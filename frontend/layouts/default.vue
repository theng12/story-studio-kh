<template>
  <div class="layout">
    <a href="#main-content" class="skip-link">Skip to main content</a>
    <!-- Top bar: draggable titlebar for the hidden-inset traffic lights.
         v1.0.132+ — Version chip on the right so the user can see the
         running build from any non-project page (the dashboard layout has
         its own version badge in the sidebar footer for project pages).
         Mirrors the dashboard.vue badge: title shows full version+build,
         click opens the What's New modal. Not draggable (the chip itself
         needs to receive clicks; the surrounding bar stays draggable). -->
    <header class="top-bar">
      <div class="titlebar-drag"></div>
      <div class="top-bar-version">
        <FeatureHelpCenter />
        <button
          type="button"
          class="version-badge"
          :title="`Story Studio KH v${appVersion} · built ${buildDate} — click for What's New`"
          @click="openWhatsNew"
        >
          v{{ appVersion }}
          <span class="version-build">· {{ buildDate }}</span>
        </button>
      </div>
    </header>
    <main id="main-content" class="page-content" tabindex="-1">
      <slot />
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useWhatsNewModal } from '~/composables/useWhatsNewModal'

const { public: pubCfg } = useRuntimeConfig()
const appVersion = computed(() => (pubCfg.appVersion as string | undefined) || '0.0.0')
const buildDate = computed(() => (pubCfg.buildDate as string | undefined) || '')

const _whatsNew = useWhatsNewModal()
function openWhatsNew() { _whatsNew.open() }
</script>

<style scoped>
.layout {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}
.top-bar {
  position: sticky;
  top: 0;
  z-index: 200;
  background: var(--bg-secondary);
  flex-shrink: 0;
  /* v1.0.132+ — Layer the version chip on top of the drag region.
     position: relative on the bar; absolute on the chip wrapper so the
     drag rectangle covers the full width and the chip sits in the
     upper-right corner. Pointer-events on the chip override the
     drag-region's grab cursor so click + hover work normally. */
  position: relative;
}
.titlebar-drag {
  height: 38px;
  border-bottom: 1px solid var(--border);
  -webkit-app-region: drag;
}
.top-bar-version {
  position: absolute;
  top: 0;
  right: 12px;
  height: 38px;
  display: flex;
  align-items: center;
  gap: 8px;
  /* Click events must reach the button — opt out of the parent's drag
     region. Without this the chip catches no clicks because macOS treats
     the whole titlebar as a window-drag target. */
  -webkit-app-region: no-drag;
}
.version-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--text-muted);
  font-size: var(--font-xs);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  cursor: pointer;
  line-height: 1.2;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.version-badge:hover {
  background: rgba(255, 255, 255, 0.08);
  color: var(--text-primary);
  border-color: var(--accent);
}
.version-build {
  color: var(--text-muted);
  font-size: var(--font-xs);
}

.page-content {
  flex: 1;
  overflow-y: auto;
}
.page-content:focus { outline: none; }

.skip-link {
  position: absolute;
  top: -9999px;
  left: 0;
  z-index: 9999;
  padding: 10px 18px;
  background: var(--accent);
  color: #0f1117;
  font-weight: 600;
  text-decoration: none;
  border-radius: 0 0 var(--radius-sm) 0;
}
.skip-link:focus {
  top: 0;
  outline: 2px solid #0f1117;
  outline-offset: -4px;
}
</style>
