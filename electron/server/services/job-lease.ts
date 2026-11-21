/**
 * How long one worker may hold its lane.
 *
 * `runJob` awaited every executor with no bound at all, so a promise that never
 * settled kept its lane for ever: the row said `running`, later work waited
 * behind it, and nothing short of a restart could reclaim it (Production,
 * 2026-11-20: "The queue says a job is running and later work waits, and
 * nothing can reclaim it short of a restart").
 *
 * The bound is the work's own, never one global timer — a 4-hour writing job and
 * a one-minute YouTube probe cannot share a number. Each ceiling below is the
 * longest a *healthy* job of that class has been measured at, with generous
 * headroom: the cost of being generous is that a truly wedged row waits a little
 * longer, and the cost of being tight is killing real work.
 *
 * Past its ceiling the worker stops being waited for: the row ends retryable
 * with that sentence, the lane frees, and the job's own recorded child processes
 * are stopped. What the abandoned executor does later is logged beside the
 * verdict, never allowed to move the row.
 */

import { getAppSetting, onAppSettingWritten } from './app-settings.js'
import { logLine } from './logger.js'
import { JOB_TYPES, type JobType } from '../models/types.js'

/** The ceiling is a default that can be rearranged — 0 turns it off entirely. */
export const JOB_LEASE_SCALE_KEY = 'job_lease_ceiling_scale'
export const JOB_LEASE_SCALE_DEFAULT = 1
export const JOB_LEASE_SCALE_MIN = 0
export const JOB_LEASE_SCALE_MAX = 4

const HOUR = 3_600_000

/**
 * The longest a healthy job of each class is given. Every class is named for the
 * work it bounds, not for a timer:
 *  - `chat`    — the Hub's own stated chat ceiling (4 h, `output-token-budget.ts`).
 *  - `render`  — a scene-by-scene episode render: 212 scenes were measured at
 *                ~2 min each (~7 h), with the final render on top.
 *  - `local`   — one local FFmpeg pass over an episode: minutes, not hours.
 *  - `provider`— one accepted provider request and its poll, including fleet waits.
 *  - `upload`  — one YouTube/social action: a large file on a slow link is measured
 *                in hours, not minutes.
 *
 * Every number is deliberately generous. Waiting longer for a truly stuck row costs
 * time; ending a real job early costs paid work, so the ceiling is the line past
 * which no healthy job of that class has ever been seen, not the typical duration.
 */
export const JOB_LEASE_CLASS_HOURS = {
  chat: 4,
  render: 12,
  local: 3,
  provider: 3,
  upload: 4,
} as const

export type JobLeaseClass = keyof typeof JOB_LEASE_CLASS_HOURS

const TYPE_CLASS: Partial<Record<JobType, JobLeaseClass>> = {
  // Writing — every one of these is a chat request (or a sequence of them).
  idea_campaign: 'chat', 'introduction-only': 'chat', 'chapter-only': 'chat', outline_only: 'chat',
  expand_chapters: 'chat', image_prompts: 'chat', metadata: 'chat', research_run: 'chat',
  scene_plan_run: 'chat', composition_generate: 'chat', contextual_cues: 'chat',
  translate_episode: 'chat', still_post_write: 'chat', music_scene_polish: 'chat',
  story_entities_extract: 'chat', broll_select: 'chat', thumbnail_score: 'chat',
  // Episode rendering — many provider requests driven from one row.
  video_assembly: 'render', continuity_render: 'render', scene_clips_batch: 'render',
  episode_shorts: 'render', music_episode_build: 'render', music_video: 'render',
  timeline_assemble: 'render', timeline_video: 'render',
  // One accepted provider request.
  scene_image_generate: 'provider', scene_clip_generate: 'provider',
  image_pool_generate: 'provider', thumb_images: 'provider', images_repair: 'provider',
  still_post_render: 'provider', timeline_image: 'provider', timeline_sketch: 'provider',
  timeline_chart: 'provider', timeline_stock: 'provider', music_generate: 'provider',
  audio: 'provider', subtitles_transcribe: 'provider',
  // Local FFmpeg only — no provider, nothing charged.
  audio_merge: 'local', broll_normalize: 'local', broll_assemble: 'local',
  // One action against a live account API.
  youtube_upload: 'upload', youtube_playlist_update: 'upload',
  youtube_thumbnail_refresh: 'upload', social_publish: 'upload',
}

/** Types with no entry are bounded by the widest class: silence must not mean "unbounded". */
export const JOB_LEASE_DEFAULT_CLASS: JobLeaseClass = 'chat'

export function jobLeaseClass(type: JobType): JobLeaseClass {
  return TYPE_CLASS[type] ?? JOB_LEASE_DEFAULT_CLASS
}

