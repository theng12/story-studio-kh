import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import sharp from 'sharp'
import { DEFAULT_IMAGE_SIZE, resolveRenderImageSize } from '../lib/image-size.js'
import { stageGenStudioImage } from '../lib/genstudio-artifacts.js'

test('a render that names no size uses the owner default, and a named one is honoured', () => {
  assert.equal(DEFAULT_IMAGE_SIZE, '1024x576')
  assert.deepEqual(resolveRenderImageSize(undefined), { size: { width: 1024, height: 576 }, label: '1024x576' })
  assert.deepEqual(resolveRenderImageSize('1280x720'), { size: { width: 1280, height: 720 }, label: '1280x720' })
  // Anything unreadable falls back to the default rather than inventing a size.
  assert.equal(resolveRenderImageSize('huge').label, '1024x576')
  assert.equal(resolveRenderImageSize('0x0').label, '1024x576')
})

test('a picture from a model that publishes another size lands at the canonical size', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'image-size-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  // FLUX2 publishes 1280x720; the batch is writing 1024x576.
  const png = await sharp({ create: { width: 1280, height: 720, channels: 3, background: '#334155' } }).png().toBuffer()
  const target = path.join(dir, 'scene-0001.png')
  const staged = await stageGenStudioImage(
    `data:image/png;base64,${png.toString('base64')}`, target, { size: { width: 1024, height: 576 } },
  )
  const meta = await sharp(staged).metadata()
  assert.equal(meta.width, 1024)
  assert.equal(meta.height, 576)
})
