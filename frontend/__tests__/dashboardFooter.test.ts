import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const dashboard = readFileSync(new URL('../layouts/dashboard.vue', import.meta.url), 'utf8')

test('the dashboard footer keeps only operational status and usage', () => {
  assert.match(dashboard, /<footer class="sidebar-credits" aria-label="Story Studio status">/)
  assert.match(dashboard, /Story Studio online/)
  assert.doesNotMatch(dashboard, /All systems online/)
  assert.match(dashboard, /class="credit-card" aria-label="Credit balances"/)
  assert.match(dashboard, /to="\/usage"/)
  assert.doesNotMatch(dashboard, /release-card|What’s new|buildDateLabel|copyVersion/)
})
