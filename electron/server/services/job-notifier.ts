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
import { redactSecrets } from '../lib/redact-secrets.js'
import { awaitingApprovalLabel } from '../contracts/episode-step-jobs.js'

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
  thumbnail_score: 'Thumbnail scoring',
  audio: 'Audio', audio_merge: 'Audio merge', metadata: 'Metadata',
  video_assembly: 'Video assembly', episode_shorts: 'Episode Shorts',
  subtitles_transcribe: 'Subtitles', scene_plan_run: 'Scene plan',
  contextual_cues: 'Contextual cues',
  scene_image_generate: 'Scene image', scene_images_batch: 'Scene images (batch)', scene_clips_batch: 'Motion clips', continuity_render: 'Scene render',
  composition_generate: 'Composition',
  research_run: 'Research',
  translate_episode: 'Translate episode',
  broll_normalize: 'B-roll normalize', broll_assemble: 'B-roll assembly',
  broll_autotag: 'B-roll auto-tag',
  // Retired job types: kept so old rows in Jobs still read plainly.
  expression_markup: 'Expression markup',
  // The legacy AI Video Generator's lane (deleted 2026-10-27). Its stored rows are history.
  video: 'Video clips',
  youtube_upload: 'YouTube upload', youtube_playlist_update: 'YouTube playlist',
  social_publish: 'Social posting',
  youtube_thumbnail_refresh: 'Thumbnail backfill',
}
/** The Pipeline's step order (mirrors VALID_STEPS in routes/pipeline.ts). A
 *  batch's jobs are chained STEPS, so the summary reads in the order they ran. */
/** `3m28s`, `1h24m`, `2m` — the Pipeline checklist's compact form (shared). */
const formatCompactDuration = sharedFormatCompactDuration

/** Immediate failure ping — fires for ANY job error when the `failures`
 *  event is on. Independent of duration / batch membership. */
export function shouldNotifyFailure(job: Job, events?: NotificationEvents): boolean {
  if (events && !events.failures) return false
  return job.status === 'error'
}

/**
 * `DM0013 — The Lost Temple`, or the bare code when no title is on record.
 * Never invents one: an unknown title leaves the stable episode code standing
 * alone (owner request 2026-10-18 — the ping must say WHICH episode it worked
 * on, and the code alone doesn't tell a human that).
 */
function episodeIdentity(code: string, title?: string): string {
  const t = (title || '').trim()
  return t ? `${code} — ${truncateChars(t, 80)}` : code
}

export function formatFailureMessage(job: Job, projectLabel?: string, episodeTitle?: string): NotificationPayload {
  const ep = job.episode_id ? `${episodeIdentity(job.episode_id, episodeTitle)} — ` : ''
  // Errors travel to the owner's phone; reuse the existing scrubber so a
  // provider that echoes a key or a credential-bearing URL can't ride along.
  const err = redactSecrets((job.error || '').trim())
  return {
    title: suffixProject(`Failed: ${labelForJobType(job.type)}`, projectLabel),
    body: `${ep}${err ? truncateChars(err, 160) : 'Job failed.'}`,
  }
}

/**
 * How many per-episode lines a Pipeline summary carries before the tail
 * collapses into "… and N more (…)". Bounded so a 30-episode batch stays one
 * readable notification — and comfortably inside Telegram's 4096-char cap,
 * even when every line is a full-length failure — while an ordinary run
 * names every episode it touched.
 */
export const BATCH_EPISODE_LINE_LIMIT = 8

/** The step rollup lives in `contracts/batch-episode-steps.ts` — shared with
 *  the Jobs page's Timing disclosure so both sides read the same facts. The
 *  notifier adds the redaction scrub the phone message needs. */
import {
  formatCompactDuration as sharedFormatCompactDuration,
  labelForJobType,
  summarizeEpisodeSteps,
  type BatchEpisodeOutcome,
  type BatchEpisodeStep,
} from '../contracts/batch-episode-steps.js'
export { labelForJobType } from '../contracts/batch-episode-steps.js'
export type { BatchEpisodeOutcome } from '../contracts/batch-episode-steps.js'

/**
 * Group a batch's jobs by episode for the Pipeline summary.
 *
 * Episodes are the unit the summary sentence actually claims ("N/M episodes
 * succeeded"); a batch's jobs are chained STEPS, so one 15-hour episode is
 * many jobs and counting jobs would report "7/7 episodes" for one episode.
 * Each episode carries its ordered steps, from the jobs' own `pipeline_step`,
 * `created_at`, `finished_at` and `status`, so the notification says what each
 * step did instead of "done · N steps" (owner request 2026-11-14). A step the
 * chain planned but never got a job is shown as absent.
 * Failures sort first — they are the lines worth reading — with run order
 * kept inside each state group. `titles` comes from the idea store
 * (episode code → title); codes missing from it keep the stable code alone.
 */
