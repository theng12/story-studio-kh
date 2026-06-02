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
 * async boot migrations finish (migrateAppSecrets, migrateDescriptionTo
 * Metadata, etc.) can hit transient state and surface "Project not
 * found" / "COULDN'T VERIFY" warnings to the user. The gate polls
 * /api/health for `boot_complete: true` on the very first call, then
 * caches the resolution so subsequent calls are no-ops. A 15 s timeout
 * lets calls proceed even if the backend never reports ready — better
 * to fail with a real error than block forever.
 */

export interface ApiOptions {
  headers?: Record<string, string>
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

function waitForBootReady(): Promise<void> {
  if (_bootReadyPromise) return _bootReadyPromise
  _bootReadyPromise = (async () => {
    const deadline = Date.now() + BOOT_READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      try {
        const r: any = await $fetch('/api/health')
        // The flag is added by the boot-migrations module after every
        // async migration settles. Older bundled backends without the
        // flag treat it as undefined → we accept any 200 as ready so
        // we don't deadlock against pre-flag versions.
        if (r?.status === 'ok' && (r.boot_complete === true || typeof r.boot_complete === 'undefined')) {
          return
        }
      } catch { /* backend still starting — keep polling */ }
      await new Promise((resolve) => setTimeout(resolve, BOOT_READY_POLL_MS))
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
let _redirectingToLogin = false
function handleAuthExpired(path: string): void {
  if (_redirectingToLogin) return
  if (typeof window === 'undefined') return
  if (path.startsWith('/auth/')) return
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
      path.includes('/undefined/') ||
      path.endsWith('/undefined') ||
      /\/undefined[?#]/.test(path) ||
      // v1.0.129+ — Also catch query-string variants. /models?project=X,
      // /usage?project=X, /dashboard-stats?project=X etc. all stringify
      // undefined into the value and would otherwise reach the backend
      // (which has no project context to resolve and 404s with the same
      // 'Project not found' detail). Match common slug-bearing param
      // names: project, slug, project_slug, episode, episode_id.
      /[?&](project|slug|project_slug|episode|episode_id)=undefined(?:&|$|#)/.test(path)
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
      return await $fetch<T>(`${baseURL}${path}`, {
        ...options,
        headers: {
          // Only apply the JSON default when the caller hasn't set an explicit
          // Content-Type — this is what lets the standards save use text/plain.
          ...(hasContentType ? {} : { 'Content-Type': 'application/json' }),
          ...userHeaders,
        },
      })
    } catch (err: any) {
      // Redirect to /login on 401 in server mode. The error still bubbles
      // so per-component error handling sees it; the navigation just
      // happens out-of-band.
      if (err?.response?.status === 401 || err?.status === 401) {
        handleAuthExpired(path)
      }
      throw err
    }
  }

  return {
    get: <T = any>(path: string, options?: ApiOptions) =>
      api<T>(path, options),
    post: <T = any>(path: string, body?: any, options?: ApiOptions) =>
      api<T>(path, { method: 'POST', body, ...options }),
    put: <T = any>(path: string, body?: any, options?: ApiOptions) =>
      api<T>(path, { method: 'PUT', body, ...options }),
    patch: <T = any>(path: string, body?: any, options?: ApiOptions) =>
      api<T>(path, { method: 'PATCH', body, ...options }),
    del: <T = any>(path: string, options?: ApiOptions) =>
      api<T>(path, { method: 'DELETE', ...options }),
  }
}
