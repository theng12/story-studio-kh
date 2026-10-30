/**
 * Still Posts — the review board's own rules (owner, 2026-10-30).
 *
 * What is proved here: the board's filters and count line, the keys, batch approval, the failed post's
 * one fix, and the approval key (in the backend lane). The redo path itself (the retired drawing, the refused foreign path)
 * is proved against the real generator and route in the backend lane: still-post-review.test.ts.
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { stillPostSource } from './_stillPostSource'

const page = stillPostSource()

describe('still posts — the review board, as the page presents it', () => {
  test('the board shows filters, a count line, keys, batch approval and the previous drawing', () => {
    // Filters name the four things a reviewer needs, and the line says how far the batch has got.
    assert.match(page, /Needs review/)
    assert.match(page, /Approved/)
    assert.match(page, /complete/)
    assert.match(page, /approvedCount \}\} of \{\{ posts\.length \}\} approved/)
    // Keys: arrows move, A approves, R redraws, Space ticks, Esc closes — and typing is never a shortcut.
    assert.match(page, /event\.key === 'ArrowRight'/)
    assert.match(page, /event\.key === 'a' \|\| event\.key === 'A'/)
    assert.match(page, /event\.key === 'r' \|\| event\.key === 'R'/)
    assert.match(page, /target\.tagName === 'TEXTAREA'/)
    // Several posts can be approved or redone in one action.
    assert.match(page, /reviewSelected\.length/)
    assert.match(page, /still-posts\/approvals/)
    // A redo shows the old drawing and says where it is kept.
    assert.match(page, /Previous drawing \(kept in Trash\)/)
    assert.match(page, /redraws\/\$\{entry\.index\}/)
    // A failed post says why and offers the one fix.
    assert.match(page, /reviewStatus\(post\) === 'failed'/)
    assert.match(page, /Fix it on Draw/)
    // The words are edited beside the re-lettered result, never as artwork plus separate text.
    assert.match(page, /Save and re-letter/)
  })
})

describe('still posts — the preset can be initialised without a component', () => {
  test('poolsForEditing fills one real pool per language script and reads no component state', async () => {
    // This is the bug the first screenshot caught: the preset's initial value called a function that
    // read a `const` declared BELOW it, so the page threw "Cannot access 'languages' before
    // initialization" at runtime while every source-only test stayed green.
    const { poolsForEditing, scriptForLanguage } = await import('../composables/useStillPostsWorkspace')
    const pools = poolsForEditing({})
    assert.deepEqual(Object.keys(pools).sort(), ['khmr', 'latn', 'hani'].sort())
    for (const pool of Object.values(pools)) assert.equal(pool.usage_mode, 'serial')
    assert.equal(scriptForLanguage('km'), 'khmr')
    assert.equal(scriptForLanguage('zh'), 'hani')
    assert.equal(scriptForLanguage('en'), 'latn')
    // A stored pool is kept, not replaced.
    const kept = poolsForEditing({ latn: { usage_mode: 'weighted', allow_repeat: true, fonts: [{ font_id: 'inter', weight: 100 }] } })
    assert.equal(kept.latn!.fonts.length, 1)
  })
})
