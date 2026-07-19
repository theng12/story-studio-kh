import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeCatalog, migrateRetiredAudioDefaults } from '../services/project-manager.js'

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

  test('heals retired internally chunked defaults without replacing deliberate limits', () => {
    const defaults: Record<string, Record<string, any>> = {
      'genstudio-qwen3-standard': { tts_soft_max_chars: 15000 },
      'voicestudio-qwen3-tts': { tts_soft_max_chars: 2000 },
      'voicestudio-qwen3-tts-base-0.6b': { tts_soft_max_chars: 15000 },
      'voicestudio-qwen3-tts-base-1.7b': { tts_soft_max_chars: 15000 },
      'voicestudio-chatterbox-mlx': { tts_soft_max_chars: 15000 },
      'voicestudio-voxcpm-mlx': { tts_soft_max_chars: 15000 },
    }
    const saved: Record<string, Record<string, any>> = {
      'genstudio-qwen3-standard': { tts_soft_max_chars: 375 },
      'voicestudio-qwen3-tts': { tts_soft_max_chars: 3000 },
      'voicestudio-qwen3-tts-base-0.6b': { tts_soft_max_chars: 5000 },
      'voicestudio-qwen3-tts-base-1.7b': { tts_soft_max_chars: 2400 },
      'voicestudio-chatterbox-mlx': { tts_soft_max_chars: 1000 },
      'voicestudio-voxcpm-mlx': { tts_soft_max_chars: 500 },
    }

    const merged = migrateRetiredAudioDefaults(mergeCatalog(defaults, saved), saved)

    assert.equal(merged['genstudio-qwen3-standard'].tts_soft_max_chars, 15000)
    assert.equal(merged['voicestudio-qwen3-tts'].tts_soft_max_chars, 3000)
    assert.equal(merged['voicestudio-qwen3-tts-base-0.6b'].tts_soft_max_chars, 15000)
    assert.equal(merged['voicestudio-qwen3-tts-base-1.7b'].tts_soft_max_chars, 2400)
    assert.equal(merged['voicestudio-chatterbox-mlx'].tts_soft_max_chars, 15000)
    assert.equal(merged['voicestudio-voxcpm-mlx'].tts_soft_max_chars, 15000)
  })
})
