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
import * as pm from '../services/project-manager.js'
import * as im from '../services/idea-manager.js'
import * as jq from '../services/job-queue.js'
import * as store from '../services/upload-store.js'
import { startOAuthFlow, getFlowStatus } from '../lib/youtube-oauth.js'
import { computeEpisodeStatus, hasFinalVideoFast, getFinalVideoBytes } from '../services/asset-status.js'
import { readSidecar } from '../services/upload-sidecar.js'
import { resolveUploadMetadata, snippetFromMeta } from '../lib/upload-metadata.js'
import * as plans from '../services/upload-plans.js'
import * as uq from '../services/upload-queue.js'
import * as reconciler from '../services/upload-reconciler.js'
import * as quota from '../services/upload-quota.js'
import * as playlistsSvc from '../services/upload-playlists.js'
import * as orphans from '../services/upload-orphans.js'
import { updateVideoMetadata, createPlaylist, listVideoStatuses } from '../lib/youtube-client.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'
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
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const accountId = typeof req.query.account_id === 'string' && req.query.account_id
      ? req.query.account_id
      : await store.getDefaultAccountId(slug, 'youtube')
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
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const accountId = typeof req.body?.account_id === 'string' && req.body.account_id
      ? req.body.account_id
      : await store.getDefaultAccountId(slug, 'youtube')
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
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const accountId = typeof req.body?.account_id === 'string' && req.body.account_id
      ? req.body.account_id
      : await store.getDefaultAccountId(slug, 'youtube')
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
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const accountId = (req.query.account_id as string)
      || await store.getDefaultAccountId(slug, 'youtube')
    if (!accountId) {
      return res.status(400).json({ detail: 'No YouTube account connected. Connect one in the Accounts tab first.' })
    }
    const tokens = await store.readTokens(slug, 'youtube', accountId)
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
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const accountId = (req.query.account_id as string)
      || await store.getDefaultAccountId(slug, 'youtube')
    if (!accountId) return res.status(400).json({ detail: 'No YouTube account connected.' })
    const tokens = await store.readTokens(slug, 'youtube', accountId)
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

router.post('/projects/:slug/upload/comments/draft', async (req, res) => {
  try {
    const slug = req.params.slug
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const config = await pm.getConfig(slug)
    if (!config) return res.status(404).json({ detail: 'Project config not found' })

    const commentId = String(req.body?.comment_id || '').trim()
    const commentText = String(req.body?.comment_text || '').trim()
    if (!commentText) return res.status(400).json({ detail: 'comment_text is required' })
    const commentAuthor = String(req.body?.comment_author || '').trim()
    const videoTitle = req.body?.video_title ? String(req.body.video_title).trim() : undefined
    const count = Math.max(1, Math.min(parseInt(String(req.body?.count || 3), 10) || 3, 5))
    const model = String(req.body?.model || '').trim()
    if (!model) return res.status(400).json({ detail: 'model is required' })

    const { buildReplyDraftPrompt, parseReplyDrafts } = await import('../lib/reply-drafter.js')
    const { getEffectiveBrand } = await import('../services/brand-loader.js')
    const project = await pm.getProject(slug)
    const brand = await getEffectiveBrand(slug)

    const prompt = buildReplyDraftPrompt({
      commentText, commentAuthor, videoTitle, count, brand, projectName: project?.name,
    })

    const apiKeys = {
      anthropic_api_key: (config as any).anthropic_api_key,
      openai_api_key: (config as any).openai_api_key,
      kie_api_key: (config as any).kie_api_key,
    }
    const { callAi } = await import('../lib/ai-client.js')
    // Pass an empty system so callAi's brand-persona auto-injection kicks
    // in when applicable. The reply-draft prompt is the user message.
    const raw = await callAi(model, '', prompt, apiKeys, false, { slug })
    const drafts = parseReplyDrafts(raw, count)
    res.json({ comment_id: commentId, drafts })
  } catch (e: any) {
    const status = typeof e?.statusCode === 'number' ? e.statusCode : 500
    res.status(status).json(humanizeBackendError(e, 'Failed to draft reply'))
  }
})

