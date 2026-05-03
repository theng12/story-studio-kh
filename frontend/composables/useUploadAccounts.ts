/**
 * Upload Center — accounts + OAuth client management.
 *
 * Phase 1 scope: list connected accounts, configure OAuth client credentials,
 * start an OAuth flow, poll for completion, disconnect accounts, change the
 * default-account pointer. Shared state is returned so the same data can be
 * read from multiple components without re-fetching.
 */

import { ref, computed } from 'vue'
import { useApi } from './useApi.js'

export type UploadPlatform = 'youtube' | 'tiktok' | 'facebook'

// Queue filter/sort buckets — match the backend's QueueFilter/QueueSort
// in electron/server/routes/upload.ts. Hoisted to module scope (not inside
// the composable) so they can be imported as types in component setup.
export type QueueFilter = 'all' | 'not_uploaded' | 'uploaded' | 'scheduled' | 'failed'
export type QueueSort = 'code_asc' | 'code_desc' | 'status' | 'scheduled_asc' | 'scheduled_desc'

export interface UploadAccount {
  id: string
  platform: UploadPlatform
  label: string
  remote_id: string
  remote_title: string
  custom_url?: string
  thumbnail_url?: string
  connected_at: string
}

export interface PlatformInfo {
  id: UploadPlatform
  label: string
  enabled: boolean
  requires_oauth_client: boolean
  coming_soon?: string
}

export interface ReconcileSuggestion {
  remote: { videoId: string; title: string; publishedAt: string; privacyStatus?: string }
  suggested_episode_code: string | null
  score: number
  reason: 'episode_code' | 'title_similarity' | 'none'
}

export interface ReconcilePreviewPayload {
  account_id: string
  remote_count: number
  local_count: number
  suggestions: ReconcileSuggestion[]
  already_linked: string[]
  /**
   * Reverse of `already_linked`: keys are YouTube videoIds, values are the
   * episode codes they're currently bound to. Lets the Reconcile table
   * mark a specific row as "🔗 Linked → EP001" rather than just showing a
   * count in the header.
   */
  linked_videos: Record<string, string>
}

interface ReconcilePreviewCacheEntry extends ReconcilePreviewPayload {
  fetched_at: number
}

const RECONCILE_TTL_MS = 10 * 60 * 1000
const reconcilePreviewCache = new Map<string, ReconcilePreviewCacheEntry>()
const reconcilePreviewState = ref<ReconcilePreviewCacheEntry | null>(null)
function reconcileCacheKey(slug: string, accountId: string) { return `${slug}:${accountId}` }

export interface OAuthClientStatus {
  configured: boolean
  client_id?: string
  client_secret_masked?: string
  /**
   * Populated when the status check itself failed (network blip, backend
   * 500, etc). Distinct from `configured: false`, which is an authoritative
   * "yes we checked, nothing is set." When `check_error` is set, the UI
   * should warn the operator that we don't know whether OAuth is
   * configured — silently treating the failure as "not configured" used
   * to make the operator think the credentials had been wiped on a
   * transient blip.
   */
  check_error?: string
}

