/**
 * Episode-scoped visual source for Video Assembly.
 *
 * Scene Plan remains the default for legacy episodes. Image Pool is an
 * explicit opt-in recorded alongside the existing per-episode selection
 * sidecar, so a stale request body can never change the source at render
 * time.
 */
import { createReadStream, existsSync } from 'fs'
import { createHash } from 'crypto'
import fs from 'fs/promises'
import path from 'path'
import * as bp from './broll-pool-manager.js'
import { resolveEpisodePathsByCode, resolveEpisodePathsByCodeWithSidecar, type ProjectFactsCache } from './utils.js'
import { readBrollSelectionSource, type BrollSelectionSidecar, type BrollSelectionSource } from './broll-selection-sidecar.js'
import { writeJsonAtomic } from '../lib/atomic-store.js'
import { getAudioDuration } from '../lib/ffmpeg-utils.js'
import { getMediaInfo } from '../lib/ffmpeg-validation.js'
import { COVERAGE_FAIL_SEC } from './scene-planner.js'
import type { Job } from '../models/types.js'
import type { SelectionEntry } from '../lib/broll-selector.js'
import {
  isActiveGenStudioProviderState,
  isNeverCreatedProviderTask,
  isSettledProviderEntry,
} from '../lib/provider-task-state.js'

export type VideoVisualSource = BrollSelectionSource

/** The explicit source may be chosen before Image Pool images are picked. */
interface SourceOnlyVisualSidecar {
  schema_version: 1
  episode_code: string
  source: VideoVisualSource
}

type VisualSourceSidecar = BrollSelectionSidecar | SourceOnlyVisualSidecar

export interface ImagePoolVisualSource {
  pool_id: string
  selected_images: SelectionEntry[]
  seconds_per_image: number
  target_duration: number
  generated_at: string
  warnings: string[]
}

export interface VideoVisualSourceState {
  source: VideoVisualSource
  image_pool: ImagePoolVisualSource | null
  sidecar: VisualSourceSidecar | null
  episode_dir: string
}

/** A video-pick sidecar identifies the bespoke B-Roll assembler even though
 * its legacy visual-source value is `scene_plan`. Unstamped Scene Plan finals
 * have no selection sidecar and retain their compatibility path. */
export function videoVisualSourceRequiresBrollProof(source: VideoVisualSourceState): boolean {
  return !!source.sidecar
    && 'selection' in source.sidecar
    && Array.isArray(source.sidecar.selection)
    && source.sidecar.media !== 'image'
}

export interface ResolvedImagePoolSelection extends ImagePoolVisualSource {
  files: Array<{ filename: string; sha256: string; path: string }>
}

export interface VideoAssemblySourceStamp {
  schema_version: 1
  episode_code: string
  source: VideoVisualSource
  final_video?: { size: number; mtime_ms: number }
  image_pool?: {
    pool_id: string
    selected_images: Array<{ filename: string; sha256: string }>
    seconds_per_image: number
  }
  /** Exact local narration rendered by the B-Roll assembler. Scene-based
   *  assembly stamps omit this and retain their existing compatibility. */
  broll_assembly?: {
    narration: BrollNarrationEvidence
  }
}

export interface BrollNarrationEvidence {
  location: 'merged_audio' | 'audio'
  filename: string
  sha256: string
  duration_sec: number
}

export interface BrollAssemblyInspection {
  complete: boolean
  reason: string
  retry_hint: string
  final_video_path?: string
  output_duration_sec?: number
  target_duration_sec?: number
}

export function videoAssemblySourceStampPath(finalVideoPath: string, episodeId: string): string {
  return path.join(path.dirname(finalVideoPath), `${episodeId.toUpperCase()}_video_assembly_source.json`)
}

export function buildVideoAssemblySourceStamp(
  episodeId: string,
  source: VideoVisualSource,
  imagePool?: ImagePoolVisualSource | null,
): VideoAssemblySourceStamp {
  return {
    schema_version: 1,
    episode_code: episodeId.toUpperCase(),
    source,
    ...(source === 'image_pool' && imagePool ? {
      image_pool: {
        pool_id: imagePool.pool_id,
        selected_images: imagePool.selected_images.map(({ filename, sha256 }) => ({ filename, sha256 })),
        seconds_per_image: imagePool.seconds_per_image,
      },
    } : {}),
  }
}

