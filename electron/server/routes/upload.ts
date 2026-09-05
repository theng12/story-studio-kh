/**
 * Upload Center REST endpoints.
 *
 * Phase 1 shape only — connection + account CRUD + OAuth handshake status
 * polling. Upload endpoints, plan endpoints, queue endpoints, and reconcile
 * arrive in later phases and will be added below.
 *
 * YouTube is live; TikTok + Facebook rows return `enabled: false` from the
 * platforms endpoint so the frontend can render a Coming Soon badge without
 * a second catalogue elsewhere.
 */

import { Router } from 'express'
import path from 'path'
import * as pm from '../services/project-manager.js'
import * as im from '../services/idea-manager.js'
import * as jq from '../services/job-queue.js'
import * as store from '../services/upload-store.js'
import {
  describeYouTubeCredential,
  resolveYouTubeAccountId,
  resolveYouTubeAccountIdForChannel,
  resolveYouTubeCredential,
} from '../services/youtube-credential.js'
import {
  disconnectYouTubeChannel,
  readYouTubeChannelTokensForServer,
  readYouTubeConnectionRegistry,
} from '../services/youtube-connection-store.js'
import { computeEpisodeStatus, hasFinalVideoFast, getFinalVideoBytes } from '../services/asset-status.js'
import { readSidecar, readSidecarRaw, readSidecarStrict } from '../services/upload-sidecar.js'
import { listUploadThumbnails, resolveUploadMetadata, snippetFromMeta } from '../lib/upload-metadata.js'
import * as plans from '../services/upload-plans.js'
import * as uq from '../services/upload-queue.js'
import * as reconciler from '../services/upload-reconciler.js'
import * as playlistsSvc from '../services/upload-playlists.js'
import * as orphans from '../services/upload-orphans.js'
import * as renumberUndo from '../services/upload-renumber-undo.js'
import { updateVideoMetadata, createPlaylist, listVideoStatuses, listVideoSnippetStatus } from '../lib/youtube-client.js'
import { getYoutubeDefaults } from '../services/app-settings.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'
import { previewThumbnailRefresh } from '../generators/youtube-thumbnail-refresh.js'
import { fetchYouTubeChannelAvatar } from '../lib/youtube-channel-avatar.js'
import { listYouTubeOperations } from '../services/youtube-operation-store.js'
import { readYouTubeProjectPublishingState } from '../services/youtube-project-publishing-store.js'

async function readAssignedYouTubeTokens(slug: string, requestedAccountId?: string) {
  const credential = await resolveYouTubeCredential(slug)
  if (!credential || (requestedAccountId && requestedAccountId !== credential.accountId)) return null
  return readYouTubeChannelTokensForServer(credential.channelId)
}

async function resolveRequestedYouTubeAccountId(slug: string, raw: unknown): Promise<string> {
  const requested = typeof raw === 'string' && raw.trim() ? raw.trim() : undefined
  return resolveYouTubeAccountId(slug, requested)
}
import type { JobType } from '../models/types.js'

export const router = Router()

// ── Playlists (A4 + A5) ───────────────────────────────────────────────────
//
// List is cached 60s per account to avoid burning quota on repeated page
// loads. `?force=1` bypasses the cache — used after a create. Default
// playlist per account is stored in config.

router.get('/projects/:slug/upload/playlists', async (req, res) => {
  try {
    const slug = req.params.slug
    const accountId = await resolveRequestedYouTubeAccountId(slug, req.query.account_id)
    if (!accountId) return res.status(400).json({ detail: 'No YouTube account connected.' })
    const force = req.query.force === '1' || req.query.force === 'true'
    const playlists = await playlistsSvc.getPlaylists(slug, accountId, force)
    const defaultPlaylistId = await playlistsSvc.getDefaultPlaylist(slug, accountId)
    res.json({ account_id: accountId, playlists, default_playlist_id: defaultPlaylistId })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to list playlists'))
  }
})

router.post('/projects/:slug/upload/playlists', async (req, res) => {
  try {
    const slug = req.params.slug
    const accountId = await resolveRequestedYouTubeAccountId(slug, req.body?.account_id)
    if (!accountId) return res.status(400).json({ detail: 'No YouTube account connected.' })
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : ''
    if (!title) return res.status(400).json({ detail: 'title required' })
    const description = typeof req.body?.description === 'string' ? req.body.description : ''
    const privacyStatus = (req.body?.privacyStatus === 'public' || req.body?.privacyStatus === 'unlisted')
      ? req.body.privacyStatus
      : 'private'
    const playlist = await createPlaylist({ slug, accountId, title, description, privacyStatus })
    playlistsSvc.invalidatePlaylistCache(slug, accountId)
    res.status(201).json({ playlist })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to create playlist'))
  }
})

router.put('/projects/:slug/upload/playlists/default', async (req, res) => {
  try {
    const slug = req.params.slug
    const accountId = await resolveRequestedYouTubeAccountId(slug, req.body?.account_id)
    if (!accountId) return res.status(400).json({ detail: 'No YouTube account connected.' })
    // Empty string clears the default. Otherwise accept any non-empty string
    // (we don't validate against listPlaylists here since that would burn a
    // quota unit on every set).
    const playlistId = typeof req.body?.playlist_id === 'string' ? req.body.playlist_id : ''
    await playlistsSvc.setDefaultPlaylist(slug, accountId, playlistId)
    res.json({ ok: true, account_id: accountId, playlist_id: playlistId })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to set default playlist'))
  }
})

// ── Analytics ─────────────────────────────────────────────────────────────
// Per-channel YouTube Analytics rollup for the connected account. Closes
// the open-loop "fire and forget" upload flow by surfacing per-episode
// performance + a "what worked" feed for the Ideas + Metadata generators.
//
// Requires the `yt-analytics.readonly` OAuth scope. Accounts connected
// before that scope was added need a re-auth pass — the route returns
// 403 with `reauth_required: true` so the frontend can show a CTA.

router.get('/projects/:slug/upload/analytics', async (req, res) => {
  try {
    const slug = req.params.slug
    const accountId = await resolveRequestedYouTubeAccountId(slug, req.query.account_id)
    if (!accountId) {
      return res.status(400).json({ detail: 'No YouTube channel is assigned. Connect or select one in Settings → YouTube.' })
    }
    const tokens = await readAssignedYouTubeTokens(slug, accountId)
    if (!tokens) {
      return res.status(404).json({ detail: 'No tokens for this account — reconnect YouTube.' })
    }
    const { tokenHasAnalyticsScope } = await import('../lib/youtube-oauth.js')
    if (!tokenHasAnalyticsScope(tokens.scope)) {
      return res.status(403).json({
        detail: 'This YouTube account is missing the analytics scope. Reconnect to grant access.',
        reauth_required: true,
      })
    }

    const startDate = (req.query.start_date as string) || undefined
    const endDate = (req.query.end_date as string) || undefined
    const maxResults = req.query.max_results
      ? Math.min(Math.max(parseInt(String(req.query.max_results), 10) || 50, 1), 200)
      : undefined
    const force = req.query.force === '1' || req.query.force === 'true'

    const { getEpisodeAnalyticsCached } = await import('../lib/youtube-analytics.js')
    const result = await getEpisodeAnalyticsCached(slug, accountId, { startDate, endDate, maxResults, force })
    res.json(result)
  } catch (e: any) {
    const status = typeof e?.statusCode === 'number' ? e.statusCode : 500
    res.status(status).json(humanizeBackendError(e, 'Failed to load analytics'))
  }
})

// ── Comments inbox + reply assistant ──────────────────────────────────────
// List comment threads on an uploaded video, draft LLM reply candidates,
// and post the chosen reply. No new OAuth scope — the existing `youtube`
// scope covers commentThreads.list + comments.insert.

router.get('/projects/:slug/upload/comments', async (req, res) => {
  try {
    const slug = req.params.slug
    const accountId = await resolveRequestedYouTubeAccountId(slug, req.query.account_id)
    if (!accountId) return res.status(400).json({ detail: 'No YouTube account connected.' })
    const tokens = await readAssignedYouTubeTokens(slug, accountId)
    if (!tokens) return res.status(404).json({ detail: 'No tokens for this account — reconnect YouTube.' })
    const videoId = String(req.query.video_id || '').trim()
    if (!videoId) return res.status(400).json({ detail: 'video_id query param is required' })
    const order = (req.query.order === 'relevance' ? 'relevance' : 'time') as 'time' | 'relevance'
    const maxResults = req.query.max_results
      ? Math.min(Math.max(parseInt(String(req.query.max_results), 10) || 50, 1), 100)
      : undefined

    const { listVideoCommentThreads } = await import('../lib/youtube-comments.js')
    const result = await listVideoCommentThreads(slug, accountId, videoId, { order, maxResults })
    res.json(result)
  } catch (e: any) {
    const status = typeof e?.statusCode === 'number' ? e.statusCode : 500
    res.status(status).json(humanizeBackendError(e, 'Failed to load comments'))
  }
})

router.post('/projects/:slug/upload/comments/reply', async (req, res) => {
  try {
    const slug = req.params.slug
    const accountId = await resolveRequestedYouTubeAccountId(slug, req.body?.account_id)
    if (!accountId) return res.status(400).json({ detail: 'No YouTube account connected.' })
    const tokens = await readAssignedYouTubeTokens(slug, accountId)
    if (!tokens) return res.status(404).json({ detail: 'No tokens for this account — reconnect YouTube.' })

    const parentCommentId = String(req.body?.parent_comment_id || '').trim()
    const text = String(req.body?.text || '')
    if (!parentCommentId) return res.status(400).json({ detail: 'parent_comment_id is required' })
    if (!text.trim()) return res.status(400).json({ detail: 'text is required' })

    const { postCommentReply } = await import('../lib/youtube-comments.js')
    const reply = await postCommentReply(slug, accountId, parentCommentId, text)
    res.json({ ok: true, reply })
  } catch (e: any) {
    const status = typeof e?.statusCode === 'number' ? e.statusCode : 500
    res.status(status).json(humanizeBackendError(e, 'Failed to post reply'))
  }
})

// ── Upload mode (apply-plan vs private-first) ─────────────────────────────
// Per-project, per-platform. Private-first means the upload job ignores
// publishAt entirely — user schedules in YouTube Studio after upload.

router.get('/projects/:slug/upload/mode', async (req, res) => {
  try {
    const slug = req.params.slug
    const youtube = await store.getUploadMode(slug, 'youtube')
    res.json({ youtube })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to read upload mode'))
  }
})

router.put('/projects/:slug/upload/mode', async (req, res) => {
  try {
    const slug = req.params.slug
    const platform = readPlatform(req.body?.platform) || 'youtube'
    const mode = req.body?.mode
    if (mode !== 'apply-plan' && mode !== 'private') {
      return res.status(400).json({ detail: 'mode must be "apply-plan" or "private"' })
    }
    await store.setUploadMode(slug, platform, mode)
    res.json({ ok: true, mode })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to set upload mode'))
  }
})

// ── Platforms catalogue ───────────────────────────────────────────────────

router.get('/projects/:slug/upload/platforms', async (req, res) => {
  res.json({
    platforms: [
      { id: 'youtube', label: 'YouTube', enabled: true, requires_oauth_client: true },
      { id: 'tiktok', label: 'TikTok', enabled: false, requires_oauth_client: true, coming_soon: 'TikTok Content Posting API integration is planned for v2.' },
      { id: 'facebook', label: 'Facebook Pages', enabled: false, requires_oauth_client: true, coming_soon: 'Facebook page upload integration is planned for v2.' },
    ],
  })
})

// Connection setup moved to the one app-level Settings → YouTube surface.
// Keep these former project routes as explicit tombstones so stale clients do
// not create an unassigned global grant or mutate the shared application.

function retiredProjectOAuth(_req: import('express').Request, res: import('express').Response): void {
  res.status(410).json({ detail: 'Manage the YouTube application, channel connection, and project assignment in Settings → YouTube.' })
}

router.get('/projects/:slug/upload/oauth-client', async (req, res) => {
  retiredProjectOAuth(req, res)
})

router.put('/projects/:slug/upload/oauth-client', async (req, res) => {
  retiredProjectOAuth(req, res)
})

router.delete('/projects/:slug/upload/oauth-client', async (req, res) => {
  retiredProjectOAuth(req, res)
})

// ── OAuth flow ────────────────────────────────────────────────────────────

router.post('/projects/:slug/upload/oauth/start', async (req, res) => {
  retiredProjectOAuth(req, res)
})

router.get('/projects/:slug/upload/oauth/status', async (req, res) => {
  retiredProjectOAuth(req, res)
})

// ── Connected accounts ────────────────────────────────────────────────────

router.get('/projects/:slug/upload/accounts', async (req, res) => {
  try {
    const slug = req.params.slug
    const accounts = await store.listAllAccounts(slug)
    accounts.youtube = []
    const defaults: Record<string, string> = {}
    for (const p of store.UPLOAD_PLATFORMS) {
      defaults[p] = p === 'youtube' ? await resolveYouTubeAccountId(slug) : await store.getDefaultAccountId(slug, p)
    }
    const credential = await resolveYouTubeCredential(slug)
    if (credential) {
      const channel = (await readYouTubeConnectionRegistry()).channels[credential.channelId]
      if (channel) accounts.youtube = [{
        id: credential.accountId,
        platform: 'youtube',
        label: channel.title,
        remote_id: channel.channel_id,
        remote_title: channel.title,
        custom_url: channel.handle,
        thumbnail_url: channel.thumbnail_url,
        connected_at: channel.connected_at,
      }]
    }
    res.json({ accounts, defaults })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to list accounts'))
  }
})

router.get('/projects/:slug/upload/accounts/:id/avatar', async (req, res) => {
  try {
    const credential = await resolveYouTubeCredential(req.params.slug)
    const channel = credential && credential.accountId === req.params.id
      ? (await readYouTubeConnectionRegistry()).channels[credential.channelId]
      : null
    const account = channel ? { thumbnail_url: channel.thumbnail_url } : null
    if (!account) return res.status(404).json({ detail: 'YouTube account not found.' })
    if (!account.thumbnail_url) return res.status(404).json({ detail: 'This YouTube channel has no icon.' })

    const avatar = await fetchYouTubeChannelAvatar(account.thumbnail_url)
    res.setHeader('Content-Type', avatar.contentType)
    res.setHeader('Content-Length', String(avatar.bytes.length))
    res.setHeader('Cache-Control', 'private, max-age=3600, stale-while-revalidate=86400')
    res.send(avatar.bytes)
  } catch (e: any) {
    res.status(502).json(humanizeBackendError(e, 'Failed to load YouTube channel icon'))
  }
})

