/**
 * Pure decision / aggregation layer for OS notifications.
 *
 * Split from the Electron main-process subscription so the logic is testable
 * without importing `electron` (tests run under `tsx --test`, no display).
 * main.ts imports these helpers, wires them to `jobEvents`, and calls the
 * actual `new Notification(...)` constructor.
 *
 * Two notification classes:
 *   1. Batch completion — fires once per `pipeline_batch_id` when every
 *      job tagged with that id has reached a terminal state.
 *   2. Long single job — fires for non-batch jobs whose wall-clock elapsed
 *      exceeds `min_duration_ms`. Threshold is user-configurable because
 *      a two-minute subtitle run shouldn't nag the operator.
 */

import { getAppSetting, setAppSetting } from './app-settings.js'
import type { Job } from '../models/types.js'
import { truncateChars } from '../lib/well-formed-text.js'

/** Telegram bot channel (v1.0.60+). Independent of the desktop channel
 *  — a user in Cambodia can mute desktop pop-ups but still get Telegram
 *  pings on their phone, or vice versa. Both share the same payload
 *  formatter so message content stays in lockstep. */
export interface TelegramConfig {
  enabled: boolean
  /** Bot token from @BotFather (looks like `1234:ABCdef…`). Stored
   *  in app-settings.json — global per machine, not per project. */
  bot_token: string
  /** Numeric chat id of the user (or `@channelname` for a channel).
   *  User obtains it by sending /start to their bot, then GETting
   *  https://api.telegram.org/bot{token}/getUpdates. */
  chat_id: string
}

/** Daily digest config (v1.0.62+). Fires once per day at the user's
 *  local time, summarising scheduling status across every project on
 *  the machine. Per-channel toggles are independent of the per-event
 *  ping channels above — a user might want quiet desktop pop-ups for
 *  job completions but a single Telegram digest each morning. */
export interface DigestConfig {
  enabled: boolean
  /** 'HH:MM' in 24-hour local time. Default '09:00'. */
  time_local: string
  desktop_enabled: boolean
  telegram_enabled: boolean
  /** v1.0.367 — when on, the scheduled digest is skipped on days when
   *  nothing is going live (totals.going_live_today === 0), so it only
   *  pings you when there's something to act on. Manual "Send now"
   *  ignores this and always sends a preview. */
  quiet_when_empty?: boolean
  /** Last YYYY-MM-DD (local) the scheduled fire ran. Used by the
   *  60-second tick to dedupe so a fire-window crossing minute marks
   *  doesn't double-fire. Manual "Send now" doesn't update this. */
  last_fired_date?: string
}

/** v1.0.367 — per-event toggles. Channels (desktop / telegram) decide WHERE a
 *  notification goes; these decide WHICH events fire at all. All default on. */
export interface NotificationEvents {
  /** The per-run summary when a pipeline batch finishes (success or with issues). */
  pipeline_finished: boolean
  /** A job failed — pings immediately, for any job type. */
  failures: boolean
  /** A standalone (non-batch) job finished after running ≥ `min_duration_ms`. */
  long_job: boolean
}

export interface NotifierSettings {
  /** Desktop (Electron Notification) channel — the original system. */
  enabled: boolean
  /** Single-job notifications fire only when elapsed ≥ this threshold. */
  min_duration_ms: number
  /** v1.0.367 — which events are allowed to notify (on whichever channels
   *  are enabled). Missing = all on (the historical behaviour). */
  events?: NotificationEvents
  /** Optional Telegram channel. Backward compat: missing/undefined =
   *  Telegram disabled, the original desktop-only behaviour. */
  telegram?: TelegramConfig
  /** Optional daily digest schedule. Missing = disabled. */
  digest?: DigestConfig
}

export const DEFAULT_NOTIFIER_SETTINGS: NotifierSettings = {
  enabled: true,
  min_duration_ms: 300_000,
  events: { pipeline_finished: true, failures: true, long_job: true },
  telegram: { enabled: false, bot_token: '', chat_id: '' },
  digest: { enabled: false, time_local: '09:00', desktop_enabled: true, telegram_enabled: true, quiet_when_empty: false },
}

