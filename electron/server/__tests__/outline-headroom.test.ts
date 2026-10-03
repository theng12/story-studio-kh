/**
 * v1.4.36 — an outline may over-deliver. It may never under-deliver.
 *
 * THE OWNER'S RULING, 2026-08-23, on finding EP0056's outline binned for
 * returning 11 chapters against a target of 10:
 *
 *   "i don't want to throw it away at all. in fact i embrace this extra
 *    chapters. we must never have hardcoded maximum, it can be extra just now
 *    below our threshold. because longer videos means more screen time more ads
 *    slot. so i always want a longer video. this to me is an opportunity, i
 *    never know why there was a hardcoded 10 requirement at all. i think it's
 *    part of something i just confirmed blindly in the past."
 *
 * What made it expensive rather than merely annoying: GenStudio had COMPLETED
 * the request and CHARGED for it (`chat.response · Succeeded`), Story Studio
 * rejected the answer locally, and `outline_only` is MANUAL_ONLY — so the only
 * way forward was to pay a second time for an outline that already contained
 * everything asked for, plus one extra chapter.
 *
 * The floor is a different argument and it survives untouched: a SHORT outline
 * is padded with empty chapters that expand into unanchored filler and then
 * pass every downstream audit, because they all measure against the padded
 * length. Under-delivery must still be rejected loudly while it is cheap. Both
 * halves are asserted here so neither can be lost by someone reading only one
 * of them.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { outlineOutputContract } from '../lib/story-output-contracts.js'
import { OUTLINE_HEADROOM_DEFAULT } from '../services/app-settings.js'

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string) => readFile(path.join(SERVER, rel), 'utf8')

const chapters = (c: any) => (c.schema as any).properties.chapters
const nBound = (c: any) => chapters(c).items.properties.n

describe('the contract: a floor that holds, a ceiling that gives', () => {
  test('EP0056 exactly — 11 chapters for a target of 10 is now accepted', () => {
    const c = outlineOutputContract(10, 20)
    assert.equal(chapters(c).minItems, 10, 'ten were asked for and ten are still required')
    assert.ok(chapters(c).maxItems >= 11, 'an eleventh chapter must fit')
    assert.ok(nBound(c).maximum >= 11,
      'and it must fit at the ITEM level too — leaving n capped at the target would let the '
      + 'array bound pass and then reject the same chapter one level down')
  })

  test('the floor is untouched: nine for ten is still refused', () => {
    const c = outlineOutputContract(10, 20)
    assert.equal(chapters(c).minItems, 10,
      'a short outline is padded with empty chapters that expand into filler and pass every '
      + 'later audit — that rejection is the cheap one and it stays')
  })

  test('an absent ceiling behaves exactly as before this parameter existed', () => {
    const c = outlineOutputContract(10)
    assert.equal(chapters(c).minItems, 10)
    assert.equal(chapters(c).maxItems, 10)
    assert.equal(nBound(c).maximum, 10)
  })

  test('a ceiling below the target cannot make the floor unsatisfiable', () => {
    // Otherwise a mis-set headroom would produce minItems > maxItems: a schema
    // nothing can satisfy, rejecting every outline including a perfect one.
    const c = outlineOutputContract(10, 4)
    assert.ok(chapters(c).maxItems >= chapters(c).minItems,
      'the ceiling is raised to the floor rather than inverting the contract')
  })

  test('the ceiling is a whole number of chapters even from a fractional multiple', () => {
    const c = outlineOutputContract(10, 15.5)
    assert.equal(chapters(c).maxItems, 15)
    assert.equal(nBound(c).maximum, 15)
  })
})

describe('the ceiling is the owner\'s, not the code\'s', () => {
  test('it is a setting with a route, not a constant', async () => {
    const settings = await read('services/app-settings.ts')
    assert.match(settings, /OUTLINE_HEADROOM_KEY = 'outline_chapter_headroom'/)
    assert.match(settings, /export async function setOutlineHeadroom/)
    const route = await read('routes/app-settings.ts')
    assert.match(route, /outline_chapter_headroom: await getOutlineHeadroom\(\)/,
      'it must be readable over the API')
    assert.match(route, /settings\.setOutlineHeadroom\(req\.body\.outline_chapter_headroom\)/,
      'and writable — a number in a file he cannot reach is half a fix')
  })

  test('it has a screen, because the last two settings did not and that was the bug', async () => {
    // v1.4.249 — the row (label + request field) is in utils/performanceSettings.ts.
    const panel = await read('../../frontend/utils/performanceSettings.ts')
    assert.match(panel, /server: 'outline_chapter_headroom', label: 'Extra chapters an outline may add'/, 'the owner must be able to see the setting')
    const screen = await read('../../frontend/components/PerformanceSettings.vue')
    assert.match(screen, /throughputPayload\(models\)/, 'and the screen must actually send it')
  })

  test('the default is generous enough that EP0056 would have passed', () => {
    assert.ok(OUTLINE_HEADROOM_DEFAULT >= 1.1,
      `a default of ${OUTLINE_HEADROOM_DEFAULT}× must clear 11 chapters on a target of 10`)
    assert.ok(Math.floor(10 * OUTLINE_HEADROOM_DEFAULT) >= 11)
  })
})

describe('the extra chapters survive the whole way through', () => {
  test('buildOutline keeps a chapter numbered past the target', async () => {
    const body = await read('lib/chunked-narration.ts')
    assert.match(body, /n < 1 \|\| n > maxChapters/,
      'the out-of-range drop must use the ceiling, not the target — otherwise the schema '
      + 'accepts the extra chapter and this loop silently discards it')
    assert.match(body, /const delivered = Math\.max\(params\.totalChapters, \.\.\.\[\.\.\.byN\.keys\(\)\]\)/,
      'the fill loop must cover every slot delivered, never fewer than the target')
  })

  test('the sidecar records what was produced, not what was asked for', async () => {
    const body = await read('lib/chunked-narration.ts')
    assert.match(body, /total_chapters: outline\.length,/,
      'this one line carries an over-length outline through expansion, the completion '
      + 'audits, the outline-edit route and the cleanup sweep — all of which compare '
      + 'total_chapters to outline.length. Recording the REQUEST here would make an '
      + 'accepted 11-chapter outline fail every one of them.')
  })

  test('and the owner is told it happened', async () => {
    const body = await read('lib/chunked-narration.ts')
    assert.match(body, /came back with \$\{outline\.length\} chapters for a target of/,
      'a longer episode than requested is a thing he should see, not a silent change')
  })
})
