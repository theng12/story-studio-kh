<template>
  <BrowserBlock v-if="blockBrowser" />
  <template v-else>
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
</template>

<script setup lang="ts">
import { isServerMode, initServerMode } from '~/composables/useServerMode'
import { useWhatsNewModal } from '~/composables/useWhatsNewModal'

// Browser-tab guard: in production, refuse to render anything if we're not
// running inside the Electron shell (where preload.cjs sets `window.electron`)
// AND we're not in server mode (where the headless backend explicitly invites
// remote browser connections). Without this guard, opening http://localhost:3001/
// in Chrome would load the full UI and the operator could click Generate,
// burning real provider credit with none of the desktop app's safeguards.
//
// Server mode signals via a <meta> tag injected at serve time by Express
// (electron/main.ts → sendIndex), so the check is synchronous and zero-flicker.
// DEV is intentionally untouched so `npm run dev` remains usable in a browser
// tab for HMR-speed iteration.
const blockBrowser = import.meta.env.PROD
  && typeof window !== 'undefined'
  && !(window as unknown as { electron?: unknown }).electron
  && !isServerMode()

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
// every save. Skips when blockBrowser is true (the BrowserBlock screen
// has no place for a modal).
const wnm = useWhatsNewModal()
if (typeof window !== 'undefined' && !blockBrowser) {
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
