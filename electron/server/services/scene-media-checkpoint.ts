import { createHash } from 'crypto'
import fs from 'fs/promises'
import path from 'path'

import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import { assertDecodableImage } from '../lib/image-validation.js'
import { assertPlayableSceneClip } from '../lib/scene-clip-media.js'
import { getMediaInfo } from '../lib/ffmpeg-validation.js'
import { SKETCH_DRAW_COMPATIBLE_HELPER_VERSIONS } from '../lib/native-scene-clip-version.js'
import { resolveSketchHoldFrames, sketchHoldFingerprint, sketchHoldSelection, type SketchHoldSetting } from '../lib/sketch-hold.js'
import {
  DEFAULT_SKETCH_REVEAL, resolveSketchRevealPlan, sketchRevealChoice, sketchRevealFingerprint,
  sketchRevealForSingleScene, sketchRevealNeedsScenes, type SketchRevealSetting, type SketchRevealType,
} from '../lib/sketch-reveal.js'
import { resolveRenderCanvas } from '../lib/render-canvas.js'
import { readChannelProfileAsset } from './channel-profile.js'
import type { MotionPresentationSettings, ProjectConfig, ScenePlan, ScenePlanEntry, SketchDrawPenMode } from '../models/types.js'
import { EpisodeSettingFileUnreadable, readEpisodeSketchPen } from './episode-sketch-pen.js'
import { readEpisodeSketchHold } from './episode-sketch-hold.js'
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

export function motionPresentationSelection(value: unknown): MotionPresentationSettings {
  const raw = value as Partial<MotionPresentationSettings> | null
  return {
    renderer: raw?.renderer === 'sketch_draw' ? 'sketch_draw' : 'image_to_video',
    pen: ['none', 'plain', 'name', 'logo'].includes(String(raw?.pen)) ? raw!.pen! : 'none',
  }
}

export type SketchPen = { mode: 'none' } | { mode: 'plain' } | { mode: 'name'; text: string } | { mode: 'logo'; logo: string }
export interface SketchDrawSettings {
  fps: number
  width: number
  height: number
  pen: Exclude<SketchPen, { mode: 'logo' }> | { mode: 'logo' }
  logoBytes?: Buffer
  penFingerprint: string
  /** The closing hold this episode renders under: its own, else the channel's. Resolved to frames per scene. */
  hold: SketchHoldSetting
  holdFingerprint: string
  /**
   * The channel's reveal style, or null when it has never been chosen. Null is not "use the default":
   * a channel that has asked for nothing cannot disagree with the reveal its clips already have, so
   * clips rendered before this control existed stay fresh. What is PERSISTED is the choice; the
   * type each scene resolves to is derived, per scene, from the episode's own ordered scene ids.
   */
  reveal: SketchRevealSetting | null
  revealFingerprint: string
}

export interface EpisodePenChoice {
  /** The pen this episode renders with: its own when it has one, else the channel's. */
  pen: SketchDrawPenMode
  pen_source: 'episode' | 'channel'
  episode_pen: SketchDrawPenMode | null
  channel_pen: SketchDrawPenMode
}

/** The one place an episode's effective pen is decided; freshness, status, approval and Assembly all come here. */
export async function resolveEpisodePen(slug: string, episodeId: string, loaded?: ProjectConfig | null): Promise<EpisodePenChoice> {
  const config = loaded ?? await pm.getConfig(slug)
  if (!config) throw new Error('Channel configuration is unavailable.')
  const channel_pen = motionPresentationSelection(config.motion_presentation).pen
  const episode_pen = await readEpisodeSketchPen(slug, episodeId)
  return { pen: episode_pen ?? channel_pen, pen_source: episode_pen ? 'episode' : 'channel', episode_pen, channel_pen }
}

export interface EpisodeHoldChoice {
  /** The hold this episode renders with: its own when it has one, else the channel's (auto until chosen). */
  hold: SketchHoldSetting
  hold_source: 'episode' | 'channel'
  episode_hold: SketchHoldSetting | null
  channel_hold: SketchHoldSetting
}

