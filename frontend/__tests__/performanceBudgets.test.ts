/**
 * 1.4.402 — the interaction budget, measured on this machine.
 *
 *   interaction ≤ 20 ms
 *
 * The workload is the channel list's own interaction: filter 500 channels by a
 * search term and sort the matches, both through the page's pure helpers.
 * Median of seven runs after a warm-up, printed as one `[perf]` line so the
 * gate log carries a number rather than a claim.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { performance } from 'node:perf_hooks'

import { matchesChannelSearch, sortChannels } from '../utils/channel-view.js'

const BUDGET_MS = 20
const ROWS = Array.from({ length: 500 }, (_, index) => ({
  slug: `channel-${index}`,
  name: `Channel ${index}`,
  labels: index % 3 === 0 ? ['history'] : [],
  edit_format: index % 2 === 0 ? 'narrated-scenes' : 'classic-chapters',
  has_api_keys: true,
  last_worked_at: new Date(2026, 0, 1 + (index % 28)).toISOString(),
})) as any[]

function interaction(): void {
  const matched = ROWS.filter(row => matchesChannelSearch(row, 'channel 4'))
  sortChannels(matched, 'recent')
}

test('filtering and sorting 500 channels meets the 20 ms interaction budget', () => {
  for (let i = 0; i < 3; i++) interaction() // warm-up
  const samples: number[] = []
  for (let i = 0; i < 7; i++) {
    const started = performance.now()
    interaction()
    samples.push(performance.now() - started)
  }
  samples.sort((a, b) => a - b)
  const median = samples[Math.floor(samples.length / 2)]!
  console.log(`[perf] interaction ${median.toFixed(2)} ms (budget ${BUDGET_MS})`)
  assert.ok(median <= BUDGET_MS, `interaction ${median.toFixed(2)} ms exceeds ${BUDGET_MS} ms`)
})
