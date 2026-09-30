/**
 * Price truth on catalogue rows and job envelopes (gateway 0.2.82).
 *
 * `price_source` / `price_usd` / `price_as_of` ride beside the zero-valued credit shapes the gateway
 * still sends. The shapes are not prices: they must survive parsing exactly as before (so a row is
 * never dropped) and the truth must arrive next to them, verbatim. An older gateway sends none of it,
 * and then the row simply has no USD price.
 */

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import {
  clearGenStudioCatalogCache,
  listChatModels,
  listImageModels,
  listTranscriptionModels,
  parseGenStudioPriceTruth,
  providerCostUsd,
} from '../lib/genstudio-client.js'
import { useTempDataDir } from './_helpers.js'

const isolatedDataDir = await useTempDataDir()
after(() => isolatedDataDir.cleanup())

const ZERO_CHAT = {
  available: true, qualification_only: false, context_window_tokens: 128_000, max_output_tokens: 8_192,
  input_credits_per_million_tokens: 0, output_credits_per_million_tokens: 0, minimum_credits: 0,
  price_version: 'flat', chargeable: true,
}
const PROVIDER = {
  price_source: 'provider',
  price_usd: { input_per_1m_tokens: 0.075, output_per_1m_tokens: 0.3, cached_input_per_1m_tokens: 0.01 },
  price_as_of: '2026-09-30T08:12:44+00:00',
}

async function served<T>(path: RegExp, rows: unknown[], key: string, list: (key: string) => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch
  clearGenStudioCatalogCache()
  try {
    globalThis.fetch = async (input) => {
      assert.match(String(input), path)
      return Response.json(rows)
    }
    return await list(key)
  } finally {
    globalThis.fetch = originalFetch
    clearGenStudioCatalogCache()
  }
}

test('a chat row keeps its zero credit shapes and gains the provider price verbatim', async () => {
  const [model] = await served(/\/v1\/chat\/models$/, [
    { ...ZERO_CHAT, id: 'gpt-oss', display_name: 'GPT OSS', ...PROVIDER },
  ], 'price-chat-provider', listChatModels)
  assert.equal(model?.input_credits_per_million_tokens, 0)
  assert.equal(model?.price_version, 'flat')
  assert.equal(model?.price_source, 'provider')
  assert.deepEqual(model?.price_usd, PROVIDER.price_usd)
  assert.equal(model?.price_as_of, PROVIDER.price_as_of)
})

test('local rows are free, unpublished rows carry no price, and an older gateway sends nothing', async () => {
  const models = await served(/\/v1\/chat\/models$/, [
    { ...ZERO_CHAT, id: 'mac', display_name: 'Mac', price_source: 'local', price_usd: { input_per_1m_tokens: 0, output_per_1m_tokens: 0 }, price_as_of: null },
    { ...ZERO_CHAT, id: 'nobody', display_name: 'Nobody', price_source: 'unpublished', price_usd: null, price_as_of: null },
    { ...ZERO_CHAT, id: 'old', display_name: 'Old gateway row' },
  ], 'price-chat-mixed', listChatModels)
  const [local, unpublished, old] = models
  assert.equal(local?.price_source, 'local')
  assert.equal(local?.price_usd?.input_per_1m_tokens, 0)
  assert.equal(unpublished?.price_source, 'unpublished')
  assert.equal(unpublished?.price_usd, null)
  assert.equal(old?.id, 'old', 'a row without price truth is still parsed')
  assert.equal('price_source' in (old ?? {}), false)
  assert.equal('price_usd' in (old ?? {}), false)
})

test('image and transcription rows carry price truth too', async () => {
  const [image] = await served(/\/v1\/image\/models$/, [{
    id: 'img', display_name: 'Img', available: true, qualification_only: false,
    credits_per_image: 0, base_credits_per_image: 0, price_version: 'flat', chargeable: true,
    price_source: 'provider', price_usd: { per_image: 0.04 }, price_as_of: '2026-09-30T00:00:00+00:00',
  }], 'price-image', listImageModels)
  assert.equal(image?.credits_per_image, 0)
  assert.deepEqual(image?.price_usd, { per_image: 0.04 })

  const [stt] = await served(/\/v1\/transcription\/models$/, [{
    id: 'stt', display_name: 'STT', available: true, qualification_only: false,
    credits_per_second: 0, minimum_credits: 0, price_version: 'flat',
    price_source: 'local', price_usd: { per_second: 0 }, price_as_of: null,
  }], 'price-stt', listTranscriptionModels)
  assert.equal(stt?.price_source, 'local')
  assert.equal(stt?.price_usd?.per_second, 0)
})