/** The one place an episode's effective closing hold is decided, as `resolveEpisodePen` is for the pen. */
export async function resolveEpisodeHold(slug: string, episodeId: string, loaded?: ProjectConfig | null): Promise<EpisodeHoldChoice> {
  const config = loaded ?? await pm.getConfig(slug)
  if (!config) throw new Error('Channel configuration is unavailable.')
  const channel_hold = sketchHoldSelection(config.motion_presentation?.hold)
  const episode_hold = await readEpisodeSketchHold(slug, episodeId)
  return { hold: episode_hold ?? channel_hold, hold_source: episode_hold ? 'episode' : 'channel', episode_hold, channel_hold }
}

/**
 * A channel default for the pen, hold or reveal just changed: drop the cached status of every
 * episode whose readiness it can move, so Motion Review reads it again. An episode with its own pen
 * or hold is untouched by a pen or hold change, as are its clips. A reveal style is channel-wide
 * reusable configuration with no episode-level override, so changing it touches EVERY episode.
 */
export async function invalidateEpisodesFollowingChannelSketch(slug: string, changed: { pen: boolean; hold: boolean; reveal?: boolean }): Promise<void> {
  if (!changed.pen && !changed.hold && !changed.reveal) return
  const { episodeStatusCache } = await import('./episode-status-cache.js')
  await episodeStatusCache.invalidateWhere(slug, async code =>
    changed.reveal === true || (changed.pen && await readEpisodeSketchPen(slug, code) === null)
    || (changed.hold && await readEpisodeSketchHold(slug, code) === null))
}

/** Frames of closing hold for one scene of an episode under these settings; the freshness rule and the generator share it. */
export function sketchHoldFramesFor(settings: Pick<SketchDrawSettings, 'hold' | 'fps'>, episodeId: string, sceneId: string, frames: number): number {
  return resolveSketchHoldFrames(settings.hold, { episodeId, sceneId, frames, fps: settings.fps })
}

/** Resolve selections again at execution/read time; never persist a copied name, logo or fps. */
export async function resolveSketchDrawSettings(slug: string, episodeId: string): Promise<SketchDrawSettings> {
  const config = await pm.getConfig(slug)
  if (!config) throw new Error('Channel configuration is unavailable.')
  const mode = (await resolveEpisodePen(slug, episodeId, config)).pen
  const { hold } = await resolveEpisodeHold(slug, episodeId, config)
  const reveal = sketchRevealChoice(config.motion_presentation?.reveal)
  if (!['none', 'plain', 'name', 'logo'].includes(mode)) throw new Error('Choose a valid Sketch Draw pen.')
  const store = config.video_assembly_last_used
  const own = store?.episodes?.[episodeId.trim().toUpperCase()]?.settings
  const output = (own ?? store?.channel?.settings)?.export as { fps?: unknown; resolution?: unknown; aspect_ratio?: unknown } | undefined
  const { DEFAULT_FPS } = await import('../generators/video.js')
  const fps = Number(output?.fps ?? DEFAULT_FPS)
  if (!Number.isInteger(fps) || ![24, 25, 30, 60].includes(fps)) throw new Error('The saved Video Assembly frame rate is invalid. Choose a frame rate in Video Assembly.')
  const canvas = resolveRenderCanvas(typeof output?.resolution === 'string' ? output.resolution : undefined,
    typeof output?.aspect_ratio === 'string' ? output.aspect_ratio : undefined)
  let pen: SketchDrawSettings['pen'] = mode === 'plain' ? { mode: 'plain' } : { mode: 'none' }
  let logoBytes: Buffer | undefined
  let identity: unknown = { mode }
  if (mode === 'name') {
    const project = await pm.getProject(slug)
    if (!project?.name?.trim()) throw new Error('This channel has no name for its pen. Set its name in the channel profile.')
    pen = { mode: 'name', text: project.name }
    identity = pen
  } else if (mode === 'logo') {
    const asset = await readChannelProfileAsset(slug, 'logo')
    if (!asset?.bytes.length) throw new Error('This channel has no profile logo. Add a logo in Channel Profile or choose another pen.')
    logoBytes = asset.bytes
    pen = { mode: 'logo' }
    identity = { mode, sha256: createHash('sha256').update(logoBytes).digest('hex') }
  }
  return { fps, width: canvas.w, height: canvas.h, pen, logoBytes,
    penFingerprint: createHash('sha256').update(JSON.stringify(identity)).digest('hex'),
    hold, holdFingerprint: sketchHoldFingerprint(hold),
    reveal, revealFingerprint: sketchRevealFingerprint(reveal ?? DEFAULT_SKETCH_REVEAL) }
}