router.put('/projects/:slug/upload/accounts/:id/default', async (req, res) => {
  try {
    const slug = req.params.slug
    const platform = readPlatform(req.body?.platform)
    if (!platform) return res.status(400).json({ detail: 'platform required' })
    if (platform === 'youtube') {
      const credential = await resolveYouTubeCredential(slug)
      if (!credential || credential.accountId !== req.params.id) {
        return res.status(409).json({ detail: 'Choose the project channel in Settings → YouTube.' })
      }
    } else {
      await store.setDefaultAccountId(slug, platform, req.params.id)
    }
    res.json({ ok: true })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to set default account'))
  }
})

router.delete('/projects/:slug/upload/accounts/:id', async (req, res) => {
  try {
    const slug = req.params.slug
    const platform = readPlatform(req.query.platform)
    if (!platform) return res.status(400).json({ detail: 'platform query param required' })
    if (platform === 'youtube') {
      const credential = await resolveYouTubeCredential(slug)
      if (!credential || credential.accountId !== req.params.id) return res.status(404).json({ detail: 'Account not found' })
      await disconnectYouTubeChannel({ channel_id: credential.channelId })
    } else {
      const removed = await store.removeAccount(slug, platform, req.params.id)
      if (!removed) return res.status(404).json({ detail: 'Account not found' })
    }
    res.json({ ok: true })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to remove account'))
  }
})

// ── Queue view (read-only source of truth for the UI) ────────────────────
// An item is any episode that has a `video_assembly` asset on disk. Phase 4
// adds a second source (project-level Upload Queue/ for non-episode items);
// this endpoint will grow a merge-and-sort step at that point.

// Two-stage queue loading. The slow part is metadata + thumbnail
// resolution per episode (each touches the file system multiple times);
// for a 300+ episode project a full scan can take 30-60 seconds on the
// first call. Splitting it lets us:
//   1. Build a CHEAP "index" of every queue item (just enough to filter
//      + sort + paginate). Cached for 5 minutes.
//   2. Enrich ONLY the visible page with the expensive metadata preview.
// First-load wait drops from ~all-episodes to ~one-page-of-episodes.
//
// The index cache is busted on: legacy-uploaded flag changes (we already
// do this), explicit ?nocache=1, and after a successful upload completes
// (the upload generator should call invalidateQueueCache; future polish).
//
// The actual cache map + TTL constant live in `services/upload-caches.ts`
// so non-upload code paths (e.g. idea remove / dismiss in routes/ideas.ts)
// can invalidate them without circular-importing this router file. See
// `invalidateProjectUploadCaches` in that module.
type QueueIndexItem = {
  id: string
  type: 'episode' | 'import'
  episode_code: string
  filename?: string
  title: string                 // best-effort: idea title or filename, no metadata read
  uploaded: boolean
  // True when a final-video file is present on disk (project tree OR external
  // root). Lets the UI distinguish "uploaded with local copy still" (safe to
  // re-render / re-upload) from "uploaded, local cleaned up" (older private
  // videos the user no longer wants targeted by bulk actions).
  has_local_final: boolean
  /**
   * Tombstone marker mirrored from the sidecar. When set, the upstream
   * video is gone (takedown / manual deletion / user-marked) and this
   * row gets its own filter chip ("Deleted upstream") so it stays out
   * of bulk-upload defaults instead of looking healthy.
   */
  deleted_at: string | null
  video_id: string
  scheduled_for: string | null
  schedule_source: 'synced' | 'planned' | 'none'
  position: number | null
  // Item E: "uploaded elsewhere" marker + optional annotations. Set when
  // the episode appears in `youtube_legacy_uploaded` (boolean flag) and,
  // optionally, in `youtube_legacy_uploaded_meta` (URL / note). The flag
  // alone keeps the row out of upload defaults; the meta drives the
  // 🔗 External pill renderer.
  legacy_uploaded: boolean
  legacy_external_url: string
  legacy_note: string
  // Carried into stage 2 — saves re-reading the sidecar.
  _sidecar: any
  _ideaTitle: string
}
// Re-exported from upload-caches.ts so existing references in this file
// stay working without a sweeping rename. The `as` cast bridges the
// type-erased `unknown[]` storage in the cache module.
import {
  queueIndexCache as _queueIndexCache,
  queueCacheKey as _queueCacheKey,
  QUEUE_INDEX_TTL_MS,
  missingVideoCache as _missingVideoCache,
  MISSING_VIDEO_TTL_MS,
} from '../services/upload-caches.js'
const queueIndexCache = _queueIndexCache as unknown as Map<string, { ts: number; items: QueueIndexItem[] }>
const queueCacheKey = _queueCacheKey
const missingVideoCache = _missingVideoCache

// Stage 1: the cheap index. Reads the per-episode sidecar (one small
// JSON file each) but skips computeEpisodeStatus + resolveUploadMetadata.
// Episode-has-video is determined cheaply by checking if any video file
// path exists for the episode (still file-IO, but a single existsSync per
// episode rather than the full status walk).
async function buildQueueIndex(slug: string, platform: store.UploadPlatform): Promise<QueueIndexItem[]> {
  const ideas = await im.getIdeas(slug, 'accepted')
  const sequence = await uq.readSequence(slug)
  // Item E: "uploaded elsewhere" — read once up front so per-row checks
  // are cheap (and so we know which non-queueable episodes still need
  // synthetic rows for the 🔗 External pill).
  const cfg = (await pm.getConfig(slug) as any) || {}
  const legacyFlag: Record<string, boolean> = (cfg.youtube_legacy_uploaded || {})
  const legacyMeta: Record<string, { external_url?: string; note?: string }>
    = (cfg.youtube_legacy_uploaded_meta || {})
  // Item I-eager: per-item scheduled_for now lives in each episode's
  // sidecar (planning stubs cover the not-yet-uploaded case). The
  // legacy `upload_item_schedule` map only carries `import:*` keys
  // post-migration, so we read it once just for the imports branch.
  const legacySchedule = (cfg.upload_item_schedule && typeof cfg.upload_item_schedule === 'object')
    ? cfg.upload_item_schedule as Record<string, string>
    : {}
  const items: QueueIndexItem[] = []
  const CONCURRENCY = 32     // bumped from 8 — most ops are file existence checks
  const queue = ideas.filter(i => i.episode_code)
  let cursor = 0
  async function worker() {
    while (cursor < queue.length) {
      const i = cursor++
      const idea = queue[i]
      if (!idea?.episode_code) continue
      const code = idea.episode_code
      // Fast video-presence check (single readdir of episode/video/) +
      // sidecar in parallel. We use `readSidecarRaw` so planning-only
      // stubs (no video_id, just `scheduled_for`) come through too —
      // that's how the queue surfaces "scheduled but not yet uploaded"
      // rows after item I-eager moved schedule data into the sidecar.
      const [hasFinal, rawSidecar] = await Promise.all([
        hasFinalVideoFast(slug, code, idea.title || ''),
        readSidecarRaw(slug, code, idea.title || '', platform),
      ])
      // Strip planning stubs out of the "is this uploaded?" view so
      // downstream consumers (enrichPage, the chip-stack template)
      // keep using the same semantics as before — uploaded sidecars
      // carry video_id; planning stubs carry an empty string.
      const sidecar = rawSidecar?.video_id ? rawSidecar : null
      const isLegacy = !!legacyFlag[code]
      // Legacy-uploaded items get a synthetic queue row even with no local
      // final + no sidecar, so the user can see what they marked + the
      // 🔗 External pill. Without this they'd vanish from the UI after
      // marking and the only revert path would be config-file editing.
      const inQueue = hasFinal || !!sidecar?.video_id || isLegacy
      if (!inQueue) continue
      // scheduled_for + schedule_source: pull from rawSidecar so
      // planning stubs (video_id='') still surface their schedule.
      // 'synced' = post-upload sidecar with publishAt mirrored from
      // YouTube; 'planned' = pre-upload stub the user wrote via plans
      // or per-row edit; 'none' = neither.
      const scheduled_for = rawSidecar?.scheduled_for || null
      const schedule_source: 'synced' | 'planned' | 'none' = rawSidecar?.video_id
        ? (rawSidecar.scheduled_for ? 'synced' : 'none')
        : (rawSidecar?.scheduled_for ? 'planned' : 'none')
      const meta = legacyMeta[code] || {}
      items.push({
        id: `ep:${code}`,
        type: 'episode',
        episode_code: code,
        title: idea.title || code,    // cheap title; enriched in stage 2
        uploaded: !!sidecar?.video_id,
        has_local_final: hasFinal,
        deleted_at: sidecar?.deleted_at || null,
        video_id: sidecar?.video_id || '',
        scheduled_for,
        schedule_source,
        position: typeof sequence[`ep:${code}`] === 'number' ? sequence[`ep:${code}`] : null,
        legacy_uploaded: isLegacy,
        legacy_external_url: meta.external_url || '',
        legacy_note: meta.note || '',
        _sidecar: sidecar,
        _ideaTitle: idea.title || '',
      })
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker))

  // Imports — small in number, cheap to enrich. Add to the index.
  try {
    const scan = await uq.scanImports(slug)
    for (const d of scan.discovered) {
      const meta = await uq.readImportMeta(d.file_path)
      items.push({
        id: d.id,
        type: 'import',
        episode_code: '',
        filename: d.filename,
        title: meta?.title || d.title,
        uploaded: false,
        // Imports always represent a file the user dropped into the imports
        // folder, so by definition they have a local file backing them.
        has_local_final: true,
        deleted_at: null,
        video_id: '',
        scheduled_for: legacySchedule[d.id] || null,
        schedule_source: legacySchedule[d.id] ? 'planned' : 'none',
        position: d.position,
        legacy_uploaded: false,
        legacy_external_url: '',
        legacy_note: '',
        _sidecar: null,
        _ideaTitle: '',
      })
    }
  } catch { /* non-fatal */ }

  // Default ordering: explicit position first, then natural episode_code.
  items.sort((a, b) => {
    const ap = a.position, bp = b.position
    if (typeof ap === 'number' && typeof bp === 'number') return ap - bp
    if (typeof ap === 'number') return -1
    if (typeof bp === 'number') return 1
    return (a.episode_code || '').localeCompare(b.episode_code || '', undefined, { numeric: true })
  })
  return items
}

// Stage 2: enrich just the page slice with metadata preview + thumbnail.
// Each enrichment is the same expensive resolveUploadMetadata call from
// before — but we run it for ~10 items instead of ~300.
async function enrichPage(slug: string, platform: store.UploadPlatform, page: QueueIndexItem[]): Promise<any[]> {
  const out = await Promise.all(page.map(async (item): Promise<any> => {
    let metaPreview = {
      title: item._ideaTitle || item.title || item.episode_code,
      description: '',
      tags: [] as string[],
      thumbnailPath: '',
    }
    let finalVideoBytes: number | undefined
    if (item.type === 'episode') {
      // Run the metadata preview and the final-video stat in parallel —
      // both hit disk; doing them serially adds ~10ms per row. Stat is
      // cheap enough to do on every visible row (page size ≤100).
      const [meta, bytes] = await Promise.all([
        resolveUploadMetadata({
          slug,
          episode_code: item.episode_code,
          fallback_title: item._ideaTitle,
          platform,
        }).catch(() => null),
        getFinalVideoBytes(slug, item.episode_code, item._ideaTitle || item.title || ''),
      ])
      if (meta) metaPreview = meta
      finalVideoBytes = bytes
    }
    const sidecar = item._sidecar
    return {
      id: item.id,
      type: item.type,
      episode_code: item.episode_code,
      filename: item.filename || undefined,
      title: metaPreview.title || item._ideaTitle || item.episode_code,
      has_metadata: !!(metaPreview.title && metaPreview.description),
      has_thumbnail: !!metaPreview.thumbnailPath,
      uploaded: item.uploaded,
      has_local_final: item.has_local_final,
      deleted_at: item.deleted_at,
      deleted_reason: sidecar?.deleted_reason || null,
      video_id: item.video_id,
      video_url: item.video_id ? `https://youtu.be/${item.video_id}` : '',
      privacy_status: sidecar?.privacy_status || null,
      scheduled_for: item.scheduled_for,
      schedule_source: item.schedule_source,
      last_sync_at: sidecar?.last_sync_at || '',
      account_id: sidecar?.account_id || '',
      position: item.position,
      final_video_bytes: finalVideoBytes,
      // Item E — surface the legacy-uploaded marker + annotations so the
      // row can render the 🔗 External pill. Empty strings when unset
      // (frontend treats falsy as "no pill").
      legacy_uploaded: item.legacy_uploaded,
      legacy_external_url: item.legacy_external_url,
      legacy_note: item.legacy_note,
    }
  }))
  return out
}

// Filter buckets (matches the frontend toolbar). 'failed' isn't tracked
// per-item today — we only know if there's an active failed job, which
// the frontend handles. So the backend filter for 'failed' returns []
// (the frontend can derive its own from job state).
// Legacy single-value tokens still accepted for back-compat (older clients
// or saved bookmarks). The frontend now sends a comma-separated multi-token
// string built from the four mutually-exclusive state chips below + a
// `scheduled` overlay chip that AND-filters on top.
type QueueFilterLegacy = 'all' | 'not_uploaded' | 'uploaded' | 'scheduled' | 'failed'
// Mutually-exclusive state buckets. A row matches at most one. Empty list =
// don't apply a state filter (i.e. include all rows).
//
// `deleted_upstream` covers rows whose sidecar carries a `deleted_at`
// tombstone — added so takedowns / manual deletions don't pretend to
// still be healthy uploads. Off by default in the chip strip; turning it
// on lets the user audit/sweep without mixing them into routine bulk runs.
type QueueStateToken = 'ready' | 'uploaded_local' | 'uploaded_freed' | 'deleted_upstream' | 'imports'
// Overlay tokens — applied as additional AND filters on top of the state
// union.
//
// `scheduled`            — has `scheduled_for` set
// `public` (v1.0.46)     — sidecar carries `privacy_status: 'public'`. The
//                          row is live on YouTube; bulk reschedule paths
//                          should leave these alone.
// `not_public` (v1.0.46) — anything that isn't public yet (private,
//                          unlisted, or no sidecar). Mutually exclusive
//                          with `public` — the chip strip enforces that
//                          on the frontend; the backend just AND's
//                          whatever the client sends so a malformed
//                          request returns an empty list rather than
//                          surprising results.
type QueueOverlayToken = 'scheduled' | 'public' | 'not_public'
type QueueSort = 'code_asc' | 'code_desc' | 'scheduled_asc' | 'unscheduled_first'

