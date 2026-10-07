/**
 * Following uploads after YouTube accepts them.
 *
 * Before this, nothing asked YouTube again once an upload was accepted: on the
 * mini 0 of ~450 uploads ever reached `ready`, so Free up space had nothing
 * to offer. Three entry points share the same reads:
 *
 *   - `checkAllYouTubeUploads` — the owner's one-click "Check All Uploads":
 *     every operation record AND every legacy-sidecar upload (published before
 *     upload receipts existed), batched 50 ids per `videos.list` call.
 *   - `startYouTubeStatusSync` — a gentle background check of `accepted` /
 *     `processing` operations only, every 30 minutes per project (at most 48
 *     small batched calls a day), backing off after failures and stopping for
 *     a channel that needs Reconnect.
 *   - the upload job itself checks once right after acceptance.
 *
 * It also warns, a day ahead, when a channel's sign-in is the 7-day kind.
 */

import type { VideoPublicationDetails } from '../lib/youtube-client.js'
import { listVideoPublicationDetails, registryCredentialFor } from '../lib/youtube-client.js'
import { logLine } from './logger.js'
import { listProjects } from './project-manager.js'
import * as im from './idea-manager.js'
import { readSidecarStrict, recordSidecarYouTubeCheck } from './upload-sidecar.js'
import { getProjectYouTubeAssignment, grantAgeMs, readYouTubeConnectionRegistry } from './youtube-connection-store.js'
import { listYouTubeOperations } from './youtube-operation-store.js'
import {
  PENDING_YOUTUBE_LIFECYCLES,
  YOUTUBE_VIDEO_NOT_FOUND,
  syncProjectYouTubePublicationStates,
  type ProjectSyncResult,
} from './youtube-publication-status.js'

export interface CheckAllResult extends ProjectSyncResult {
  legacy: { checked: number; processed: number; not_found: number }
}

/** Legacy (pre-receipt) uploads on this channel, by video id → episode code. */
async function legacyUploadsFor(slug: string, channelId: string): Promise<Map<string, string>> {
  const withRecord = new Set((await listYouTubeOperations(slug))
    .filter(record => record.channel_id === channelId && !!record.video_id)
    .map(record => record.episode_code.toUpperCase()))
  const out = new Map<string, string>()
  for (const idea of await im.getIdeas(slug, 'accepted')) {
    const code = String(idea.episode_code || '').toUpperCase()
    if (!code || withRecord.has(code)) continue
    const sidecar = await readSidecarStrict(slug, code, 'youtube').catch(() => null)
    const videoId = sidecar?.video_id?.trim()
    if (!videoId || sidecar!.deleted_at) continue
    if (sidecar!.channel_id && sidecar!.channel_id !== channelId) continue
    out.set(videoId, code)
  }
  return out
}

/** The owner's one-time "Check All Uploads" for one project. */
export async function checkAllYouTubeUploads(input: { project_slug: string; account_id: string }): Promise<CheckAllResult> {
  const operations = await syncProjectYouTubePublicationStates(input)
  const legacy = { checked: 0, processed: 0, not_found: 0 }
  const result = (extra: Partial<ProjectSyncResult> = {}): CheckAllResult => ({
    ...operations,
    ...extra,
    checked: operations.checked + legacy.checked,
    legacy,
  })
  const uploads = await legacyUploadsFor(input.project_slug, operations.channel_id)
  if (!uploads.size) return result()
  let details: Record<string, VideoPublicationDetails>
  try {
    details = await listVideoPublicationDetails(input.project_slug, input.account_id, [...uploads.keys()])
  } catch (error) {
    logLine('warn', `[youtube-status] legacy check failed: ${(error as Error)?.message || 'unknown'}`, { project_slug: input.project_slug })
    return result({ outcome: operations.outcome === 'ok' ? 'partial' : 'failed' })
  }
  // Same rule as the operation sync: an answer with none of several known
  // videos is a wrong-account answer, not an empty channel.
  if (uploads.size >= 3 && ![...uploads.keys()].some(id => details[id])) {
    return result({ outcome: operations.outcome === 'ok' ? 'partial' : 'failed', error_code: 'provider_error' })
  }
  const checkedAt = new Date().toISOString()
  for (const [videoId, code] of uploads) {
    const found = details[videoId]
    const status = found ? (found.uploadStatus || 'unknown') : YOUTUBE_VIDEO_NOT_FOUND
    const written = await recordSidecarYouTubeCheck(input.project_slug, code, videoId, {
      checked_at: checkedAt, upload_status: status, channel_id: found?.channelId ?? null,
    }).catch(() => false)
    if (!written) continue
    legacy.checked += 1
    if (status === 'processed') legacy.processed += 1
    if (status === YOUTUBE_VIDEO_NOT_FOUND) legacy.not_found += 1
  }
  return result()
}

