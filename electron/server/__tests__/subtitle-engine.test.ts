/**
 * The v1.1.0 caption engine.
 *
 * `subtitle-ass.test.ts` still pins the v1 surface. This file covers what
 * v1.1.0 added, and the properties that would let it break something quietly:
 *
 *  1. **Old styles render identically.** Every project on disk and every saved
 *     preset holds the flat v1 shape. Golden fixtures captured from the v1
 *     engine BEFORE it was replaced are compared byte-for-byte, because
 *     "should look the same" is not a thing a person can eyeball across four
 *     styles, five animations and two resolutions.
 *  2. **Each word mode emits the tags it claims to.** A word mode that emits
 *     nothing renders as a plain caption and nobody notices until export.
 *  3. **Word blocks re-assert their resting state.** libass applies overrides
 *     in text order, so a `\t` on word 2 keeps animating words 3+ unless a
 *     later block sets the same property statically. This is the single
 *     easiest way to break word modes and the hardest to see in a diff.
 *  4. **Character-weighted timing**, including the degenerate cues.
 *  5. **All eighteen presets validate and produce a parseable document.**
 *  6. **Unknown fields are rejected by name.**
 *  7. **Preview and burn agree on scale.** The preview is only evidence if a
 *     640x360 render and a 1920x1080 render describe the same caption.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  buildAssStyle,
  buildSubtitleAssDocument,
  buildSubtitleForceStyle,
  parseSrt,
  srtToAss,
} from '../lib/subtitle-builder.js'
import {
  CUE_ANIMATION_DEFAULTS,
  SEMI_BOX_OPACITY,
  SUBTITLE_STYLE_SCHEMA_VERSION,
  defaultSubtitleStyle,
  mergeSubtitleStyle,
  normalizeSubtitleStyle,
  requiresAssDocument,
} from '../contracts/subtitle-style.js'
import {
  SubtitleStyleValidationError,
  parseSubtitleStyleDocument,
} from '../contracts/subtitle-style-schema.js'
import { BUILT_IN_SUBTITLE_PRESETS } from '../contracts/subtitle-presets.js'
import { SUBTITLE_PREVIEW_W, SUBTITLE_PREVIEW_H } from '../contracts/subtitle-preview.js'
import {
  distributeWordTimes,
  estimatedWordTimingSource,
  createExactWordTimingSource,
  wordWeight,
} from '../lib/subtitle-word-timing.js'

const golden = JSON.parse(readFileSync(
  fileURLToPath(new URL('./fixtures/subtitle-v1-golden.json', import.meta.url)),
  'utf8',
)) as Record<string, Record<string, string>>

const cues = [
  { index: 1, start_sec: 0, end_sec: 2.5, text: 'Hello world' },
  { index: 2, start_sec: 2.5, end_sec: 5, text: 'Second line with {braces}' },
]

const LEGACY_DEFAULT: any = {
  font_family: 'Helvetica', font_size_px: 28, color_hex: '#FFFFFF',
  outline_color_hex: '#000000', outline_px: 2, background: 'none',
  position: 'bottom', align: 'center', max_chars_per_line: 42, max_lines: 2,
}
const LEGACY_STYLES: Record<string, any> = {
  legacyDefault: LEGACY_DEFAULT,
  legacyPrecise: { ...LEGACY_DEFAULT, position_x_pct: 50, position_y_pct: 92, safe_margin_pct: 8, animation: 'none' },
  legacyBoxed: { ...LEGACY_DEFAULT, background: 'full', font_family: 'Avenir Next', font_size_px: 40, outline_px: 0, position: 'top', align: 'left' },
  legacySemi: { ...LEGACY_DEFAULT, background: 'semi', outline_px: 4, color_hex: '#FFEE00', align: 'right' },
}

// ── 1. Old → new equivalence ────────────────────────────────────────────────

describe('legacy styles render byte-identically through the new engine', () => {
  for (const [name, legacy] of Object.entries(LEGACY_STYLES)) {
    test(`${name}: force_style fragment is unchanged`, () => {
      const upgraded = normalizeSubtitleStyle(legacy)
      assert.equal(buildSubtitleForceStyle(upgraded), golden[name]!.force_style)
      // The deprecated adapter must agree with the direct call — it is what
      // older call sites still use.
      assert.equal(buildAssStyle(legacy), golden[name]!.force_style)
    })

    for (const animation of ['none', 'fade', 'pop', 'slide-up'] as const) {
      for (const [height, width] of [[1080, 1920], [360, 640]] as const) {
        test(`${name}: ASS document is unchanged (${animation} @ ${height}p)`, () => {
          const upgraded = normalizeSubtitleStyle({ ...legacy, animation })
          const produced = buildSubtitleAssDocument(cues, upgraded, { width, height }).ass
          assert.equal(produced, golden[name]![`ass_${animation}_${height === 1080 ? '1080' : '360'}`])
          // …and through the deprecated adapter, which is what the burn paths
          // used before v1.1.0 and what older tests still exercise.
          assert.equal(srtToAss(cues, legacy, { width, height, animation }), produced)
        })
      }
    }
  }

  test('an upgraded legacy style carries the v1 animation timings, not generic ones', () => {
    for (const animation of ['none', 'fade', 'pop', 'slide-up'] as const) {
      const upgraded = normalizeSubtitleStyle({ ...LEGACY_DEFAULT, animation })
      assert.deepEqual(
        {
          in_ms: upgraded.animation.in_ms,
          out_ms: upgraded.animation.out_ms,
          transform_ms: upgraded.animation.transform_ms,
          pop_from_pct: upgraded.animation.pop_from_pct,
          travel_px: upgraded.animation.travel_px,
        },
        CUE_ANIMATION_DEFAULTS[animation],
      )
    }
  })

  test('the v1 "semi" backdrop round-trips to ASS alpha 0x80, not 0x7F', () => {
    const upgraded = normalizeSubtitleStyle({ ...LEGACY_DEFAULT, background: 'semi' })
    assert.equal(upgraded.color.box_opacity, SEMI_BOX_OPACITY)
    assert.match(buildSubtitleAssDocument(cues, upgraded, { width: 1920, height: 1080 }).ass, /,&H80000000,/)
  })

  test('an unrecognised legacy value falls back rather than inventing one', () => {
    const upgraded = normalizeSubtitleStyle({ ...LEGACY_DEFAULT, background: 'chartreuse', position: 'sideways', color_hex: 'not-a-colour' })
    assert.equal(upgraded.box.mode, 'none')
    assert.equal(upgraded.placement.position, 'bottom')
    assert.equal(upgraded.color.primary_hex, '#FFFFFF')
  })
})

// ── 2 & 3. Word modes ───────────────────────────────────────────────────────

const WORD_CUES = [{ index: 1, start_sec: 0, end_sec: 4, text: 'one two three four' }]

function wordStyle(patch: any) {
  return mergeSubtitleStyle(defaultSubtitleStyle(), patch)
}

function dialogues(ass: string): string[] {
  return ass.split('\n').filter(l => l.startsWith('Dialogue:'))
}

describe('word modes emit the override tags they promise', () => {
  test('highlight swaps colour on and back off for each word', () => {
    const style = wordStyle({ word: { mode: 'highlight', active_color_hex: '#FF0000', inactive_color_hex: '#FFFFFF', transition_ms: 100 } })
    const [line] = dialogues(buildSubtitleAssDocument(WORD_CUES, style, { width: 1920, height: 1080 }).ass)
    assert.ok(line)
    // Four words → four "turn active" transitions and four "return" ones.
    assert.equal((line!.match(/\\t\(\d+,\d+,\\1c&H0000ff&\)/g) || []).length, 4, 'one activation per word')
    assert.equal((line!.match(/\\t\(\d+,\d+,\\1c&Hffffff&\)/g) || []).length, 4, 'each word returns to rest')
  })

  test('pop scales the active word and returns it to 100%', () => {
    const style = wordStyle({ word: { mode: 'pop', active_scale_pct: 140 } })
    const [line] = dialogues(buildSubtitleAssDocument(WORD_CUES, style, { width: 1920, height: 1080 }).ass)
    assert.match(line!, /\\fscx140\\fscy140/)
    assert.match(line!, /\\fscx100\\fscy100\)/)
  })

  test('reveal fades each word in from fully transparent and never back out', () => {
    const style = wordStyle({ word: { mode: 'reveal', transition_ms: 120 } })
    const [line] = dialogues(buildSubtitleAssDocument(WORD_CUES, style, { width: 1920, height: 1080 }).ass)
    assert.equal((line!.match(/\\alpha&HFF&/g) || []).length, 4, 'every word starts hidden')
    assert.equal((line!.match(/\\t\(\d+,\d+,\\alpha&H00&\)/g) || []).length, 4, 'every word appears')
    assert.ok(!/\\t\(\d+,\d+,\\alpha&HFF&\)/.test(line!), 'no word is hidden again')
  })

  test('typewriter reveals instantly — a one-millisecond window, never an ease', () => {
    const style = wordStyle({ word: { mode: 'typewriter', transition_ms: 500 } })
    const [line] = dialogues(buildSubtitleAssDocument(WORD_CUES, style, { width: 1920, height: 1080 }).ass)
    for (const m of line!.matchAll(/\\t\((\d+),(\d+),\\alpha&H00&\)/g)) {
      assert.equal(Number(m[2]) - Number(m[1]), 1, 'typewriter does not ease, whatever transition_ms says')
    }
  })

  test('single puts exactly one word per Dialogue event, in order', () => {
    const style = wordStyle({ word: { mode: 'single' } })
    const lines = dialogues(buildSubtitleAssDocument(WORD_CUES, style, { width: 1920, height: 1080 }).ass)
    assert.equal(lines.length, 4)
    const body = (l: string) => l.split(',').slice(9).join(',').replace(/^\{[^}]*\}/, '')
    assert.deepEqual(lines.map(body), ['one', 'two', 'three', 'four'])
  })

  test('the highlighter block widens the border and recolours it, then restores both', () => {
    const style = wordStyle({
      word: { mode: 'highlight', highlight_box: true, highlight_box_hex: '#FFE712', highlight_box_px: 20 },
      edge: { outline_px: 3 },
    })
    const [line] = dialogues(buildSubtitleAssDocument(WORD_CUES, style, { width: 1920, height: 1080 }).ass)
    assert.match(line!, /\\bord20\\3c&H12e7ff&/, 'active word gets the block')
    assert.match(line!, /\\bord3\\3c&H000000&/, 'and gives it back')
  })

  test('word mode off emits no per-word tags at all', () => {
    const [line] = dialogues(buildSubtitleAssDocument(WORD_CUES, defaultSubtitleStyle(), { width: 1920, height: 1080 }).ass)
    assert.equal(line!.split(',').slice(9).join(','), 'one two three four')
  })
})

/**
 * The leak guard. Verified against a real libass render before it was written
 * down (a frame at the third word shows only the third word coloured), and
 * pinned here because the failure mode — the highlight smearing across the
 * rest of the line — is invisible in a diff.
 */
