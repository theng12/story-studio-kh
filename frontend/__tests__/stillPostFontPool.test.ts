/**
 * Still Posts — the lettering font pool, as the page presents it.
 *
 * Two things are proved here:
 *   1. the percentages the picker prints are the shared function's own answer, so what the customer
 *      reads is what the rotation uses (AGENTS §1: an enforced limit is shown, and shown truthfully);
 *   2. the page really offers the pool — serial by default, percentages only in weighted mode, only
 *      faces the font manifest lists for that script, and the pool travels in the preset and on the
 *      batch request.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { stillPostSource } from './_stillPostSource'
import {
  DEFAULT_FONT_USAGE_MODE,
  STILL_POST_FONT_USAGE_LABELS,
  decideFont,
  emptyFontPool,
  normaliseFontPool,
  percentagesFor,
  type StillPostFontPool,
} from '../../electron/server/contracts/still-post-fonts.js'

const page = stillPostSource()
const tsconfig = readFileSync(fileURLToPath(new URL('../tsconfig.json', import.meta.url)), 'utf8')

function weighted(pairs: Array<[string, number]>): StillPostFontPool {
  return {
    usage_mode: 'weighted',
    allow_repeat: false,
    fonts: pairs.map(([font_id, weight]) => ({ font_id, weight })),
  }
}

test('the picker prints the effective percentage of every face, and they add up to 100', () => {
  assert.deepEqual(percentagesFor(weighted([['inter', 60], ['anton', 25], ['patrick-hand', 15]])), [60, 25, 15])
  // Whole numbers, so nothing reads as "33.333%"; largest remainder keeps the total exact.
  assert.deepEqual(percentagesFor(weighted([['inter', 1], ['anton', 1], ['patrick-hand', 1]])), [34, 33, 33])
  assert.equal(percentagesFor(weighted([['inter', 1], ['anton', 3]])).reduce((sum, value) => sum + value, 0), 100)
  // An empty pool has no percentages to show, and the page says the format's face is used instead.
  assert.deepEqual(percentagesFor(emptyFontPool()), [])
})

test('serial is the default, needs no configuration, and rotates in pool order', () => {
  assert.equal(DEFAULT_FONT_USAGE_MODE, 'serial')
  assert.equal(emptyFontPool().usage_mode, 'serial')
  // A preset saved with nothing, or with a mode this build does not know, is serial.
  assert.equal(normaliseFontPool({ fonts: [{ font_id: 'inter' }] }).usage_mode, 'serial')
  assert.equal(normaliseFontPool({ usage_mode: 'shuffle', fonts: [] }).usage_mode, 'serial')

  const pool = normaliseFontPool({ fonts: [{ font_id: 'inter' }, { font_id: 'anton' }] })
  const order: string[] = []
  let cursor: { last_font_id: string | null, last_index: number | null } | null = null
  for (let index = 0; index < 5; index++) {
    const chosen = decideFont(pool, cursor, () => 0)!
    order.push(chosen.font_id)
    cursor = { last_font_id: chosen.font_id, last_index: chosen.index }
  }
  assert.deepEqual(order, ['inter', 'anton', 'inter', 'anton', 'inter'])
})

test('percentages are shown only in weighted mode, and the mode is a choice in the page', () => {
  assert.match(page, /STILL_POST_FONT_USAGE_MODES/, 'the modes come from the shared contract')
  assert.match(page, /usageModeLabels\[mode\]/, 'each mode is offered by its plain-words label')
  assert.match(page, /row\.pool\.usage_mode === 'weighted'/, 'weight and percentage appear only in weighted mode')
  assert.match(page, /percentagesFor\(row\.pool\)/, 'the effective percentage is shown')
  assert.match(page, /of posts/, 'the percentage is labelled as a share of posts')
  assert.match(page, /Allow the same font twice in a row \(true random\)/, 'true random is an explicit opt-in')
  // Serial is named the way the owner names it, and the page prints the shared label rather than a
  // second copy of the wording.
  assert.equal(STILL_POST_FONT_USAGE_LABELS.serial, 'One after another')
  assert.equal(STILL_POST_FONT_USAGE_LABELS.weighted, 'By percentage')
})

test('the pool offers only faces the font manifest lists for that script', () => {
  assert.match(page, /font\.scripts\.includes\(script\)/, 'faces are filtered by the script the manifest declares')
  assert.match(page, /freeFaces\(row\)/, 'a face already in the pool is not offered twice')
  assert.match(page, /No bundled font covers/, 'a script with no bundled face says so instead of offering one')
  assert.match(page, /never add it and hope/, 'adding a face the manifest does not cover is refused in the page too')
})

test('the pool is preset content, and it travels on the batch request', () => {
  // §5: a reusable look belongs in the preset, so the preset restores it…
  assert.match(page, /preset\.font_pools = poolsForEditing\(found\.data\.font_pools\)/)
  // …and a preset with no pool blanks the previous one rather than leaving it standing (§4).
  assert.match(page, /poolsForEditing\(\{\}\)/)
  // The batch carries it, so the writer assigns faces from THIS preset.
  assert.match(page, /font_pools: preset\.font_pools/)
  // The face a post was actually given is recorded server-side, so the page never re-picks it.
  assert.doesNotMatch(page, /font_id:.*preset/, 'the page must not send a font on an individual post')
})

test('the page reads the pool rules from the shared contract module, and it resolves', () => {
  assert.match(page, /from '@shared\/still-post-fonts'/)
  assert.match(page, /from '@shared\/still-posts'/)
  // A shared value import only works because the frontend tsconfig maps it.
  assert.match(tsconfig, /"@shared\/still-post-fonts": \["\.\.\/electron\/server\/contracts\/still-post-fonts\.ts"\]/)
  assert.match(tsconfig, /"@shared\/still-posts": \["\.\.\/electron\/server\/contracts\/still-posts\.ts"\]/)
})
