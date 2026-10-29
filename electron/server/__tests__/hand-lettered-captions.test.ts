/**
 * Hand-lettered Shorts captions (owner, 2026-10-29).
 *
 * The look: big centred hand-lettering, warm off-white ink with a soft dark
 * edge so it reads over any picture, a hand-set fade instead of a snap. The
 * references are social quote posts, not video captions, so the things worth
 * pinning are exactly the ones a "looks close enough" implementation gets
 * wrong:
 *
 *   1. The face is the BUNDLED Patrick Hand, and the burn can see it (fontsdir).
 *   2. Khmer — which Patrick Hand cannot draw at all — lands in a bundled
 *      Khmer face via the manifest, at a size Khmer can fit, SHAPED (marks
 *      attached to their base, not floating on dotted circles).
 *   3. Nothing that already ships moved: same ids, same order, same bytes for
 *      a Latin caption in every pre-existing preset.
 *
 * Every assertion below is about what the burned frame contains: a test that
 * only asserts "a preset with this id exists" passes for a preset that renders
 * Helvetica in white over a bright sky.
 *
 * The shaping evidence behind rule 2 was measured by burning frames with the
 * bundled FFmpeg on 2026-10-29 (`_orchestra/hand-captions-20261029/diagnose/`):
 * a non-zero ASS `Spacing` draws every Khmer vowel on its own dotted circle in
 * this libass build, and `\fsp0` on the line restores it. The tests pin the
 * document-level property that causes it (an override on a line whose marks
 * must stay attached, and no override ever landing INSIDE a cluster).
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { BUILT_IN_SUBTITLE_PRESETS } from '../contracts/subtitle-presets.js'
import { defaultSubtitleStyle, mergeSubtitleStyle } from '../contracts/subtitle-style.js'
import { parseSubtitleStyleDocument } from '../contracts/subtitle-style-schema.js'
import { buildSubtitleAssDocument } from '../lib/subtitle-builder.js'
import {
  bundledFallbackFamily,
  clearScriptFallbackCache,
  fallbackFamilyForLine,
  scriptLineOverride,
  type ScriptLineInput,
} from '../lib/subtitle-script-fallback.js'
import { bundledFontsFilterOption } from '../lib/subtitle-font-dir.js'
import { clearFontManifestCache, fontsResourceDir, readFontManifest } from '../lib/thumbnail-fonts.js'
import { listSubtitleStylePresets } from '../services/style-effect-loader.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '../../..')

const HAND = 'shorts-vertical-hand-lettered'
const HAND_HIGHLIGHT = 'shorts-vertical-hand-lettered-highlight'

/** A Latin line and a Khmer line, both short enough to stay on one caption line. */
const LATIN = 'some days the quiet is enough'
const KHMER = 'ថ្ងៃខ្លះ ភាពស្ងប់ស្ងាត់គឺគ្រប់គ្រាន់'

/** The size the fallback brings a Khmer line down to, at the 1080 reference. */
const KHMER_CAP_PX = 64

function presetById(id: string) {
  const found = BUILT_IN_SUBTITLE_PRESETS.find(entry => entry.id === id)
  assert.ok(found, `preset ${id} is registered`)
  return found!
}

function assFor(id: string, text: string, size = { width: 1080, height: 1920 }) {
  return buildSubtitleAssDocument(
    [{ index: 1, start_sec: 0.2, end_sec: 2.8, text }],
    presetById(id).style,
    size,
  ).ass
}

/** The Dialogue events of a document, as [event fields, text] pairs. */
function dialogueEvents(ass: string): Array<{ head: string, text: string }> {
  return ass.split('\n')
    .filter(line => line.startsWith('Dialogue:'))
    .map(line => {
      const [head, rest] = line.split('Default,,')
      const index = rest!.indexOf(',,')
      return { head: head!, text: rest!.slice(index + 2) }
    })
}

/** Every `{…}` override block in a line, in order. */
function overrideBlocks(text: string): string[] {
  return [...text.matchAll(/\{[^}]*\}/g)].map(match => match[0])
}

/** A line with every override block removed — the words libass is told to draw. */
function visibleText(text: string): string {
  return text.replace(/\{[^}]*\}/g, '')
}