export function summarizeBatchEpisodes(
  jobs: Job[],
  titles?: ReadonlyMap<string, string> | null,
): BatchEpisodeOutcome[] {
  const groups = new Map<string, Job[]>()
  for (const j of jobs) {
    const code = (j.episode_id || '').trim()
    if (!code) continue // A row with no episode id has no identity to show.
    const list = groups.get(code)
    if (list) list.push(j)
    else groups.set(code, [j])
  }

  const ranked: Array<{ outcome: BatchEpisodeOutcome; rank: number; first_seen: string }> = []
  for (const [code, group] of groups) {
    let stepsDone = 0
    let failed: Job | null = null
    let anyCancelled = false
    let anyActive = false
    let firstSeen = group[0]!.created_at
    let lastFinished = ''
    for (const j of group) {
      if (j.created_at && j.created_at < firstSeen) firstSeen = j.created_at
      if (j.finished_at && j.finished_at > lastFinished) lastFinished = j.finished_at
      switch (j.status) {
        case 'done': stepsDone++; break
        case 'error': if (!failed || j.created_at < failed.created_at) failed = j; break
        case 'cancelled': anyCancelled = true; break
        case 'queued':
        case 'running': anyActive = true; break
      }
    }
    const state: BatchEpisodeOutcome['state'] = failed ? 'failed'
      : anyCancelled ? 'cancelled'
      : anyActive ? 'running'
      : 'done'

    // The steps this episode actually has a job for, grouped and ordered by
    // the shared builder — the same facts the Jobs page's Timing disclosure
    // renders (the script step's outline → chapters pair stays one step).
    const { steps } = summarizeEpisodeSteps(group, redactSecrets)

    const outcome: BatchEpisodeOutcome = {
      episode_id: code,
      title: String(titles?.get(code) || '').trim(),
      state,
      steps_done: stepsDone,
      steps_total: group.length,
      steps,
      elapsed_ms: state !== 'running' && lastFinished
        ? Math.max(0, Date.parse(lastFinished) - Date.parse(firstSeen))
        : 0,
    }
    if (failed) {
      outcome.failed_step = labelForJobType(failed.type)
      const err = redactSecrets((failed.error || '').trim()).replace(/\s+/g, ' ').trim()
      if (err) outcome.failed_error = err
    }
    const rank = state === 'failed' ? 0 : state === 'cancelled' ? 1 : state === 'running' ? 2 : 3
    ranked.push({ outcome, rank, first_seen: firstSeen })
  }

  ranked.sort((a, b) => a.rank - b.rank || a.first_seen.localeCompare(b.first_seen))
  return ranked.map(r => r.outcome)
}

/** One checklist entry: `audio ✓ 8m46s`, `subtitles — pending`, `audio ✗ — …`. */
function formatBatchEpisodeStep(step: BatchEpisodeStep): string {
  const label = step.label.toLowerCase()
  if (step.status === 'absent') return `${label} — pending`
  if (step.status === 'cancelled') return `${label} — cancelled`
  if (step.status === 'paused' || step.status === 'queued' || step.status === 'running') {
    return `${label} — ${step.status}`
  }
  const time = step.elapsed_ms > 0 ? ` ${formatCompactDuration(step.elapsed_ms)}` : ''
  if (step.status === 'failed') {
    return `${label} ✗${time}${step.reason ? ` — ${truncateChars(step.reason, 120)}` : ''}`
  }
  return `${label} ✓${time}`
}

/** One line of the per-episode detail under a Pipeline summary: the episode,
 *  then its steps in pipeline order with what each did, then the episode's
 *  total. Never the old "done · N steps" — that said nothing about the run. */
function formatBatchEpisodeLine(e: BatchEpisodeOutcome): string {
  const name = episodeIdentity(e.episode_id, e.title)
  if (e.steps.length === 0) {
    const state = e.state === 'failed' ? 'failed'
      : e.state === 'cancelled' ? 'cancelled'
      : e.state === 'running' ? 'still running'
      : 'done'
    return `${name}: ${state}`
  }
  const parts = e.steps.map(formatBatchEpisodeStep)
  if (e.elapsed_ms > 0 && e.state !== 'running') parts.push(`total ${formatCompactDuration(e.elapsed_ms)}`)
  // A failed run keeps everything that already finished — say so, so the line
  // cannot read as if the whole episode was lost.
  if (e.state === 'failed' && e.steps.some(s => s.status === 'done')) parts.push('finished steps are kept')
  return `${name}: ${parts.join(' · ')}`
}

/** "… and 4 more (2 failed, 1 cancelled)" — the explicit count of episodes
 *  the line limit omitted, so nothing disappears silently from the summary. */
