/**
 * Automatic chapter-only, scene-backed chapter titles (1.4.386, item 18).
 *
 * What is pinned here:
 *
 *   1. CHAPTER-ONLY. Exactly the first scene of each chapter carries a heading;
 *      the rest of the chapter keeps `show_title: false`. A chapter spanning
 *      four scenes titles one of them, not four.
 *   2. SCENE-BACKED. Membership comes from each scene's own `start_sec` against
 *      the chapter clock, including the music-lead-in shift, and the text is the
 *      narration's own chapter title — falling back to the chapter's label, to
 *      invented prose.
 *   3. FONT BINDING IS AUTOMATIC ONLY WHEN NOTHING WAS CHOSEN. An explicit
 *      `font_id`, an already-resolved `resolved_font_id` and a deliberate
 *      "today's look" (`channel_look: false`) all survive untouched; only an
 *      episode that expressed nothing is bound to the channel's pool, and the
 *      same episode id always draws the same face.
 *   4. THE CUSTOMER'S SWITCH STILL GOVERNS. `enabled: false` answers null, so
 *      the caller keeps today's render byte for byte.
 *   5. IT NEVER FAILS A RENDER. An unreadable chapter clock is a note and no
 *      titles, not an exception.
 *
 * What these cannot catch: whether the drawn heading LOOKS right, and whether
 * the bound face's glyphs cover a real heading — the latter stays with
 * `assertChapterTitleCovers` in `chapter-title-font.ts`, which these tests do
 * exercise once through `chapterTitleFontId`.
 */

import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import {
  applyAutomaticChapterTitles,
  bindChapterTitleFont,
  bindChapterTitlesToScenes,
  chapterHeadingFor,
  chapterLabelFor,
  chapterTitleScriptFor,
  chapterTitleSeedRng,
  type ChapterWindow,
} from '../lib/chapter-title-binding.js'
import { chapterTitleFontId } from '../lib/chapter-title-font.js'
import { useTempDataDir } from './_helpers.js'

const cleanups: Array<() => Promise<void>> = []
after(async () => { await Promise.all(cleanups.map(fn => fn().catch(() => {}))) })

const WINDOWS: ChapterWindow[] = [
  { slug: 'Introduction', start_sec: 5, end_sec: 15 },
  { slug: 'Chapter_01', start_sec: 17, end_sec: 60 },
  { slug: 'Chapter_02', start_sec: 62, end_sec: 120 },
]

const HEADINGS: Record<string, string> = {
  Chapter_01: 'The Quiet Harbor',
  Chapter_02: 'A Lantern in the Fog',
}

const scene = (start_sec: number) => ({ start_sec })

// ── Chapter-only ────────────────────────────────────────────────────────────

test('only the first scene of each chapter carries its heading', () => {
  const bindings = bindChapterTitlesToScenes({
    scenes: [scene(0), scene(8), scene(20), scene(35), scene(70)],
    windows: WINDOWS,
    headings: HEADINGS,
  })
  assert.deepEqual(
    bindings.map(binding => [binding.show_title, binding.title]),
    [
      [true, 'Introduction'],
      [false, null],
      [true, 'The Quiet Harbor'],
      [false, null],
      [true, 'A Lantern in the Fog'],
    ],
    'one heading per chapter, on the scene that opens it',
  )
})

test('a chapter spanning many scenes titles exactly one of them', () => {
  const bindings = bindChapterTitlesToScenes({
    scenes: [scene(17), scene(25), scene(33), scene(41), scene(50), scene(58)],
    windows: WINDOWS,
    headings: HEADINGS,
  })
  assert.equal(bindings.filter(binding => binding.show_title).length, 1)
  assert.deepEqual(bindings[0], { show_title: true, title: 'The Quiet Harbor' })
})

test('a heading falls back to the chapter label, never to invented prose', () => {
  assert.equal(chapterLabelFor('Chapter_02'), 'Chapter 02')
  assert.equal(chapterLabelFor('Introduction'), 'Introduction')
  assert.equal(chapterHeadingFor('Chapter_02', HEADINGS), 'A Lantern in the Fog')
  assert.equal(chapterHeadingFor('Chapter_07', HEADINGS), 'Chapter 07')
  assert.equal(chapterHeadingFor('Chapter_07', {}), 'Chapter 07')
  assert.equal(chapterHeadingFor('Chapter_07', null), 'Chapter 07')
})

test('the music lead-in shift moves the binding with the narration it describes', () => {
  // The plan was timed without the intro's lead-in: its clock sits 12s behind
  // the chapter clock, so scene 2 at plan-time 12 is chapter 1's opener.
  const unshifted = bindChapterTitlesToScenes({
    scenes: [scene(0), scene(12), scene(50)],
    windows: WINDOWS,
    headings: HEADINGS,
  })
  assert.deepEqual(unshifted.map(binding => binding.show_title), [true, false, true])

  const shifted = bindChapterTitlesToScenes({
    scenes: [scene(0), scene(12), scene(50)],
    windows: WINDOWS,
    headings: HEADINGS,
    leadInShiftSec: 12,
  })
  assert.deepEqual(shifted.map(binding => binding.show_title), [true, true, true],
    'with the lead-in added, plan-time 12 lands at 24s — no longer inside the intro, so it opens Chapter 01')
})

