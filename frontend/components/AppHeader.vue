<template>
  <header class="app-header">
    <div class="app-header-bar">
      <div class="app-header-identity">
        <slot name="leading" />
        <NuxtLink to="/" class="app-header-brand" aria-label="Story Studio KH — All Channels">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="12" cy="12" r="10" stroke="var(--accent)" stroke-width="1.5" />
            <path d="M15.5 12a5.5 5.5 0 0 1-9 4.24A7 7 0 0 0 12 5a5.5 5.5 0 0 1 3.5 7Z" fill="var(--accent)" opacity=".65" />
          </svg>
          <span>Story Studio KH</span>
        </NuxtLink>
      </div>

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
        <AppVersionInfo />
        <slot name="actions" />
      </div>

      <!--
        Reserved slot for the data-refresh chip: always exactly 100px wide,
        empty or not, at the END of the bar. That is what keeps the chip off
        the nav (it is in normal flow, never an overlay) and keeps the nav
        from moving when the chip appears. A failure does not need the slot —
        it takes its own strip under the bar, in flow, so it can say the whole
        reason without squeezing anything.
      -->
      <div class="app-header-refresh">
        <DataRefreshIndicator variant="pill" />
      </div>
    </div>
    <DataRefreshIndicator variant="banner" />
  </header>
</template>

<script setup lang="ts">
const route = useRoute()

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
  gap: var(--space-2, 8px);
  padding: 0 16px 0 84px;
  -webkit-app-region: drag;
}
.app-header-identity { display: flex; flex: none; align-items: center; gap: 8px; }
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
/* Equal, larger gaps between the tabs, and a pill on every one of them, so
   each reads as its own button at rest — not only when active (owner,
   2026-11-02: "each button should get a bit farther away, they are too
   close… no separating button or sth either. it should be obvious").

   The old `flex: 0 0 104px` boxed every label into the same 104px, so the long
   ones ("Review finals", "Studio Library") touched their neighbours while the
   short ones ("Usage", "Trash") floated apart. Sizing to the label with a
   constant gap and constant padding makes the spacing independent of wording. */
.app-header-nav {
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  align-items: stretch;
  justify-content: flex-start;
  gap: 10px;
  /* The brand is not a tab. Say so with a rule between them. */
  margin-left: 4px;
  padding-left: 16px;
  border-left: 1px solid var(--border);
  overflow-x: auto;
  scrollbar-width: thin;
  -webkit-app-region: no-drag;
}
.app-header-link {
  display: inline-flex;
  min-height: 34px;
  flex: none;
  align-items: center;
  justify-content: center;
  padding: 7px 14px;
  border: 1px solid transparent;
  border-radius: var(--radius-md, 8px);
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: var(--font-sm);
  font-weight: 600;
  text-decoration: none;
  white-space: nowrap;
  transition:
    background var(--motion-fast, 140ms),
    color var(--motion-fast, 140ms),
    border-color var(--motion-fast, 140ms);
}
.app-header-link:hover { background: var(--bg-hover); border-color: var(--border); color: var(--text-primary); }
.app-header-link.active {
  background: var(--accent-dim);
  border-color: color-mix(in srgb, var(--accent) 45%, transparent);
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
/*
  The reserved place for the "Updating…" chip: always exactly 100px wide,
  whether it is showing or empty, so nothing in the bar moves when it
  appears. It is the LAST item, so the space it holds is the bar's own
  slack after the tools — at the widths the app is used at, the nav gives
  up that much of its (already spare) width rather than any of its links.
*/
.app-header-refresh {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 100px;
  min-width: 0;
  -webkit-app-region: no-drag;
}
.app-header-standing { max-width: 180px; }
@media (max-width: 1300px) {
  .app-header-brand span { display: none; }
}

/*
  A window this narrow has no slack left over after the tools, so the
  reserved refresh slot is paid for by trimming each link's INNER padding
  by 4px. The 10px gap between links — the spacing this header was rebuilt
  for — is untouched, and at 1280 the nav still fits every one of its seven
  destinations with room to spare.
*/
@media (max-width: 1330px) {
  .app-header-link { padding: 7px 10px; }
}

/* Small screens: the seven destinations stop fighting the window controls and
   the tools for one squeezed row. They take a row of their own and wrap, so
   every destination is visible without scrolling a strip you cannot see into
   (owner, 2026-11-02: "collapse sensibly on small screens"). */
@media (max-width: 720px) {
  .app-header-bar { flex-wrap: wrap; row-gap: 7px; padding-block: 8px; }
  .app-header-tools { order: 2; margin-left: auto; }
  /* The nav owns rows of its own here, so the refresh chip takes the first
     row beside the brand instead: it overlays nothing, and keeping the slot
     in the flow at a fixed width means the brand and the tools hold the same
     place whether it is showing or empty. */
  .app-header-refresh { order: 1; }
  .app-header-nav {
    order: 3;
    flex: 1 1 100%;
    flex-wrap: wrap;
    gap: 8px;
    margin-left: 0;
    padding-left: 0;
    border-left: 0;
    overflow-x: visible;
    scrollbar-width: auto;
  }
}

/* At the window sizes the app actually runs in (1440 and the 1400 default),
   seven tabs plus the right-hand controls overflowed the nav and clipped
   "Settings" to "Set". Tighten the gaps and padding only below 1500 px, so a
   wide window keeps the roomy spacing the owner asked for. */
@media (max-width: 1499px) {
  .app-header-nav { gap: 8px; padding-left: 12px; }
  .app-header-link { padding: 7px 10px; }
}
</style>
