import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const componentUrl = new URL('../components/GenStudioStandingStrip.vue', import.meta.url)
const dashboard = readFileSync(new URL('../layouts/dashboard.vue', import.meta.url), 'utf8')
const defaultLayout = readFileSync(new URL('../layouts/default.vue', import.meta.url), 'utf8')

/** The markup between an opening marker and the first following closing tag. */
function region(source: string, open: string, close: string): string {
  const start = source.indexOf(open)
  assert.notEqual(start, -1, `expected to find ${open}`)
  const end = source.indexOf(close, start)
  assert.notEqual(end, -1, `expected ${close} after ${open}`)
  return source.slice(start, end + close.length)
}

test('both application shells render one shared standing strip in their persistent top region', () => {
  assert.equal(existsSync(fileURLToPath(componentUrl)), true, 'shared standing strip must exist')

  // Project pages (v1.2.3): inside the top bar itself, beside Page guide and
  // the notification bell, so credits and lanes never move between views.
  assert.match(
    region(dashboard, '<header class="top-bar">', '</header>'),
    /<GenStudioStandingStrip variant="inline"/,
  )
  // Channels and Content Store: the standing band pinned directly under the
  // titlebar, outside the scrolling page content. That layout has no sidebar,
  // so the strip has always been on top there.
  assert.match(
    region(defaultLayout, '<div v-if="!signingIn" class="account-standing">', '</div>'),
    /<GenStudioStandingStrip/,
  )

  // And nowhere else. The sidebar footer used to be its second home.
  assert.doesNotMatch(
    region(dashboard, '<footer class="sidebar-credits"', '</footer>'),
    /<GenStudioStandingStrip/,
  )
  assert.equal(dashboard.match(/<GenStudioStandingStrip/g)?.length, 1)
  assert.equal(defaultLayout.match(/<GenStudioStandingStrip/g)?.length, 1)
  assert.doesNotMatch(dashboard + defaultLayout, /startCreditPolling|stopCreditPolling/)
})

test('the shared strip owns one slug-independent polling lease and account navigation', () => {
  assert.equal(existsSync(fileURLToPath(componentUrl)), true, 'shared standing strip must exist')
  const component = readFileSync(componentUrl, 'utf8')
  assert.match(component, /to="\/usage"/)
  assert.match(component, /genstudioTier/)
  assert.match(component, /genstudioActiveLanes/)
  assert.match(component, /genstudioLaneLimit/)
  assert.match(component, /startPolling\(\)/)
  assert.match(component, /releasePolling\?\.\(\)/)
  assert.doesNotMatch(component, /slug|projectSlug/)
})

test('the strip carries its own top-bar shape instead of relying on a parent override', () => {
  const component = readFileSync(componentUrl, 'utf8')
  // A parent class and this component's own class tie on specificity, so the
  // winner would be decided by bundle order. A variant keeps it decided here.
  assert.match(component, /variant\?: 'stacked' \| 'inline'/)
  assert.match(component, /\.standing-strip-inline\s*\{[^}]*flex-wrap:\s*nowrap/)
  assert.match(component, /\.standing-strip-inline small\s*\{[^}]*width:\s*auto/)
})

test('the sign-in page does not show account standing it cannot read before sign-in', () => {
  assert.match(defaultLayout, /signingIn = computed\(\(\) => route\.path\.replace\(\/\\\/\+\$\/, ''\) === '\/login'\)/)
})
