/**
 * Owner, 2026-10-09: "add a way to put a shape around the logo: smooth its
 * corners, or place it in a circle." Cut once per render into a still PNG; the
 * FFmpeg graph never gains a per-frame `geq`. None (the default) is unchanged.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { logoCornerRadiusPct, logoShapeMaskSvg, logoShapeOf, writeShapedLogo } from '../lib/logo-shape.js'

const dir = await mkdtemp(path.join(os.tmpdir(), 'logo-shape-'))
const source = path.join(dir, 'logo.png')
await sharp({ create: { width: 400, height: 200, channels: 3, background: '#ff0000' } }).png().toFile(source)
const alphaAt = async (file: string, x: number, y: number) => {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return data[(y * info.width + x) * info.channels + 3]
}

test('shape and radius values: anything unknown is none; radius 1–50 %, default 20', () => {
  assert.equal(logoShapeOf(undefined), 'none')
  assert.equal(logoShapeOf('star'), 'none')
  assert.equal(logoShapeOf('rounded'), 'rounded')
  assert.equal(logoShapeOf('circle'), 'circle')
  assert.equal(logoCornerRadiusPct(undefined), 20)
  assert.equal(logoCornerRadiusPct(80), 50)
  assert.equal(logoCornerRadiusPct(0), 1)
})

test('the mask for each shape', () => {
  assert.equal(logoShapeMaskSvg(102, 51, 'rounded', 20), '<svg xmlns="http://www.w3.org/2000/svg" width="102" height="51"><rect x="0" y="0" width="102" height="51" rx="10" ry="10"/></svg>')
  assert.equal(logoShapeMaskSvg(102, 102, 'circle'), '<svg xmlns="http://www.w3.org/2000/svg" width="102" height="102"><circle cx="51" cy="51" r="51"/></svg>')
})

test('rounded keeps the aspect at the rendered width and clears the corners', async () => {
  const out = path.join(dir, 'rounded.png')
  assert.deepEqual(await writeShapedLogo(source, out, 102, 'rounded', 20), { width: 102, height: 51 })
  assert.equal(await alphaAt(out, 0, 0), 0, 'corner cut away')
  assert.equal(await alphaAt(out, 51, 25), 255, 'middle kept')
  assert.equal(await alphaAt(out, 51, 0), 255, 'straight edge kept')
})

test('circle is a centre-fitted square cut to a circle', async () => {
  const out = path.join(dir, 'circle.png')
  assert.deepEqual(await writeShapedLogo(source, out, 154, 'circle'), { width: 154, height: 154 })
  assert.equal(await alphaAt(out, 0, 0), 0)
  assert.equal(await alphaAt(out, 10, 77), 255, 'inside the circle at the left middle')
  assert.equal(await alphaAt(out, 77, 77), 255)
})

test('the render uses the shaped still only when a shape is chosen, and no geq touches the logo', async () => {
  const video = await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'generators', 'video.ts'), 'utf8')
  const block = video.slice(video.indexOf('A rounded or circle logo is cut once'), video.indexOf('logoInputIdx = nextInputIdx++'))
  assert.match(block, /let logoPath = logo\.image_path/, 'none keeps the original file')
  assert.match(block, /if \(shape !== 'none'\)/)
  assert.match(block, /args\.push\('-i', logoPath\)/)
  assert.match(block, /the logo is shown as it is/, 'a failed cut falls back to the plain logo')
  assert.match(video, /filterParts\.push\(`\[\$\{logoInputIdx\}:v\]scale=\$\{logoW\}:-1,format=rgba,colorchannelmixer=aa=\$\{opacity\}\[logo\]`\)/, 'the logo filter is unchanged')
  assert.doesNotMatch(block, /geq/)
})
