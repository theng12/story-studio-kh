import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { formatTopPerformersBlock } from '../lib/top-performers.js'

describe('formatTopPerformersBlock', () => {
  test('returns empty string for an empty list', () => {
    assert.equal(formatTopPerformersBlock([]), '')
  })

  test('formats views, CTR, and multiple titles', () => {
    const output = formatTopPerformersBlock([
      { title: 'Hit Episode', views: 250_000, ctr_percentage: 4.7 },
      { title: 'New Episode', views: 47 },
    ])
    assert.match(output, /TOP PERFORMERS/)
    assert.match(output, /250K views, 4\.7% CTR/)
    assert.match(output, /47 views/)
    assert.equal(output.split('\n').filter(line => line.trim().startsWith('- ')).length, 2)
  })
})