export interface SceneClipFreshnessContext {
  slug: string
  episodeId: string
  episodeDir: string
  imagePath?: string | null
  sketchSettings?: SketchDrawSettings
  /** Scenes the saved request observed as deliberately Still. */
  stillIds?: string[]
  /** False when the run produces clips for review without choosing them (Motion Review's Generate). */
  requireSelected?: boolean
  /**
   * Every scene id of this episode, in plan order. A Mix resolves per scene and never two
   * consecutive scenes to the same type, so resolving one scene needs the ones before it. Only a
   * real Mix reads it; a single style is answered by the scene's own id.
   */
  revealScenes?: readonly string[]
  /** Resolved reveal type for the scene being checked, when the caller already has the plan. */
  revealType?: SketchRevealType
}

export function sceneWindowSeconds(scene: Pick<ScenePlanEntry, 'start_sec' | 'end_sec'>): number {
  const seconds = scene.end_sec - scene.start_sec
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('Scene Plan has an invalid scene window. Repair its timeline before generating motion.')
  return seconds
}

/** Source-image bytes by path, keyed by size:mtime, so a review poll hashes only new files. */
const imageShaCache = new Map<string, { key: string; sha256: string }>()

async function currentImageSha256(filePath: string): Promise<string | null> {
  const stat = await fs.stat(filePath).catch(() => null)
  if (!stat?.isFile() || stat.size <= 0) return null
  const key = `${stat.size}:${Math.trunc(stat.mtimeMs)}`
  const cached = imageShaCache.get(filePath)
  if (cached?.key === key) return cached.sha256
  const bytes = await fs.readFile(filePath).catch(() => null)
  if (!bytes?.length) return null
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  imageShaCache.set(filePath, { key, sha256 })
  return sha256
}

const CANNOT_VERIFY_SOURCE = 'Sketch Draw cannot verify its source image here. Open Motion Review and Retry.'
const SETTINGS_UNAVAILABLE = 'Sketch Draw settings could not be checked. Choose the pen, reveal style and Video Assembly frame rate again.'
/** Only reachable if a caller omits the episode's scene order from a Mix check; it never guesses. */
const REVEAL_NEEDS_EPISODE = 'Sketch Draw cannot check its reveal style here. Open Motion Review and Retry.'

/** The reveal type one scene resolves to, or null when a Mix needs the episode's scene order and
 *  the caller did not supply it. Never guesses: a wrong answer here silently stales a good clip. */
export function revealTypeFor(reveal: SketchRevealSetting, context: SceneClipFreshnessContext, sceneId: string): SketchRevealType | null {
  if (sketchRevealNeedsScenes(reveal) && !context.revealScenes) return null
  const plan = resolveSketchRevealPlan(context.episodeId, context.revealScenes ?? [sceneId], reveal)
  return plan.get(sceneId) ?? sketchRevealForSingleScene(reveal, sceneId)
}

