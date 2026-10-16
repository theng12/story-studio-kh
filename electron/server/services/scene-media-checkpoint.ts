import { createHash } from 'crypto'
import fs from 'fs/promises'
import path from 'path'

import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import { assertDecodableImage } from '../lib/image-validation.js'
import { assertPlayableSceneClip } from '../lib/scene-clip-media.js'
import type { ScenePlan } from '../models/types.js'
import { sceneReviewAutoApproveOn } from './preset-authority.js'
import * as pm from './project-manager.js'

export interface SceneImageCompletionAudit {
  expected: number
  completed: number
  missing: string[]
  invalid: string[]
  issues: Array<{ item_id: string; state: 'missing' | 'invalid'; reason?: string }>
}

export type SceneClipCompletionAudit = SceneImageCompletionAudit

async function assertUsableFile(filePath: string, label: string): Promise<void> {
  const stat = await fs.stat(filePath).catch(() => null)
  if (!stat?.isFile() || stat.size <= 0) {
    throw new Error(`${label} was not saved as a usable file: ${filePath}`)
  }
}

/** Re-read the plan and verify the exact scene IDs against files downstream
 * Scene Review can resolve. This catches omitted callbacks, empty downloads,
 * deleted plan rows, and stale stored paths before a job can report success. */
export async function auditSceneImageCompletion(
  planPath: string,
  sceneIds: string[],
  imageDirectories: string[],
): Promise<SceneImageCompletionAudit> {
  const plan = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
  const scenesById = new Map(plan.scenes.map(scene => [scene.id, scene]))
  const missing: string[] = []
  const invalid: string[] = []
  const issues: SceneImageCompletionAudit['issues'] = []

  for (const sceneId of [...new Set(sceneIds)]) {
    const scene = scenesById.get(sceneId)
    if (!scene) {
      invalid.push(`${sceneId} (missing from scene plan)`)
      issues.push({ item_id: sceneId, state: 'invalid', reason: 'missing from scene plan' })
      continue
    }

    const candidates = [
      ...imageDirectories.map(dir => path.join(dir, `${sceneId}.png`)),
      ...(typeof scene.image_path === 'string' && scene.image_path.trim() ? [scene.image_path] : []),
    ]
    let foundEmpty = false
    let foundCorrupt = false
    let foundUsable = false
    for (const candidate of [...new Set(candidates)]) {
      const stat = await fs.stat(candidate).catch(() => null)
      if (!stat?.isFile()) continue
      if (stat.size > 0) {
        try {
          await assertDecodableImage(candidate, `Image for ${sceneId}`)
          foundUsable = true
          break
        } catch {
          foundCorrupt = true
        }
      }
      foundEmpty = true
    }
    if (!foundUsable) {
      if (foundCorrupt) {
        invalid.push(`${sceneId} (corrupt image)`)
        issues.push({ item_id: sceneId, state: 'invalid', reason: 'corrupt image' })
      } else if (foundEmpty) {
        invalid.push(`${sceneId} (empty image)`)
        issues.push({ item_id: sceneId, state: 'invalid', reason: 'empty image' })
      } else {
        missing.push(sceneId)
        issues.push({ item_id: sceneId, state: 'missing' })
      }
    }
  }

  const expected = new Set(sceneIds).size
  return { expected, completed: expected - missing.length - invalid.length, missing, invalid, issues }
}

export async function auditSceneClipCompletion(
  planPath: string,
  sceneIds: string[],
  clipsDirectory: string,
  expectedDurations: Record<string, number> = {},
): Promise<SceneClipCompletionAudit> {
  const plan = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
  const scenesById = new Map(plan.scenes.map(scene => [scene.id, scene]))
  const missing: string[] = []
  const invalid: string[] = []
  const issues: SceneClipCompletionAudit['issues'] = []

  for (const sceneId of [...new Set(sceneIds)]) {
    const scene = scenesById.get(sceneId)
    if (!scene) {
      invalid.push(`${sceneId} (missing from scene plan)`)
      issues.push({ item_id: sceneId, state: 'invalid', reason: 'missing from scene plan' })
      continue
    }
    // A saved scope snapshot remains immutable across later editorial changes.
    // Choosing Still deliberately satisfies that scene without a paid clip.
    if (scene.motion_choice === 'still') continue
    const clipPath = path.join(clipsDirectory, `${sceneId}.mp4`)
    const stat = await fs.stat(clipPath).catch(() => null)
    if (!stat?.isFile()) {
      missing.push(sceneId)
      issues.push({ item_id: sceneId, state: 'missing' })
      continue
    }
    if (stat.size <= 0) {
      invalid.push(`${sceneId} (empty clip)`)
      issues.push({ item_id: sceneId, state: 'invalid', reason: 'empty clip' })
      continue
    }
    if (scene.rendered_motion_prompt !== (scene.motion_prompt || '')) {
      invalid.push(`${sceneId} (stale motion prompt)`)
      issues.push({ item_id: sceneId, state: 'invalid', reason: 'stale motion prompt' })
      continue
    }
    if (scene.image_version != null && scene.clip_source_image_version !== scene.image_version) {
      invalid.push(`${sceneId} (stale source image)`)
      issues.push({ item_id: sceneId, state: 'invalid', reason: 'stale source image' })
      continue
    }
    if (scene.motion_choice !== 'clip') {
      invalid.push(`${sceneId} (clip not selected)`)
      issues.push({ item_id: sceneId, state: 'invalid', reason: 'clip not selected' })
      continue
    }
    try {
      await assertPlayableSceneClip(clipPath, expectedDurations[sceneId] ?? scene.clip_requested_duration_seconds)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      invalid.push(`${sceneId} (unplayable clip)`)
      issues.push({ item_id: sceneId, state: 'invalid', reason })
    }
  }

  const expected = new Set(sceneIds).size
  return { expected, completed: expected - missing.length - invalid.length, missing, invalid, issues }
}

