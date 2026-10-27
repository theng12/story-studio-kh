import { effectiveGenStudioTaskState, holdsUnknownProviderOutcome } from '@shared/provider-task-state'
import { jobDisplayStatus } from './episode-recovery.js'

export interface JobControlLike {
  action: string
  enabled: boolean
}

/**
 * The ONE user-facing job-type label map (F-11).
 *
 * Four hand-maintained copies had drifted from the live `JobType` union in
 * `electron/server/models/types.ts`, so several current types rendered as raw
 * slugs in the Jobs rows, the completion toasts and the episode dropdown. This
 * is the single authority all four now read. Legacy ids are kept so historical
 * rows stay interpretable; `jobTypeLabel` still humanizes an unknown/future id
 * rather than rendering a slug.
 */
export const JOB_TYPE_LABELS: Record<string, string> = {
  idea_campaign: 'Idea Campaign',
  'introduction-only': 'Introduction',
  'chapter-only': 'Chapter regen',
  outline_only: 'Script outline',
  expand_chapters: 'Chapter expansion',
  image_prompts: 'Prompts',
  thumb_images: 'Thumbnail Images',
  images_repair: 'Image Repair',
  audio: 'Audio',
  audio_merge: 'Audio Assembly',
  metadata: 'YouTube Finalizer',
  video_assembly: 'Video Assembly',
  subtitles_transcribe: 'Subtitles',
  youtube_upload: 'YouTube upload',
  youtube_playlist_update: 'YouTube playlist',
  youtube_thumbnail_refresh: 'YouTube thumbnail',
  social_publish: 'Social posting',
  broll_select: 'B-roll selection',
  broll_normalize: 'B-roll normalize',
  broll_assemble: 'B-roll assembly',
  research_run: 'Research',
  scene_plan_run: 'Scene Plan',
  scene_image_generate: 'Scene image',
  scene_clip_generate: 'Motion clip',
  scene_clips_batch: 'Motion Review clips',
  continuity_render: 'Scene Review images',
  composition_generate: 'Image composition',
  contextual_cues: 'Sound & Labels',
  image_pool_generate: 'Image pool',
  music_generate: 'Music generation',
  music_video: 'Music video',
  music_episode_build: 'Music episode',
  music_scene_polish: 'Scene prompt polish',
  translate_episode: 'Translate episode',
  still_post_write: 'Still Posts writing',
  still_post_render: 'Still Posts drawing',
  // Retired ids retained so old history rows stay readable.
  'script-only': 'Script (chapters)',
  // The legacy AI Video Generator's lane. Its executor, auditor and reader are gone; stored
  // job rows from before that still name it, so the label keeps their history readable.
  video: 'AI Video (retired)',
  expression_markup: 'Expression markup',
  images: 'Images (All)',
  scene_images: 'Scene Images',
  scene_images_batch: 'Scene Review Batch',
  broll_autotag: 'B-roll tags',
  thumb_prompts: 'Thumb Prompts',
}

/** A human label for any job type; an unknown id is humanized, never a raw slug. */
export function jobTypeLabel(type: string): string {
  return JOB_TYPE_LABELS[type] || type.replace(/[_-]/g, ' ').replace(/\b\w/g, character => character.toUpperCase())
}

/**
 * The Gateway's operation vocabulary, in the customer's words.
 *
 * The operation is what the job actually IS — a text generation, an image, a
 * voice, a video, a song, a transcription — so the details of a job read in
 * terms of the work rather than in terms of the endpoint. Only the six
 * operations the contract publishes appear; anything else is shown as it
 * stands rather than guessed at.
 */
export const PROVIDER_OPERATION_LABELS: Record<string, string> = {
  'chat.response': 'Text',
  'image.generation': 'Image',
  'voice.tts': 'Voice',
  'video.generation': 'Video',
  'music.generation': 'Music',
  'audio.transcription': 'Transcription',
}

/**
 * The label for one Gateway operation, or '' when there is none.
 *
 * A job that never called a provider (a local render, a local assembly) has no
 * operation, and says nothing about one — it is provider-free, not mislabelled.
 */
export function jobOperationLabel(operation: unknown): string {
  if (typeof operation !== 'string' || !operation) return ''
  return PROVIDER_OPERATION_LABELS[operation] || operation.replace(/[._]/g, ' ')
}

