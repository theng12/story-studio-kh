import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clearGenStudioCatalogCache,
  listImageModels,
} from '../lib/genstudio-client.js'

/**
 * An absent catalogue default is not permission to choose a familiar frame.
 * Keep the public string contract, but carry absence as its empty value so
 * callers can require an explicit published/default choice.
 */
test('image catalogue preserves an absent or null aspect-ratio default without inventing 16:9', async () => {
  const originalFetch = globalThis.fetch
  clearGenStudioCatalogCache()
  try {
    globalThis.fetch = async (input) => {
      assert.match(String(input), /\/v1\/image\/models$/)
      return Response.json([
        { id: 'absent-default', display_name: 'Absent default', aspect_ratios: ['4:3'] },
        { id: 'null-default', display_name: 'Null default', aspect_ratios: ['9:16'], default_aspect_ratio: null },
        { id: 'published-default', display_name: 'Published default', aspect_ratios: ['3:2'], default_aspect_ratio: '3:2' },
      ])
    }

    const models = await listImageModels('task13-image-default-aspect')
    assert.deepEqual(models.map(model => [model.id, model.default_aspect_ratio]), [
      ['absent-default', ''],
      ['null-default', ''],
      ['published-default', '3:2'],
    ])
  } finally {
    globalThis.fetch = originalFetch
    clearGenStudioCatalogCache()
  }
})
