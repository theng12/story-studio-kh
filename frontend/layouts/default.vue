<template>
  <div class="layout">
    <a href="#main-content" class="skip-link">Skip to main content</a>
    <!-- Top bar: draggable titlebar for the hidden-inset traffic lights.
         v1.0.132+ — Version chip on the right so the user can see the
         running build from any non-project page. This layout has no sidebar,
         so the chip stays here; dashboard.vue carries the same chip in its
         sidebar footer for project pages (v1.2.3). Both show version + build
         date with the full version+build in the title, and both open the
         What's New modal on click. Not draggable (the chip itself needs to
         receive clicks; the surrounding bar stays draggable). -->
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
    <div class="account-standing">
      <GenStudioStandingStrip class="default-standing-strip" />
      <ContentInstallStrip class="default-install-strip" />
    </div>
    <main id="main-content" class="page-content" tabindex="-1">
      <slot />
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useWhatsNewModal } from '~/composables/useWhatsNewModal'
import ContentInstallStrip from '~/components/content-store/ContentInstallStrip.vue'

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
  /* **`position` is declared ONCE here, and that is the fix.** It used to appear twice —
     `sticky` at the top of this rule and `relative` below it, added for the version chip — and
     the second won. A later declaration in the same rule silently overwrites an earlier one, so
     the bar was `relative`: it scrolled away with the page, and once it was gone the page content
     slid up under the window's traffic lights, which are OS chrome pinned to the top-left and
     cannot move. The owner saw exactly that — *"the 3 traffic light is blocking the logo and
     stuff… basically when i scrolled"* — on the channels page.
     `sticky` is itself a positioned value, so it is already the containing block the absolutely
     positioned chip below needs; `relative` bought nothing and cost the reservation of the
     titlebar strip. Measured in the **built** CSS, per this repo's own rule that a declaration
     which loses is indistinguishable from one never written:
     `…flex-shrink:0;position:relative;top:0` — the minifier kept the loser and dropped `sticky`. */
  position: sticky;
  top: 0;
  z-index: 200;
  background: var(--bg-secondary);
  flex-shrink: 0;
  /* v1.0.132+ — the version chip is layered on top of the drag region: `sticky` on the bar (a
     containing block, see above), `absolute` on the chip wrapper, so the drag rectangle covers
     the full width and the chip sits in the upper-right corner. Pointer-events on the chip opt it
     out of the drag region so click and hover work normally. */
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

.account-standing {
  flex: 0 0 auto;
  padding: 7px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-secondary);
}
.default-standing-strip { width: min(100%, 620px); margin-left: auto; }
.default-install-strip { width: min(100%, 620px); margin-left: auto; margin-top: 6px; }

.page-content {
  flex: 1;
  overflow-y: auto;
}
.page-content:focus { outline: none; }

</style>
