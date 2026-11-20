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
  'continuity_render', 'contextual_cues',
  // 1.4.415 — the two image producers, on the same disk rule `images_repair` already uses. (There is
  // no `images` job type; these are the ones that make scene and pool pictures.)
  'scene_image_generate', 'image_pool_generate',
  // An upload's output is on YouTube, not on disk, so it settles by its own rule below.
  'youtube_upload',
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

/**
 * Continuity Render: every scene the failed render covered now has a usable,
 * prompt-matching picture on disk, by the one scene-image audit the generator
 * and the Production Board already use (`auditSceneImageCompletion`).
 *
 * The audit is the same proof in both directions: a scene with no file is
 * `missing`, a corrupt or empty file is `invalid`, and a file rendered from an
 * OUTDATED prompt is `invalid` too. A partial render therefore leaves the row
 * needing attention, and a later plan edit does not let an old picture settle
 * a row.
 *
 * A forced re-render wanted NEW pictures for the same prompt, and the disk
 * cannot tell a new file from the old one it replaced — so that row is left
 * unsettled on purpose (the same rule the thumbnail pools below follow).
 */
async function continuityRenderComplete(job: Job): Promise<boolean> {
  if (!job.episode_id) return false
  if (job.params?.force === true) return false
  const episodeId = String(job.params?.episode_id || job.episode_id)
  const { resolveEpisodePathsByCode, resolveScenePlanPath } = await import('./utils.js')
  const { resolveContinuityRenderOutputDir } = await import('../generators/continuity-render.js')
  const { auditSceneImageCompletion } = await import('./scene-media-checkpoint.js')
  const paths = await resolveEpisodePathsByCode(job.project_slug, episodeId)
  const planPath = await resolveScenePlanPath(job.project_slug, episodeId, paths.episode_dir)
  const plan = JSON.parse(await (await import('fs/promises')).readFile(planPath, 'utf-8')) as {
    scenes?: Array<{ id: string }>
  }
  const planIds = (plan.scenes || []).map(scene => scene.id)
  const requested = Array.isArray(job.params?.scene_ids) && job.params.scene_ids.length
    ? job.params.scene_ids.map(String)
    : job.params?.single_scene_id
      ? [String(job.params.single_scene_id)]
      : null
  const ids = requested ?? planIds
  if (!ids.length) return false
  const outputDir = await resolveContinuityRenderOutputDir(job.project_slug, episodeId, paths.episode_dir)
  const audit = await auditSceneImageCompletion(
    planPath,
    ids,
    job.output_dir && job.output_dir !== outputDir ? [outputDir, job.output_dir] : [outputDir],
  )
  return audit.expected > 0 && audit.completed === audit.expected && !audit.issues.length
}

/**
 * Contextual Cues: the labels timeline for THIS scene plan exists, by the same
 * audit the cancellation auditor and the Pipeline's own readiness check use
 * (`inspectContextualCueCompletion`).
 *
 * A partial run writes its progress to a different file and never the
 * timeline, so a half-proposed run leaves the row needing attention. A timeline
 * built from an EARLIER scene plan is not this plan's labels, and the audit
 * says so.
 *
 * A timeline is also only proof for a run that asked for NEW labels when the
 * timeline was written AFTER that ask: an older run's labels are not what
 * this row was for. The same rule the Still Posts redraw below follows.
 *
 * The same job also proposes the SOUND half when the channel has Sound
 * switched on, so a run that wrote its labels and then failed on the sounds
 * has only half its work done — the sound timeline is part of the proof.
 */