export async function writeVideoAssemblySourceStamp(
  finalVideoPath: string,
  episodeId: string,
  source: VideoVisualSource,
  imagePool?: ImagePoolVisualSource | null,
  brollNarration?: BrollNarrationEvidence,
  narrationOffsetSec?: number,
): Promise<void> {
  const stat = await fs.stat(finalVideoPath)
  await writeJsonAtomic(
    videoAssemblySourceStampPath(finalVideoPath, episodeId),
    {
      ...buildVideoAssemblySourceStamp(episodeId, source, imagePool),
      final_video: { size: stat.size, mtime_ms: Math.round(stat.mtimeMs) },
      ...(narrationOffsetSec !== undefined ? { narration_offset_sec: narrationOffsetSec } : {}),
      ...(brollNarration ? { broll_assembly: { narration: brollNarration } } : {}),
    },
  )
}

function isSelectionEntry(value: unknown): value is SelectionEntry {
  const row = value as Partial<SelectionEntry> | null
  return !!row
    && typeof row.filename === 'string'
    && row.filename.trim().length > 0
    && typeof row.sha256 === 'string'
    && row.sha256.trim().length > 0
    && Number.isFinite(Number(row.target_duration))
    && Number(row.target_duration) > 0
}

function isFilenameInside(folder: string, filename: string): boolean {
  if (path.isAbsolute(filename)) return false
  const root = path.resolve(folder)
  const candidate = path.resolve(root, filename)
  const relative = path.relative(root, candidate)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

async function readSidecarForEpisode(slug: string, episodeId: string, cache?: ProjectFactsCache): Promise<{
  sidecar: VisualSourceSidecar | null
  episodeDir: string
}> {
  const code = episodeId.toUpperCase()
  const withSidecar = await resolveEpisodePathsByCodeWithSidecar(slug, code, 'broll-selection.json', cache)
  const sidecarPath = path.join(withSidecar.episode_dir, 'broll-selection.json')
  let raw: string
  try {
    raw = await fs.readFile(sidecarPath, 'utf8')
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error
    const paths = await resolveEpisodePathsByCode(slug, code, cache)
    return { sidecar: null, episodeDir: paths.episode_dir }
  }
  try {
    const sidecar = JSON.parse(raw) as unknown
    readBrollSelectionSource(sidecar)
    return { sidecar: sidecar as VisualSourceSidecar, episodeDir: withSidecar.episode_dir }
  } catch (error: any) {
    throw new Error(`Video Assembly is blocked: broll-selection.json is malformed for ${code}. Pick images again, then retry. (${error?.message || error})`)
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

async function eligibleMediaPaths(folder: string, pattern: RegExp): Promise<string[]> {
  let names: string[]
  try {
    names = await fs.readdir(folder)
  } catch (error: any) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return []
    throw error
  }
  const candidates: string[] = []
  for (const name of names) {
    if (name.startsWith('.tmp_') || !pattern.test(name)) continue
    const candidate = path.join(folder, name)
    if (await existingFile(candidate)) candidates.push(candidate)
  }
  return candidates
}

/** One narration authority shared by picker, producer, and completion audit. */
export async function resolveAuthoritativeBrollNarration(
  paths: Pick<Awaited<ReturnType<typeof resolveEpisodePathsByCode>>, 'episode_dir' | 'merged_audio_dir' | 'audio_dir'>,
  episodeId: string,
): Promise<string | null> {
  const { inspectAudioMergeAtPaths } = await import('./asset-status.js')
  const merge = await inspectAudioMergeAtPaths(paths, episodeId)
  if (merge.present && merge.path) return merge.path

  if ((await eligibleMediaPaths(paths.merged_audio_dir, /\.(mp3|wav|m4a)$/i)).length) {
    throw new Error('Merged narration exists but is stale or unverified. Repair Audio Assembly before B-Roll Assembly.')
  }

  const raw = await eligibleMediaPaths(paths.audio_dir, /\.mp3$/i)
  if (raw.length > 1) {
    throw new Error('Raw narration is ambiguous: B-Roll Assembly requires exactly one eligible raw MP3 or a verified Audio Assembly merge.')
  }
  return raw[0] || null
}

/** Capture the exact narration identity before B-Roll rendering starts. */
export async function snapshotBrollNarration(
  narrationPath: string,
  paths: Pick<Awaited<ReturnType<typeof resolveEpisodePathsByCode>>, 'episode_dir' | 'merged_audio_dir' | 'audio_dir'>,
  episodeId: string,
): Promise<BrollNarrationEvidence> {
  const absolute = path.resolve(narrationPath)
  const parent = path.dirname(absolute)
  const location = parent === path.resolve(paths.merged_audio_dir)
    ? 'merged_audio'
    : parent === path.resolve(paths.audio_dir)
      ? 'audio'
      : null
  if (!location) throw new Error('B-Roll Assembly cannot prove narration outside this episode. Retry after Audio Assembly.')
  const authoritative = await resolveAuthoritativeBrollNarration(paths, episodeId)
  if (!authoritative || path.resolve(authoritative) !== absolute) {
    throw new Error('B-Roll Assembly selected narration that is not the current authoritative source. Repair Audio Assembly, then Retry.')
  }
  const duration = await getAudioDuration(absolute)
  if (!Number.isFinite(duration) || Number(duration) <= 0) {
    throw new Error('B-Roll Assembly could not measure the selected narration. Repair Audio Assembly, then Retry.')
  }
  return {
    location,
    filename: path.basename(absolute),
    sha256: await sha256File(absolute),
    duration_sec: Number(duration),
  }
}

export function videoAssemblySourceStampMatches(
  stamp: VideoAssemblySourceStamp,
  source: VideoVisualSourceState,
  episodeId: string,
): boolean {
  if (stamp.schema_version !== 1
    || stamp.episode_code !== episodeId.toUpperCase()
    || stamp.source !== source.source) return false
  if (source.source !== 'image_pool') return true
  const current = source.image_pool
  const saved = stamp.image_pool
  if (!current || !saved || saved.pool_id !== current.pool_id
    || Math.abs(saved.seconds_per_image - current.seconds_per_image) > 0.001
    || saved.selected_images.length !== current.selected_images.length) return false
  return saved.selected_images.every((row, index) => {
    const currentRow = current.selected_images[index]
    return !!currentRow && row.filename === currentRow.filename && row.sha256 === currentRow.sha256
  })
}

function incompleteBroll(reason: string): BrollAssemblyInspection {
  return {
    complete: false,
    reason,
    retry_hint: 'Retry B-Roll Assembly; completed inputs are preserved.',
  }
}

/** Probe the staged/final bytes against the frozen rendered narration target. */
export async function inspectBrollRenderCoverage(
  renderPath: string,
  targetDurationSec: number,
): Promise<BrollAssemblyInspection> {
  if (!await existingFile(renderPath)) {
    return incompleteBroll('B-Roll rendered video is missing or empty.')
  }
  if (!Number.isFinite(targetDurationSec) || targetDurationSec <= 0) {
    return incompleteBroll('B-Roll narration target duration is missing or unusable.')
  }
  let media: Awaited<ReturnType<typeof getMediaInfo>>
  try {
    media = await getMediaInfo(renderPath)
  } catch {
    return incompleteBroll('B-Roll rendered video could not be inspected.')
  }
  if (!media.hasVideo) {
    return incompleteBroll('B-Roll rendered output has no video stream.')
  }
  if (!media.hasAudio) {
    return incompleteBroll('B-Roll rendered output has no narration audio stream.')
  }
  const videoDuration = media.videoDurationSec
  if (!Number.isFinite(videoDuration) || Number(videoDuration) <= 0) {
    return incompleteBroll('B-Roll rendered video stream duration could not be measured.')
  }
  const audioDuration = media.audioDurationSec
  if (!Number.isFinite(audioDuration) || Number(audioDuration) <= 0) {
    return incompleteBroll('B-Roll rendered narration audio stream duration could not be measured.')
  }
  if (targetDurationSec - Number(videoDuration) > COVERAGE_FAIL_SEC) {
    return {
      ...incompleteBroll(
        `B-Roll rendered video is partial (${Number(videoDuration).toFixed(1)}s of ${targetDurationSec.toFixed(1)}s narration).`,
      ),
      output_duration_sec: Number(videoDuration),
      target_duration_sec: targetDurationSec,
    }
  }
  if (targetDurationSec - Number(audioDuration) > COVERAGE_FAIL_SEC) {
    return {
      ...incompleteBroll(
        `B-Roll rendered narration audio is partial (${Number(audioDuration).toFixed(1)}s of ${targetDurationSec.toFixed(1)}s narration).`,
      ),
      output_duration_sec: Number(audioDuration),
      target_duration_sec: targetDurationSec,
    }
  }
  const outputDuration = Math.min(Number(videoDuration), Number(audioDuration))
  return {
    complete: true,
    reason: 'rendered video covers its narration target',
    retry_hint: '',
    output_duration_sec: Number(outputDuration),
    target_duration_sec: targetDurationSec,
  }
}

async function existingFile(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath)
    return stat.isFile() && stat.size > 0
  } catch (error: any) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false
    throw error
  }
}

