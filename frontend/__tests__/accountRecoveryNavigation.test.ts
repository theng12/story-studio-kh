import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8')
}

test('unconfigured the Gateway and usage failures lead to the connection settings', () => {
  const strip = source('../components/GenStudioStandingStrip.vue')
  const usage = source('../pages/usage.vue')

  assert.match(strip, /appSettingsModal\.open\('connections'\)/)
  assert.match(strip, /<button\s+v-else/)
  assert.match(strip, /<NuxtLink\s+v-else-if="genstudioConfigured"/)
  // A stopped Gateway comes first and leads to the same connection settings.
  assert.match(strip, /v-if="gatewayDown"[\s\S]*?appSettingsModal\.open\('connections'\)/)
  assert.match(usage, /appSettingsModal\.open\('connections'\)/)
  assert.match(usage, /GENSTUDIO_USAGE_SCOPE_UNAVAILABLE/)
})

test('Studio Library access errors expose the actual settings recovery', () => {
  const store = source('../pages/library.vue')
  const presentation = source('../composables/useContentStore.ts')

  assert.match(presentation, /settingsAction: boolean/)
  assert.match(store, /pageError\.showSettings/)
  assert.match(store, /appSettingsModal\.open\('connections'\)/)
})

test('dashboard and channel identity offer honest first actions', () => {
  const dashboard = source('../pages/projects/[slug]/index.vue')
  const banner = source('../components/NicheMissingBanner.vue')

  assert.match(dashboard, /Start with ideas/)
  assert.match(dashboard, /v-if="noAcceptedIdeas"/)
  assert.match(dashboard, /overview\.value\?\.ideas\?\.accepted === 0 && episodeCount\.value === 0/)
  assert.match(banner, /settings#formula/)
  assert.match(banner, /Series Formula/)
  assert.match(banner, /@media \(max-width: 560px\)/)
  assert.match(banner, /grid-template-columns: 24px minmax\(0, 1fr\) auto/)
  assert.match(banner, /grid-column: 1 \/ -1/)
})

test('the sidebar reaches the Studio Library and Settings as ordinary rows (v1.4.371)', () => {
  // Owner, 2026-10-30: only All Channels stays pinned; every other destination
  // is a normal row in its own section after Publish. The old footer grid is
  // gone, so these must be reachable from the scrolling list.
  const layout = source('../layouts/dashboard.vue')
  const navStart = layout.indexOf('<nav ref="navList" class="sidebar-nav"')
  const navEnd = layout.indexOf('</nav>', navStart)
  const nav = layout.slice(navStart, navEnd)
  const footerStart = layout.indexOf('<footer class="sidebar-credits"')
  const footerEnd = layout.indexOf('</footer>', footerStart)
  const footer = layout.slice(footerStart, footerEnd)

  assert.match(nav, /<NuxtLink to="\/library"[^>]*class="nav-item"[^>]*>[\s\S]*?<\/NuxtLink>/)
  assert.match(nav, /\/projects\/\$\{slug\}\/settings`[^>]*class="nav-item"/)
  assert.match(nav, /to="\/settings"[^>]*class="nav-item"/, 'no channel: Settings is the page')
  assert.doesNotMatch(nav, /appSettingsModal\.open\(\)/, 'the list no longer opens a popup')
  assert.doesNotMatch(footer, /Studio Library|Free Up Space|>Trash</, 'the footer is status and version only')
})

test('an empty LLM catalog distinguishes missing setup from a search miss', () => {
  const selector = source('../components/ModelSelector.vue')
  const menu = source('../components/ModelMenu.vue')

  assert.match(selector, /emptyCatalogNeedsSetup/)
  assert.match(selector, /appSettingsModal\.open\('connections'\)/)
  assert.match(menu, /emptyCatalogLabel/)
  assert.match(menu, /No models match/)
})