interface ParsedFilter {
  states: Set<QueueStateToken>
  overlays: Set<QueueOverlayToken>
  /** true = include all rows by state (no state filter applied) */
  allStates: boolean
}

function parseFilterParam(raw: string): ParsedFilter {
  const tokens = raw.split(',').map(s => s.trim()).filter(Boolean)
  const states = new Set<QueueStateToken>()
  const overlays = new Set<QueueOverlayToken>()
  let allStates = false
  for (const t of tokens) {
    // Legacy aliases first — keep old bookmarks + URL-shared filter strings
    // working without forcing a migration.
    if (t === 'all') { allStates = true; continue }
    if (t === 'not_uploaded') { states.add('ready'); states.add('imports'); continue }
    if (t === 'uploaded') { states.add('uploaded_local'); states.add('uploaded_freed'); continue }
    if (t === 'failed') continue   // never matched anything at this layer anyway
    // New tokens.
    if (t === 'ready' || t === 'uploaded_local' || t === 'uploaded_freed' || t === 'deleted_upstream' || t === 'imports') {
      states.add(t as QueueStateToken)
      continue
    }
    if (t === 'scheduled') { overlays.add('scheduled'); continue }
    if (t === 'public' || t === 'not_public') {
      overlays.add(t as QueueOverlayToken)
      continue
    }
  }
  // No state tokens AND no `all` → treat as "all". Avoids the user seeing an
  // empty list when only an overlay chip (Scheduled) is active.
  if (states.size === 0 && !allStates) allStates = true
  return { states, overlays, allStates }
}

function matchesFilter(item: QueueIndexItem, parsed: ParsedFilter): boolean {
  // State match — `deleted_upstream` shadows the upload buckets so a
  // tombstoned row only matches when the user explicitly asks for it
  // (otherwise it would also match `uploaded_local` / `uploaded_freed`
  // and blend into routine bulk-action defaults, which is exactly the
  // behaviour the tombstone is fixing).
  if (!parsed.allStates) {
    let stateOk = false
    if (item.type === 'import') {
      stateOk = parsed.states.has('imports')
    } else if (item.deleted_at) {
      stateOk = parsed.states.has('deleted_upstream')
    } else if (item.uploaded && item.has_local_final) {
      stateOk = parsed.states.has('uploaded_local')
    } else if (item.uploaded && !item.has_local_final) {
      stateOk = parsed.states.has('uploaded_freed')
    } else if (!item.uploaded && item.has_local_final) {
      stateOk = parsed.states.has('ready')
    }
    if (!stateOk) return false
  }
  // Overlay AND-filters
  if (parsed.overlays.has('scheduled') && !item.scheduled_for) return false
  // v1.0.46 privacy overlays — `public` matches only sidecar-confirmed
  // public videos; `not_public` is its complement (no sidecar / not-yet-
  // uploaded counts as not-public). The two chips are mutually exclusive
  // in the UI; if a client sends both we AND them and naturally produce
  // an empty list — defensible since "public AND not_public" is a
  // degenerate query.
  if (parsed.overlays.has('public')) {
    const privacy = item._sidecar?.privacy_status
    if (privacy !== 'public') return false
  }
  if (parsed.overlays.has('not_public')) {
    const privacy = item._sidecar?.privacy_status
    if (privacy === 'public') return false
  }
  return true
}

export interface QueueStateCounts {
  ready: number
  uploaded_local: number
  uploaded_freed: number
  deleted_upstream: number
  imports: number
  all: number
}

/**
 * v1.0.390 — per-state row counts over the FULL index (independent of the
 * active filter / page), so the Upload Queue's "Quick views" buttons can show
 * absolute totals per intent ("Ready to upload (12)"). The state branches MUST
 * mirror matchesFilter() above so the count next to a chip equals what
 * selecting that chip actually shows.
 */
export function queueStateCounts(index: QueueIndexItem[]): QueueStateCounts {
  const counts: QueueStateCounts = {
    ready: 0, uploaded_local: 0, uploaded_freed: 0, deleted_upstream: 0, imports: 0, all: index.length,
  }
  for (const it of index) {
    if (it.type === 'import') counts.imports++
    else if (it.deleted_at) counts.deleted_upstream++
    else if (it.uploaded && it.has_local_final) counts.uploaded_local++
    else if (it.uploaded && !it.has_local_final) counts.uploaded_freed++
    else if (!it.uploaded && it.has_local_final) counts.ready++
  }
  return counts
}

function filterAndSortIndex(
  items: QueueIndexItem[],
  filterRaw: string,
  sort: QueueSort,
  q?: string,
): QueueIndexItem[] {
  const parsed = parseFilterParam(filterRaw)
  let out: QueueIndexItem[] = items.filter(i => matchesFilter(i, parsed))
  // Substring search across the fields a user is most likely to type:
  // episode_code (e.g. "TN0143"), title (the human label they remember),
  // and filename (for import rows that don't have an episode_code).
  // Case-insensitive; trimmed; no-op when blank so existing call sites
  // that don't pass `q` keep their semantics.
  const qNorm = (q || '').trim().toLowerCase()
  if (qNorm) {
    out = out.filter(i =>
      (i.episode_code || '').toLowerCase().includes(qNorm) ||
      (i.title || '').toLowerCase().includes(qNorm) ||
      (i.filename || '').toLowerCase().includes(qNorm)
    )
  }
  out = out.slice()
  const cmpCode = (a: QueueIndexItem, b: QueueIndexItem) =>
    (a.episode_code || a.filename || '').localeCompare(b.episode_code || b.filename || '', undefined, { numeric: true })
  const cmpScheduled = (a: QueueIndexItem, b: QueueIndexItem) => {
    const av = a.scheduled_for || ''
    const bv = b.scheduled_for || ''
    if (av && !bv) return -1
    if (!av && bv) return 1
    return av.localeCompare(bv)
  }
  switch (sort) {
    case 'code_asc':       out.sort(cmpCode); break
    case 'code_desc':      out.sort((a, b) => cmpCode(b, a)); break
    case 'scheduled_asc':  out.sort(cmpScheduled); break
    case 'unscheduled_first':
      // Surfaces "ready to schedule" rows so apply-plan is one click
      // away. Unscheduled rows come first (sorted by code asc); then
      // scheduled rows (sorted by scheduled_for asc) so the user can
      // see the existing queue tail right below.
      out.sort((a, b) => {
        const aHas = !!a.scheduled_for
        const bHas = !!b.scheduled_for
        if (aHas !== bHas) return aHas ? 1 : -1
        return aHas ? cmpScheduled(a, b) : cmpCode(a, b)
      })
      break
  }
  return out
}

router.get('/projects/:slug/upload/queue', async (req, res) => {
  try {
    const slug = req.params.slug
    const platform = readPlatform(req.query.platform) || 'youtube'

    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1)
    const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.page_size || '10'), 10) || 10))
    // `filter` is now a comma-separated multi-token string (e.g.
    // `ready,uploaded_local,scheduled`). Legacy single-value tokens (`all`,
    // `not_uploaded`, `uploaded`, `scheduled`, `failed`) still parse via the
    // alias map — see parseFilterParam.
    const filter = String(req.query.filter || 'all')
    const sort = (String(req.query.sort || 'code_asc') as QueueSort)
    // Free-text search — matches against episode_code, title, filename.
    // Empty / whitespace = disabled. See filterAndSortIndex for the
    // exact match semantics.
    const q = typeof req.query.q === 'string' ? req.query.q : ''
    // Item 10 — when present, restricts the queue to a specific list of
    // episode_codes regardless of filter/page. Lets the frontend show a
    // "View selected" view that pulls only-the-selected rows into a single
    // page with full enrichment, even if those rows are spread across
    // many pages of the underlying paginated view. Comma-separated.
    const codesFilterRaw = typeof req.query.episode_codes === 'string' ? req.query.episode_codes : ''
    const codesFilter = codesFilterRaw
      ? new Set(codesFilterRaw.split(',').map(s => s.trim()).filter(Boolean))
      : null
    const noCache = req.query.nocache === '1' || req.query.nocache === 'true'
    // Lightweight mode for "select all across all pages" / "all unuploaded" /
    // "next N" scope pickers in the Plans tab. Skips the expensive per-row
    // metadata enrichment and pagination — returns just the ordered list of
    // episode codes for the requested filter+sort. The cache key + builder
    // are shared with the paginated read, so back-to-back calls don't re-scan.
    const idsOnly = req.query.ids_only === '1' || req.query.ids_only === 'true'

    const ckey = queueCacheKey(slug, platform)
    const now = Date.now()
    let index: QueueIndexItem[] | null = null
    let cacheHit = false
    if (!noCache) {
      const hit = queueIndexCache.get(ckey)
      if (hit && now - hit.ts < QUEUE_INDEX_TTL_MS) {
        index = hit.items
        cacheHit = true
      }
    }
    if (!index) {
      index = await buildQueueIndex(slug, platform)
      queueIndexCache.set(ckey, { ts: now, items: index })
    }

    let filtered = filterAndSortIndex(index, filter, sort, q)
    // Item 10 — episode_codes[] post-filter, applied AFTER the chip filter
    // so the user's "show me my selection" view honours both the filter
    // chips (in case they want to combine) AND the explicit list. When
    // codesFilter is empty, this is a no-op.
    if (codesFilter) {
      filtered = filtered.filter(it => it.episode_code && codesFilter.has(it.episode_code))
    }
    const total = filtered.length

    if (idsOnly) {
      // Episodes only — imports don't carry an episode_code so they can't be
      // targets of scope-picker actions (apply / upload / unapply all key off
      // episode_code in the backend).
      const episode_codes = filtered
        .filter(it => it.type === 'episode' && it.episode_code)
        .map(it => it.episode_code as string)
      return res.json({
        ids_only: true,
        episode_codes,
        total: episode_codes.length,
        total_unfiltered: index.length,
        filter,
        sort,
        cached: cacheHit,
      })
    }

    const totalPages = Math.max(1, Math.ceil(total / pageSize))
    const start = (page - 1) * pageSize
    const pageSlice = filtered.slice(start, start + pageSize)
    // Stage 2: only the visible page pays the metadata-preview cost.
    const items = await enrichPage(slug, platform, pageSlice)

    res.json({
      items,
      total,
      total_unfiltered: index.length,
      counts: queueStateCounts(index),
      page,
      page_size: pageSize,
      total_pages: totalPages,
      filter,
      sort,
      cached: cacheHit,
    })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to load queue'))
  }
})

// The retired per-project preview/upload pair was removed. The confirmed
// /youtube/upload route owns upload preview and enqueueing.

// v1.0.524 — Backfill thumbnails onto already-uploaded videos that are missing
// one (thumbnails.set on the existing video_id; no re-upload). `dry_run:true`
// returns counts only (no quota spend) to preview "will fix N of M". Otherwise
// enqueues a single quota-paced, resumable backfill job per project.
router.post('/projects/:slug/upload/refresh-thumbnails', async (req, res) => {
  try {
    const slug = req.params.slug
    const platform = readPlatform(req.body?.platform) || 'youtube'
    if (platform !== 'youtube') return res.status(400).json({ detail: `${platform} thumbnail backfill is not enabled yet.` })
    const account_id = await resolveRequestedYouTubeAccountId(slug, req.body?.account_id)
    if (!account_id) return res.status(400).json({ detail: 'No YouTube channel is assigned. Connect or select one in Settings → YouTube.' })
    const mode: 'missing' | 'all' = req.body?.mode === 'all' ? 'all' : 'missing'

    if (req.body?.dry_run === true) {
      const preview = await previewThumbnailRefresh(slug, { mode, accountId: account_id, platform: 'youtube' })
      return res.json({ dry_run: true, ...preview })
    }

    if (jq.isDuplicate(slug, '_thumbnail_refresh_', 'youtube_thumbnail_refresh' as JobType)) {
      return res.status(409).json({ detail: 'A thumbnail backfill is already running for this project.' })
    }
    const job = await jq.enqueue({
      project_slug: slug,
      type: 'youtube_thumbnail_refresh' as JobType,
      episode_id: '_thumbnail_refresh_',
      title: `Thumbnail backfill (${mode})`,
      params: { account_id, mode },
    })
    res.status(201).json(job)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to start thumbnail backfill'))
  }
})

// Playlist-only update for an already-uploaded video. Distinct from
// /upload/upload's metadata branch because it has its own quota class
// (50 units vs. 1600+ for an upload), its own job type for queue
// scheduling, and a much narrower failure surface — easier to reason
// about in bulk runs of 20+ rows than overloading the upload endpoint
// with yet another mode flag.
router.post('/projects/:slug/upload/update-playlist', async (req, res) => {
  try {
    const slug = req.params.slug
    const platform = readPlatform(req.body?.platform) || 'youtube'
    if (platform !== 'youtube') return res.status(400).json({ detail: `${platform} playlist update is not enabled yet.` })
    const episode_id: string = typeof req.body?.episode_id === 'string' ? req.body.episode_id : ''
    if (!episode_id) return res.status(400).json({ detail: 'episode_id required' })

    const account_id = await resolveRequestedYouTubeAccountId(slug, req.body?.account_id)
    if (!account_id) {
      return res.status(400).json({ detail: 'No YouTube channel is assigned. Connect or select one in Settings → YouTube.' })
    }

    if (jq.isDuplicate(slug, episode_id, 'youtube_playlist_update' as JobType)) {
      return res.status(409).json({ detail: `Playlist update already queued/running for ${episode_id}` })
    }

    // Same body shape as /upload/upload's playlist override: empty/null
    // means "use project default", `_none_` is a no-op short-circuit
    // handled in the generator. Any other string is a literal playlist id.
    const playlist_id = typeof req.body?.playlist_id === 'string' ? req.body.playlist_id : null

    const job = await jq.enqueue({
      project_slug: slug,
      type: 'youtube_playlist_update' as JobType,
      episode_id,
      title: `YouTube playlist — ${episode_id}`,
      params: { episode_id, account_id, playlist_id },
    })
    res.status(201).json(job)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to queue playlist update'))
  }
})

