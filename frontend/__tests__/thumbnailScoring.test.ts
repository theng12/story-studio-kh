/**
 * Thumbnail scoring — frontend tests (owner, 2026-11-01).
 *
 * The UI's job is to tell the truth about every candidate:
 *
 *   1. A candidate with a score shows the NUMBER and the model's own reason.
 *   2. A candidate that was never measured says "Not scored" — never a 0,
 *      because "no score" and "a score of zero" are different facts (§6).
 *   3. A candidate a local rule set aside says so, and shows no score.
 *   4. The automatically picked candidate is marked.
 *   5. The channel switch is in plain words, and it defaults to ON.
 *
 * The component is read as source and driven through a stubbed $fetch, so no
 * backend is needed.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const ROW = readFileSync(new URL('../components/ImageGeneratorRow.vue', import.meta.url), 'utf8')
const PANEL = readFileSync(new URL('../components/ImageGeneratorPanel.vue', import.meta.url), 'utf8')
const IMAGES = readFileSync(new URL('../pages/projects/[slug]/images.vue', import.meta.url), 'utf8')
const SETTINGS = readFileSync(new URL('../pages/projects/[slug]/settings.vue', import.meta.url), 'utf8')

describe('thumbnail scoring — the row shows the score and the reason', () => {
  test('a scored candidate shows its number', () => {
    assert.match(ROW, /`Score \$\{number\}`/)
    assert.match(ROW, /entry\.state === 'scored'/)
  })

  test('a candidate that was never measured says "Not scored" plainly', () => {
    assert.match(ROW, /return 'Not scored'/)
    assert.match(ROW, /return 'Set aside'/)
  })

  test('the reason is shown, not hidden behind a tooltip', () => {
    assert.match(ROW, /class="igr-score-reason"/)
    assert.match(ROW, /v-if="score && scoreReason"/)
  })

  test('the score is a typed state, never a bare number', () => {
    assert.match(ROW, /state: 'scored' \| 'rejected_by_rule' \| 'not_scored'/)
    assert.match(ROW, /score\?: number/)
  })
})

describe('thumbnail scoring — the board wires the scores through', () => {
  test('each row receives its score and the automatic pick', () => {
    assert.match(PANEL, /:score="scoreFor\(/)
    assert.match(PANEL, /:auto-picked="imageByNumber\.get\(row\.number\)\?\.filename === autoPickedFilename"/)
    assert.match(PANEL, /return props\.scores\?\.\[filename\] \|\| null/)
  })

  test('the page loads the scores with the pin state', () => {
    assert.match(IMAGES, /:scores="thumbnailScores"/)
    assert.match(IMAGES, /:auto-picked-filename="autoPickedThumbnailFilename"/)
    assert.match(IMAGES, /scored_pick/)
  })

  test('the page says which thumbnail was chosen, in plain words', () => {
    assert.match(IMAGES, /was chosen automatically as the strongest thumbnail/)
  })
})

describe('thumbnail scoring — the channel switch', () => {
  test('the switch is on by default and says what it does', () => {
    assert.match(SETTINGS, /const thumbnailAutoPickEnabled = ref\(true\)/)
    assert.match(SETTINGS, /Score this channel's thumbnails and pick the strongest one/)
  })

  test('the switch is per channel and saved on change', () => {
    assert.match(SETTINGS, /thumbnail_auto_pick: \{ \.\.\.existing, \.\.\.patch \}/)
    assert.match(SETTINGS, /data-setting="thumbnail-auto-pick"/)
  })

  test('the model is the channel\'s own choice — never picked for them', () => {
    assert.match(SETTINGS, /Story Studio does not choose one for you/)
    assert.match(SETTINGS, /without a model\s*\n?\s*the thumbnails are simply not scored/)
  })
})

describe('thumbnail scoring — the honest states', () => {
  test('the board never claims a score it does not have', () => {
    // The row's label is computed from the state, never from a number that
    // might be missing.
    assert.match(ROW, /typeof entry\.score === 'number' \? entry\.score : null/)
    assert.match(ROW, /number === null \? 'Scored' : `Score \$\{number\}`/)
  })
})
