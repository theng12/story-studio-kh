/**
 * Title-card fitting — the exact Origin Field EP0031 title that was clipped, and the edge cases a
 * generic "it rendered" test would miss.
 *
 * These render real pixels through the bundled-font renderer and assert the ink bounds it measured,
 * not a character-count estimate.
 */

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { describe, test } from 'node:test'
import sharp from 'sharp'

import { renderTitleCardTextLayer } from '../lib/title-card-text.js'

const FRAME = { width: 1920, height: 1080 }
const EXACT_TITLE = 'When Mountain Ranges Rose Through the Atmosphere | Documentary for Sleep'

function assertContained(proof: Awaited<ReturnType<typeof renderTitleCardTextLayer>>['proof']): void {
  assert.ok(proof.nonblank_pixels > 0, 'the card drew visible ink')
  assert.ok(proof.bounds, 'the card has raster bounds')
  const m = proof.safe_margin_px
  assert.ok(proof.bounds.left >= m, `left ${proof.bounds.left} >= ${m}`)
  assert.ok(proof.bounds.top >= m, `top ${proof.bounds.top} >= ${m}`)
  assert.ok(proof.bounds.right <= FRAME.width - m, `right ${proof.bounds.right} <= ${FRAME.width - m}`)
  assert.ok(proof.bounds.bottom <= FRAME.height - m, `bottom ${proof.bounds.bottom} <= ${FRAME.height - m}`)
  assert.equal(proof.text_sha256, crypto.createHash('sha256').update(proof.text).digest('hex'))
  assert.match(proof.rendered_sha256, /^[0-9a-f]{64}$/)
}

describe('the exact title that was clipped', () => {
  test('1920x1080: the whole 70-character title is drawn inside the safe margins', async () => {
    const { proof } = await renderTitleCardTextLayer({
      text: EXACT_TITLE,
      style: 'white',
      kind: 'title',
      width: FRAME.width,
      height: FRAME.height,
      basePx: Math.round(1080 * 0.075),
    })
    assert.equal(proof.text, EXACT_TITLE)
    assert.equal(proof.frame.width, FRAME.width)
    assert.equal(proof.frame.height, FRAME.height)
    assertContained(proof)
    // It genuinely wrapped and/or shrank rather than staying on the clipped single line.
    assert.ok(proof.lines > 1 || proof.font_px < Math.round(1080 * 0.075), `lines=${proof.lines} px=${proof.font_px}`)
  })

  test('a short title keeps the card\'s existing size instead of growing', async () => {
    const { proof } = await renderTitleCardTextLayer({
      text: 'Origin Field',
      style: 'white',
      kind: 'title',
      width: FRAME.width,
      height: FRAME.height,
      basePx: 81,
    })
    assert.equal(proof.font_px, 81)
    assert.equal(proof.lines, 1)
    assertContained(proof)
  })

  test('one very long unbroken word is broken and stays inside the frame', async () => {
    const { proof } = await renderTitleCardTextLayer({
      text: 'A'.repeat(400),
      style: 'gold',
      kind: 'title',
      width: FRAME.width,
      height: FRAME.height,
      basePx: 81,
    })
    assert.ok(proof.lines > 1, `lines=${proof.lines}`)
    assertContained(proof)
  })

  test('Khmer text is drawn by a Khmer-capable bundled face and stays inside the frame', async () => {
    const { proof } = await renderTitleCardTextLayer({
      text: 'ភ្នំដែលរស់ឡើងក្នុងបរិយាកាស',
      style: 'white',
      kind: 'title',
      width: FRAME.width,
      height: FRAME.height,
      basePx: 81,
    })
    assert.equal(proof.font_id, 'kantumruy-pro')
    assertContained(proof)
  })

  test('a subtitle is part of the fitted block and stays inside the frame', async () => {
    const { proof } = await renderTitleCardTextLayer({
      text: 'Origin Field',
      subtitle: 'A documentary for sleep',
      style: 'minimal',
      kind: 'title',
      width: FRAME.width,
      height: FRAME.height,
      basePx: 81,
    })
    assertContained(proof)
  })

  test('empty text is a loud refusal, never a silently blank card', async () => {
    await assert.rejects(
      renderTitleCardTextLayer({
        text: '   ',
        style: 'white',
        kind: 'title',
        width: FRAME.width,
        height: FRAME.height,
        basePx: 81,
      }),
      /no text|Nothing was rendered/i,
    )
  })
})

/**
 * sharp reads text as Pango markup. A title is customer text, so `<b>` and `&` must be drawn as the
 * characters the customer typed — never parsed into formatting or dropped.
 */
describe('literal markup characters in a title', () => {
  const render = (text: string) => renderTitleCardTextLayer({
    text,
    style: 'white',
    kind: 'title',
    width: FRAME.width,
    height: FRAME.height,
    basePx: 40,
  })

  test('"<b>X</b>" is drawn as its literal eight characters, not as bold X', async () => {
    const plain = await render('X')
    const tagged = await render('<b>X</b>')
    assert.equal(tagged.proof.text, '<b>X</b>')
    const width = (p: typeof plain.proof) => p.bounds.right - p.bounds.left
    assert.ok(
      width(tagged.proof) > width(plain.proof) * 3,
      `literal tags must add ink: plain=${width(plain.proof)} tagged=${width(tagged.proof)}`,
    )
  })

  test('a literal ampersand is preserved and drawn', async () => {
    const { proof } = await render('Mountain & Atmosphere')
    assert.equal(proof.text, 'Mountain & Atmosphere')
    assert.ok(proof.nonblank_pixels > 0)
  })
})

/** Contiguous bands of rows that contain visible ink (the black outline does not count). */
async function inkRowBands(png: Buffer): Promise<number> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  let bands = 0
  let inBand = false
  for (let y = 0; y < info.height; y++) {
    let ink = false
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * 4
      if (data[i + 3]! > 8 && (data[i]! > 48 || data[i + 1]! > 48 || data[i + 2]! > 48)) { ink = true; break }
    }
    if (ink && !inBand) bands += 1
    inBand = ink
  }
  return bands
}

describe('line spacing uses the drawn glyphs', () => {
  test('the exact title\'s lines never overlap', async () => {
    const { png, proof } = await renderTitleCardTextLayer({
      text: EXACT_TITLE,
      style: 'white',
      kind: 'title',
      width: FRAME.width,
      height: FRAME.height,
      basePx: Math.round(1080 * 0.075),
    })
    // Every line is its own ink band; overlapping descenders would merge two bands into one.
    assert.equal(await inkRowBands(png), proof.lines)
  })
})
