<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
  <ToastContainer />
  <CostConfirmationDialog />
  <ConfirmDialog />
  <AppSettingsModal />
  <!-- Server-mode-only: in-app replacement for native folder/file pickers. -->
  <FileBrowserModal v-if="serverModeForModal" />
  <!-- Server-mode-only: connection banner with sign-out. -->
  <ServerModeBanner v-if="serverModeForModal" />
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
const wnm = useWhatsNewModal()
if (typeof window !== 'undefined') {
  void (async () => {
    if (wnm._autoCheckDone.value) return
    wnm._autoCheckDone.value = true
    // Lazy-import useApi here to avoid a top-level dependency cycle (this
    // file imports many composables already).
    const { useApi: _useApi } = await import('~/composables/useApi')
    const { get } = _useApi()
    try {
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