async function resolveBrollFinalPath(input: {
  project_slug: string
  episode_id: string
  title?: string
  output_dir?: string
  final_video_path?: string
}): Promise<{ path?: string; error?: string }> {
  const filename = `${input.episode_id.toUpperCase()}_final_video.mp4`
  if (input.final_video_path) return { path: path.resolve(input.final_video_path) }
  if (input.output_dir) return { path: path.resolve(input.output_dir, filename) }

  const paths = await resolveEpisodePathsByCodeWithSidecar(
    input.project_slug, input.episode_id, 'broll-selection.json',
  )
  const candidates = [path.join(paths.video_dir, filename)]
  const { resolveExternalFinalVideoDir } = await import('./external-video-store.js')
  const external = await resolveExternalFinalVideoDir(
    input.project_slug, input.episode_id, input.title || '',
  )
  if (external) candidates.push(path.join(external, filename))
  const present: string[] = []
  for (const candidate of new Set(candidates.map(value => path.resolve(value)))) {
    if (await existingFile(candidate)) present.push(candidate)
  }
  if (present.length === 1) return { path: present[0] }
  if (present.length > 1) {
    return { error: 'B-Roll final video is ambiguous across project and external storage.' }
  }
  return { error: 'B-Roll final video is missing.' }
}

/**
 * Prove one B-Roll final from the promoted file and the producer's durable
 * narration evidence. Legacy sidecars are context only, never completion.
 */
