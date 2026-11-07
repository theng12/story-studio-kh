import { createHash } from 'crypto'
import { existsSync } from 'fs'
import fs from 'fs/promises'
import path from 'path'

import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import { assertDecodableImage } from '../lib/image-validation.js'
import { assertPlayableSceneClip } from '../lib/scene-clip-media.js'
import { getMediaInfo } from '../lib/ffmpeg-validation.js'
import { SKETCH_DRAW_COMPATIBLE_HELPER_VERSIONS } from '../lib/native-scene-clip-version.js'
import { resolveSketchHoldFrames, sketchHoldFingerprint, sketchHoldSelection, type SketchHoldSetting } from '../lib/sketch-hold.js'
import {
  DEFAULT_SKETCH_REVEAL, resolveSketchRevealPlan, sceneTypeHoldFor, sketchRevealChoice, sketchRevealFingerprint,
  sketchRevealForSingleScene, sketchRevealNeedsScenes, type SketchRevealSetting, type SketchRevealType,
} from '../lib/sketch-reveal.js'
import {
  DEFAULT_SKETCH_LINE_WEIGHT, sketchLineWeightSelection, type SketchLineWeight,
} from '../lib/sketch-line-weight.js'
import { resolveRenderCanvas } from '../lib/render-canvas.js'
import { readChannelProfileAsset } from './channel-profile.js'
import { resolveScenePlanPath } from './utils.js'
import type { MotionPresentationSettings, ProjectConfig, ScenePlan, ScenePlanEntry, SketchDrawPenMode } from '../models/types.js'
import { EpisodeSettingFileUnreadable, episodeDir, isEpisodeCode, readEpisodeSketchPen, writeEpisodeSketchPen } from './episode-sketch-pen.js'
import { readEpisodeSketchHold, writeEpisodeSketchHold } from './episode-sketch-hold.js'
import { sceneImageStaleReason } from './scene-plan-staleness.js'
import { readEpisodeSketchReveal, writeEpisodeSketchReveal } from './episode-sketch-reveal.js'
import { readEpisodeSketchLineWeight, writeEpisodeSketchLineWeight } from './episode-sketch-line-weight.js'
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
  const renderer = raw?.renderer === 'sketch_draw'
    ? 'sketch_draw'
    : raw?.renderer === 'text_to_video'
      ? 'text_to_video'
      : 'image_to_video'
  return {
    renderer,
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
   * The reveal style this episode renders with: its own, else the channel's, or null when neither
   * has ever been chosen. Null is not "use the default": a channel and an episode that have asked
   * for nothing cannot disagree with the reveal its clips already have, so clips rendered before
   * this control existed stay fresh. What is PERSISTED is the choice; the type each scene resolves
   * to is derived, per scene, from the episode's own ordered scene ids.
   */
  reveal: SketchRevealSetting | null
  revealFingerprint: string
  /**
   * The ink weight this episode renders with: its own, else the channel's, else NORMAL. Normal is
   * the engine's own weight, so a channel and an episode that have never chosen one keep every
   * clip they have — the weight a clip was drawn with is recorded on its receipt, and a receipt
   * with no weight IS a normal one.
   */
  lineWeight: SketchLineWeight
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

export interface EpisodeRevealChoice {
  /** The reveal this episode renders with: its own when it has one, else the channel's, else null (never chosen). */
  reveal: SketchRevealSetting | null
  reveal_source: 'episode' | 'channel' | 'none'
  episode_reveal: SketchRevealSetting | null
  channel_reveal: SketchRevealSetting | null
}

/** The one place an episode's effective reveal style is decided, as `resolveEpisodePen` is for the pen. */
export async function resolveEpisodeReveal(slug: string, episodeId: string, loaded?: ProjectConfig | null): Promise<EpisodeRevealChoice> {
  const config = loaded ?? await pm.getConfig(slug)
  if (!config) throw new Error('Channel configuration is unavailable.')
  const channel_reveal = sketchRevealChoice(config.motion_presentation?.reveal)
  const episode_reveal = await readEpisodeSketchReveal(slug, episodeId)
  const reveal = episode_reveal ?? channel_reveal
  return { reveal, reveal_source: episode_reveal ? 'episode' : channel_reveal ? 'channel' : 'none', episode_reveal, channel_reveal }
}

export interface EpisodeLineWeightChoice {
  /** The weight this episode renders with: its own when it has one, else the channel's, else normal. */
  line_weight: SketchLineWeight
  line_weight_source: 'episode' | 'channel'
  episode_line_weight: SketchLineWeight | null
  channel_line_weight: SketchLineWeight
}

/**
 * The one place an episode's effective ink weight is decided, as `resolveEpisodeReveal` is for the
 * reveal. A channel that never chose one reads NORMAL, which is the engine's own weight — so a
 * clip drawn before the control existed keeps the look it has.
 */
export async function resolveEpisodeLineWeight(slug: string, episodeId: string, loaded?: ProjectConfig | null): Promise<EpisodeLineWeightChoice> {
  const config = loaded ?? await pm.getConfig(slug)
  if (!config) throw new Error('Channel configuration is unavailable.')
  const channel_line_weight = sketchLineWeightSelection(config.motion_presentation?.line_weight)
  const episode_line_weight = await readEpisodeSketchLineWeight(slug, episodeId)
  return {
    line_weight: episode_line_weight ?? channel_line_weight,
    line_weight_source: episode_line_weight ? 'episode' : 'channel',
    episode_line_weight,
    channel_line_weight,
  }
}

/**
 * A channel default for the pen, hold or reveal just changed: drop the cached status of every
 * episode whose readiness it can move, so Motion Review reads it again. An episode with its own pen,
 * hold or reveal is untouched by a change to that setting, as are its clips.
 */
export async function invalidateEpisodesFollowingChannelSketch(slug: string, changed: { pen: boolean; hold: boolean; reveal?: boolean; line_weight?: boolean }): Promise<void> {
  if (!changed.pen && !changed.hold && !changed.reveal && !changed.line_weight) return
  const { episodeStatusCache } = await import('./episode-status-cache.js')
  await episodeStatusCache.invalidateWhere(slug, async code =>
    (changed.pen && await readEpisodeSketchPen(slug, code) === null)
    || (changed.hold && await readEpisodeSketchHold(slug, code) === null)
    || (changed.reveal === true && await readEpisodeSketchReveal(slug, code) === null)
    || (changed.line_weight === true && await readEpisodeSketchLineWeight(slug, code) === null))
}

/** What the channel's four Sketch Draw settings resolve to right now: the values a save compares against. */
export interface ChannelSketchDefaults {
  pen: SketchDrawPenMode
  hold: SketchHoldSetting
  reveal: SketchRevealSetting | null
  line_weight: SketchLineWeight
}

/**
 * The channel's effective pen, hold, reveal and ink weight. An invalid saved value throws — it is
 * surfaced, never guessed (§6), because a save that cannot say what those clips were drawn with
 * cannot pin them to it.
 */
export function channelSketchDefaults(config: ProjectConfig): ChannelSketchDefaults {
  return {
    pen: motionPresentationSelection(config.motion_presentation).pen,
    hold: sketchHoldSelection(config.motion_presentation?.hold),
    reveal: sketchRevealChoice(config.motion_presentation?.reveal),
    line_weight: sketchLineWeightSelection(config.motion_presentation?.line_weight),
  }
}

/**
 * Which of the four actually MOVE between two settings objects. Compared as resolved values, the
 * way the line weight already did: an absent hold and AUTO are the same hold, so re-saving it
 * moves nothing — no episode is pinned and no cached status is dropped.
 */
export function movedChannelSketchSettings(before: ChannelSketchDefaults, after: ChannelSketchDefaults): { pen: boolean; hold: boolean; reveal: boolean; line_weight: boolean } {
  return {
    pen: after.pen !== before.pen,
    hold: JSON.stringify(after.hold) !== JSON.stringify(before.hold),
    reveal: JSON.stringify(after.reveal ?? null) !== JSON.stringify(before.reveal ?? null),
    line_weight: after.line_weight !== before.line_weight,
  }
}

/** Every episode folder this channel has on disk, by code: an episode folder's name carries its code at the front. */
async function sketchEpisodeCodesOnDisk(slug: string): Promise<string[]> {
  const projectDir = pm.getProjectDir(slug)
  if (!projectDir) return []
  const { path: episodesRoot } = pm.resolveOutputRoot(projectDir)
  const codes = new Set<string>()
  // Episode folders sit directly under `episodes/`, or one season folder below it — never deeper.
  const scan = async (dir: string, depth: number): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      // The "✅ " done-marker prefix is stripped the same way the folder resolver strips it.
      const match = /^([A-Za-z]{1,12}\d{1,8})\b/.exec(entry.name.replace(/^✅\s*/, ''))
      if (match && isEpisodeCode(match[1])) { codes.add(match[1]!.toUpperCase()); continue }
      if (depth > 0) await scan(path.join(dir, entry.name), depth - 1)
    }
  }
  await scan(episodesRoot, 1)
  return [...codes].sort()
}

