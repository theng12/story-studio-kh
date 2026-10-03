/**
 * The template editor's live preview and the server's thumbnail render share
 * one layout (contracts/thumbnail-overlay.ts).
 *
 * Proves: (1) composeThumbnail paints exactly the overlay document the editor
 * draws — pixel-identical when both are rasterised by sharp; (2) the layout
 * boxes the editor draws (layoutTextZone) are where the server actually puts
 * ink, within a few px, for bundled and synthetic templates.
 * Cannot catch: how the browser draws the glyphs (its font engine is not
 * librsvg) — that is the "may differ slightly" the editor states.
 */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { composeThumbnail } from '../lib/thumbnail-composer.js'
import {
  buildOverlaySvg,
  layoutTextZone,
  previewOverlayText,
  type OverlayTemplate,
  type OverlayTextZone,
} from '../contracts/thumbnail-overlay.js'

const templatesDir = fileURLToPath(new URL('../thumbnail-templates/', import.meta.url))
const bundled = (id: string) => JSON.parse(readFileSync(path.join(templatesDir, `${id}.json`), 'utf8')) as OverlayTemplate
const tmp = mkdtempSync(path.join(os.tmpdir(), 'tpl-overlay-'))
const CANVAS = { width: 1920, height: 1080 }

async function blackBackground(): Promise<string> {
  const file = path.join(tmp, 'black.png')
  writeFileSync(file, await sharp({ create: { ...CANVAS, channels: 3, background: '#000000' } }).png().toBuffer())
  return file
}

const SYNTHETIC: OverlayTemplate = {
  canvas: CANVAS,
  textZones: [
    { name: 'title', defaultText: '{episode_title}', x: 'left', y: 'top', xOffset: 90, yOffset: 80, maxWidth: 900, fontFamily: "Impact, 'Arial Black', sans-serif", fontSize: 120, fontWeight: 900, uppercase: true, lineHeight: 1.05 },
    { name: 'tag', defaultText: 'NEW EPISODE', x: 'right', y: 'bottom', xOffset: 70, yOffset: 60, maxWidth: 700, fontFamily: "Georgia, 'Times New Roman', serif", fontSize: 64, fontWeight: 700 },
  ],
}

const CASES: Array<[string, OverlayTemplate]> = [
  ['centered-hero-headline', bundled('centered-hero-headline')],
  ['portrait-block-right', bundled('portrait-block-right')],
  ['synthetic left/top + right/bottom', SYNTHETIC],
]
const TITLES = ['Your title here', 'The Lamplighter of Pier Nine and the Long Night of Fog']

test('composeThumbnail paints exactly the overlay the editor previews', async () => {
  const bg = await blackBackground()
  for (const [name, tmpl] of CASES) {
    for (const title of TITLES) {
      const text = previewOverlayText(title)
      const server = await sharp(await composeThumbnail({ sourcePath: bg, template: tmpl as any, ...text })).raw().toBuffer()
      const preview = await sharp(bg)
        .composite([{ input: Buffer.from(buildOverlaySvg(tmpl, text)), top: 0, left: 0 }])
        .png().toBuffer()
      assert.ok(server.equals(await sharp(preview).raw().toBuffer()), `${name} / "${title}" — server render differs from the preview document`)
    }
  }
})

/** Ink bounding box of one zone drawn alone, white on black, no shadow. */
async function inkBox(zone: OverlayTextZone, title: string) {
  const solo: OverlayTemplate = { canvas: CANVAS, textZones: [{ ...zone, fill: '#ffffff', shadow: undefined }] }
  const png = await composeThumbnail({ sourcePath: await blackBackground(), template: solo as any, ...previewOverlayText(title) })
  const { data, info } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true })
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[y * info.width + x]! > 128) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  assert.ok(maxX >= 0, 'zone painted something')
  return { minX, minY, maxX, maxY }
}

test('editor layout boxes sit where the server draws the text (within a few px)', async () => {
  const TOL = 6
  for (const [name, tmpl] of CASES) {
    for (const zone of tmpl.textZones || []) {
      for (const title of TITLES) {
        const l = layoutTextZone(zone, CANVAS, previewOverlayText(title))
        const ink = await inkBox(zone, title)
        const where = `${name} / ${zone.name} / "${title}"`
        const descent = zone.fontSize * 0.3
        // Vertical: ink starts below the box top (cap height < em) and ends
        // by the last baseline plus descenders.
        const lastBaseline = l.firstBaseline + l.lineStep * (l.lines.length - 1)
        assert.ok(ink.minY >= l.box.top - TOL, `${where}: ink top ${ink.minY} above box top ${l.box.top}`)
        assert.ok(ink.maxY <= lastBaseline + descent, `${where}: ink bottom ${ink.maxY} below last baseline ${lastBaseline}`)
        assert.ok(ink.minY <= l.firstBaseline - zone.fontSize * 0.5, `${where}: first line not on its baseline`)
        // Horizontal: the anchored edge lands on the anchor x.
        if (l.anchor === 'start') assert.ok(Math.abs(ink.minX - l.x) <= TOL + zone.fontSize * 0.08, `${where}: left edge ${ink.minX} vs ${l.x}`)
        if (l.anchor === 'end') assert.ok(Math.abs(ink.maxX - l.x) <= TOL + (zone.letterSpacing ?? 0) + zone.fontSize * 0.08, `${where}: right edge ${ink.maxX} vs ${l.x}`)
        if (l.anchor === 'middle') assert.ok(Math.abs((ink.minX + ink.maxX) / 2 - l.x) <= TOL + (zone.letterSpacing ?? 0), `${where}: centre ${(ink.minX + ink.maxX) / 2} vs ${l.x}`)
      }
    }
  }
})