/**
 * The ONE bucketing of a Gateway request's state.
 *
 * Two copies of this rule drifted once already: the Gateway item list grew a
 * `held` bucket — a request the Gateway still holds as an unknown outcome,
 * which is neither finished nor a failure to retry — and the settlement
 * sentence's own copy did not, so one card described the same request in two
 * vocabularies. It lives here now, and both read it.
 *
 * It says what a request IS. It says nothing about credits: whether a
 * reservation counts as held is the settlement rule's business
 * (`summariseSettlement`), and the two must not be quietly merged.
 */
export type JobStateBucket = 'settled' | 'active' | 'queued' | 'not_created' | 'cancelled' | 'held' | 'failed'

export function jobStateBucket(remote: {
  state?: unknown
  queue_state?: unknown
  cancelled?: boolean | null
  failure_code?: string | null
  recovery_required?: boolean | null
  recovery_state?: string | null
}): JobStateBucket {
  const state = effectiveGenStudioTaskState(remote)
  if (state === 'not_created') return 'not_created'
  if (remote.cancelled === true || state === 'cancelled' || /_CANCELLED_BY_CUSTOMER$/.test(remote.failure_code || '')) return 'cancelled'
  // A failed request the Gateway still holds as an unknown outcome is neither
  // finished nor failed — it is held, and it is never counted as settled.
  if (holdsUnknownProviderOutcome(remote)) return 'held'
  if (state === 'failed') return 'failed'
  if (/success|succeed|complete|done|settled/.test(state)) return 'settled'
  if (/queue|pending|wait|accept/.test(state)) return 'queued'
  return 'active'
}

/** The label a specific job shows, including the prompt-mode distinction. */
export function jobDisplayLabel(job: { type: string; params?: { mode?: unknown } | null }): string {
  const mode = job.params?.mode
  if (job.type === 'image_prompts' && mode === 'thumbnails') return 'Thumbnail Prompts'
  if (job.type === 'image_prompts' && mode === 'scenes') return 'Scene Prompts'
  return jobTypeLabel(job.type)
}

/**
 * Job types that no longer have an executor; old rows still list but cannot be retried.
 * `video` is the retired AI Video Generator's lane (deleted 2026-10-27), whose stored rows
 * are history. Keep this in step with `routes/jobs.ts`.
 */
const REMOVED_JOB_TYPES = new Set(['script-only', 'expression_markup', 'video'])

/**
 * The frontend half of the backend's `retryAdmissionError` legacy rules
 * (Q-06). A removed job type and the two retired prompt shapes are always
 * refused with a 409, so offering Retry — per row or through Retry all — is a
 * dead end the user only discovers after clicking. Keep this in step with
 * `routes/jobs.ts`.
 */
export function retryAdmissionAllowed(job: { type: string; params?: { mode?: unknown } | null }): boolean {
  const mode = job.params?.mode
  if (REMOVED_JOB_TYPES.has(job.type)) return false
  // Truthiness, not `=== undefined`: the backend's guard is
  // `job.params?.mode && job.params.mode !== 'thumbnails'`, so any falsy mode
  // (absent, null, empty string) is admitted.
  if (job.type === 'image_prompts') return !mode || mode === 'thumbnails'
  if (job.type === 'images') return !mode || mode === 'thumbs'
  return true
}

export interface JobsEmptyStateInput {
  hiddenInScope: number
  showHidden: boolean
  scopedJobs: number
  typeFilter: string
  typeLabel: string
  statusFilter: string
  batchFilter: string | null
  universal: boolean
}

/**
 * Q-08 — a status or batch filter that empties a nonempty list must say "no
 * matches", not "no jobs yet". The page cannot know the difference from the
 * filtered array alone, so the decision lives here where it can be tested.
 */
