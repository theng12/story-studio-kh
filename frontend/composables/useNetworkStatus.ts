/**
 * Tracks reachability of the app's backend (the engine that runs jobs) and
 * mirrors it to the job queue's pause state.
 *
 * v1.0.190 — reachability is decided ONLY by a periodic probe to the local
 * backend (`GET /api/health`), never by `navigator.onLine`. Chromium's
 * `navigator.onLine` throws false negatives on macOS (sleep/wake, VPN /
 * Tailscale changes, Wi-Fi interface flaps) even when the internet is fine —
 * and the old code "trusted it immediately", which paused the whole job queue
 * and left jobs stuck at "Queued" with no explanation. The probe hits the
 * local server, so "offline" now means "the job engine is unreachable", which
 * is the only state where pausing the queue is actually correct. The browser's
 * online/offline events are treated as a nudge to re-probe, not as gospel.
 *
 * Exposes a singleton so every component reads the same value.
 */

// Explicit Vue import so this module is usable from plain node:test (no
// Nuxt auto-import context). Nuxt's auto-imports remain additive inside
// .vue files.
import { ref, readonly } from 'vue'

const online = ref(true)
const lastChecked = ref<number>(Date.now())
// `queueSyncFailed` is true when the most recent attempt to mirror the
// online↔paused state to the backend failed. The dashboard layout reads this
// to warn that the pause/resume command didn't land.
const queueSyncFailed = ref(false)
let started = false
let interval: ReturnType<typeof setInterval> | null = null
// The pause state we last *intended* to set on the backend. Recorded on every
// attempt (not just success) so a failed PAUSE to an unreachable backend isn't
// retried every probe — that's spam to a dead endpoint, and jobs aren't running
// anyway. A failed RESUME is different: see the retry note in syncQueueState.
let lastSyncedPaused: boolean | null = null

/**
 * Tell the backend to pause or resume the job queue based on reachability.
 * Skips the POST when we're already in the intended state — EXCEPT when a
 * previous *resume* failed: in that case we retry, because a dropped resume
 * POST (backend briefly busy during the transition) would otherwise leave the
 * queue paused forever with the UI showing "Online". We deliberately do NOT
 * retry failed *pauses*: if the backend is unreachable the pause can't land
 * anyway and jobs aren't running, so retrying is pointless noise.
 */
async function syncQueueState(nowOnline: boolean) {
  const shouldBePaused = !nowOnline
  const resumeRetry = queueSyncFailed.value && shouldBePaused === false
  if (lastSyncedPaused === shouldBePaused && !resumeRetry) return
  lastSyncedPaused = shouldBePaused
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
  // Reachability of the local job engine is the only signal that gates the
  // queue. navigator.onLine is intentionally NOT consulted (see file header).
  online.value = await probe()
  lastChecked.value = Date.now()
  await syncQueueState(online.value)
}

export function useNetworkStatus() {
  if (!started && import.meta.client) {
    started = true
    // Initial probe
    refresh()
    // Browser online/offline events only nudge a fresh probe — they never
    // directly flip the state (navigator.onLine is too flaky to trust).
    window.addEventListener('online', refresh)
    window.addEventListener('offline', refresh)
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