/** Aggregate over every job tagged with a given `pipeline_batch_id`. */
export interface BatchStats {
  batch_id: string
  total: number
  success: number
  fail: number
  cancelled: number
  earliest_created_at: string | null
  latest_finished_at: string | null
  elapsed_ms: number
  /** queued + running. When this reaches 0 the batch is complete. */
  still_active: number
}

/** Does `job` belong to a pipeline batch? */
export function getBatchId(job: Job): string | null {
  const id = job.params?.pipeline_batch_id
  return typeof id === 'string' && id.length > 0 ? id : null
}

export function aggregateBatch(jobs: Job[], batchId: string): BatchStats {
  let total = 0
  let success = 0
  let fail = 0
  let cancelled = 0
  let still_active = 0
  let earliest: string | null = null
  let latest: string | null = null

  for (const j of jobs) {
    if (getBatchId(j) !== batchId) continue
    total++
    if (!earliest || j.created_at < earliest) earliest = j.created_at
    if (j.finished_at && (!latest || j.finished_at > latest)) latest = j.finished_at
    switch (j.status) {
      case 'done':      success++; break
      case 'error':     fail++; break
      case 'cancelled': cancelled++; break
      case 'queued':
      case 'running':   still_active++; break
    }
  }

  const elapsed_ms = earliest && latest
    ? Math.max(0, Date.parse(latest) - Date.parse(earliest))
    : 0

  return { batch_id: batchId, total, success, fail, cancelled,
    earliest_created_at: earliest, latest_finished_at: latest,
    elapsed_ms, still_active }
}

export function isBatchComplete(stats: BatchStats): boolean {
  return stats.total > 0 && stats.still_active === 0
}

/**
 * Single-job notification filter. Only fires for non-batch jobs in a
 * terminal state whose wall-clock elapsed ≥ `min_duration_ms`.
 *
 * `started_at` can be null for queued-then-cancelled jobs — those never
 * actually ran, so there's nothing worth notifying about.
 */