async function contextualCuesComplete(job: Job): Promise<boolean> {
  if (!job.episode_id) return false
  const episodeId = String(job.params?.episode_id || job.episode_id)
  const { resolveEpisodePathsByCode, resolveScenePlanPath } = await import('./utils.js')
  const { inspectContextualCueCompletion } = await import('./text-completion.js')
  const { readContextualCueTimeline } = await import('./contextual-cues.js')
  const { readSoundDesignTimeline, normalizeSoundDesignConfig } = await import('./sound-design.js')
  const { getConfig } = await import('./project-manager.js')
  const paths = await resolveEpisodePathsByCode(job.project_slug, episodeId)
  const planPath = await resolveScenePlanPath(job.project_slug, episodeId, paths.episode_dir)
  const audit = await inspectContextualCueCompletion(planPath)
  if (!audit.authoritative || !audit.complete) return false
  const timeline = await readContextualCueTimeline(planPath)
  if (!timeline) return false
  const requestedAt = Date.parse(job.started_at || job.created_at || '')
  if (!Number.isFinite(requestedAt)) return false
  const writtenAt = Date.parse(timeline.generated_at || '')
  if (!Number.isFinite(writtenAt) || writtenAt < requestedAt) return false
  const config = normalizeSoundDesignConfig((await getConfig(job.project_slug))?.sound_design)
  if (!config.enabled) return true
  const sounds = await readSoundDesignTimeline(planPath)
  if (!sounds) return false
  const soundsAt = Date.parse(sounds.generated_at || '')
  return Number.isFinite(soundsAt) && soundsAt >= requestedAt
}

/**
 * A later SUCCESSFUL upload of the same episode to the same channel supersedes a failed one.
 *
 * The disk rule cannot answer this: an upload's output is a video on YouTube. Matching on the
 * episode alone would let a successful re-upload to a DIFFERENT channel settle a failure on the
 * one that is still missing; matching on "a later attempt" would settle a row for a retry that
 * also failed. So: same episode, same expected channel, status `done`, finished strictly after
 * this row. Returns the winner so the row can name it.
 */
async function youtubeUploadSupersededBy(job: Job): Promise<Job | null> {
  if (!job.episode_id) return null
  const channel = String(job.params?.expected_channel_id || '').trim()
  if (!channel) return null
  const failedAt = Date.parse(job.finished_at || job.created_at || '')
  if (!Number.isFinite(failedAt)) return null
  const later = await jq.findJobs(job.project_slug, other => other.type === 'youtube_upload'
    && other.status === 'done'
    && other.episode_id === job.episode_id
    && String(other.params?.expected_channel_id || '').trim() === channel
    && Date.parse(other.finished_at || '') > failedAt)
  return later[0] ?? null
}

/**
 * What to write on a settled row. Most rows say the same sentence; an upload names the later upload
 * that superseded it, because "no longer needs attention" alone leaves a person wondering whether
 * the video is on YouTube.
 */
export async function settledReasonFor(job: Job): Promise<string> {
  if (job.type !== 'youtube_upload') return RESOLVED_REASON
  const winner = await youtubeUploadSupersededBy(job)
  if (!winner) return RESOLVED_REASON
  const at = winner.finished_at ? new Date(winner.finished_at).toLocaleString('en-GB') : 'a later run'
  return `This upload failed, and a later upload of the same episode to the same channel succeeded `
    + `(${at}, job ${winner.job_id}), so it no longer needs attention.`
}

/** Does every file this failed job was meant to make exist on disk now? */
export async function outputsComplete(job: Job): Promise<boolean> {
  // Types that settle on artifacts rather than one episode's folder first: a
  // Still Posts draw has no episode at all, so the guard below would hide it.
  if (job.type === 'still_post_render') return await stillPostRenderComplete(job)
  if (job.type === 'scene_clips_batch') return await sceneClipBatchComplete(job)
  if (job.type === 'scene_plan_run') return await scenePlanRunComplete(job)
  if (!job.episode_id) return false
  if (job.type === 'continuity_render') return await continuityRenderComplete(job)
  if (job.type === 'contextual_cues') return await contextualCuesComplete(job)
  if (job.type === 'youtube_upload') return (await youtubeUploadSupersededBy(job)) !== null
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
    const reason = await settledReasonFor(job).catch(() => RESOLVED_REASON)
    if (await jq.noteOnFinishedJob(projectSlug, job.job_id, [`✓ ${reason}`], reason)) settled.push(job.job_id)
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
