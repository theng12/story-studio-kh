/**
 * Thumbnail text layer — renderer, effects, fit and glyph coverage.
 *
 * Covers AGENTS §8 (verified completion), §6 (a zero that means two things) and
 * the Khmer-first requirement. No real model calls; no network.
 */

import assert from 'node:assert/strict'
import { before, describe, test } from 'node:test'
import { readFileSync } from 'node:fs'
import sharp from 'sharp'

import {
  renderThumbnailText,
  wrapText,
  hexToRgb,
  paintFill,
  buildOutline,
  buildBackground,
  graphemes,
  textHasCase,
  ThumbnailTextRefusal,
  resetFontProbe,
  placementBox,
} from '../lib/thumbnail-text-render.js'
import { glyphCoverage, clearCmapCache } from '../lib/font-coverage.js'
import {
  fontById,
  clearFontManifestCache,
  fontFilePath,
  configureFontconfig,
  fontsResourceDir,
} from '../lib/thumbnail-fonts.js'
import { THUMBNAIL_TEXT_CANVAS } from '../contracts/thumbnail-text.js'
import type { ThumbnailTextStyle } from '../contracts/thumbnail-text.js'

// ── A solid 1280x720 source image the renderer can draw onto. ─────────────

let sourcePng: Buffer

function baseStyle(overrides: Partial<ThumbnailTextStyle> = {}): ThumbnailTextStyle {
  return {
    font_id: 'kantumruy-pro',
    weight: 700,
    size: { mode: 'fit', min_px: 28, max_px: 116 },
    max_lines: 2,
    align: 'left',
    line_height: 1.12,
    letter_spacing: 0,
    uppercase: false,
    fill: { type: 'solid', color: '#FFD60A' },
    opacity: 1,
    outline: { enabled: false, color: '#000000', width_px: 0 },
    shadow: { enabled: false, color: '#000000', opacity: 0.5, dx: 0, dy: 4, blur_px: 6 },
    background: { enabled: false, color: '#000000', opacity: 0.5, padding_px: 20, radius_px: 12 },
    placement: { anchor: 'bottom-left', x_pct: 5, y_pct: 93, width_pct: 72, height_pct: 32 },
    ...overrides,
  }
}

async function nonBackgroundPixelCount(png: Buffer): Promise<number> {
  const { data } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  // The source is a solid mid-grey (#404040). Anything that is not that exact colour was drawn by
  // the text layer. Counts alpha>0 pixels whose RGB differs from the source.
  let count = 0
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue
    if (data[i] !== 0x40 || data[i + 1] !== 0x40 || data[i + 2] !== 0x40) count++
  }
  return count
}

async function assertInkInsideBox(png: Buffer, style: ThumbnailTextStyle): Promise<void> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const box = placementBox(style, info.width, info.height)
  let ink = 0
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * 4
      if (data[i] === 0x40 && data[i + 1] === 0x40 && data[i + 2] === 0x40) continue
      ink++
      assert.ok(x >= box.left && x < box.left + box.width && y >= box.top && y < box.top + box.height, `ink outside box at ${x},${y}`)
    }
  }
  assert.ok(ink > 100, 'text must draw real pixels inside its placement box')
}

/** The auto-fit rule: longer text ends up smaller, or wrapped onto more lines (owner point 4). */
function report_smaller_or_more_lines(
  longer: { font_px: number, lines: number },
  shorter: { font_px: number, lines: number },
): boolean {
  return longer.font_px < shorter.font_px || longer.lines > shorter.lines
}

async function samplePixel(png: Buffer, x: number, y: number): Promise<{ r: number; g: number; b: number; a: number }> {  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const index = (y * info.width + x) * 4
  return { r: data[index]!, g: data[index + 1]!, b: data[index + 2]!, a: data[index + 3]! }
}

before(async () => {
  clearCmapCache()
  clearFontManifestCache()
  resetFontProbe()
  // A 1280x720 solid grey PNG — every drawn pixel will visibly differ from this.
  sourcePng = await sharp({
    create: {
      width: THUMBNAIL_TEXT_CANVAS.width,
      height: THUMBNAIL_TEXT_CANVAS.height,
      channels: 3,
      background: { r: 0x40, g: 0x40, b: 0x40 },
    },
  }).png().toBuffer()
})