export async function inspectBrollAssemblyOutput(input: {
  project_slug: string
  episode_id: string
  title?: string
  output_dir?: string
  final_video_path?: string
}): Promise<BrollAssemblyInspection> {
  const sidecarState = await readVideoVisualSource(input.project_slug, input.episode_id)
  const legacyTarget = Number(
    sidecarState.sidecar && 'target_duration' in sidecarState.sidecar
      ? sidecarState.sidecar.target_duration
      : NaN,
  )
  const resolved = await resolveBrollFinalPath(input)
  if (!resolved.path) return incompleteBroll(`${resolved.error} Run B-Roll Assembly again.`)
  const finalPath = resolved.path
  if (!await existingFile(finalPath)) {
    return incompleteBroll('B-Roll final video is missing or empty. Run B-Roll Assembly again.')
  }

  let stamp: VideoAssemblySourceStamp
  try {
    stamp = JSON.parse(await fs.readFile(
      videoAssemblySourceStampPath(finalPath, input.episode_id), 'utf8',
    )) as VideoAssemblySourceStamp
  } catch (error: any) {
    if (!Number.isFinite(legacyTarget) || legacyTarget <= 0) {
      return incompleteBroll('B-Roll target duration is unknown. Pick B-Roll again, then Retry Assembly.')
    }
    return incompleteBroll('B-Roll final video has no durable narration proof. Retry B-Roll Assembly.')
  }

  if (!videoAssemblySourceStampMatches(stamp, sidecarState, input.episode_id)) {
    return incompleteBroll('B-Roll visual-source proof is stale. Retry B-Roll Assembly.')
  }
  const finalStat = await fs.stat(finalPath)
  if (!stamp.final_video
    || stamp.final_video.size !== finalStat.size
    || stamp.final_video.mtime_ms !== Math.round(finalStat.mtimeMs)) {
    return incompleteBroll('B-Roll final video changed after its completion proof. Retry B-Roll Assembly.')
  }

  const narration = stamp.broll_assembly?.narration
  if (!narration || !['merged_audio', 'audio'].includes(narration.location)
    || !narration.filename || path.basename(narration.filename) !== narration.filename
    || !narration.sha256 || !Number.isFinite(narration.duration_sec) || narration.duration_sec <= 0) {
    return incompleteBroll('B-Roll narration proof is missing or unusable. Retry B-Roll Assembly.')
  }
  // The sidecar is the existing authority for the titled episode directory.
  // Code-only resolution can choose the legacy code-only sibling in imported
  // projects and falsely report the rendered narration as missing.
  const paths = await resolveEpisodePathsByCodeWithSidecar(
    input.project_slug, input.episode_id, 'broll-selection.json',
  )
  const narrationDir = narration.location === 'merged_audio' ? paths.merged_audio_dir : paths.audio_dir
  const narrationPath = path.join(narrationDir, narration.filename)
  if (!await existingFile(narrationPath)) {
    return incompleteBroll('B-Roll rendered narration is missing. Repair Audio Assembly, then Retry B-Roll Assembly.')
  }
  let authoritativeNarration: string | null
  try {
    authoritativeNarration = await resolveAuthoritativeBrollNarration(paths, input.episode_id)
  } catch (error: any) {
    return incompleteBroll(error?.message || 'B-Roll narration authority could not be resolved.')
  }
  if (!authoritativeNarration || path.resolve(authoritativeNarration) !== path.resolve(narrationPath)) {
    return incompleteBroll('B-Roll rendered narration is no longer the authoritative episode narration. Retry B-Roll Assembly.')
  }
  const [currentHash, currentDuration] = await Promise.all([
    sha256File(narrationPath),
    getAudioDuration(narrationPath),
  ])
  if (currentHash !== narration.sha256
    || !Number.isFinite(currentDuration)
    || Math.abs(Number(currentDuration) - narration.duration_sec) > 0.05) {
    return incompleteBroll('B-Roll rendered narration changed after this final was made. Retry B-Roll Assembly.')
  }
  const coverage = await inspectBrollRenderCoverage(finalPath, narration.duration_sec)
  if (!coverage.complete) return { ...coverage, final_video_path: finalPath }
  return {
    complete: true,
    reason: 'final video and rendered narration proof are current',
    retry_hint: '',
    final_video_path: finalPath,
    output_duration_sec: coverage.output_duration_sec,
    target_duration_sec: narration.duration_sec,
  }
}

