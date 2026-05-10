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
  </template>
</template>

<script setup lang="ts">
import { isServerMode, initServerMode } from '~/composables/useServerMode'

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
</script>
