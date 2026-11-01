/**
 * API client composable — wraps $fetch with a consistent base URL.
 *
 * Every call goes through here so cross-cutting concerns (auth, retries,
 * error shaping, logging) can be added in one place. Routes that need a
 * non-JSON body (e.g. `text/plain` for production_standards) can supply
 * their own `Content-Type` via the per-call `headers` override — the
 * default JSON header is suppressed when the caller sets one explicitly.
 *
 * Boot-ready gate: every page mounts and fires several API calls in
 * parallel. Without this gate, calls that land before the backend's
 * async boot maintenance finishes can hit transient state and surface "Project not
 * found" / "COULDN'T VERIFY" warnings to the user. The gate polls
 * /api/health for `boot_complete: true` on the very first call, then
 * caches the resolution so subsequent calls are no-ops. A 15 s timeout
 * lets calls proceed even if the backend never reports ready — better
 * to fail with a real error than block forever.
 *
 * Stale-while-revalidate: every GET returns cached data at once and starts
 * a background refresh. Callers using `useApiData` get reactive updates
 * when fresh data lands. Failed refreshes keep old data but mark it with
 * an error so nothing is silently shown as fresh.
 */

import { isServerMode } from './useServerMode'
import { swrGet, swrInvalidate, swrClearAll, shouldSkipCache, setLegacyCacheClearer } from '../utils/swrCache'

export interface ApiOptions {
 headers?: Record<string, string>
 /** Bypass the shared read cache for an explicit refresh/verification. */
 cache?: RequestCache
 /**
  * Optional body for methods that don't take one as a positional arg
  * (currently `del`). DELETE-with-body is unusual but valid HTTP and
  * useful for "delete by criteria" endpoints — e.g. linked-projects
  * unregister sends the path in the body so the URL stays free of
  * filesystem characters that would need escaping.
  */
 body?: any
}

// Module-level cache so every useApi() call across the app shares the
// same gate. The first call kicks off the poll; everyone else awaits
// the same promise. Once resolved we replace it with a synchronous
// no-op so there's zero overhead on cached subsequent calls.
let _bootReadyPromise: Promise<void> | null = null
const BOOT_READY_TIMEOUT_MS = 15_000
const BOOT_READY_POLL_MS = 250

// `useApi` used to keep a second, TTL-based read map for three paths.
// Every GET now goes through the SWR store in `utils/swrCache.ts`, so
// there is no second cache to maintain — only a hook so a full clear
// (sign-out, server change) reaches the store from one place.
setLegacyCacheClearer(() => { /* no second map left to clear */ })

