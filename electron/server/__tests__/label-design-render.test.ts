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
