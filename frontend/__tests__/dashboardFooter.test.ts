import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const dashboard = readFileSync(new URL('../layouts/dashboard.vue', import.meta.url), 'utf8')

test('the dashboard footer presents connection, balances, and release information as distinct compact cards', () => {
  assert.match(dashboard, /<footer class="sidebar-credits" aria-label="Story Studio status">/)
  assert.match(dashboard, /Story Studio online/)
  assert.doesNotMatch(dashboard, /All systems online/)
  assert.match(dashboard, /class="credit-card" aria-label="Credit balances"/)
  assert.match(dashboard, /class="release-card"/)
  assert.match(dashboard, /What’s new/)
  assert.match(dashboard, /const buildDateLabel = computed/)
  assert.doesNotMatch(dashboard, /auto · \{\{ Math\.round\(pollIntervalMs/)
})
