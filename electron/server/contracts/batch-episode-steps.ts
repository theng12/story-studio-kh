/**
 * Pipeline-batch step rollup — shared by the Telegram notifier and the Jobs
 * page's Timing disclosure.
 *
 * WHY THIS FILE EXISTS. The notifier already builds each episode's ordered
 * steps (`summarizeBatchEpisodes` → `BatchEpisodeOutcome.steps`); the Jobs
 * page needs the same facts per job row. The grouping, ordering, labels and
 * elapsed arithmetic must exist once and be used by both sides, or the ping
 * on the owner's phone and the row on the page drift apart. Zero-dependency:
 * imported by the Electron main process (via `services/job-notifier.ts`) and
 * by the frontend runtime.
 */

/** Minimal job shape both sides carry. A wire `Job` satisfies it structurally. */
export interface BatchStepJob {
  type: string
  status: string
  episode_id?: string | null
  created_at: string
  finished_at?: string | null
  error?: string | null
  params?: Record<string, unknown> | null
}

/** One step of an episode's Pipeline checklist. */
export interface BatchEpisodeStep {
  /** The Pipeline step id (`params.pipeline_step`) when the job carries one,
   *  else the job type. */
  type: string
  /** The app's display name for that step. */
  label: string
  /** `absent` is a step the run planned but never got a job (a held chain link). */
  status: 'done' | 'failed' | 'cancelled' | 'paused' | 'queued' | 'running' | 'absent'
  /** `created_at` → `finished_at`; 0 when the step never ran or is still active. */
  elapsed_ms: number
  /** The step's error, when it failed. Scrubbed by the caller that owns redaction. */
  reason?: string
}

/** One episode's ordered steps plus its own wall-clock total. */
export interface BatchEpisodeStepSummary {
  steps: BatchEpisodeStep[]
  /** Earliest queue time → last finish, for the episode's total; 0 while any
   *  step is still active. */
  elapsed_ms: number
}

/** One episode's outcome inside a finished Pipeline batch. */
export interface BatchEpisodeOutcome {
  episode_id: string
  title: string
  state: 'done' | 'failed' | 'cancelled' | 'running'
  steps_done: number
  steps_total: number
  steps: BatchEpisodeStep[]
  /** 0 while a step is still active. */
  elapsed_ms: number
  failed_step?: string
  failed_error?: string
}

/** Friendly names for the job types a step line names (kept in step with the
 *  frontend's own label table). */
export const JOB_TYPE_LABELS: Record<string, string> = {
  research_run: 'Research', outline_only: 'Outline', expand_chapters: 'Chapter expansion',
  'introduction-only': 'Introduction', image_prompts: 'Image prompts', thumb_images: 'Thumbnails',
  audio: 'Audio', audio_merge: 'Audio merge', subtitles_transcribe: 'Subtitles',
  metadata: 'Metadata', scene_plan_run: 'Scene plan', contextual_cues: 'Contextual cues',
  continuity_render: 'Scene render', scene_images_batch: 'Scene images',
  scene_clips_batch: 'Motion clips', character_sheet: 'Character sheet',
  video_assembly: 'Video assembly', music_episode_build: 'Music episode',
  broll_assemble: 'B-roll assembly', translate_episode: 'Translation',
  // The legacy AI Video Generator's lane (deleted 2026-10-27). Its stored rows are history.
  video: 'Video clips',
  youtube_upload: 'YouTube upload', youtube_playlist_update: 'YouTube playlist',
  social_publish: 'Social posting',
  youtube_thumbnail_refresh: 'Thumbnail backfill',
}
export function labelForJobType(type: string): string {
  return JOB_TYPE_LABELS[type] || type
}

/** The Pipeline's step order (mirrors VALID_STEPS in routes/pipeline.ts). A
 *  batch's jobs are chained STEPS, so the summary reads in the order they ran. */
export const PIPELINE_STEP_ORDER: readonly string[] = [
  'research', 'script-only', 'introduction-only', 'image_prompts', 'thumb_images',
  'audio', 'audio_merge', 'metadata', 'subtitles', 'scene_plan', 'contextual_cues',
  'scene_review', 'motion_review', 'character_sheet', 'video_assembly', 'music_build',
]

/** Job types whose step name differs, so the script step's outline → chapters
 *  pair (and old rows with no `pipeline_step`) still read as one step. */
export const JOB_TYPE_STEP: Record<string, string> = {
  outline_only: 'script-only', expand_chapters: 'script-only',
  research_run: 'research', subtitles_transcribe: 'subtitles',
  scene_plan_run: 'scene_plan', continuity_render: 'scene_review',
  scene_clips_batch: 'motion_review', music_episode_build: 'music_build',
}

export const PIPELINE_STEP_LABELS: Record<string, string> = {
  research: 'Research', 'script-only': 'Script', 'introduction-only': 'Introduction',
  image_prompts: 'Image prompts', thumb_images: 'Thumbnails', audio: 'Audio',
  audio_merge: 'Audio merge', metadata: 'Metadata', subtitles: 'Subtitles',
  scene_plan: 'Scene plan', contextual_cues: 'Contextual cues',
  scene_review: 'Scene review', motion_review: 'Motion clips',
  character_sheet: 'Character sheet', video_assembly: 'Video assembly',
  music_build: 'Music episode',
}

export function jobStepKey(job: BatchStepJob): string {
  const stamped = job.params?.pipeline_step
  if (typeof stamped === 'string' && stamped) return stamped
  return JOB_TYPE_STEP[job.type] || job.type
}

export function stepLabel(key: string, jobType: string): string {
  return PIPELINE_STEP_LABELS[key] || labelForJobType(jobType)
}

