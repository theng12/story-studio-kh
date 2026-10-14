import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import {
  clearGenStudioCatalogCache,
  listMusicModels,
} from '../lib/genstudio-client.js'
import { useTempDataDir } from './_helpers.js'

const isolated = await useTempDataDir()
after(() => isolated.cleanup())

function musicRow(id: string, chargeable: unknown = undefined): Record<string, unknown> {
  return {
    id,
    display_name: id,
    description: 'Published music parser fixture.',
    coming_soon: false,
    credits_per_request: 0,
    minimum_credits: 0,
    price_version: 'music-zero-v1',
    price_source: 'local',
    price_usd: {},
    standard_credits: 0,
    sale_credits: null,
    sale_ends_at: null,
    sale_disclaimer: null,
    supports_instrumental: true,
    supports_vocals: true,
    requires_lyrics: false,
    max_prompt_characters: 500,
    max_prompt_without_lyrics_characters: 500,
    min_prompt_characters: 1,
    max_lyrics_characters: 5_000,
    min_lyrics_characters: 0,
    max_title_characters: 80,
    outputs_per_request: 1,
    ...(chargeable === undefined ? {} : { chargeable }),
  }
}

test('music catalog preserves published chargeable booleans and rejects a malformed published flag', async () => {
  const originalFetch = globalThis.fetch
  clearGenStudioCatalogCache()
  try {
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), 'http://127.0.0.1:8787/v1/music/models')
      assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer scoped-key')
      return Response.json([
        musicRow('music-explicit-paid', true),
        musicRow('music-explicit-free', false),
        musicRow('music-unpublished'),
        musicRow('music-null', null),
        musicRow('music-malformed', 'false'),
      ])
    }

    const models = await listMusicModels('scoped-key')
    assert.deepEqual(models.map(model => model.id), [
      'music-explicit-paid',
      'music-explicit-free',
      'music-unpublished',
      'music-null',
    ])
    assert.equal(models[0]?.chargeable, true)
    assert.equal(models[1]?.chargeable, false)
    assert.equal(Object.hasOwn(models[2] ?? {}, 'chargeable'), false)
    assert.equal(Object.hasOwn(models[3] ?? {}, 'chargeable'), false)
  } finally {
    globalThis.fetch = originalFetch
    clearGenStudioCatalogCache()
  }
})
