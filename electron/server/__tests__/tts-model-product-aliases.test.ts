/**
 * The TTS catalogue must carry the identifiers a product also answers to.
 *
 * WHAT WAS WRONG. `GenStudioProductAliases` was mixed into the image, chat and
 * video model types and spread in their parsers, but NOT into `GenStudioTtsModel`
 * or the TTS row literal. The catalogue parsers build explicit object literals,
 * so a field nobody names is silently dropped — and `legacy_ids` is exactly the
 * field that lets a saved preset or remembered form holding a superseded id be
 * matched to the row the Gateway now publishes it under.
 *
 * WHAT IT COST. A channel whose saved audio preset held the pre-rename model id
 * got no model back at all: `selectedTtsModel` was null, so the page passed
 * `tts-model-id=""` to VoicePicker, which then asked the browser for NO voice
 * list and showed "Choose a voice model first." — a blank picker, with the
 * saved voice stranded as unverified and no voices request even attempted.
 * Measured against this fixture: the page made one request (`/tts-models`) and
 * never called `/genstudio/voices` at all.
 *
 * THE RED CASE. The assertions below read the aliases straight off the parsed
 * TTS row. Before the fix they were absent (`undefined`), which is what made the
 * alias unresolvable; the id/display-name assertions still passed, so the test
 * pins the alias set specifically rather than merely that rows exist.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { useTempDataDir } from './_helpers.js'
import { startMockGenStudioService, MOCK_GENSTUDIO_FULL_KEY } from './fixtures/mock-genstudio-service.js'

/** The rename this pins: the Gateway republished the product under a new id. */
const REPUBLISHED_ROW = {
  id: 'voxcpm2-v1',
  display_name: 'VoxCPM2',
  provider_id: 'vox-provider',
  provider_name: 'VoxProvider',
  description: 'Khmer-capable TTS.',
  credits_per_1000_characters: 2,
  minimum_credits: 2,
  maximum_input_characters: 20_000,
  supports_speed: true,
  minimum_speed: 0.5,
  maximum_speed: 2.0,
  supports_voice_cloning: true,
  preview_policy: '',
  generation_enabled: true,
  controls: [],
  supported_languages: ['km', 'en'],
  legacy_ids: ['voxcpm2', 'voxcpm-2'],
  customer_handle: 'voxcpm2',
  public_model_id: 'genstudio-voxcpm2-v1',
}

test('the TTS catalogue keeps the identifiers a product also answers to', async () => {
  await useTempDataDir()
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  const service = await startMockGenStudioService()
  // One catalogue read, two rows: the republished product, and one that
  // publishes no aliases at all.
  service.ttsModels = [
    REPUBLISHED_ROW,
    {
      ...REPUBLISHED_ROW,
      id: 'plain-tts-v1',
      display_name: 'Plain TTS',
      legacy_ids: undefined,
      customer_handle: undefined,
      public_model_id: undefined,
    },
  ]
  try {
    const settings = await import('../services/app-settings.js')
    const { listTtsModels, clearGenStudioCatalogCache } = await import('../lib/genstudio-client.js')
    await settings.setGenStudioUrl(service.baseUrl)
    clearGenStudioCatalogCache()

    const rows = await listTtsModels(MOCK_GENSTUDIO_FULL_KEY)
    const row = rows.find(candidate => candidate.id === 'voxcpm2-v1')
    assert.ok(row, 'the republished row is published')
    assert.equal(row.display_name, 'VoxCPM2')

    // The regression: these were dropped, which stranded every saved selection
    // holding an older id.
    assert.deepEqual(row.legacy_ids, ['voxcpm2', 'voxcpm-2'])
    assert.equal(row.customer_handle, 'voxcpm2')
    assert.equal(row.public_model_id, 'genstudio-voxcpm2-v1')

    // Absent stays absent: Story Studio never invents an alias, and an empty
    // array would be a claim that GenStudio published one.
    const plain = rows.find(candidate => candidate.id === 'plain-tts-v1')
    assert.ok(plain, 'the plain row is published')
    assert.equal(plain.legacy_ids, undefined)
    assert.equal(plain.customer_handle, undefined)
    assert.equal(plain.public_model_id, undefined)
  } finally {
    await service.close().catch(() => {})
  }
})

test('the shared identity resolver matches the superseded id against the live row', async () => {
  const { isGenStudioProduct } = await import('../contracts/genstudio-product-identity.js')
  assert.equal(isGenStudioProduct(REPUBLISHED_ROW as any, 'voxcpm2'), true)
  assert.equal(isGenStudioProduct(REPUBLISHED_ROW as any, 'genstudio-voxcpm2-v1'), true)
  assert.equal(isGenStudioProduct(REPUBLISHED_ROW as any, 'some-other-model'), false)
})
