/**
 * Tracks network reachability for the app.
 *
 * Two signals:
 *   - navigator.onLine — fast but only detects interface state, not internet.
 *   - Periodic HEAD to /api/health — confirms the backend is actually reachable.
 *
 * Exposes a singleton state so every component reads the same value.
 */

// Explicit Vue import so this module is usable from plain node:test (no
// Nuxt auto-import context). Nuxt's auto-imports remain additive inside
// .vue files.
import { ref, readonly } from 'vue'

const online = ref(true)
const lastChecked = ref<number>(Date.now())
// `queueSyncFailed` is true when the most recent attempt to mirror the
// online↔paused state to the backend failed. The dashboard layout reads
// this to show a "queue may be out of sync" warning next to the network
// indicator — otherwise the operator sees "Offline" and assumes new jobs
// are safely paused, when in reality the pause POST never landed and the
// worker is still chewing through queued items against a flaky backend.
const queueSyncFailed = ref(false)
let started = false
let interval: ReturnType<typeof setInterval> | null = null
let lastPausedState: boolean | null = null

/**
 * Tell the backend to pause or resume the job queue based on connectivity.
 * No-op if the state hasn't changed, so we don't spam the endpoint every
 * 20 s probe.
 *
 * On failure we still record the attempted state (so we don't retry every
 * 20 s against an already-broken backend — that's spam, not signal) but
 * we flip `queueSyncFailed` so the network indicator can warn the operator
 * that the pause/resume command didn't land. Silent catch used to let the
 * UI say "Offline" while the worker quietly chewed through queued jobs.
 */
async function syncQueueState(nowOnline: boolean) {
  const shouldBePaused = !nowOnline
  if (lastPausedState === shouldBePaused) return
  // Record the attempt up front so a failed POST doesn't cause us to spam
  // the backend on every subsequent probe — the next legitimate state
  // transition will retry naturally. Failure surfaces via queueSyncFailed.
  lastPausedState = shouldBePaused
  try {
    const res = await fetch(`/api/system/queue/${shouldBePaused ? 'pause' : 'resume'}`, { method: 'POST' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    queueSyncFailed.value = false
  } catch {
    queueSyncFailed.value = true
  }
}

async function probe(): Promise<boolean> {
  try {
    const res = await fetch('/api/health', { method: 'GET', cache: 'no-store' })
    return res.ok
  } catch {
    return false
  }
}

async function refresh() {
  // If the browser says offline, trust it immediately.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    online.value = false
    lastChecked.value = Date.now()
    await syncQueueState(false)
    return
  }
  online.value = await probe()
  lastChecked.value = Date.now()
  await syncQueueState(online.value)
}

export function useNetworkStatus() {
  if (!started && import.meta.client) {
    started = true
    // Initial probe
    refresh()
    // Browser events
    window.addEventListener('online', refresh)
    window.addEventListener('offline', () => { online.value = false; lastChecked.value = Date.now() })
    // Periodic re-check every 20 s
    interval = setInterval(refresh, 20000)
  }

  return {
    online: readonly(online),
    lastChecked: readonly(lastChecked),
    queueSyncFailed: readonly(queueSyncFailed),
    refresh,
  }
}
