/**
 * API client composable — wraps $fetch with a consistent base URL.
 *
 * Every call goes through here so cross-cutting concerns (auth, retries,
 * error shaping, logging) can be added in one place. Routes that need a
 * non-JSON body (e.g. `text/plain` for production_standards) can supply
 * their own `Content-Type` via the per-call `headers` override — the
 * default JSON header is suppressed when the caller sets one explicitly.
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

export function useApi() {
  const baseURL = '/api'

  async function api<T = any>(path: string, options: any = {}): Promise<T> {
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