/**
 * Assert that no `{…}` override starts or ends inside a grapheme cluster of the
 * words the event draws. Uses `Intl.Segmenter`, the same cluster rules a
 * shaping engine applies — a Khmer base consonant and its vowel signs are ONE
 * cluster, so a boundary between them is a failure, not a formatting detail.
 */
function assertNoOverrideInsideCluster(label: string, eventText: string): void {
  const visible = visibleText(eventText)
  const boundaries = new Set<number>([0])
  let at = 0
  for (const { segment } of new Intl.Segmenter('km', { granularity: 'grapheme' }).segment(visible)) {
    at += segment.length
    boundaries.add(at)
  }

  let visibleSoFar = 0
  for (let i = 0; i < eventText.length; i++) {
    if (eventText[i] === '{') {
      const close = eventText.indexOf('}', i)
      assert.ok(close > i, `${label} left an override block unterminated: ${eventText}`)
      assert.ok(boundaries.has(visibleSoFar),
        `${label} put an override inside a grapheme cluster at ${visibleSoFar}: ${eventText}`)
      i = close
      continue
    }
    visibleSoFar++
  }
}

function overrideFor(line: string, style = defaultSubtitleStyle(), scale = 1): string {
  const input: ScriptLineInput = {
    line,
    fontFamily: style.typography.font_family,
    fontSizePx: style.typography.font_size_px,
    letterSpacingPx: style.typography.letter_spacing_px,
    scale,
  }
  return scriptLineOverride(input)
}

describe('the hand-lettered Shorts presets are registered and listed for Shorts', () => {
  test('both presets exist, with unique ids and names', () => {
    for (const id of [HAND, HAND_HIGHLIGHT]) {
      const preset = presetById(id)
      assert.match(preset.name, /^Shorts Vertical — Hand-lettered/)
      assert.ok(preset.description.length > 40, `${id} says what it looks like`)
    }
    const ids = BUILT_IN_SUBTITLE_PRESETS.map(entry => entry.id)
    assert.equal(new Set(ids).size, ids.length, 'no duplicated preset id')
  })

  test('both validate strictly — they are shippable documents, not loose objects', () => {
    for (const id of [HAND, HAND_HIGHLIGHT]) {
      assert.doesNotThrow(() => parseSubtitleStyleDocument(presetById(id).style), id)
    }
  })

  test('both sit where the other Shorts styles sit: centred, 62%, 10% safe band', () => {
    for (const id of [HAND, HAND_HIGHLIGHT]) {
      const placement = presetById(id).style.placement
      assert.equal(placement.align, 'center', id)
      assert.equal(placement.position_x_pct, 50, id)
      assert.equal(placement.position_y_pct, 62, `${id} clears the Shorts buttons and title`)
      assert.equal(placement.safe_margin_pct, 10, id)
    }
  })

  test('the Latin type is poster-size and set in bundled Patrick Hand', () => {
    const hand = presetById(HAND).style.typography
    assert.equal(hand.font_family, 'Patrick Hand')
    // The owner's ask was "bigger, centred, expressive" — 96-110 px at the
    // 1080 reference, not ordinary subtitle size (40-46 px on the other
    // vertical styles, 28 on the broadcast default).
    assert.ok(hand.font_size_px >= 96 && hand.font_size_px <= 110,
      `${HAND} is poster-size, got ${hand.font_size_px}`)
    const earlierVertical = BUILT_IN_SUBTITLE_PRESETS
      .filter(entry => entry.id.startsWith('shorts-vertical-') && entry.id !== HAND && entry.id !== HAND_HIGHLIGHT)
    for (const entry of earlierVertical) {
      assert.ok(hand.font_size_px > entry.style.typography.font_size_px,
        `${HAND} is bigger than ${entry.id}`)
    }
    assert.equal(hand.all_caps, false, 'hand-lettering keeps its own case')
    assert.ok(hand.max_lines <= 3, 'a Short takes 2-3 short lines, never a paragraph')
    assert.ok(hand.line_spacing_px > 0, 'loose hand-set line rhythm')
  })

  test('the ink is warm off-white with a soft dark edge, not plain white type', () => {
    for (const id of [HAND, HAND_HIGHLIGHT]) {
      const style = presetById(id).style
      // #FBF4E4 — warm cream, not #FFFFFF.
      assert.match(style.color.primary_hex, /^#F[AB]/i, `${id} is warm, not pure white`)
      assert.equal(style.color.outline_hex, '#241B14', `${id} has the pen's dark edge`)
      assert.ok(style.edge.outline_px >= 4, `${id} has a real stroke`)
      assert.ok(style.edge.shadow_px > 0, `${id} carries a shadow under the ink`)
      assert.ok(style.edge.blur_px > 0, `${id} softens the shadow rather than doubling the letters`)
    }
  })

  test('the motion is the unhurried fade libass really draws, not an invented tilt', () => {
    for (const id of [HAND, HAND_HIGHLIGHT]) {
      assert.equal(presetById(id).style.animation.type, 'fade', id)
    }
    // Slower than the snappy styles (140-160ms) — a hand-set rhythm.
    assert.ok(presetById(HAND).style.animation.in_ms >= 240)
  })

  test('the highlight variant is the GENTLE one: colour only, no scale, slow ease', () => {
    const style = presetById(HAND_HIGHLIGHT).style
    assert.equal(style.word.mode, 'highlight', 'colour only — `pop` would scale the word')
    assert.equal(style.word.active_color_hex, '#F2C87B')
    assert.equal(style.word.inactive_color_hex, null, 'resting words follow the ink colour')
    assert.ok(style.word.transition_ms >= 200, 'gentle ease, not the snappy 80-90ms')
    assert.equal(presetById(HAND_HIGHLIGHT).wordLevel, true)
    assert.equal(presetById(HAND).wordLevel, false, 'the base look is not word-by-word')
  })

  test('the caption gallery lists both, with built-in origin', async () => {
    const catalog = await listSubtitleStylePresets({})
    for (const id of [HAND, HAND_HIGHLIGHT]) {
      const listed = catalog.presets.find(entry => entry.id === id)
      assert.ok(listed, `${id} is in the caption gallery`)
      assert.equal(listed!.origin?.origin, 'built-in', `${id} is free and ships with the app`)
    }
  })

  test('the content ledger gives both a free-builtin disposition, so the closure test closes', () => {
    const ledger = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'content-packs/legacy-migration-dispositions.json'), 'utf-8'),
    ) as { dispositions: Array<{ legacy_key: string; disposition: string }> }
    for (const id of [HAND, HAND_HIGHLIGHT]) {
      const entry = ledger.dispositions.find(item => item.legacy_key === `subtitle:${id}`)
      assert.ok(entry, `subtitle:${id} has a disposition`)
      assert.equal(entry!.disposition, 'retained-free-builtin', `${id} is free, like the other Shorts styles`)
    }
  })
})