/** The single freshness rule used by review, approval, completion, status, retry and assembly. */
export async function sceneClipStaleReason(scene: ScenePlanEntry, context?: SceneClipFreshnessContext): Promise<string | null> {
  const sketch = scene.clip_renderer === 'sketch_draw'
  if (!sketch) {
    // Provider clips are trimmed/held by Assembly; a plan-timing nudge must never turn an
    // existing motion episode into stills. Only their source image and prompt identity matter.
    if (typeof scene.rendered_motion_prompt === 'string'
      && scene.rendered_motion_prompt !== (scene.motion_prompt || '')) return 'stale motion prompt'
    if (scene.image_version != null && scene.clip_source_image_version !== scene.image_version) return 'stale source image'
    if (scene.clip_source_image_sha256 !== undefined) {
      if (!scene.image_sha256) {
        if (!context?.imagePath) return 'source image cannot be verified here'
        if (await currentImageSha256(context.imagePath) !== scene.clip_source_image_sha256) return 'stale source image'
      } else if (scene.image_sha256 !== scene.clip_source_image_sha256) return 'stale source image'
    }
    return null
  }

  const window = scene.end_sec - scene.start_sec
  if (!Number.isFinite(window) || window <= 0) return 'invalid scene window'
  const receipt = scene.clip_sketch
  // Version-2 clips (old 15% hold) are complete and exactly scene-length: they stay fresh until regenerated.
  if (!receipt || !SKETCH_DRAW_COMPATIBLE_HELPER_VERSIONS.includes(receipt.helper_version)) return 'stale Sketch Draw renderer'
  if (!context) {
    // No live channel/Assembly context here: still compare the two recorded identities when
    // both exist, and say plainly when neither can prove the source.
    if (scene.clip_source_image_sha256 && scene.image_sha256) {
      return scene.image_sha256 === scene.clip_source_image_sha256 ? CANNOT_VERIFY_SOURCE : 'stale source image'
    }
    return CANNOT_VERIFY_SOURCE
  }
  let settings: SketchDrawSettings
  try { settings = context.sketchSettings ?? await resolveSketchDrawSettings(context.slug, context.episodeId) }
  catch (error) { return error instanceof EpisodeSettingFileUnreadable ? error.message : SETTINGS_UNAVAILABLE }
  if (receipt.fps !== settings.fps) return 'stale frame rate'
  if (!Number.isSafeInteger(receipt.frames) || receipt.frames < 1) return 'invalid Sketch Draw frame budget'
  // One frame of tolerance: a timing re-sync that moves a boundary by less than a frame keeps the drawing.
  if (Math.abs(receipt.frames - window * settings.fps) > 1) {
    return `scene length changed (clip ${(receipt.frames / settings.fps).toFixed(1)}s, scene now ${window.toFixed(1)}s)`
  }
  if (receipt.width !== settings.width || receipt.height !== settings.height) return 'stale render canvas'
  if (receipt.pen_fingerprint !== settings.penFingerprint) return 'stale pen configuration'
  // Fit exactly: one frame of tolerance covers the whole-second plan's frame rounding, no more.
  if (scene.clip_scene_window_seconds === undefined
    || Math.abs(scene.clip_scene_window_seconds - window) > 1 / settings.fps + 1e-9) {
    const was = scene.clip_scene_window_seconds === undefined ? 'unrecorded' : `${scene.clip_scene_window_seconds.toFixed(1)}s`
    return `scene length changed (clip ${was}, scene now ${window.toFixed(1)}s)`
  }

  // The hold is compared as resolved frames for THIS scene, so a setting change stales only the clips
  // whose hold it actually moves. A clip that recorded none is a legacy helper-v2 clip, or malformed.
  if (receipt.hold_frames === undefined) {
    if (receipt.helper_version >= 3) return 'stale closing hold'
  } else if (!Number.isSafeInteger(receipt.hold_frames)
    || receipt.hold_frames !== sketchHoldFramesFor(settings, context.episodeId, scene.id, receipt.frames)) return 'stale closing hold'

  // The reveal style is compared as the type THIS scene resolves to, so editing a Mix stales only
  // the scenes whose type actually moved. A channel that has never chosen one keeps every clip it
  // has: nothing was asked for, so nothing can be wrong. A clip from before reveal types has no
  // `reveal_type`; it IS a line reveal, so choosing Line (the default) never stales it.
  if (settings.reveal) {
    const wanted = context.revealType ?? revealTypeFor(settings.reveal, context, scene.id)
    if (wanted === null) return REVEAL_NEEDS_EPISODE
    const recorded = receipt.reveal_type ?? 'line'
    if (recorded !== wanted) return `stale reveal style (${recorded} → ${wanted})`
  }

  const clipSha = scene.clip_source_image_sha256
  if (!clipSha) return CANNOT_VERIFY_SOURCE
  if (scene.image_sha256) return scene.image_sha256 === clipSha ? null : 'stale source image'
  if (!context.imagePath) return CANNOT_VERIFY_SOURCE
  const currentSha = await currentImageSha256(context.imagePath)
  return currentSha && currentSha === clipSha ? null : 'stale source image'
}

/** The one definition of "this scene already has a fresh clip", without decoding it. */
export async function isSceneClipFresh(scene: ScenePlanEntry, clipPath: string, context?: SceneClipFreshnessContext): Promise<boolean> {
  const stat = await fs.stat(clipPath).catch(() => null)
  if (!stat?.isFile() || stat.size <= 0) return false
  return (await sceneClipStaleReason(scene, context)) === null
}

