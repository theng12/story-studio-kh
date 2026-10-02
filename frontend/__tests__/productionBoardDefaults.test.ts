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
    // A search still finds finished episodes (it is a lookup, not a work list).
    assert.match(board, /if \(needsWorkOnly\.value && !searchActive\.value\) list = list\.filter\(ep => !isFullyDone\(ep\)\)/)
    assert.match(board, /Show all episodes/)
    assert.doesNotMatch(board, /const hidePending/)
  })

  test('shows fixed 25-episode pages with navigation above the matrix', () => {
    assert.match(board, /const EPISODES_PER_PAGE = 25/)
    assert.match(board, /slice\(start, start \+ EPISODES_PER_PAGE\)/)
    assert.match(board, /v-for="ep in paginatedEpisodes"/)
    assert.match(board, /class="board-pagination" aria-label="Episode pages"/)

    const paginationIndex = board.indexOf('class="board-pagination"')
    const matrixIndex = board.indexOf('class="board-scroll"')
    assert.ok(paginationIndex >= 0 && paginationIndex < matrixIndex, 'pagination must stay above the board matrix')

    const boardScrollCss = board.match(/\.board-scroll \{([\s\S]*?)\n\}/)?.[1] || ''
    assert.ok(boardScrollCss, 'board-scroll styles are missing')
    assert.doesNotMatch(boardScrollCss, /overflow:\s*auto|max-height/)
    assert.match(boardScrollCss, /overflow-y:\s*visible/)
  })

  test('names symbolic board actions for assistive technology', () => {
    assert.match(board, /:aria-label="cellTitle\(ep, col\)"/)
    assert.match(board, /:aria-label="markTitle\(ep, col\)"/)
    assert.match(board, /:aria-label="`Import a finished file for \$\{ep\.episode_code\}`"/)
  })
})
