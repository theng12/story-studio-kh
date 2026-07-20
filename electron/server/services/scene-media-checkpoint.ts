import fs from 'fs/promises'
import path from 'path'

import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import { assertDecodableImage } from '../lib/image-validation.js'
import type { ScenePlan } from '../models/types.js'

export interface SceneImageCompletionAudit {
  expected: number
  completed: number
  missing: string[]
  invalid: string[]
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

  for (const sceneId of [...new Set(sceneIds)]) {
    const scene = scenesById.get(sceneId)
    if (!scene) {
      invalid.push(`${sceneId} (missing from scene plan)`)
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
      if (foundCorrupt) invalid.push(`${sceneId} (corrupt image)`)
      else if (foundEmpty) invalid.push(`${sceneId} (empty image)`)
      else missing.push(sceneId)
    }
  }

  const expected = new Set(sceneIds).size
  return { expected, completed: expected - missing.length - invalid.length, missing, invalid }
}

export async function auditSceneClipCompletion(
  planPath: string,
  sceneIds: string[],
  clipsDirectory: string,
): Promise<SceneClipCompletionAudit> {
  const plan = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
  const scenesById = new Map(plan.scenes.map(scene => [scene.id, scene]))
  const missing: string[] = []
  const invalid: string[] = []

  for (const sceneId of [...new Set(sceneIds)]) {
    const scene = scenesById.get(sceneId)
    if (!scene) {
      invalid.push(`${sceneId} (missing from scene plan)`)
      continue
    }
    const clipPath = path.join(clipsDirectory, `${sceneId}.mp4`)
    const stat = await fs.stat(clipPath).catch(() => null)
    if (!stat?.isFile()) {
      missing.push(sceneId)
      continue
    }
    if (stat.size <= 0) {
      invalid.push(`${sceneId} (empty clip)`)
      continue
    }
    if (scene.rendered_motion_prompt !== (scene.motion_prompt || '')) {
      invalid.push(`${sceneId} (stale motion prompt)`)
      continue
    }
    if (scene.image_version != null && scene.clip_source_image_version !== scene.image_version) {
      invalid.push(`${sceneId} (stale source image)`)
      continue
    }
    if (scene.motion_choice !== 'clip') invalid.push(`${sceneId} (clip not selected)`)
  }

  const expected = new Set(sceneIds).size
  return { expected, completed: expected - missing.length - invalid.length, missing, invalid }
}

export async function checkpointSceneImage(
  planPath: string,
  sceneId: string,
  imagePath: string,
  renderedPrompt: string,
  autoApproveGenerated = false,
): Promise<ScenePlan> {
  await assertUsableFile(imagePath, `Image for ${sceneId}`)
  await assertDecodableImage(imagePath, `Image for ${sceneId}`)
  return withLock(planPath, async () => {
    const plan = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
    const scene = plan.scenes.find(item => item.id === sceneId)
    if (!scene) throw new Error(`Scene ${sceneId} disappeared before its image could be registered.`)

    scene.image_path = imagePath
    scene.rendered_prompt = renderedPrompt
    scene.image_version = new Date().toISOString()
    scene.motion_choice = 'pending'
    // Approval is applied only after the exact output file passed the usable
    // media check above and the matching scene still exists in the fresh plan.
    scene.approved = autoApproveGenerated === true
    await writeJsonAtomic(planPath, plan)
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
): Promise<ScenePlan> {
  await assertUsableFile(clipPath, `Motion clip for ${sceneId}`)
  return withLock(planPath, async () => {
    const plan = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
    const scene = plan.scenes.find(item => item.id === sceneId)
    if (!scene) throw new Error(`Scene ${sceneId} disappeared before its motion clip could be registered.`)

    scene.clip_path = clipPath
    scene.rendered_motion_prompt = renderedMotionPrompt
    scene.clip_source_image_version = sourceImageVersion
    scene.motion_choice = approveClip ? 'clip' : 'pending'
    await writeJsonAtomic(planPath, plan)
    return plan
  })
}
