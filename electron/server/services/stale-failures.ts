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
 *
 * Production, 2026-10-29: four `still_post_render` rows (little-weather-within
 * 6da4810d, 18663004, 0faf7acd, fcaeb3e5) whose artwork and finals every later
 * run had made stayed "needs attention" forever, and Scene Plan / motion batch
 * failures had the same shape — they simply had no settle path at all. Each new
 * type below settles only through the SAME completion proof its generator and
 * the Production Board use (§8); a type whose completeness cannot be proven
 * from disk is deliberately left unsettled.
 */
import type { Job } from '../models/types.js'
import type { StillPost } from '../contracts/still-posts.js'
import * as jq from './job-queue.js'

const RESOLVABLE_TYPES = new Set<Job['type']>([
  'audio', 'thumb_images', 'images_repair', 'audio_merge', 'video_assembly',
  'still_post_render', 'scene_clips_batch', 'scene_plan_run',
])

/** Assembly rebuilds one whole file; a later successful build of it is that output. */
const ASSEMBLY_TYPES = new Set<Job['type']>(['audio_merge', 'video_assembly'])

export const RESOLVED_REASON = 'Everything this job was meant to make is now saved (finished by a later run or a repair), so it no longer needs attention.'

type ImagePool = 'scenes' | 'thumbnails' | 'all'

function imagePool(job: Job): ImagePool {
  const raw = job.type === 'thumb_images'
    ? ({ thumbs: 'thumbnails', scenes: 'scenes' } as Record<string, ImagePool>)[String(job.params?.mode)]
    : job.params?.pool
  return raw === 'scenes' || raw === 'thumbnails' ? raw : 'all'
}

/**
 * When each artifact the post shows for its CURRENT art mode and aspects was
 * drawn or rendered, as the records on disk say. A per-size drawing or a final
 * for an aspect the post no longer has is not something it shows, so it is not
 * judged here (a stale 1:1 final must not block a post now framed 9:16 only).
 */
function postArtifactTimes(post: StillPost, perSize: boolean): number[] {
  const times: number[] = []
  for (const panel of post.panels) {
    if (!perSize) {
      if (panel.image?.rendered_at) times.push(Date.parse(panel.image.rendered_at))
      continue
    }
    for (const aspect of post.aspects) {
      const drawn = panel.images?.[aspect]
      if (drawn?.rendered_at) times.push(Date.parse(drawn.rendered_at))
    }
  }
  for (const final of post.finals) {
    if (post.aspects.includes(final.aspect)) times.push(Date.parse(final.rendered_at))
  }
  return times
}

/**
 * Still Posts: every post the failed draw covered now has its art and a final
 * in every requested frame — the generator's own finish line
 * (`listBatchStates` over the same `selectPosts` scope, generators/still-posts.ts).
 *
 * A `redraw` wanted NEW artwork, so old files being complete proves nothing
 * (`force` above, and the assembly rule below): it settles only when every
 * artifact the post now shows for its current frames was rendered since the
 * redraw was requested (the job's start, or its creation if it never started).
 * The row's own partial draw counts; a row whose post is still missing a piece
 * stays, because `listBatchStates` must be complete first.
 */
async function stillPostRenderComplete(job: Job): Promise<boolean> {
  const { listBatchStates, artModeOf } = await import('./still-posts.js')
  const { selectPosts } = await import('../generators/still-posts.js')
  // `selectPosts` refuses an unknown id; that is "cannot prove", not "complete".
  const posts = await selectPosts(job.project_slug, (job.params || {}) as Parameters<typeof selectPosts>[1])
  if (!posts.length) return false
  // The same scope the generator judged (AGENTS §8): a post_ids redraw is complete on its own posts.
  const states = await listBatchStates(job.project_slug, posts)
  if (!(states.length > 0 && states.every(state => state.complete))) return false
  if (job.params?.redraw !== true) return true
  // A redraw wanted artwork drawn for THIS request. The row's own run began after it was asked
  // for, so anything from that run (or later) counts, including a post whose later run finished
  // it after this row failed. Files from before the request prove nothing.
  const requestedAt = Date.parse(job.started_at || job.created_at || '')
  if (!Number.isFinite(requestedAt)) return false
  return posts.every(post => {
    const times = postArtifactTimes(post, artModeOf(post) === 'per-size')
    return times.length > 0 && times.every(time => Number.isFinite(time) && time >= requestedAt)
  })
}

/**
 * Scene Plan: the plan the failed run was for is complete by the existing
 * completeness rule (`auditScenePlanOutput` — the same auditor recovery uses).
 *
 * A run that failed on a PRECONDITION (Production, quiet-longing EP0001:
 * "Subtitle timeline is incomplete — complete transcription and stitch
 * subtitles again") never produced a plan, so there is no complete plan to find
 * and the row stays. A later plan that IS complete settles it, because that is
 * the work the row was for.
 */
async function scenePlanRunComplete(job: Job): Promise<boolean> {
  if (!job.episode_id) return false
  const { auditScenePlanOutput } = await import('../boot/executors.js')
  return await auditScenePlanOutput(job) === 'complete'
}

/**
 * Motion clips: every clip the failed batch covered is on disk, fresh and
 * selected, by the one freshness rule (`sceneClipBatchOutputsComplete`, which
 * is the batch's own `auditSceneClipCompletion` proof over the job's scope).
 */
async function sceneClipBatchComplete(job: Job): Promise<boolean> {
  if (!job.episode_id) return false
  const { sceneClipBatchOutputsComplete } = await import('../generators/scene-clip.js')
  return await sceneClipBatchOutputsComplete(job)
}

/** Does every file this failed job was meant to make exist on disk now? */
export async function outputsComplete(job: Job): Promise<boolean> {
  // Types that settle on artifacts rather than one episode's folder first: a
  // Still Posts draw has no episode at all, so the guard below would hide it.
  if (job.type === 'still_post_render') return await stillPostRenderComplete(job)
  if (job.type === 'scene_clips_batch') return await sceneClipBatchComplete(job)
  if (job.type === 'scene_plan_run') return await scenePlanRunComplete(job)
  if (!job.episode_id) return false
  if (ASSEMBLY_TYPES.has(job.type)) {
    // A file that was already on disk before the failure proves nothing, so
    // only a build of the same kind that FINISHED after it counts.
    const failedAt = Date.parse(job.finished_at || job.created_at || '')
    return (await jq.findJobs(job.project_slug, other => other.type === job.type
      && other.episode_id === job.episode_id && other.status === 'done'
      && Date.parse(other.finished_at || '') > failedAt)).length > 0
  }
  // A forced remake wanted NEW files; old ones on disk prove nothing.
  if (job.params?.force === true) return false
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
  const candidates = await jq.findJobs(projectSlug, job => job.status === 'error'
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
  if (job.status !== 'done' || !RESOLVABLE_TYPES.has(job.type)) return
  // A Still Posts draw covers a batch, not an episode: settle its channel.
  if (!job.episode_id && job.type !== 'still_post_render') return
  void settleCompletedFailures(job.project_slug, job.episode_id || undefined).catch(() => {})
}
