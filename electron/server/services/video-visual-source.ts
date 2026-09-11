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
import { resolveEpisodePathsByCode, resolveEpisodePathsByCodeWithSidecar } from './utils.js'
import { readBrollSelectionSource, type BrollSelectionSidecar, type BrollSelectionSource } from './broll-selection-sidecar.js'
import { writeJsonAtomic } from '../lib/atomic-store.js'
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
): Promise<void> {
  const stat = await fs.stat(finalVideoPath)
  await writeJsonAtomic(
    videoAssemblySourceStampPath(finalVideoPath, episodeId),
    {
      ...buildVideoAssemblySourceStamp(episodeId, source, imagePool),
      final_video: { size: stat.size, mtime_ms: Math.round(stat.mtimeMs) },
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

async function readSidecarForEpisode(slug: string, episodeId: string): Promise<{
  sidecar: VisualSourceSidecar | null
  episodeDir: string
}> {
  const code = episodeId.toUpperCase()
  const withSidecar = await resolveEpisodePathsByCodeWithSidecar(slug, code, 'broll-selection.json')
  const sidecarPath = path.join(withSidecar.episode_dir, 'broll-selection.json')
  let raw: string
  try {
    raw = await fs.readFile(sidecarPath, 'utf8')
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error
    const paths = await resolveEpisodePathsByCode(slug, code)
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
): Promise<VideoVisualSourceState> {
  const { sidecar, episodeDir } = await readSidecarForEpisode(slug, episodeId)
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
