import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import type { Job, JobStatus } from '../models/types.js'
import { getWorkTempRoot, sanitizeWorkTempSegment } from './work-tempdir.js'

export interface VideoAssemblyCompletedSceneClip {
  scene_index: number
  clip_path: string
  render_duration_sec: number
}

/** One finished segment of the final render (1.4.265, lib/segmented-render.ts). */
export interface VideoAssemblyFinalSegment {
  index: number
  start_sec: number
  end_sec: number
  path: string
  bytes: number
  sha256: string
}

export interface VideoAssemblyFinalSegments {
  /** Hash of the inputs, the encoder settings and the segment plan. Any change re-renders every segment. */
  fingerprint: string
  segments: VideoAssemblyFinalSegment[]
}

/**
 * The final render's exact command and the work-folder files it reads (1.4.265). After a restart or
 * an update, an episode whose inputs and settings are unchanged (`inputs`: the render fingerprint
 * without the app version) finishes this render as it began instead of starting over.
 */
export interface VideoAssemblyFinalStage {
  inputs: string
  argv: string[]
  /**
   * Work-folder-relative file name → sha256, `/`-separated and nested where the command reads a
   * subfolder (`loudness_first/premixed_audio.wav`) — every work-folder path the argv names.
   */
  files: Record<string, string>
  total_render_sec: number
  still_tail_from: number | null
  narration_offset_sec?: number
}

export interface VideoAssemblyCheckpoint {
  version: 1
  job_id: string
  project_slug: string
  episode_id: string
  work_dir: string
  render_fingerprint: string
  completed_scene_clips: VideoAssemblyCompletedSceneClip[]
  final_segments?: VideoAssemblyFinalSegments
  final_stage?: VideoAssemblyFinalStage
}

const SHA256_RE = /^[a-f0-9]{64}$/

function finalSegmentPath(workDir: string, index: number): string {
  return path.join(workDir, 'final_segments', `final_seg_${String(index).padStart(4, '0')}.mp4`)
}

/**
 * A work-folder-relative file name, `/`-separated: nested (`loudness_first/premixed_audio.wav`) but
 * never hidden, never absolute, and never climbing out of the folder.
 */
function validWorkFileName(name: string): boolean {
  const parts = name.split('/')
  return parts.length > 0 && parts.every(part => !!part && !part.startsWith('.'))
}

function validFinalStage(value: unknown): boolean {
  if (value === undefined) return true
  const stage = value as Record<string, unknown> | null
  return !!stage && typeof stage === 'object'
    && typeof stage.inputs === 'string' && SHA256_RE.test(stage.inputs)
    && Array.isArray(stage.argv) && stage.argv.length > 0 && stage.argv.every(arg => typeof arg === 'string')
    && !!stage.files && typeof stage.files === 'object'
    && Object.entries(stage.files as Record<string, unknown>).every(([name, sha]) => (
      validWorkFileName(name) && typeof sha === 'string' && SHA256_RE.test(sha)))
    && typeof stage.total_render_sec === 'number' && Number.isFinite(stage.total_render_sec) && stage.total_render_sec > 0
    && (stage.narration_offset_sec === undefined || (typeof stage.narration_offset_sec === 'number' && Number.isFinite(stage.narration_offset_sec) && stage.narration_offset_sec >= 0))
    && (stage.still_tail_from === null || (typeof stage.still_tail_from === 'number' && Number.isFinite(stage.still_tail_from)))
}

function validFinalSegments(value: unknown, workDir: string): boolean {
  if (value === undefined) return true
  const group = value as Record<string, unknown> | null
  if (!group || typeof group !== 'object' || typeof group.fingerprint !== 'string'
    || !SHA256_RE.test(group.fingerprint) || !Array.isArray(group.segments)) return false
  const indexes = new Set<number>()
  return group.segments.every((value) => {
    const seg = value as Record<string, unknown> | null
    if (!seg || typeof seg !== 'object' || !Number.isInteger(seg.index) || (seg.index as number) < 0
      || indexes.has(seg.index as number)) return false
    indexes.add(seg.index as number)
    return typeof seg.start_sec === 'number' && typeof seg.end_sec === 'number'
      && Number.isFinite(seg.start_sec) && Number.isFinite(seg.end_sec) && seg.end_sec > seg.start_sec
      && Number.isInteger(seg.bytes) && (seg.bytes as number) > 0
      && typeof seg.sha256 === 'string' && SHA256_RE.test(seg.sha256)
      && seg.path === finalSegmentPath(workDir, seg.index as number)
  })
}

