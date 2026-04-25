/**
 * Persists the operator's current page so the next launch (clean or after a
 * crash) can land them back on it. Writes to /api/last-session on every
 * navigation to a project route, throttled to one write per second.
 *
 * The home route `/` is never saved — overwriting useful project state with
 * "/" would defeat the purpose of restore. Routes whose page-mount has side
 * effects (OAuth callbacks, one-shot wizard steps) must NOT appear in the
 * allowlist; the server enforces the same allowlist server-side as a backstop.
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

  const THROTTLE_MS = 1000
  let pending: ReturnType<typeof setTimeout> | null = null
  let lastWriteAt = 0

  function scheduleWrite(slug: string, route: string) {
    const now = Date.now()
    const wait = Math.max(0, THROTTLE_MS - (now - lastWriteAt))
    if (pending) clearTimeout(pending)
    pending = setTimeout(() => {
      pending = null
      lastWriteAt = Date.now()
      post('/last-session', { projectSlug: slug, route }).catch(() => {
        // Ignore — restore is a best-effort UX nicety, not a correctness
        // guarantee. A failed write just means the next launch lands on `/`.
      })
    }, wait)
  }

  router.afterEach((to) => {
    const m = parseProjectRoute(to.path)
    if (!m) return
    scheduleWrite(m.slug, m.route)
  })
})