// ── Background check ─────────────────────────────────────────────────────

const INTERVAL_MS = 30 * 60 * 1000
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const backoff = new Map<string, { next_at: number; failures: number }>()
const warned = new Set<string>()

type Notice = { title: string; body: string }
let dispatchNotice: ((notice: Notice) => Promise<void> | void) | null = null

/** Electron wires desktop/Telegram notifications here; headless runs only log. */
export function setYouTubeNoticeDispatcher(dispatcher: ((notice: Notice) => Promise<void> | void) | null): void {
  dispatchNotice = dispatcher
}

/** One pass: follow pending uploads of every project whose channel is signed in. */
export async function runYouTubeStatusSyncPass(now = Date.now()): Promise<void> {
  const registry = await readYouTubeConnectionRegistry()
  for (const project of await listProjects()) {
    const slug = project.slug
    const wait = backoff.get(slug)
    if (wait && now < wait.next_at) continue
    try {
      const assignment = await getProjectYouTubeAssignment(slug)
      const channel = assignment ? registry.channels[assignment.channel_id] : undefined
      if (!assignment || channel?.status !== 'connected') continue
      const pending = (await listYouTubeOperations(slug)).some(record => record.channel_id === assignment.channel_id
        && !!record.video_id && PENDING_YOUTUBE_LIFECYCLES.has(record.lifecycle))
      if (!pending) continue
      const result = await syncProjectYouTubePublicationStates({
        project_slug: slug, account_id: registryCredentialFor(assignment.channel_id), only_pending: true,
      })
      if (result.outcome === 'failed') {
        throw Object.assign(new Error(`sync ${result.error_code || 'failed'}`), { quota: result.error_code === 'quota_exhausted' })
      }
      backoff.delete(slug)
    } catch (error) {
      const failures = (backoff.get(slug)?.failures ?? 0) + 1
      const delay = (error as { quota?: boolean }).quota ? 12 * 60 * 60 * 1000 : Math.min(MAX_BACKOFF_MS, INTERVAL_MS * 2 ** failures)
      backoff.set(slug, { next_at: now + delay, failures })
      logLine('warn', `[youtube-status] background check for ${slug} failed (${(error as Error)?.message || 'unknown'}); next try in ${Math.round(delay / 60000)} min`)
    }
  }
  await warnExpiringSignIns(registry, now)
}

/**
 * Testing-status OAuth apps issue 7-day sign-ins, and the status belongs to
 * the app, so once any channel showed the 7-day pattern every channel of that
 * app is treated as 7-day. Warn once per grant, a day before it lapses.
 */
async function warnExpiringSignIns(registry: Awaited<ReturnType<typeof readYouTubeConnectionRegistry>>, now: number): Promise<void> {
  const channels = Object.values(registry.channels)
  const sevenDayApps = new Set(channels.filter(channel => channel.seven_day_sign_in).map(channel => channel.application_id))
  for (const channel of channels) {
    if (channel.status !== 'connected' || !sevenDayApps.has(channel.application_id)) continue
    const left = 7 * DAY_MS - grantAgeMs(channel, now)
    const key = `${channel.channel_id}:${channel.authorized_at ?? channel.updated_at}`
    if (left > DAY_MS || left <= 0 || warned.has(key)) continue
    warned.add(key)
    const notice = {
      title: `YouTube sign-in for ${channel.title} ends within a day`,
      body: 'Google signs this app out after 7 days while its OAuth consent screen is in Testing. Press Reconnect in Settings → YouTube now, or publish the app to production in Google Cloud Console to stop this.',
    }
    logLine('info', `[youtube-status] ${notice.title}`)
    try { await dispatchNotice?.(notice) } catch { /* a notification is never worth failing the check */ }
  }
}

let timer: ReturnType<typeof setInterval> | null = null

export function startYouTubeStatusSync(): void {
  if (timer) return
  const tick = () => { void runYouTubeStatusSyncPass().catch(error => console.warn('[youtube-status]', error?.message || error)) }
  setTimeout(tick, 2 * 60 * 1000).unref()
  timer = setInterval(tick, INTERVAL_MS)
  timer.unref()
}

export function _resetYouTubeStatusSyncForTests(): void {
  backoff.clear()
  warned.clear()
  dispatchNotice = null
}