function isImagePoolSelectionSidecar(sidecar: VisualSourceSidecar | null): sidecar is BrollSelectionSidecar {
  return !!sidecar && 'media' in sidecar && sidecar.media === 'image' && Array.isArray(sidecar.selection)
}

function imagePoolSnapshot(sidecar: VisualSourceSidecar | null): ImagePoolVisualSource | null {
  if (!isImagePoolSelectionSidecar(sidecar) || sidecar.source !== 'image_pool'
    || !sidecar.selection.length || sidecar.selection.some(row => !isSelectionEntry(row))) return null
  const selected = sidecar.selection
  const firstDuration = selected[0]?.target_duration || 1
  return {
    pool_id: sidecar.pool_id,
    selected_images: selected,
    seconds_per_image: Math.max(0.5, Number(sidecar.segment_seconds) || firstDuration),
    target_duration: Math.max(0, Number(sidecar.target_duration) || 0),
    generated_at: typeof sidecar.generated_at === 'string' ? sidecar.generated_at : '',
    warnings: Array.isArray(sidecar.warnings) ? sidecar.warnings.map(String) : [],
  }
}

/** Read the durable source choice. Missing/legacy source means Scene Plan. */
export async function readVideoVisualSource(
  slug: string,
  episodeId: string,
  cache?: ProjectFactsCache,
): Promise<VideoVisualSourceState> {
  const { sidecar, episodeDir } = await readSidecarForEpisode(slug, episodeId, cache)
  const source: VideoVisualSource = sidecar?.source === 'image_pool' ? 'image_pool' : 'scene_plan'
  return { source, image_pool: source === 'image_pool' ? imagePoolSnapshot(sidecar) : null, sidecar, episode_dir: episodeDir }
}