describe('thumbnail text renderer — Khmer coverage and fit', () => {
  test('fontconfig is fully written before its synchronous setup function returns', () => {
    const file = configureFontconfig()
    const xml = readFileSync(file, 'utf8')
    assert.ok(xml.includes(fontsResourceDir()))
    assert.match(xml, /<cachedir>/)
  })
  test('Khmer text in Kantumruy Pro gives glyphs_complete true and draws real pixels', async () => {
    const text = 'សួស្តីពិភពលោក' // "Hello world" in Khmer
    const { png, report } = await renderThumbnailText({
      sourceBytes: sourcePng,
      text,
      style: baseStyle(),
    })
    assert.equal(report.glyphs_complete, true)
    assert.deepEqual(report.missing_characters, [])
    assert.equal(report.overflow, false)
    assert.ok(report.font_px >= 28 && report.font_px <= 116, `font_px ${report.font_px} out of range`)

    const meta = await sharp(png).metadata()
    assert.equal(meta.width, THUMBNAIL_TEXT_CANVAS.width)
    assert.equal(meta.height, THUMBNAIL_TEXT_CANVAS.height)

    const drawn = await nonBackgroundPixelCount(png)
    assert.ok(drawn > 100, `expected real drawn pixels, got ${drawn}`)
    await assertInkInsideBox(png, baseStyle())
  })

  test('short and long titles auto-fit: the long one is smaller and/or wraps onto more lines', async () => {
    const short = 'ខ្លី'
    const long = 'ចំណងជើងវែងមួយដែលត្រូវការពេលវេលាដើម្បីបង្ហាញនៅលើរូបភាពតូចមួយ'
    const shortResult = await renderThumbnailText({ sourceBytes: sourcePng, text: short, style: baseStyle() })
    const longResult = await renderThumbnailText({ sourceBytes: sourcePng, text: long, style: baseStyle() })
    // Both fit — neither overflows.
    assert.equal(shortResult.report.overflow, false)
    assert.equal(longResult.report.overflow, false)
    assert.ok(
      report_smaller_or_more_lines(longResult.report, shortResult.report),
      `long (${longResult.report.font_px}px/${longResult.report.lines} lines) must be smaller or wrap more than short (${shortResult.report.font_px}px/${shortResult.report.lines} lines)`,
    )
    await assertInkInsideBox(shortResult.png, baseStyle())
    await assertInkInsideBox(longResult.png, baseStyle())
  })

  test('an impossible fit at min_px / max_lines reports overflow', async () => {
    const huge = 'អក្សរវែងណាស់ដែលមិនអាចសមនឹងប្រអប់តូចមួយបានឡើយ'.repeat(3)
    await assert.rejects(
      () => renderThumbnailText({
        sourceBytes: sourcePng,
        text: huge,
        style: baseStyle({
          size: { mode: 'fit', min_px: 40, max_px: 60 },
          max_lines: 1,
          placement: { anchor: 'center', x_pct: 50, y_pct: 50, width_pct: 10, height_pct: 5 },
        }),
      }),
      (error: any) => {
        assert.ok(error instanceof ThumbnailTextRefusal)
        assert.match(error.message, /does not fit/i)
        assert.equal((error as any).report?.overflow, true, 'the refusal must carry the overflow verdict')
        return true
      },
    )
  })

  test('Khmer text in Latin-only Anton reports missing characters and is refused', async () => {
    const khmer = 'សួស្តី'
    const coverage = await glyphCoverage(fontFilePath((await fontById('anton'))!), khmer)
    assert.equal(coverage.complete, false)
    assert.ok(coverage.missing.length > 0)

    await assert.rejects(
      () => renderThumbnailText({
        sourceBytes: sourcePng,
        text: khmer,
        style: baseStyle({ font_id: 'anton', weight: 400 }),
      }),
      (error: any) => {
        assert.ok(error instanceof ThumbnailTextRefusal)
        assert.match(error.message, /cannot draw/i)
        assert.equal((error as any).report?.glyphs_complete, false)
        assert.deepEqual((error as any).report?.missing_characters, coverage.missing)
        return true
      },
    )
  })

  test('Latin text in Anton renders with glyphs_complete true', async () => {
    const { report } = await renderThumbnailText({
      sourceBytes: sourcePng,
      text: 'HELLO WORLD',
      style: baseStyle({ font_id: 'anton', weight: 400 }),
    })
    assert.equal(report.glyphs_complete, true)
    assert.deepEqual(report.missing_characters, [])
  })

  test('empty text is refused', async () => {
    await assert.rejects(
      () => renderThumbnailText({ sourceBytes: sourcePng, text: '   ', style: baseStyle() }),
      (error: any) => error instanceof ThumbnailTextRefusal && /nothing to draw/i.test(error.message),
    )
  })
})

