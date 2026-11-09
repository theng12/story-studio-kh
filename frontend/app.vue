<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
  <!-- The data-refresh chip and failure strip live in components/AppHeader.vue
       (reserved slot at the end of the bar + a strip under it), so they are in
       flow with the header and can never sit on top of the nav. -->
  <ToastContainer />
  <GenerationConfirmationDialog />
  <ConfirmDialog />
  <AppSettingsModal />
  <!-- Server-mode-only: in-app replacement for native folder/file pickers. -->
  <FileBrowserModal v-if="serverModeForModal" />
  <!-- v1.0.77 — What's New modal. Auto-shows once per upgrade; can also
       be opened manually from the sidebar version badge or Help menu. -->
  <WhatsNewModal />
</template>

<script setup lang="ts">
import { isServerMode, initServerMode } from '~/composables/useServerMode'
import { useWhatsNewModal } from '~/composables/useWhatsNewModal'

// v1.0.110 — removed the BrowserBlock guard that prevented loading the SPA
// from a non-Electron browser tab unless server mode was detected. Two
// reasons:
//
//   1. The detection relied on a `<meta name="story-studio-server-mode">`
//      tag that Express only injected into the ROOT `/index.html`. Nuxt's
//      static build emits a separate `login/index.html`, `projects/.../
//      index.html`, etc. — express.static served those raw, no meta tag, so
//      navigating directly to any non-root URL falsely tripped the block
//      even though server mode was active.
//   2. For this app's single-user / personal-use threat model, server mode's
//      session-cookie auth already gates everything. The block was a
//      defence-in-depth feature that turned into a friction tax.
//
// Removing it: any non-Electron browser fetch lands on the SPA directly. In
// desktop mode the backend still binds 127.0.0.1, so accidentally pointing
// a remote browser at the host requires explicit server-mode opt-in. In
// server mode, login.vue + the auth-gate middleware do the work.

// Mount the file-browser modal only when server mode is active — saves the
// component cost in the common (Electron) case and prevents a stray modal
// from ever leaking into the desktop UI.
const serverModeForModal = isServerMode()

// Kick off the auth-state check (fire-and-forget). The composable caches the
// result so subsequent calls from pages / banners don't re-fetch.
if (typeof window !== 'undefined') {
  initServerMode().catch(() => { /* anonymous → login page handles it */ })
}

// v1.0.77 — auto-show "What's New" once per app upgrade. Compares the
// runtime app version to last_seen_version persisted in app-settings; if
// they differ (or last_seen has never been set on this machine), pop the
// modal so the user sees the changelog. The modal's close handler PUTs
// the current version back so the next launch is silent until the next
// upgrade. Wrapped in HMR/dev guard so the dev cycle doesn't pop it on
// every save.
//
// v1.0.112 — gate the probe on auth-ready in server mode. Without the gate,
// app.vue mounted on /login → fired this fetch → backend returned 401 →
// useApi redirected to /login → infinite refresh loop. The fetch hits an
// auth-gated endpoint, so it can't run before initServerMode() confirms
// the user is signed in. Desktop mode hits no auth gate, so it runs
// immediately (initServerMode resolves synchronously for non-server-mode).
const wnm = useWhatsNewModal()
const useApiPromise = typeof window !== 'undefined'
  ? import('~/composables/useApi')
  : null
if (typeof window !== 'undefined') {
  void (async () => {
    if (wnm._autoCheckDone.value) return
    wnm._autoCheckDone.value = true
    // Wait for the auth-state probe to settle. In desktop mode this
    // resolves immediately (state.authChecked is set synchronously). In
    // server mode it awaits the /api/auth/me round-trip.
    await initServerMode().catch(() => {})
    // In server mode, skip when anonymous — the gated endpoint would
    // 401 and useApi would helpfully redirect to /login, which on a fresh
    // remote-browser load IS the page we're already on → infinite loop.
    const { useServerMode } = await import('~/composables/useServerMode')
    const sm = useServerMode()
    if (sm.isServerMode && !sm.isAuthenticated) return
    const { useApi: _useApi } = await useApiPromise!
    const { get } = _useApi()
    try {
      // v1.4.6 — never on a machine that has not been set up yet.
      //
      // On a brand-new Mac `last_seen_version` is unset, so this fired
      // immediately and covered the welcome screen — the one screen he MUST
      // complete before the app can do anything, and the one he cannot report a
      // bug on because he cannot get past it. Release notes for a version he has
      // never run are noise at that moment; they keep until he is inside.
      const { useLibrary } = await import('~/composables/useLibrary')
      const library = await useLibrary().load()
      if (library && !library.configured) return
      const r = await get<{ last_seen_version: string | null }>('/app-settings/last-seen-version')
      const { public: pubCfg } = useRuntimeConfig()
      const current = (pubCfg.appVersion as string | undefined) || ''
      // First-launch (last_seen null) OR version mismatch → show. Including
      // first-launch is intentional — a freshly-installed user wants to see
      // what's in the build they just downloaded.
      if (current && r.last_seen_version !== current) {
        wnm.open()
      }
    } catch { /* non-fatal — user can still open via the sidebar button */ }
  })()
}
</script>
