import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'

import { downloadImage } from '../lib/kie-client.js'

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
})

describe('image download validation', () => {
  it('promotes a fully decodable image atomically', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'image-download-valid-'))
    tempDirs.push(dir)
    const destination = path.join(dir, 'scene.png')
    await downloadImage(`data:image/png;base64,${ONE_PIXEL_PNG.toString('base64')}`, destination)
    assert.deepEqual(await fs.readFile(destination), ONE_PIXEL_PNG)
  })

  it('rejects a truncated non-empty image without replacing the destination', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'image-download-corrupt-'))
    tempDirs.push(dir)
    const destination = path.join(dir, 'scene.png')
    await fs.writeFile(destination, ONE_PIXEL_PNG)
    const truncated = ONE_PIXEL_PNG.subarray(0, 40)

    await assert.rejects(
      downloadImage(`data:image/png;base64,${truncated.toString('base64')}`, destination),
      /corrupt or incomplete/,
    )
    assert.deepEqual(await fs.readFile(destination), ONE_PIXEL_PNG)
    const entries = await fs.readdir(dir)
    assert.deepEqual(entries, ['scene.png'])
  })
})