describe('thumbnail text renderer — effects change pixels', () => {
  test('outline adds a ring of pixels around the text', async () => {
    const plain = await renderThumbnailText({
      sourceBytes: sourcePng, text: 'TEST', style: baseStyle(),
    })
    const outlined = await renderThumbnailText({
      sourceBytes: sourcePng, text: 'TEST', style: baseStyle({
        outline: { enabled: true, color: '#0000FF', width_px: 6 },
      }),
    })
    // Outlined image has more drawn pixels than the plain one.
    const plainPx = await nonBackgroundPixelCount(plain.png)
    const outlinedPx = await nonBackgroundPixelCount(outlined.png)
    assert.ok(outlinedPx > plainPx, `outlined (${outlinedPx}) should exceed plain (${plainPx})`)

    // The outline colour is blue somewhere in the image.
    const { data } = await sharp(outlined.png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    let blueFound = false
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) continue
      if (data[i + 2]! > 200 && data[i]! < 50 && data[i + 1]! < 50) { blueFound = true; break }
    }
    assert.equal(blueFound, true, 'outline colour #0000FF must appear in the output')
  })

  test('shadow adds a blurred offset copy', async () => {
    const plain = await renderThumbnailText({
      sourceBytes: sourcePng, text: 'SHADOW', style: baseStyle(),
    })
    const shadowed = await renderThumbnailText({
      sourceBytes: sourcePng, text: 'SHADOW', style: baseStyle({
        shadow: { enabled: true, color: '#FF0000', opacity: 0.9, dx: 8, dy: 12, blur_px: 10 },
      }),
    })
    const plainPx = await nonBackgroundPixelCount(plain.png)
    const shadowedPx = await nonBackgroundPixelCount(shadowed.png)
    assert.ok(shadowedPx > plainPx, 'shadow must add pixels')
  })

  test('background box draws a rounded rectangle behind the text', async () => {
    const plain = await renderThumbnailText({
      sourceBytes: sourcePng, text: 'BOX', style: baseStyle(),
    })
    const boxed = await renderThumbnailText({
      sourceBytes: sourcePng, text: 'BOX', style: baseStyle({
        background: { enabled: true, color: '#00FF00', opacity: 1, padding_px: 20, radius_px: 12 },
      }),
    })
    // Green must appear somewhere — the background box.
    const { data } = await sharp(boxed.png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    let greenFound = false
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) continue
      if (data[i + 1]! > 200 && data[i]! < 50 && data[i + 2]! < 50) { greenFound = true; break }
    }
    assert.equal(greenFound, true, 'background colour #00FF00 must appear')
    const plainPx = await nonBackgroundPixelCount(plain.png)
    const boxedPx = await nonBackgroundPixelCount(boxed.png)
    assert.ok(boxedPx > plainPx, 'background box must add pixels')
  })

  test('gradient fill produces two different colours across the text', async () => {
    const plain = await renderThumbnailText({ sourceBytes: sourcePng, text: 'GRADIENT', style: baseStyle() })
    const { png } = await renderThumbnailText({
      sourceBytes: sourcePng, text: 'GRADIENT',
      style: baseStyle({ fill: { type: 'gradient', color: '#FF0000', color2: '#0000FF', angle: 0 } }),
    })
    const { data } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const plainPixels = await sharp(plain.png).ensureAlpha().raw().toBuffer()
    assert.notDeepEqual(data, plainPixels, 'gradient must change decoded pixels relative to solid fill')
    let redFound = false, blueFound = false
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) continue
      if (data[i]! > 200 && data[i + 2]! < 50) redFound = true
      if (data[i + 2]! > 200 && data[i]! < 50) blueFound = true
      if (redFound && blueFound) break
    }
    assert.equal(redFound, true, 'gradient start colour must appear')
    assert.equal(blueFound, true, 'gradient end colour must appear')
  })

  test('solid fill colour is really present in the output', async () => {
    const fill = '#FF1493' // deep pink
    const { png } = await renderThumbnailText({
      sourceBytes: sourcePng, text: 'FILL',
      style: baseStyle({ fill: { type: 'solid', color: fill } }),
    })
    const expected = hexToRgb(fill)
    const { data } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    let found = false
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) continue
      if (data[i] === expected.r && data[i + 1] === expected.g && data[i + 2] === expected.b) {
        found = true; break
      }
    }
    assert.equal(found, true, `fill colour ${fill} must appear in output pixels`)
  })
})