export function jobsEmptyState(input: JobsEmptyStateInput): { title: string; message: string } {
  if (input.hiddenInScope > 0 && !input.showHidden) {
    return {
      title: 'No visible jobs',
      message: 'Show hidden jobs to restore them. Work and settlement checks continue in the background.',
    }
  }
  const filterActive = input.typeFilter !== 'all' || input.statusFilter !== 'all' || input.batchFilter !== null
  if (filterActive && input.scopedJobs > 0) {
    return {
      title: 'No matching jobs',
      message: `This view has ${input.scopedJobs} job${input.scopedJobs === 1 ? '' : 's'}, but none match the current filter. Clear the filter to see them.`,
    }
  }
  return {
    title: input.typeFilter === 'all' ? 'No jobs yet' : `No ${input.typeLabel} jobs`,
    message: input.typeFilter === 'all'
      ? (input.universal
          ? 'Jobs from every project appear here automatically as soon as they are queued.'
          : 'Start generating scripts, images, or audio to see this project’s background jobs here.')
      : 'Try switching to the All tab to see other jobs.',
  }
}

export interface JobFilterLike {
  type?: string
  status?: string
  project_slug?: string
  params?: {
    pipeline_batch_id?: unknown
    force?: unknown
    generation_action?: { kind?: unknown }
    episode_recovery_id?: unknown
    episode_recovery?: { id?: unknown; completed?: readonly unknown[]; first_unresolved?: unknown }
  }
}

export interface CapacitySnapshotLike {
  capacity_verified?: boolean
  limitSource?: string
  refreshed_at?: string | null
}

export interface JobRequestIdentityLike {
  job_id: string
  genstudio_jobs?: readonly { id: string }[] | null
  /** Streamed jobs: the unsettled entries only (the full list is on the per-job GET). */
  genstudio_jobs_active?: readonly { id: string }[] | null
  remote_cancellations?: Readonly<Record<string, { provider_job_id: string }>> | null
}

const LIVE_CAPACITY_MAX_AGE_MS = 30_000

export function primaryControl<T extends JobControlLike>(controls: readonly T[]): T | null {
  return controls.find(control => control.action !== 'force-abandon') || controls[0] || null
}

export function secondaryControls<T extends JobControlLike>(controls: readonly T[]): T[] {
  const primary = primaryControl(controls)
  return controls.filter(control => control !== primary)
}

export function filterJobsForView<T extends JobFilterLike>(
  jobs: readonly T[],
  filters: { type: string; status: string; project: string; batch: string | null },
): T[] {
  return jobs.filter(job => {
    if (filters.project !== 'all' && job.project_slug !== filters.project) return false
    if (filters.type !== 'all' && job.type !== filters.type) return false
    if (filters.status !== 'all' && jobDisplayStatus(job) !== filters.status) return false
    if (filters.batch && job.params?.pipeline_batch_id !== filters.batch) return false
    return true
  })
}

export function isVerifiedLiveCapacity(snapshot: CapacitySnapshotLike | null | undefined, nowMs: number): boolean {
  if (snapshot?.capacity_verified !== true || snapshot.limitSource !== 'account-overview' || !snapshot.refreshed_at) return false
  const refreshedAt = Date.parse(snapshot.refreshed_at)
  if (!Number.isFinite(refreshedAt)) return false
  const age = nowMs - refreshedAt
  return age >= -5_000 && age <= LIVE_CAPACITY_MAX_AGE_MS
}

export function jobRequestIds(job: JobRequestIdentityLike): string[] {
  return [
    job.job_id,
    ...(job.genstudio_jobs || job.genstudio_jobs_active || []).map(remote => remote.id),
    ...Object.values(job.remote_cancellations || {}).map(record => record.provider_job_id),
  ].filter(Boolean)
}

/**
 * Log lines worth showing. Older runs logged "Gateway task: Chapter 11 -> <id>" (and a matching
 * "Gateway request:" line) for every item; with the id hidden that read "Chapter 11 -> [request
 * hidden]", which tells the owner nothing. New runs log "Chapter 11 sent to the Gateway." once.
 */
export function visibleJobOutputLines(lines: readonly unknown[] | null | undefined): string[] {
  return (lines || []).map(line => String(line ?? ''))
    .filter(line => !/^\s*Gateway (?:task|request): .+ -> \S+\s*$/.test(line))
}