/**
 * Item J — resolve the project's `category_id` ProjectConfig setting for a
 * `snippetFromMeta` call. Defaults to undefined → snippetFromMeta falls
 * back to '22' ("People & Blogs") for back-compat. Returns undefined on
 * any error so the upload path is never blocked by a missing config.
 */
async function resolveCategoryIdForSlug(slug: string): Promise<number | undefined> {
  try {
    const cfg = await pm.getConfig(slug) as any
    const v = cfg?.category_id
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v
    return undefined
  } catch { return undefined }
}

/**
 * Item J — YouTube videoCategories.list cache.
 *
 * Cache location: `<userData>/youtube-category-cache/<region>.json`
 * Cache TTL: 7 days. Categories essentially never change — the list is a
 * stable enum maintained by YouTube — so a long TTL keeps the cache hit
 * rate ~100% in practice.
 *
 * Read flow:
 *   1. If cache fresh, return it (1 disk read, 0 quota).
 *   2. Otherwise fetch via videoCategories.list (1 quota unit), persist,
 *      return.
 *   3. If the fetch fails AND we have a stale cache on disk, return the
 *      stale entries instead of erroring — soft fallback per the locked
 *      acceptance for this item. The UI dropdown is more useful with
 *      stale-but-readable category names than blocked entirely.
 */
const CATEGORY_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000   // 7 days
function categoryCacheDir(): string {
  return path.join(pm.getUserDataDir(), 'youtube-category-cache')
}
function categoryCachePath(regionCode: string): string {
  // Sanitise region code — YouTube expects ISO 3166-1 alpha-2 (e.g. "US").
  const safe = (regionCode || 'US').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2) || 'US'
  return path.join(categoryCacheDir(), `${safe}.json`)
}
interface CategoryEntry { id: string; title: string }
interface CategoryCache {
  schema_version: 1
  fetched_at: string         // ISO 8601
  region: string
  categories: CategoryEntry[]
}

async function readCategoryCache(regionCode: string): Promise<CategoryCache | null> {
  try {
    const raw = await (await import('fs/promises')).readFile(categoryCachePath(regionCode), 'utf8')
    const parsed = JSON.parse(raw) as CategoryCache
    if (!parsed?.categories || !Array.isArray(parsed.categories)) return null
    return parsed
  } catch { return null }
}
async function writeCategoryCache(regionCode: string, categories: CategoryEntry[]): Promise<void> {
  const fs = await import('fs/promises')
  await fs.mkdir(categoryCacheDir(), { recursive: true }).catch(() => {})
  const payload: CategoryCache = {
    schema_version: 1,
    fetched_at: new Date().toISOString(),
    region: regionCode,
    categories,
  }
  await fs.writeFile(categoryCachePath(regionCode), JSON.stringify(payload, null, 2), 'utf8')
}
function isCategoryCacheFresh(cache: CategoryCache | null): boolean {
  if (!cache) return false
  const age = Date.now() - Date.parse(cache.fetched_at)
  return Number.isFinite(age) && age < CATEGORY_CACHE_TTL_MS
}

async function fetchYouTubeCategories(slug: string, accountId: string, regionCode: string): Promise<CategoryEntry[]> {
  const { fetchWithAuthRetry, youtubeTransport } = await import('../lib/youtube-client.js')
  const url = `https://www.googleapis.com/youtube/v3/videoCategories?part=snippet&regionCode=${encodeURIComponent(regionCode)}`
  const resp = await fetchWithAuthRetry(slug, accountId, async (token) => youtubeTransport(url, {
    headers: { Authorization: `Bearer ${token}` },
  }), 'video_categories_list')
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '')
    throw new Error(`videoCategories.list ${resp.status}: ${txt.slice(0, 200)}`)
  }
  const data = await resp.json() as { items?: Array<{ id?: string; snippet?: { title?: string; assignable?: boolean } }> }
  const out: CategoryEntry[] = []
  for (const item of data.items || []) {
    const id = item.id
    const title = item.snippet?.title
    if (!id || !title) continue
    // Only return assignable categories — YouTube has many legacy /
    // archived categories the API still returns but won't accept on
    // upload (assignable=false). Filter them so the dropdown is honest.
    if (item.snippet?.assignable === false) continue
    out.push({ id, title })
  }
  out.sort((a, b) => Number(a.id) - Number(b.id))
  return out
}

router.get('/projects/:slug/upload/youtube-categories', async (req, res) => {
  try {
    const slug = req.params.slug
    const regionCode = (typeof req.query.region === 'string' && req.query.region) ? req.query.region : 'US'

    const cached = await readCategoryCache(regionCode)
    if (isCategoryCacheFresh(cached)) {
      return res.json({ source: 'cache', region: regionCode, fetched_at: cached!.fetched_at, categories: cached!.categories })
    }

    const accountId = await resolveYouTubeAccountId(slug)
    if (!accountId) {
      // No connected account — return whatever we have (even if stale)
      // so the Settings dropdown still shows category names. If nothing
      // cached either, return empty + a hint instead of erroring.
      if (cached) return res.json({ source: 'stale', region: regionCode, fetched_at: cached.fetched_at, categories: cached.categories, hint: 'No YouTube account connected — showing last cached list.' })
      return res.json({ source: 'empty', region: regionCode, categories: [], hint: 'Connect a YouTube account to fetch the live category list.' })
    }

    try {
      const categories = await fetchYouTubeCategories(slug, accountId, regionCode)
      await writeCategoryCache(regionCode, categories).catch(() => {})
      res.json({ source: 'live', region: regionCode, fetched_at: new Date().toISOString(), categories })
    } catch (e: any) {
      // Item J — soft fallback. If the live fetch fails (network down,
      // token issue, quota exhausted), serve the stale cache when one
      // exists. The user can still pick a category from the last-known
      // list without being blocked by a transient outage.
      if (cached) {
        return res.json({ source: 'stale', region: regionCode, fetched_at: cached.fetched_at, categories: cached.categories, hint: `Live fetch failed: ${e?.message || e}. Showing last cached list.` })
      }
      throw e
    }
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to load YouTube categories'))
  }
})

/**
 * v1.0.77 — Backfill the AI/synthetic-content disclosure flag and the
 * default category onto every previously uploaded YouTube video for this
 * project.
 *
 * Flow:
 *   1. Resolve the project's effective settings (per-project overrides
 *      win over app-level defaults).
 *   2. Walk accepted ideas, read each youtube_upload.json sidecar, collect
 *      live (non-tombstoned) video IDs.
 *   3. videos.list batch-fetch current snippet+status for each id (1 quota
 *      unit per 50 videos) — needed so the PATCH preserves privacy and
 *      publishAt rather than clobbering them.
 *   4. videos.update PATCH each video where the current state differs
 *      from the desired settings. Skip videos that already match.
 *
 * Body: `{ dry_run?: boolean }` — when true, returns the would-update plan
 *       without firing any PATCH calls. Useful for surfacing a confirm
 *       dialog before the user authorises the action.
 *
 * Returns a summary: scanned, eligible, updated, skipped, failed, plus
 * per-video details.
 */
router.post('/projects/:slug/upload/youtube-backfill', async (req, res) => {
  try {
    const slug = req.params.slug

    const dryRun = req.body?.dry_run === true

    // 1. Resolve effective settings (project override → app default).
    const cfg = (await pm.getConfig(slug)) as any
    const appDefaults = await getYoutubeDefaults()
    const effectiveAi: boolean = typeof cfg?.mark_as_ai_generated === 'boolean'
      ? cfg.mark_as_ai_generated
      : appDefaults.default_mark_as_ai_generated
    const effectiveCategoryId: string = (typeof cfg?.category_id === 'number'
      && Number.isFinite(cfg.category_id) && cfg.category_id > 0)
      ? String(cfg.category_id)
      : String(appDefaults.default_yt_category_id)

    const credential = await resolveYouTubeCredential(slug)
    if (!credential) return res.status(400).json({ detail: 'No YouTube channel is assigned to this project.' })
    const accountId = credential.accountId

    // 2. Enumerate the current channel's canonical video identities. A
    // historical sidecar remains a final legacy fallback only.
    const ideas = await im.getIdeas(slug, 'accepted')
    const [operations, publishingState] = await Promise.all([
      listYouTubeOperations(slug),
      readYouTubeProjectPublishingState(slug),
    ])
    const eligible: Array<{ episode_code: string; title: string; video_id: string }> = []
    const seenVideoIds = new Set<string>()
    for (const idea of ideas) {
      if (!idea.episode_code) continue
      const canonical = operations.filter(record => record.episode_code === idea.episode_code
        && record.channel_id === credential.channelId && !!record.video_id?.trim()).at(-1)
      const link = publishingState.episode_video_links[idea.episode_code]
      let videoId = canonical?.video_id?.trim() || ''
      if (!videoId && link?.channel_id === credential.channelId) videoId = link.video_id.trim()
      if (!videoId) {
        const sidecar = await readSidecarStrict(slug, idea.episode_code, 'youtube')
        if (sidecar?.video_id?.trim() && !sidecar.deleted_at
          && sidecar.channel_id === credential.channelId) videoId = sidecar.video_id.trim()
      }
      if (!videoId || seenVideoIds.has(videoId)) continue
      seenVideoIds.add(videoId)
      eligible.push({ episode_code: idea.episode_code, title: idea.title || '', video_id: videoId })
    }

    if (!eligible.length) {
      return res.json({
        scanned: ideas.length,
        eligible: 0,
        updated: 0,
        skipped: 0,
        failed: 0,
        details: [],
        message: 'No previously-uploaded YouTube videos found in this project.',
      })
    }

    // 3. Batch-fetch current state.
    const videoIds = eligible.map(e => e.video_id)
    const live = await listVideoSnippetStatus(slug, accountId, videoIds)

    // 4. Decide per-video what to do.
    interface RowDetail {
      episode_code: string
      video_id: string
      action: 'updated' | 'skipped' | 'failed' | 'missing'
      changed?: { containsSyntheticMedia?: boolean; categoryId?: string }
      reason?: string
      error?: string
    }
    const details: RowDetail[] = []
    let updated = 0, skipped = 0, failed = 0

    for (const row of eligible) {
      const vid = row.video_id
      const current = live[vid]
      if (!current) {
        details.push({ episode_code: row.episode_code, video_id: vid, action: 'missing', reason: 'Video no longer accessible (deleted or privacy hides it from this account).' })
        continue
      }

      const needAi = current.containsSyntheticMedia !== effectiveAi
      const needCat = current.categoryId !== effectiveCategoryId
      if (!needAi && !needCat) {
        skipped++
        details.push({ episode_code: row.episode_code, video_id: vid, action: 'skipped', reason: 'Already matches current settings.' })
        continue
      }

      const changed: { containsSyntheticMedia?: boolean; categoryId?: string } = {}
      if (needAi) changed.containsSyntheticMedia = effectiveAi
      if (needCat) changed.categoryId = effectiveCategoryId

      if (dryRun) {
        details.push({ episode_code: row.episode_code, video_id: vid, action: 'updated', changed, reason: 'Dry run — not applied.' })
        continue
      }

      try {
        await updateVideoMetadata({
          slug,
          accountId,
          videoId: vid,
          ...(needCat ? { snippet: { categoryId: effectiveCategoryId } } : {}),
          ...(needAi ? { status: { containsSyntheticMedia: effectiveAi } } : {}),
        })
        updated++
        details.push({ episode_code: row.episode_code, video_id: vid, action: 'updated', changed })
      } catch (e: any) {
        failed++
        details.push({
          episode_code: row.episode_code,
          video_id: vid,
          action: 'failed',
          error: e?.message || String(e),
        })
      }
    }

    res.json({
      scanned: ideas.length,
      eligible: eligible.length,
      updated,
      skipped,
      failed,
      missing: details.filter(d => d.action === 'missing').length,
      dry_run: dryRun,
      effective_settings: {
        contains_synthetic_media: effectiveAi,
        category_id: effectiveCategoryId,
      },
      details,
    })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'YouTube backfill failed'))
  }
})

// ── Plans CRUD ────────────────────────────────────────────────────────────

router.get('/projects/:slug/upload/plans', async (req, res) => {
  try {
    const slug = req.params.slug
    const list = await plans.listPlans(slug)
    // Active pointers keyed by `${platform}:${account_id}`.
    const cfg = (await pm.getConfig(slug)) as any
    const active = cfg?.upload_plan_active && typeof cfg.upload_plan_active === 'object'
      ? cfg.upload_plan_active
      : {}
    res.json({ plans: list, active })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to list plans'))
  }
})

router.post('/projects/:slug/upload/plans', async (req, res) => {
  try {
    const slug = req.params.slug
    const body = req.body || {}
    const { name, platform, account_id, schedule, defaults, id } = body
    if (!name || typeof name !== 'string') return res.status(400).json({ detail: 'name required' })
    if (!readPlatform(platform)) return res.status(400).json({ detail: 'platform required' })
    if (!account_id || typeof account_id !== 'string') return res.status(400).json({ detail: 'account_id required' })
    if (!schedule || typeof schedule !== 'object') return res.status(400).json({ detail: 'schedule required' })
    if (!defaults || typeof defaults !== 'object') return res.status(400).json({ detail: 'defaults required' })
    const plan = await plans.upsertPlan(slug, { id, name, platform, account_id, schedule, defaults })
    res.json({ plan })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to save plan'))
  }
})

router.delete('/projects/:slug/upload/plans/:id', async (req, res) => {
  try {
    const slug = req.params.slug
    const removed = await plans.removePlan(slug, req.params.id)
    if (!removed) return res.status(404).json({ detail: 'Plan not found' })
    res.json({ ok: true })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to delete plan'))
  }
})

router.put('/projects/:slug/upload/plans/:id/active', async (req, res) => {
  try {
    const slug = req.params.slug
    const plan = await plans.getPlan(slug, req.params.id)
    if (!plan) return res.status(404).json({ detail: 'Plan not found' })
    await plans.setActivePlanId(slug, plan.platform, plan.account_id, plan.id)
    res.json({ ok: true })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to activate plan'))
  }
})