/**
 * Whether this episode's Scene Plan records at least one Sketch Draw clip receipt — the evidence
 * that it has clips a channel-default move would re-render. A plan that exists but cannot be read
 * throws, naming the episode: unreadable is never read as "no clips" (§6).
 */
async function episodeHasSketchClipReceipt(slug: string, code: string): Promise<boolean> {
  const dir = await episodeDir(slug, code)
  const planPath = await resolveScenePlanPath(slug, code, dir)
  if (!existsSync(planPath)) return false
  let plan: ScenePlan
  try { plan = JSON.parse(await fs.readFile(planPath, 'utf8')) as ScenePlan }
  catch {
    throw new EpisodeSettingFileUnreadable(
      `This episode's scene plan (${path.basename(planPath)} for ${code}) cannot be read, so its Sketch Draw clips cannot be pinned to the channel's current default. Repair or regenerate ${code}'s Scene Plan, then save the channel setting again.`,
    )
  }
  const scenes = (plan as { scenes?: unknown } | null)?.scenes
  if (!Array.isArray(scenes)) {
    throw new EpisodeSettingFileUnreadable(
      `This episode's scene plan (${path.basename(planPath)} for ${code}) holds no scene list, so its Sketch Draw clips cannot be pinned to the channel's current default. Repair or regenerate ${code}'s Scene Plan, then save the channel setting again.`,
    )
  }
  return scenes.some(scene => (scene as ScenePlanEntry | null)?.clip_renderer === 'sketch_draw'
    && (scene as ScenePlanEntry | null)?.clip_sketch)
}

