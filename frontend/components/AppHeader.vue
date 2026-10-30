<template>
  <!-- ONE header for every non-channel page (owner, 2026-10-30).
       Before this, each page drew its own: a top strip with a name and a
       sometimes-clipped box, a separate Gateway band, and on All Channels a
       third band with links that existed nowhere else. The links sat at
       different sizes and colours and there was no way to reach the other
       pages from any of them.

       This header is the whole navigation: the mark, every destination spread
       evenly at one target size with the current page marked, then the live
       Gateway facts, the page guide and the running version. The Gateway facts
       here are the same component the channel pages use, so the two cannot
       disagree about jobs or capacity. -->
  <header class="app-header">
    <div class="app-header-bar">
      <NuxtLink to="/" class="app-header-brand" aria-label="Story Studio KH — All Channels">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="10" stroke="var(--accent)" stroke-width="1.5" />
          <path d="M15.5 12a5.5 5.5 0 0 1-9 4.24A7 7 0 0 0 12 5a5.5 5.5 0 0 1 3.5 7Z" fill="var(--accent)" opacity=".65" />
        </svg>
        <span>Story Studio KH</span>
      </NuxtLink>

      <nav class="app-header-nav" aria-label="Application">
        <NuxtLink
          v-for="link in links"
          :key="link.to"
          :to="link.to"
          class="app-header-link"
          :class="{ active: isCurrent(link) }"
          :aria-current="isCurrent(link) ? 'page' : undefined"
        >{{ link.label }}</NuxtLink>
      </nav>

      <div class="app-header-tools">
        <GenStudioStandingStrip variant="inline" class="app-header-standing" />
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
    </div>
  </header>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useWhatsNewModal } from '~/composables/useWhatsNewModal'

const route = useRoute()
const { public: pubCfg } = useRuntimeConfig()
const appVersion = computed(() => (pubCfg.appVersion as string | undefined) || '0.0.0')
const buildDate = computed(() => (pubCfg.buildDate as string | undefined) || '')

/** Every non-channel destination, in one order, each a link of the same size. */
const links = [
  { to: '/', label: 'Channels' },
  { to: '/publishing', label: 'Publishing' },
  { to: '/review', label: 'Review finals' },
  { to: '/library', label: 'Studio Library' },
  { to: '/usage', label: 'Usage' },
  { to: '/trash', label: 'Trash' },
  { to: '/settings', label: 'Settings' },
]

/** The current page is the link whose path this page is (or lives under). */
function isCurrent(link: { to: string }): boolean {
  const here = route.path.replace(/\/+$/, '') || '/'
  if (link.to === '/') return here === '/'
  return here === link.to || here.startsWith(`${link.to}/`)
}

const _whatsNew = useWhatsNewModal()
function openWhatsNew() { _whatsNew.open() }
</script>

<style scoped>
.app-header {
  position: sticky;
  top: 0;
  z-index: 200;
  flex-shrink: 0;
  border-bottom: 1px solid var(--border);
  background: var(--bg-secondary);
}
/* The hidden-inset traffic lights sit here inside the desktop app; the bar is
   the window's drag region and every control opts out of it. */
.app-header-bar {
  display: flex;
  min-height: 50px;
  align-items: center;
  gap: var(--space-3, 16px);
  padding: 0 16px 0 84px;
  -webkit-app-region: drag;
}
.app-header-brand {
  display: flex;
  flex: none;
  align-items: center;
  gap: 9px;
  color: var(--text-primary);
  font-size: var(--font-sm);
  font-weight: 700;
  text-decoration: none;
  -webkit-app-region: no-drag;
}
.app-header-nav {
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  align-items: stretch;
  justify-content: space-evenly;
  gap: var(--space-1, 4px);
  -webkit-app-region: no-drag;
}
.app-header-link {
  display: inline-flex;
  min-height: 34px;
  flex: 0 1 auto;
  align-items: center;
  justify-content: center;
  padding: 6px 12px;
  border-radius: var(--radius-md, 8px);
  color: var(--text-secondary);
  font-size: var(--font-sm);
  font-weight: 600;
  text-decoration: none;
  white-space: nowrap;
}
.app-header-link:hover { background: var(--bg-hover); color: var(--text-primary); }
.app-header-link.active {
  background: var(--accent-dim);
  color: var(--text-primary);
  box-shadow: inset 0 -2px 0 var(--accent);
}
.app-header-link:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.app-header-tools {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-2, 8px);
  -webkit-app-region: no-drag;
}
.app-header-standing { max-width: 340px; }
.version-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.04);
  color: var(--text-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: var(--font-xs);
  line-height: 1.2;
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.version-badge:hover { border-color: var(--accent); background: rgba(255, 255, 255, 0.08); color: var(--text-primary); }
.version-build { color: var(--text-muted); font-size: var(--font-xs); }

/* Narrow widths: the links stay one evenly spread row and scroll instead of
   overflowing the bar; the standing strip drops its words before the links do. */
@media (max-width: 1180px) {
  .app-header-standing { display: none; }
}
@media (max-width: 900px) {
  .app-header-bar { padding-left: 16px; }
  .app-header-nav { justify-content: flex-start; overflow-x: auto; scrollbar-width: none; }
  .app-header-link { padding: 6px 9px; }
  .version-build { display: none; }
}
</style>
