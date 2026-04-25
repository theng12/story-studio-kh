<template>
  <BrowserBlock v-if="blockBrowser" />
  <template v-else>
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
    <ToastContainer />
    <CostConfirmationDialog />
    <ConfirmDialog />
  </template>
</template>

<script setup lang="ts">
// Browser-tab guard: in production, refuse to render anything if we're not
// running inside the Electron shell (where preload.cjs sets `window.electron`).
// Without this, opening http://localhost:3001/ in Chrome loads the full UI and
// the operator can click Generate, burning real provider credit with none of
// the desktop app's safeguards. DEV is intentionally untouched so `npm run dev`
// remains usable in a browser tab for HMR-speed iteration.
const blockBrowser = import.meta.env.PROD
  && typeof window !== 'undefined'
  && !(window as unknown as { electron?: unknown }).electron
</script>