test('malformed price truth is never read as free', () => {
  assert.deepEqual(parseGenStudioPriceTruth(null), {})
  assert.deepEqual(parseGenStudioPriceTruth({ price_source: 'free' }), {})
  // "provider" with no usable number is unpublished, not $0
  assert.deepEqual(parseGenStudioPriceTruth({ price_source: 'provider', price_usd: { per_image: 'cheap', x: -1 } }),
    { price_source: 'unpublished', price_usd: null, price_as_of: null })
  assert.deepEqual(parseGenStudioPriceTruth({ price_source: 'unpublished', price_usd: { per_image: 5 } }),
    { price_source: 'unpublished', price_usd: null, price_as_of: null })
  assert.deepEqual(parseGenStudioPriceTruth({ price_source: 'local', price_usd: null }),
    { price_source: 'local', price_usd: {}, price_as_of: null }, 'a local row is free even with no numbers')
  // a stated 0 from the provider is a real, free price
  assert.deepEqual(parseGenStudioPriceTruth({ price_source: 'provider', price_usd: { per_image: 0 }, price_as_of: '2026-09-30T00:00:00Z' }),
    { price_source: 'provider', price_usd: { per_image: 0 }, price_as_of: '2026-09-30T00:00:00Z' })
})

test('job cost is carried only when the provider stated it', () => {
  assert.deepEqual(providerCostUsd({ cost_usd: 0.0027754454, cost_source: 'provider' }), { cost_usd: 0.0027754454, cost_source: 'provider' })
  assert.deepEqual(providerCostUsd({ cost_usd: 0, cost_source: 'provider' }), { cost_usd: 0, cost_source: 'provider' })
  assert.deepEqual(providerCostUsd({}), {})
  assert.deepEqual(providerCostUsd({ cost_usd: 1 }), {}, 'a number with no cost_source is not assumed to be the provider’s')
  assert.deepEqual(providerCostUsd({ cost_usd: Number.NaN, cost_source: 'provider' }), {})
})

test('a pricing-page row keeps its url and its variants, and never invents a single number', () => {
  const page = parseGenStudioPriceTruth({
    price_source: 'provider_page',
    price_usd: { per_video: 1.5 },
    price_as_of: '2026-09-29T00:00:00+00:00',
    price_url: 'https://provider.example/pricing',
    price_variants: [
      { unit: 'per_image', usd: 0.04, variant: '1K', source_url: 'https://provider.example/pricing' },
      { unit: 'per_image', usd: 0.08, variant: '2K' },
      { unit: 'per_image', usd: 'free', variant: 'bad' },
      { usd: 1, variant: 'no unit' },
    ],
  })
  assert.equal(page.price_source, 'provider_page')
  assert.equal(page.price_url, 'https://provider.example/pricing')
  assert.deepEqual(page.price_usd, { per_video: 1.5 })
  assert.deepEqual(page.price_variants, [
    { unit: 'per_image', usd: 0.04, variant: '1K', source_url: 'https://provider.example/pricing' },
    { unit: 'per_image', usd: 0.08, variant: '2K' },
  ])
  // "other" units carry the page's own words, no usd
  assert.deepEqual(parseGenStudioPriceTruth({ price_source: 'provider_page', price_usd: {}, price_url: 'https://p.example/x',
    price_variants: [{ unit: 'other', variant: 'text-to-speech', unit_text: '$15.00 / M UTF-8 bytes' }, { unit: 'other', variant: 'free tier', unit_text: 'Free of charge' }, { unit: 'other', variant: 'empty' }] }).price_variants,
  [{ unit: 'other', variant: 'text-to-speech', unit_text: '$15.00 / M UTF-8 bytes' }, { unit: 'other', variant: 'free tier', unit_text: 'Free of charge' }])
  // variants only: priced (it varies), not unpublished
  assert.equal(parseGenStudioPriceTruth({ price_source: 'provider_page', price_usd: {}, price_url: 'https://p.example/x',
    price_variants: [{ unit: 'per_image', usd: 0.04, variant: '1K' }] }).price_source, 'provider_page')
  // a non-http url is dropped; variants/url on any other source are ignored
  assert.equal(parseGenStudioPriceTruth({ price_source: 'provider_page', price_usd: { per_image: 1 }, price_url: 'javascript:alert(1)' }).price_url, undefined)
  const api = parseGenStudioPriceTruth({ price_source: 'provider', price_usd: { per_image: 1 }, price_url: 'https://p.example/x',
    price_variants: [{ unit: 'per_image', usd: 2, variant: 'x' }] })
  assert.equal('price_url' in api, false)
  assert.equal('price_variants' in api, false)
  // a page row with nothing usable is unpublished, and an absent field is tolerated
  assert.equal(parseGenStudioPriceTruth({ price_source: 'provider_page', price_usd: null }).price_source, 'unpublished')
})