export function shouldNotifyForSingleJob(
  job: Job,
  settings: NotifierSettings,
): boolean {
  if (!settings.enabled) return false
  if (getBatchId(job)) return false
  if (job.status !== 'done' && job.status !== 'error' && job.status !== 'cancelled') return false
  if (!job.started_at || !job.finished_at) return false
  const elapsed = Date.parse(job.finished_at) - Date.parse(job.started_at)
  if (!Number.isFinite(elapsed)) return false
  return elapsed >= settings.min_duration_ms
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s'
  const totalSec = Math.floor(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const totalMin = Math.floor(totalSec / 60)
  if (totalMin < 60) return `${totalMin}m ${totalSec % 60}s`
  const h = Math.floor(totalMin / 60)
  return `${h}h ${totalMin % 60}m`
}

export interface NotificationPayload {
  title: string
  body: string
}

/**
 * Project label appended to notification titles when supplied (v1.0.61+).
 * Lets the user see which channel/project the ping is from at a glance —
 * critical when running multiple projects (one channel, another channel, …)
 * because today's titles like "Pipeline finished" don't say which one.
 * Falls back gracefully when the dispatch layer can't resolve a name.
 */
function suffixProject(title: string, projectLabel?: string): string {
  return projectLabel ? `${title} — ${projectLabel}` : title
}

// v1.0.367 — friendly names for job types so notifications read "Scene plan"
// instead of "scene_plan_run". Mirrors JOB_TYPE_LABELS in frontend useJobs.ts;
// covers the audio-paced pipeline jobs added in 2026. Unknown types fall back
// to the raw type string.
const JOB_TYPE_LABELS: Record<string, string> = {
  'script-only': 'Script', 'introduction-only': 'Introduction', 'chapter-only': 'Chapter regen',
  outline_only: 'Outline', expand_chapters: 'Chapter expansion',
  image_prompts: 'Image prompts', images: 'Images', scene_images: 'Scene images',
  thumb_images: 'Thumbnail images', images_repair: 'Image repair',
  audio: 'Audio', audio_merge: 'Audio merge', metadata: 'Metadata',
  video: 'Video clips', video_assembly: 'Video assembly',
  subtitles_transcribe: 'Subtitles', scene_plan_run: 'Scene plan',
  contextual_cues: 'Contextual cues',
  scene_image_generate: 'Scene image', scene_images_batch: 'Scene images (batch)', scene_clips_batch: 'Motion clips', continuity_render: 'Scene render',
  composition_generate: 'Composition',
  expression_markup: 'Expression markup',
  research_run: 'Research',
  broll_normalize: 'B-roll normalize', broll_assemble: 'B-roll assembly',
  broll_autotag: 'B-roll auto-tag',
  youtube_upload: 'YouTube upload', youtube_playlist_update: 'YouTube playlist',
  youtube_thumbnail_refresh: 'Thumbnail backfill',
}
export function labelForJobType(type: string): string {
  return JOB_TYPE_LABELS[type] || type
}

/** Immediate failure ping — fires for ANY job error when the `failures`
 *  event is on. Independent of duration / batch membership. */
export function shouldNotifyFailure(job: Job, events?: NotificationEvents): boolean {
  if (events && !events.failures) return false
  return job.status === 'error'
}

export function formatFailureMessage(job: Job, projectLabel?: string): NotificationPayload {
  const ep = job.episode_id ? `${job.episode_id} — ` : ''
  const err = (job.error || '').trim()
  return {
    title: suffixProject(`Failed: ${labelForJobType(job.type)}`, projectLabel),
    body: `${ep}${err ? truncateChars(err, 160) : 'Job failed.'}`,
  }
}

export function formatBatchMessage(stats: BatchStats, projectLabel?: string): NotificationPayload {
  const baseTitle = stats.fail > 0 || stats.cancelled > 0
    ? 'Pipeline finished with issues'
    : 'Pipeline finished'
  const parts: string[] = [`${stats.success}/${stats.total} episodes succeeded.`]
  if (stats.fail > 0) parts.push(`${stats.fail} failed.`)
  if (stats.cancelled > 0) parts.push(`${stats.cancelled} cancelled.`)
  parts.push(`Elapsed ${formatDuration(stats.elapsed_ms)}.`)
  return { title: suffixProject(baseTitle, projectLabel), body: parts.join(' ') }
}

export function formatSingleJobMessage(job: Job, projectLabel?: string): NotificationPayload {
  const elapsed = job.started_at && job.finished_at
    ? Date.parse(job.finished_at) - Date.parse(job.started_at)
    : 0
  const tag = job.status === 'done'  ? 'Done'
           : job.status === 'error' ? 'Failed'
           :                          'Cancelled'
  const prefix = job.episode_id ? `${job.episode_id} — ` : ''
  return {
    title: suffixProject(`${tag}: ${labelForJobType(job.type)}`, projectLabel),
    body: `${prefix}${formatDuration(elapsed)}`,
  }
}

// ── Persistence (thin wrapper over app-settings.ts) ────────────────────────

function readTelegramConfig(raw: unknown): TelegramConfig {
  const def = DEFAULT_NOTIFIER_SETTINGS.telegram!
  if (!raw || typeof raw !== 'object') return { ...def }
  const r = raw as Record<string, unknown>
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : def.enabled,
    bot_token: typeof r.bot_token === 'string' ? r.bot_token : def.bot_token,
    chat_id: typeof r.chat_id === 'string' ? r.chat_id : def.chat_id,
  }
}

function readDigestConfig(raw: unknown): DigestConfig {
  const def = DEFAULT_NOTIFIER_SETTINGS.digest!
  if (!raw || typeof raw !== 'object') return { ...def }
  const r = raw as Record<string, unknown>
  // Loose validation — `time_local` accepts H:MM or HH:MM, refuses
  // garbage like "9:0pm". Bad values fall back to default.
  const time = typeof r.time_local === 'string' && /^\d{1,2}:\d{2}$/.test(r.time_local)
    ? r.time_local : def.time_local
  const out: DigestConfig = {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : def.enabled,
    time_local: time,
    desktop_enabled: typeof r.desktop_enabled === 'boolean' ? r.desktop_enabled : def.desktop_enabled,
    telegram_enabled: typeof r.telegram_enabled === 'boolean' ? r.telegram_enabled : def.telegram_enabled,
    quiet_when_empty: typeof r.quiet_when_empty === 'boolean' ? r.quiet_when_empty : !!def.quiet_when_empty,
  }
  // Only include last_fired_date when actually persisted — otherwise
  // deepEqual against DEFAULT_NOTIFIER_SETTINGS (which omits the key)
  // sees `last_fired_date: undefined` as a diff.
  if (typeof r.last_fired_date === 'string') out.last_fired_date = r.last_fired_date
  return out
}