let scale = JOB_LEASE_SCALE_DEFAULT
/** Test seam: shrink or switch off the ceilings without writing settings. */
let scaleOverride: number | null = null
const ceilingOverrides = new Map<JobType, number>()

function clampScale(raw: unknown): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n < JOB_LEASE_SCALE_MIN || n > JOB_LEASE_SCALE_MAX) {
    return JOB_LEASE_SCALE_DEFAULT
  }
  return n
}

/** The ceiling for one job type in ms, or null when the bound is switched off. */
export function executionCeilingMs(type: JobType): number | null {
  const override = ceilingOverrides.get(type)
  if (override !== undefined) return override
  const effective = scaleOverride ?? scale
  if (effective === 0) return null
  return Math.round(JOB_LEASE_CLASS_HOURS[jobLeaseClass(type)] * HOUR * effective)
}

export function describeCeiling(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1_000))} seconds`
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes} minutes`
  const hours = Math.round((ms / HOUR) * 10) / 10
  return `${hours} hour${hours === 1 ? '' : 's'}`
}

/** Test-only: pin a ceiling per type (or clear them), and the scale. */
export function _setJobLeaseForTesting(input: {
  ceilings?: Partial<Record<JobType, number>>
  scale?: number
  clear?: boolean
} | null): void {
  if (!input) {
    ceilingOverrides.clear()
    scaleOverride = null
    return
  }
  if (input.clear !== false) ceilingOverrides.clear()
  for (const [type, ms] of Object.entries(input.ceilings ?? {})) {
    if (typeof ms === 'number') ceilingOverrides.set(type as JobType, ms)
  }
  if (input.scale !== undefined) scaleOverride = input.scale
}

/**
 * A worker that outlived its own ceiling. The message is the row's sentence, so
 * it says what was waited on, for how long, and what the operator can do.
 */
export class JobLeaseExpiredError extends Error {
  constructor(readonly type: JobType, readonly ceilingMs: number) {
    super(`Story stopped waiting for this ${type} after ${describeCeiling(ceilingMs)} — its own ceiling for that work.`
      + ' The row is retryable; work already saved on disk is kept. Press Retry to continue it,'
      + ' or raise job_lease_ceiling_scale if this step legitimately needs longer.')
    this.name = 'JobLeaseExpiredError'
  }
}

export interface JobLeaseDeps {
  /** Called with no time to spare when the ceiling is crossed. */
  onExpired?: () => void
  now?: () => number
}

/**
 * Await `work` under the job type's own ceiling.
 *
 * A late settlement (the abandoned executor finishing afterwards) is logged once
 * beside the verdict and never returned: the row is already settled, and a
 * result that arrives after its ceiling must not be able to rewrite it.
 *
 * shortcut: the abandoned executor is not cancelled, only unowned — an executor that reaches a
 * persisting helper after the verdict can still write to that row. It cannot change a terminal
 * status here, and the log line names it. Upgrade to a real cancellation token in the executor
 * contract if a late write is ever seen to reopen a row.
 */
export async function withJobLease<T>(
  job: { job_id: string; type: JobType },
  work: () => Promise<T>,
  deps: JobLeaseDeps = {},
): Promise<T> {
  const ceilingMs = executionCeilingMs(job.type)
  const promise = work()
  if (ceilingMs === null) return promise

  const settled = { current: false }
  void promise.then(
    () => { if (settled.current) noteLate(job, 'finished') },
    error => { if (settled.current) noteLate(job, `failed: ${error instanceof Error ? error.message : String(error)}`) },
  ).catch(() => { /* the note itself must never throw */ })

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          settled.current = true
          try { deps.onExpired?.() } catch (error) {
            logLine('error', `[job-lease] could not stop the children of ${job.job_id}`, { error: String(error) })
          }
          reject(new JobLeaseExpiredError(job.type, ceilingMs))
        }, ceilingMs)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function noteLate(job: { job_id: string; type: JobType }, what: string): void {
  logLine('warn', `[job-lease] the executor of ${job.type} ${job.job_id} settled after its ceiling was crossed; the row keeps its verdict`, { what })
}

/** Read the scale at boot and follow it while the app runs, like the wedge bound does. */
export function startJobLeaseSettings(): void {
  const load = () => {
    void getAppSetting(JOB_LEASE_SCALE_KEY)
      .then(raw => { scale = clampScale(raw) })
      .catch(() => { /* the last good value stands */ })
  }
  load()
  onAppSettingWritten(key => { if (key === JOB_LEASE_SCALE_KEY) load() })
}

/** Every job type resolves to a class; exported so a test can prove the table is complete. */
export function classifiedJobTypes(): JobType[] {
  return JOB_TYPES.filter(type => TYPE_CLASS[type] !== undefined)
}