const CHECKPOINT_KEY = 'video_assembly_checkpoint'
const NONTERMINAL_STATUSES: readonly JobStatus[] = ['queued', 'running', 'paused']
const FINGERPRINT_RE = /^[a-f0-9]{64}$/
const RUN_DIR_RE = /^\.tmp_\d+$/

function checkpointFrom(job: Pick<Job, 'result'>): unknown {
  return job.result?.[CHECKPOINT_KEY]
}

function structurallyValidCheckpoint(value: unknown): value is VideoAssemblyCheckpoint {
  if (!value || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  if (row.version !== 1
    || typeof row.job_id !== 'string' || !row.job_id
    || typeof row.project_slug !== 'string' || !row.project_slug
    || typeof row.episode_id !== 'string' || !row.episode_id
    || typeof row.work_dir !== 'string' || !path.isAbsolute(row.work_dir)
    || typeof row.render_fingerprint !== 'string' || !FINGERPRINT_RE.test(row.render_fingerprint)
    || !Array.isArray(row.completed_scene_clips)) return false

  const indexes = new Set<number>()
  for (const value of row.completed_scene_clips) {
    if (!value || typeof value !== 'object') return false
    const clip = value as Record<string, unknown>
    if (!Number.isInteger(clip.scene_index) || (clip.scene_index as number) < 0
      || indexes.has(clip.scene_index as number)
      || typeof clip.clip_path !== 'string'
      || typeof clip.render_duration_sec !== 'number'
      || !Number.isFinite(clip.render_duration_sec)
      || clip.render_duration_sec <= 0) return false
    const expectedPath = path.join(row.work_dir, `scene_${String(clip.scene_index).padStart(4, '0')}.mp4`)
    if (clip.clip_path !== expectedPath) return false
    indexes.add(clip.scene_index as number)
  }
  return validFinalSegments(row.final_segments, row.work_dir) && validFinalStage(row.final_stage)
}

function isCanonicalOwnedWorkDir(checkpoint: VideoAssemblyCheckpoint): Promise<boolean> {
  return isOwnedVideoAssemblyWorkDir(checkpoint.project_slug, checkpoint.episode_id, checkpoint.work_dir)
}

/** True only for a real run folder directly under this project's and episode's own work-temp folder. */
export async function isOwnedVideoAssemblyWorkDir(projectSlug: string, episode: string, workDir: string): Promise<boolean> {
  if (typeof workDir !== 'string' || !path.isAbsolute(workDir)) return false
  const runName = path.basename(workDir)
  if (!RUN_DIR_RE.test(runName)) return false
  const root = getWorkTempRoot()
  const rootRelative = path.relative(root, workDir)
  if (!rootRelative || path.isAbsolute(rootRelative) || rootRelative.startsWith(`..${path.sep}`)) return false
  const expectedParent = path.join(root, sanitizeWorkTempSegment(projectSlug), sanitizeWorkTempSegment(episode))
  if (path.dirname(workDir) !== expectedParent) return false

  try {
    const [rootReal, parentReal, workReal, workStat] = await Promise.all([
      fs.realpath(root),
      fs.realpath(expectedParent),
      fs.realpath(workDir),
      fs.lstat(workDir),
    ])
    if (!workStat.isDirectory() || workStat.isSymbolicLink()) return false
    return parentReal === path.join(rootReal, sanitizeWorkTempSegment(projectSlug), sanitizeWorkTempSegment(episode))
      && workReal === path.join(parentReal, runName)
  } catch {
    return false
  }
}

export async function getValidVideoAssemblyCheckpoint(
  job: Pick<Job, 'job_id' | 'project_slug' | 'episode_id' | 'type' | 'status' | 'result'>,
  allowedStatuses: readonly JobStatus[] = NONTERMINAL_STATUSES,
): Promise<VideoAssemblyCheckpoint | null> {
  const checkpoint = checkpointFrom(job)
  if (job.type !== 'video_assembly' || !allowedStatuses.includes(job.status)
    || !structurallyValidCheckpoint(checkpoint)) return null
  if (checkpoint.job_id !== job.job_id
    || checkpoint.project_slug !== job.project_slug
    || checkpoint.episode_id !== job.episode_id) return null
  return await isCanonicalOwnedWorkDir(checkpoint) ? checkpoint : null
}

export async function collectProtectedVideoAssemblyWorkDirs(
  jobs: unknown[],
): Promise<Set<string>> {
  const protectedDirs = new Set<string>()
  for (const value of jobs) {
    if (!value || typeof value !== 'object') continue
    const job = value as Pick<Job, 'job_id' | 'project_slug' | 'episode_id' | 'type' | 'status' | 'result'>
    const checkpoint = await getValidVideoAssemblyCheckpoint(job)
    if (checkpoint) protectedDirs.add(checkpoint.work_dir)
  }
  return protectedDirs
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonicalValue(item)]),
  )
}