describe('the fonts resolve from the bundle on any Mac', () => {
  test('Patrick Hand is a bundled face: manifest entry, real file, matching hash', async () => {
    const manifest = await readFontManifest()
    const entry = manifest.fonts.find(face => face.id === 'patrick-hand')
    assert.ok(entry, 'patrick-hand is in bundled/fonts/fonts.json')
    assert.equal(entry!.family, 'Patrick Hand')
    assert.deepEqual(entry!.scripts, ['latn'], 'Latin only — this is exactly why Khmer needs a fallback')
    assert.equal(entry!.license, 'OFL-1.1')

    const file = path.join(fontsResourceDir(), entry!.id, entry!.file)
    assert.ok(existsSync(file), `the font file ships: ${file}`)
    assert.equal(
      createHash('sha256').update(readFileSync(file)).digest('hex'),
      entry!.sha256,
      'the shipped file is the one the manifest names',
    )
    // The licence travels with the font — an OFL face without its licence is
    // not shippable.
    const licence = path.join(fontsResourceDir(), entry!.id, entry!.license_file)
    assert.ok(existsSync(licence), `the licence ships beside the font: ${licence}`)
    assert.match(readFileSync(licence, 'utf-8'), /SIL Open Font License/i)
  })

  test('the burn is told where the bundled fonts are, so the preset font is not a lottery', () => {
    const option = bundledFontsFilterOption()
    assert.match(option, /^:fontsdir=/, 'the ass filter carries a fontsdir')
    assert.ok(option.endsWith('/fonts'), `the whole fonts root is passed: ${option}`)
  })

  test('a Latin line burns in the style’s own face, at the style’s own size and spacing', () => {
    for (const id of [HAND, HAND_HIGHLIGHT]) {
      const style = presetById(id).style
      const ass = assFor(id, LATIN)
      assert.match(ass, /^Style: Default,Patrick Hand,/m, `${id} names Patrick Hand in its style line`)
      const events = dialogueEvents(ass)
      assert.ok(events.length >= 1, `${id} emitted an event`)
      for (const event of events) {
        // A Latin line needs no script override: the family, the 100 px and the
        // 1.5 px spacing all come from the style line untouched. (`\fs` does
        // appear — in the line-spacing spacer, which draws no words.)
        assert.equal(event.text.includes('\\fn'), false, `${id} added a font override for Latin`)
        assert.equal(event.text.includes('\\fsp0'), false, `${id} dropped Latin spacing`)
        for (const line of event.text.split('\\N')) {
          // Strip ASS's own markers (`\h` hard space, `\N` break) before
          // asking whether the line carries words; the line-spacing spacer is
          // `{\fs12}\h{\fs100}` and draws no text.
          const words = visibleText(line).replace(/\\[hN]/g, '')
          if (!/\p{L}/u.test(words)) continue
          for (const block of overrideBlocks(line)) {
            assert.equal(block.includes('\\fs'), false, `${id} resized a Latin line: ${block}`)
          }
        }
      }
      assert.ok(style.typography.letter_spacing_px > 0, `${id} keeps its loose hand-set spacing`)
    }
  })
})

