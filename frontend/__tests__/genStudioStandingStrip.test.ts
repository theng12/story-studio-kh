import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const componentUrl = new URL('../components/GenStudioStandingStrip.vue', import.meta.url)
const dashboard = readFileSync(new URL('../layouts/dashboard.vue', import.meta.url), 'utf8')
const defaultLayout = readFileSync(new URL('../layouts/default.vue', import.meta.url), 'utf8')

test('both application shells render one shared GenStudio account standing strip', () => {
  assert.equal(existsSync(fileURLToPath(componentUrl)), true, 'shared standing strip must exist')
  assert.match(dashboard, /<GenStudioStandingStrip/)
  assert.match(defaultLayout, /<GenStudioStandingStrip/)
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
