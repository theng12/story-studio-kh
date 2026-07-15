import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

const board = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/board.vue', import.meta.url)),
  'utf8',
)

describe('Production Board defaults', () => {
  test('opens as a needs-work dashboard instead of a completed archive', () => {
    assert.match(board, /const needsWorkOnly = ref\(true\)/)
    assert.match(board, /if \(needsWorkOnly\.value\) list = list\.filter\(ep => !isFullyDone\(ep\)\)/)
    assert.match(board, /Show all episodes/)
    assert.doesNotMatch(board, /const hidePending/)
  })
})
