/**
 * Bundled fonts — the faces, their licences, and the one punctuation fallback.
 *
 * Owner, 2026-10-29: *"a face only needs to be good at the script it serves"* — which is why every
 * bundled Khmer face draws the letters but none of them draws a curly quote, an em dash or an
 * ellipsis. Those six marks must never change the customer's words, and must never be drawn by a
 * face nobody chose, so ONE Latin face draws them for every face that lacks them, and the render
 * report says whose glyph they were (AGENTS §6: a silent substitution and a correct render must not
 * look the same).
 *
 * Pinned here:
 *   - what the manifest claims about scripts, weights and licences is true of the shipped files;
 *   - the fallback face is chosen from the manifest, not from a constant, and it really has all six;
 *   - a Khmer line with quotes renders and reports the fallback instead of being refused;
 *   - anything outside those six is still refused, by name;
 *   - a weight request names a weight the face really has, so bold is never synthesised.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { before, describe, test } from 'node:test'
import path from 'node:path'
import sharp from 'sharp'

import {
  nearestWeight,
  punctuationFallbackFace,
  renderThumbnailText,
  resetFontProbe,
  resetPunctuationFallback,
  ThumbnailTextRefusal,
} from '../lib/thumbnail-text-render.js'
import { clearCmapCache, missingCharacters } from '../lib/font-coverage.js'
import { clearFontManifestCache, fontFilePath, readFontManifest } from '../lib/thumbnail-fonts.js'
import { THUMBNAIL_TEXT_CANVAS } from '../contracts/thumbnail-text.js'
import type { ThumbnailTextStyle } from '../contracts/thumbnail-text.js'

const PUNCTUATION = '‘’“”—…'

let sourcePng: Buffer

function baseStyle(overrides: Partial<ThumbnailTextStyle> = {}): ThumbnailTextStyle {
  return {
    font_id: 'moul',
    weight: 400,
    size: { mode: 'fit', min_px: 24, max_px: 96 },
    max_lines: 4,
    align: 'left',
    line_height: 1.12,
    letter_spacing: 0,
    uppercase: false,
    fill: { type: 'solid', color: '#FFD60A' },
    opacity: 1,
    outline: { enabled: false, color: '#000000', width_px: 0 },
    shadow: { enabled: false, color: '#000000', opacity: 0.5, dx: 0, dy: 4, blur_px: 6 },
    background: { enabled: false, color: '#000000', opacity: 0.5, padding_px: 20, radius_px: 12 },
    placement: { anchor: 'bottom-left', x_pct: 5, y_pct: 45, width_pct: 90, height_pct: 45 },
    ...overrides,
  }
}

before(async () => {
  clearCmapCache()
  clearFontManifestCache()
  resetFontProbe()
  resetPunctuationFallback()
  sourcePng = await sharp({
    create: {
      width: THUMBNAIL_TEXT_CANVAS.width,
      height: THUMBNAIL_TEXT_CANVAS.height,
      channels: 3,
      background: { r: 0x40, g: 0x40, b: 0x40 },
    },
  }).png().toBuffer()
})

describe('bundled fonts — the manifest tells the truth about every shipped face', () => {
  test('every face ships its file and the licence it declares, OFL or Apache', async () => {
    const manifest = await readFontManifest()
    const licences = new Set<string>()
    for (const entry of manifest.fonts) {
      const dir = path.dirname(fontFilePath(entry))
      assert.ok(existsSync(path.join(dir, entry.license_file)), `${entry.id}: ${entry.license_file} ships beside it`)
      const text = readFileSync(path.join(dir, entry.license_file), 'utf-8')
      if (entry.license === 'Apache-2.0') {
        assert.match(text, /Apache License/, `${entry.id} declares Apache-2.0`)
        assert.match(text, /TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION/, `${entry.id}: the full Apache terms ship`)
        assert.equal(entry.license_file, 'LICENSE.txt', `${entry.id}: Apache faces carry LICENSE.txt`)
      } else {
        assert.equal(entry.license, 'OFL-1.1', `${entry.id}: an unexpected licence "${entry.license}"`)
        assert.match(text, /SIL Open Font License/i, `${entry.id} declares OFL-1.1`)
        assert.equal(entry.license_file, 'OFL.txt', `${entry.id}: OFL faces carry OFL.txt`)
      }
      licences.add(entry.license)
    }
    // Both licence kinds are really present, so a future reader cannot assume "all OFL".
    assert.deepEqual([...licences].sort(), ['Apache-2.0', 'OFL-1.1'])
  })

  test('every Khmer face draws the letters; the ones with no marks of their own are named', async () => {
    const manifest = await readFontManifest()
    let needsFallback = 0
    for (const entry of manifest.fonts) {
      if (!entry.scripts.includes('khmr')) continue
      const file = fontFilePath(entry)
      assert.deepEqual(await missingCharacters(file, 'សួស្តី'), [], `${entry.id} declares khmr and must draw Khmer`)
      assert.deepEqual(await missingCharacters(file, 'Hello Aa'), [], `${entry.id} also draws Latin`)
      // A Khmer face either carries the six marks or carries none of them — never a partial set,
      // which would draw one quote in its own face and the next in the fallback's.
      const missing = await missingCharacters(file, PUNCTUATION)
      assert.ok(missing.length === 0 || missing.length === 6, `${entry.id}: partial punctuation ${JSON.stringify(missing)}`)
      if (missing.length) needsFallback += 1
    }
    // The fallback rule is not decorative: most Khmer faces need it.
    assert.ok(needsFallback >= 2, `only ${needsFallback} Khmer face(s) need the punctuation fallback`)
  })

  test('the weights in the manifest are the weights the picker offers', async () => {
    const manifest = await readFontManifest()
    const byId = new Map(manifest.fonts.map(entry => [entry.id, entry]))
    // Variable faces list their real named instances; a single-instance face lists exactly one.
    assert.deepEqual(byId.get('reenie-beanie')!.weights, [500])
    assert.deepEqual(byId.get('caveat')!.weights, [400, 700])
    assert.deepEqual(byId.get('hanuman')!.weights, [100, 400, 900])
    for (const entry of manifest.fonts) {
      assert.ok(entry.weights.length > 0, `${entry.id} lists no weights`)
      for (const weight of entry.weights) {
        assert.ok(Number.isInteger(weight) && weight >= 100 && weight <= 900, `${entry.id}: ${weight} is not a font weight`)
      }
      assert.equal(new Set(entry.weights).size, entry.weights.length, `${entry.id} repeats a weight`)
    }
  })
})

describe('the weight requested is a weight the face really has', () => {
  test('the nearest REAL instance is named, so bold is never synthesised', () => {
    // A face with one weight always asks for that one, whatever the style wants.
    assert.equal(nearestWeight(700, [400]), 'Regular')
    assert.equal(nearestWeight(400, [700]), 'Bold')
    assert.equal(nearestWeight(300, [500]), 'Medium')
    // Variable faces answer with their own named instances.
    assert.equal(nearestWeight(600, [400, 700]), 'Bold')
    assert.equal(nearestWeight(400, [300, 400, 700]), 'Regular')
    assert.equal(nearestWeight(200, [100, 400, 900]), 'Thin')
    // With no face list the old keyword mapping still applies (callers that only ask "what is 600?").
    assert.equal(nearestWeight(600), 'Semi-Bold')
  })
})

describe('the six punctuation marks get one consistent face', () => {
  test('the fallback face comes from the manifest and really draws all six', async () => {
    const family = await punctuationFallbackFace()
    assert.ok(family, 'some bundled face must carry the marks, or a Khmer headline with quotes would be refused')
    const manifest = await readFontManifest()
    const chosen = manifest.fonts.find(entry => entry.family === family)!
    assert.ok(chosen, `${family} is a bundled face`)
    // It is a LATIN face: a face that also draws Khmer is exactly the kind that lacks the marks.
    assert.ok(chosen.scripts.includes('latn'))
    assert.ok(!chosen.scripts.includes('khmr'), 'the fallback must not itself be a Khmer face')
    assert.deepEqual(await missingCharacters(fontFilePath(chosen), PUNCTUATION), [], `${family} must draw all six`)
  })

  test('a Khmer line with quotes, an em dash and an ellipsis renders and names the fallback', async () => {
    const text = 'ខ្ញុំ “ស្រលាញ់” អ្នក — ហើយគិតដល់អ្នក…'
    const { report } = await renderThumbnailText({ sourceBytes: sourcePng, text, style: baseStyle({ font_id: 'moul' }) })
    assert.equal(report.glyphs_complete, true)
    assert.deepEqual(report.missing_characters, [])
    // The substitution is STATED — the customer can see whose glyph the marks were.
    assert.equal(report.fallback_family, await punctuationFallbackFace())
  })

  test('a face that already draws the marks keeps its own — no fallback is used or reported', async () => {
    const text = 'ខ្ញុំ “ស្រលាញ់” — …'
    const { report } = await renderThumbnailText({ sourceBytes: sourcePng, text, style: baseStyle({ font_id: 'kantumruy-pro' }) })
    assert.equal(report.glyphs_complete, true)
    assert.equal(report.fallback_family, undefined, 'Kantumruy Pro draws every one of these itself')
  })

  test('anything outside the six is still refused, by name', async () => {
    // A CJK character no bundled face carries: the fallback must not be a licence to draw anything.
    await assert.rejects(
      renderThumbnailText({ sourceBytes: sourcePng, text: '龘', style: baseStyle({ font_id: 'moul' }) }),
      (error: any) => {
        assert.ok(error instanceof ThumbnailTextRefusal)
        const report = error.report!
        assert.match(report.missing_characters.join(''), /龘/)
        assert.equal(report.fallback_family, undefined)
        return true
      },
    )
  })
})
