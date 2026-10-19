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
 *   - `startYouTubeStatusSync` — a gentle background check every 30 minutes
 *     per project: `accepted` / `processing` operations, then at most
 *     `BACKGROUND_MAX_CALLS` batched calls for any known video (ready,
 *     scheduled, legacy, reconciled, listed) whose cached observation is stale.
 *     Backs off after failures and stops for a channel that needs Reconnect.
 *   - the upload job itself checks once right after acceptance.
 *
 * Every answer lands in the channel's publication cache
 * (`youtube-publication-cache.ts`), which every reader shares.
 *
 * It also warns, a day ahead, when a channel's sign-in is the 7-day kind.
 */

import { registryCredentialFor } from '../lib/youtube-client.js'
import { logLine } from './logger.js'
import { listProjects } from './project-manager.js'
import { recordSidecarYouTubeCheck } from './upload-sidecar.js'
import { getProjectYouTubeAssignment, grantAgeMs, readYouTubeConnectionRegistry } from './youtube-connection-store.js'
import { listYouTubeOperations } from './youtube-operation-store.js'
import { readYouTubeProjectPublishingState } from './youtube-project-publishing-store.js'
import {
  legacyUploadsFor,
  observedPublicationIndex,
  readYouTubePublicationCache,
  refreshStaleYouTubePublications,
  refreshYouTubePublications,
  type ObservedPublication,
} from './youtube-publication-cache.js'
import {
  YOUTUBE_VIDEO_NOT_FOUND,
  isYouTubeUploadCheckDue,
  setYouTubePublicationFailureNotifier,
  syncProjectYouTubePublicationStates,
  type ProjectSyncResult,
} from './youtube-publication-status.js'

export interface CheckAllResult extends ProjectSyncResult {
  legacy: { checked: number; processed: number; not_found: number }
  /** The batched publication-cache refresh for legacy, reconciled and listed videos. */
  publication_cache: { requested: number; recorded: number; unrequested: number; calls: number }
}

/** At most 2,000 videos per deliberate "Check All Uploads" (40 videos.list calls of 50). */
const CHECK_ALL_MAX_CALLS = 40
/** At most 100 stale videos per background pass. */
const BACKGROUND_MAX_CALLS = 2

/** The owner's one-time "Check All Uploads" for one project. */
export async function checkAllYouTubeUploads(input: { project_slug: string; account_id: string }): Promise<CheckAllResult> {
  const operations = await syncProjectYouTubePublicationStates(input)
  const legacy = { checked: 0, processed: 0, not_found: 0 }
  const publication_cache = { requested: 0, recorded: 0, unrequested: 0, calls: 0 }
  const result = (extra: Partial<ProjectSyncResult> = {}): CheckAllResult => ({
    ...operations,
    ...extra,
    checked: operations.checked + legacy.checked,
    legacy,
    publication_cache,
  })
  const channelId = operations.channel_id
  const uploads = await legacyUploadsFor(input.project_slug, channelId)
  // Everything else this channel knows without an operation record: legacy
  // uploads, reconciled links and listed channel videos - including ones
  // YouTube said were not found, because this is the deliberate re-check.
  // Operation videos were just asked above and are already in the cache.
  const [state, cache, records] = await Promise.all([
    readYouTubeProjectPublishingState(input.project_slug),
    // The cache only adds videos to ask about; an unreadable one must not fail the check itself.
    readYouTubePublicationCache(input.project_slug).catch(() => ({})),
    listYouTubeOperations(input.project_slug),
  ])
  const asked = new Map<string, { source: ObservedPublication['source']; episode_code?: string }>()
  for (const entry of observedPublicationIndex(state, cache, records, channelId).values()) {
    if (entry.source !== 'operation') {
      asked.set(entry.video_id, { source: entry.source, ...(entry.episode_code ? { episode_code: entry.episode_code } : {}) })
    }
  }
  for (const [videoId, code] of uploads) asked.set(videoId, { source: 'legacy', episode_code: code })
  if (!asked.size) return result()
  const refreshed = await refreshYouTubePublications({
    project_slug: input.project_slug, account_id: input.account_id, channel_id: channelId,
    videos: asked, max_calls: CHECK_ALL_MAX_CALLS,
  })
  Object.assign(publication_cache, {
    requested: refreshed.requested, recorded: refreshed.recorded, unrequested: refreshed.unrequested, calls: refreshed.calls,
  })
  if (refreshed.error_code) {
    logLine('warn', `[youtube-status] legacy check ${refreshed.outcome}: ${refreshed.error_code}`, { project_slug: input.project_slug })
  }
  const checkedAt = new Date().toISOString()
  for (const videoId of refreshed.answered) {
    const code = uploads.get(videoId)
    if (!code) continue
    const found = refreshed.details[videoId]
    const status = found ? (found.uploadStatus || 'unknown') : YOUTUBE_VIDEO_NOT_FOUND
    const written = await recordSidecarYouTubeCheck(input.project_slug, code, videoId, {
      checked_at: checkedAt, upload_status: status, channel_id: found?.channelId ?? null,
    }).catch(() => false)
    if (!written) continue
    legacy.checked += 1
    if (status === 'processed') legacy.processed += 1
    if (status === YOUTUBE_VIDEO_NOT_FOUND) legacy.not_found += 1
  }
  if (refreshed.outcome === 'ok') return result()
  return result({
    // Nothing learned anywhere is a failure, not "partial".
    outcome: operations.outcome === 'failed' || (refreshed.outcome === 'failed' && operations.checked === 0) ? 'failed' : 'partial',
    ...(refreshed.error_code ? { error_code: refreshed.error_code } : {}),
  })
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
  // An upload YouTube gave up on is announced on the same channels a failed job
  // is: the upload job finished long before the verdict arrives.
  setYouTubePublicationFailureNotifier(dispatcher)
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
      const accountId = registryCredentialFor(assignment.channel_id)
      // The watch covers `not_found` too, for 24 h after acceptance: a video
      // YouTube has not indexed yet answers exactly like one that is gone, and
      // dropping it there is how an accepted upload is never followed again.
      const pending = (await listYouTubeOperations(slug))
        .some(record => record.channel_id === assignment.channel_id && isYouTubeUploadCheckDue(record, now))
      if (pending) {
        const result = await syncProjectYouTubePublicationStates({ project_slug: slug, account_id: accountId, only_pending: true, now })
        if (result.outcome === 'failed') {
          throw Object.assign(new Error(`sync ${result.error_code || 'failed'}`), { quota: result.error_code === 'quota_exhausted' })
        }
      }
      const stale = await refreshStaleYouTubePublications({
        project_slug: slug, account_id: accountId, channel_id: assignment.channel_id, max_calls: BACKGROUND_MAX_CALLS, now,
      })
      if (stale?.outcome === 'failed') {
        throw Object.assign(new Error(`refresh ${stale.error_code || 'failed'}`), { quota: stale.error_code === 'quota_exhausted' })
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
  setYouTubePublicationFailureNotifier(null)
}