function invalidateGetCache(mutatedPath: string): void {
  const projectMatch = mutatedPath.match(/^\/projects\/([^/?#]+)/)
  const projectPrefix = projectMatch ? `/projects/${projectMatch[1]}` : null
  const changesProjectSettings = !!projectPrefix
    && mutatedPath.startsWith(`${projectPrefix}/settings/config`)

  // The SWR keys are `GET:<api path>`, so one project prefix covers every
  // read under that channel. Deliberately NOT a bare "any mutation under
  // this project flushes everything": that made unrelated generation
  // actions force presets, formats and model selectors to reload.
  const escaped = projectPrefix
    ? projectPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    : null
  if (escaped) {
    // The exact path that changed — the primary rule, and the one every
    // "I saved this field, now re-read it" flow depends on.
    swrInvalidate(`GET:${mutatedPath}`)
    // The project root itself (`GET:/projects/x`).
    swrInvalidate(new RegExp(`^GET:${escaped}(?:[?#]|$)`))
    // Project identity/settings writes move config + effective format too.
    if (changesProjectSettings || new RegExp(`^${escaped}(?:[?#]|$)`).test(mutatedPath)) {
      swrInvalidate(new RegExp(`^GET:${escaped}/settings/config`))
      swrInvalidate(new RegExp(`^GET:${escaped}/effective-format`))
    }
  } else {
    // No project in the path (global endpoints): still invalidate itself.
    swrInvalidate(`GET:${mutatedPath}`)
  }
  // API-key and local-backend changes affect model availability globally.
  if (/secrets|app-settings|settings\/config/.test(mutatedPath)) {
    swrInvalidate(/^GET:\/models\?/)
  }
}

/**
 * Drop every cached GenStudio model catalogue read.
 *
 * Reuses the SHARED `/models?` cache above — this is deliberately not a second
 * fetch path. It exists because GenStudio is the final validator of context and
 * output limits: when it rejects a request for exceeding one, the catalogue this
 * page is showing is out of date, and the next read must go to the network
 * rather than serve the stale entry for the rest of its 5-minute TTL.
 */
export function invalidateModelCatalogCache(): void {
  swrInvalidate(/^GET:\/models\?/)
}

/**
 * Clear all cached data. Called on sign-out and when connecting to a
 * different server so no stale data from one session leaks into another.
 */
export function clearAllCaches(): void {
 swrClearAll()
}

/**
 * Invalidate every cached read belonging to one project (and, when given,
 * one episode inside it).
 *
 * Job streams (`useJobs` / `useAllJobs` / `useAppJobs`) are the app's
 * live-data channel: when a job reaches `done` or `error` the project's
 * episodes, channels and dashboards all change on disk. Pages that are
 * sitting on a stored value must not keep showing the pre-job picture, so
 * every job status transition calls this for its project.
 *
 * The key shape is `GET:<path>` where `<path>` is the API path the caller
 * passed to `get()` — so matching on `/projects/<slug>` covers every read
 * under that channel. Episode isolation (AGENTS.md §4) is preserved: keys
 * are matched by their full path, so `/projects/A/episodes/EP001` is never
 * confused with `/projects/A/episodes/EP002`.
 */
export function invalidateProjectCache(slug: string, episodeId?: string): void {
 if (!slug) return
 const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
 if (episodeId) {
   const epEscaped = episodeId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
   swrInvalidate(new RegExp(`^GET:/projects/${escaped}(/|\\?|$)`))
   swrInvalidate(new RegExp(`^GET:/projects/${escaped}/episodes/${epEscaped}(/|\\?|$)`))
 } else {
   swrInvalidate(new RegExp(`^GET:/projects/${escaped}(/|\\?|$)`))
 }
}

/**
 * Pre-resolve the boot-ready gate. The frontend test runner calls this
 * in setup.ts so unit tests don't fire an unexpected `/api/health`
 * probe (which pollutes their captured-fetches assertions). No-op in
 * production — the gate stays armed until the real backend reports
 * `boot_complete: true`.
 */
export function _markBootReadyForTests(): void {
 _bootReadyPromise = Promise.resolve()
}

/** Reset shared read state between isolated unit tests. */
export function _clearApiGetCacheForTests(): void {
 swrClearAll()
}

function waitForBootReady(): Promise<void> {
 if (_bootReadyPromise) return _bootReadyPromise
 _bootReadyPromise = (async () => {
   const deadline = Date.now() + BOOT_READY_TIMEOUT_MS
   while (Date.now() < deadline) {
     try {
       const remaining = deadline - Date.now()
       const controller = new AbortController()
       let timer: ReturnType<typeof setTimeout> | undefined
       let r: any
       try {
         r = await Promise.race([
           $fetch('/api/health', { signal: controller.signal, timeout: remaining, retry: 0 }),
           new Promise(resolve => {
             timer = setTimeout(() => { controller.abort(); resolve(undefined) }, remaining)
           }),
         ])
       } finally {
         clearTimeout(timer)
       }
       // The flag is added by the boot-migrations module after every
       // async migration settles. Older bundled backends without the
       // flag treat it as undefined → we accept any 200 as ready so
       // we don't deadlock against pre-flag versions.
       if (r?.status === 'ok' && (r.boot_complete === true || typeof r.boot_complete === 'undefined')) {
         return
       }
     } catch { /* backend still starting — keep polling */ }
     const remaining = deadline - Date.now()
     if (remaining <= 0) break
     await new Promise((resolve) => setTimeout(resolve, Math.min(BOOT_READY_POLL_MS, remaining)))
   }
   // Timed out. Let calls proceed; if they fail it's a real error worth
   // surfacing rather than a "still loading" silence.
   console.warn(`[useApi] backend boot_complete didn't flip within ${BOOT_READY_TIMEOUT_MS}ms — proceeding anyway`)
 })()
 return _bootReadyPromise
}

/**
 * Server-mode 401 handler: when the session has expired (or was never
 * established), redirect to /login. Skip when already on /login (login
 * itself uses raw $fetch and handles its own 401), skip in default
 * (Electron) mode where 401 doesn't exist as a normal flow, and skip
 * when the call is /auth/me (the SPA's "am I logged in?" probe expects
 * 401 to mean "no").
 *
 * v1.0.112 — two hardening changes after a real infinite-refresh loop hit
 * production from a remote browser:
 *   1. Trailing-slash tolerance in the "already on /login" guard.
 *      Nuxt static build emits `login/index.html` (a directory); express.
 *      static redirects `GET /login` → `GET /login/` (HTTP 301) so the
 *      ACTUAL pathname is `/login/`. The previous exact-match check
 *      (`=== '/login'`) never fired, so every 401 redirected and the
 *      destination 401'd again and the loop ran forever.
 *   2. Re-entrancy guard. A page typically fires many API calls in
 *      parallel; if the session is gone, ALL of them 401 and ALL of them
 *      tried to call window.location.assign. Harmless individually, but
 *      it amplified the loop above and made debugging noisier. Latch the
 *      first redirect; subsequent 401s become no-ops.
 */
export const NO_RESPONSE_MESSAGE = "Story Studio's engine is not answering — it may be starting up. Wait a moment, then try again."

let _redirectingToLogin = false
function handleAuthExpired(path: string, error: any): void {
 if (_redirectingToLogin) return
 if (typeof window === 'undefined') return
 if (path.startsWith('/auth/')) return
 if (!isServerMode()) return
 const data = error?.data || error?.response?._data || {}
 if (data.code) return
 if (data.detail !== 'Authentication required' && data.detail !== 'Invalid or expired session') return
 // Normalize trailing slash. Browsers report `/login/` after express.static's
 // directory-redirect, but the SPA's canonical login URL is `/login`.
 const currentPath = window.location.pathname.replace(/\/+$/, '') || '/'
 if (currentPath === '/login') return
 _redirectingToLogin = true
 // Synchronous redirect — every in-flight fetch will land in `catch`
 // before the navigation completes; that's fine, the page is unloading.
 window.location.assign('/login')
}

/**
 * Server-mode shim for native pickers — `/system/pick-folder`,
 * `/system/pick-file`, `/system/pick-files` would normally pop a macOS
 * dialog on the Mac mini's desktop, useless to the remote browser user.
 * Intercept those calls and route them to the in-app FileBrowserModal
 * instead, returning the same response shape so existing callers (21+
 * sites) work without modification.
 *
 * Returns a "match" indicator so the caller can decide whether to skip
 * the network round-trip.
 */
async function maybeServerModeNativePickerShim(
 path: string,
 body: any,
): Promise<{ matched: false } | { matched: true; result: any }> {
 if (typeof window === 'undefined') return { matched: false }
 // Lazy import to avoid circular deps + keep useApi tree-shakable for
 // anything not on the picker code path.
 const { isServerMode } = await import('./useServerMode')
 if (!isServerMode()) return { matched: false }
 const opts = body || {}
 if (path === '/system/pick-folder') {
   const { pickFolder } = await import('./usePathPicker')
   const picked = await pickFolder({
     title: opts.title,
     button_label: opts.buttonLabel,
     initial_path: opts.defaultPath,
   })
   return { matched: true, result: { path: picked } }
 }
 if (path === '/system/pick-file') {
   const { pickFile } = await import('./usePathPicker')
   const exts = Array.isArray(opts.filters)
     ? opts.filters.flatMap((f: any) => Array.isArray(f.extensions) ? f.extensions : [])
     : undefined
   const picked = await pickFile({
     title: opts.title,
     button_label: opts.buttonLabel,
     extensions: exts && exts.length ? exts : undefined,
   })
   return { matched: true, result: { path: picked } }
 }
 if (path === '/system/pick-files') {
   const { pickFiles } = await import('./usePathPicker')
   const exts = Array.isArray(opts.filters)
     ? opts.filters.flatMap((f: any) => Array.isArray(f.extensions) ? f.extensions : [])
     : undefined
   const picked = await pickFiles({
     title: opts.title,
     button_label: opts.buttonLabel,
     extensions: exts && exts.length ? exts : undefined,
   })
   return { matched: true, result: { paths: picked } }
 }
 return { matched: false }
}

export function useApi() {
 const baseURL = '/api'

 async function api<T = any>(path: string, options: any = {}): Promise<T> {
   // v1.0.125+ — Slug-race short-circuit.
   //
   // Route transitions (and the dashboard layout's `immediate: true`
   // slug watcher) can fire callers BEFORE `route.params.slug` resolves
   // — `slug.value` is then `undefined`, and any caller that builds a
   // URL via `${slug.value}` produces the literal substring
   // `/projects/undefined/...` (template-literal artifact). The backend
   // 404s every such request with `{ detail: 'Project not found' }`,
   // which then surfaces as a spammy toast on the affected page.
   //
   // Two existing composables (`useProject.ts:48`, `useCredits.ts:42`)
   // already guard against this locally — but every OTHER composable
   // and page would need the same per-callsite check to be safe. Guard
   // here so the whole app gets it for free, and the backend never sees
   // the bogus path.
   //
   // Sentinel format on the thrown error:
   //   err.message      = '__slug_race__'
   //   err.data.detail  = '__slug_race__'
   // — useToast.error() checks both and silently swallows.
   if (
     path.includes('/undefined/') || path.includes('/null/') ||
     path.endsWith('/undefined') || path.endsWith('/null') ||
     /\/(undefined|null)[?#]/.test(path) ||
     // v1.0.129+ — Also catch query-string variants. /models?project=X,
     // /usage?project=X, /dashboard-stats?project=X etc. all stringify
     // undefined into the value and would otherwise reach the backend
     // (which has no project context to resolve and 404s with the same
     // 'Project not found' detail). Match common slug-bearing param
     // names: project, slug, project_slug, episode, episode_id.
     /[?&](project|slug|project_slug|episode|episode_id)=(undefined|null)(?:&|$|#)/.test(path)
   ) {
     const err: any = new Error('__slug_race__')
     err.data = { detail: '__slug_race__' }
     err.__slugRace = true
     throw err
   }

   // Health probe itself must NEVER wait on the boot-ready gate — the
   // gate IS that probe. Skip for any /health endpoint to avoid the
   // recursive deadlock.
   if (!path.startsWith('/health')) {
     await waitForBootReady()
   }
   // Server-mode shim: native-dialog endpoints get rerouted to the
   // in-app file browser modal. Only fires for the three pick-* paths
   // and only when isServerMode() is true; default mode falls through.
   if (options.method === 'POST' && path.startsWith('/system/pick-')) {
     const shim = await maybeServerModeNativePickerShim(path, options.body)
     if (shim.matched) return shim.result as T
   }
   const userHeaders: Record<string, string> = options.headers || {}
   const hasContentType = Object.keys(userHeaders).some(k => k.toLowerCase() === 'content-type')
   try {
     return await $fetch(`${baseURL}${path}`, {
       ...options,
       headers: {
         // Only apply the JSON default when the caller hasn't set an explicit
         // Content-Type — this is what lets the standards save use text/plain.
         ...(hasContentType ? {} : { 'Content-Type': 'application/json' }),
         ...userHeaders,
       },
     }) as T
   } catch (err: any) {
     // Redirect to /login on 401 in server mode. The error still bubbles
     // so per-component error handling sees it; the navigation just
     // happens out-of-band.
     if (err?.response?.status === 401 || err?.status === 401) {
       handleAuthExpired(path, err)
     }
     // No response at all means Story Studio's own engine did not answer (starting up, restarting,
     // or the remote Mac is unreachable). Callers show `e.data.detail || e.message`, and ofetch's
     // message here is `[GET] "/api/…": <no response> Failed to fetch` — say what it means instead.
     if (err && !err.response && !err.data && err.name === 'FetchError' && err.cause?.name !== 'AbortError') {
       try { err.message = NO_RESPONSE_MESSAGE } catch { /* read-only message: leave it */ }
     }
     // The server's humanized errors carry a next step in `hint` that no page rendered. Every
     // caller shows `e.data.detail`, so the hint travels there — said once, in one place.
     const data = err?.data
     if (data && typeof data.detail === 'string' && typeof data.hint === 'string'
       && data.hint.trim() && !data.detail.includes(data.hint.trim())) {
       try { data.detail = `${data.detail} ${data.hint.trim()}` } catch { /* frozen payload: leave it */ }
     }
     throw err
   }
 }

 async function cachedGet<T = any>(path: string, options?: ApiOptions): Promise<T> {
   // `no-store` / `reload` is an explicit "do not serve me stored data"
   // from the caller. A custom Content-Type header means the response is
   // not plain JSON (the production_standards text/plain read), which the
   // shared store must not hold either.
   const bypassCache = options?.cache === 'no-store' || options?.cache === 'reload'
   if (bypassCache || options?.headers || shouldSkipCache(path)) {
     return api<T>(path, options)
   }

   // Stale-while-revalidate for every other GET: the stored value (if any)
   // comes back at once and one background refresh starts behind it. The
   // three paths that used to sit behind a 60 s / 5 min TTL — project
   // config, model catalogue, effective format — now behave the same way
   // as everything else: instant on return, fresh a moment later, and
   // still invalidated by their owning mutations. A TTL returned a stored
   // value with NO revalidation, which is how a page could sit on a
   // catalogue that GenStudio had already changed (AGENTS.md §1).
   const key = `GET:${path}`
   return swrGet<T>(key, () => api<T>(path, options))
 }

 async function mutate<T>(path: string, options: any): Promise<T> {
   const value = await api<T>(path, options)
   invalidateGetCache(path)
   return value
 }

 return {
   get: <T = any>(path: string, options?: ApiOptions) =>
     cachedGet<T>(path, options),
   post: <T = any>(path: string, body?: any, options?: ApiOptions) =>
     mutate<T>(path, { method: 'POST', body, ...options }),
   put: <T = any>(path: string, body?: any, options?: ApiOptions) =>
     mutate<T>(path, { method: 'PUT', body, ...options }),
   patch: <T = any>(path: string, body?: any, options?: ApiOptions) =>
     mutate<T>(path, { method: 'PATCH', body, ...options }),
   del: <T = any>(path: string, options?: ApiOptions) =>
     mutate<T>(path, { method: 'DELETE', ...options }),
 }
}