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
    assert.match(board, /const needsWorkOnly = ref\(place\.needsWork\)/)
    assert.match(board, /const PLACE = \{[^}]*needsWork: true,/)
    // A search still finds finished episodes (it is a lookup, not a work list).
    assert.match(board, /const hidingFinished = computed\(\(\) => needsWorkOnly\.value && !searchActive\.value && uploadFilter\.value === 'all'\)/)
    assert.match(board, /hideFinished\(list, hidingFinished\.value, isFullyDone\)/)
    assert.match(board, /Show All Episodes/)
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

  test('keeps stage navigation above the matrix and makes the region keyboard-accessible', () => {
    assert.ok(board.indexOf('aria-label="Navigate production stages"') < board.indexOf('ref="boardScroll"'))
    assert.match(board, /ref="boardScroll" class="board-scroll" tabindex="0" role="region"/)
    assert.match(board, /region\.scrollTo\(\{ left: direction === 'start' \? 0 : region\.scrollWidth \}\)/)
    assert.match(board, /scrollStages\('assembly'\)/)
    assert.match(board, /\.board-scroll \{\s*width: 100%;\s*min-width: 0;/)
  })
})
