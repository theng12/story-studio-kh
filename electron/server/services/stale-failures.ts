/**
 * Failed rows whose work was finished later stop needing attention.
 *
 * Dreamlands, 2026-10-03: three thumbnail jobs failed, their missing
 * thumbnails were made later by another run, and the old rows (plus the
 * repair rows next to them) kept saying "needs attention" — the dashboard
 * asked for "Repair 6 failed jobs" with every thumbnail on disk. A failed row
 * is now settled (`job.resolved`) once everything it was meant to make exists.
 * The row and its log stay; only the "needs attention" count changes. Jobs
 * page, toasts and dashboard read the same field, so they agree.
 */
import type { Job } from '../models/types.js'
import * as jq from './job-queue.js'

const RESOLVABLE_TYPES = new Set<Job['type']>(['audio', 'thumb_images', 'images_repair'])

export const RESOLVED_REASON = 'Everything this job was meant to make is now saved (finished by a later run or a repair), so it no longer needs attention.'

type ImagePool = 'scenes' | 'thumbnails' | 'all'

function imagePool(job: Job): ImagePool {
  const raw = job.type === 'thumb_images'
    ? ({ thumbs: 'thumbnails', scenes: 'scenes' } as Record<string, ImagePool>)[String(job.params?.mode)]
    : job.params?.pool
  return raw === 'scenes' || raw === 'thumbnails' ? raw : 'all'
}

/** Does every file this failed job was meant to make exist on disk now? */
export async function outputsComplete(job: Job): Promise<boolean> {
  // A forced remake wanted NEW files; old ones on disk prove nothing.
  if (job.params?.force === true || !job.episode_id) return false
  if (job.type === 'audio') {
    const { getAudioStatus } = await import('./audio-reconciler.js')
    const status = await getAudioStatus(job.project_slug, job.episode_id)
    return status.expected.length > 0 && status.missing.length === 0
  }
  const { getImagesReconcileStatus } = await import('./image-reconciler.js')
  const status = await getImagesReconcileStatus(job.project_slug, job.episode_id)
  const pool = imagePool(job)
  const sets = pool === 'thumbnails' ? [status.thumb] : pool === 'scenes' ? [status.scene] : [status.thumb, status.scene]
  return sets.some(set => set.expected > 0) && sets.every(set => set.missing === 0)
}

/**
 * Settle every failed row (optionally one episode's) whose outputs now all
 * exist. Returns the settled job ids. Never starts work, never deletes.
 */
export async function settleCompletedFailures(
  projectSlug: string,
  episodeId?: string,
  isComplete: (job: Job) => Promise<boolean> = outputsComplete,
): Promise<string[]> {
  const candidates = (await jq.getJobs(projectSlug)).filter(job => job.status === 'error'
    && !job.resolved && RESOLVABLE_TYPES.has(job.type)
    && (!episodeId || job.episode_id === episodeId))
  const settled: string[] = []
  for (const job of candidates) {
    // One unreadable episode must not stop the others from settling.
    if (!await isComplete(job).catch(() => false)) continue
    if (await jq.noteOnFinishedJob(projectSlug, job.job_id, [`✓ ${RESOLVED_REASON}`], RESOLVED_REASON)) settled.push(job.job_id)
  }
  return settled
}

/** Queue listener: a run that finished may have made an older failed row's files. */
export function settleAfterSuccess(job: Pick<Job, 'status' | 'type' | 'project_slug' | 'episode_id'>): void {
  if (job.status !== 'done' || !RESOLVABLE_TYPES.has(job.type) || !job.episode_id) return
  void settleCompletedFailures(job.project_slug, job.episode_id).catch(() => {})
}
