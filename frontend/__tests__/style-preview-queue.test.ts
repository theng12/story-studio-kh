import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  runPreviewQueue,
  userStylesNeedingPreviews,
} from '../utils/style-preview-queue.js'

describe('userStylesNeedingPreviews', () => {
  test('selects only the owner\'s own styles that lack previews or are stale', () => {
    const styles = [
      { id: 'signed.a', user_style: undefined, preview_images: [] },
      { id: 'signed.b', user_style: false, preview_images: [] },
      { id: 'own.none', user_style: true, preview_images: [] },
      { id: 'own.ok', user_style: true, preview_images: ['a', 'b', 'c'] },
      { id: 'own.stale', user_style: true, preview_images: ['a'], preview_stale: true },
      { id: 'own.current', user_style: true, preview_images: ['a', 'b', 'c'], preview_stale: false },
    ]
    assert.deepEqual(
      userStylesNeedingPreviews(styles).map(s => s.id),
      ['own.none', 'own.stale'],
    )
  })
})

describe('runPreviewQueue', () => {
  test('runs each entry in order, reports progress, and collects completions', async () => {
    const seen: string[] = []
    const progress: string[] = []
    const outcome = await runPreviewQueue({
      entries: [
        { key: 'a', label: 'A' },
        { key: 'b', label: 'B' },
        { key: 'c', label: 'C' },
      ],
      async generate(entry) { seen.push(entry.key) },
      isCancelled: () => false,
      onProgress: (p) => progress.push(`${p.index}/${p.total}:${p.entry.key}:${p.status}`),
    })
    assert.deepEqual(seen, ['a', 'b', 'c'])
    assert.deepEqual(outcome.completed, ['a', 'b', 'c'])
    assert.deepEqual(outcome.failed, [])
    assert.equal(outcome.cancelled, false)
    assert.deepEqual(outcome.notStarted, [])
    assert.deepEqual(progress, [
      '1/3:a:running', '1/3:a:done',
      '2/3:b:running', '2/3:b:done',
      '3/3:c:running', '3/3:c:done',
    ])
  })

  test('a failure on one entry is reported by name and does not stop the others', async () => {
    const outcome = await runPreviewQueue({
      entries: [
        { key: 'a', label: 'A' },
        { key: 'b', label: 'B' },
        { key: 'c', label: 'C' },
      ],
      async generate(entry) {
        if (entry.key === 'b') throw new Error('b refused')
      },
      isCancelled: () => false,
    })
    assert.deepEqual(outcome.completed, ['a', 'c'])
    assert.equal(outcome.failed.length, 1)
    assert.equal(outcome.failed[0]!.key, 'b')
    assert.equal(outcome.failed[0]!.label, 'B')
    assert.match(outcome.failed[0]!.error, /b refused/)
    assert.equal(outcome.cancelled, false)
  })

  test('a stop is honoured BETWEEN entries, never mid-entry', async () => {
    const seen: string[] = []
    let cancelled = false
    const outcomePromise = runPreviewQueue({
      entries: [
        { key: 'a', label: 'A' },
        { key: 'b', label: 'B' },
        { key: 'c', label: 'C' },
        { key: 'd', label: 'D' },
      ],
      async generate(entry) {
        seen.push(entry.key)
        // Cancel right after the second entry completes.
        if (entry.key === 'b') cancelled = true
      },
      isCancelled: () => cancelled,
    })
    const outcome = await outcomePromise
    // 'a' and 'b' ran; 'c' and 'd' never started.
    assert.deepEqual(seen, ['a', 'b'])
    assert.equal(outcome.cancelled, true)
    assert.deepEqual(outcome.completed, ['a', 'b'])
    assert.deepEqual(outcome.notStarted, ['c', 'd'])
  })

  test('a stop asked for during the last entry still marks the queue as cancelled', async () => {
    let cancelled = false
    const outcome = await runPreviewQueue({
      entries: [{ key: 'only', label: 'Only' }],
      async generate() { cancelled = true },
      isCancelled: () => cancelled,
    })
    assert.equal(outcome.cancelled, true)
    assert.deepEqual(outcome.completed, ['only'])
  })

  test('an empty queue completes immediately with nothing started', async () => {
    const outcome = await runPreviewQueue({
      entries: [],
      async generate() { throw new Error('should not run') },
      isCancelled: () => false,
    })
    assert.deepEqual(outcome.completed, [])
    assert.deepEqual(outcome.failed, [])
    assert.equal(outcome.cancelled, false)
    assert.deepEqual(outcome.notStarted, [])
  })
})