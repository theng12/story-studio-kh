import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const dashboard = readFileSync(new URL('../layouts/dashboard.vue', import.meta.url), 'utf8')
const app = readFileSync(new URL('../app.vue', import.meta.url), 'utf8')
const banner = readFileSync(new URL('../components/ServerModeBanner.vue', import.meta.url), 'utf8')
const footerStart = dashboard.indexOf('<footer class="sidebar-credits"')
const footer = dashboard.slice(footerStart, dashboard.indexOf('</footer>', footerStart))

test('the dashboard footer keeps operational status and shows the running build', () => {
  assert.notEqual(footerStart, -1, 'the sidebar status footer must exist')
  assert.match(dashboard, /<footer class="sidebar-credits" aria-label="Story Studio status">/)
  // The footer reports the Gateway, not only the local engine (which is up whenever the window is).
  assert.match(footer, /\{\{ connection\.label \}\}/)
  assert.match(footer, /v-if="connection\.hint"/)
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

test('the footer badge reports the same build facts as the shared header', () => {
  // v1.4.371 — the top bar moved into components/AppHeader.vue, rendered by the
  // default layout for every non-channel page.
  const header = readFileSync(new URL('../components/AppHeader.vue', import.meta.url), 'utf8')
  const defaultLayout = readFileSync(new URL('../layouts/default.vue', import.meta.url), 'utf8')
  const title = /:title="`Story Studio KH v\$\{appVersion\} · built \$\{buildDate\} — click for What's New`"/
  assert.match(footer, title)
  assert.match(header, title)
  assert.match(defaultLayout, /<AppHeader \/>/)
})

test('the signed-in browser line and sign-out live in the sidebar footer, never over the page', () => {
  // The old global pill floated bottom-right over page actions. It is the same
  // session line and sign-out, now in normal flow under the connection status.
  assert.doesNotMatch(app, /<ServerModeBanner/)
  assert.match(footer, /v-if="connection\.hint"[\s\S]*<ServerModeBanner \/>[\s\S]*class="version-badge"/)
  assert.doesNotMatch(banner, /position:\s*fixed/)
  assert.doesNotMatch(banner, /latency|ssm-dot|setInterval/, 'the sidebar connection row owns status truth')
  assert.match(banner, /\/api\/auth\/logout/)
  assert.match(banner, /flex-wrap:\s*wrap/)
  assert.match(banner, /overflow-wrap:\s*anywhere/)
})

test('the project sidebar reaches the existing Image Pool beside Assets Library', () => {
  const assets = dashboard.indexOf('>Assets Library</span>')
  const imagePool = dashboard.indexOf('>Image Pool</span>')
  assert.notEqual(assets, -1)
  assert.notEqual(imagePool, -1)
  assert.ok(imagePool > assets, 'Image Pool belongs after Assets Library in the Manage group')
  assert.match(
    dashboard.slice(assets, imagePool + '>Image Pool</span>'.length),
    /:to="`\/projects\/\$\{slug\}\/image-pool`"[\s\S]{0,160}>Image Pool<\/span>/,
  )
})

test('the collapsed-sidebar Menu button sits clear of the macOS traffic lights', () => {
  assert.match(dashboard, /<template #leading>[\s\S]*class="menu-toggle"/)
  const header = readFileSync(new URL('../components/AppHeader.vue', import.meta.url), 'utf8')
  assert.match(header, /\.app-header-bar\s*\{[^}]*padding:[^;]*84px/)
})