/**
 * Validate the frozen selection against the currently registered pool.
 * The selection is never regenerated here: a changed/missing file blocks the
 * render and tells the caller what must be repaired.
 */
export async function resolveImagePoolSelection(
  slug: string,
  episodeId: string,
  targetDuration?: number,
): Promise<ResolvedImagePoolSelection> {
  const state = await readVideoVisualSource(slug, episodeId)
  // A source-only sidecar is deliberate but unready. Rendering still needs a
  // complete frozen image selection and must never repair or substitute one.
  if (!isImagePoolSelectionSidecar(state.sidecar)) {
    throw new Error(`Video Assembly is blocked: ${episodeId} is set to Image Pool but its image selection is missing. Pick images again, then retry.`)
  }
  const sidecar = state.sidecar
  const poolId = sidecar.pool_id
  if (!poolId) throw new Error(`Video Assembly is blocked: Image Pool selection for ${episodeId} has no pool id. Pick images again, then retry.`)
  const pool = await bp.getPool(poolId)
  if (!pool || bp.poolMedia(pool) !== 'image') {
    throw new Error(`Video Assembly is blocked: Image Pool '${poolId}' is missing or is not an image pool. Choose an online image pool and pick images again.`)
  }
  if (!existsSync(pool.folder_path)) {
    throw new Error(`Video Assembly is blocked: Image Pool folder is offline: ${pool.folder_path}. Connect it and retry.`)
  }

  const rawSelection = sidecar.selection
  if (!rawSelection.length || rawSelection.some(row => !isSelectionEntry(row))) {
    throw new Error(`Video Assembly is blocked: Image Pool selection for ${episodeId} is empty or malformed. Pick images again, then retry.`)
  }
  const indexed = new Map((await bp.listClips(poolId, { includeMissing: false })).map(clip => [clip.filename, clip]))
  const files: ResolvedImagePoolSelection['files'] = []
  for (const row of rawSelection) {
    const entry = row as SelectionEntry
    if (!isFilenameInside(pool.folder_path, entry.filename)) {
      throw new Error(`Video Assembly is blocked: Image Pool selection contains an invalid filename: ${entry.filename}`)
    }
    const clip = indexed.get(entry.filename)
    if (!clip || clip.missing) {
      throw new Error(`Video Assembly is blocked: selected Image Pool asset is missing or offline: ${entry.filename}. Pick images again after reconnecting the pool.`)
    }
    if (clip.sha256 !== entry.sha256) {
      throw new Error(`Video Assembly is blocked: selected Image Pool asset hash changed: ${entry.filename}. Re-index the pool and pick images again.`)
    }
    const assetPath = path.resolve(pool.folder_path, entry.filename)
    const stat = await fs.stat(assetPath).catch(() => null)
    if (!stat?.isFile() || stat.size <= 0) {
      throw new Error(`Video Assembly is blocked: selected Image Pool asset is unavailable: ${entry.filename}. Connect the pool and retry.`)
    }
    const actualHash = await sha256File(assetPath).catch(() => '')
    if (!actualHash || actualHash !== entry.sha256) {
      throw new Error(`Video Assembly is blocked: selected Image Pool asset bytes changed: ${entry.filename}. Re-index the pool and pick images again.`)
    }
    files.push({ filename: entry.filename, sha256: entry.sha256, path: assetPath })
  }

  const selected = rawSelection as SelectionEntry[]
  const fallbackSeconds = selected[0]?.target_duration || 1
  return {
    pool_id: poolId,
    selected_images: selected,
    seconds_per_image: Math.max(0.5, Number(sidecar.segment_seconds) || fallbackSeconds),
    target_duration: Math.max(0, Number(targetDuration ?? sidecar.target_duration) || 0),
    generated_at: typeof sidecar.generated_at === 'string' ? sidecar.generated_at : '',
    warnings: Array.isArray(sidecar.warnings) ? sidecar.warnings.map(String) : [],
    files,
  }
}

