/**
 * What the job queue says about each episode's steps, keyed by the same
 * status fields the Production Board columns use (STEP_STATUS_FIELD).
 *
 * Files decide "done". This only adds what files cannot show: a step that is
 * being made right now, and a step whose latest attempt FAILED — which the
 * Board used to draw as the same grey ○ as "never started", so an overnight
 * run's failures were invisible everywhere except the Jobs page.
 */

const JOB_TYPE_STATUS_FIELD: Record<string, string> = {
  research_run: 'research',
  outline_only: 'script',
  expand_chapters: 'script',
  translate_episode: 'script',
  'introduction-only': 'introduction',
  thumb_images: 'thumbnails',
  audio: 'audio',
  audio_merge: 'merged_audio',
  subtitles_transcribe: 'subtitles',
  metadata: 'metadata',
  scene_plan_run: 'scene_plan',
  continuity_render: 'scene_review',
  scene_images_batch: 'scene_review',
  scene_clips_batch: 'motion_review',
  video_assembly: 'video_assembly',
  broll_assemble: 'video_assembly',
  // Music channels: the Episode Builder's draw + stitch is the "Episode Builder" column.
  music_episode_build: 'music_episode',
}

/** Every job type that can mark a Board step active or failed (`image_prompts` is mode-dependent). */
export const STEP_JOB_TYPES = [...Object.keys(JOB_TYPE_STATUS_FIELD), 'image_prompts'] as const

export interface StepJobLike {
  type: string
  status: string
  episode_id?: string | null
  created_at?: string | null
  error?: string | null
  params?: { mode?: unknown } | null
}

export interface StepJobState {
  state: 'active' | 'failed'
  error: string
}

export function statusFieldForJob(job: StepJobLike): string | null {
  // Scene prompts belong to Scene Plan, not to the Thumbnail Prompts column.
  if (job.type === 'image_prompts') return job.params?.mode === 'scenes' ? null : 'thumb_prompts'
  return JOB_TYPE_STATUS_FIELD[job.type] || null
}

/** `${episode}:${field}` → the latest job's state, when it is running or failed. */
export function episodeStepJobStates(jobs: readonly StepJobLike[]): Map<string, StepJobState> {
  const latest = new Map<string, StepJobLike>()
  for (const job of jobs) {
    const field = statusFieldForJob(job)
    if (!field || !job.episode_id) continue
    const key = `${job.episode_id}:${field}`
    const previous = latest.get(key)
    if (!previous || String(job.created_at || '') >= String(previous.created_at || '')) latest.set(key, job)
  }
  const states = new Map<string, StepJobState>()
  for (const [key, job] of latest) {
    if (job.status === 'queued' || job.status === 'running') states.set(key, { state: 'active', error: '' })
    else if (job.status === 'error') states.set(key, { state: 'failed', error: String(job.error || '').split('\n')[0] || '' })
  }
  return states
}

/**
 * Scene Review that is waiting on the owner, not on work: every scene counted has its image and
 * no approval yet. One wording for the Board and the notification (TN0329 sat on one scene unseen).
 */
export function awaitingApprovalLabel(count: unknown): string {
  const n = typeof count === 'number' && Number.isInteger(count) && count > 0 ? count : 0
  return n ? `Waiting for your approval (${n} scene${n === 1 ? '' : 's'})` : ''
}
