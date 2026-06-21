import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { mapExpressionConcurrent } from '../services/audio-expression.js'

describe('expression tagging concurrency', () => {
  test('runs short chapter tagging calls concurrently while preserving result order', async () => {
    let active = 0
    let maxActive = 0
    const result = await mapExpressionConcurrent([1, 2, 3], 3, async (value) => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise(resolve => setTimeout(resolve, 20))
      active--
      return value * 10
    })

    assert.equal(maxActive, 3)
    assert.deepEqual(result, [10, 20, 30])
  })

  test('honours a lower concurrency cap', async () => {
    let active = 0
    let maxActive = 0
    await mapExpressionConcurrent([1, 2, 3, 4], 2, async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise(resolve => setTimeout(resolve, 10))
      active--
    })
    assert.equal(maxActive, 2)
  })
})