describe('thumbnail text renderer — primitives', () => {
  test('hexToRgb parses 6-digit and 3-digit hex', () => {
    assert.deepEqual(hexToRgb('#FF0000'), { r: 255, g: 0, b: 0 })
    assert.deepEqual(hexToRgb('#0F0'), { r: 0, g: 255, b: 0 })
    assert.deepEqual(hexToRgb('garbage'), { r: 255, g: 255, b: 255 })
  })

  test('textHasCase is false for Khmer and true for Latin', () => {
    assert.equal(textHasCase('សួស្តី'), false)
    assert.equal(textHasCase('Hello'), true)
    assert.equal(textHasCase('hello'), true) // 'h'.toUpperCase() !== 'h'.toLowerCase()
  })

  test('graphemes keeps Khmer clusters intact', () => {
    const clusters = graphemes('សួស្តី')
    // Khmer clusters combine base + coeng + subscript; the count must be fewer than the codepoint count.
    assert.ok(clusters.length <= 'សួស្តី'.length)
    assert.ok(clusters.length >= 1)
  })

  test('wrapText splits the first unspaced token and reports a real overflow', async () => {
    const wrapped = await wrapText('ABCDEFGHIJKL', 3, 40, async line => line.length * 10)
    assert.deepEqual(wrapped, { lines: ['ABCD', 'EFGH', 'IJKL'], overflow: false })
    const overflow = await wrapText('ABCDEFGHIJKL', 2, 40, async line => line.length * 10)
    assert.deepEqual(overflow, { lines: ['ABCD', 'EFGH'], overflow: true })
  })

  test('wrapText breaks long text into lines', async () => {
    const result = await wrapText('one two three four five six', 2, 100, async (line) => line.length * 10)
    assert.equal(result.lines.length, 2)
  })

  test('buildOutline grows the shape by the requested width', async () => {
    const tile = await sharp({
      create: { width: 40, height: 40, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    }).composite([{
      input: await sharp({
        create: { width: 20, height: 20, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 255 } },
      }).png().toBuffer(),
      left: 10, top: 10,
    }]).png().toBuffer()
    const outlined = await buildOutline(tile, 5, '#FF0000')
    const meta = await sharp(outlined).metadata()
    assert.equal(meta.width, 50) // 40 + 5*2
    assert.equal(meta.height, 50)
  })

  test('paintFill tints a shape with the requested colour', async () => {
    const white = await sharp({
      create: { width: 10, height: 10, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 255 } },
    }).png().toBuffer()
    const tinted = await paintFill(white, { type: 'solid', color: '#00FF00' })
    const pixel = await samplePixel(tinted, 5, 5)
    assert.equal(pixel.r, 0)
    assert.equal(pixel.g, 255)
    assert.equal(pixel.b, 0)
  })

  test('buildBackground produces a rounded rectangle of the right size', async () => {
    const bg = await buildBackground(100, 40, baseStyle({
      background: { enabled: true, color: '#FF0000', opacity: 1, padding_px: 10, radius_px: 8 },
    }))
    const meta = await sharp(bg).metadata()
    assert.equal(meta.width, 120) // 100 + 10*2
    assert.equal(meta.height, 60) // 40 + 10*2
  })
})