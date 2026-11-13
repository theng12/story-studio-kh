/**
 * Tracks reachability of the app's backend (the engine that runs jobs) and of
 * the Gateway behind it, and reports both to the shell.
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
 * The local engine is up whenever the window is, so on its own that badge said
 * "online" while a stopped or restarting Gateway made every job fail. The same
 * probe now also asks the backend whether the Gateway answers
 * (`GET /api/gateway/status`), and the shell shows that.
 *
 * The probe pauses while the window is hidden and re-checks the moment it is
 * shown again. Informational only — it never touches the job queue.
 *
 * Exposes a singleton so every component reads the same value.
 */

// Explicit Vue import so this module is usable from plain node:test (no Nuxt
// auto-import context). Nuxt's auto-imports remain additive inside .vue files.
import { computed, ref, readonly } from 'vue'
import { createVisibleInterval } from './useVisibleInterval.js'

/** `unknown` until the first answer, and whenever the engine itself is down. */
export type GatewayReachability = 'unknown' | 'reachable' | 'unreachable'

const online = ref(true)
const gateway = ref<GatewayReachability>('unknown')
const gatewayUrl = ref('')
const lastChecked = ref<number>(Date.now())
let started = false

async function probe(): Promise<boolean> {
  try {
    const res = await fetch('/api/health', { method: 'GET', cache: 'no-store' })
    return res.ok
  } catch {
    return false
  }
}

async function probeGateway(): Promise<void> {
  try {
    const res = await fetch('/api/gateway/status', { method: 'GET', cache: 'no-store' })
    if (!res.ok) { gateway.value = 'unknown'; return }
    const body = await res.json() as { reachable?: unknown; url?: unknown }
    gateway.value = body?.reachable === true ? 'reachable' : body?.reachable === false ? 'unreachable' : 'unknown'
    if (typeof body?.url === 'string') gatewayUrl.value = body.url
  } catch {
    gateway.value = 'unknown'
  }
}

async function refresh() {
  // navigator.onLine is intentionally NOT consulted (see file header).
  online.value = await probe()
  if (online.value) await probeGateway()
  else gateway.value = 'unknown'
  lastChecked.value = Date.now()
}

/** The address the last Gateway probe used, for error sentences that must name where we tried. */
export function currentGatewayUrl(): string {
  return gatewayUrl.value
}

export function useNetworkStatus() {
  if (!started && import.meta.client) {
    started = true
    refresh()
    // Browser online/offline events only nudge a fresh probe — they never
    // directly flip the state (navigator.onLine is too flaky to trust).
    window.addEventListener('online', refresh)
    window.addEventListener('offline', refresh)
    // Every 20 s while the window is visible; immediately on becoming visible.
    createVisibleInterval(() => { void refresh() }, 20_000).start()
  }

  return {
    online: readonly(online),
    gateway: readonly(gateway),
    gatewayUrl: readonly(gatewayUrl),
    lastChecked: readonly(lastChecked),
    refresh,
  }
}

export interface ConnectionStatus {
  tone: 'online' | 'offline' | 'unknown'
  label: string
  /** A visible next step; empty when there is nothing to do. */
  hint: string
}

/**
 * The one wording for "can Story Studio do AI work right now", shared by the sidebar and the header
 * strip so the two never disagree. The local engine comes first (if it is down nothing works), then
 * the Gateway, which every generation goes through.
 */
export function connectionStatus(engineOnline: boolean, gateway: GatewayReachability, gatewayUrl = ''): ConnectionStatus {
  if (!engineOnline) {
    return {
      tone: 'offline',
      label: 'Story Studio engine not answering',
      hint: 'Quit and reopen Story Studio. Your projects stay on disk.',
    }
  }
  if (gateway === 'unreachable') {
    return {
      tone: 'offline',
      label: gatewayUrl ? `Gateway not reachable at ${gatewayUrl}` : 'Gateway not reachable',
      hint: 'Open the Gateway app on that Mac, or change the address in Settings → Connections. AI work cannot start until it answers; this updates by itself.',
    }
  }
  if (gateway === 'reachable') return { tone: 'online', label: 'Gateway connected', hint: '' }
  return { tone: 'unknown', label: 'Checking the Gateway…', hint: '' }
}

/** The shared status sentence plus "is the Gateway down?", for any component that shows it. */
export function useConnectionStatus() {
  const { online, gateway, gatewayUrl, refresh } = useNetworkStatus()
  return {
    connection: computed(() => connectionStatus(online.value, gateway.value, gatewayUrl.value)),
    gatewayDown: computed(() => online.value && gateway.value === 'unreachable'),
    refresh,
  }
}