describe('Khmer falls back to a bundled Khmer face, shaped and sized to fit', () => {
  before(() => { clearFontManifestCache(); clearScriptFallbackCache() })

  test('the manifest answers which bundled face draws Khmer', () => {
    assert.equal(bundledFallbackFamily('khmr'), 'Kantumruy Pro',
      'the manifest’s Khmer TEXT face, not a display face')
  })

  test('a Khmer line in the hand-lettered presets takes face, size cap and spacing guard', () => {
    for (const id of [HAND, HAND_HIGHLIGHT]) {
      const style = presetById(id).style
      assert.equal(
        overrideFor(KHMER, style),
        `{\\fnKantumruy Pro\\fs${KHMER_CAP_PX}\\fsp0}`,
        `${id} names the Khmer face, caps the size and drops spacing`,
      )
      const ass = assFor(id, KHMER)
      const [event] = dialogueEvents(ass)
      assert.ok(event, `${id} emitted an event`)
      // The tag sits at the START of each wrapped line — never inside a
      // grapheme cluster, which is the property that keeps shaping intact.
      for (const line of event!.text.split('\\N')) {
        const firstKhmer = line.search(/\p{Script=Khmer}/u)
        if (firstKhmer < 0) continue
        // The tag goes before the first Khmer character on the line — only
        // override blocks may sit in front of it (the cue's own \pos/\fad
        // come first on the opening line).
        const tag = `{\\fnKantumruy Pro\\fs${KHMER_CAP_PX}\\fsp0}`
        const at = line.indexOf(tag)
        assert.ok(at >= 0 && at < firstKhmer,
          `${id} tags the whole Khmer line before its first character: ${line}`)
        assert.ok(visibleText(line.slice(0, firstKhmer)) === '',
          `${id} draws no text before the Khmer line's tag: ${line}`)
      }
      // Every Khmer-bearing line in the event is tagged — none is missed by a
      // wrap that put one phrase on its own line.
      const khmerLines = event!.text.split('\\N').filter(line => /\p{Script=Khmer}/u.test(line))
      assert.equal(khmerLines.length, 2, `${id} tagged both wrapped Khmer lines`)
      assert.ok(visibleText(event!.text).includes(KHMER.split(' ')[0]!),
        `${id} still draws the Khmer words themselves`)
    }
  })

  test('the size cap is the script’s, not a shrunken style', () => {
    // The style itself stays poster-size for Latin; only the Khmer line is
    // brought down. A preset that simply used 64 px would fail the Latin test
    // above, and one that used 100 px would run a Khmer phrase off the frame.
    assert.equal(presetById(HAND).style.typography.font_size_px, 100)
    assert.equal(overrideFor(KHMER, presetById(HAND).style), '{\\fnKantumruy Pro\\fs64\\fsp0}')
    // At a smaller frame the cap scales with every other px value.
    const small = scriptLineOverride({
      line: KHMER,
      fontFamily: 'Patrick Hand',
      fontSizePx: 100,
      letterSpacingPx: 1.5,
      scale: 0.5,
    })
    assert.equal(small, '{\\fnKantumruy Pro\\fs32\\fsp0}')
  })

  test('a style that is not larger than the cap gets no size override', () => {
    const tag = scriptLineOverride({
      line: KHMER,
      fontFamily: 'Anton',
      fontSizePx: 46,
      letterSpacingPx: 0,
      scale: 1,
    })
    assert.equal(tag, '{\\fnKantumruy Pro}', 'Anton + Khmer changes family only, not size')
  })

  test('letter spacing is dropped on a line whose marks must stay attached', () => {
    // The measured defect: a non-zero ASS `Spacing` draws every Khmer vowel on
    // its own dotted circle in this libass build.
    const spaced = mergeSubtitleStyle(defaultSubtitleStyle(), {
      typography: { font_family: 'Kantumruy Pro', font_size_px: 40, letter_spacing_px: 1 },
    })
    assert.equal(overrideFor(KHMER, spaced), '{\\fsp0}',
      'a face that already covers Khmer still needs the spacing guard')
    // Latin keeps its spacing — the guard only fires where marks exist.
    assert.equal(overrideFor(LATIN, spaced), '')
    // And a style with no spacing emits nothing at all.
    assert.equal(overrideFor(KHMER, defaultSubtitleStyle()), '')
  })

  test('a face that already carries Khmer is left alone', () => {
    assert.equal(fallbackFamilyForLine(KHMER, 'Kantumruy Pro'), null)
    assert.equal(fallbackFamilyForLine(KHMER, 'Battambang'), null)
    assert.equal(fallbackFamilyForLine(KHMER, 'Moul'), null)
  })

  test('the same rule applies to every bundled Latin-only face, not just the new one', () => {
    // The rule is a property of the BURN ("a bundled face that cannot draw
    // this script hands it to the bundled face that can"), not a rule about
    // hand-lettering. Anton is Latin-only too, so a Khmer line in an Anton
    // preset now draws bundled Kantumruy Pro instead of whatever the system
    // cascade happened to offer on that Mac. Deliberate: the alternative is
    // output that differs between two Macs rendering the same caption.
    assert.equal(presetById('shorts-vertical-bounce').style.typography.font_family, 'Anton')
    assert.equal(fallbackFamilyForLine(KHMER, 'Anton'), 'Kantumruy Pro')
    assert.equal(fallbackFamilyForLine(KHMER, 'Inter'), 'Kantumruy Pro')
    assert.equal(fallbackFamilyForLine(KHMER, 'Noto Sans SC'), 'Kantumruy Pro')
    // …and the Anton preset's Khmer line renders shaped, not on dotted circles.
    const [event] = dialogueEvents(assFor('shorts-vertical-bounce', KHMER))
    assert.ok(event!.text.includes('{\\fnKantumruy Pro}'), 'the Khmer line takes the bundled face')
    assert.ok(!event!.text.includes('\\fsp0'), 'Anton sets no spacing, so no guard is needed')
  })

  test('a system face is left exactly as it was — no delivered episode moves', () => {
    // Helvetica is not in the manifest, so the burn keeps whatever the system
    // did before this existed. Changing it here would silently restyle
    // episodes nobody touched.
    assert.equal(fallbackFamilyForLine(KHMER, 'Helvetica'), null)
    assert.equal(overrideFor(KHMER, defaultSubtitleStyle()), '')
  })

  test('the fallback is data-driven: another Khmer face in the manifest wins for text', () => {
    // A throwaway bundle whose only Khmer face is a different family proves the
    // answer comes from the manifest, not from a constant in this module.
    const root = mkdtempSync(path.join(os.tmpdir(), 'story-fonts-fallback-'))
    try {
      mkdirSync(path.join(root, 'fonts'), { recursive: true })
      writeFileSync(path.join(root, 'fonts', 'fonts.json'), JSON.stringify({
        fonts: [
          { id: 'patrick-hand', family: 'Patrick Hand', role: 'display', scripts: ['latn'] },
          { id: 'khmer-test', family: 'Khmer Test Face', role: 'text', scripts: ['khmr', 'latn'] },
        ],
      }))
      const previous = process.env.STORY_STUDIO_RESOURCES_DIR
      process.env.STORY_STUDIO_RESOURCES_DIR = root
      clearFontManifestCache()
      clearScriptFallbackCache()
      try {
        assert.equal(bundledFallbackFamily('khmr'), 'Khmer Test Face')
        assert.equal(
          overrideFor(KHMER, presetById(HAND).style),
          '{\\fnKhmer Test Face\\fs64\\fsp0}',
        )
      } finally {
        if (previous === undefined) delete process.env.STORY_STUDIO_RESOURCES_DIR
        else process.env.STORY_STUDIO_RESOURCES_DIR = previous
        clearFontManifestCache()
        clearScriptFallbackCache()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('an absent bundle answers "nothing to tag" instead of throwing', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'story-fonts-none-'))
    const previous = process.env.STORY_STUDIO_RESOURCES_DIR
    process.env.STORY_STUDIO_RESOURCES_DIR = root
    clearFontManifestCache()
    clearScriptFallbackCache()
    try {
      assert.equal(bundledFallbackFamily('khmr'), null)
      assert.equal(overrideFor(KHMER, presetById(HAND).style), '{\\fsp0}',
        'with no manifest there is no face to name — only the spacing guard remains')
    } finally {
      if (previous === undefined) delete process.env.STORY_STUDIO_RESOURCES_DIR
      else process.env.STORY_STUDIO_RESOURCES_DIR = previous
      clearFontManifestCache()
      clearScriptFallbackCache()
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('the burned words are never split', () => {
  // A fallback that inserted an override between a base consonant and its
  // vowel would break shaping exactly like bad spacing does. These assertions
  // hold the real property: overrides live at line starts, and the visible text
  // of every event is the cue text, in order, with no characters moved.
  const LINES = [LATIN, KHMER]

  for (const preset of BUILT_IN_SUBTITLE_PRESETS) {
    test(`${preset.id} keeps every cluster together`, () => {
      for (const text of LINES) {
        const ass = assFor(preset.id, text)
        const events = dialogueEvents(ass)
        assert.ok(events.length >= 1, `${preset.id} emitted an event for "${text}"`)
        for (const event of events) {
          // Balanced braces: libass reads an unterminated block as text.
          assert.equal((event.text.match(/\{/g) ?? []).length, (event.text.match(/\}/g) ?? []).length)
          // Every override block opens on a GRAPHEME boundary of the words it
          // surrounds. A block between a base consonant and its vowel would
          // split the cluster and break shaping exactly like bad spacing does.
          assertNoOverrideInsideCluster(preset.id, event.text)
        }
      }
    })
  }

  test('the Khmer text reaches libass intact, codepoint for codepoint', () => {
    const style = presetById(HAND).style
    const ass = buildSubtitleAssDocument(
      [{ index: 1, start_sec: 0, end_sec: 3, text: KHMER }],
      style,
      { width: 1080, height: 1920 },
    ).ass
    const visible = dialogueEvents(ass).map(event => visibleText(event.text)).join(' ').replace(/\\N/g, ' ')
    for (const phrase of KHMER.split(' ')) {
      assert.ok(visible.includes(phrase), `the phrase survived the wrap and the overrides: ${phrase}`)
    }
    // Every Khmer codepoint of the source is present, in order.
    const source = [...KHMER].filter(ch => /\p{Script=Khmer}/u.test(ch))
    const drawn = [...visible].filter(ch => /\p{Script=Khmer}/u.test(ch))
    assert.deepEqual(drawn, source, 'no Khmer character was dropped, duplicated or reordered')
  })
})

describe('no existing preset or its rendering moved', () => {
  // The exact shipped order. A rename, a reorder or a quietly dropped style
  // fails here rather than surprising a channel that picked one.
  const SHIPPED_ORDER = [
    'clean-broadcast',
    'documentary-serif',
    'sleep-soft',
    'bold-impact',
    'karaoke-highlight',
    'karaoke-pop',
    'word-reveal',
    'single-word-focus',
    'neon-glow',
    'yellow-highlighter',
    'boxed-caption',
    'typewriter',
    'slide-up',
    'gentle-fade',
    'explainer-accent',
    'minimal-lower-third',
    'shorts-vertical',
    'shorts-vertical-word-pop',
    'shorts-vertical-bounce',
    'shorts-vertical-electric',
    'shorts-vertical-moul',
    'shorts-vertical-battambang',
    HAND,
    HAND_HIGHLIGHT,
  ]

  test('the shipped presets are all still there, in the same order, with the new pair last', () => {
    assert.deepEqual(BUILT_IN_SUBTITLE_PRESETS.map(entry => entry.id), SHIPPED_ORDER)
  })

  test('the earlier Shorts styles carry exactly the field values they shipped with', () => {
    const expected = [
      { id: 'shorts-vertical', family: 'Kantumruy Pro', size: 40, animation: 'fade', word: 'off' },
      { id: 'shorts-vertical-word-pop', family: 'Kantumruy Pro', size: 40, animation: 'none', word: 'pop' },
      { id: 'shorts-vertical-bounce', family: 'Anton', size: 46, animation: 'none', word: 'pop' },
      { id: 'shorts-vertical-electric', family: 'Anton', size: 46, animation: 'none', word: 'highlight' },
      { id: 'shorts-vertical-moul', family: 'Moul', size: 38, animation: 'fade', word: 'off' },
      { id: 'shorts-vertical-battambang', family: 'Battambang', size: 42, animation: 'slide-up', word: 'off' },
    ]
    for (const item of expected) {
      const style = presetById(item.id).style
      assert.equal(style.typography.font_family, item.family, item.id)
      assert.equal(style.typography.font_size_px, item.size, item.id)
      assert.equal(style.animation.type, item.animation, item.id)
      assert.equal(style.word.mode, item.word, item.id)
    }
  })

  test('the regression anchor is still the v1 default look', () => {
    const clean = presetById('clean-broadcast').style
    assert.equal(clean.typography.font_family, 'Helvetica')
    assert.equal(clean.typography.font_size_px, 28)
    assert.equal(clean.animation.type, 'none')
    assert.equal(clean.word.mode, 'off')
  })

  test('a Latin caption in every older preset still burns with no script override', () => {
    // The overrides can only ever ADD to a line whose script needs them; a
    // Latin caption in an older look is untouched.
    for (const preset of BUILT_IN_SUBTITLE_PRESETS) {
      if (preset.id === HAND || preset.id === HAND_HIGHLIGHT) continue
      const ass = assFor(preset.id, LATIN, { width: 1920, height: 1080 })
      assert.equal(ass.includes('\\fn'), false, `${preset.id} gained a font override`)
      assert.equal(ass.includes('\\fsp0'), false, `${preset.id} lost its letter spacing`)
    }
  })

  test('the one older look whose Khmer was broken now renders shaped — and nothing else changed', () => {
    // `explainer-accent` is the only shipped look with letter spacing, so it is
    // the only older preset whose Khmer output moves: the `\fsp0` guard is what
    // turns a line of dotted circles into readable Khmer.
    const ass = assFor('explainer-accent', KHMER)
    const [event] = dialogueEvents(ass)
    assert.ok(event!.text.includes('{\\fsp0}'), 'the Khmer line drops letter spacing')
    assert.equal(fallbackFamilyForLine(KHMER, 'Helvetica Neue'), null,
      'its face is a system face, so the family is untouched')
  })
})

describe('the rendered document is one libass can actually read', () => {
  test('a two-line hand-lettered caption in 9:16 keeps balanced braces and a real event', () => {
    const ass = assFor(HAND, 'some days the quiet is enough to hold on to for a while')
    const events = dialogueEvents(ass)
    assert.ok(events.length >= 1, 'the caption is split into events, never dropped')
    for (const event of events) {
      const opens = (event.text.match(/\{/g) ?? []).length
      const closes = (event.text.match(/\}/g) ?? []).length
      assert.equal(opens, closes, `unbalanced override braces: ${event.text}`)
    }
    assert.match(ass, /PlayResX: 1080/)
    assert.match(ass, /PlayResY: 1920/)
  })
})

after(() => {
  clearFontManifestCache()
  clearScriptFallbackCache()
})