export function useUploadAccounts(slug: string) {
  const { get, post, put, del } = useApi()

  const platforms = ref<PlatformInfo[]>([])
  const accounts = ref<Partial<Record<UploadPlatform, UploadAccount[]>>>({})
  const defaults = ref<Record<string, string>>({})
  const clientStatus = ref<Partial<Record<UploadPlatform, OAuthClientStatus>>>({})
  const loading = ref(false)

  async function loadPlatforms() {
    const r = await get<{ platforms: PlatformInfo[] }>(`/projects/${slug}/upload/platforms`)
    platforms.value = r.platforms || []
  }

  async function loadAccounts() {
    const r = await get<{ accounts: typeof accounts.value; defaults: Record<string, string> }>(`/projects/${slug}/upload/accounts`)
    accounts.value = r.accounts || {}
    defaults.value = r.defaults || {}
  }

  async function loadClientStatus(platform: UploadPlatform) {
    try {
      const r = await get<OAuthClientStatus>(`/projects/${slug}/upload/oauth-client?platform=${platform}`)
      clientStatus.value[platform] = r
    } catch (e: any) {
      // Preserve the failure rather than collapsing to "not configured" —
      // a transient backend blip used to make the operator think their
      // saved client_id had vanished, prompting them to paste it again.
      // The UI reads `check_error` and warns "couldn't verify" instead.
      clientStatus.value[platform] = {
        configured: false,
        check_error: e?.data?.detail || e?.message || 'Could not verify OAuth client status',
      }
    }
  }

  async function refreshAll() {
    loading.value = true
    try {
      await Promise.all([
        loadPlatforms(),
        loadAccounts(),
        loadClientStatus('youtube'),
      ])
      // Eagerly load playlists once accounts exist so the Queue tab's
      // default-playlist banner has the right data on first paint instead
      // of flashing "no default" until the user opens the Playlists tab.
      // 60s-cached on the backend so this is essentially free.
      if (youtubeAccounts.value.length) {
        loadPlaylists().catch(() => { /* fail-quiet — banner falls back to "no default" */ })
      }
    } finally {
      loading.value = false
    }
  }

  async function saveOAuthClient(platform: UploadPlatform, client_id: string, client_secret: string) {
    await put(`/projects/${slug}/upload/oauth-client`, { platform, client_id, client_secret })
    await loadClientStatus(platform)
  }

  async function clearOAuthClient(platform: UploadPlatform) {
    await del(`/projects/${slug}/upload/oauth-client?platform=${platform}`)
    await loadClientStatus(platform)
  }

  /**
   * Kick off the OAuth flow. Returns `{ flow_id, auth_url }` — caller is
   * responsible for opening the URL in the system browser (Electron's
   * shell.openExternal in packaged builds, window.open in dev).
   */
  async function startOAuthFlow(platform: UploadPlatform): Promise<{ flow_id: string; auth_url: string }> {
    return post<{ flow_id: string; auth_url: string }>(`/projects/${slug}/upload/oauth/start`, { platform })
  }

  /**
   * Poll the OAuth flow status. Resolves once terminal. Caller chooses the
   * poll cadence; 1500ms is a reasonable default (Google consent + redirect
   * typically takes 5-30s, longer when 2FA is involved).
   */
  async function waitForOAuthFlow(flow_id: string, opts: { intervalMs?: number; timeoutMs?: number } = {}): Promise<{ ok: boolean; error?: string }> {
    const interval = opts.intervalMs ?? 1500
    const timeout = opts.timeoutMs ?? 5 * 60 * 1000
    const start = Date.now()
    while (Date.now() - start < timeout) {
      const s = await get<any>(`/projects/${slug}/upload/oauth/status?flow_id=${flow_id}`)
      if (s.status === 'success') {
        await loadAccounts()
        return { ok: true }
      }
      if (s.status === 'error') return { ok: false, error: s.error || 'OAuth flow failed' }
      if (s.status === 'unknown') return { ok: false, error: 'Flow expired' }
      await new Promise(r => setTimeout(r, interval))
    }
    return { ok: false, error: 'Timeout waiting for OAuth flow to complete' }
  }

  async function removeAccount(account: UploadAccount) {
    await del(`/projects/${slug}/upload/accounts/${account.id}?platform=${account.platform}`)
    await loadAccounts()
  }

  async function setDefault(platform: UploadPlatform, account_id: string) {
    await put(`/projects/${slug}/upload/accounts/${account_id}/default`, { platform })
    await loadAccounts()
  }

  const youtubeAccounts = computed(() => accounts.value.youtube || [])

  // ── Queue + upload (Phase 2) ─────────────────────────────────────────
  // The queue endpoint is paginated server-side: it scans every accepted
  // idea for a final video which is the slow part on big projects (300+
  // episodes). We pass page/pageSize/filter/sort and the server caches
  // the full enriched list for 30s so navigating pages doesn't re-scan.
  // Bypass the cache by passing nocache: true (the Refresh button does this).
  const queueItems = ref<any[]>([])
  const queueLoading = ref(false)
  const queueTotal = ref(0)
  const queueTotalUnfiltered = ref(0)
  const queueTotalPages = ref(1)
  // Sticky last-used params so the many call sites that just call
  // `loadQueue('youtube')` to refresh continue to work — they implicitly
  // re-request the same page/filter/sort the user is currently viewing.
  const queueLastParams = {
    platform: 'youtube' as UploadPlatform,
    page: 1,
    pageSize: 10,
    filter: 'not_uploaded' as QueueFilter,   // default: hide uploaded items
    sort: 'code_asc' as QueueSort,
  }

  // Two call shapes for backwards compatibility:
  //   loadQueue('youtube')                     → legacy string form, refreshes with sticky params
  //   loadQueue({ filter: 'uploaded', page: 2 }) → new options form
  async function loadQueue(arg?: UploadPlatform | {
    platform?: UploadPlatform
    page?: number
    pageSize?: number
    filter?: QueueFilter
    sort?: QueueSort
    nocache?: boolean
  }) {
    const opts = typeof arg === 'string' ? { platform: arg } : (arg || {})
    if (opts.platform) queueLastParams.platform = opts.platform
    if (opts.page) queueLastParams.page = opts.page
    if (opts.pageSize) queueLastParams.pageSize = opts.pageSize
    if (opts.filter) queueLastParams.filter = opts.filter
    if (opts.sort) queueLastParams.sort = opts.sort
    queueLoading.value = true
    try {
      const qs = new URLSearchParams({
        platform: queueLastParams.platform,
        page: String(queueLastParams.page),
        page_size: String(queueLastParams.pageSize),
        filter: queueLastParams.filter,
        sort: queueLastParams.sort,
      })
      if (opts.nocache) qs.set('nocache', '1')
      const r = await get<{
        items: any[]
        total: number
        total_unfiltered: number
        page: number
        page_size: number
        total_pages: number
      }>(`/projects/${slug}/upload/queue?${qs}`)
      queueItems.value = r.items || []
      queueTotal.value = r.total ?? 0
      queueTotalUnfiltered.value = r.total_unfiltered ?? 0
      queueTotalPages.value = r.total_pages ?? 1
    } finally {
      queueLoading.value = false
    }
  }

  /**
   * Lightweight read of the FULL filtered/sorted queue, returning just the
   * ordered list of episode codes — no enrichment, no pagination. Used by
   * the Plans-tab scope pickers ("All unuploaded", "Next N from top") so
   * actions can target every matching episode regardless of which page
   * the user is currently viewing. Hits the same cache as `loadQueue`, so
   * back-to-back calls don't re-scan disk.
   */
  async function fetchQueueEpisodeCodes(opts: {
    platform?: UploadPlatform
    filter?: QueueFilter
    sort?: QueueSort
    nocache?: boolean
  } = {}): Promise<{ episode_codes: string[]; total: number; total_unfiltered: number }> {
    const qs = new URLSearchParams({
      platform: opts.platform || queueLastParams.platform,
      filter: opts.filter || queueLastParams.filter,
      sort: opts.sort || queueLastParams.sort,
      ids_only: '1',
    })
    if (opts.nocache) qs.set('nocache', '1')
    return get<{ episode_codes: string[]; total: number; total_unfiltered: number }>(
      `/projects/${slug}/upload/queue?${qs}`,
    )
  }

  // Mark / unmark an episode as "already uploaded elsewhere". Backend
  // also busts the queue cache so the missing-video list updates next
  // time it's fetched. Returns the new total count of legacy-flagged
  // episodes for any UI that wants to badge it.
  async function markLegacyUploaded(episode_code: string, mark = true) {
    return post<{ ok: true; marked: boolean; total_legacy: number }>(
      `/projects/${slug}/upload/mark-legacy-uploaded`,
      { episode_code, mark },
    )
  }
  async function markLegacyUploadedBulk(episode_codes: string[], mark = true) {
    return post<{ ok: true; marked: boolean; count: number; total_legacy: number }>(
      `/projects/${slug}/upload/mark-legacy-uploaded-bulk`,
      { episode_codes, mark },
    )
  }

  async function triggerUpload(opts: {
    episode_id: string
    platform?: UploadPlatform
    account_id?: string
    scheduled_for?: string | null
    privacy_status?: 'private' | 'unlisted' | 'public'
    /**
     * For metadata-only updates on already-uploaded rows: when true, the
     * backend omits the YouTube `status` block entirely so the existing
     * video's privacyStatus + publishAt stay exactly as they are. Set
     * by the per-row "↻ Update metadata" handler in upload.vue. Ignored
     * on fresh uploads (a new video must declare a privacyStatus).
     */
    preserve_status?: boolean
    /** Per-upload playlist override. `_none_` = skip even if default is set. Empty/null = use project default. */
    playlist_id?: string | null
  }) {
    // When preserve_status is set, deliberately skip privacy_status in the
    // request body so the backend's body parsing branch sees the absence
    // and doesn't fall back to its default 'private'. (The route already
    // honors preserve_status, but omitting privacy_status keeps the
    // request body honest about user intent — easier to debug from logs.)
    const body: Record<string, unknown> = {
      platform: opts.platform || 'youtube',
      episode_id: opts.episode_id,
      account_id: opts.account_id,
      scheduled_for: opts.scheduled_for ?? null,
      playlist_id: opts.playlist_id ?? null,
    }
    if (opts.preserve_status) {
      body.preserve_status = true
    } else {
      body.privacy_status = opts.privacy_status || 'private'
    }
    return post<{ job_id: string }>(`/projects/${slug}/upload/upload`, body)
  }

  /**
   * Metadata-only update for an already-uploaded row. Same endpoint as
   * triggerUpload (the backend branches on preserve_status), but distinct
   * here so the per-row Metadata button is unambiguous from the call site
   * — the request body always carries preserve_status: true regardless of
   * what privacy/schedule fields the row carries. Saves the caller from
   * remembering to opt out of every status-touching default.
   */
  async function triggerMetadataUpdate(opts: {
    episode_id: string
    platform?: UploadPlatform
    account_id?: string
  }) {
    return post<{ job_id: string }>(`/projects/${slug}/upload/upload`, {
      platform: opts.platform || 'youtube',
      episode_id: opts.episode_id,
      account_id: opts.account_id,
      preserve_status: true,
    })
  }

  /**
   * Playlist-only sync — adds the existing video to a playlist via the
   * dedicated `/upload/update-playlist` route. Add-only / idempotent;
   * never removes the video from playlists this app didn't track.
   * `playlist_id` semantics match the upload endpoint:
   *   - undefined / empty / null → use the project default
   *   - '_none_' → server treats as a no-op
   *   - explicit id → add to that playlist
   */
  async function triggerPlaylistUpdate(opts: {
    episode_id: string
    platform?: UploadPlatform
    account_id?: string
    playlist_id?: string | null
  }) {
    return post<{ job_id: string }>(`/projects/${slug}/upload/update-playlist`, {
      platform: opts.platform || 'youtube',
      episode_id: opts.episode_id,
      account_id: opts.account_id,
      playlist_id: opts.playlist_id ?? null,
    })
  }

  // ── Plans (Phase 3) ────────────────────────────────────────────────────
  const plans = ref<any[]>([])
  const activePlanMap = ref<Record<string, string>>({})
  const plansLoading = ref(false)

  async function loadPlans() {
    plansLoading.value = true
    try {
      const r = await get<{ plans: any[]; active: Record<string, string> }>(`/projects/${slug}/upload/plans`)
      plans.value = r.plans || []
      activePlanMap.value = r.active || {}
    } finally {
      plansLoading.value = false
    }
  }

  async function savePlan(plan: any) {
    const r = await post<{ plan: any }>(`/projects/${slug}/upload/plans`, plan)
    await loadPlans()
    return r.plan
  }

  async function deletePlan(id: string) {
    await del(`/projects/${slug}/upload/plans/${id}`)
    await loadPlans()
  }

  async function activatePlan(id: string) {
    await put(`/projects/${slug}/upload/plans/${id}/active`, {})
    await loadPlans()
  }

  async function previewPlan(id: string, count: number): Promise<string[]> {
    const r = await post<{ slots: string[] }>(`/projects/${slug}/upload/plans/${id}/preview`, { count })
    return r.slots || []
  }

  async function applyPlan(id: string, episode_codes: string[]): Promise<{
    assignments: Array<{ episode_code: string; publishAt: string }>
    patched: Array<{ episode_code: string; video_id: string; ok: boolean; error?: string }>
  }> {
    return post(`/projects/${slug}/upload/plans/${id}/apply`, { episode_codes })
  }

  async function clearItemSchedule(opts: {
    plan_id?: string
    sync_youtube?: boolean
    /**
     * Explicit episode codes to clear. When provided, takes precedence over
     * `plan_id` slot-recompute — the backend clears exactly these codes.
     * Used by the Plans-tab scope picker so Unapply hits the user's chosen
     * scope (Selection / All unuploaded / Next N / This page) instead of
     * approximating from current-queue slot positions.
     */
    episode_codes?: string[]
  } = {}) {
    const params = new URLSearchParams()
    if (opts.plan_id) params.set('plan_id', opts.plan_id)
    if (opts.sync_youtube) params.set('sync_youtube', '1')
    if (opts.episode_codes?.length) params.set('episode_codes', opts.episode_codes.join(','))
    const qs = params.toString()
    const url = `/projects/${slug}/upload/item-schedule${qs ? `?${qs}` : ''}`
    const r = await fetch(`/api${url}`, { method: 'DELETE' })
    if (!r.ok) {
      const body = await r.json().catch(() => ({ detail: 'clear failed' }))
      throw { data: body }
    }
    return r.json() as Promise<{ ok: true; cleared: number; patched: number; patch_errors: Array<{ episode_code: string; error: string }> }>
  }

  // ── Imports + scan (Phase 4) ─────────────────────────────────────────
  const importsFolder = ref<string>('')
  async function loadImportsFolder() {
    try {
      const r = await get<{ folder: string }>(`/projects/${slug}/upload/imports/folder`)
      importsFolder.value = r.folder || ''
    } catch { /* folder resolution is best-effort */ }
  }
  async function scanImports() {
    return post<{ folder: string; discovered: any[]; missing: any[] }>(`/projects/${slug}/upload/imports/scan`, {})
  }
  async function saveImportMeta(filename: string, meta: { title: string; description: string; tags: string[] }) {
    return put(`/projects/${slug}/upload/imports/${encodeURIComponent(filename)}/meta`, meta)
  }
  async function removeImport(filename: string, deleteFile = false) {
    const qs = deleteFile ? '?delete_file=1' : ''
    return del(`/projects/${slug}/upload/imports/${encodeURIComponent(filename)}${qs}`)
  }
  async function reorderSequence(ordered_ids: string[]) {
    return put(`/projects/${slug}/upload/sequence`, { ordered_ids })
  }

  // ── Per-episode Imported/ (Phase 5) ──────────────────────────────────
  const missingVideoEpisodes = ref<Array<{ episode_code: string; title: string }>>([])
  async function loadMissingVideoEpisodes() {
    try {
      const r = await get<{ episodes: typeof missingVideoEpisodes.value }>(`/projects/${slug}/upload/missing-video`)
      missingVideoEpisodes.value = r.episodes || []
    } catch { /* non-fatal */ }
  }
  async function scanEpisodeImports(code: string) {
    return post<{ moved: Array<{ from: string; to: string }>; skipped: string[]; imported_folder: string; target_folder: string }>(
      `/projects/${slug}/episodes/${encodeURIComponent(code)}/imported/scan`, {},
    )
  }
  async function getEpisodeImportFolder(code: string): Promise<string> {
    const r = await get<{ folder: string }>(`/projects/${slug}/episodes/${encodeURIComponent(code)}/imported/folder`)
    return r.folder || ''
  }
  async function revealFolder(folderPath: string) {
    return post('/system/reveal-folder', { path: folderPath })
  }

  // ── Reconcile (Phase 6) ──────────────────────────────────────────────
  async function reconcilePreview(account_id?: string) {
    return post<ReconcilePreviewPayload>(`/projects/${slug}/upload/reconcile/preview`, { account_id })
  }

  async function reconcileConfirm(account_id: string, links: Array<{ episode_code: string; video_id: string; remote_title?: string; published_at?: string }>) {
    return post<{ written: string[]; errors: Array<{ episode_code: string; error: string }> }>(
      `/projects/${slug}/upload/reconcile/confirm`, { account_id, links },
    )
  }

  // Cached reconcile preview — backs the Queue tab's "review & link" banner
  // and the Reconcile tab itself so they share a single fetch. TTL keeps
  // page-back navigation cheap; the manual "Fetch channel + preview" button
  // forces a fresh call.
  async function getCachedReconcilePreview(account_id?: string, opts: { force?: boolean } = {}) {
    const acctId = account_id || defaults.value.youtube || (accounts.value.youtube?.[0]?.id || '')
    if (!acctId) return null
    const key = reconcileCacheKey(slug, acctId)
    if (!opts.force) {
      const cached = reconcilePreviewCache.get(key)
      if (cached && Date.now() - cached.fetched_at < RECONCILE_TTL_MS) {
        reconcilePreviewState.value = cached
        return cached
      }
    }
    const r = await reconcilePreview(acctId)
    const payload: ReconcilePreviewCacheEntry = {
      account_id: r.account_id,
      remote_count: r.remote_count,
      local_count: r.local_count,
      already_linked: r.already_linked,
      // Defensive default for older backends that don't yet send linked_videos
      // — happens during dev when frontend is on this branch but Electron is
      // still running main. The chip falls back to "0 linked" gracefully.
      linked_videos: r.linked_videos || {},
      suggestions: r.suggestions,
      fetched_at: Date.now(),
    }
    reconcilePreviewCache.set(key, payload)
    reconcilePreviewState.value = payload
    return payload
  }

  function invalidateReconcilePreview(account_id?: string) {
    const acctId = account_id || defaults.value.youtube || ''
    if (!acctId) {
      reconcilePreviewCache.clear()
      reconcilePreviewState.value = null
      return
    }
    reconcilePreviewCache.delete(reconcileCacheKey(slug, acctId))
    if (reconcilePreviewState.value?.account_id === acctId) reconcilePreviewState.value = null
  }

  // ── Reset upload state (recalibrate after wrong-account upload) ──────
  async function resetUploadState(episode_code: string, platform: UploadPlatform = 'youtube') {
    return post<{ ok: true; had_sidecar: boolean; prior_video_id: string; prior_account_id: string }>(
      `/projects/${slug}/upload/queue/${encodeURIComponent(episode_code)}/reset`,
      { platform },
    )
  }

  // ── Per-item schedule ops (A2) ────────────────────────────────────────
  async function editSchedule(episode_code: string, publish_at: string) {
    const r = await fetch(`/api/projects/${slug}/upload/queue/${encodeURIComponent(episode_code)}/schedule`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publish_at }),
    })
    if (!r.ok) {
      const body = await r.json().catch(() => ({ detail: 'edit failed' }))
      throw { data: body }
    }
    return r.json() as Promise<{ ok: true; publish_at: string; patched: boolean; patch_error: string | null }>
  }

  // Pull current privacy + schedule from YouTube for every uploaded queue
  // row (or just the codes passed in) and rewrite local sidecars to match.
  // Used by the queue toolbar's "☁ Sync from YouTube" button to fix drift
  // caused by manual edits in YT Studio or videos that auto-published.
  async function syncQueueFromYoutube(episode_codes?: string[]) {
    const r = await post<{
      checked: number
      updated: number
      drift: Array<{ episode_code: string; video_id: string; before: { privacy_status: string; scheduled_for: string | null }; after: { privacy_status: string; scheduled_for: string | null } }>
      errors: Array<{ episode_code: string; error: string }>
    }>(`/projects/${slug}/upload/queue/sync-from-youtube`, episode_codes ? { episode_codes } : {})
    return r
  }

  async function unschedule(episode_code: string, make: 'private' | 'public') {
    const r = await fetch(`/api/projects/${slug}/upload/queue/${encodeURIComponent(episode_code)}/schedule`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ make }),
    })
    if (!r.ok) {
      const body = await r.json().catch(() => ({ detail: 'unschedule failed' }))
      throw { data: body }
    }
    return r.json() as Promise<{ ok: true; make: string; patched: boolean; patch_error: string | null }>
  }

  // ── Playlists (A4 + A5) ──────────────────────────────────────────────
  interface Playlist {
    id: string
    title: string
    description: string
    privacyStatus: 'public' | 'unlisted' | 'private'
    itemCount: number
  }
  const playlists = ref<Playlist[]>([])
  const defaultPlaylistId = ref<string>('')
  const playlistsLoading = ref(false)

  const playlistsError = ref<string>('')
  async function loadPlaylists(force = false) {
    playlistsLoading.value = true
    playlistsError.value = ''
    try {
      const r = await get<{ account_id: string; playlists: Playlist[]; default_playlist_id: string }>(
        `/projects/${slug}/upload/playlists${force ? '?force=1' : ''}`,
      )
      playlists.value = r.playlists || []
      defaultPlaylistId.value = r.default_playlist_id || ''
    } catch (e: any) {
      // Surface the backend detail (including stale-Electron "Cannot GET"
      // HTML → generic HTTP status) so the UI can show a helpful banner
      // instead of silently pretending nothing happened. Most common cause
      // here: user ran Batch A's routes via tsx-watch but didn't restart
      // the packaged Electron process, so the `/upload/playlists` route
      // returns 404 HTML from the SPA fallback.
      const status = e?.response?.status ?? e?.status
      const detail = e?.data?.detail || e?.message || ''
      playlistsError.value = status === 404
        ? 'Playlists endpoint not found on the server. Fully quit + relaunch Electron to pick up the latest code.'
        : `Failed to load playlists${status ? ` (HTTP ${status})` : ''}${detail ? `: ${detail}` : ''}`
    }
    playlistsLoading.value = false
  }

  async function createPlaylistFor(opts: { title: string; description?: string; privacyStatus?: 'public' | 'unlisted' | 'private' }) {
    const r = await post<{ playlist: Playlist }>(`/projects/${slug}/upload/playlists`, opts)
    await loadPlaylists(true)   // bypass cache
    return r.playlist
  }

  async function setDefaultPlaylist(playlist_id: string) {
    const r = await put<{ ok: true; account_id: string; playlist_id: string }>(`/projects/${slug}/upload/playlists/default`, { playlist_id })
    defaultPlaylistId.value = playlist_id
    return r
  }

  // ── Upload mode (apply-plan vs private-first) ───────────────────────
  const uploadMode = ref<'apply-plan' | 'private'>('apply-plan')
  async function loadUploadMode() {
    try {
      const r = await get<{ youtube: 'apply-plan' | 'private' }>(`/projects/${slug}/upload/mode`)
      uploadMode.value = r.youtube
    } catch { /* keep current */ }
  }
  async function setUploadModeFor(platform: UploadPlatform, mode: 'apply-plan' | 'private') {
    await put(`/projects/${slug}/upload/mode`, { platform, mode })
    if (platform === 'youtube') uploadMode.value = mode
  }

  // ── Orphan videos (#7) ───────────────────────────────────────────────
  interface OrphanVideo {
    videoId: string; title: string; publishedAt: string; privacyStatus?: string
  }
  const orphans = ref<OrphanVideo[]>([])
  const orphansNextNumber = ref<number>(1)
  const orphansAlreadyLinked = ref<string[]>([])
  const orphansError = ref<string>('')
  const orphansLoading = ref(false)

  async function loadOrphans() {
    orphansLoading.value = true
    orphansError.value = ''
    try {
      const r = await get<{
        account_id: string; orphans: OrphanVideo[];
        already_linked: string[]; next_episode_number: number; remote_total: number
      }>(`/projects/${slug}/upload/orphans`)
      orphans.value = r.orphans || []
      orphansNextNumber.value = r.next_episode_number || 1
      orphansAlreadyLinked.value = r.already_linked || []
    } catch (e: any) {
      const status = e?.response?.status ?? e?.status
      const detail = e?.data?.detail || e?.message || ''
      orphansError.value = status === 404
        ? 'Orphans endpoint not found on the server. Fully quit + relaunch Electron to pick up the latest code.'
        : `Failed to list orphans${status ? ` (HTTP ${status})` : ''}${detail ? `: ${detail}` : ''}`
    }
    orphansLoading.value = false
  }

  async function adoptSingleOrphan(video: OrphanVideo, episode_code: string) {
    return post<{ ok: true; adopted: { episode_code: string; video_id: string; idea_id: string } }>(
      `/projects/${slug}/upload/orphans/adopt-single`,
      { video, episode_code },
    )
  }

  async function adoptBulkOrphans(videos: OrphanVideo[], mode: 'continuation' | 'renumber') {
    return post<{
      ok: true; mode: string
      adopted: Array<{ episode_code: string; video_id: string; idea_id: string }>
      renamed?: Array<{ old_code: string; new_code: string; old_dir: string; new_dir: string }>
      errors: Array<{ video_id?: string; stage?: string; error?: string; detail?: string }>
    }>(`/projects/${slug}/upload/orphans/adopt-bulk`, { videos, mode })
  }

  // ── Quota status ─────────────────────────────────────────────────────
  const quota = ref<{
    used: number; ceiling: number; tracking_day: string; resets_at: string; warn_at: number; block_at: number; stale?: boolean
  } | null>(null)
  async function loadQuota() {
    try {
      quota.value = await get(`/projects/${slug}/upload/quota`)
    } catch { /* non-fatal */ }
  }
  async function setQuotaCeiling(ceiling: number) {
    quota.value = await put(`/projects/${slug}/upload/quota/ceiling`, { ceiling })
  }

  // 30s visibility-aware polling. The interval is paused while the tab is
  // hidden so we don't burn CPU + a network round-trip every 30s on a
  // backgrounded window. On resume we fire an immediate fetch so the chip
  // doesn't show up to 30s of staleness right after switching back.
  const QUOTA_POLL_MS = 30_000
  let quotaPollHandle: ReturnType<typeof setInterval> | null = null
  let visibilityHandler: (() => void) | null = null
  function startQuotaPolling() {
    if (typeof document === 'undefined') return // SSR safety
    stopQuotaPolling()
    loadQuota()
    const start = () => {
      if (quotaPollHandle != null) return
      quotaPollHandle = setInterval(() => { loadQuota() }, QUOTA_POLL_MS)
    }
    const stop = () => {
      if (quotaPollHandle != null) {
        clearInterval(quotaPollHandle)
        quotaPollHandle = null
      }
    }
    if (document.visibilityState !== 'hidden') start()
    visibilityHandler = () => {
      if (document.visibilityState === 'hidden') {
        stop()
      } else {
        loadQuota()
        start()
      }
    }
    document.addEventListener('visibilitychange', visibilityHandler)
  }
  function stopQuotaPolling() {
    if (quotaPollHandle != null) {
      clearInterval(quotaPollHandle)
      quotaPollHandle = null
    }
    if (visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', visibilityHandler)
      visibilityHandler = null
    }
  }

  return {
    platforms,
    accounts,
    defaults,
    clientStatus,
    loading,
    youtubeAccounts,
    queueItems,
    queueLoading,
    queueTotal,
    queueTotalUnfiltered,
    queueTotalPages,
    queueLastParams,
    markLegacyUploaded,
    markLegacyUploadedBulk,
    plans,
    activePlanMap,
    plansLoading,
    importsFolder,
    loadImportsFolder,
    scanImports,
    saveImportMeta,
    removeImport,
    reorderSequence,
    missingVideoEpisodes,
    loadMissingVideoEpisodes,
    scanEpisodeImports,
    getEpisodeImportFolder,
    revealFolder,
    reconcilePreview,
    reconcileConfirm,
    reconcilePreviewState,
    getCachedReconcilePreview,
    invalidateReconcilePreview,
    editSchedule,
    unschedule,
    clearItemSchedule,
    syncQueueFromYoutube,
    resetUploadState,
    orphans,
    orphansNextNumber,
    orphansAlreadyLinked,
    orphansError,
    orphansLoading,
    loadOrphans,
    adoptSingleOrphan,
    adoptBulkOrphans,
    quota,
    loadQuota,
    setQuotaCeiling,
    startQuotaPolling,
    stopQuotaPolling,
    uploadMode,
    loadUploadMode,
    setUploadModeFor,
    playlists,
    defaultPlaylistId,
    playlistsLoading,
    playlistsError,
    loadPlaylists,
    createPlaylistFor,
    setDefaultPlaylist,
    loadPlatforms,
    loadAccounts,
    loadClientStatus,
    loadQueue,
    fetchQueueEpisodeCodes,
    loadPlans,
    savePlan,
    deletePlan,
    activatePlan,
    previewPlan,
    applyPlan,
    refreshAll,
    saveOAuthClient,
    clearOAuthClient,
    startOAuthFlow,
    waitForOAuthFlow,
    removeAccount,
    setDefault,
    triggerUpload,
    triggerMetadataUpdate,
    triggerPlaylistUpdate,
  }
}
