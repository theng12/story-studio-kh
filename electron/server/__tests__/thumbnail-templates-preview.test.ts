/**
 * Every Shell Library card serves its OWN layout and typography.
 *
 * Recipe-only templates — signed packs and the shipped recipe JSONs — carry
 * `recipe`, never `textZones`, so `buildOverlaySvg` emitted a bare `<svg>`
 * with nothing drawable: the preview route composited an empty document over
 * the placeholder and served the SAME grey bytes (176,556, md5 526f661c…)
 * for 6 of 7 forks and 5 built-ins. The picker never even asked for those
 * templates' endpoint; when it does now, this is what it must get.
 *
 * Proves, at the route boundary the picker actually calls:
 *   1. two DIFFERENT recipe templates serve DIFFERENT bytes,
 *   2. both differ from the bare placeholder compose (the exact old output),
 *   3. the overlay text is really painted — brighter-than-bare pixels sit in
 *      the band each template's `defaultTextPosition` asks for (top vs
 *      bottom), so a template with no Shell artwork still shows where its
 *      words go over the placeholder.
 *
 * Cannot catch: how the browser draws glyphs in the editor's live preview.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { after, test } from 'node:test'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import request from 'supertest'
import sharp from 'sharp'
import { useTempDataDir } from './_helpers.js'
import { composeThumbnail } from '../lib/thumbnail-composer.js'
import { THUMBNAIL_PLACEHOLDER_SVG } from '../contracts/thumbnail-overlay.js'

// Import the router under a throwaway data dir so any module-level cache is
// keyed against it — the pattern images-thumbnail-route-resolution uses.
const boot = await useTempDataDir()
const { router } = await import('../routes/thumbnail-templates.js')
after(async () => { await boot.cleanup() })

const app = express()
app.use(express.json())
app.use('/api', router)

const CANVAS = { width: 1920, height: 1080 }

async function previewPng(id: string): Promise<Buffer> {
  const response = await request(app)
    .get(`/api/thumbnail-templates/${id}/preview.png`)
    .buffer(true)
    .expect(200)
  assert.equal(response.headers['content-type'], 'image/png')
  assert.ok(Buffer.isBuffer(response.body), 'preview.png must come back as bytes')
  return response.body
}

/** The exact bytes the route served before the fix: placeholder portrait,
 *  composed through the same pipeline with nothing to draw. */
async function barePlaceholderCompose(): Promise<Buffer> {
  const placeholder = await sharp(Buffer.from(THUMBNAIL_PLACEHOLDER_SVG, 'utf8'))
    .resize(CANVAS.width, CANVAS.height).png().toBuffer()
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sskh-bare-'))
  const file = path.join(dir, 'placeholder.png')
  writeFileSync(file, placeholder)
  return composeThumbnail({
    sourcePath: file,
    template: { id: 'bare', name: 'bare', description: '', builtin: false, schemaVersion: 1, canvas: CANVAS } as any,
  })
}

/** Pixels where `png` is BRIGHTER than `bare` — the dim gradient only ever
 *  darkens, so brighter pixels are the painted text itself. Returns them
 *  with their vertical centre of mass (canvas fraction, 0 = top). */
async function brighterInk(png: Buffer, bare: Buffer): Promise<{ count: number; centroidY: number }> {
  const a = await sharp(png).raw().toBuffer({ resolveWithObject: true })
  const b = await sharp(bare).raw().toBuffer({ resolveWithObject: true })
  assert.equal(a.info.width, b.info.width)
  assert.equal(a.info.height, b.info.height)
  let count = 0
  let sumY = 0
  const { width, height, channels } = a.info
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels
      const lumaA = (a.data[i]! + a.data[i + 1]! + a.data[i + 2]!) / 3
      const lumaB = (b.data[i]! + b.data[i + 1]! + b.data[i + 2]!) / 3
      if (lumaA - lumaB > 35) { count++; sumY += y }
    }
  }
  return { count, centroidY: count ? sumY / count / height : 1 }
}

test('two recipe-only built-ins serve different previews, each with its text over the bare placeholder', async () => {
  const bare = await barePlaceholderCompose()
  // curiosity-question-cartoon: recipe.defaultTextPosition = 'top'
  // archival-map-investigation: recipe.defaultTextPosition = 'bottom'
  const top = await previewPng('curiosity-question-cartoon')
  const bottom = await previewPng('archival-map-investigation')

  // 1. Different templates → different bytes (the old bug: both == bare).
  assert.ok(!top.equals(bottom), 'two different templates served identical bytes')
  // 2. Neither is the bare placeholder compose any more.
  assert.ok(!top.equals(bare), 'top-position template still serves the bare placeholder')
  assert.ok(!bottom.equals(bare), 'bottom-position template still serves the bare placeholder')

  // 3. The text is really there, and where each recipe puts it.
  const inkTop = await brighterInk(top, bare)
  const inkBottom = await brighterInk(bottom, bare)
  assert.ok(inkTop.count > 400, `top template painted ${inkTop.count} text pixels, expected > 400`)
  assert.ok(inkBottom.count > 400, `bottom template painted ${inkBottom.count} text pixels, expected > 400`)
  assert.ok(inkTop.centroidY < 0.45, `top template's ink sits at ${inkTop.centroidY.toFixed(2)} of the canvas, expected the top band`)
  assert.ok(inkBottom.centroidY > 0.55, `bottom template's ink sits at ${inkBottom.centroidY.toFixed(2)} of the canvas, expected the bottom band`)
})

test('a template with explicit textZones is untouched by the recipe derivation', async () => {
  const bare = await barePlaceholderCompose()
  const withZones = await previewPng('centered-hero-headline')
  assert.ok(!withZones.equals(bare), 'zone-bearing template must still paint its overlay')
})