/** Scenes that have their image and no approval yet: Scene Review is waiting on the owner. */
export async function countScenesAwaitingApproval(planPath: string): Promise<number> {
  const plan = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
  return plan.scenes.filter(scene => scene.approved !== true && !!scene.image_path).length
}

/** The channel's auto scene approval as it is NOW, for a job that captured the flag off when it started. */
export const liveSceneAutoApprove = (slug: string) => async (): Promise<boolean> =>
  sceneReviewAutoApproveOn(await pm.getConfig(slug).catch(() => null))

export async function checkpointSceneImage(
  planPath: string,
  sceneId: string,
  imagePath: string,
  renderedPrompt: string,
  autoApproveGenerated = false,
  /** Asked once, under the lock, only for a new image of a job that captured auto-approve off. */
  liveAutoApprove?: () => Promise<boolean>,
): Promise<ScenePlan> {
  await assertUsableFile(imagePath, `Image for ${sceneId}`)
  await assertDecodableImage(imagePath, `Image for ${sceneId}`)
  const sha256 = createHash('sha256').update(await fs.readFile(imagePath)).digest('hex')
  return withLock(planPath, async () => {
    const plan = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
    const scene = plan.scenes.find(item => item.id === sceneId)
    if (!scene) throw new Error(`Scene ${sceneId} disappeared before its image could be registered.`)

    // The same bytes registered again (a retry or restart re-running the checkpoint) is not a new
    // image: whatever the owner decided since (approval, motion choice) stands. Approval is only
    // ever added here, never cleared. A genuinely different image still waits for the owner below.
    if (scene.image_path === imagePath && scene.image_sha256 === sha256) {
      if (autoApproveGenerated === true) {
        plan.auto_approve_generated = true
        scene.approved = true
      }
      await writeJsonAtomic(planPath, plan, { compact: true })
      return plan
    }

    // A scene filling in a gap (no image yet) of an episode whose render auto-approved its
    // images is approved the same way; a replacement image still waits for the owner.
    const fillIn = !scene.image_path
    if (autoApproveGenerated === true) plan.auto_approve_generated = true
    scene.image_path = imagePath
    scene.rendered_prompt = renderedPrompt
    scene.image_version = new Date().toISOString()
    scene.image_sha256 = sha256
    scene.motion_choice = 'pending'
    // Approval is applied only after the exact output file passed the usable
    // media check above and the matching scene still exists in the fresh plan.
    scene.approved = autoApproveGenerated === true || (fillIn && plan.auto_approve_generated === true)
      || (!!liveAutoApprove && await liveAutoApprove())
    await writeJsonAtomic(planPath, plan, { compact: true })
    return plan
  })
}

export async function checkpointSceneClip(
  planPath: string,
  sceneId: string,
  clipPath: string,
  renderedMotionPrompt: string,
  sourceImageVersion: string | undefined,
  approveClip: boolean,
  receipt: {
    requested_duration_seconds?: number
    duration_seconds?: number
    shortfall_mode?: 'hold'
  } = {},
): Promise<ScenePlan> {
  await assertUsableFile(clipPath, `Motion clip for ${sceneId}`)
  const durationSeconds = receipt.duration_seconds ?? await assertPlayableSceneClip(clipPath, receipt.requested_duration_seconds)
  return withLock(planPath, async () => {
    const plan = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
    const scene = plan.scenes.find(item => item.id === sceneId)
    if (!scene) throw new Error(`Scene ${sceneId} disappeared before its motion clip could be registered.`)

    scene.clip_path = clipPath
    scene.rendered_motion_prompt = renderedMotionPrompt
    scene.clip_source_image_version = sourceImageVersion
    // The provider may finish after the editor has explicitly chosen Still.
    // Keep the verified artifact and receipt for later reuse, but do not let a
    // stale completion reverse that newer output decision.
    if (scene.motion_choice !== 'still') scene.motion_choice = approveClip ? 'clip' : 'pending'
    if (receipt.requested_duration_seconds === undefined) delete scene.clip_requested_duration_seconds
    else scene.clip_requested_duration_seconds = receipt.requested_duration_seconds
    scene.clip_duration_seconds = durationSeconds
    if (receipt.shortfall_mode === 'hold') scene.clip_shortfall_mode = 'hold'
    else delete scene.clip_shortfall_mode
    await writeJsonAtomic(planPath, plan, { compact: true })
    return plan
  })
}
