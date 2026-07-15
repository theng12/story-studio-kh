import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { listAvailableHubModels } from '../lib/imagestudio-client.js'
import { listAvailableHubEngines } from '../lib/voicestudio-client.js'

describe('Studio Hub model inventory adapters', () => {
  test('deduplicates image rows and merges fleet download state', () => {
    const result = listAvailableHubModels([
      { repo: 'org/image', label: 'Image', family: 'flux', capabilities: ['txt2img'], hub_cached: false, fit: { state: 'ok' } },
      { repo: 'org/image', label: 'Image', family: 'flux', capabilities: ['txt2img'], hub_cached: true, fit: { state: 'ok' } },
    ])
    assert.equal(result.models.length, 1)
    assert.equal(result.models[0]?.downloaded, true)
    assert.equal(result.models[0]?.id, 'imagestudio:org/image')
  })

  test('maps downloaded Voice repos to stable Story Studio model ids', () => {
    const result = listAvailableHubEngines([
      { repo: 'mlx-community/Kokoro-82M-4bit', downloaded: true },
      { repo: 'mlx-community/VoxCPM2-4bit', downloaded: false },
    ])
    assert.equal(result.ok, true)
    assert.ok(result.models.some(m => m.id === 'voicestudio-kokoro'))
    assert.ok(!result.models.some(m => m.id === 'voicestudio-voxcpm-mlx'))
  })

  test('maps both Qwen3 Base cloning variants from Hub inventory', () => {
    const result = listAvailableHubEngines([
      { repo: 'mlx-community/Qwen3-TTS-12Hz-0.6B-Base-8bit', downloaded: true },
      { repo: 'mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit', downloaded: true },
    ])
    assert.deepEqual(
      result.models.map(model => model.id),
      ['voicestudio-qwen3-tts-base-0.6b', 'voicestudio-qwen3-tts-base-1.7b'],
    )
    assert.ok(result.models.every(model => model.voicepack === false))
  })
})