// Preview what the plan would do: returns N computed slots without writing.
// Also surfaces any slots that would land in the past so the UI can warn
// before the user commits (Apply will hard-reject past slots).
//
// Accepts an optional `episode_codes` body field so the preview can
// reflect the same continue-after-existing logic as Apply. When
// supplied, we find the latest future scheduled time across every
// other accepted episode and pass it to computeSlots as
// `minStartDate` — preview rows then match what Apply would actually
// write. When omitted (e.g. the standalone "preview the plan" tester),
// we fall back to the raw N-slots-from-start_date behaviour.
router.post('/projects/:slug/upload/plans/:id/preview', async (req, res) => {
  try {
    const slug = req.params.slug
    const plan = await plans.getPlan(slug, req.params.id)
    if (!plan) return res.status(404).json({ detail: 'Plan not found' })
    const requestedCount = Math.max(1, Math.min(500, Number(req.body?.count) || 10))
    const targetCodes = plans.orderEpisodeCodes(
      Array.isArray(req.body?.episode_codes) ? req.body.episode_codes : [],
    )
    const count = targetCodes.length || requestedCount

    let latestFutureClaimMs = 0
    let publicSkipCodes: string[] = []
    if (targetCodes.length > 0) {
      const targetSet = new Set(targetCodes)
      const allAccepted = await im.getIdeas(slug, 'accepted')
      const nowMs = Date.now()
      // v1.0.46 — also count which target codes are already public on
      // YouTube. Apply will skip those (Layer 2 guard); the modal
      // shows the count up-front so the user knows N rows won't be
      // touched before they hit Confirm.
      const targetIdeas = new Map<string, { title: string }>()
      for (const idea of allAccepted) {
        if (!idea.episode_code) continue
        if (targetSet.has(idea.episode_code)) {
          targetIdeas.set(idea.episode_code, { title: idea.title || '' })
        }
      }
      latestFutureClaimMs = await plans.latestFutureProjectClaimMs(
        slug, plan.platform, targetSet, nowMs,
      )
      const publicationStates = plan.platform === 'youtube'
        ? await plans.readItemPublicationStates(slug)
        : null
      const publicChecks = await Promise.all(Array.from(targetIdeas.entries()).map(async ([code, info]) => {
        const privacy = publicationStates
          ? publicationStates[code]?.privacy_status
          : (await readSidecarRaw(slug, code, info.title, plan.platform))?.privacy_status
        return privacy === 'public' ? code : null
      }))
      publicSkipCodes = publicChecks.filter((c): c is string => !!c)
    }

    const minStartDate = latestFutureClaimMs ? new Date(latestFutureClaimMs) : undefined
    const slots = plans.computeSlots(plan.schedule, count, { minStartDate })
    const now = Date.now()
    const past_slots = slots.filter(s => new Date(s).getTime() < now - 60_000)
    const assignments = targetCodes.map((episode_code, index) => ({
      episode_code,
      publishAt: slots[index] || '',
    }))
    res.json({
      slots,
      ordered_episode_codes: targetCodes,
      assignments,
      past_slots,
      has_past_slots: past_slots.length > 0,
      latest_existing_claim: latestFutureClaimMs ? new Date(latestFutureClaimMs).toISOString() : null,
      public_skip_codes: publicSkipCodes,
      public_skip_count: publicSkipCodes.length,
    })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to preview plan'))
  }
})

// Apply a plan across an ordered list of episode_codes. Writes the
// per-item schedule map; for any episode whose sidecar already carries a
// video_id, also patches YouTube's publishAt via videos.update. Returns
// the computed map + list of already-uploaded videos that were patched.
router.post('/projects/:slug/upload/plans/:id/apply', async (req, res) => {
  try {
    const slug = req.params.slug
    const plan = await plans.getPlan(slug, req.params.id)
    if (!plan) return res.status(404).json({ detail: 'Plan not found' })

    // Private-first mode skips the whole Apply path — the user opted out
    // of our scheduling in favor of YT Studio's native UI. Return a 409
    // so the frontend can surface a clear "switch mode first" message.
    const mode = await store.getUploadMode(slug, plan.platform)
    if (mode === 'private') {
      return res.status(409).json({
        detail: 'Private-first mode is active. Apply-plan is disabled because uploads ignore publishAt in this mode. Switch back to Apply-plan mode in Accounts tab to schedule via Story Studio.',
        upload_mode: mode,
      })
    }

    const episode_codes = plans.orderEpisodeCodes(
      Array.isArray(req.body?.episode_codes) ? req.body.episode_codes : [],
    )
    if (!episode_codes.length) return res.status(400).json({ detail: 'episode_codes (ordered) required' })

    // Find the latest FUTURE scheduled time across all other accepted
    // episodes so computeSlots can resume the walk past the existing
    // queue. Episodes IN the apply target are excluded — their old
    // slots are being released and re-assigned by this apply. Past
    // (already-published) slots are also ignored: a video that went
    // live last week shouldn't push new schedules further out.
    //
    // Replaces the v1.0.42 `claimedSlots` Set<string> approach, which
    // silently failed on any sidecar `scheduled_for` whose ISO format
    // didn't include `.000Z` milliseconds (YouTube-synced values).
    const latestFutureClaimMs = await plans.latestFutureProjectClaimMs(
      slug, plan.platform, new Set(episode_codes),
    )

    const minStartDate = latestFutureClaimMs ? new Date(latestFutureClaimMs) : undefined
    const slots = plans.computeSlots(plan.schedule, episode_codes.length, { minStartDate })

    // If the plan's end_date or weekday config can't yield enough
    // slots from the (possibly advanced) walk start, surface a clear
    // error instead of a silent partial-apply.
    if (slots.length < episode_codes.length) {
      return res.status(400).json({
        detail:
          `Plan "${plan.name}" couldn't generate enough slots within its 2-year horizon. ` +
          `${slots.length} of ${episode_codes.length} requested slot(s) available` +
          `${latestFutureClaimMs ? ` after the latest existing scheduled time` : ''}. ` +
          `Either extend the plan's end_date, increase slot density (more weekdays / shorter interval), ` +
          `or unschedule some existing episodes first.`,
        free_slots_available: slots.length,
        latest_existing_claim: latestFutureClaimMs ? new Date(latestFutureClaimMs).toISOString() : null,
      })
    }

    // Hard-reject past slots. YouTube returns a cryptic 400 when publishAt
    // is in the past; catching it here gives the user a clear next step
    // rather than a confusing "some uploads scheduled, others failed"
    // partial success. Threshold: 60s of clock skew tolerance, so "right
    // now" isn't rejected for computed timestamps a few ms behind.
    const now = Date.now()
    const pastSlots: Array<{ episode_code: string; publishAt: string }> = []
    for (let i = 0; i < episode_codes.length && i < slots.length; i++) {
      const slot = slots[i]!
      if (new Date(slot).getTime() < now - 60_000) {
        pastSlots.push({ episode_code: episode_codes[i]!, publishAt: slot })
      }
    }
    if (pastSlots.length) {
      return res.status(400).json({
        detail: `Plan "${plan.name}" would produce ${pastSlots.length} publish time(s) in the past. Edit the plan's start_date to today or later.`,
        past_slots: pastSlots,
        first_past: pastSlots[0]?.publishAt,
      })
    }

    const assignments: Array<{ episode_code: string; publishAt: string }> = []
    for (let i = 0; i < episode_codes.length && i < slots.length; i++) {
      assignments.push({ episode_code: episode_codes[i]!, publishAt: slots[i]! })
    }

    // For already-uploaded videos, PATCH publishAt live. Failures are
    // surfaced per-row so the user sees which ones synced.
    const ideas = await im.getIdeas(slug, 'accepted')
    const ideaByCode = new Map(ideas.filter(i => i.episode_code).map(i => [i.episode_code!, i]))
    // Pre-fetch sidecars in parallel — sidecar reads are pure I/O and
    // independent. Sequential awaits made an N-episode plan apply pay
    // N round-trips of disk latency before the first PATCH could fire;
    // parallel reads collapse that to ~1 disk round-trip total.
    const sidecarsByCode = new Map<string, Awaited<ReturnType<typeof readSidecar>>>()
    await Promise.all(assignments.map(async (a) => {
      const idea = ideaByCode.get(a.episode_code)
      if (!idea) return
      sidecarsByCode.set(a.episode_code, await readSidecar(slug, a.episode_code, idea.title || '', plan.platform))
    }))

    // v1.0.46 — partition assignments into "public" (skipped) vs the
    // rest BEFORE writing the local item-schedule map. Writing public
    // codes into the local map would create a UI/YouTube desync
    // (queue says "scheduled at X" but the live video stayed public
    // and ignored the PATCH skip).
    const publicCodes = new Set<string>()
    for (const a of assignments) {
      const sc = sidecarsByCode.get(a.episode_code)
      if (sc?.privacy_status === 'public') publicCodes.add(a.episode_code)
    }

    // Persist in-memory plan → per-item schedule map. Exclude public
    // codes so the local view stays honest about what actually got
    // pushed to YouTube.
    const existing = await plans.readItemSchedule(slug)
    const nextMap = { ...existing }
    for (const a of assignments) {
      if (publicCodes.has(a.episode_code)) continue
      nextMap[a.episode_code] = a.publishAt
    }
    await plans.writeItemSchedule(slug, nextMap)
    const patched: Array<{ episode_code: string; video_id: string; ok: boolean; error?: string }> = []
    const skipped_public: Array<{ episode_code: string; video_id: string }> = []
    // v1.0.502 — heal a stale plan→account binding. Disconnect→reconnect used
    // to mint a fresh account id, orphaning plan.account_id and failing every
    // patch with "No tokens for this account" even though the (single)
    // account is healthy. Resolve once for the batch; persist the fix back to
    // the plan so future applies don't need the fallback.
    const patchAccountId = plan.platform === 'youtube'
      ? await resolveYouTubeAccountId(slug, plan.account_id)
      : await store.resolveUsableAccountId(slug, plan.platform, plan.account_id)
    if (!patchAccountId) {
      return res.status(409).json({ detail: 'Reconnect the assigned channel in Settings → YouTube before applying this plan.' })
    }
    if (patchAccountId !== plan.account_id) {
      try { await plans.upsertPlan(slug, { ...plan, account_id: patchAccountId }) } catch { /* best-effort heal */ }
    }
    // PATCH calls stay sequential — they hit YouTube's API and benefit
    // from natural rate limiting; per-row error reporting also expects
    // ordered execution.
    for (const a of assignments) {
      const idea = ideaByCode.get(a.episode_code)
      if (!idea) continue
      const sidecar = sidecarsByCode.get(a.episode_code) || null
      if (!sidecar?.video_id) continue
      // v1.0.46 — public-video safety guard. The PATCH below sets
      // `privacyStatus: plan.defaults.privacy_status` (typically
      // 'private') alongside publishAt, which would silently
      // **unpublish a live YouTube video** and reschedule it. Skip
      // any row whose last-known sidecar privacy is 'public' so
      // bulk apply-plan can never destroy live videos. The skip is
      // reported per-row so the UI can show a "skipped N public"
      // badge in the result toast.
      if (sidecar.privacy_status === 'public') {
        skipped_public.push({ episode_code: a.episode_code, video_id: sidecar.video_id })
        continue
      }
      try {
        await updateVideoMetadata({
          slug,
          accountId: patchAccountId,
          videoId: sidecar.video_id,
          status: { privacyStatus: plan.defaults.privacy_status, publishAt: a.publishAt },
        })
        // Refresh sidecar's scheduled_for so the queue view reflects the
        // new time without waiting for the next manual upload action.
        const { writeSidecar } = await import('../services/upload-sidecar.js')
        await writeSidecar(slug, a.episode_code, idea.title || '', {
          ...sidecar,
          account_id: patchAccountId,   // v1.0.502 — heal stale binding in place
          scheduled_for: a.publishAt,
          last_sync_at: new Date().toISOString(),
        })
        patched.push({ episode_code: a.episode_code, video_id: sidecar.video_id, ok: true })
      } catch (e: any) {
        patched.push({ episode_code: a.episode_code, video_id: sidecar.video_id, ok: false, error: e?.message || 'patch failed' })
      }
    }

    // Mark this plan active for the platform/account combo so future
    // uploads default to it without an extra UI step.
    await plans.setActivePlanId(slug, plan.platform, patchAccountId, plan.id)

    res.json({ assignments, patched, skipped_public })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to apply plan'))
  }
})

// ── Import folder + scan (Phase 4) ────────────────────────────────────────

router.post('/projects/:slug/upload/imports/scan', async (req, res) => {
  try {
    const slug = req.params.slug
    const result = await uq.scanImports(slug)
    res.json(result)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Scan failed'))
  }
})

router.put('/projects/:slug/upload/imports/:filename/meta', async (req, res) => {
  try {
    const slug = req.params.slug
    // Defense-in-depth: reject path-traversal filenames at the route layer
    // too, with a correct 400 (rather than the generic 500 the service throw
    // would become in the catch below).
    const filenameErr = validateFilename(req.params.filename)
    if (filenameErr) return res.status(400).json({ detail: filenameErr })
    const folder = await uq.ensureQueueFolder(slug)
    if (!folder) return res.status(400).json({ detail: 'Project output root not configured' })
    const { default: path } = await import('path')
    const fp = path.join(folder, req.params.filename)
    const meta = {
      title: typeof req.body?.title === 'string' ? req.body.title : '',
      description: typeof req.body?.description === 'string' ? req.body.description : '',
      tags: Array.isArray(req.body?.tags) ? req.body.tags : [],
      notes: typeof req.body?.notes === 'string' ? req.body.notes : '',
    }
    await uq.writeImportMeta(fp, meta)
    res.json({ ok: true })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to save import metadata'))
  }
})

router.delete('/projects/:slug/upload/imports/:filename', async (req, res) => {
  try {
    const slug = req.params.slug
    const filenameErr = validateFilename(req.params.filename)
    if (filenameErr) return res.status(400).json({ detail: filenameErr })
    const deleteFile = req.query.delete_file === '1' || req.query.delete_file === 'true'
    const removed = await uq.removeImport(slug, req.params.filename, deleteFile)
    if (!removed) return res.status(404).json({ detail: 'Import not found' })
    res.json({ ok: true })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to remove import'))
  }
})

router.put('/projects/:slug/upload/sequence', async (req, res) => {
  try {
    const slug = req.params.slug
    const ordered = Array.isArray(req.body?.ordered_ids)
      ? req.body.ordered_ids.filter((x: any) => typeof x === 'string')
      : []
    await uq.reorder(slug, ordered)
    res.json({ ok: true })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to reorder'))
  }
})

