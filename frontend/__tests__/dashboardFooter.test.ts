import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const dashboard = readFileSync(new URL('../layouts/dashboard.vue', import.meta.url), 'utf8')
const footerStart = dashboard.indexOf('<footer class="sidebar-credits"')
const footer = dashboard.slice(footerStart, dashboard.indexOf('</footer>', footerStart))

test('the dashboard footer keeps operational status and shows the running build', () => {
  assert.notEqual(footerStart, -1, 'the sidebar status footer must exist')
  assert.match(dashboard, /<footer class="sidebar-credits" aria-label="Story Studio status">/)
  assert.match(footer, /Story Studio online/)
  assert.doesNotMatch(dashboard, /All systems online/)

  // Deliberately reversed in v1.2.3. The account standing strip moved to the
  // top bar so credits and lanes read the same on every view; the footer now
  // carries the running build, which project pages showed nowhere before.
  assert.doesNotMatch(footer, /<GenStudioStandingStrip/)
  assert.match(footer, /class="version-badge"/)
  assert.match(footer, /v\{\{ appVersion \}\}/)
  assert.match(footer, /\{\{ buildDate \}\}/)
  assert.match(footer, /@click="openWhatsNew"/)
  assert.doesNotMatch(dashboard, /release-card|What’s new|buildDateLabel|copyVersion/)
})

test('the footer badge reports the same build facts as the channels top bar', () => {
  const defaultLayout = readFileSync(new URL('../layouts/default.vue', import.meta.url), 'utf8')
  const title = /:title="`Story Studio KH v\$\{appVersion\} · built \$\{buildDate\} — click for What's New`"/
  assert.match(footer, title)
  assert.match(defaultLayout, title)
})
