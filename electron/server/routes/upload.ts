/**
 * The older `/projects/:slug/upload/*` endpoints that the app still calls:
 * accounts (+ avatar), playlists, YouTube categories and backfill, upload
 * plans, and the renumber-undo banner. Everything else the Upload Center
 * does lives in `routes/youtube-upload-center.ts` (`/youtube/*`); the
 * legacy queue, import, orphan, reconcile, OAuth and schedule endpoints
 * were removed once nothing called them (dead-feature sweep, 2026-10).
 */

import { Router } from 'express'
import path from 'path'
import * as pm from '../services/project-manager.js'
import * as im from '../services/idea-manager.js'
import * as store from '../services/upload-store.js'
import { resolveYouTubeAccountId, resolveYouTubeCredential } from '../services/youtube-credential.js'
import { readYouTubeConnectionRegistry } from '../services/youtube-connection-store.js'
import { readSidecarStrict } from '../services/upload-sidecar.js'
import * as plans from '../services/upload-plans.js'
import * as playlistsSvc from '../services/upload-playlists.js'
import * as renumberUndo from '../services/upload-renumber-undo.js'
import { updateVideoMetadata, listVideoSnippetStatus } from '../lib/youtube-client.js'
import { getYoutubeDefaults } from '../services/app-settings.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'
import { fetchYouTubeChannelAvatar } from '../lib/youtube-channel-avatar.js'
import { listYouTubeOperations } from '../services/youtube-operation-store.js'
import { readYouTubeProjectPublishingState } from '../services/youtube-project-publishing-store.js'

async function resolveRequestedYouTubeAccountId(slug: string, raw: unknown): Promise<string> {
  const requested = typeof raw === 'string' && raw.trim() ? raw.trim() : undefined
  return resolveYouTubeAccountId(slug, requested)
}

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

// The retired per-project preview/upload pair was removed. The confirmed
// /youtube/upload route owns upload preview and enqueueing.

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

// ── The channel's one schedule (v1.4.249) ─────────────────────────────────
// Settings → Publishing and Upload Center → Plans both read and write this:
// once a channel is assigned it IS the channel's active upload plan, shown by
// name. See services/publish-cadence.ts.

router.get('/projects/:slug/publishing-schedule', async (req, res) => {
  try {
    if (!await pm.getProject(req.params.slug)) return res.status(404).json({ detail: 'Project not found' })
    const { readChannelSchedule } = await import('../services/publish-cadence.js')
    res.json(await readChannelSchedule(req.params.slug))
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to read the publishing schedule'))
  }
})

router.put('/projects/:slug/publishing-schedule', async (req, res) => {
  try {
    if (!await pm.getProject(req.params.slug)) return res.status(404).json({ detail: 'Project not found' })
    const body = req.body || {}
    if (!body.schedule || typeof body.schedule !== 'object') return res.status(400).json({ detail: 'schedule required' })
    const { saveChannelSchedule } = await import('../services/publish-cadence.js')
    res.json(await saveChannelSchedule(req.params.slug, {
      schedule: body.schedule,
      name: typeof body.name === 'string' ? body.name : undefined,
      auto_schedule_on_render: typeof body.auto_schedule_on_render === 'boolean' ? body.auto_schedule_on_render : undefined,
    }))
  } catch (e: any) {
    const status = e?.statusCode === 400 || e?.status === 400 ? 400 : 500
    res.status(status).json(status === 400 ? { detail: e.message } : humanizeBackendError(e, 'Failed to save the publishing schedule'))
  }
})

// ── Plans CRUD ────────────────────────────────────────────────────────────

router.get('/projects/:slug/upload/plans', async (req, res) => {
  try {
    const slug = req.params.slug
    const list = await plans.listPlans(slug)
    // Active pointers keyed by `${platform}:${account_id}`.
    const cfg = (await pm.getConfig(slug)) as any
    // Bindings to plans that no longer exist are not shown (1.4.280).
    res.json({ plans: list, active: plans.liveActiveMap(cfg?.upload_plan_active, list) })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to list plans'))
  }
})

router.post('/projects/:slug/upload/plans', async (req, res) => {
  try {
    const slug = req.params.slug
    const body = req.body || {}
    const { name, platform, account_id, schedule, defaults, id } = body
    if (!readPlatform(platform)) return res.status(400).json({ detail: 'platform required' })
    const validationError = plans.validateUploadPlanDraft(body)
    if (validationError) return res.status(400).json({ detail: validationError })

    const normalizedName = name.trim()
    const normalizedAccountId = account_id.trim()
    const existing = id ? await plans.getPlan(slug, id) : null
    if (id && !existing) return res.status(404).json({ detail: 'Plan not found' })
    if (existing && (existing.account_id !== normalizedAccountId || existing.platform !== platform)) {
      return res.status(409).json({ detail: 'An existing plan cannot be retargeted to another account or platform' })
    }
    // YouTube plans may only be saved while their account is represented by
    // the project's current channel assignment. This keeps a channel switch
    // from allowing an old plan to be edited behind the editor's back.
    if (platform === 'youtube' && !(await resolveYouTubeAccountId(slug, normalizedAccountId))) {
      return res.status(409).json({ detail: 'account_id must match the project YouTube account' })
    }
    const plan = await plans.upsertPlan(slug, {
      id,
      name: normalizedName,
      platform,
      account_id: normalizedAccountId,
      schedule,
      defaults,
    })
    // v1.4.249 — Settings shows this same plan; keep the channel's seed equal to it.
    const { mirrorPlanToCadence } = await import('../services/publish-cadence.js')
    await mirrorPlanToCadence(slug, plan)
    res.json({ plan })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to save plan'))
  }
})

router.put('/projects/:slug/upload/plans/:id/active', async (req, res) => {
  try {
    const slug = req.params.slug
    const plan = await plans.getPlan(slug, req.params.id)
    if (!plan) return res.status(404).json({ detail: 'Plan not found' })
    if (plan.platform === 'youtube' && !(await resolveYouTubeAccountId(slug, plan.account_id))) {
      return res.status(409).json({ detail: 'Plan account no longer matches the project YouTube account' })
    }
    await plans.setActivePlanId(slug, plan.platform, plan.account_id, plan.id)
    const { mirrorPlanToCadence } = await import('../services/publish-cadence.js')
    await mirrorPlanToCadence(slug, plan)
    res.json({ ok: true })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to activate plan'))
  }
})

// 1.4.280 — restored. Removed with the legacy /upload/* routes in 1.4.249
// because the Upload Center no longer had a delete button.
router.delete('/projects/:slug/upload/plans/:id', async (req, res) => {
  try {
    const slug = req.params.slug
    const plan = await plans.getPlan(slug, req.params.id)
    if (!plan) return res.status(404).json({ detail: 'Plan not found' })
    const assigned = plan.platform === 'youtube' ? await resolveYouTubeAccountId(slug) : ''
    if (assigned && plan.account_id === assigned && await plans.getActivePlanId(slug, 'youtube', assigned) === plan.id) {
      return res.status(409).json({ detail: 'This is the active plan for the project YouTube channel. Make another plan active first.' })
    }
    if (!await plans.removePlan(slug, plan.id)) return res.status(404).json({ detail: 'Plan not found' })
    res.json({ ok: true })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to delete plan'))
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

// ── Helpers ───────────────────────────────────────────────────────────────

function readPlatform(raw: any): store.UploadPlatform | null {
  if (typeof raw !== 'string') return null
  return (store.UPLOAD_PLATFORMS as readonly string[]).includes(raw) ? (raw as store.UploadPlatform) : null
}