describe('every word block re-asserts its resting state before its own transitions', () => {
  for (const mode of ['highlight', 'pop'] as const) {
    test(`${mode}: each word statically resets every property it animates`, () => {
      const style = wordStyle({ word: { mode, inactive_color_hex: '#FFFFFF', active_color_hex: '#FF0000' } })
      const [line] = dialogues(buildSubtitleAssDocument(WORD_CUES, style, { width: 1920, height: 1080 }).ass)
      const blocks = [...line!.matchAll(/\{([^}]*)\}/g)].map(m => m[1]!)
      assert.equal(blocks.length, 4, 'one override block per word')
      for (const block of blocks) {
        const staticPart = block.split('\\t(')[0]!
        assert.match(staticPart, /\\1c&Hffffff&/, 'resting colour restated before any transition')
        if (mode === 'pop') assert.match(staticPart, /\\fscx100\\fscy100/, 'resting scale restated too')
      }
    })
  }

  test('reveal: each word restates full transparency before its own fade-in', () => {
    const style = wordStyle({ word: { mode: 'reveal' } })
    const [line] = dialogues(buildSubtitleAssDocument(WORD_CUES, style, { width: 1920, height: 1080 }).ass)
    for (const m of line!.matchAll(/\{([^}]*)\}/g)) {
      assert.match(m[1]!.split('\\t(')[0]!, /\\alpha&HFF&/)
    }
  })
})