/** Remove request identities only from presentation; the source job evidence is untouched. */
export function customerSafeJobText(value: unknown, exactIds: readonly string[] = []): string {
  // "0 credits released" is not news; a real release (N > 0) is kept word for word.
  let text = String(value || '').replace(/\s*GenStudio reports 0 credits released\./g, '')
  for (const id of [...new Set(exactIds.filter(id => id.length >= 6))].sort((a, b) => b.length - a.length)) {
    text = text.split(id).join('[request hidden]')
  }
  return text
    .replace(/\b((?:provider[ _-]?)?(?:job|task|request)[ _-]?id)\s*[:=#]\s*[A-Za-z0-9._:-]{6,}/gi, '$1: hidden')
    .replace(/\b((?:story\s+)?(?:job|task|request))\s+(?=[A-Za-z0-9._:-]{6,}\b)(?=[A-Za-z0-9._:-]*\d)(?=[A-Za-z0-9._:-]*[_.:-])[A-Za-z0-9._:-]+\b/gi, '$1 [request hidden]')
}

/**
 * A navigation-only shortcut to the page that made this job; opening a workspace never retries
 * provider work. Every status gets it (owner, 2026-10-24: "add a go to the generator for each
 * different job so i don't have to hunt for it") — it used to appear only on failed jobs.
 */
export function jobWorkspaceLink(job: {
  type: string
  status: string
  project_slug?: string | null
  episode_id?: string | null
  params?: { mode?: unknown; pool?: unknown }
}): { to: string; label: string; ariaLabel: string } | null {
  if (!job.project_slug || job.project_slug === '_app_') return null
  const destinations: Record<string, [string, string]> = {
    idea_campaign: ['ideas', 'Ideas Generator'],
    'chapter-only': ['scripts', 'Script Generator'],
    outline_only: ['scripts', 'Script Generator'],
    expand_chapters: ['scripts', 'Script Generator'],
    translate_episode: ['scripts', 'Script Generator'],
    'introduction-only': ['introduction', 'Introduction'],
    research_run: ['research', 'Research'],
    image_prompts: job.params?.mode === 'scenes' ? ['scene-plan', 'Scene Plan'] : ['image-prompts', 'Thumbnail Prompts'],
    thumb_images: ['images', 'Thumbnail Generator'],
    images_repair: job.params?.pool === 'scenes' ? ['scene-review', 'Scene Review'] : ['images', 'Thumbnail Generator'],
    composition_generate: ['character-sheet', 'Character Sheet'],
    broll_select: ['broll', 'B-Roll'],
    audio: ['audio', 'Audio Generator'],
    audio_merge: ['audio-merge', 'Audio Assembly'],
    subtitles_transcribe: ['subtitles', 'Subtitles'],
    metadata: ['metadata', 'YouTube Finalizer'],
    scene_plan_run: ['scene-plan', 'Scene Plan'],
    contextual_cues: ['sound-and-labels', 'Sound & Labels'],
    scene_image_generate: ['scene-review', 'Scene Review'],
    continuity_render: ['scene-review', 'Scene Review'],
    scene_clip_generate: ['motion-review', 'Motion Review'],
    scene_clips_batch: ['motion-review', 'Motion Review'],
    video: ['motion-review', 'Motion Review'],
    video_assembly: ['video-assembly', 'Video Assembly'],
    youtube_upload: ['upload/publish', 'Upload Center'],
    youtube_playlist_update: ['upload/publish', 'Upload Center'],
    youtube_thumbnail_refresh: ['upload/publish', 'Upload Center'],
    social_publish: ['upload/publish', 'Upload Center'],
    image_pool_generate: ['image-pool', 'Image Pool'],
    music_generate: ['music', 'Music'],
    music_video: ['music', 'Music'],
    music_episode_build: ['episode-builder', 'Episode Builder'],
    music_scene_polish: ['episode-builder', 'Episode Builder'],
    still_post_write: ['still-posts', 'Still Posts'],
    still_post_render: ['still-posts', 'Still Posts'],
  }
  if (!Object.hasOwn(destinations, job.type)) return null
  const destination = destinations[job.type]
  const [page, label] = destination
  // These tasks use a pool ID or a bulk-operation sentinel, not an episode code.
  const episodeId = job.type === 'idea_campaign' || job.type === 'image_pool_generate' || job.type === 'music_generate' || job.episode_id === '_thumbnail_refresh_' ? null : job.episode_id
  const episode = episodeId ? `?episode_id=${encodeURIComponent(episodeId)}` : ''
  return { to: `/projects/${encodeURIComponent(job.project_slug)}/${page}${episode}`, label: `Open ${label}`, ariaLabel: `Open ${label}${episodeId ? ` for ${episodeId}` : ''}` }
}
