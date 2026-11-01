/**
 * Frontend awareness of whether the app is running in server mode (headless
 * web UI) vs local Electron desktop mode.
 *
 * Two signals, two granularities:
 *   1. Synchronous (`isServerMode()`): reads the `<meta name="story-studio-
 *      server-mode" content="1">` tag injected by Express at serve time
 *      (electron/main.ts → sendIndex). Available immediately in <script
 *      setup> before any API roundtrip — used by app.vue's BrowserBlock
 *      guard so we don't flash the "open in Electron" message at users
 *      coming in through the intended web URL.
 *   2. Async (`useServerModeState()`): the full state including the
 *      authenticated user's name, fetched from /api/auth/me after login.
 *      Reactive so banners/buttons update on sign-in / sign-out.
 *
 * Singleton state — every page shares one reactive object. Mutations come
 * from auth-flow code paths only (login.vue submit handler, banner sign-out
 * button, useApi 401 handler). Don't mutate from elsewhere.
 */

import { reactive, readonly } from 'vue'
import { swrClearAll } from '../utils/swrCache'

interface ServerModeState {
  isServerMode: boolean
  isAuthenticated: boolean
  username: string | null
  /** Set once /api/auth/me has settled — distinguishes "not yet checked" from "checked, anonymous". */
  authChecked: boolean
}

const state = reactive<ServerModeState>({
  isServerMode: false,
  isAuthenticated: false,
  username: null,
  authChecked: false,
})

/**
 * Sync read — safe to call during `<script setup>` because it doesn't await.
 * Returns false during SSR (no `document`); the SPA is `ssr: false` so this
 * never matters in production but keeps unit tests sane.
 *
 * Detection logic (v1.0.110):
 *   1. `window.electron.isElectron === true` (set by electron/preload.cjs)
 *      → we're sitting at the host Mac in the Electron window → desktop.
 *   2. Hostname is loopback (`127.0.0.1` / `localhost` / `::1`)
 *      → either `npm run dev` or the host Mac in a local browser → desktop.
 *   3. Otherwise (Tailscale IP, *.tailnet, *.local, real LAN IP)
 *      → remote client → server mode.
 *
 * Hostname-only check is reliable because server mode is the ONLY config
 * that binds the backend on 0.0.0.0 — in default desktop mode the server
 * binds 127.0.0.1 only, so a non-loopback URL physically can't reach the
 * app unless server mode is active. No need for a server-injected meta
 * tag (the previous mechanism, removed in v1.0.110 because Nuxt's static
 * build emits per-route HTML files that `express.static` served raw,
 * bypassing the meta-tag injection on every URL except `/`).
 */
export function isServerMode(): boolean {
  if (typeof document === 'undefined') return false
  const w = window as unknown as { electron?: { isElectron?: boolean } }
  if (w.electron?.isElectron === true) return false
  const host = window.location.hostname
  if (host === '127.0.0.1' || host === 'localhost' || host === '::1') return false
  return true
}

/**
 * Initialise the singleton. Idempotent — safe to call from every page mount;
 * the meta-tag read is sync, the /api/auth/me fetch is gated behind a flag
 * so we don't hammer the endpoint on every page change.
 */
let _authCheckPromise: Promise<void> | null = null
export function initServerMode(): Promise<void> {
  state.isServerMode = isServerMode()
  if (!state.isServerMode) {
    state.authChecked = true
    return Promise.resolve()
  }
  if (_authCheckPromise) return _authCheckPromise
  _authCheckPromise = (async () => {
    try {
      const r = await $fetch('/api/auth/me') as { username: string }
      state.isAuthenticated = true
      state.username = r.username
    } catch {
      state.isAuthenticated = false
      state.username = null
    } finally {
      state.authChecked = true
    }
  })()
  return _authCheckPromise
}

/**
 * Mark the user as authenticated after a successful POST /api/auth/login.
 * Called by the login page handler so banners / nav update without a full
 * page reload (we still recommend a reload in login.vue for the cleanest
 * post-login state — every cached useFetch needs to re-run with the cookie).
 */
export function markAuthenticated(username: string): void {
  state.isAuthenticated = true
  state.username = username
  state.authChecked = true
  // A fresh session must not inherit anything stored for the previous one.
  swrClearAll()
}

/**
 * Mark the user as signed out. Called from the banner's Sign Out button
 * handler after the API call settles, then a full page reload to /login
 * clears the rest of the UI state.
 *
 * Also drops every cached API read: a stored project or channel value
 * must never survive a sign-out, or the next user of this browser tab
 * would see the previous session's data on first paint.
 */
export function markSignedOut(): void {
  state.isAuthenticated = false
  state.username = null
  swrClearAll()
}

/**
 * Get the reactive state for templates / watchers.
 * Returns readonly so callers can't bypass the marker functions above.
 */
export function useServerMode() {
  return readonly(state)
}
