import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import request from 'supertest'
import { imageModeId, publishedImageModes } from '../contracts/genstudio-image-modes.js'
import { clearGenStudioCatalogCache } from '../lib/genstudio-client.js'
import { sceneReferenceIds } from '../services/scene-reference-characters.js'
import { useTempDataDir } from './_helpers.js'

const modes = [
  { id: 'txt2img', label: 'Text to image', available: true, reason: null },
  { id: 'edit', label: 'Edit', available: false, reason: 'No free reference worker.',
    references: { min: 1, max: 2, max_dimension: 1024 } },
]

test('published modes retain availability, reasons and limits with customer-facing labels', () => {
  const rows = publishedImageModes(modes)!
  assert.equal(rows[1].label, 'Reference to image')
  assert.equal(rows[1].available, false)
  assert.equal(rows[1].reason, 'No free reference worker.')
  assert.deepEqual(rows[1].references, { min: 1, max: 2, max_dimension: 1024 })
  assert.equal(imageModeId('text2img'), 'txt2img')
  assert.equal(imageModeId('img2img'), 'edit')
  const changed = publishedImageModes([{ ...modes[1], available: true, references: { min: 2, max: 4 } }])!
  assert.equal(changed[0].references?.max, 4)
})

test('absent, empty and malformed modes never invent support from legacy flags', () => {
  assert.equal(publishedImageModes(undefined), undefined)
  assert.equal(publishedImageModes({ supports_reference_images: true }), undefined)
  assert.deepEqual(publishedImageModes([]), [])
  assert.deepEqual(publishedImageModes([{ id: 'img2img', available: true }, { id: 'edit' }]), [])
  const parsed = publishedImageModes([{ id: 'edit', available: true, references: { min: -1, max: '2', max_dimension: 512 } }])!
  assert.deepEqual(parsed[0].references, { max_dimension: 512 })
})

test('explicit text mode suppresses saved scene references without rewriting the saved choice', () => {
  const scene = { reference_character_ids: ['mara'] }
  assert.deepEqual(sceneReferenceIds(scene, ['kiri'], 'text2img'), [])
  assert.deepEqual(sceneReferenceIds(scene, ['kiri'], 'img2img'), ['mara'])
  assert.deepEqual(scene.reference_character_ids, ['mara'])
  assert.deepEqual(sceneReferenceIds(scene, ['kiri']), ['mara'], 'historical jobs retain their reference behavior')
})

let app: any
let cleanup: () => Promise<void>
let originalFetch: typeof globalThis.fetch
before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  app = (await import('../app.js')).app
  originalFetch = globalThis.fetch
})
after(async () => {
  globalThis.fetch = originalFetch
  clearGenStudioCatalogCache()
  await cleanup()
})

test('the actual image catalogue route preserves only published modes', async () => {
  await request(app).put('/api/app-settings/api-keys/genstudio').send({ apiKey: 'gsk_test_image_modes' }).expect(200)
  clearGenStudioCatalogCache()
  globalThis.fetch = async input => {
    assert.match(String(input), /\/v1\/image\/models$/)
    return Response.json([
      { id: 'dual', display_name: 'Dual', available: true, credits_per_image: 0, minimum_credits: 0, image_modes: modes },
      { id: 'legacy', display_name: 'Legacy', available: true, credits_per_image: 0, minimum_credits: 0, supports_reference_images: true, max_reference_images: 2 },
    ])
  }
  const response = await request(app).get('/api/app-settings/genstudio/image-models').expect(200)
  assert.deepEqual(response.body.models.find((row: any) => row.id === 'dual').image_modes, publishedImageModes(modes))
  assert.equal(Object.hasOwn(response.body.models.find((row: any) => row.id === 'legacy'), 'image_modes'), false)
})