/** `3m28s`, `1h24m`, `2m` — the Pipeline checklist's compact form. */
export function formatCompactDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  if (totalSec < 60) return `${totalSec}s`
  const totalMin = Math.floor(totalSec / 60)
  if (totalMin < 60) return totalSec % 60 === 0 ? `${totalMin}m` : `${totalMin}m${totalSec % 60}s`
  const h = Math.floor(totalMin / 60)
  return totalMin % 60 === 0 ? `${h}h` : `${h}h${totalMin % 60}m`
}

/** Turn one step's real jobs into its checklist entry (owner request 2026-11-14).
 *  `scrub` is passed by the server side (redactSecrets); the frontend renders
 *  job.error as it already shows it elsewhere, so it omits the scrub. */
export function summarizeStep(
  key: string,
  label: string,
  jobs: BatchStepJob[],
  scrub?: (text: string) => string,
): BatchEpisodeStep {
  let firstSeen = jobs[0]!.created_at
  let lastFinished = ''
  let failed: BatchStepJob | null = null
  let active = false
  let paused = false
  let cancelled = false
  for (const j of jobs) {
    if (j.created_at && j.created_at < firstSeen) firstSeen = j.created_at
    if (j.finished_at && j.finished_at > lastFinished) lastFinished = j.finished_at
    switch (j.status) {
      case 'error': if (!failed || j.created_at < failed.created_at) failed = j; break
      case 'cancelled': cancelled = true; break
      case 'paused': paused = true; break
      case 'queued':
      case 'running': active = true; break
    }
  }
  const status: BatchEpisodeStep['status'] = failed ? 'failed'
    : active ? 'running'
    : paused ? 'paused'
    : cancelled ? 'cancelled'
    : 'done'
  const elapsed_ms = (status === 'done' || status === 'failed' || status === 'cancelled') && lastFinished
    ? Math.max(0, Date.parse(lastFinished) - Date.parse(firstSeen))
    : 0
  const step: BatchEpisodeStep = {
    type: key,
    label,
    status,
    elapsed_ms: Number.isFinite(elapsed_ms) ? elapsed_ms : 0,
  }
  if (failed) {
    const raw = (failed.error || '').trim()
    const err = (scrub ? scrub(raw) : raw).replace(/\s+/g, ' ').trim()
    if (err) step.reason = err
  }
  return step
}

/** A chain link's step, from the chain stamped on a real job. */
export function chainLinkStep(link: unknown): { key: string; type: string } | null {
  if (!link || typeof link !== 'object') return null
  const l = link as { type?: unknown; params?: Record<string, unknown> }
  const type = typeof l.type === 'string' ? l.type : ''
  const stamped = l.params?.pipeline_step
  const key = typeof stamped === 'string' && stamped
    ? stamped
    : type ? (JOB_TYPE_STEP[type] || type) : ''
  return key ? { key, type: type || key } : null
}

/**
 * One episode's steps in Pipeline order, from its batch jobs' `pipeline_step`,
 * `created_at`, `finished_at` and `status`. A step the chain planned but never
 * got a job is shown as absent. This is the exact grouping the Telegram
 * summary reads out; the Jobs page's Timing disclosure calls the same builder.
 */
export function summarizeEpisodeSteps(
  group: readonly BatchStepJob[],
  scrub?: (text: string) => string,
): BatchEpisodeStepSummary {
  // The steps this episode actually has a job for, grouped by Pipeline step
  // (the script step's outline → chapters pair stays one step).
  const buckets = new Map<string, { label: string; jobs: BatchStepJob[]; first_seen: string }>()
  for (const j of group) {
    const key = jobStepKey(j)
    const bucket = buckets.get(key)
    if (bucket) bucket.jobs.push(j)
    else buckets.set(key, { label: stepLabel(key, j.type), jobs: [j], first_seen: j.created_at })
  }
  // Steps the run planned and never reached: the chain still carried on a
  // real job is the Gateway's own record that they were coming.
  const planned = new Map<string, { type: string; first_seen: string }>()
  for (const j of group) {
    const chain = Array.isArray(j.params?.pipeline_chain) ? j.params.pipeline_chain as unknown[] : []
    for (const link of chain) {
      const step = chainLinkStep(link)
      if (!step || buckets.has(step.key) || planned.has(step.key)) continue
      planned.set(step.key, { type: step.type, first_seen: j.created_at })
    }
  }
  const steps: Array<{ step: BatchEpisodeStep; first_seen: string }> = [
    ...[...buckets].map(([key, b]) => ({ step: summarizeStep(key, b.label, b.jobs, scrub), first_seen: b.first_seen })),
    ...[...planned].map(([key, p]) => ({
      step: { type: key, label: stepLabel(key, p.type), status: 'absent' as const, elapsed_ms: 0 },
      first_seen: p.first_seen,
    })),
  ]
  const order = (key: string) => {
    const index = PIPELINE_STEP_ORDER.indexOf(key)
    return index === -1 ? PIPELINE_STEP_ORDER.length : index
  }
  steps.sort((a, b) => order(a.step.type) - order(b.step.type) || a.first_seen.localeCompare(b.first_seen))

  let firstSeen = group[0]?.created_at ?? ''
  let lastFinished = ''
  let anyActive = false
  for (const j of group) {
    if (j.created_at && j.created_at < firstSeen) firstSeen = j.created_at
    if (j.finished_at && j.finished_at > lastFinished) lastFinished = j.finished_at
    if (j.status === 'running' || j.status === 'queued') anyActive = true
  }
  const elapsed_ms = !anyActive && lastFinished
    ? Math.max(0, Date.parse(lastFinished) - Date.parse(firstSeen))
    : 0
  return {
    steps: steps.map(s => s.step),
    elapsed_ms: Number.isFinite(elapsed_ms) ? elapsed_ms : 0,
  }
}