/**
 * A channel default for the pen, hold, reveal or ink weight is about to MOVE. An episode with no
 * choice of its own FOLLOWS that default, so the new value alone would re-render every Sketch Draw
 * clip it already has — the 2026-11-02 line-weight incident. Before the save, each following episode
 * that has at least one Sketch Draw clip receipt in its scene plan is pinned to the OLD effective
 * value in its own setting file: those clips keep the look they were drawn with, and a re-render of
 * them uses exactly that look. An episode with no clips keeps following the channel and simply gets
 * the new default, as does a new episode.
 *
 * An episode's own choice is never overwritten. A scene plan or setting file that cannot be read
 * refuses the save, naming the episode, and nothing further is written — every episode is read
 * before any pin lands. Nothing here renders anything.
 */
export async function pinEpisodesFollowingChannelSketch(
  slug: string,
  previous: ChannelSketchDefaults,
  changed: { pen: boolean; hold: boolean; reveal: boolean; line_weight: boolean },
): Promise<void> {
  if (!changed.pen && !changed.hold && !changed.reveal && !changed.line_weight) return
  const writes: Array<() => Promise<unknown>> = []
  for (const code of await sketchEpisodeCodesOnDisk(slug)) {
    // Read every own choice first: a malformed setting file throws here and names the episode,
    // and no pin has been written yet.
    const own = {
      pen: changed.pen ? await readEpisodeSketchPen(slug, code) : undefined,
      hold: changed.hold ? await readEpisodeSketchHold(slug, code) : undefined,
      reveal: changed.reveal ? await readEpisodeSketchReveal(slug, code) : undefined,
      line_weight: changed.line_weight ? await readEpisodeSketchLineWeight(slug, code) : undefined,
    }
    const follows = {
      pen: changed.pen && own.pen === null,
      hold: changed.hold && own.hold === null,
      reveal: changed.reveal && own.reveal === null,
      line_weight: changed.line_weight && own.line_weight === null,
    }
    if (!follows.pen && !follows.hold && !follows.reveal && !follows.line_weight) continue
    if (!await episodeHasSketchClipReceipt(slug, code)) continue
    if (follows.pen) writes.push(() => writeEpisodeSketchPen(slug, code, previous.pen))
    if (follows.hold) writes.push(() => writeEpisodeSketchHold(slug, code, previous.hold))
    // A channel that never chose a reveal drew its clips with the line reveal (the generator draws
    // DEFAULT_SKETCH_REVEAL when none is chosen, and a clip with no recorded type IS a line
    // reveal), so the pin is Line — never `null`, which would mean "follow the channel" again.
    if (follows.reveal) writes.push(() => writeEpisodeSketchReveal(slug, code, previous.reveal ?? DEFAULT_SKETCH_REVEAL))
    if (follows.line_weight) writes.push(() => writeEpisodeSketchLineWeight(slug, code, previous.line_weight))
  }
  // Phase two, after every episode has been read successfully: the pins themselves.
  for (const write of writes) await write()
}

