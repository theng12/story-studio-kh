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
 *      Khmer face via the manifest, not in boxes and not in a system face.
 *   3. Nothing that already ships moved: same ids, same order, same bytes for
 *      a Latin caption in every pre-existing preset.
 *
 * Every assertion below is about what the burned frame contains: a test that
 * only asserts "a preset with this id exists" passes for a preset that renders
 * Helvetica in white over a bright sky.
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { BUILT_IN_SUBTITLE_PRESETS } from '../contracts/subtitle-presets.js'
import { parseSubtitleStyleDocument } from '../contracts/subtitle-style-schema.js'
import { buildSubtitleAssDocument } from '../lib/subtitle-builder.js'
import {
  bundledFallbackFamily,
  clearScriptFallbackCache,
  scriptFallbackTag,
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
const KHMER = 'ថ្ងៃខ្លះភាពស្ងប់ស្ងាត់គឺគ្រប់គ្រាន់'

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

  test('the type is bigger than every earlier vertical style and set in bundled Patrick Hand', () => {
    const hand = presetById(HAND).style.typography
    assert.equal(hand.font_family, 'Patrick Hand')
    // Patrick Hand has a small x-height for its point size, so "bigger" is the
    // whole ask: no earlier vertical preset is above 46px at the 1080 reference.
    const earlierVertical = BUILT_IN_SUBTITLE_PRESETS
      .filter(entry => entry.id.startsWith('shorts-vertical-') && entry.id !== HAND && entry.id !== HAND_HIGHLIGHT)
    for (const entry of earlierVertical) {
      assert.ok(hand.font_size_px > entry.style.typography.font_size_px,
        `${HAND} is bigger than ${entry.id}`)
    }
    assert.equal(hand.all_caps, false, 'hand-lettering keeps its own case')
    assert.ok(hand.line_spacing_px > 0, 'loose hand-set line rhythm')
  })

  test('the ink is warm off-white with a soft dark edge, not plain white type', () => {
    for (const id of [HAND, HAND_HIGHLIGHT]) {
      const style = presetById(id).style
      // #FBF4E4 — warm cream, not #FFFFFF.
      assert.match(style.color.primary_hex, /^#FB|^#FA/i, `${id} is warm, not pure white`)
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

  test('a Latin line burns in the style’s own face, with no fallback tag', () => {
    for (const id of [HAND, HAND_HIGHLIGHT]) {
      const ass = assFor(id, LATIN)
      assert.match(ass, /^Style: Default,Patrick Hand,/m, `${id} names Patrick Hand in its style line`)
      assert.equal(ass.includes('\\fn'), false, `${id} adds no font override for Latin`)
    }
  })
})

describe('Khmer falls back to a bundled Khmer face, never to boxes', () => {
  before(() => { clearFontManifestCache(); clearScriptFallbackCache() })

  test('the manifest answers which bundled face draws Khmer', () => {
    assert.equal(bundledFallbackFamily('khmr'), 'Kantumruy Pro',
      'the manifest’s Khmer TEXT face, not a display face')
  })

  test('a Khmer line in the hand-lettered presets is tagged with that face', () => {
    for (const id of [HAND, HAND_HIGHLIGHT]) {
      assert.equal(scriptFallbackTag(KHMER, 'Patrick Hand'), '{\\fnKantumruy Pro}', id)
      const ass = assFor(id, KHMER)
      const line = ass.split('\n').find(entry => entry.startsWith('Dialogue:'))
      assert.ok(line, `${id} emitted an event`)
      assert.ok(line!.includes(`{\\fnKantumruy Pro}${KHMER}`),
        `${id} draws the Khmer line in Kantumruy Pro: ${line}`)
    }
  })

  test('a face that already carries Khmer is left alone', () => {
    assert.equal(scriptFallbackTag(KHMER, 'Kantumruy Pro'), '')
    assert.equal(scriptFallbackTag(KHMER, 'Battambang'), '')
    assert.equal(scriptFallbackTag(KHMER, 'Moul'), '')
  })

  test('the same rule applies to every bundled Latin-only face, not just the new one', () => {
    // The rule is a property of the BURN ("a bundled face that cannot draw
    // this script hands it to the bundled face that can"), not a rule about
    // hand-lettering. Anton is Latin-only too, so a Khmer line in an Anton
    // preset now draws bundled Kantumruy Pro instead of whatever the system
    // cascade happened to offer on that Mac. Deliberate: the alternative is
    // output that differs between two Macs rendering the same caption.
    assert.deepEqual(presetById('shorts-vertical-bounce').style.typography.font_family, 'Anton')
    assert.equal(scriptFallbackTag(KHMER, 'Anton'), '{\\fnKantumruy Pro}')
    // Inter publishes latn + cyrl, not khmr, so it takes the same fallback.
    assert.equal(scriptFallbackTag(KHMER, 'Inter'), '{\\fnKantumruy Pro}')
    // Noto Sans SC publishes hani + latn — also no khmr.
    assert.equal(scriptFallbackTag(KHMER, 'Noto Sans SC'), '{\\fnKantumruy Pro}')
  })

  test('a system face is left exactly as it was — no delivered episode moves', () => {
    // Helvetica is not in the manifest, so the burn keeps whatever the system
    // did before this existed. Changing it here would silently restyle
    // episodes nobody touched.
    assert.equal(scriptFallbackTag(KHMER, 'Helvetica'), '')
    assert.equal(scriptFallbackTag(KHMER, 'Segment Anything Not Installed'), '')
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
        assert.equal(scriptFallbackTag(KHMER, 'Patrick Hand'), '{\\fnKhmer Test Face}')
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
      assert.equal(scriptFallbackTag(KHMER, 'Patrick Hand'), '')
    } finally {
      if (previous === undefined) delete process.env.STORY_STUDIO_RESOURCES_DIR
      else process.env.STORY_STUDIO_RESOURCES_DIR = previous
      clearFontManifestCache()
      clearScriptFallbackCache()
      rmSync(root, { recursive: true, force: true })
    }
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

  test('a Latin caption in every older preset still burns with no font override', () => {
    // The fallback must be invisible to everything that already worked: it can
    // only ever ADD a tag for a line the chosen bundled face cannot draw.
    for (const preset of BUILT_IN_SUBTITLE_PRESETS) {
      if (preset.id === HAND || preset.id === HAND_HIGHLIGHT) continue
      const ass = assFor(preset.id, LATIN, { width: 1920, height: 1080 })
      assert.equal(ass.includes('\\fn'), false, `${preset.id} gained a font override`)
    }
  })
})

describe('the rendered document is one libass can actually read', () => {
  test('a two-line hand-lettered caption in 9:16 keeps balanced braces and a real event', () => {
    const ass = assFor(HAND, 'some days the quiet is enough to hold on to for a while')
    const events = ass.split('\n').filter(line => line.startsWith('Dialogue:'))
    assert.ok(events.length >= 1, 'the caption is split into events, never dropped')
    for (const line of events) {
      const text = line.slice(line.indexOf(',,') + 2)
      const opens = (text.match(/\{/g) ?? []).length
      const closes = (text.match(/\}/g) ?? []).length
      assert.equal(opens, closes, `unbalanced override braces: ${text}`)
    }
    assert.match(ass, /PlayResX: 1080/)
    assert.match(ass, /PlayResY: 1920/)
  })
})

after(() => {
  clearFontManifestCache()
  clearScriptFallbackCache()
})
