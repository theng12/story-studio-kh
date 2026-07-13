import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeCatalog } from '../services/project-manager.js'

describe('model catalog ownership', () => {
  test('keeps built-in user pricing but drops project-added model entries', () => {
    const defaults: Record<string, Record<string, any>> = {
      built_in: {
        label: 'Built in',
        credits_per_image: 1,
        provider_params: { model: 'provider/current-model' },
      },
    }
    const saved: Record<string, Record<string, any>> = {
      built_in: {
        label: 'Renamed by stale config',
        credits_per_image: 7,
        provider_params: { model: 'provider/obsolete-model' },
        is_custom: true,
      },
      custom_model: {
        label: 'Project custom model',
        credits_per_image: 3,
        is_custom: true,
      },
    }

    const merged = mergeCatalog(defaults, saved)

    assert.deepEqual(Object.keys(merged), ['built_in'])
    assert.equal(merged.built_in.credits_per_image, 7)
    assert.equal(merged.built_in.label, 'Renamed by stale config')
    assert.deepEqual(merged.built_in.provider_params, { model: 'provider/current-model' })
    assert.equal('is_custom' in merged.built_in, false)
  })
})