export async function assertSketchDrawClip(filePath: string, expected: { fps: number; frames: number; width: number; height: number }): Promise<number> {
  const duration = await assertPlayableSceneClip(filePath, expected.frames / expected.fps)
  const info = await getMediaInfo(filePath)
  if (info.videoFrames !== expected.frames
    || info.frameRate === undefined || Math.abs(info.frameRate - expected.fps) > 0.001
    || info.width !== expected.width || info.height !== expected.height
    || info.hasAudio || info.videoCodec !== 'h264' || info.pixelFormat !== 'yuv420p'
    || Math.abs(duration - expected.frames / expected.fps) > 1 / expected.fps) {
    throw new Error(`Sketch Draw output failed its frame count, frame rate, geometry or silent H.264 check. File preserved: ${filePath}. Retry renders this scene again.`)
  }
  return duration
}

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
  context?: SceneClipFreshnessContext,
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
    if (scene.motion_choice === 'still' || context?.stillIds?.includes(sceneId)) continue
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
    const staleReason = await sceneClipStaleReason(scene, context)
    if (staleReason) {
      invalid.push(`${sceneId} (${staleReason})`)
      issues.push({ item_id: sceneId, state: 'invalid', reason: staleReason })
      continue
    }
    if (scene.motion_choice !== 'clip' && context?.requireSelected !== false) {
      invalid.push(`${sceneId} (clip not selected)`)
      issues.push({ item_id: sceneId, state: 'invalid', reason: 'clip not selected' })
      continue
    }
    try {
      if (scene.clip_renderer === 'sketch_draw') await assertSketchDrawClip(clipPath, scene.clip_sketch!)
      else await assertPlayableSceneClip(clipPath, expectedDurations[sceneId] ?? scene.clip_requested_duration_seconds)
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
    renderer?: ScenePlanEntry['clip_renderer']
    source_image_sha256?: string
    scene_window_seconds?: number
    sketch?: ScenePlanEntry['clip_sketch']
    /** A verified candidate is promoted only after the current plan/settings still match. */
    candidate_path?: string
    context?: SceneClipFreshnessContext
    assertActive?: () => void
  } = {},
): Promise<ScenePlan> {
  const candidate = receipt.candidate_path ?? clipPath
  await assertUsableFile(candidate, `Motion clip for ${sceneId}`)
  const durationSeconds = receipt.duration_seconds ?? await assertPlayableSceneClip(candidate, receipt.requested_duration_seconds)
  return withLock(planPath, async () => {
    const plan = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
    const scene = plan.scenes.find(item => item.id === sceneId)
    if (!scene) throw new Error(`Scene ${sceneId} disappeared before its motion clip could be registered.`)
    if (receipt.renderer === 'sketch_draw') {
      const effectiveWindow = receipt.scene_window_seconds ?? sceneWindowSeconds(scene)
      const reason = await sceneClipStaleReason({ ...scene, clip_renderer: 'sketch_draw',
        clip_source_image_sha256: receipt.source_image_sha256,
        clip_scene_window_seconds: effectiveWindow, clip_sketch: receipt.sketch }, receipt.context)
      if (reason) throw new Error(`Scene ${sceneId} changed while Sketch Draw rendered (${reason}). The previous clip was kept. Retry renders only this missing or stale scene.`)
    }
    receipt.assertActive?.()
    if (receipt.candidate_path) {
      // The render lives in app temp, which may be on another volume. Stage beside the
      // destination first so the final visible name is still an atomic rename.
      try {
        await fs.rename(receipt.candidate_path, clipPath)
      } catch (error: any) {
        if (error?.code !== 'EXDEV') throw error
        const staged = `${clipPath}.${process.pid}.${Date.now()}.tmp`
        try {
          await fs.copyFile(receipt.candidate_path, staged)
          await fs.rename(staged, clipPath)
          await fs.unlink(receipt.candidate_path).catch(() => {})
        } catch (copyError) {
          await fs.unlink(staged).catch(() => {})
          throw copyError
        }
      }
    }

    scene.clip_renderer = receipt.renderer ?? 'image_to_video'
    scene.clip_source_image_sha256 = receipt.source_image_sha256
    if (receipt.renderer === 'sketch_draw') scene.clip_scene_window_seconds = receipt.scene_window_seconds ?? sceneWindowSeconds(scene)
    else delete scene.clip_scene_window_seconds
    if (receipt.sketch) scene.clip_sketch = receipt.sketch
    else delete scene.clip_sketch
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