function absolutePaths(value: unknown, found = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    if (path.isAbsolute(value)) found.add(path.resolve(value))
    return found
  }
  if (Array.isArray(value)) {
    for (const item of value) absolutePaths(item, found)
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) absolutePaths(item, found)
  }
  return found
}

/** Hash resolved settings plus durable filesystem identity for every absolute input path. */
export async function buildVideoAssemblyRenderFingerprint(renderState: unknown): Promise<string> {
  const sources: Array<Record<string, unknown>> = []
  for (const sourcePath of [...absolutePaths(renderState)].sort()) {
    try {
      const [stat, realPath] = await Promise.all([fs.stat(sourcePath), fs.realpath(sourcePath)])
      sources.push({
        path: sourcePath,
        real_path: realPath,
        kind: stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other',
        dev: stat.dev,
        ino: stat.ino,
        size: stat.size,
        mtime_ms: stat.mtimeMs,
      })
    } catch {
      sources.push({ path: sourcePath, missing: true })
    }
  }
  return createHash('sha256')
    .update(JSON.stringify(canonicalValue({ render_state: renderState, sources })))
    .digest('hex')
}

export function createVideoAssemblyCheckpoint(
  job: Pick<Job, 'job_id' | 'project_slug' | 'episode_id'>,
  workDir: string,
  renderFingerprint: string,
  completedSceneClips: VideoAssemblyCompletedSceneClip[] = [],
  finalSegments?: VideoAssemblyFinalSegments,
): VideoAssemblyCheckpoint {
  return {
    version: 1,
    job_id: job.job_id,
    project_slug: job.project_slug,
    episode_id: job.episode_id,
    work_dir: workDir,
    render_fingerprint: renderFingerprint,
    completed_scene_clips: completedSceneClips,
    ...(finalSegments ? { final_segments: finalSegments } : {}),
  }
}

/**
 * Move the final render's work files into the fresh work dir and point its command there. Null when
 * any of them is missing or changed (sha256): the episode then renders from the start as before.
 *
 * The set moved is EVERY work-folder path the saved command reads, nested ones included — not just
 * the ones an older checkpoint happened to record. The whole set is checked for presence, and the
 * recorded ones for content, BEFORE anything moves: a command that would run against a file the old
 * folder no longer holds is never resumed, and the folder is never emptied of a file it still needs
 * (Myth EP0012, 2026-10-20).
 */
export async function moveCheckpointFinalStage(
  checkpoint: VideoAssemblyCheckpoint,
  workDir: string,
): Promise<VideoAssemblyFinalStage | null> {
  const stage = checkpoint.final_stage
  if (!stage) return null
  const { workFolderDependencies, workFolderIdentity } = await import('./segmented-render.js')
  const { escapeFilterPath } = await import('./ffmpeg-utils.js')
  const output = stage.argv.at(-1) ?? ''
  const here = await workFolderIdentity(stage.argv, checkpoint.work_dir, output)
  for (const [name, sha] of Object.entries(stage.files)) {
    if (here.files[name] !== sha) return null
  }
  const dependencies = workFolderDependencies(stage.argv, checkpoint.work_dir, output)
  if (dependencies.some(name => here.files[name] === undefined)) return null
  for (const name of dependencies) {
    const parts = name.split('/')
    const target = path.join(workDir, ...parts)
    try {
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.rename(path.join(checkpoint.work_dir, ...parts), target)
    } catch {
      return null
    }
  }
  const swap = (arg: string) => arg.split(escapeFilterPath(checkpoint.work_dir)).join(escapeFilterPath(workDir))
    .split(checkpoint.work_dir).join(workDir)
  return { ...stage, argv: stage.argv.map(swap), files: here.files }
}

