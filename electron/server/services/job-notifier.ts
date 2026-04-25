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

export interface NotifierSettings {
  enabled: boolean
  /** Single-job notifications fire only when elapsed ≥ this threshold. */
  min_duration_ms: number
}

export const DEFAULT_NOTIFIER_SETTINGS: NotifierSettings = {
  enabled: true,
  min_duration_ms: 300_000,
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

export function formatBatchMessage(stats: BatchStats): NotificationPayload {
  const title = stats.fail > 0 || stats.cancelled > 0
    ? 'Pipeline finished with issues'
    : 'Pipeline finished'
  const parts: string[] = [`${stats.success}/${stats.total} episodes succeeded.`]
  if (stats.fail > 0) parts.push(`${stats.fail} failed.`)
  if (stats.cancelled > 0) parts.push(`${stats.cancelled} cancelled.`)
  parts.push(`Elapsed ${formatDuration(stats.elapsed_ms)}.`)
  return { title, body: parts.join(' ') }
}

export function formatSingleJobMessage(job: Job): NotificationPayload {
  const elapsed = job.started_at && job.finished_at
    ? Date.parse(job.finished_at) - Date.parse(job.started_at)
    : 0
  const tag = job.status === 'done'  ? 'Done'
           : job.status === 'error' ? 'Failed'
           :                          'Cancelled'
  const prefix = job.episode_id ? `${job.episode_id} — ` : ''
  return {
    title: `${tag}: ${job.type}`,
    body: `${prefix}${formatDuration(elapsed)}`,
  }
}

// ── Persistence (thin wrapper over app-settings.ts) ────────────────────────

export async function getNotifierSettings(): Promise<NotifierSettings> {
  const raw = await getAppSetting('notifications')
  const defaults = DEFAULT_NOTIFIER_SETTINGS
  if (!raw || typeof raw !== 'object') return { ...defaults }
  const r = raw as Record<string, unknown>
  const min = typeof r.min_duration_ms === 'number' && r.min_duration_ms >= 0
    ? r.min_duration_ms : defaults.min_duration_ms
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : defaults.enabled,
    min_duration_ms: min,
  }
}

export async function setNotifierSettings(patch: Partial<NotifierSettings>): Promise<NotifierSettings> {
  const current = await getNotifierSettings()
  const next: NotifierSettings = {
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
    min_duration_ms: typeof patch.min_duration_ms === 'number' && patch.min_duration_ms >= 0
      ? patch.min_duration_ms : current.min_duration_ms,
  }
  await setAppSetting('notifications', next)
  return next
}