/**
 * Frames of closing hold for one scene of an episode under these settings; the freshness rule and the
 * generator share it. `subjectKind` lets an enabled scene-type rule's own hold win, exactly as the
 * reveal rule does; without it the episode/channel hold applies unchanged.
 */
export function sketchHoldFramesFor(settings: Pick<SketchDrawSettings, 'hold' | 'fps' | 'reveal'>, episodeId: string, sceneId: string, frames: number, subjectKind?: string | null): number {
  const hold = sceneTypeHoldFor(settings.reveal, subjectKind) ?? settings.hold
  return resolveSketchHoldFrames(hold, { episodeId, sceneId, frames, fps: settings.fps })
}

/** Resolve selections again at execution/read time; never persist a copied name, logo or fps. */
export async function resolveSketchDrawSettings(slug: string, episodeId: string): Promise<SketchDrawSettings> {
  const config = await pm.getConfig(slug)
  if (!config) throw new Error('Channel configuration is unavailable.')
  const mode = (await resolveEpisodePen(slug, episodeId, config)).pen
  const { hold } = await resolveEpisodeHold(slug, episodeId, config)
  const { reveal } = await resolveEpisodeReveal(slug, episodeId, config)
  const { line_weight: lineWeight } = await resolveEpisodeLineWeight(slug, episodeId, config)
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
    reveal, revealFingerprint: sketchRevealFingerprint(reveal ?? DEFAULT_SKETCH_REVEAL),
    lineWeight }
}