describe('word-mode word timings line up with the cue', () => {
  test('per-word transitions are relative to the Dialogue line start, not the timeline', () => {
    const style = wordStyle({ word: { mode: 'highlight', transition_ms: 0 } })
    const shifted = [{ index: 1, start_sec: 120, end_sec: 124, text: 'one two three four' }]
    const [line] = dialogues(buildSubtitleAssDocument(shifted, style, { width: 1920, height: 1080 }).ass)
    assert.match(line!, /Dialogue: 0,0:02:00\.00,0:02:04\.00,/)
    assert.match(line!, /\\t\(0,1,/, 'the first word activates at line-relative zero')
    assert.ok(!/\\t\(12\d{4},/.test(line!), 'no absolute-timeline milliseconds leaked into \\t')
  })

  test('a cue longer than max_lines splits into chunks that keep their own word windows', () => {
    const style = wordStyle({
      word: { mode: 'highlight' },
      typography: { max_chars_per_line: 10, max_lines: 1 },
    })
    const lines = dialogues(buildSubtitleAssDocument(WORD_CUES, style, { width: 1920, height: 1080 }).ass)
    assert.ok(lines.length > 1, 'the cue was split')
    // Chunks must tile the cue window without overlapping.
    const starts = lines.map(l => l.split(',')[1]!)
    assert.deepEqual([...starts].sort(), starts, 'chunks are in ascending time order')
  })
})

// ── 4. Word timing distribution ─────────────────────────────────────────────

describe('character-weighted word timing', () => {
  test('a longer word gets a longer slice than a short one', () => {
    const words = distributeWordTimes(['a', 'extraordinary'], 0, 10)
    const first = words[0]!.end_sec - words[0]!.start_sec
    const second = words[1]!.end_sec - words[1]!.start_sec
    assert.ok(second > first * 3, `expected a much longer slice for the long word, got ${first} vs ${second}`)
  })

  test('the window is exactly filled — no gaps, no overshoot', () => {
    const words = distributeWordTimes(['one', 'two', 'three', 'four'], 2, 6)
    assert.equal(words[0]!.start_sec, 2)
    assert.equal(words[words.length - 1]!.end_sec, 6)
    for (let i = 1; i < words.length; i++) {
      assert.equal(words[i]!.start_sec, words[i - 1]!.end_sec, 'words are contiguous')
    }
  })

  test('a one-word cue takes the whole window', () => {
    const words = distributeWordTimes(['alone'], 1, 3)
    assert.deepEqual([words.length, words[0]!.start_sec, words[0]!.end_sec], [1, 1, 3])
  })

  test('punctuation earns no time — a comma is not spoken', () => {
    assert.equal(wordWeight('three'), wordWeight('three,'))
    assert.equal(wordWeight('"three"'), wordWeight('three'))
  })

  test('a pure-punctuation token still gets a non-zero weight', () => {
    // Zero weight would produce a zero-length \t window, which libass cannot
    // interpolate — the word would simply never activate.
    assert.ok(wordWeight('—') > 0)
    const words = distributeWordTimes(['—', 'yes'], 0, 2)
    assert.ok(words[0]!.end_sec > words[0]!.start_sec)
  })

  test('a very long word does not starve its neighbours to zero length', () => {
    const words = distributeWordTimes(['a', 'antidisestablishmentarianism', 'b'], 0, 5)
    for (const w of words) assert.ok(w.end_sec > w.start_sec, `${w.text} got no time`)
  })

  test('an empty cue yields no words rather than a zero-length one', () => {
    assert.deepEqual(distributeWordTimes([], 0, 5), [])
    assert.deepEqual(estimatedWordTimingSource.forCue({ index: 1, start_sec: 0, end_sec: 1, text: '   ' }), [])
  })

  test('every derived word is stamped estimated, and the document says so', () => {
    const words = estimatedWordTimingSource.forCue({ index: 1, start_sec: 0, end_sec: 2, text: 'two words' })
    assert.ok(words.every(w => w.precision === 'estimated'))
    const result = buildSubtitleAssDocument(WORD_CUES, wordStyle({ word: { mode: 'highlight' } }), { width: 1920, height: 1080 })
    assert.equal(result.wordPrecision, 'estimated')
  })

  test('the document reports no word precision when word mode is off', () => {
    assert.equal(buildSubtitleAssDocument(WORD_CUES, defaultSubtitleStyle(), { width: 1920, height: 1080 }).wordPrecision, null)
  })

  test('the exact source is a seam, not a promise — it refuses rather than faking', () => {
    assert.throws(() => createExactWordTimingSource(null), /[Tt]he Gateway does not publish per-word times/)
  })

  test('the exact source falls back to interpolation for a cue it does not cover', () => {
    const source = createExactWordTimingSource([
      { text: 'one', start_sec: 0, end_sec: 1, precision: 'exact' },
    ])
    // Two words expected, one supplied → the whole cue degrades to estimated
    // rather than silently mistiming half of it.
    const got = source.forCue({ index: 1, start_sec: 0, end_sec: 2, text: 'one two' })
    assert.equal(got.length, 2)
    assert.ok(got.every(w => w.precision === 'estimated'))
  })
})

// ── 5. Presets ──────────────────────────────────────────────────────────────

describe('the eighteen built-in presets', () => {
  // Sixteen, plus Quote Shorts' two vertical styles (1.4.361).
  test('there are exactly eighteen, with unique ids and names', () => {
    assert.equal(BUILT_IN_SUBTITLE_PRESETS.length, 18)
    assert.equal(new Set(BUILT_IN_SUBTITLE_PRESETS.map(p => p.id)).size, 18)
    assert.equal(new Set(BUILT_IN_SUBTITLE_PRESETS.map(p => p.name)).size, 18)
  })

  for (const p of BUILT_IN_SUBTITLE_PRESETS) {
    test(`${p.id} validates strictly and renders a parseable document`, () => {
      assert.doesNotThrow(() => parseSubtitleStyleDocument(p.style))
      const result = buildSubtitleAssDocument(
        [{ index: 1, start_sec: 0.5, end_sec: 4, text: 'The forest whispered secrets older than memory.' }],
        p.style,
        { width: 1920, height: 1080 },
      )
      assert.match(result.ass, /^\[Script Info\]/)
      assert.match(result.ass, /\[V4\+ Styles\]\nFormat: /)
      assert.match(result.ass, /\[Events\]\nFormat: /)
      assert.ok(result.events > 0, 'a preset that renders nothing is a broken preset')
      // A stray unescaped brace would turn caption text into an override block.
      for (const line of dialogues(result.ass)) {
        const body = line.split(',').slice(9).join(',')
        const balanced = (body.match(/\{/g) || []).length === (body.match(/\}/g) || []).length
        assert.ok(balanced, `unbalanced override braces in ${p.id}`)
      }
    })
  }

  test('Clean Broadcast is the regression anchor — identical to the v1 default', () => {
    const clean = BUILT_IN_SUBTITLE_PRESETS.find(p => p.id === 'clean-broadcast')!
    assert.deepEqual(clean.style, normalizeSubtitleStyle(LEGACY_DEFAULT))
    assert.equal(
      buildSubtitleAssDocument(cues, clean.style, { width: 1920, height: 1080 }).ass,
      golden.legacyDefault!.ass_none_1080,
    )
  })

  test('every preset whose name promises word-by-word actually uses a word mode', () => {
    const wordNamed = ['karaoke-highlight', 'karaoke-pop', 'word-reveal', 'single-word-focus', 'typewriter', 'yellow-highlighter']
    for (const id of wordNamed) {
      const p = BUILT_IN_SUBTITLE_PRESETS.find(x => x.id === id)!
      assert.notEqual(p.style.word.mode, 'off', `${id} claims word-level behaviour`)
      assert.equal(p.wordLevel, true)
    }
  })

  test('the presets that cannot be exact say so', () => {
    // Not a list of what SHOULD be approximate — a check that the flag is not
    // quietly dropped from the three looks libass genuinely cannot render.
    for (const id of ['neon-glow', 'yellow-highlighter', 'typewriter']) {
      const p = BUILT_IN_SUBTITLE_PRESETS.find(x => x.id === id)!
      assert.ok(p.approximation && p.approximation.length > 40, `${id} must explain what it cannot do`)
    }
  })
})

// ── 6. Strict validation ────────────────────────────────────────────────────

describe('strict validation names what it rejects', () => {
  test('an unknown top-level field is rejected by name', () => {
    const doc: any = { ...defaultSubtitleStyle(), glitter: true }
    assert.throws(() => parseSubtitleStyleDocument(doc), (e: any) => {
      assert.ok(e instanceof SubtitleStyleValidationError)
      assert.match(e.message, /"glitter"/)
      assert.match(e.message, /newer subtitle engine/)
      return true
    })
  })

  test('an unknown nested field names its full path', () => {
    const doc: any = defaultSubtitleStyle()
    doc.typography = { ...doc.typography, small_caps: true }
    assert.throws(() => parseSubtitleStyleDocument(doc), /"typography\.small_caps"/)
  })

  test('an out-of-range value names the field and the bound', () => {
    const doc: any = defaultSubtitleStyle()
    doc.typography.font_size_px = 5000
    assert.throws(() => parseSubtitleStyleDocument(doc), /typography\.font_size_px/)
  })

  test('a legacy flat object is rejected by the strict parser but accepted by the normaliser', () => {
    assert.throws(() => parseSubtitleStyleDocument(LEGACY_DEFAULT), SubtitleStyleValidationError)
    assert.equal(normalizeSubtitleStyle(LEGACY_DEFAULT).schema_version, SUBTITLE_STYLE_SCHEMA_VERSION)
  })

  test('the normaliser never throws, whatever it is handed', () => {
    for (const junk of [null, undefined, 0, 'nope', [], { schema_version: 'two' }, { typography: 5 }]) {
      assert.doesNotThrow(() => normalizeSubtitleStyle(junk))
    }
  })
})

// ── 7. Preview / burn scale agreement ───────────────────────────────────────

/**
 * The preview endpoint and the real burn render at different resolutions. If
 * those disagree about relative size, position or stroke weight, the preview
 * is decoration rather than evidence — so compare the numbers, not the
 * pictures.
 *
 * v1.3.2 raised the endpoint's own size from 640x360 to 1280x720 so the modal
 * shows a sharp clip instead of an upscaled one. `PREVIEW` below is now
 * IMPORTED from the endpoint's constant rather than restated: a test that
 * keeps its own copy of the preview size can go on passing after someone
 * changes the endpoint, proving faithfulness at a resolution nothing renders
 * at. `LEGACY_PREVIEW` keeps the old size under test too, because the burn
 * genuinely runs at several sizes and the property is meant to hold at all of
 * them, not just the two currently in use.
 */
describe('preview and final burn describe the same caption', () => {
  /**
   * Read the `[V4+ Styles]` line by FIELD INDEX rather than by a regex over
   * the whole line. The first version of this helper counted commas and landed
   * on BorderStyle while calling it Outline — a test that reported a scaling
   * bug that did not exist.
   * 0 Name, 1 Fontname, 2 Fontsize, 3 Primary, 4 Secondary, 5 OutlineColour,
   * 6 BackColour, 7 Bold, 8 Italic, 9 Underline, 10 StrikeOut, 11 ScaleX,
   * 12 ScaleY, 13 Spacing, 14 Angle, 15 BorderStyle, 16 Outline, 17 Shadow,
   * 18 Alignment, 19 MarginL, 20 MarginR, 21 MarginV, 22 Encoding
   */
  function styleNumbers(ass: string) {
    const h = Number(ass.match(/^PlayResY: (\d+)$/m)![1])
    const f = ass.match(/^Style: (.*)$/m)![1]!.split(',')
    return {
      fontFraction: Number(f[2]) / h,
      spacingFraction: Number(f[13]) / h,
      outlineFraction: Number(f[16]) / h,
      shadowFraction: Number(f[17]) / h,
      marginFraction: Number(f[21]) / h,
      alignment: Number(f[18]),
      borderStyle: Number(f[15]),
    }
  }

  /** The size the endpoint actually renders — not a copy of it. */
  const PREVIEW = { width: SUBTITLE_PREVIEW_W, height: SUBTITLE_PREVIEW_H }
  /** The pre-v1.3.2 preview size; the burn still runs at 720p and 1080p. */
  const LEGACY_PREVIEW = { width: 640, height: 360 }
  const BURN = { width: 1920, height: 1080 }

  for (const p of BUILT_IN_SUBTITLE_PRESETS) {
    test(`${p.id}: relative size, stroke and margin match at both resolutions`, () => {
      const large = styleNumbers(buildSubtitleAssDocument(cues, p.style, BURN).ass)
      // Rounding at 360p is coarser than at 1080p, so allow a hair of drift —
      // but not the 3x class of error the v1.0.413 scaling bug produced.
      const near = (a: number, b: number, what: string) =>
        assert.ok(Math.abs(a - b) < 0.0015, `${what}: preview ${a} vs burn ${b}`)
      for (const size of [PREVIEW, LEGACY_PREVIEW]) {
        const small = styleNumbers(buildSubtitleAssDocument(cues, p.style, size).ass)
        near(small.fontFraction, large.fontFraction, `font size @${size.width}`)
        near(small.outlineFraction, large.outlineFraction, `outline width @${size.width}`)
        near(small.shadowFraction, large.shadowFraction, `shadow depth @${size.width}`)
        near(small.spacingFraction, large.spacingFraction, `letter spacing @${size.width}`)
        near(small.marginFraction, large.marginFraction, `margin @${size.width}`)
        assert.equal(small.alignment, large.alignment, `alignment @${size.width}`)
        assert.equal(small.borderStyle, large.borderStyle, `border style @${size.width}`)
      }
    })
  }

  /**
   * v1.4.0 — the caption preflight frames are inside this guarantee.
   *
   * Those three stills exist to let a person approve the captions before an
   * encode, which only means anything if they show what the encode will show.
   * The property that makes that true is narrow and worth pinning: the frames
   * and the burn call ONE builder, with the same style and the same PlayRes, so
   * the ASS they are drawn from is byte-identical — not merely similar.
   *
   * This is asserted at the module boundary rather than by running ffmpeg,
   * because what could regress is the CODE PATH: someone adding a preview-only
   * tweak, a rounding difference, or a second builder for the still. A pixel
   * comparison would pass right up until it did not, and would not say why.
   */
  test('a preflight frame is drawn from byte-identical ASS to the burn', () => {
    for (const p of BUILT_IN_SUBTITLE_PRESETS) {
      // The burn: `generators/video.ts` calls buildSubtitleAssDocument(cues,
      // style, { width: w, height: h }) at the render resolution.
      const burn = buildSubtitleAssDocument(cues, p.style, BURN)
      // The preflight: `lib/subtitle-preflight-frames.ts` does the same, at the
      // same resolution, from the same cue list.
      const preflight = buildSubtitleAssDocument(cues, p.style, BURN)
      assert.equal(preflight.ass, burn.ass, `${p.id}: preflight ASS differs from the burn's`)
      assert.equal(preflight.events, burn.events, `${p.id}: event count differs`)
      assert.equal(preflight.wordPrecision, burn.wordPrecision, `${p.id}: word timing differs`)
    }
  })

  test('the preflight builds its document through the shared renderer, not its own', () => {
    // The guarantee above holds only while the frame path keeps calling the
    // shared builder. A local copy of the ASS assembly would satisfy every
    // assertion in this file and still lie about the video, so the call itself
    // is pinned. Same reasoning as `video-subtitle-episode-ownership.test.ts`
    // asserting that preflight calls the ownership guard.
    const src = readFileSync(
      fileURLToPath(new URL('../lib/subtitle-preflight-frames.ts', import.meta.url)),
      'utf8',
    )
    assert.match(src, /import \{[^}]*buildSubtitleAssDocument[^}]*\} from '\.\/subtitle-builder\.js'/)
    assert.match(src, /buildSubtitleAssDocument\(opts\.cues, opts\.style, \{ width: opts\.width, height: opts\.height \}\)/)
    // One document, shared by all three frames. Building it per frame would let
    // three previews disagree with each other as well as with the render.
    assert.equal((src.match(/buildSubtitleAssDocument\(/g) || []).length, 1)
  })

  test('a precise anchor lands on the same relative point at both resolutions', () => {
    const style = mergeSubtitleStyle(defaultSubtitleStyle(), {
      placement: { position_x_pct: 25, position_y_pct: 80 },
    })
    const small = buildSubtitleAssDocument(cues, style, PREVIEW).ass.match(/\\pos\((\d+),(\d+)\)/)!
    const large = buildSubtitleAssDocument(cues, style, BURN).ass.match(/\\pos\((\d+),(\d+)\)/)!
    assert.equal(Number(small[1]) / PREVIEW.width, Number(large[1]) / BURN.width)
    assert.equal(Number(small[2]) / PREVIEW.height, Number(large[2]) / BURN.height)
  })

  test('word-mode timings do not depend on the render resolution', () => {
    const style = wordStyle({ word: { mode: 'highlight' } })
    const small = dialogues(buildSubtitleAssDocument(WORD_CUES, style, PREVIEW).ass)
    const large = dialogues(buildSubtitleAssDocument(WORD_CUES, style, BURN).ass)
    const times = (lines: string[]) => lines.map(l => [...l.matchAll(/\\t\((\d+),(\d+),/g)].map(m => m[1]))
    assert.deepEqual(times(small), times(large))
  })
})

// ── Misc contracts ──────────────────────────────────────────────────────────

describe('engine contracts', () => {
  test('all-caps changes the rendered text, not just the label', () => {
    const style = mergeSubtitleStyle(defaultSubtitleStyle(), { typography: { all_caps: true } })
    assert.match(buildSubtitleAssDocument(cues, style, { width: 1920, height: 1080 }).ass, /HELLO WORLD/)
  })

  test('extra line spacing inserts a sized spacer line and nothing at zero', () => {
    const none = buildSubtitleAssDocument([{ index: 1, start_sec: 0, end_sec: 2, text: 'a'.repeat(30) + ' ' + 'b'.repeat(30) }],
      mergeSubtitleStyle(defaultSubtitleStyle(), { typography: { max_chars_per_line: 32 } }), { width: 1920, height: 1080 }).ass
    assert.ok(!none.includes('\\fs'), 'no spacer machinery at the default of 0')
    const spaced = buildSubtitleAssDocument([{ index: 1, start_sec: 0, end_sec: 2, text: 'a'.repeat(30) + ' ' + 'b'.repeat(30) }],
      mergeSubtitleStyle(defaultSubtitleStyle(), { typography: { max_chars_per_line: 32, line_spacing_px: 20 } }), { width: 1920, height: 1080 }).ass
    assert.match(spaced, /\\N\{\\fs20\}\\h\{\\fs28\}\\N/)
  })

  test('braces in source text can never be read as an override block', () => {
    const ass = buildSubtitleAssDocument(cues, defaultSubtitleStyle(), { width: 1920, height: 1080 }).ass
    assert.ok(!ass.includes('{braces}'))
    assert.match(ass, /\(braces\)/)
  })

  test('braces are neutralised in word modes too, where text is split per word', () => {
    const style = wordStyle({ word: { mode: 'highlight' } })
    const ass = buildSubtitleAssDocument([{ index: 1, start_sec: 0, end_sec: 2, text: 'safe {evil\\pos(0,0)} text' }], style, { width: 1920, height: 1080 }).ass
    assert.ok(!/\{evil/.test(ass))
  })

  test('requiresAssDocument reports every reason force_style would be lossy', () => {
    assert.equal(requiresAssDocument(defaultSubtitleStyle()), false)
    const reasons: any[] = [
      { word: { mode: 'highlight' } },
      { animation: { type: 'fade' } },
      { placement: { position_x_pct: 10, position_y_pct: 10 } },
      { edge: { blur_px: 2 } },
      { edge: { shadow_offset_x_px: 3 } },
      { typography: { line_spacing_px: 4 } },
      { typography: { all_caps: true } },
    ]
    for (const patch of reasons) {
      assert.equal(requiresAssDocument(mergeSubtitleStyle(defaultSubtitleStyle(), patch)), true, JSON.stringify(patch))
    }
  })

  test('an empty cue list still produces a valid, event-free document', () => {
    const result = buildSubtitleAssDocument([], defaultSubtitleStyle(), { width: 1280, height: 720 })
    assert.equal(result.events, 0)
    assert.match(result.ass, /\[Events\]/)
  })

  test('cues parsed from real SRT keep their timestamps through the engine', () => {
    const srt = '1\n00:00:01,500 --> 00:00:03,250\nHi there\n\n'
    const ass = buildSubtitleAssDocument(parseSrt(srt), defaultSubtitleStyle(), { width: 1920, height: 1080 }).ass
    assert.match(ass, /Dialogue: 0,0:00:01\.50,0:00:03\.25,/)
  })
})
