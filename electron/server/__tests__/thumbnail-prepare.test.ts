/**
 * v1.0.524 — thumbnail downscale before YouTube's 2 MB thumbnails.set limit.
 * planThumbnailEncode is the pure sizing decision; prepareThumbnail is verified
 * against a real >2 MB image (built with sharp) to prove the output lands under
 * 2 MB and ≤1280 px wide, while small files pass through byte-for-byte.
 */

import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import os from 'os'
import path from 'path'
import { randomBytes } from 'crypto'
import { promises as fsp } from 'fs'
import sharp from 'sharp'

import {
  planThumbnailEncode,
  prepareThumbnail,
  THUMB_MAX_BYTES,
  THUMB_MAX_WIDTH,
} from '../lib/thumbnail-prepare.js'

describe('planThumbnailEncode', () => {
  test('passthrough for a small, in-spec image (0.47 MB, 1280w)', () => {
    const p = planThumbnailEncode({ bytes: 0.47 * 1024 * 1024, width: 1280 })
    assert.equal(p.passthrough, true)
    assert.equal(p.resizeWidth, null)
  })
  test('over 2 MB → re-encode (no resize when width is in-spec)', () => {
    const p = planThumbnailEncode({ bytes: 2.4 * 1024 * 1024, width: 1280 })
    assert.equal(p.passthrough, false)
    assert.equal(p.resizeWidth, null)
  })
  test('too wide → resize to 1280 even if bytes were fine', () => {
    const p = planThumbnailEncode({ bytes: 1.0 * 1024 * 1024, width: 1920 })
    assert.equal(p.passthrough, false)
    assert.equal(p.resizeWidth, THUMB_MAX_WIDTH)
  })
  test('missing width is treated as in-spec width', () => {
    assert.equal(planThumbnailEncode({ bytes: 1000, width: undefined }).passthrough, true)
  })
})

describe('prepareThumbnail (real sharp round-trip)', () => {
  const tmp: string[] = []
  after(async () => { await Promise.all(tmp.map(f => fsp.rm(f, { force: true }))) })

  // High-entropy pixels so PNG can't compress it below the 2 MB threshold.
  function noise(w: number, h: number): Buffer {
    return randomBytes(w * h * 3)
  }

  test('a >2 MB, 1920-wide PNG is downscaled to <2 MB and ≤1280w JPEG', async () => {
    const src = path.join(os.tmpdir(), `thumb-prep-big-${process.pid}.png`)
    tmp.push(src)
    await sharp(noise(1920, 1080), { raw: { width: 1920, height: 1080, channels: 3 } }).png().toFile(src)
    const stat = await fsp.stat(src)
    assert.ok(stat.size > THUMB_MAX_BYTES, `fixture should exceed 2MB (was ${stat.size})`)

    const out = await prepareThumbnail(src)
    assert.equal(out.resized, true)
    assert.equal(out.contentType, 'image/jpeg')
    assert.ok(out.bytes <= THUMB_MAX_BYTES, `output must be ≤2MB (was ${out.bytes})`)
    const meta = await sharp(out.buffer).metadata()
    assert.ok((meta.width || 0) <= THUMB_MAX_WIDTH, `output width ≤1280 (was ${meta.width})`)
  })

  test('a small in-spec PNG passes through untouched (stays PNG, same bytes)', async () => {
    const src = path.join(os.tmpdir(), `thumb-prep-small-${process.pid}.png`)
    tmp.push(src)
    await sharp({ create: { width: 640, height: 360, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toFile(src)
    const raw = await fsp.readFile(src)
    assert.ok(raw.length <= THUMB_MAX_BYTES)

    const out = await prepareThumbnail(src)
    assert.equal(out.resized, false)
    assert.equal(out.contentType, 'image/png')
    assert.equal(out.bytes, raw.length)
  })
})
