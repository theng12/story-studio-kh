import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_IMAGE_SIZE, storyDefaultAspectRatio, storyDefaultOutputOption } from '../contracts/genstudio-image-defaults.js'

const flux = {
  display_name: 'FLUX2-klein-4B',
  default_resolution: '1K',
  output_options: [
    { resolution: '1K', aspect_ratio: '16:9', width: 1280, height: 720, is_default: true },
    { resolution: '1K', aspect_ratio: '16:9 small', width: 1024, height: 576, is_default: false },
    { resolution: '1K', aspect_ratio: '1:1', width: 1024, height: 1024, is_default: false },
  ],
}
const qwen = {
  display_name: 'qwen-image-2-1-turbo',
  default_resolution: '1K',
  output_options: [
    { resolution: '1K', aspect_ratio: '16:9', width: 1024, height: 576, is_default: false },
    { resolution: '1K', aspect_ratio: '1:1', width: 1024, height: 1024, is_default: true },
  ],
}

test('an unnamed size lands on 1024x576 on both models, whatever the row is called', () => {
  assert.deepEqual(DEFAULT_IMAGE_SIZE, { width: 1024, height: 576 })
  // FLUX2 calls the row `16:9 small`; qwen calls it `16:9`. Both must be chosen.
  assert.equal(storyDefaultAspectRatio(flux), '16:9 small')
  assert.equal(storyDefaultAspectRatio(qwen), '16:9')
  const fluxRow = storyDefaultOutputOption(flux)
  assert.deepEqual([fluxRow?.width, fluxRow?.height], [1024, 576])
  const qwenRow = storyDefaultOutputOption(qwen)
  assert.deepEqual([qwenRow?.width, qwenRow?.height], [1024, 576])
})

test('a model with no 1024x576 row keeps its previous default', () => {
  const onlyBig = {
    default_resolution: '1K',
    output_options: [
      { resolution: '1K', aspect_ratio: '16:9', width: 1536, height: 1024, is_default: true },
    ],
  }
  assert.equal(storyDefaultAspectRatio(onlyBig), '16:9')
  assert.equal(storyDefaultOutputOption(onlyBig)?.height, 1024)
})