/** Expand the frozen list into a deterministic cyclic still timeline. */
export function buildImagePoolPlayOrder(
  selection: ResolvedImagePoolSelection,
  targetDuration: number,
): Array<{ path: string; filename: string; duration: number; sha256: string }> {
  const target = Math.max(0, Number(targetDuration) || 0)
  if (!selection.files.length || target <= 0) return []
  const byFilename = new Map(selection.files.map(file => [file.filename, file]))
  const rows = selection.selected_images
  const fallbackSeconds = rows[0]?.target_duration || 1
  const output: Array<{ path: string; filename: string; duration: number; sha256: string }> = []
  let remaining = target
  let index = 0
  while (remaining > 0.001) {
    const row = rows[index % rows.length]!
    const file = byFilename.get(row.filename)!
    const duration = Math.min(Math.max(0.5, selection.seconds_per_image || Number(row.target_duration) || fallbackSeconds), remaining)
    output.push({ path: file.path, filename: file.filename, duration, sha256: file.sha256 })
    remaining -= duration
    index++
    if (index > 100_000) throw new Error('Image Pool selection could not cover the merged narration duration.')
  }
  return output
}

/** Persist an explicit source while preserving the existing selection sidecar. */
export async function setVideoVisualSource(
  slug: string,
  episodeId: string,
  source: VideoVisualSource,
): Promise<VideoVisualSourceState> {
  if (source !== 'scene_plan' && source !== 'image_pool') throw new Error('source must be scene_plan or image_pool')
  const state = await readVideoVisualSource(slug, episodeId)
  if (state.sidecar) {
    // Write beside the sidecar we just resolved. Passing a title to the
    // generic save helper could select a stale renamed sibling.
    await writeJsonAtomic(path.join(state.episode_dir, 'broll-selection.json'), { ...state.sidecar, source })
  } else if (source === 'image_pool') {
    await writeJsonAtomic(path.join(state.episode_dir, 'broll-selection.json'), {
      schema_version: 1,
      episode_code: episodeId.toUpperCase(),
      source,
    } satisfies SourceOnlyVisualSidecar)
  }
  // The episode list keeps this episode's visual source on its status row.
  ;(await import('./episode-status-cache.js')).episodeStatusCache.invalidate(slug, episodeId)
  return readVideoVisualSource(slug, episodeId)
}

/** A queued visual step cannot silently follow a source selected after Run.
 * Existing paid work continues through its saved request identities. Historical
 * jobs without this snapshot keep their established recovery behavior.
 */
export async function assertQueuedVisualSource(job: Pick<Job, 'type' | 'params' | 'project_slug' | 'episode_id' | 'genstudio_jobs'>): Promise<void> {
  const expected = job.params?.visual_source
  if (!expected || !job.episode_id) return
  if (!['scene_plan_run', 'scene_image_generate', 'scene_clips_batch', 'scene_clip_generate', 'continuity_render', 'video_assembly'].includes(job.type)) return
  const hasAcceptedProviderTask = (job.genstudio_jobs || []).some(entry => (
    typeof entry.id === 'string'
    && entry.id.trim().length > 0
    && !entry.id.startsWith('pending:')
    && !isNeverCreatedProviderTask(entry)
    && (isActiveGenStudioProviderState(entry.state) || isSettledProviderEntry(entry))
  ))
  if (job.type !== 'video_assembly' && job.type !== 'continuity_render' && hasAcceptedProviderTask) return
  const current = await readVideoVisualSource(job.project_slug, job.episode_id)
  if (current.source !== expected) {
    throw new Error(`${job.episode_id}: visual source changed after this job was queued. Restore its ${expected === 'image_pool' ? 'Image Pool' : 'Scene Plan'} source to resume, or start a new run with the current source.`)
  }
}