export interface SceneClipFreshnessContext {
  slug: string
  episodeId: string
  episodeDir: string
  /** This ONE scene's source image, when the caller already resolved it. */
  imagePath?: string | null
  /**
   * The folder this episode's scene images live in, resolved ONCE by a caller that checks many
   * scenes. `imagePath` answers for one scene; this lets a loop give every scene its own image
   * without resolving the folder per scene.
   *
   * Both are optional, and neither is trusted to be there: an image registered before
   * `image_sha256` existed (2026-10-16) carries no recorded stamp, and the clip's own
   * `clip_source_image_sha256` is then proven by hashing the scene's own image now. A call site that
   * supplies neither is still CORRECT (the rule resolves the folder itself), just slower.
   */
  imagesDir?: string | null
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
  /**
   * Scene id -> `subject_kind` for this episode's scenes, when the caller has them. Only the optional
   * scene-type rules read it; absent, the plan is the pre-mode one byte-for-byte.
   */
  sceneKinds?: Readonly<Record<string, string | undefined>>
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

/**
 * The scene's OWN source image, resolved by the same rule the renderer draws from
 * (`resolveSceneImageReadPath`: the episode's named images folder first, the legacy flat folder
 * second — never an arbitrary stored path, so the file compared here is one the clip could really
 * have been drawn from).
 *
 * Why the rule resolves this itself: the clip carries `clip_source_image_sha256` — the sha of the
 * exact bytes it was drawn from — but a scene image registered before 2026-10-16 carries no
 * `image_sha256` to compare it to. Every multi-scene caller (completion audit, Motion Review,
 * episode status) used to pass no image at all, so the shared rule answered "cannot verify" for
 * every such clip while the evidence sat on disk. Asking here means no caller can omit the proof.
 */
async function sourceImagePathFor(scene: ScenePlanEntry, context: SceneClipFreshnessContext): Promise<string | null> {
  // Imported lazily: `generators/scene-image.ts` imports this module, and a static import here
  // would close that cycle.
  const { resolveSceneImageReadPath, SCENE_IMAGES_SUBFOLDER } = await import('../generators/scene-image.js')
  if (context.imagesDir) {
    const named = path.join(context.imagesDir, `${scene.id}.png`)
    if (existsSync(named)) return named
    const flat = path.join(context.episodeDir, SCENE_IMAGES_SUBFOLDER, `${scene.id}.png`)
    return existsSync(flat) ? flat : null
  }
  const code = context.episodeId?.trim().toUpperCase()
  if (!context.slug?.trim() || !code || !context.episodeDir) return null
  return resolveSceneImageReadPath(context.slug, code, context.episodeDir, scene.id)
}

/** The one folder this episode's scene images live in — resolved once by a multi-scene caller. */
async function resolveSceneImagesFolder(context: SceneClipFreshnessContext): Promise<string | null> {
  const code = context.episodeId?.trim().toUpperCase()
  if (!context.slug?.trim() || !code || !context.episodeDir) return null
  const { resolveSceneImagesDir } = await import('../generators/scene-image.js')
  return resolveSceneImagesDir(context.slug, code, context.episodeDir)
}

/**
 * Prove (or fail to prove) that the scene's image on disk is still the one a clip recorded.
 * `unavailable` means no image could even be named — never the same value as "it changed".
 */
async function sourceImageProof(scene: ScenePlanEntry, recordedSha: string, context: SceneClipFreshnessContext): Promise<'match' | 'mismatch' | 'unavailable'> {
  const filePath = context.imagePath !== undefined
    ? context.imagePath
    : await sourceImagePathFor(scene, context)
  if (!filePath) return 'unavailable'
  const currentSha = await currentImageSha256(filePath)
  return currentSha === recordedSha ? 'match' : 'mismatch'
}

const CANNOT_VERIFY_SOURCE = 'Sketch Draw cannot verify its source image here. Open Motion Review and Retry.'
/** The clip recorded its source, but the scene's own image is not where it should be. */
const SOURCE_IMAGE_MISSING = 'source image is missing'
const SETTINGS_UNAVAILABLE = 'Sketch Draw settings could not be checked. Choose the pen, reveal style and Video Assembly frame rate again.'
/** Only reachable if a caller omits the episode's scene order from a Mix check; it never guesses. */
const REVEAL_NEEDS_EPISODE = 'Sketch Draw cannot check its reveal style here. Open Motion Review and Retry.'

/** The reveal type one scene resolves to, or null when a Mix needs the episode's scene order and
 *  the caller did not supply it. Never guesses: a wrong answer here silently stales a good clip.
 *  `subjectKind` lets an enabled scene-type rule answer for this scene; `context.sceneKinds` gives
 *  the whole episode's types when the caller has them. */
export function revealTypeFor(reveal: SketchRevealSetting, context: SceneClipFreshnessContext, sceneId: string, subjectKind?: string | null): SketchRevealType | null {
  if (sketchRevealNeedsScenes(reveal) && !context.revealScenes) return null
  const kind = subjectKind ?? context.sceneKinds?.[sceneId]
  const kinds = context.sceneKinds ?? (kind ? { [sceneId]: kind } : undefined)
  const plan = resolveSketchRevealPlan(context.episodeId, context.revealScenes ?? [sceneId], reveal, kinds)
  return plan.get(sceneId) ?? sketchRevealForSingleScene(reveal, sceneId, kind)
}

/** The single freshness rule used by review, approval, completion, status, retry and assembly. */
export async function sceneClipStaleReason(scene: ScenePlanEntry, context?: SceneClipFreshnessContext): Promise<string | null> {
  const isT2V = scene.clip_renderer === 'text_to_video' || scene.visual_lane === 'text_to_video'
  if (isT2V) {
    if (typeof scene.rendered_video_prompt === 'string'
      && scene.rendered_video_prompt !== (scene.video_prompt || '')) return 'stale video prompt'
    return null
  }
  // v1.4.374 — every other lane animates the scene's own picture. When a re-plan
  // changed the scene's prompt, that picture shows different narration, so the
  // clip made from it is stale too, whatever its own stamps say. A T2V clip is
  // judged by its video prompt instead, above.
  if (sceneImageStaleReason(scene)) return 'stale source image'
  const sketch = scene.clip_renderer === 'sketch_draw'
  if (!sketch) {
    // Provider clips are trimmed/held by Assembly; a plan-timing nudge must never turn an
    // existing motion episode into stills. Only their source image and prompt identity matter.
    if (typeof scene.rendered_motion_prompt === 'string'
      && scene.rendered_motion_prompt !== (scene.motion_prompt || '')) return 'stale motion prompt'
    // v1.4.375 — an imported external clip (Google Flow etc., owner 2026-11-02) was made
    // outside the app from this scene's motion prompt, not rendered from the local picture.
    // The picture's version and hash are therefore not its source: comparing them called a
    // fresh import stale whenever the still was imported after the clip (or replaced later),
    // and Assembly silently fell back to the still. Only the prompt it was made from stales it.
    if (scene.clip_renderer === 'external') return null
    if (scene.image_version != null && scene.clip_source_image_version !== scene.image_version) return 'stale source image'
    if (scene.clip_source_image_sha256 !== undefined) {
      const recorded = scene.clip_source_image_sha256
      if (scene.image_sha256) return scene.image_sha256 === recorded ? null : 'stale source image'
      // No recorded image stamp: hash the scene's own image now, exactly as the Sketch Draw branch
      // does. Nothing is invented — an unreadable or different file is still stale.
      const proof = context
        ? await sourceImageProof(scene, recorded, context)
        : 'unavailable' as const
      return proof === 'match' ? null : proof === 'mismatch' ? 'stale source image' : 'source image cannot be verified here'
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
    || receipt.hold_frames !== sketchHoldFramesFor(settings, context.episodeId, scene.id, receipt.frames, scene.subject_kind)) return 'stale closing hold'

  // The reveal style is compared as the type THIS scene resolves to, so editing a Mix stales only
  // the scenes whose type actually moved. An episode (and channel) that has never chosen one keeps
  // every clip it has: nothing was asked for, so nothing can be wrong. A clip from before reveal
  // types has no `reveal_type`; it IS a line reveal, so choosing Line (the default) never stales it.
  if (settings.reveal) {
    const wanted = context.revealType ?? revealTypeFor(settings.reveal, context, scene.id, scene.subject_kind)
    if (wanted === null) return REVEAL_NEEDS_EPISODE
    const recorded = receipt.reveal_type ?? 'line'
    if (recorded !== wanted) return `stale reveal style (${recorded} → ${wanted})`
  }

  // The ink weight is compared as the weight THIS clip was drawn with. A clip recorded before the
  // weight existed was drawn NORMAL, so choosing normal never stales it, and a channel or episode
  // that never chose a weight (normal) stales nothing at all.
  const recordedWeight = receipt.line_weight ?? DEFAULT_SKETCH_LINE_WEIGHT
  if (recordedWeight !== settings.lineWeight) {
    return `stale line weight (${recordedWeight} → ${settings.lineWeight})`
  }

  const clipSha = scene.clip_source_image_sha256
  // No receipt sha at all: the clip never recorded what it was drawn from, so there is nothing to
  // compare and no honest way to call it fresh.
  if (!clipSha) return CANNOT_VERIFY_SOURCE
  if (scene.image_sha256) return scene.image_sha256 === clipSha ? null : 'stale source image'
  // Every scene image registered before 2026-10-16 has no `image_sha256`, and it never will: the
  // stamp is written when an image is registered and nothing rewrites a stored plan. The clip's own
  // `clip_source_image_sha256` is then the proof, compared against the scene's image hashed NOW.
  const proof = await sourceImageProof(scene, clipSha, context)
  if (proof === 'match') return null
  return proof === 'mismatch' ? 'stale source image' : SOURCE_IMAGE_MISSING
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
/**
 * Owner, 1.4.296: a free-fleet scene that still fails on its last automatic try keeps a stand-in
 * rather than failing the episode. This records that decision for this exact prompt.
 */
export async function markSceneImageStandIn(planPath: string, sceneId: string, visualPrompt: string): Promise<void> {
  await withLock(planPath, async () => {
    const plan = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
    const scene = plan.scenes.find(item => item.id === sceneId)
    if (!scene) throw new Error(`Scene ${sceneId} disappeared before its stand-in picture could be recorded.`)
    scene.stand_in_for_prompt = visualPrompt
    await writeJsonAtomic(planPath, plan, { compact: true })
  })
}

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
    if (foundUsable && sceneImageStaleReason(scene)) {
      invalid.push(`${sceneId} (image was rendered from an outdated prompt)`)
      issues.push({ item_id: sceneId, state: 'invalid', reason: 'image was rendered from an outdated prompt' })
    } else if (!foundUsable) {
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
  // The audit checks many scenes, so it resolves the one images folder once and lets the freshness
  // rule join each scene's own id inside it. Without this the rule had no image to hash for a scene
  // whose image predates `image_sha256`, and called a complete clip unknowable (2026-10-28).
  const auditContext = context && context.imagesDir === undefined && context.imagePath === undefined
    ? { ...context, imagesDir: await resolveSceneImagesFolder(context).catch(() => null) }
    : context

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
    const staleReason = await sceneClipStaleReason(scene, auditContext)
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
      scene.rendered_prompt = renderedPrompt
      delete scene.stand_in_for_prompt
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
    delete scene.stand_in_for_prompt
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
    if (receipt.renderer === 'text_to_video') scene.rendered_video_prompt = renderedMotionPrompt
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