function formatOmittedEpisodes(omitted: BatchEpisodeOutcome[]): string {
  const failed = omitted.filter(e => e.state === 'failed').length
  const cancelled = omitted.filter(e => e.state === 'cancelled').length
  const bits: string[] = []
  if (failed > 0) bits.push(`${failed} failed`)
  if (cancelled > 0) bits.push(`${cancelled} cancelled`)
  return `… and ${omitted.length} more (${bits.length > 0 ? bits.join(', ') : 'all done'})`
}

/**
 * Per-run summary when a pipeline batch finishes.
 *
 * With `episodes` (from summarizeBatchEpisodes) the counts and the detail
 * lines describe EPISODES — the sentence's own unit; each episode is named
 * by code and title, up to BATCH_EPISODE_LINE_LIMIT lines. Without it the
 * aggregate job counts are kept, so callers that never resolved episode
 * identity see the original wording.
 */
export function formatBatchMessage(
  stats: BatchStats,
  projectLabel?: string,
  episodes?: BatchEpisodeOutcome[] | null,
): NotificationPayload {
  const detail = episodes && episodes.length > 0 ? episodes : null
  const total = detail ? detail.length : stats.total
  const success = detail ? detail.filter(e => e.state === 'done').length : stats.success
  const fail = detail ? detail.filter(e => e.state === 'failed').length : stats.fail
  const cancelled = detail ? detail.filter(e => e.state === 'cancelled').length : stats.cancelled

  const baseTitle = fail > 0 || cancelled > 0
    ? 'Pipeline finished with issues'
    : 'Pipeline finished'
  const parts: string[] = [`${success}/${total} episodes succeeded.`]
  if (fail > 0) parts.push(`${fail} failed.`)
  if (cancelled > 0) parts.push(`${cancelled} cancelled.`)
  parts.push(`Elapsed ${formatDuration(stats.elapsed_ms)}.`)
  const header = parts.join(' ')

  if (!detail) return { title: suffixProject(baseTitle, projectLabel), body: header }

  const lines = [header, ...detail.slice(0, BATCH_EPISODE_LINE_LIMIT).map(formatBatchEpisodeLine)]
  const omitted = detail.slice(BATCH_EPISODE_LINE_LIMIT)
  if (omitted.length > 0) lines.push(formatOmittedEpisodes(omitted))
  return { title: suffixProject(baseTitle, projectLabel), body: lines.join('\n') }
}

export function formatSingleJobMessage(job: Job, projectLabel?: string, episodeTitle?: string): NotificationPayload {
  const elapsed = job.started_at && job.finished_at
    ? Date.parse(job.finished_at) - Date.parse(job.started_at)
    : 0
  const tag = job.status === 'done'  ? 'Done'
           : job.status === 'error' ? 'Failed'
           :                          'Cancelled'
  const identity = job.episode_id ? `${episodeIdentity(job.episode_id, episodeTitle)} — ` : ''
  return {
    title: suffixProject(`${tag}: ${labelForJobType(job.type)}`, projectLabel),
    body: `${identity}${formatDuration(elapsed)}`,
  }
}

/** A scene render finished and Scene Review now waits on the owner's approval. */
export function formatApprovalWaitMessage(job: Job, projectLabel?: string, episodeTitle?: string): NotificationPayload | null {
  const label = job.status === 'done' ? awaitingApprovalLabel(job.result?.awaiting_approval) : ''
  if (!label) return null
  return {
    title: suffixProject(label, projectLabel),
    body: `${job.episode_id ? `${episodeIdentity(job.episode_id, episodeTitle)} — ` : ''}Scene Review. Open it to approve the scenes.`,
  }
}

/** Quit while jobs run: say what happens to them. Null = nothing running, quit without asking. */
export function formatQuitWarning(running: number): NotificationPayload | null {
  if (!Number.isInteger(running) || running < 1) return null
  return {
    title: `${running} job${running === 1 ? ' is' : 's are'} running; ${running === 1 ? 'it' : 'they'}'ll continue after restart.`,
    body: 'Saved work is kept. Anything that cannot pick up where it stopped shows Retry in Jobs.',
  }
}

/**
 * Whether a quit may stop and ask a person. Never on a machine.
 *
 * The updater's stop arrives as the same Apple Event quit a person's Cmd-Q produces, so the
 * discriminator is what came first: an update hold in force means the updater is driving, and a
 * server-role Mac has nobody at the screen. Either way a modal is not an option — it blocks the
 * main thread, including the shutdown ceiling (a JS timer), and the app serves nothing meanwhile.
 * angkor 2026-11-19: 181 s in `runModalForWindow:` with 9 jobs, then the off-thread watchdog killed
 * it. A person on a desktop is still asked.
 */
export function mayAskBeforeQuit(input: {
  warning: unknown
  hasWindow: boolean
  serverRole: boolean
  updateHoldActive: boolean
}): boolean {
  return Boolean(input.warning) && input.hasWindow && !input.serverRole && !input.updateHoldActive
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