// ── Per-episode Imported/ (Phase 5) ────────────────────────────────────
//
// Different folder from the project-level Upload Queue: this one lives
// inside each episode's directory and lets the user drop an externally-
// rendered version of THAT episode's video without going through
// Video Assembly. Scan moves the file into `{episode}/video/` as
// `{code}_final_video.{ext}` so the broadened detection picks it up.

router.post('/projects/:slug/episodes/:code/imported/scan', async (req, res) => {
  try {
    const slug = req.params.slug
    const code = req.params.code
    const result = await uq.scanEpisodeImports(slug, code)
    res.json(result)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Episode scan failed'))
  }
})

router.get('/projects/:slug/episodes/:code/imported/folder', async (req, res) => {
  try {
    const slug = req.params.slug
    const code = req.params.code
    const folder = await uq.ensureEpisodeImportFolder(slug, code)
    res.json({ folder })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to resolve episode import folder'))
  }
})

// Episodes that are accepted but don't have a final video on disk yet —
// candidates for the per-episode import flow. The UI renders them as a
// separate section below the main queue so the user can drop external
// renders for them.
// Same TTL as the queue index cache — same scan cost, same staleness
// tolerance. Cache map + TTL constant live in `services/upload-caches.ts`
// so non-upload routes (idea remove/dismiss) can invalidate it via
// `invalidateProjectUploadCaches`.

