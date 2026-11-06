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

  const header = readFileSync(new URL('../components/AppHeader.vue', import.meta.url), 'utf8')
  assert.match(defaultLayout, /<AppHeader \/>/)
  assert.match(dashboard, /<AppHeader>/)
  assert.match(region(header, '<div class="app-header-tools">', '</div>'), /<GenStudioStandingStrip variant="inline"/)
  assert.equal(header.match(/<GenStudioStandingStrip/g)?.length, 1)
  assert.doesNotMatch(dashboard + defaultLayout, /<GenStudioStandingStrip/)
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

test('the top bar keeps live Gateway status and queue facts without money', () => {
  const component = readFileSync(componentUrl, 'utf8')
  assert.doesNotMatch(component, /\bcredits?\b|creditSummary|genstudioCredits/, 'owner removed price and credit display')
  assert.match(component, /gatewayDown/)
  assert.match(component, /gatewayJobsLine\(genstudioActiveLanes\.value, genstudioLaneLimit\.value\)/)
  assert.match(component, /usageError/)
})

test('the sign-in page does not show account standing it cannot read before sign-in', () => {
  assert.match(defaultLayout, /signingIn = computed\(\(\) => route\.path\.replace\(\/\\\/\+\$\/, ''\) === '\/login'\)/)
})

test('the top bar job count is truthful: all Gateway jobs, not "paid", and hidden when idle', async () => {
  const { gatewayJobsLine } = await import('../utils/genstudio-freshness.js')
  assert.equal(gatewayJobsLine(0, 299), '', 'nothing running → nothing shown')
  assert.equal(gatewayJobsLine(null, 299), '')
  assert.equal(gatewayJobsLine(1, 299), '1 job running · room for 298 more')
  assert.equal(gatewayJobsLine(3, null), '3 jobs running')
  const component = readFileSync(componentUrl, 'utf8')
  assert.doesNotMatch(component, /paid jobs running/)
  assert.match(component, /gatewayJobsLine\(genstudioActiveLanes\.value, genstudioLaneLimit\.value\)/)
})
