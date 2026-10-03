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

export interface VideoAssemblyCheckpoint {
  version: 1
  job_id: string
  project_slug: string
  episode_id: string
  work_dir: string
  render_fingerprint: string
  completed_scene_clips: VideoAssemblyCompletedSceneClip[]
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
  return true
}

async function isCanonicalOwnedWorkDir(checkpoint: VideoAssemblyCheckpoint): Promise<boolean> {
  const runName = path.basename(checkpoint.work_dir)
  if (!RUN_DIR_RE.test(runName)) return false
  const root = getWorkTempRoot()
  const rootRelative = path.relative(root, checkpoint.work_dir)
  if (!rootRelative || path.isAbsolute(rootRelative) || rootRelative.startsWith(`..${path.sep}`)) return false
  const expectedParent = path.join(
    root,
    sanitizeWorkTempSegment(checkpoint.project_slug),
    sanitizeWorkTempSegment(checkpoint.episode_id),
  )
  if (path.dirname(checkpoint.work_dir) !== expectedParent) return false

  try {
    const [rootReal, parentReal, workReal, workStat] = await Promise.all([
      fs.realpath(root),
      fs.realpath(expectedParent),
      fs.realpath(checkpoint.work_dir),
      fs.lstat(checkpoint.work_dir),
    ])
    if (!workStat.isDirectory() || workStat.isSymbolicLink()) return false
    return parentReal === path.join(
      rootReal,
      sanitizeWorkTempSegment(checkpoint.project_slug),
      sanitizeWorkTempSegment(checkpoint.episode_id),
    ) && workReal === path.join(parentReal, runName)
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
): VideoAssemblyCheckpoint {
  return {
    version: 1,
    job_id: job.job_id,
    project_slug: job.project_slug,
    episode_id: job.episode_id,
    work_dir: workDir,
    render_fingerprint: renderFingerprint,
    completed_scene_clips: completedSceneClips,
  }
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
