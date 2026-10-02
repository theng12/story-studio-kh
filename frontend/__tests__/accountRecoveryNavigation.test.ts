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

test('Content Store access errors expose the actual settings recovery', () => {
  const store = source('../pages/content-store.vue')
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
  assert.match(banner, /settings#channel/)
  assert.match(banner, /Series Formula/)
  assert.match(banner, /@media \(max-width: 560px\)/)
  assert.match(banner, /grid-template-columns: 24px minmax\(0, 1fr\) auto/)
  assert.match(banner, /grid-column: 1 \/ -1/)
})

test('sidebar keeps Store and Settings in its fixed utility footer', () => {
  const layout = source('../layouts/dashboard.vue')
  const manageStart = layout.indexOf('<span class="nav-section-label">Manage</span>')
  const manageEnd = layout.indexOf('</div>', manageStart)
  const footerStart = layout.indexOf('<footer class="sidebar-credits"')
  const footerEnd = layout.indexOf('</footer>', footerStart)
  const manage = layout.slice(manageStart, manageEnd)
  const footer = layout.slice(footerStart, footerEnd)

  assert.doesNotMatch(manage, />Content Store</)
  assert.doesNotMatch(manage, />Settings</)
  assert.match(footer, /to="\/content-store"[^>]*>Content Store</)
  assert.match(footer, /\/projects\/\$\{slug\}\/settings/)
  assert.match(footer, /v-else type="button"[^>]*appSettingsModal\.open\(\)/)
})

test('an empty LLM catalog distinguishes missing setup from a search miss', () => {
  const selector = source('../components/ModelSelector.vue')
  const menu = source('../components/ModelMenu.vue')

  assert.match(selector, /emptyCatalogNeedsSetup/)
  assert.match(selector, /appSettingsModal\.open\('connections'\)/)
  assert.match(menu, /emptyCatalogLabel/)
  assert.match(menu, /No models match/)
})
