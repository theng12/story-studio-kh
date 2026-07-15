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

  test('shows fixed ten-episode pages with navigation above the matrix', () => {
    assert.match(board, /const EPISODES_PER_PAGE = 10/)
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
})