test('nothing is titled when the clock cannot say which chapter a scene belongs to', () => {
  assert.deepEqual(
    bindChapterTitlesToScenes({ scenes: [scene(20), scene(40)], windows: [] }),
    [{ show_title: false, title: null }, { show_title: false, title: null }],
  )
  assert.deepEqual(
    bindChapterTitlesToScenes({ scenes: [{ }, { }], windows: WINDOWS }),
    [{ show_title: false, title: null }, { show_title: false, title: null }],
    'an Image Pool render carries no plan clock, so guessing a chapter would be worse than showing none',
  )
  assert.deepEqual(bindChapterTitlesToScenes({ scenes: [], windows: WINDOWS }), [])
})

// ── Font binding ────────────────────────────────────────────────────────────

const POOL = {
  usage_mode: 'serial' as const,
  allow_repeat: false,
  fonts: [{ font_id: 'kantumruy-pro', weight: 1 }, { font_id: 'inter', weight: 1 }],
}

test('an episode that expressed nothing is bound to the channel font pool', () => {
  const bound = bindChapterTitleFont(null, POOL)
  assert.equal(bound?.channel_look, true)
  assert.equal(bound?.resolved_font_id, 'kantumruy-pro', 'serial starts at the first face')
  // The render resolves it exactly as 1.4.384 already did — this binding only
  // fills in the id, it never bypasses the font module's own resolution.
  assert.equal(chapterTitleFontId(bound), 'kantumruy-pro')
})

test('every deliberate choice survives binding untouched', () => {
  const explicit = { font_id: 'anton' as string }
  assert.equal(bindChapterTitleFont(explicit, POOL), explicit, 'an explicit face wins over the pool')

  const alreadyResolved = { channel_look: true, resolved_font_id: 'inter' }
  assert.equal(bindChapterTitleFont(alreadyResolved, POOL), alreadyResolved, 'a face the pool already resolved is kept')

  const todayLook = { channel_look: false }
  assert.equal(bindChapterTitleFont(todayLook, POOL), todayLook, 'a customer who chose today’s look keeps it')

  assert.equal(bindChapterTitleFont(null, null), null, 'no pool means no face, exactly as before')
  assert.equal(bindChapterTitleFont(null, { ...POOL, fonts: [] }), null, 'an empty pool is the format’s own face')
})

test('the automatic face is stable for an episode — a retry never re-rolls it', () => {
  const first = bindChapterTitleFont(null, POOL, { rng: chapterTitleSeedRng('EP0018') })
  const second = bindChapterTitleFont(null, POOL, { rng: chapterTitleSeedRng('EP0018') })
  assert.equal(first?.resolved_font_id, second?.resolved_font_id)

  const other = chapterTitleSeedRng('EP0019')
  const mine = chapterTitleSeedRng('EP0018')
  const rolls = (rng: () => number) => Array.from({ length: 6 }, () => Math.floor(rng() * 2))
  assert.notDeepEqual(rolls(other), rolls(mine), 'different episodes may stand at different places in the pool')
})

test('a weighted pool picks by weight but stays repeatable per episode', () => {
  const weighted = { usage_mode: 'weighted' as const, allow_repeat: false, fonts: [{ font_id: 'inter', weight: 1 }] }
  const a = bindChapterTitleFont(null, weighted, { rng: chapterTitleSeedRng('EP0042') })
  const b = bindChapterTitleFont(null, weighted, { rng: chapterTitleSeedRng('EP0042') })
  assert.equal(a?.resolved_font_id, 'inter')
  assert.equal(a?.resolved_font_id, b?.resolved_font_id)
})

test('the pool script follows the heading, Khmer or Latin', () => {
  assert.equal(chapterTitleScriptFor('រាត្រីនៃការគេង'), 'khmr')
  assert.equal(chapterTitleScriptFor('The Quiet Harbor'), 'latn')
  assert.equal(chapterTitleScriptFor(''), 'latn')
})

// ── The customer's switch, and failing soft ────────────────────────────────

test('the feature is off until the customer turns it on: enabled false answers null', async () => {
  cleanups.push((await useTempDataDir()).cleanup)
  const result = await applyAutomaticChapterTitles({
    slug: 'no-such-channel',
    episodeId: 'EP0001',
    enabled: false,
    scenes: [scene(0), scene(20)],
    presentation: { font_id: 'anton' },
  })
  assert.equal(result, null, 'an off switch leaves the caller exactly where it was')
})

test('an unreadable chapter clock is a note and no titles, never a failed render', async () => {
  cleanups.push((await useTempDataDir()).cleanup)
  const result = await applyAutomaticChapterTitles({
    slug: 'no-such-channel-for-chapter-titles',
    episodeId: 'EP0001',
    enabled: true,
    scenes: [scene(0), scene(20)],
  })
  assert.ok(result, 'the feature was on, so an answer comes back')
  assert.deepEqual(result!.scenes, [{ show_title: false, title: null }, { show_title: false, title: null }])
  assert.equal(result!.presentation, null)
  assert.equal(result!.notes.length, 1)
  assert.match(result!.notes[0]!, /chapter clock could not be read/)
})
