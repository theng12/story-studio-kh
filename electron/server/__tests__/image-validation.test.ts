import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import sharp from 'sharp'
import { assertDecodableImage, clearImageValidationCache, decodableImageSignature } from '../lib/image-validation.js'

let dir: string
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'image-validation-')) })
afterEach(async () => {
  clearImageValidationCache()
  await fs.rm(dir, { recursive: true, force: true })
})

// Non-compressible pixels keep the truncated tail inside the image body,
// rather than merely removing optional trailing metadata or a PNG end marker.
function pixels(): Buffer {
  const bytes = Buffer.alloc(128 * 128 * 3)
  let seed = 123456789
  for (let i = 0; i < bytes.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    bytes[i] = seed >>> 24
  }
  return bytes
}

for (const format of ['png', 'jpeg', 'webp'] as const) {
  test(`fully validates ${format}, rejecting truncated bodies that still have readable headers`, async () => {
    const file = path.join(dir, `image.${format}`)
    const encoded = await sharp(pixels(), { raw: { width: 128, height: 128, channels: 3 } })
      .toFormat(format).toBuffer()
    await fs.writeFile(file, encoded)
    assert.deepEqual(await assertDecodableImage(file), { width: 128, height: 128, format })
    const signature = await decodableImageSignature(file)
    assert.ok(signature)
    assert.equal(await decodableImageSignature(file), signature)
    for (const fraction of [0.99, 0.65]) {
      const broken = path.join(dir, `truncated-${fraction}.${format}`)
      await fs.writeFile(broken, encoded.subarray(0, Math.floor(encoded.length * fraction)))
      if (format !== 'webp') {
        const metadata = await sharp(broken).metadata()
        assert.equal(metadata.width, 128, 'a header-only check would accept this corrupt image')
      }
      await assert.rejects(assertDecodableImage(broken), /corrupt or incomplete/)
      assert.equal(await decodableImageSignature(broken), null)
      await fs.writeFile(broken, encoded)
      assert.ok(await decodableImageSignature(broken), 'a repaired image is checked again')
      await fs.unlink(broken)
    }
    assert.deepEqual(await fs.readFile(file), encoded, 'validation never rewrites the input')
    assert.deepEqual(await fs.readdir(dir), [`image.${format}`], 'no converted image is left beside the source')
  })
}

test('a same-size replacement is revalidated when its timestamp changes', async () => {
  const file = path.join(dir, 'image.png')
  const encoded = await sharp(pixels(), { raw: { width: 128, height: 128, channels: 3 } }).png().toBuffer()
  await fs.writeFile(file, encoded)
  assert.ok(await decodableImageSignature(file))
  const original = await fs.stat(file)
  await fs.writeFile(file, Buffer.alloc(encoded.length))
  const later = new Date(original.mtimeMs + 2000)
  await fs.utimes(file, later, later)
  assert.equal(await decodableImageSignature(file), null)
})

test('validates transparent images and rejects missing or empty files', async () => {
  const file = path.join(dir, 'image.png')
  await assert.rejects(assertDecodableImage(file), /missing or empty/)
  await fs.writeFile(file, '')
  await assert.rejects(assertDecodableImage(file), /missing or empty/)
  await sharp({ create: { width: 4, height: 3, channels: 4, background: '#12345678' } }).png().toFile(file)
  assert.deepEqual(await assertDecodableImage(file), { width: 4, height: 3, format: 'png' })
})

test('keeps validation available for other imported image formats', async () => {
  const file = path.join(dir, 'reference.tiff')
  await sharp(pixels(), { raw: { width: 128, height: 128, channels: 3 } }).tiff().toFile(file)
  assert.deepEqual(await assertDecodableImage(file), { width: 128, height: 128, format: 'tiff' })
})
