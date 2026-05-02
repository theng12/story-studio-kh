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

export function useApi() {
  const baseURL = '/api'

  async function api<T = any>(path: string, options: any = {}): Promise<T> {
    // Health probe itself must NEVER wait on the boot-ready gate — the
    // gate IS that probe. Skip for any /health endpoint to avoid the
    // recursive deadlock.
    if (!path.startsWith('/health')) {
      await waitForBootReady()
    }
    const userHeaders: Record<string, string> = options.headers || {}
    const hasContentType = Object.keys(userHeaders).some(k => k.toLowerCase() === 'content-type')
    return await $fetch<T>(`${baseURL}${path}`, {
      ...options,
      headers: {
        // Only apply the JSON default when the caller hasn't set an explicit
        // Content-Type — this is what lets the standards save use text/plain.
        ...(hasContentType ? {} : { 'Content-Type': 'application/json' }),
        ...userHeaders,
      },
    })
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
