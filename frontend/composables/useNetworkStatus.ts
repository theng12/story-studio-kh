/**
 * Tracks reachability of the app's backend (the engine that runs jobs) and
 * reports it to the dashboard.
 *
 * v1.0.190 — reachability is decided ONLY by a periodic probe to the local
 * backend (`GET /api/health`), never by `navigator.onLine`. Chromium's
 * `navigator.onLine` throws false negatives on macOS (sleep/wake, VPN /
 * Tailscale changes, Wi-Fi interface flaps) even when the internet is fine —
 * and the old code "trusted it immediately", which paused the whole job queue
 * and left jobs stuck at "Queued" with no explanation. The probe hits the
 * local server, so "offline" now means "the job engine is unreachable", which
 * is useful for status display only. The browser's online/offline events are
 * treated as a nudge to re-probe, not as gospel.
 *
 * Exposes a singleton so every component reads the same value.
 */

// Explicit Vue import so this module is usable from plain node:test (no
// Nuxt auto-import context). Nuxt's auto-imports remain additive inside
// .vue files.
import { ref, readonly } from 'vue'

const online = ref(true)
const lastChecked = ref<number>(Date.now())
let started = false
let interval: ReturnType<typeof setInterval> | null = null

async function probe(): Promise<boolean> {
  try {
    const res = await fetch('/api/health', { method: 'GET', cache: 'no-store' })
    return res.ok
  } catch {
    return false
  }
}

async function refresh() {
  // Reachability of the local job engine is informational only.
  // navigator.onLine is intentionally NOT consulted (see file header).
  online.value = await probe()
  lastChecked.value = Date.now()
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
    refresh,
  }
}
