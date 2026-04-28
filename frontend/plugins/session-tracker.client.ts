/**
 * Persists the operator's current page so the next launch (clean or after a
 * crash) can land them back on it. Writes to /api/last-session on every
 * navigation to a project route.
 *
 * The home route `/` is never saved — overwriting useful project state with
 * "/" would defeat the purpose of restore. Routes whose page-mount has side
 * effects (OAuth callbacks, one-shot wizard steps) must NOT appear in the
 * allowlist; the server enforces the same allowlist server-side as a backstop.
 *
 * Write strategy: the first navigation in a session writes immediately so
 * even a launch-then-close-fast cycle captures something. After that, writes
 * are throttled to one per 250 ms to keep noisy click-throughs cheap.
 * `beforeunload` and `pagehide` fire a final synchronous flush via
 * `sendBeacon` so the *most recent* navigation is always the saved one — no
 * silent loss when the user closes the window inside the throttle window.
 */

const RESTORABLE_SUBS = new Set([
  'ideas', 'pipeline', 'scripts', 'metadata', 'image-prompts', 'images',
  'video', 'audio', 'audio-merge', 'video-assembly', 'upload',
  'tiktok-upload', 'facebook-upload', 'presets', 'assets', 'jobs', 'settings',
])

function parseProjectRoute(path: string): { slug: string; route: string } | null {
  const m = /^\/projects\/([^/]+)(?:\/([^/?#]+))?\/?$/.exec(path)
  if (!m) return null
  const slug = decodeURIComponent(m[1]!)
  const sub = m[2] ?? 'index'
  if (sub !== 'index' && !RESTORABLE_SUBS.has(sub)) return null
  // Strip query/hash from the saved route — we re-restore the canonical page,
  // not whatever transient ?modal=open state the operator had.
  const cleanPath = path.split(/[?#]/, 1)[0] ?? path
  return { slug, route: cleanPath }
}

export default defineNuxtPlugin(() => {
  const router = useRouter()
  const { post } = useApi()

  const THROTTLE_MS = 250
  let pending: ReturnType<typeof setTimeout> | null = null
  let lastWriteAt = 0
  let firstWriteDone = false
  // Track the latest pending payload so the unload flush always sends the
  // newest navigation, not whatever was queued earliest.
  let latest: { slug: string; route: string } | null = null

  function writeNow(slug: string, route: string) {
    lastWriteAt = Date.now()
    post('/last-session', { projectSlug: slug, route }).catch(() => {
      // Ignore — restore is a best-effort UX nicety, not a correctness
      // guarantee. A failed write just means the next launch lands on `/`.
    })
  }

  function scheduleWrite(slug: string, route: string) {
    latest = { slug, route }
    // First write of the session bypasses throttle so a launch-then-close
    // cycle still captures the user's first real navigation. Without this,
    // closing inside 250 ms of opening loses the route entirely.
    if (!firstWriteDone) {
      firstWriteDone = true
      writeNow(slug, route)
      return
    }
    const now = Date.now()
    const wait = Math.max(0, THROTTLE_MS - (now - lastWriteAt))
    if (pending) clearTimeout(pending)
    pending = setTimeout(() => {
      pending = null
      if (!latest) return
      writeNow(latest.slug, latest.route)
    }, wait)
  }

  /**
   * Final flush on unload. `fetch` mid-unload is unreliable (the renderer is
   * tearing down), so prefer `sendBeacon` — designed for this exact case and
   * survives the renderer exit. Fallback to a `keepalive` fetch when beacon
   * isn't available (older Electron, test envs).
   */
  function flushOnUnload() {
    if (!latest) return
    const payload = JSON.stringify({
      projectSlug: latest.slug,
      route: latest.route,
    })
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
        const blob = new Blob([payload], { type: 'application/json' })
        navigator.sendBeacon('/api/last-session', blob)
        return
      }
    } catch { /* fall through to fetch */ }
    try {
      // keepalive lets the request outlive the document.
      fetch('/api/last-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        keepalive: true,
      }).catch(() => {})
    } catch { /* nothing else we can do */ }
  }

  router.afterEach((to) => {
    const m = parseProjectRoute(to.path)
    if (!m) return
    scheduleWrite(m.slug, m.route)
  })

  if (typeof window !== 'undefined') {
    // Both events fire on Electron close — pagehide is the modern, more
    // reliable one (fires for bfcache too); beforeunload is the legacy
    // fallback. Listening to both is safe because flushOnUnload is
    // idempotent (the payload reflects the latest navigation either way).
    window.addEventListener('pagehide', flushOnUnload)
    window.addEventListener('beforeunload', flushOnUnload)
  }
})