function readEvents(raw: unknown): NotificationEvents {
  const def = DEFAULT_NOTIFIER_SETTINGS.events!
  if (!raw || typeof raw !== 'object') return { ...def }
  const r = raw as Record<string, unknown>
  return {
    pipeline_finished: typeof r.pipeline_finished === 'boolean' ? r.pipeline_finished : def.pipeline_finished,
    failures: typeof r.failures === 'boolean' ? r.failures : def.failures,
    long_job: typeof r.long_job === 'boolean' ? r.long_job : def.long_job,
  }
}

export async function getNotifierSettings(): Promise<NotifierSettings> {
  const raw = await getAppSetting('notifications')
  const defaults = DEFAULT_NOTIFIER_SETTINGS
  if (!raw || typeof raw !== 'object') {
    return { ...defaults, events: { ...defaults.events! }, telegram: { ...defaults.telegram! }, digest: { ...defaults.digest! } }
  }
  const r = raw as Record<string, unknown>
  const min = typeof r.min_duration_ms === 'number' && r.min_duration_ms >= 0
    ? r.min_duration_ms : defaults.min_duration_ms
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : defaults.enabled,
    min_duration_ms: min,
    events: readEvents(r.events),
    telegram: readTelegramConfig(r.telegram),
    digest: readDigestConfig(r.digest),
  }
}

export async function setNotifierSettings(patch: Partial<NotifierSettings>): Promise<NotifierSettings> {
  const current = await getNotifierSettings()
  const curEvents = current.events || DEFAULT_NOTIFIER_SETTINGS.events!
  const next: NotifierSettings = {
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
    min_duration_ms: typeof patch.min_duration_ms === 'number' && patch.min_duration_ms >= 0
      ? patch.min_duration_ms : current.min_duration_ms,
    events: patch.events
      ? {
          pipeline_finished: typeof patch.events.pipeline_finished === 'boolean' ? patch.events.pipeline_finished : curEvents.pipeline_finished,
          failures: typeof patch.events.failures === 'boolean' ? patch.events.failures : curEvents.failures,
          long_job: typeof patch.events.long_job === 'boolean' ? patch.events.long_job : curEvents.long_job,
        }
      : curEvents,
    telegram: patch.telegram
      ? {
          enabled: typeof patch.telegram.enabled === 'boolean'
            ? patch.telegram.enabled
            : (current.telegram?.enabled ?? false),
          bot_token: typeof patch.telegram.bot_token === 'string'
            ? patch.telegram.bot_token.trim()
            : (current.telegram?.bot_token ?? ''),
          chat_id: typeof patch.telegram.chat_id === 'string'
            ? patch.telegram.chat_id.trim()
            : (current.telegram?.chat_id ?? ''),
        }
      : current.telegram,
    digest: patch.digest
      ? {
          enabled: typeof patch.digest.enabled === 'boolean'
            ? patch.digest.enabled
            : (current.digest?.enabled ?? false),
          time_local: typeof patch.digest.time_local === 'string' && /^\d{1,2}:\d{2}$/.test(patch.digest.time_local)
            ? patch.digest.time_local
            : (current.digest?.time_local ?? '09:00'),
          desktop_enabled: typeof patch.digest.desktop_enabled === 'boolean'
            ? patch.digest.desktop_enabled
            : (current.digest?.desktop_enabled ?? true),
          telegram_enabled: typeof patch.digest.telegram_enabled === 'boolean'
            ? patch.digest.telegram_enabled
            : (current.digest?.telegram_enabled ?? true),
          quiet_when_empty: typeof patch.digest.quiet_when_empty === 'boolean'
            ? patch.digest.quiet_when_empty
            : (current.digest?.quiet_when_empty ?? false),
          // last_fired_date is set internally by the scheduler; preserve
          // unless the patch explicitly sets it (e.g. tests).
          last_fired_date: typeof patch.digest.last_fired_date === 'string'
            ? patch.digest.last_fired_date
            : current.digest?.last_fired_date,
        }
      : current.digest,
  }
  await setAppSetting('notifications', next)
  return next
}