router.get('/projects/:slug/upload/missing-video', async (req, res) => {
  try {
    const slug = req.params.slug
    const noCache = req.query.nocache === '1' || req.query.nocache === 'true'

    // Episodes the user manually marked as "uploaded elsewhere".
    const config = await pm.getConfig(slug) as any
    const legacyUploaded: Record<string, boolean> = (config?.youtube_legacy_uploaded || {})

    const now = Date.now()
    let episodes: Array<{ episode_code: string; title: string }> | null = null
    if (!noCache) {
      const hit = missingVideoCache.get(slug)
      if (hit && now - hit.ts < MISSING_VIDEO_TTL_MS) episodes = hit.episodes
    }
    if (!episodes) {
      const ideas = await im.getIdeas(slug, 'accepted')
      const out: Array<{ episode_code: string; title: string }> = []
      const CONCURRENCY = 32
      const queue = ideas.filter(i => i.episode_code)
      let cursor = 0
      async function worker() {
        while (cursor < queue.length) {
          const i = cursor++
          const idea = queue[i]
          if (!idea?.episode_code) continue
          // Fast check (Path A only) + sidecar in parallel. Same shape as
          // buildQueueIndex — episodes uploaded to YouTube don't count
          // as "missing" even if the local file was deleted.
          const [hasFinal, sidecar] = await Promise.all([
            hasFinalVideoFast(slug, idea.episode_code, idea.title || ''),
            readSidecar(slug, idea.episode_code, idea.title || '', 'youtube'),
          ])
          if (!hasFinal && !sidecar?.video_id) {
            out.push({ episode_code: idea.episode_code, title: idea.title || idea.episode_code })
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker))
      out.sort((a, b) => a.episode_code.localeCompare(b.episode_code, undefined, { numeric: true }))
      episodes = out
      missingVideoCache.set(slug, { ts: now, episodes })
    }

    // Filter out legacy-uploaded after the cache hit so the user gets
    // immediate feedback when they mark/unmark without invalidating the
    // expensive scan cache.
    const filtered = episodes.filter(ep => !legacyUploaded[ep.episode_code])
    res.json({
      episodes: filtered,
      legacy_uploaded_count: Object.keys(legacyUploaded).filter(k => legacyUploaded[k]).length,
    })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to list missing-video episodes'))
  }
})

// Soft URL validation — keeps the field free-text-ish so users can paste
// shortlinks without a deeper-parse rejection, but at least catches typos
// like missing protocol or accidental `mailto:` etc. Returning null = OK.
function validateExternalUrlOrErr(raw: unknown): string | null {
  if (raw == null || raw === '') return null
  if (typeof raw !== 'string') return 'external_url must be a string'
  const t = raw.trim()
  if (!t) return null
  if (!/^https?:\/\//i.test(t)) return 'external_url must start with http:// or https://'
  return null
}

// Mark / unmark an episode as "already uploaded elsewhere" — used for
// legacy episodes (uploaded to YouTube years before Story Studio, where
// no video file exists locally) AND for episodes that live on a different
// account / platform we want to record but not manage. Reversible via
// { mark: false }.
//
// Optional fields (additive, item E):
//   - external_url: pasteable URL where the video lives (must start http(s)://)
//   - note: free-form annotation ("on Bob's channel", "Vimeo backup", etc.)
// These ride alongside the boolean flag in `youtube_legacy_uploaded_meta`
// so call sites that only check `youtube_legacy_uploaded[code]` keep
// working without migration.
router.post('/projects/:slug/upload/mark-legacy-uploaded', async (req, res) => {
  try {
    const slug = req.params.slug
    const episodeCode = typeof req.body?.episode_code === 'string' ? req.body.episode_code.trim() : ''
    if (!episodeCode) return res.status(400).json({ detail: 'episode_code is required' })
    const mark = req.body?.mark !== false   // default true; pass false to unmark

    const urlErr = validateExternalUrlOrErr(req.body?.external_url)
    if (urlErr) return res.status(400).json({ detail: urlErr })
    const externalUrl = typeof req.body?.external_url === 'string' ? req.body.external_url.trim() : ''
    const note = typeof req.body?.note === 'string' ? req.body.note.trim() : ''

    const config = await pm.getConfig(slug) as any
    const current: Record<string, boolean> = (config?.youtube_legacy_uploaded || {})
    const meta: Record<string, { external_url?: string; note?: string }> = (config?.youtube_legacy_uploaded_meta || {})
    if (mark) {
      current[episodeCode] = true
      // Only write a meta entry when at least one annotation field is set,
      // so old marks without metadata don't get a {} sidecar that lies
      // about "had an annotation". Existing entries are preserved when
      // the request omits the fields entirely.
      const next: { external_url?: string; note?: string } = {
        ...(meta[episodeCode] || {}),
      }
      if (typeof req.body?.external_url === 'string') {
        if (externalUrl) next.external_url = externalUrl
        else delete next.external_url
      }
      if (typeof req.body?.note === 'string') {
        if (note) next.note = note
        else delete next.note
      }
      if (next.external_url || next.note) meta[episodeCode] = next
      else delete meta[episodeCode]
    } else {
      delete current[episodeCode]
      delete meta[episodeCode]
    }

    await pm.updateConfig(slug, {
      youtube_legacy_uploaded: current,
      youtube_legacy_uploaded_meta: meta,
    } as any)
    // Bust the queue cache so the next /upload/queue call sees the change.
    queueIndexCache.delete(queueCacheKey(slug, 'youtube'))
    res.json({
      ok: true,
      marked: mark,
      episode_code: episodeCode,
      external_url: meta[episodeCode]?.external_url || null,
      note: meta[episodeCode]?.note || null,
      total_legacy: Object.keys(current).length,
    })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to update legacy-uploaded flag'))
  }
})

// Bulk variant — takes an array of episode_codes. Cheaper than N round-trips
// when the user has 50+ legacy episodes to mark in one go.
//
// The optional `external_url` / `note` fields are applied uniformly to every
// code in the request. Per-episode metadata is rare in bulk flows (you'd
// typically annotate one-by-one), so the simple "same value for all"
// behaviour is fine.
router.post('/projects/:slug/upload/mark-legacy-uploaded-bulk', async (req, res) => {
  try {
    const slug = req.params.slug
    const codes = Array.isArray(req.body?.episode_codes) ? req.body.episode_codes.filter((c: any) => typeof c === 'string' && c.trim()) : []
    if (!codes.length) return res.status(400).json({ detail: 'episode_codes (array) is required' })
    const mark = req.body?.mark !== false

    const urlErr = validateExternalUrlOrErr(req.body?.external_url)
    if (urlErr) return res.status(400).json({ detail: urlErr })
    const externalUrl = typeof req.body?.external_url === 'string' ? req.body.external_url.trim() : ''
    const note = typeof req.body?.note === 'string' ? req.body.note.trim() : ''
    const haveAnnotations = !!(externalUrl || note)

    const config = await pm.getConfig(slug) as any
    const current: Record<string, boolean> = (config?.youtube_legacy_uploaded || {})
    const meta: Record<string, { external_url?: string; note?: string }> = (config?.youtube_legacy_uploaded_meta || {})
    for (const code of codes) {
      const c = code.trim()
      if (mark) {
        current[c] = true
        if (haveAnnotations) {
          const entry: { external_url?: string; note?: string } = {}
          if (externalUrl) entry.external_url = externalUrl
          if (note) entry.note = note
          meta[c] = entry
        }
      } else {
        delete current[c]
        delete meta[c]
      }
    }
    await pm.updateConfig(slug, {
      youtube_legacy_uploaded: current,
      youtube_legacy_uploaded_meta: meta,
    } as any)
    queueIndexCache.delete(queueCacheKey(slug, 'youtube'))
    res.json({ ok: true, marked: mark, count: codes.length, total_legacy: Object.keys(current).length })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to bulk-update legacy-uploaded flags'))
  }
})

// Expose the folder path so the UI can offer "Open folder in Finder" via
// system/open, and print it so the user knows where to drop files.
router.get('/projects/:slug/upload/imports/folder', async (req, res) => {
  try {
    const slug = req.params.slug
    const folder = await uq.ensureQueueFolder(slug)
    if (!folder) return res.status(400).json({ detail: 'Project output root not configured' })
    res.json({ folder, relative: uq.UPLOAD_QUEUE_FOLDER })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to resolve queue folder'))
  }
})

// ── Reconcile channel (Phase 6) ────────────────────────────────────────
//
// One-time onboarding for channels with pre-existing uploads. Preview
// fetches up to ~400 recent channel videos + fuzzy-matches to local
// episodes; user reviews + confirms; confirmed links write sidecars
// so the queue flips to "uploaded" state for those episodes.

router.post('/projects/:slug/upload/reconcile/preview', async (req, res) => {
  try {
    const slug = req.params.slug
    const account_id = await resolveRequestedYouTubeAccountId(slug, req.body?.account_id)
    if (!account_id) return res.status(400).json({ detail: 'No YouTube account connected.' })
    const preview = await reconciler.buildReconcilePreview(slug, account_id)
    res.json({ account_id, ...preview })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Reconcile preview failed'))
  }
})

router.post('/projects/:slug/upload/reconcile/confirm', async (req, res) => {
  try {
    const slug = req.params.slug
    const account_id = await resolveRequestedYouTubeAccountId(slug, req.body?.account_id)
    if (!account_id) return res.status(400).json({ detail: 'No YouTube account connected.' })
    const links = Array.isArray(req.body?.links) ? req.body.links : []
    const valid = links.filter((l: any) =>
      typeof l?.episode_code === 'string' && l.episode_code
      && typeof l?.video_id === 'string' && l.video_id,
    ).map((l: any) => ({
      episode_code: l.episode_code,
      video_id: l.video_id,
      remote_title: typeof l.remote_title === 'string' ? l.remote_title : undefined,
      published_at: typeof l.published_at === 'string' ? l.published_at : undefined,
      // Per-row opt-in: when true AND remote_title is present, the
      // confirm flow overwrites the episode's title in ideas.json.
      apply_remote_title: !!l.apply_remote_title,
    }))
    if (!valid.length) return res.status(400).json({ detail: 'links (episode_code + video_id) required' })
    const result = await reconciler.confirmReconcile(slug, account_id, valid)
    res.json(result)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Reconcile confirm failed'))
  }
})

// ── Orphan management (#7) ───────────────────────────────────────────────
//
// "Orphans" = videos on the connected YouTube channel that aren't linked
// to any local episode via a sidecar. Three adoption flows surface them
// into Story Studio:
//   - GET  /upload/orphans                       → list
//   - POST /upload/orphans/adopt-single          → create one ep for one video
//   - POST /upload/orphans/adopt-bulk             → bulk, with mode =
//                                                  'continuation' | 'renumber'

router.get('/projects/:slug/upload/orphans', async (req, res) => {
  try {
    const slug = req.params.slug
    const accountId = await resolveRequestedYouTubeAccountId(slug, req.query.account_id)
    if (!accountId) return res.status(400).json({ detail: 'No YouTube account connected.' })
    const result = await orphans.listOrphans(slug, accountId)
    res.json(result)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to list orphans'))
  }
})

router.post('/projects/:slug/upload/orphans/adopt-single', async (req, res) => {
  try {
    const slug = req.params.slug
    const accountId = await resolveRequestedYouTubeAccountId(slug, req.body?.account_id)
    if (!accountId) return res.status(400).json({ detail: 'No YouTube account connected.' })
    const video = req.body?.video
    const episode_code = typeof req.body?.episode_code === 'string' ? req.body.episode_code.trim() : ''
    if (!video?.videoId || !episode_code) {
      return res.status(400).json({ detail: 'video (with videoId) and episode_code required' })
    }
    const adopted = await orphans.adoptSingle(slug, accountId, video, episode_code)
    res.json({ ok: true, adopted })
  } catch (e: any) {
    res.status(400).json(humanizeBackendError(e, 'Adopt failed'))
  }
})

router.post('/projects/:slug/upload/orphans/adopt-bulk', async (req, res) => {
  try {
    const slug = req.params.slug
    const accountId = await resolveRequestedYouTubeAccountId(slug, req.body?.account_id)
    if (!accountId) return res.status(400).json({ detail: 'No YouTube account connected.' })
    const mode = req.body?.mode
    const videos = Array.isArray(req.body?.videos) ? req.body.videos : []
    if (mode !== 'continuation' && mode !== 'renumber') {
      return res.status(400).json({ detail: 'mode must be "continuation" or "renumber"' })
    }
    if (!videos.length) return res.status(400).json({ detail: 'videos (non-empty) required' })

    if (mode === 'continuation') {
      const r = await orphans.adoptBulkContinuation(slug, accountId, videos)
      res.json({ ok: true, mode, ...r })
    } else {
      const r = await orphans.adoptBulkRenumber(slug, accountId, videos)
      res.json({ ok: true, mode, ...r })
    }
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Bulk adopt failed'))
  }
})

// ── Renumber rollback (item L) ───────────────────────────────────────────
//
// `adopt-bulk mode=renumber` writes `.renumber-undo.json` to the project
// root before any disk renames or ideas.json mutations land. The three
// endpoints below let the UI:
//   - GET  /upload/renumber-undo  → check whether a rollback is available
//                                    + show the user a banner with the
//                                    planned undo
//   - POST /upload/renumber-undo/revert → run the full inverse operation
//   - DELETE /upload/renumber-undo → user manually dismisses the safety
//                                     net once they're confident
// Auto-cleanup of stale (>30d) sidecars happens on Electron boot —
// see boot/migrations.ts.

router.get('/projects/:slug/upload/renumber-undo', async (req, res) => {
  try {
    const slug = req.params.slug
    const plan = await renumberUndo.readUndoSidecar(slug)
    if (!plan) return res.json({ available: false })
    res.json({
      available: true,
      plan,
      // Pre-computed convenience fields for the banner — keeps the
      // frontend dumb (no need to format dates / count items twice).
      adopted_count: plan.adopted.length,
      renamed_count: plan.rename_plan.length,
      expired: renumberUndo.isExpired(plan),
    })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to read renumber-undo sidecar'))
  }
})

router.post('/projects/:slug/upload/renumber-undo/revert', async (req, res) => {
  try {
    const slug = req.params.slug
    const result = await renumberUndo.revertRenumber(slug)
    // Bust caches that depend on episode codes — most importantly the
    // queue index, which built up assuming the renumbered codes.
    queueIndexCache.delete(queueCacheKey(slug, 'youtube'))
    missingVideoCache.delete(slug)
    res.json({ ok: true, ...result })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to revert renumber'))
  }
})

router.delete('/projects/:slug/upload/renumber-undo', async (req, res) => {
  try {
    const slug = req.params.slug
    const deleted = await renumberUndo.deleteUndoSidecar(slug)
    res.json({ ok: true, deleted })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to dismiss renumber-undo sidecar'))
  }
})

// ── Reset upload state (#2 recalibrate) ──────────────────────────────────
//
// Episodes sometimes end up with a sidecar pointing at the wrong YouTube
// video — most commonly when the user uploaded once to a different
// account by accident. The sidecar's `video_id` + `account_id` become
// stale, and any subsequent "Upload" click tries to PATCH metadata on
// the wrong video via the wrong account's tokens → confusing failure.
//
// This endpoint clears the sidecar so the next Upload does a fresh
// insert against the currently-connected account. It does NOT touch the
// remote YouTube video — that stays on whichever channel it was
// accidentally pushed to; the user removes it via YT Studio if desired.

router.post('/projects/:slug/upload/queue/:episode_code/reset', async (req, res) => {
  try {
    const slug = req.params.slug
    const code = req.params.episode_code
    const platform = readPlatform(req.body?.platform) || 'youtube'

    const ideas = await im.getIdeas(slug, 'accepted')
    const idea = ideas.find(i => (i.episode_code || '') === code)
    if (!idea) return res.status(404).json({ detail: `Episode ${code} not found` })

    const { deleteSidecar, readSidecar: peek } = await import('../services/upload-sidecar.js')
    const prior = await peek(slug, code, idea.title || '', platform)
    await deleteSidecar(slug, code, idea.title || '', platform)

    // Also drop any per-item schedule entry — otherwise the next fresh
    // upload would inherit a stale publishAt from the old session.
    const schedMap = await plans.readItemSchedule(slug)
    if (code in schedMap) {
      delete schedMap[code]
      await plans.writeItemSchedule(slug, schedMap)
    }
    queueIndexCache.delete(queueCacheKey(slug, platform))

    res.json({
      ok: true,
      had_sidecar: !!prior?.video_id,
      prior_video_id: prior?.video_id || '',
      prior_account_id: prior?.account_id || '',
    })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to reset upload state'))
  }
})

/**
 * Link an EXISTING local episode to a YouTube video that's already on the
 * channel. Distinct from /upload/orphans/adopt-single — that path creates
 * a brand-new idea + folder tree and rejects if the episode_code is taken.
 * This path assumes the local episode already exists (the dominant case
 * for "I uploaded this manually while travelling and want to reconnect")
 * and just writes / overwrites the sidecar so future flows know the link.
 *
 * Body: { video: { videoId, title?, publishedAt?, privacyStatus? } }
 * Errors: 404 if the episode_code isn't in accepted ideas; 400 if no
 * video.videoId; 409 if the video_id is already linked to a different
 * episode (forces the user to resolve the conflict by hand).
 */
router.post('/projects/:slug/upload/queue/:episode_code/link-existing-video', async (req, res) => {
  try {
    const slug = req.params.slug
    const code = req.params.episode_code
    const platform = readPlatform(req.body?.platform) || 'youtube'

    const ideas = await im.getIdeas(slug, 'accepted')
    const idea = ideas.find(i => (i.episode_code || '') === code)
    if (!idea) return res.status(404).json({ detail: `Episode ${code} not found in accepted ideas. Use the Unlinked Uploads tab if you need to adopt a YouTube video into a new episode.` })

    const video = req.body?.video
    const videoId: string = typeof video?.videoId === 'string' ? video.videoId.trim() : ''
    if (!videoId) return res.status(400).json({ detail: 'video.videoId required' })

    // Conflict detection: refuse if another episode already claims this
    // video_id. Avoids two episodes pointing at the same upstream video,
    // which would bork sync + reconcile in subtle ways.
    const conflict = await Promise.all(ideas
      .filter(i => i.episode_code && i.episode_code !== code)
      .map(async (i) => {
        const sc = await readSidecar(slug, i.episode_code!, i.title || '', platform)
        return sc?.video_id === videoId ? i.episode_code : null
      }))
    const conflictCode = conflict.find(c => c)
    if (conflictCode) {
      return res.status(409).json({ detail: `Video ${videoId} is already linked to episode ${conflictCode}. Forget that link first if you want to move it.` })
    }

    // Account / channel attribution: use the project's default account.
    // The video has to be on the connected channel (it came back from
    // listChannelVideos) so attribution is unambiguous.
    const accountId = await resolveYouTubeAccountId(slug)
    if (!accountId) return res.status(400).json({ detail: 'No YouTube channel is assigned. Connect or select one in Settings → YouTube.' })
    const account = await describeYouTubeCredential(slug, accountId)
    if (!account) return res.status(400).json({ detail: 'Reconnect the assigned channel in Settings → YouTube.' })

    // Preserve any prior sidecar fields so a re-link doesn't clobber
    // local-only state (e.g. a previously-set scheduled_for that's now
    // moot but useful audit). For a fresh link this is a no-op.
    const { writeSidecar, readSidecar: peek } = await import('../services/upload-sidecar.js')
    const prior = await peek(slug, code, idea.title || '', platform)
    await writeSidecar(slug, code, idea.title || '', {
      ...(prior || {} as any),
      platform: 'youtube' as const,
      video_id: videoId,
      account_id: accountId,
      channel_id: account.remote_id,
      uploaded_at: video?.publishedAt || prior?.uploaded_at || new Date().toISOString(),
      last_sync_at: new Date().toISOString(),
      scheduled_for: prior?.scheduled_for ?? null,
      privacy_status: (video?.privacyStatus as any) || prior?.privacy_status || 'public',
      title: video?.title || prior?.title || idea.title || code,
      description: prior?.description || '',
      tags: prior?.tags || [],
      thumbnail_set: prior?.thumbnail_set ?? false,
      // Linking heals a broken state — clear any tombstone left from
      // sync-from-youtube. The new video_id is what we trust.
      deleted_at: null,
      deleted_reason: undefined,
    })
    queueIndexCache.delete(queueCacheKey(slug, platform))
    res.json({ ok: true, episode_code: code, video_id: videoId, replaced_prior: !!prior?.video_id })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to link existing video'))
  }
})

/**
 * Mark an episode's upstream video as deleted (tombstone). Distinct verb
 * from reset:
 *   - reset wipes the sidecar entirely → row goes back to "Ready" and
 *     bulk-upload will re-upload the file. Right verb when the user
 *     uploaded to the wrong account by accident.
 *   - mark-deleted KEEPS the sidecar but stamps `deleted_at` →
 *     row goes to a separate "Deleted upstream" state, EXCLUDED from
 *     bulk-upload defaults, but the historical link (video_id, account)
 *     stays intact for audit. Right verb when the video was taken down
 *     and the user does NOT want it re-uploaded.
 */
router.post('/projects/:slug/upload/queue/:episode_code/mark-deleted', async (req, res) => {
  try {
    const slug = req.params.slug
    const code = req.params.episode_code
    const platform = readPlatform(req.body?.platform) || 'youtube'
    // `clear: true` un-marks a tombstoned row WITHOUT touching the rest of
    // the sidecar. Right verb when the user marked deleted by accident or
    // when they confirmed the upstream video is actually fine after all.
    // The existing "Forget link" path wipes the sidecar entirely; this is
    // the lighter-touch counterpart.
    const clear = req.body?.clear === true

    const ideas = await im.getIdeas(slug, 'accepted')
    const idea = ideas.find(i => (i.episode_code || '') === code)
    if (!idea) return res.status(404).json({ detail: `Episode ${code} not found` })

    const { readSidecar: peek, writeSidecar } = await import('../services/upload-sidecar.js')
    const sidecar = await peek(slug, code, idea.title || '', platform)
    if (!sidecar) {
      return res.status(400).json({ detail: `Episode ${code} has no upload sidecar — nothing to ${clear ? 'un-mark' : 'mark as deleted'}. Use Reset if the row is already in a confused state.` })
    }
    if (clear) {
      if (!sidecar.deleted_at) {
        // Idempotent — un-marking a row that isn't tombstoned is a no-op.
        return res.json({ ok: true, already_unmarked: true })
      }
      const now = new Date().toISOString()
      await writeSidecar(slug, code, idea.title || '', {
        ...sidecar,
        deleted_at: null,
        deleted_reason: undefined,
        last_sync_at: now,
      })
      queueIndexCache.delete(queueCacheKey(slug, platform))
      return res.json({ ok: true, cleared: true })
    }
    if (sidecar.deleted_at) {
      // Idempotent — re-marking is a no-op so the user can click without fear.
      return res.json({ ok: true, already_marked: true, deleted_at: sidecar.deleted_at })
    }
    // Item K — coerce caller-supplied `reason` to a typed DeletedReason
    // value or fall back to 'manual'. Closed enum at write time; reads
    // accept any string so old sidecars from before this commit don't
    // suddenly fail validation.
    const VALID_REASONS = new Set(['sync_404', 'manual', 'takedown', 'duplicate'])
    const rawReason = typeof req.body?.reason === 'string' ? req.body.reason : ''
    const reason: 'sync_404' | 'manual' | 'takedown' | 'duplicate' =
      VALID_REASONS.has(rawReason) ? rawReason as any : 'manual'
    const now = new Date().toISOString()
    await writeSidecar(slug, code, idea.title || '', {
      ...sidecar,
      deleted_at: now,
      deleted_reason: reason,
      last_sync_at: now,
    })
    queueIndexCache.delete(queueCacheKey(slug, platform))
    res.json({ ok: true, deleted_at: now })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to mark/un-mark video as deleted upstream'))
  }
})

// ── Per-item schedule edit + unschedule (A2) ──────────────────────────────
//
// Two operations:
//   PATCH /upload/queue/:episode_code/schedule
//     body: { publish_at: ISO 8601 }
//     Writes the local item-schedule map AND if the episode has a sidecar
//     with a video_id, PATCHes YouTube's video.status.publishAt live.
//
//   DELETE /upload/queue/:episode_code/schedule
//     body: { make: 'private' | 'public' }
//     Drops the publishAt and sets privacyStatus. 'private' lets the user
//     schedule in YouTube Studio; 'public' flips the video live now.

router.patch('/projects/:slug/upload/queue/:episode_code/schedule', async (req, res) => {
  try {
    const slug = req.params.slug
    const code = req.params.episode_code
    const publish_at = typeof req.body?.publish_at === 'string' ? req.body.publish_at : ''
    if (!publish_at) return res.status(400).json({ detail: 'publish_at (ISO 8601) required' })

    // Validate it parses + isn't in the past (1-min clock skew tolerance).
    const when = new Date(publish_at).getTime()
    if (!Number.isFinite(when)) return res.status(400).json({ detail: 'publish_at is not a valid ISO 8601 timestamp' })
    if (when < Date.now() - 60_000) {
      return res.status(400).json({ detail: 'publish_at is in the past — pick a time today or later.' })
    }

    // Update local item-schedule map.
    const map = await plans.readItemSchedule(slug)
    map[code] = publish_at
    await plans.writeItemSchedule(slug, map)

    // If the episode is uploaded, PATCH YouTube live so the change
    // reflects on the channel within seconds.
    const ideas = await im.getIdeas(slug, 'accepted')
    const idea = ideas.find(i => (i.episode_code || '') === code)
    const sidecar = idea ? await readSidecar(slug, code, idea.title || '', 'youtube') : null
    let patched = false
    let patch_error: string | null = null
    if (sidecar?.video_id && idea) {
      try {
        // The immutable channel id survives the clean break from legacy local
        // account ids; a different current channel remains fail-closed.
        const accountId = await resolveYouTubeAccountIdForChannel(slug, sidecar.channel_id)
        if (!accountId) throw new Error('Reconnect the YouTube channel recorded for this upload in Settings before editing its schedule.')
        await updateVideoMetadata({
          slug,
          accountId,
          videoId: sidecar.video_id,
          status: { privacyStatus: 'private', publishAt: publish_at },
        })
        // Refresh sidecar so the queue shows the new time immediately.
        const { writeSidecar } = await import('../services/upload-sidecar.js')
        await writeSidecar(slug, code, idea.title || '', {
          ...sidecar,
          account_id: accountId,
          scheduled_for: publish_at,
          privacy_status: 'private',
          last_sync_at: new Date().toISOString(),
        })
        patched = true
      } catch (e: any) {
        patch_error = e?.message || 'YouTube update failed'
      }
    }

    res.json({ ok: true, publish_at, patched, patch_error })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to edit schedule'))
  }
})

router.delete('/projects/:slug/upload/queue/:episode_code/schedule', async (req, res) => {
  try {
    const slug = req.params.slug
    const code = req.params.episode_code
    const make = req.body?.make === 'public' ? 'public' : 'private'

    // Drop from local map.
    const map = await plans.readItemSchedule(slug)
    if (code in map) {
      delete map[code]
      await plans.writeItemSchedule(slug, map)
    }

    const ideas = await im.getIdeas(slug, 'accepted')
    const idea = ideas.find(i => (i.episode_code || '') === code)
    const sidecar = idea ? await readSidecar(slug, code, idea.title || '', 'youtube') : null
    let patched = false
    let patch_error: string | null = null
    if (sidecar?.video_id && idea) {
      try {
        const accountId = await resolveYouTubeAccountIdForChannel(slug, sidecar.channel_id)
        if (!accountId) throw new Error('Reconnect the YouTube channel recorded for this upload in Settings before changing its schedule.')
        await updateVideoMetadata({
          slug,
          accountId,
          videoId: sidecar.video_id,
          // No publishAt → video detaches from its scheduled publish. Privacy
          // is either 'private' (for YT-Studio hand-off) or 'public' (go live now).
          status: { privacyStatus: make, publishAt: null },
        })
        const { writeSidecar } = await import('../services/upload-sidecar.js')
        await writeSidecar(slug, code, idea.title || '', {
          ...sidecar,
          account_id: accountId,
          scheduled_for: null,
          privacy_status: make,
          last_sync_at: new Date().toISOString(),
        })
        patched = true
      } catch (e: any) {
        patch_error = e?.message || 'YouTube update failed'
      }
    }

    res.json({ ok: true, make, patched, patch_error })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to unschedule'))
  }
})

// ── Sync from YouTube ────────────────────────────────────────────────────
// Pull the current `status` block (privacyStatus + publishAt) from YouTube
// for every uploaded queue row and rewrite each sidecar to match. Fixes
// drift caused by manual edits in YT Studio or by scheduled videos that
// have auto-published since the last local refresh.
//
// Cost: ~1 quota unit per 50 videos (videos.list batches at 50). The user
// triggers this explicitly from the queue toolbar — not on every refresh —
// so the cost stays low.
//
// Body: { episode_codes?: string[] } — optional. When omitted, syncs all
// queue rows that have a video_id.
//
// Returns: { checked, updated, drift: [{ episode_code, video_id, before, after }], errors }
router.post('/projects/:slug/upload/queue/sync-from-youtube', async (req, res) => {
  try {
    const slug = req.params.slug

    const credential = await resolveYouTubeCredential(slug)
    if (!credential) return res.status(400).json({ detail: 'No YouTube channel is assigned to this project.' })
    const accountId = credential.accountId

    const filterCodes: string[] | null = Array.isArray(req.body?.episode_codes)
      ? req.body.episode_codes.filter((c: any) => typeof c === 'string' && c)
      : null

    // Build the list of (episode_code, video_id, sidecar) tuples we'll sync.
    // Read every candidate sidecar in parallel — they're independent files
    // and the sequential await chain made N-episode syncs pay N round-trips
    // of disk latency before videos.list could fire.
    const ideas = await im.getIdeas(slug, 'accepted')
    interface Row { code: string; idea: typeof ideas[number]; sidecar: NonNullable<Awaited<ReturnType<typeof readSidecar>>> }
    const candidates = ideas.filter((idea) => {
      const code = idea.episode_code || ''
      if (!code) return false
      if (filterCodes && !filterCodes.includes(code)) return false
      return true
    })
    const sidecarsByIdea = await Promise.all(
      candidates.map((idea) => readSidecar(slug, idea.episode_code!, idea.title || '', 'youtube')),
    )
    const rows: Row[] = []
    candidates.forEach((idea, i) => {
      const sidecar = sidecarsByIdea[i]
      if (!sidecar?.video_id) return
      // Old local account ids do not survive the registry clean break. The
      // immutable channel id does, and remains the provider authorization
      // boundary for historical upload evidence.
      if (sidecar.channel_id !== credential.channelId) return
      rows.push({ code: idea.episode_code!, idea, sidecar: sidecar as Row['sidecar'] })
    })

    if (!rows.length) {
      return res.json({ checked: 0, updated: 0, drift: [], errors: [] })
    }

    const liveById = await listVideoStatuses(slug, accountId, rows.map(r => r.sidecar.video_id))

    const drift: Array<{ episode_code: string; video_id: string; before: { privacy_status: string; scheduled_for: string | null }; after: { privacy_status: string; scheduled_for: string | null } }> = []
    const errors: Array<{ episode_code: string; error: string }> = []
    /**
     * Episodes whose video_id was missing from videos.list this run. We
     * mark the sidecar with `deleted_at` so the row stops pretending to
     * be a healthy upload — bulk actions skip tombstoned rows by default,
     * and the user gets a "Deleted upstream" filter chip to audit them.
     * Idempotent: re-syncing a row already tombstoned is a no-op.
     */
    const tombstoned: Array<{ episode_code: string; video_id: string }> = []
    let updated = 0
    const { writeSidecar } = await import('../services/upload-sidecar.js')
    // Item B — keep the per-item schedule map in lockstep with what we
    // just learned from YouTube. Without this, the local map can quietly
    // disagree with reality after a manual YT-Studio edit (sidecar
    // updates but the map doesn't), so the next plan-driven action picks
    // a stale publishAt. We accumulate the diffs here and flush in one
    // write at the end so we don't pay N file-locks per sync.
    let scheduleMapDirty = false
    const itemScheduleMap = await plans.readItemSchedule(slug)

    for (const r of rows) {
      const live = liveById[r.sidecar.video_id]
      if (!live) {
        // Video missing from YouTube's response — could be a takedown,
        // a manual deletion in YouTube Studio, or a privacy-status flip
        // to a tier our token can't see (rare). Stamp the sidecar so the
        // row drops out of routine bulk-upload defaults; preserve the
        // historical fields (video_id, account_id) so audit trails stay
        // intact. Skip if already tombstoned so we don't churn last_sync_at.
        if (!r.sidecar.deleted_at) {
          try {
            await writeSidecar(slug, r.code, r.idea.title || '', {
              ...r.sidecar,
              deleted_at: new Date().toISOString(),
              deleted_reason: 'sync_404',
              last_sync_at: new Date().toISOString(),
            })
            tombstoned.push({ episode_code: r.code, video_id: r.sidecar.video_id })
          } catch (e: any) {
            errors.push({ episode_code: r.code, error: e?.message || 'Tombstone write failed' })
          }
        }
        continue
      }
      const before = { privacy_status: r.sidecar.privacy_status || 'private', scheduled_for: r.sidecar.scheduled_for ?? null }
      const after = { privacy_status: live.privacyStatus, scheduled_for: live.publishAt }
      const driftedPrivacy = before.privacy_status !== after.privacy_status
      const driftedSchedule = (before.scheduled_for || null) !== (after.scheduled_for || null)
      if (!driftedPrivacy && !driftedSchedule) continue

      try {
        await writeSidecar(slug, r.code, r.idea.title || '', {
          ...r.sidecar,
          privacy_status: after.privacy_status,
          scheduled_for: after.scheduled_for,
          last_sync_at: new Date().toISOString(),
        })
        updated++
        drift.push({ episode_code: r.code, video_id: r.sidecar.video_id, before, after })
        // Item B — schedule-map drift. If YouTube's publishAt changed we
        // also need to reconcile the per-item schedule map; otherwise the
        // next plan-apply or upload will pick the stale local time. Three
        // cases:
        //   (a) YT now has a publishAt, map has no entry → record it.
        //   (b) YT now has a publishAt, map has a different entry → overwrite.
        //   (c) YT has no publishAt (already public, or schedule cleared in
        //       YT Studio) → drop the map entry so future plans don't
        //       resurrect a phantom time.
        if (after.scheduled_for) {
          if (itemScheduleMap[r.code] !== after.scheduled_for) {
            itemScheduleMap[r.code] = after.scheduled_for
            scheduleMapDirty = true
          }
        } else if (r.code in itemScheduleMap) {
          delete itemScheduleMap[r.code]
          scheduleMapDirty = true
        }
      } catch (e: any) {
        errors.push({ episode_code: r.code, error: e?.message || 'Sidecar write failed' })
      }
    }

    // Flush the schedule-map diff in a single write — Item B.
    if (scheduleMapDirty) {
      try { await plans.writeItemSchedule(slug, itemScheduleMap) }
      catch (e: any) { errors.push({ episode_code: '*', error: `Schedule-map write failed: ${e?.message || e}` }) }
    }

    // Drop the queue cache so the next page load surfaces the updated
    // sidecars without waiting out the 5-min TTL.
    if (updated > 0 || tombstoned.length > 0 || scheduleMapDirty) queueIndexCache.delete(queueCacheKey(slug, 'youtube'))

    res.json({ checked: rows.length, updated, drift, tombstoned, errors })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to sync from YouTube'))
  }
})

// Manual clear of the per-item schedule map. Two modes:
//   `?plan_id=X` → only wipe entries equal to slots this plan would have
//                 assigned (approximation: entries present in the map that
//                 match this plan's computed slots — best-effort unapply).
//   no query    → wipe the entire map (bulk clear).
//
// Both can optionally PATCH live YouTube videos to private + no publishAt
// when `sync_youtube=1` is passed. Default: local-only, ask user to sync
// via per-row unschedule if they want YT to update.
router.delete('/projects/:slug/upload/item-schedule', async (req, res) => {
  try {
    const slug = req.params.slug
    const planId = typeof req.query.plan_id === 'string' ? req.query.plan_id : ''
    const syncYoutube = req.query.sync_youtube === '1' || req.query.sync_youtube === 'true'
    // Explicit episode_codes (comma-separated query param) lets the Plans-tab
    // scope picker target an exact list — Selection / All unuploaded / Next 5
    // / This page — instead of the legacy slot-recompute approximation. When
    // present, this list wins; when absent, fall back to plan-id recompute or
    // wipe-all behaviour.
    const codesParam = typeof req.query.episode_codes === 'string' ? req.query.episode_codes : ''
    const explicitCodes = codesParam
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)

    const existing = await plans.readItemSchedule(slug)
    const ideas = await im.getIdeas(slug, 'accepted')
    const ideaByCode = new Map(ideas.filter(i => i.episode_code).map(i => [i.episode_code!, i]))

    // Figure out which codes to clear.
    let toClear: string[]
    if (explicitCodes.length) {
      // Caller listed specific episode codes — clear those entries that
      // actually have a schedule. Codes that don't currently have one are
      // a no-op (so re-running unapply is idempotent).
      toClear = explicitCodes.filter(code => code in existing)
    } else if (planId) {
      // Plan unapply: recompute the plan's slots for the current queue and
      // drop any matching entries. Approximate since the original slot→
      // episode_code mapping isn't persisted — but if the user hasn't
      // changed the queue much, the intersection covers them.
      const plan = await plans.getPlan(slug, planId)
      if (!plan) return res.status(404).json({ detail: 'Plan not found' })
      // Episodes that currently have a scheduled_for AND a matching slot
      // in this plan. We compute up to N slots (= count of existing).
      const entries = Object.entries(existing)
      const slots = new Set(plans.computeSlots(plan.schedule, entries.length))
      toClear = entries.filter(([, at]) => slots.has(at)).map(([code]) => code)
    } else {
      toClear = Object.keys(existing)
    }

    // Wipe local map.
    const nextMap: Record<string, string> = {}
    for (const [k, v] of Object.entries(existing)) {
      if (!toClear.includes(k)) nextMap[k] = v
    }
    await plans.writeItemSchedule(slug, nextMap)

    // Optionally PATCH YouTube for any uploaded episodes we cleared.
    const patched: string[] = []
    const patch_errors: Array<{ episode_code: string; error: string }> = []
    if (syncYoutube) {
      // Pre-fetch sidecars in parallel so the YouTube PATCH loop below
      // doesn't pay disk-read latency between every PATCH call. Reads
      // are independent; PATCHes stay sequential to be friendly to
      // YouTube's rate limiter.
      const sidecarsByClearCode = new Map<string, Awaited<ReturnType<typeof readSidecar>>>()
      await Promise.all(toClear.map(async (code) => {
        const idea = ideaByCode.get(code)
        if (!idea) return
        sidecarsByClearCode.set(code, await readSidecar(slug, code, idea.title || '', 'youtube'))
      }))
      for (const code of toClear) {
        const idea = ideaByCode.get(code)
        if (!idea) continue
        const sidecar = sidecarsByClearCode.get(code) || null
        if (!sidecar?.video_id) continue
        try {
          const accountId = await resolveYouTubeAccountIdForChannel(slug, sidecar.channel_id)
          if (!accountId) throw new Error('Reconnect the YouTube channel recorded for this upload in Settings before clearing its schedule.')
          await updateVideoMetadata({
            slug,
            accountId,
            videoId: sidecar.video_id,
            status: { privacyStatus: 'private', publishAt: null },
          })
          const { writeSidecar } = await import('../services/upload-sidecar.js')
          await writeSidecar(slug, code, idea.title || '', {
            ...sidecar,
            scheduled_for: null,
            privacy_status: 'private',
            last_sync_at: new Date().toISOString(),
          })
          patched.push(code)
        } catch (e: any) {
          patch_errors.push({ episode_code: code, error: e?.message || 'patch failed' })
        }
      }
    }

    res.json({ ok: true, cleared: toClear.length, patched: patched.length, patch_errors })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to clear schedule'))
  }
})

// ── Helpers ───────────────────────────────────────────────────────────────

function readPlatform(raw: any): store.UploadPlatform | null {
  if (typeof raw !== 'string') return null
  return (store.UPLOAD_PLATFORMS as readonly string[]).includes(raw) ? (raw as store.UploadPlatform) : null
}

/**
 * Returns an error message if the filename is unsafe (path separators,
 * traversal, null byte), or `null` if it's acceptable. Mirrors the
 * assertion in upload-queue's assertSafeFilename so route handlers can
 * return 400 cleanly instead of relying on the service throw → 500 path.
 */
function validateFilename(name: string | undefined): string | null {
  if (!name || typeof name !== 'string') return 'filename required'
  if (name.includes('/') || name.includes('\\')) return 'filename may not contain path separators'
  if (name === '.' || name === '..' || name.startsWith('..') || name.includes('/..') || name.includes('\\..')) {
    return 'filename may not reference parent directories'
  }
  if (name.includes('\0')) return 'filename may not contain null bytes'
  return null
}