/**
 * Move a checkpoint's finished final-render segments into the fresh work dir, before
 * `moveCheckpointSceneClips` drops the old one. Each is checked again (size and sha256) when the
 * final render resumes; one that cannot be moved is rendered again.
 */
export async function moveCheckpointFinalSegments(
  checkpoint: VideoAssemblyCheckpoint,
  workDir: string,
): Promise<VideoAssemblyFinalSegments | undefined> {
  const group = checkpoint.final_segments
  if (!group) return undefined
  if (path.resolve(checkpoint.work_dir) === path.resolve(workDir)) return group
  const segments: VideoAssemblyFinalSegment[] = []
  await fs.mkdir(path.join(workDir, 'final_segments'), { recursive: true })
  for (const seg of group.segments) {
    const target = finalSegmentPath(workDir, seg.index)
    try {
      await fs.rename(seg.path, target)
      segments.push({ ...seg, path: target })
    } catch { /* missing or unmovable: rendered again */ }
  }
  return { fingerprint: group.fingerprint, segments }
}

/**
 * Move a checkpoint's saved scene clips into a fresh work dir and drop the old
 * one. A resumed render never writes into the previous attempt's folder, where
 * an encoder orphaned by a crash may still be writing. Clips that cannot be
 * moved are simply re-rendered (the reuse check validates every clip anyway).
 */
export async function moveCheckpointSceneClips(
  checkpoint: VideoAssemblyCheckpoint,
  workDir: string,
): Promise<VideoAssemblyCompletedSceneClip[]> {
  const moved: VideoAssemblyCompletedSceneClip[] = []
  if (path.resolve(checkpoint.work_dir) === path.resolve(workDir)) return checkpoint.completed_scene_clips
  for (const clip of checkpoint.completed_scene_clips) {
    const target = path.join(workDir, path.basename(clip.clip_path))
    try {
      await fs.rename(clip.clip_path, target)
      moved.push({ ...clip, clip_path: target })
    } catch { /* missing or unmovable: re-rendered */ }
  }
  // Scratch only (validated as this job's own canonical temp dir by the caller).
  await fs.rm(checkpoint.work_dir, { recursive: true, force: true }).catch(() => {})
  return moved
}

export function setVideoAssemblyCheckpoint(job: Job, checkpoint: VideoAssemblyCheckpoint | null): void {
  const result = { ...(job.result || {}) }
  if (checkpoint) result[CHECKPOINT_KEY] = checkpoint
  else delete result[CHECKPOINT_KEY]
  job.result = Object.keys(result).length ? result : undefined
}

export async function validateVideoAssemblySceneClip(
  clip: VideoAssemblyCompletedSceneClip,
): Promise<boolean> {
  try {
    const stat = await fs.lstat(clip.clip_path)
    if (!stat.isFile() || stat.isSymbolicLink()) return false
    const tolerance = 0.15
    const { assertValidMedia } = await import('./ffmpeg-validation.js')
    const info = await assertValidMedia(clip.clip_path, {
      label: `Video Assembly scene ${clip.scene_index + 1} recovery clip`,
      requireVideo: true,
      minDurationSec: Math.max(0.1, clip.render_duration_sec - tolerance),
    })
    return Math.abs(info.durationSec - clip.render_duration_sec) <= tolerance
  } catch {
    return false
  }
}

export async function findReusableVideoAssemblySceneClips(
  checkpoint: VideoAssemblyCheckpoint,
  renderFingerprint: string,
  expected: VideoAssemblyCompletedSceneClip[],
): Promise<Map<number, string>> {
  const reusable = new Map<number, string>()
  if (checkpoint.render_fingerprint !== renderFingerprint) return reusable
  const saved = new Map(checkpoint.completed_scene_clips.map(clip => [clip.scene_index, clip]))
  for (const item of expected) {
    const clip = saved.get(item.scene_index)
    if (!clip
      || clip.clip_path !== item.clip_path
      || Math.abs(clip.render_duration_sec - item.render_duration_sec) > 0.001) continue
    if (await validateVideoAssemblySceneClip(clip)) reusable.set(item.scene_index, clip.clip_path)
  }
  return reusable
}
