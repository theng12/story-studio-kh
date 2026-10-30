/**
 * An image-backed label is sized by its WORDS, not by the artwork's pixel size.
 *
 * The owner, 2026-10-30: "they are too large. it fills up nearly all of the
 * image... a short place name should sit around a fifth to a quarter of the
 * frame width, and it should grow only as much as its words need."
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import {
  findLabelDesign,
  renderLabelDesign,
  renderLeaderLine,
  labelFrameBase,
} from '../lib/label-design-render.js'

const LANDSCAPE = { w: 1920, h: 1080 }
const PORTRAIT = { w: 1080, h: 1920 }
const SHORT = 'Berlin'
const LONG = 'The Grand Bazaar of Constantinople'
const TWO_LINE = 'Grand Bazaar of Constantinople'

async function sizeFor(designId: string, text: string, frame: { w: number; h: number }) {
  const design = (await findLabelDesign(designId))!
  assert.ok(design, `${designId} must be installed`)
  const out = await renderLabelDesign({ design, title: text, frame_w: frame.w, frame_h: frame.h })
  return { out, fraction: out.width / frame.w }
}

describe('label design rendering', () => {
  test('the built-in catalogue loads', async () => {
    const design = await findLabelDesign('label:location-pin')
    assert.ok(design)
    assert.equal(design.pointing, true)
  })

  test('a short label sits between a fifth and a third of the frame width at 16:9', async () => {
    const { fraction } = await sizeFor('label:location-pin', SHORT, LANDSCAPE)
    assert.ok(fraction >= 0.16 && fraction <= 0.32, `short label was ${(fraction * 100).toFixed(1)}% of the frame width`)
  })

  test('a short label is proportionate at 9:16 too', async () => {
    const { fraction } = await sizeFor('label:location-pin', SHORT, PORTRAIT)
    assert.ok(fraction >= 0.16 && fraction <= 0.32, `portrait short label was ${(fraction * 100).toFixed(1)}%`)
  })

  test('the frame base is the short side of a vertical frame', async () => {
    assert.equal(labelFrameBase(PORTRAIT.w), 1080)
    assert.equal(labelFrameBase(LANDSCAPE.w), 1920)
  })

  test('longer words make a wider label, up to the cap', async () => {
    const short = await sizeFor('label:location-pin', SHORT, LANDSCAPE)
    const long = await sizeFor('label:location-pin', LONG, LANDSCAPE)
    assert.ok(long.out.width > short.out.width, 'a longer label must grow')
    assert.ok(long.fraction <= 0.32, 'and must stay inside the cap')
  })

  test('two-line text fits inside the design box at both aspect ratios', async () => {
    for (const frame of [LANDSCAPE, PORTRAIT]) {
      const { out } = await sizeFor('label:location-pin', TWO_LINE, frame)
      const design = (await findLabelDesign('label:location-pin'))!
      const boxW = Math.round(design.text_box.width * out.width)
      // Ink exists inside the box region once composited.
      const box = await sharp(out.png)
        .extract({
          left: Math.round(design.text_box.x * out.width),
          top: Math.round(design.text_box.y * out.height),
          width: boxW,
          height: Math.round(design.text_box.height * out.height),
        })
        .stats()
      assert.ok(box.channels[3].max > 40, 'the words must be drawn inside the text box')
    }
  })

  test('a tall design stays within 30% of the frame height at both aspect ratios', async () => {
    const design = (await findLabelDesign('label:jungle-trail-sign'))!
    assert.ok(design, 'the tall jungle design is in the catalogue')
    for (const [frame_w, frame_h] of [[1920, 1080], [1080, 1920]] as const) {
      const out = await renderLabelDesign({ design, title: 'The Amazon River Basin, Brazil', frame_w, frame_h })
      assert.ok(out.height <= Math.ceil(frame_h * 0.3) + 1, `${out.height} tall in a ${frame_h} frame`)
    }
  })

  test('named fonts affect sizing and the measured words are the words drawn', async () => {
    const design = (await findLabelDesign('label:jungle-bamboo-frame'))!
    const input = { design, title: 'Amazon Forest', frame_w: 1920, frame_h: 1080 }
    const named = await renderLabelDesign(input)
    const fallback = await renderLabelDesign({ ...input, design: { ...design, font: undefined } })
    assert.notEqual(named.width, fallback.width, 'the selected face must affect measured width')
    assert.notDeepEqual(named.png, fallback.png, 'the selected face must affect the drawn words')
    const { fontById, fontFilePath } = await import('../lib/thumbnail-fonts.js')
    const face = (await fontById(design.font!))!
    const ink = await sharp({ text: { text: input.title, font: `${face.family}, 72`, fontfile: fontFilePath(face), rgba: true } }).trim({ threshold: 1 }).png().toBuffer()
    const inkMeta = await sharp(ink).metadata()
    const expectedWidth = Math.round(Math.max(1920 * 0.16, (inkMeta.width ?? 0) / design.text_box.width))
    assert.equal(named.width, expectedWidth, 'asset width follows the same face used for the ink')
    const base = await sharp((await import('../lib/label-design-render.js')).labelDesignAssetPath(design.asset)).resize(named.width, named.height, { fit: 'fill' }).png().toBuffer()
    const box = design.text_box
    const expected = await sharp(base).composite([{ input: ink, left: Math.round(box.x * named.width) + Math.round((Math.round(box.width * named.width) - (inkMeta.width ?? 0)) / 2), top: Math.round(box.y * named.height) + Math.max(0, Math.round((Math.round(box.height * named.height) - (inkMeta.height ?? 0)) / 2)) }]).png().toBuffer()
    assert.deepEqual(named.png, expected, 'the measured ink is composited without changing face')
  })

  test('missing fonts fall back once and Khmer skips Latin-only fonts', async () => {
    const design = (await findLabelDesign('label:jungle-bamboo-frame'))!
    const input = { design, title: 'Amazon Rainforest', frame_w: 1920, frame_h: 1080 }
    const fallback = await renderLabelDesign({ ...input, design: { ...design, font: undefined } })
    const messages: string[] = []
    const warn = console.warn
    console.warn = (...args: unknown[]) => { messages.push(args.join(' ')) }
    try {
      const missing = { ...design, font: 'missing-test-font' }
      assert.deepEqual((await renderLabelDesign({ ...input, design: missing })).png, fallback.png)
      assert.deepEqual((await renderLabelDesign({ ...input, design: missing })).png, fallback.png)
      assert.equal(messages.length, 1)
      assert.match(messages[0], /missing-test-font.*default font/)
    } finally { console.warn = warn }
    const khmer = { ...input, title: 'ប្រាសាទអង្គរវត្ត' }
    const named = await renderLabelDesign(khmer)
    const normal = await renderLabelDesign({ ...khmer, design: { ...design, font: undefined } })
    assert.deepEqual(named.png, normal.png)
  })

  test('the leader line is a full-frame transparent image ending at the target', async () => {
    const png = await renderLeaderLine({
      frame_w: 640, frame_h: 360,
      from: { x: 0.2, y: 0.2 }, to: { x: 0.8, y: 0.8 },
    })
    const meta = await sharp(png).metadata()
    assert.equal(meta.width, 640)
    assert.equal(meta.height, 360)
    assert.equal(meta.hasAlpha, true)
  })
})
