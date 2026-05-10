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
 * Sync read of the meta tag. Safe to call during `<script setup>` because
 * it doesn't await — index.html is already in the DOM before any Vue code
 * runs. Returns false during SSR (no `document`); the SPA is `ssr: false`
 * so this never matters in production but keeps unit tests sane.
 */
export function isServerMode(): boolean {
  if (typeof document === 'undefined') return false
  return !!document.querySelector('meta[name="story-studio-server-mode"][content="1"]')
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
      const r = await $fetch<{ username: string }>('/api/auth/me')
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
}

/**
 * Mark the user as signed out. Called from the banner's Sign Out button
 * handler after the API call settles, then a full page reload to /login
 * clears the rest of the UI state.
 */
export function markSignedOut(): void {
  state.isAuthenticated = false
  state.username = null
}

/**
 * Get the reactive state for templates / watchers.
 * Returns readonly so callers can't bypass the marker functions above.
 */
export function useServerMode() {
  return readonly(state)
}