router.post('/projects/:slug/upload/comments/reply', async (req, res) => {
  try {
    const slug = req.params.slug
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const accountId = String(req.body?.account_id || '').trim()
      || await store.getDefaultAccountId(slug, 'youtube')
    if (!accountId) return res.status(400).json({ detail: 'No YouTube account connected.' })
    const tokens = await store.readTokens(slug, 'youtube', accountId)
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
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const youtube = await store.getUploadMode(slug, 'youtube')
    res.json({ youtube })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to read upload mode'))
  }
})

router.put('/projects/:slug/upload/mode', async (req, res) => {
  try {
    const slug = req.params.slug
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
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

// ── Quota (YouTube Data API budget) ───────────────────────────────────────

router.get('/projects/:slug/upload/quota', async (req, res) => {
  try {
    const slug = req.params.slug
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const snap = await quota.readQuota(slug)
    res.json(snap)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to read quota'))
  }
})

router.put('/projects/:slug/upload/quota/ceiling', async (req, res) => {
  try {
    const slug = req.params.slug
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const ceiling = Number(req.body?.ceiling)
    if (!Number.isFinite(ceiling) || ceiling < 1 || ceiling > 1_000_000) {
      return res.status(400).json({ detail: 'ceiling must be a positive integer up to 1,000,000' })
    }
    await quota.setQuotaCeiling(slug, Math.floor(ceiling))
    const snap = await quota.readQuota(slug)
    res.json(snap)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to save quota ceiling'))
  }
})

// ── Platforms catalogue ───────────────────────────────────────────────────

router.get('/projects/:slug/upload/platforms', async (req, res) => {
  if (!await pm.getProject(req.params.slug)) return res.status(404).json({ detail: 'Project not found' })
  res.json({
    platforms: [
      { id: 'youtube', label: 'YouTube', enabled: true, requires_oauth_client: true },
      { id: 'tiktok', label: 'TikTok', enabled: false, requires_oauth_client: true, coming_soon: 'TikTok Content Posting API integration is planned for v2.' },
      { id: 'facebook', label: 'Facebook Pages', enabled: false, requires_oauth_client: true, coming_soon: 'Facebook page upload integration is planned for v2.' },
    ],
  })
})

// ── OAuth client (client_id + client_secret) CRUD ─────────────────────────
// The client_secret is returned masked on GET — never the raw value. Saving
// re-writes both fields; clearing (empty strings) deletes the record.

router.get('/projects/:slug/upload/oauth-client', async (req, res) => {
  try {
    const slug = req.params.slug
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const platform = readPlatform(req.query.platform)
    if (!platform) return res.status(400).json({ detail: 'platform query param required' })
    const creds = await store.readOAuthClient(slug, platform)
    if (!creds) return res.json({ configured: false })
    res.json({
      configured: true,
      client_id: creds.client_id,
      client_secret_masked: maskSecret(creds.client_secret),
    })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to read OAuth client'))
  }
})

router.put('/projects/:slug/upload/oauth-client', async (req, res) => {
  try {
    const slug = req.params.slug
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const platform = readPlatform(req.body?.platform)
    if (!platform) return res.status(400).json({ detail: 'platform required' })
    const client_id = typeof req.body?.client_id === 'string' ? req.body.client_id.trim() : ''
    const client_secret = typeof req.body?.client_secret === 'string' ? req.body.client_secret.trim() : ''
    if (!client_id || !client_secret) {
      return res.status(400).json({ detail: 'client_id and client_secret both required' })
    }
    await store.writeOAuthClient(slug, platform, { client_id, client_secret })
    res.json({ ok: true })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to save OAuth client'))
  }
})

router.delete('/projects/:slug/upload/oauth-client', async (req, res) => {
  try {
    const slug = req.params.slug
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const platform = readPlatform(req.query.platform)
    if (!platform) return res.status(400).json({ detail: 'platform query param required' })
    await store.deleteOAuthClient(slug, platform)
    res.json({ ok: true })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to delete OAuth client'))
  }
})

// ── OAuth flow ────────────────────────────────────────────────────────────

router.post('/projects/:slug/upload/oauth/start', async (req, res) => {
  try {
    const slug = req.params.slug
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const platform = readPlatform(req.body?.platform)
    if (!platform) return res.status(400).json({ detail: 'platform required' })
    if (platform !== 'youtube') {
      return res.status(400).json({ detail: `${platform} upload is not enabled yet.` })
    }
    const creds = await store.readOAuthClient(slug, platform)
    if (!creds) return res.status(400).json({ detail: 'OAuth client is not configured. Save your Google Cloud client_id + client_secret first.' })

    const state = await startOAuthFlow({
      client_id: creds.client_id,
      client_secret: creds.client_secret,
    })
    // Resolve promise in the background — success triggers the account
    // record write so GET /accounts reflects it on the user's next poll.
    state.promise.then(async (result) => {
      const account = await store.addAccount(slug, 'youtube', {
        label: result.channel.channel_title,
        remote_id: result.channel.channel_id,
        remote_title: result.channel.channel_title,
        custom_url: result.channel.custom_url,
        thumbnail_url: result.channel.thumbnail_url,
      })
      await store.writeTokens(slug, 'youtube', account.id, result.tokens)
    }).catch(() => { /* surfaced via getFlowStatus */ })

    res.json({ flow_id: state.flow_id, auth_url: state.auth_url })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to start OAuth flow'))
  }
})

router.get('/projects/:slug/upload/oauth/status', async (req, res) => {
  try {
    const slug = req.params.slug
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const flow_id = typeof req.query.flow_id === 'string' ? req.query.flow_id : ''
    if (!flow_id) return res.status(400).json({ detail: 'flow_id query param required' })
    const s = getFlowStatus(flow_id)
    if (s.status === 'success') {
      // Don't leak the raw tokens back to the client. Return the channel
      // metadata only — the frontend re-fetches /accounts to see the new
      // row. Tokens stay in secrets.json.
      res.json({
        status: 'success',
        channel: s.result.channel,
      })
    } else {
      res.json(s)
    }
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to read flow status'))
  }
})

// ── Connected accounts ────────────────────────────────────────────────────

router.get('/projects/:slug/upload/accounts', async (req, res) => {
  try {
    const slug = req.params.slug
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const accounts = await store.listAllAccounts(slug)
    const defaults: Record<string, string> = {}
    for (const p of store.UPLOAD_PLATFORMS) {
      defaults[p] = await store.getDefaultAccountId(slug, p)
    }
    res.json({ accounts, defaults })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to list accounts'))
  }
})

router.put('/projects/:slug/upload/accounts/:id/default', async (req, res) => {
  try {
    const slug = req.params.slug
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const platform = readPlatform(req.body?.platform)
    if (!platform) return res.status(400).json({ detail: 'platform required' })
    await store.setDefaultAccountId(slug, platform, req.params.id)
    res.json({ ok: true })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to set default account'))
  }
})

router.delete('/projects/:slug/upload/accounts/:id', async (req, res) => {
  try {
    const slug = req.params.slug
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const platform = readPlatform(req.query.platform)
    if (!platform) return res.status(400).json({ detail: 'platform query param required' })
    const removed = await store.removeAccount(slug, platform, req.params.id)
    if (!removed) return res.status(404).json({ detail: 'Account not found' })
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
const QUEUE_INDEX_TTL_MS = 5 * 60_000
type QueueIndexItem = {
  id: string
  type: 'episode' | 'import'
  episode_code: string
  filename?: string
  title: string                 // best-effort: idea title or filename, no metadata read
  uploaded: boolean
  video_id: string
  scheduled_for: string | null
  schedule_source: 'synced' | 'planned' | 'none'
  position: number | null
  // Carried into stage 2 — saves re-reading the sidecar.
  _sidecar: any
  _ideaTitle: string
}
const queueIndexCache = new Map<string, { ts: number; items: QueueIndexItem[] }>()
function queueCacheKey(slug: string, platform: string) { return `${slug}:${platform}` }

// Stage 1: the cheap index. Reads the per-episode sidecar (one small
// JSON file each) but skips computeEpisodeStatus + resolveUploadMetadata.
// Episode-has-video is determined cheaply by checking if any video file
// path exists for the episode (still file-IO, but a single existsSync per
// episode rather than the full status walk).
async function buildQueueIndex(slug: string, platform: store.UploadPlatform): Promise<QueueIndexItem[]> {
  const ideas = await im.getIdeas(slug, 'accepted')
  const itemSchedule = await plans.readItemSchedule(slug)
  const sequence = await uq.readSequence(slug)
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
      // sidecar in parallel. Sidecar tells us if it's uploaded; if so,
      // the local file might be deleted but the episode still belongs in
      // the queue (re-upload PATCHes metadata).
      const [hasFinal, sidecar] = await Promise.all([
        hasFinalVideoFast(slug, code, idea.title || ''),
        readSidecar(slug, code, idea.title || '', platform),
      ])
      const inQueue = hasFinal || !!sidecar?.video_id
      if (!inQueue) continue
      const scheduled_for = sidecar?.scheduled_for || itemSchedule[code] || null
      items.push({
        id: `ep:${code}`,
        type: 'episode',
        episode_code: code,
        title: idea.title || code,    // cheap title; enriched in stage 2
        uploaded: !!sidecar?.video_id,
        video_id: sidecar?.video_id || '',
        scheduled_for,
        schedule_source: sidecar?.scheduled_for ? 'synced' : (itemSchedule[code] ? 'planned' : 'none'),
        position: typeof sequence[`ep:${code}`] === 'number' ? sequence[`ep:${code}`] : null,
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
        video_id: '',
        scheduled_for: itemSchedule[d.id] || null,
        schedule_source: itemSchedule[d.id] ? 'planned' : 'none',
        position: d.position,
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
      video_id: item.video_id,
      video_url: item.video_id ? `https://youtu.be/${item.video_id}` : '',
      privacy_status: sidecar?.privacy_status || null,
      scheduled_for: item.scheduled_for,
      schedule_source: item.schedule_source,
      last_sync_at: sidecar?.last_sync_at || '',
      account_id: sidecar?.account_id || '',
      position: item.position,
      final_video_bytes: finalVideoBytes,
    }
  }))
  return out
}

// Filter buckets (matches the frontend toolbar). 'failed' isn't tracked
// per-item today — we only know if there's an active failed job, which
// the frontend handles. So the backend filter for 'failed' returns []
// (the frontend can derive its own from job state).
type QueueFilter = 'all' | 'not_uploaded' | 'uploaded' | 'scheduled' | 'failed'
type QueueSort = 'code_asc' | 'code_desc' | 'status' | 'scheduled_asc' | 'scheduled_desc'

function filterAndSortIndex(items: QueueIndexItem[], filter: QueueFilter, sort: QueueSort): QueueIndexItem[] {
  let out: QueueIndexItem[] = items
  if (filter === 'not_uploaded') out = out.filter(i => !i.uploaded)
  else if (filter === 'uploaded') out = out.filter(i => i.uploaded)
  else if (filter === 'scheduled') out = out.filter(i => !!i.scheduled_for)
  else if (filter === 'failed') out = []   // job-failed state isn't tracked at this layer; UI handles it
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
    case 'scheduled_desc': out.sort((a, b) => cmpScheduled(b, a)); break
    case 'status':
      out.sort((a, b) => {
        const rank = (i: QueueIndexItem) => i.uploaded ? 0 : (i.scheduled_for ? 1 : 2)
        const r = rank(a) - rank(b)
        return r !== 0 ? r : cmpCode(a, b)
      })
      break
  }
  return out
}

router.get('/projects/:slug/upload/queue', async (req, res) => {
  try {
    const slug = req.params.slug
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const platform = readPlatform(req.query.platform) || 'youtube'

    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1)
    const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.page_size || '10'), 10) || 10))
    const filter = (String(req.query.filter || 'all') as QueueFilter)
    const sort = (String(req.query.sort || 'code_asc') as QueueSort)
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

    const filtered = filterAndSortIndex(index, filter, sort)
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

// Kick off an upload. Either starts a fresh resumable upload or queues a
// metadata-only update depending on sidecar state (see job executor).
router.post('/projects/:slug/upload/upload', async (req, res) => {
  try {
    const slug = req.params.slug
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const platform = readPlatform(req.body?.platform) || 'youtube'
    if (platform !== 'youtube') return res.status(400).json({ detail: `${platform} upload is not enabled yet.` })
    const episode_id: string = typeof req.body?.episode_id === 'string' ? req.body.episode_id : ''
    if (!episode_id) return res.status(400).json({ detail: 'episode_id required' })

    // Pick account: explicit > default.
    const account_id = typeof req.body?.account_id === 'string' && req.body.account_id
      ? req.body.account_id
      : (await store.getDefaultAccountId(slug, 'youtube'))
    if (!account_id) {
      return res.status(400).json({ detail: 'No YouTube account connected. Open Upload Center → Accounts and connect a channel first.' })
    }

    if (jq.isDuplicate(slug, episode_id, 'youtube_upload' as JobType)) {
      return res.status(409).json({ detail: `YouTube upload already queued/running for ${episode_id}` })
    }

    // Schedule resolution: explicit body > per-item plan schedule > null.
    // Preserves the plan-computed time without requiring the UI to send it
    // every single click.
    let scheduled_for: string | null = typeof req.body?.scheduled_for === 'string' ? req.body.scheduled_for : null
    if (!scheduled_for) {
      const itemSchedule = await plans.readItemSchedule(slug)
      if (itemSchedule[episode_id]) scheduled_for = itemSchedule[episode_id]
    }
    const privacy_status = typeof req.body?.privacy_status === 'string' ? req.body.privacy_status : 'private'
    // preserve_status routes through to the executor's metadata-only branch.
    // `true` = leave YouTube's existing privacy + publishAt alone (the safe
    // default for "↻ Update metadata" clicks on already-uploaded rows).
    // `false` (or unset) = old behavior: re-push privacy/publishAt from the
    // request, which is correct for fresh uploads that need to declare a
    // privacyStatus. Frontend defaults to true when item.uploaded.
    const preserve_status = req.body?.preserve_status === true
    // Per-upload playlist override (A5). Sentinel `_none_` means skip the
    // project default; empty/null/missing means "use project default (if any)".
    const playlist_id = typeof req.body?.playlist_id === 'string' ? req.body.playlist_id : null

    // Surface quota issues BEFORE the job enters the queue — nicer than
    // having the user watch it start, then instantly fail. The executor
    // re-checks inside uploadVideo so a slow-running queue doesn't let
    // stale snapshots through, but this pre-check catches the common case.
    try {
      await quota.checkQuota(slug, 'videos_insert')
    } catch (e: any) {
      if (e?.name === 'QuotaExceededError') {
        return res.status(429).json({
          detail: e.message,
          quota: e.snapshot,
        })
      }
      throw e
    }

    const job = jq.enqueue({
      project_slug: slug,
      type: 'youtube_upload' as JobType,
      episode_id,
      title: `YouTube upload — ${episode_id}`,
      params: { episode_id, account_id, scheduled_for, privacy_status, playlist_id, preserve_status },
    })
    res.status(201).json(job)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to queue upload'))
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
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const platform = readPlatform(req.body?.platform) || 'youtube'
    if (platform !== 'youtube') return res.status(400).json({ detail: `${platform} playlist update is not enabled yet.` })
    const episode_id: string = typeof req.body?.episode_id === 'string' ? req.body.episode_id : ''
    if (!episode_id) return res.status(400).json({ detail: 'episode_id required' })

    const account_id = typeof req.body?.account_id === 'string' && req.body.account_id
      ? req.body.account_id
      : (await store.getDefaultAccountId(slug, 'youtube'))
    if (!account_id) {
      return res.status(400).json({ detail: 'No YouTube account connected. Open Upload Center → Accounts and connect a channel first.' })
    }

    if (jq.isDuplicate(slug, episode_id, 'youtube_playlist_update' as JobType)) {
      return res.status(409).json({ detail: `Playlist update already queued/running for ${episode_id}` })
    }

    // Same body shape as /upload/upload's playlist override: empty/null
    // means "use project default", `_none_` is a no-op short-circuit
    // handled in the generator. Any other string is a literal playlist id.
    const playlist_id = typeof req.body?.playlist_id === 'string' ? req.body.playlist_id : null

    const job = jq.enqueue({
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

// ── Plans CRUD ────────────────────────────────────────────────────────────

router.get('/projects/:slug/upload/plans', async (req, res) => {
  try {
    const slug = req.params.slug
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
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
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
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
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
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
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
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
router.post('/projects/:slug/upload/plans/:id/preview', async (req, res) => {
  try {
    const slug = req.params.slug
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const plan = await plans.getPlan(slug, req.params.id)
    if (!plan) return res.status(404).json({ detail: 'Plan not found' })
    const count = Math.max(1, Math.min(500, Number(req.body?.count) || 10))
    const slots = plans.computeSlots(plan.schedule, count)
    const now = Date.now()
    const past_slots = slots.filter(s => new Date(s).getTime() < now - 60_000)
    res.json({ slots, past_slots, has_past_slots: past_slots.length > 0 })
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
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
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

    const episode_codes: string[] = Array.isArray(req.body?.episode_codes)
      ? req.body.episode_codes.filter((c: any) => typeof c === 'string' && c)
      : []
    if (!episode_codes.length) return res.status(400).json({ detail: 'episode_codes (ordered) required' })

    const slots = plans.computeSlots(plan.schedule, episode_codes.length)

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

    // Persist in-memory plan → per-item schedule map.
    const existing = await plans.readItemSchedule(slug)
    const nextMap = { ...existing }
    for (const a of assignments) nextMap[a.episode_code] = a.publishAt
    await plans.writeItemSchedule(slug, nextMap)

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
    const patched: Array<{ episode_code: string; video_id: string; ok: boolean; error?: string }> = []
    // PATCH calls stay sequential — they hit YouTube's API and benefit
    // from natural rate limiting; per-row error reporting also expects
    // ordered execution.
    for (const a of assignments) {
      const idea = ideaByCode.get(a.episode_code)
      if (!idea) continue
      const sidecar = sidecarsByCode.get(a.episode_code) || null
      if (!sidecar?.video_id) continue
      try {
        const meta = await resolveUploadMetadata({
          slug, episode_code: a.episode_code, fallback_title: idea.title, platform: plan.platform,
        })
        await updateVideoMetadata({
          slug,
          accountId: plan.account_id,
          videoId: sidecar.video_id,
          snippet: snippetFromMeta(meta),
          status: { privacyStatus: plan.defaults.privacy_status, publishAt: a.publishAt },
        })
        // Refresh sidecar's scheduled_for so the queue view reflects the
        // new time without waiting for the next manual upload action.
        const { writeSidecar } = await import('../services/upload-sidecar.js')
        await writeSidecar(slug, a.episode_code, idea.title || '', {
          ...sidecar,
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
    await plans.setActivePlanId(slug, plan.platform, plan.account_id, plan.id)

    res.json({ assignments, patched })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to apply plan'))
  }
})

// ── Import folder + scan (Phase 4) ────────────────────────────────────────

router.post('/projects/:slug/upload/imports/scan', async (req, res) => {
  try {
    const slug = req.params.slug
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const result = await uq.scanImports(slug)
    res.json(result)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Scan failed'))
  }
})

router.put('/projects/:slug/upload/imports/:filename/meta', async (req, res) => {
  try {
    const slug = req.params.slug
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
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
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
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
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
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
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
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
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
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
// tolerance. Busted on legacy-uploaded changes (see endpoints below).
const MISSING_VIDEO_TTL_MS = 5 * 60_000
const missingVideoCache = new Map<string, { ts: number; episodes: Array<{ episode_code: string; title: string }> }>()

router.get('/projects/:slug/upload/missing-video', async (req, res) => {
  try {
    const slug = req.params.slug
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
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

// Mark / unmark an episode as "already uploaded elsewhere" — used for
// legacy episodes (uploaded to YouTube years before Story Studio, where
// no video file exists locally). Just a flag; no URL needed because the
// names on YouTube vs on disk often differ enough that linking them
// wouldn't be reliable. Reversible via { mark: false }.
router.post('/projects/:slug/upload/mark-legacy-uploaded', async (req, res) => {
  try {
    const slug = req.params.slug
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const episodeCode = typeof req.body?.episode_code === 'string' ? req.body.episode_code.trim() : ''
    if (!episodeCode) return res.status(400).json({ detail: 'episode_code is required' })
    const mark = req.body?.mark !== false   // default true; pass false to unmark

    const config = await pm.getConfig(slug) as any
    const current: Record<string, boolean> = (config?.youtube_legacy_uploaded || {})
    if (mark) current[episodeCode] = true
    else delete current[episodeCode]

    await pm.updateConfig(slug, { youtube_legacy_uploaded: current } as any)
    // Bust the queue cache so the next /upload/queue call sees the change.
    queueIndexCache.delete(queueCacheKey(slug, 'youtube'))
    res.json({ ok: true, marked: mark, episode_code: episodeCode, total_legacy: Object.keys(current).length })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to update legacy-uploaded flag'))
  }
})

// Bulk variant — takes an array of episode_codes. Cheaper than N round-trips
// when the user has 50+ legacy episodes to mark in one go.
router.post('/projects/:slug/upload/mark-legacy-uploaded-bulk', async (req, res) => {
  try {
    const slug = req.params.slug
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const codes = Array.isArray(req.body?.episode_codes) ? req.body.episode_codes.filter((c: any) => typeof c === 'string' && c.trim()) : []
    if (!codes.length) return res.status(400).json({ detail: 'episode_codes (array) is required' })
    const mark = req.body?.mark !== false

    const config = await pm.getConfig(slug) as any
    const current: Record<string, boolean> = (config?.youtube_legacy_uploaded || {})
    for (const code of codes) {
      if (mark) current[code.trim()] = true
      else delete current[code.trim()]
    }
    await pm.updateConfig(slug, { youtube_legacy_uploaded: current } as any)
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
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
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
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const account_id = typeof req.body?.account_id === 'string' && req.body.account_id
      ? req.body.account_id
      : (await store.getDefaultAccountId(slug, 'youtube'))
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
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const account_id = typeof req.body?.account_id === 'string' && req.body.account_id
      ? req.body.account_id
      : (await store.getDefaultAccountId(slug, 'youtube'))
    if (!account_id) return res.status(400).json({ detail: 'No YouTube account connected.' })
    const links = Array.isArray(req.body?.links) ? req.body.links : []
    const valid = links.filter((l: any) =>
      typeof l?.episode_code === 'string' && l.episode_code
      && typeof l?.video_id === 'string' && l.video_id,
    )
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
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const accountId = typeof req.query.account_id === 'string' && req.query.account_id
      ? req.query.account_id
      : await store.getDefaultAccountId(slug, 'youtube')
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
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const accountId = typeof req.body?.account_id === 'string' && req.body.account_id
      ? req.body.account_id
      : await store.getDefaultAccountId(slug, 'youtube')
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
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const accountId = typeof req.body?.account_id === 'string' && req.body.account_id
      ? req.body.account_id
      : await store.getDefaultAccountId(slug, 'youtube')
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
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
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
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
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
        const meta = await resolveUploadMetadata({ slug, episode_code: code, fallback_title: idea.title, platform: 'youtube' })
        await updateVideoMetadata({
          slug,
          accountId: sidecar.account_id,
          videoId: sidecar.video_id,
          snippet: snippetFromMeta(meta),
          status: { privacyStatus: 'private', publishAt: publish_at },
        })
        // Refresh sidecar so the queue shows the new time immediately.
        const { writeSidecar } = await import('../services/upload-sidecar.js')
        await writeSidecar(slug, code, idea.title || '', {
          ...sidecar,
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
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
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
        const meta = await resolveUploadMetadata({ slug, episode_code: code, fallback_title: idea.title, platform: 'youtube' })
        await updateVideoMetadata({
          slug,
          accountId: sidecar.account_id,
          videoId: sidecar.video_id,
          snippet: snippetFromMeta(meta),
          // No publishAt → video detaches from its scheduled publish. Privacy
          // is either 'private' (for YT-Studio hand-off) or 'public' (go live now).
          status: { privacyStatus: make },
        })
        const { writeSidecar } = await import('../services/upload-sidecar.js')
        await writeSidecar(slug, code, idea.title || '', {
          ...sidecar,
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
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })

    const accountId = await store.getDefaultAccountId(slug, 'youtube')
    if (!accountId) return res.status(400).json({ detail: 'No default YouTube account set for this project.' })

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
      // Only sync rows that belong to the *currently active* account —
      // calling videos.list with someone else's tokens would 404 those ids.
      if (sidecar.account_id && sidecar.account_id !== accountId) return
      rows.push({ code: idea.episode_code!, idea, sidecar: sidecar as Row['sidecar'] })
    })

    if (!rows.length) {
      return res.json({ checked: 0, updated: 0, drift: [], errors: [] })
    }

    const liveById = await listVideoStatuses(slug, accountId, rows.map(r => r.sidecar.video_id))

    const drift: Array<{ episode_code: string; video_id: string; before: { privacy_status: string; scheduled_for: string | null }; after: { privacy_status: string; scheduled_for: string | null } }> = []
    const errors: Array<{ episode_code: string; error: string }> = []
    let updated = 0
    const { writeSidecar } = await import('../services/upload-sidecar.js')

    for (const r of rows) {
      const live = liveById[r.sidecar.video_id]
      if (!live) {
        // Video missing from YouTube's response — could be deleted or no
        // longer accessible. Don't touch the sidecar (preserves history).
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
      } catch (e: any) {
        errors.push({ episode_code: r.code, error: e?.message || 'Sidecar write failed' })
      }
    }

    // Drop the queue cache so the next page load surfaces the updated
    // sidecars without waiting out the 5-min TTL.
    if (updated > 0) queueIndexCache.delete(queueCacheKey(slug, 'youtube'))

    res.json({ checked: rows.length, updated, drift, errors })
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
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
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
          const meta = await resolveUploadMetadata({ slug, episode_code: code, fallback_title: idea.title, platform: 'youtube' })
          await updateVideoMetadata({
            slug,
            accountId: sidecar.account_id,
            videoId: sidecar.video_id,
            snippet: snippetFromMeta(meta),
            status: { privacyStatus: 'private' },
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

function maskSecret(s: string): string {
  if (!s) return ''
  if (s.length <= 8) return '••••'
  return `${s.slice(0, 4)}••••${s.slice(-4)}`
}
