import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  describeChatRate,
  describeImageModelRate,
  describeImageUnitCost,
  describeMusicUnitCost,
  describeVideoModelRate,
  describeVoiceRate,
} from '../utils/genstudio-credit-cost.js'
import { describeTranscriptionRate } from '../composables/useGenStudioTranscription.js'
import {
  describeJobCostUsd,
  describeUsdPrice,
  ESTIMATE_STEPS,
  estimateBatchUsd,
  formatUsd,
  stepQuantity,
  type EstimateStep,
} from '../utils/genstudio-price-usd.js'

// The gateway's zero-valued credit shapes: parser scaffolding, never a price.
const ZERO_SHAPES = {
  chargeable: true,
  credits_per_image: 0,
  input_credits_per_million_tokens: 0,
  output_credits_per_million_tokens: 0,
  credits_per_1000_characters: 0,
  credits_per_second: 0,
  credits_per_request: 0,
  variants: [{ credits_per_video: 0 }],
}
const CHAT_PROVIDER = {
  display_name: 'GPT OSS',
  price_source: 'provider' as const,
  price_usd: { input_per_1m_tokens: 0.075, output_per_1m_tokens: 0.3, cached_input_per_1m_tokens: 0.01 },
  price_as_of: '2026-09-30T08:12:44+00:00',
}

test('a provider chat price shows real USD with its units and date, never the zero credit shapes', () => {
  const rate = describeChatRate({ ...ZERO_SHAPES, ...CHAT_PROVIDER })
  assert.equal(rate.basis, 'provider')
  assert.equal(rate.text, '$0.075 / 1M input tokens · $0.30 / 1M output tokens · as of 2026-09-30')
  assert.match(rate.title, /\$0\.01 \/ 1M cached input tokens/)
  assert.doesNotMatch(rate.text, /credit/i)
})

test('every modality shows its own unit', () => {
  const asOf = { price_source: 'provider' as const, price_as_of: '2026-09-30T00:00:00+00:00' }
  assert.equal(describeImageUnitCost({ ...ZERO_SHAPES, ...asOf, price_usd: { per_image: 0.04 } }, null).text, '$0.04 / image · as of 2026-09-30')
  assert.equal(describeImageModelRate({ ...ZERO_SHAPES, ...asOf, price_usd: { per_image: 0.04 } }).text, '$0.04 / image · as of 2026-09-30')
  assert.equal(describeVideoModelRate({ ...ZERO_SHAPES, ...asOf, price_usd: { per_second: 0.1 } }).text, '$0.10 / second · as of 2026-09-30')
  assert.equal(describeVideoModelRate({ ...ZERO_SHAPES, ...asOf, price_usd: { per_video: 1.5 } }).text, '$1.50 / video · as of 2026-09-30')
  assert.equal(describeVoiceRate({ ...ZERO_SHAPES, ...asOf, price_usd: { per_1k_chars: 0.03 } }).text, '$0.03 / 1,000 characters · as of 2026-09-30')
  assert.equal(describeTranscriptionRate({ ...ZERO_SHAPES, ...asOf, price_usd: { per_second: 0.0001 } }).text, '$0.0001 / second · as of 2026-09-30')
  assert.equal(describeMusicUnitCost({ ...ZERO_SHAPES, ...asOf, price_usd: { per_request: 0.2 } }).text, '$0.20 / request · as of 2026-09-30')
})

test('local rows read "Free — your fleet" in every picker', () => {
  const local = { ...ZERO_SHAPES, display_name: 'This Mac', price_source: 'local' as const, price_usd: { per_image: 0 }, price_as_of: null }
  for (const shown of [
    describeChatRate(local), describeImageUnitCost(local, null), describeImageModelRate(local),
    describeVideoModelRate(local), describeVoiceRate(local), describeTranscriptionRate(local), describeMusicUnitCost(local),
  ]) {
    assert.equal(shown.text, 'Free — your fleet')
    assert.equal(shown.basis, 'local')
  }
})

test('unpublished rows say "Price not published" — not $0, not free, not credits', () => {
  const unpublished = { ...ZERO_SHAPES, display_name: 'GPT', price_source: 'unpublished' as const, price_usd: null, price_as_of: null }
  for (const shown of [
    describeChatRate(unpublished), describeImageUnitCost(unpublished, null), describeImageModelRate(unpublished),
    describeVideoModelRate(unpublished), describeVoiceRate(unpublished), describeTranscriptionRate(unpublished), describeMusicUnitCost(unpublished),
  ]) {
    assert.equal(shown.text, 'Price not published')
    assert.equal(shown.basis, 'not-published')
  }
})

test('a stated provider zero is genuinely free, and unit-less or malformed truth is not a price', () => {
  const free = describeUsdPrice({ price_source: 'provider', price_usd: { input_per_1m_tokens: 0, output_per_1m_tokens: 0 }, price_as_of: '2026-09-30T00:00:00Z' })
  assert.equal(free?.basis, 'free')
  assert.equal(describeUsdPrice({ price_source: 'provider', price_usd: {} })?.text, 'Price not published')
  assert.equal(describeUsdPrice({ price_source: 'provider', price_usd: { per_image: 0.04 } })?.text, '$0.04 / image')
})

test('an older gateway row (no price_source) keeps the credit display exactly as before', () => {
  assert.equal(describeUsdPrice({ display_name: 'x' }), null)
  const rate = describeChatRate({ display_name: 'Old', input_credits_per_million_tokens: 30, output_credits_per_million_tokens: 60 })
  assert.equal(rate.basis, 'rate')
  assert.equal(rate.text, '30 credits / 1M input tokens · 60 credits / 1M output tokens')
})

test('formatUsd never rounds a stated price away', () => {
  assert.equal(formatUsd(2), '$2.00')
  assert.equal(formatUsd(0.075), '$0.075')
  assert.equal(formatUsd(0.0027754454), '$0.0027754454')
  assert.equal(formatUsd(0), '$0.00')
})

test('a job shows its cost only when the provider stated it', () => {
  assert.equal(describeJobCostUsd({ cost_usd: 0.0027754454, cost_source: 'provider' }), '$0.0027754454 provider cost')
  assert.equal(describeJobCostUsd({ cost_usd: 0, cost_source: 'provider' }), '$0.00 provider cost')
  assert.equal(describeJobCostUsd({}), '')
  assert.equal(describeJobCostUsd({ cost_usd: 1 }), '')
})

// ── The Run Batch estimate ─────────────────────────────────────────────

const image = (per_image: number) => ({ price_source: 'provider' as const, price_usd: { per_image }, price_as_of: '2026-09-30T00:00:00Z' })
const step = (over: Partial<EstimateStep> & Pick<EstimateStep, 'id'>): EstimateStep => ({
  label: over.id, model: null, unit: 'per_image', quantity: null, unitNote: 'note', ...over,
})

test('estimate = unit price × units, summed across paid steps', () => {
  const estimate = estimateBatchUsd([
    step({ id: 'scene_review', model: image(0.04), quantity: 30 }),
    step({ id: 'motion_review', model: { price_source: 'provider', price_usd: { per_video: 0.5 } }, unit: 'per_video', quantity: 4 }),
  ])
  assert.equal(estimate.totalUsd, 0.04 * 30 + 0.5 * 4)
  assert.deepEqual(estimate.priced.map(line => line.detail), ['$0.04 × 30 image', '$0.50 × 4 video'])
  assert.equal(estimate.notIncluded.length, 0)
})

test('local steps are free and add nothing', () => {
  const estimate = estimateBatchUsd([
    step({ id: 'scene_review', model: { price_source: 'local', price_usd: { per_image: 0 } }, quantity: 30 }),
    step({ id: 'audio', model: { price_source: 'local', price_usd: { per_1k_chars: 0 } }, unit: 'per_1k_chars', quantity: null }),
    step({ id: 'metadata', model: { price_source: 'local', price_usd: null }, unit: undefined, quantity: null }),
  ])
  assert.equal(estimate.totalUsd, 0)
  assert.deepEqual(estimate.free.map(line => line.id), ['scene_review', 'audio', 'metadata'])
  assert.equal(estimate.notIncluded.length, 0)
})

test('unpublished, unmappable, unknown-quantity and unresolved steps are listed as not included, never guessed', () => {
  const estimate = estimateBatchUsd([
    step({ id: 'thumb_images', model: { price_source: 'unpublished', price_usd: null }, quantity: 5 }),
    step({ id: 'motion_review', model: { price_source: 'provider', price_usd: { per_second: 0.1 } }, unit: 'per_video', quantity: 4 }),
    step({ id: 'scene_review', model: image(0.04), quantity: null, unitNote: 'scene count unknown' }),
    step({ id: 'script-only', model: { price_source: 'provider', price_usd: { input_per_1m_tokens: 1, output_per_1m_tokens: 2 } }, unit: undefined, unitNote: 'priced per token' }),
    step({ id: 'audio', model: null }),
    step({ id: 'metadata', model: image(0.04), quantity: 3, modelOverride: 'model policy' }),
    step({ id: 'research', model: {} }),
  ])
  assert.equal(estimate.totalUsd, 0)
  assert.equal(estimate.priced.length, 0)
  const why = Object.fromEntries(estimate.notIncluded.map(line => [line.id, line.reason]))
  assert.equal(why.thumb_images, 'price not published')
  assert.match(why.motion_review!, /prices this model differently \(per_second\)/)
  assert.equal(why.scene_review, 'scene count unknown')
  assert.equal(why['script-only'], 'priced per token')
  assert.match(why.audio!, /no price from the gateway/)
  assert.equal(why.metadata, 'model policy')
  assert.match(why.research!, /no price from the gateway/)
})

test('a priced step and a not-included step in one batch: only the priced one is summed', () => {
  const estimate = estimateBatchUsd([
    step({ id: 'scene_review', model: image(0.25), quantity: 8 }),
    step({ id: 'thumb_images', model: image(0.25), quantity: null, unitNote: 'thumbnail count unknown' }),
  ])
  assert.equal(estimate.totalUsd, 2)
  assert.equal(estimate.notIncluded.length, 1)
})

test('quantities are only what Story Studio knows: scenes still to render, one clip per scene', () => {
  const eps = [{ scenesTotal: 40, scenesPresent: 10 }, { scenesTotal: 30, scenesPresent: 30 }]
  assert.equal(stepQuantity('scene_review', eps, false), 30)
  assert.equal(stepQuantity('scene_review', eps, true), 70, 'Force re-run redoes every scene')
  assert.equal(stepQuantity('motion_review', eps, false), 70)
  assert.equal(stepQuantity('scene_review', [...eps, { scenesTotal: 0, scenesPresent: 0 }], false), null, 'no scene plan yet: unknown, not 0')
  assert.equal(stepQuantity('thumb_images', eps, false), null)
  assert.equal(stepQuantity('audio', eps, false), null)
})

test('every paid step is mapped and no chat step claims a per-unit quantity', () => {
  for (const id of ['research', 'script-only', 'introduction-only', 'image_prompts', 'metadata', 'scene_plan', 'contextual_cues']) {
    assert.equal(ESTIMATE_STEPS[id]?.catalog, 'chat')
    assert.equal(ESTIMATE_STEPS[id]?.unit, undefined)
  }
  assert.equal(ESTIMATE_STEPS.scene_review?.unit, 'per_image')
  assert.equal(ESTIMATE_STEPS.motion_review?.unit, 'per_video')
})

test('the pipeline dialog is wired to the estimate and labels it an estimate', () => {
  const page = readFileSync(new URL('../pages/projects/[slug]/pipeline.vue', import.meta.url), 'utf8')
  assert.match(page, /estimateBatchUsd\(steps\)/)
  assert.match(page, /data-testid="batch-estimate"/)
  assert.match(page, /Estimated provider cost/)
  assert.match(page, /not included — /)
})

// ── Pricing-page prices (gateway 0.2.83) ───────────────────────────────

const PAGE = { price_source: 'provider_page' as const, price_as_of: '2026-09-29T00:00:00+00:00', price_url: 'https://provider.example/pricing' }

test('a pricing-page price says where it came from, links the page, and lists variants without picking one', () => {
  const single = describeImageUnitCost({ ...ZERO_SHAPES, ...PAGE, price_usd: { per_image: 0.04 } }, null)
  assert.equal(single.basis, 'provider-page')
  assert.equal(single.text, '$0.04 / image · from pricing page, 2026-09-29')
  assert.equal(single.url, 'https://provider.example/pricing')
  assert.equal(single.variants, undefined)

  const varies = describeImageUnitCost({
    ...ZERO_SHAPES, ...PAGE, price_usd: {},
    price_variants: [{ unit: 'per_image', usd: 0.04, variant: '1K' }, { unit: 'per_image', usd: 0.08, variant: '2K' }],
  }, null)
  assert.equal(varies.text, 'Price varies · from pricing page, 2026-09-29')
  assert.deepEqual(varies.variants, ['$0.04 / image — 1K', '$0.08 / image — 2K'])
  assert.doesNotMatch(varies.text, /^\$/)
})

test('a pricing-page link that is not http(s) is never offered', () => {
  const shown = describeUsdPrice({ price_source: 'provider_page', price_usd: { per_image: 1 }, price_url: 'javascript:alert(1)' })
  assert.equal(shown?.url, undefined)
})

test('the estimate may use a pricing-page price, but a unit that only exists as variants is not included', () => {
  const page = { ...PAGE, price_usd: { per_image: 0.04 } }
  const estimate = estimateBatchUsd([
    step({ id: 'scene_review', model: page, quantity: 10 }),
    step({ id: 'thumb_images', quantity: 5, model: { ...PAGE, price_usd: {}, price_variants: [
      { unit: 'per_image', usd: 0.04, variant: '1K' }, { unit: 'per_image', usd: 0.08, variant: '2K' }] } }),
  ])
  assert.equal(estimate.totalUsd, 0.04 * 10)
  assert.match(estimate.priced[0]!.detail, /from the provider’s pricing page/)
  assert.deepEqual(estimate.notIncluded.map(line => line.id), ['thumb_images'])
  assert.match(estimate.notIncluded[0]!.reason, /price varies: see variants \(1K, 2K\)/)
})

test('a page row with no single number lists its variants verbatim — never $0, never "not published"', () => {
  const shown = describeChatRate({
    ...ZERO_SHAPES, ...PAGE, price_usd: {},
    price_variants: [
      { unit: 'other', variant: 'text-to-speech', unit_text: '$15.00 / M UTF-8 bytes' },
      { unit: 'other', variant: 'free tier', unit_text: 'Free of charge' },
      { unit: 'input_per_1m_tokens', variant: 'peak', usd: 0.5 },
    ],
  })
  assert.equal(shown.basis, 'provider-page')
  assert.equal(shown.text, 'Price varies · from pricing page, 2026-09-29')
  assert.deepEqual(shown.variants, ['$15.00 / M UTF-8 bytes — text-to-speech', 'Free of charge — free tier', '$0.50 / 1M input tokens — peak'])
  assert.doesNotMatch(shown.text, /\$0|not published/)
})

test('variants already stated as a single number in price_usd are not listed twice', () => {
  const shown = describeImageUnitCost({
    ...ZERO_SHAPES, ...PAGE, price_usd: { per_image: 0.04 },
    price_variants: [{ unit: 'per_image', variant: 'all sizes', usd: 0.04 }],
  }, null)
  assert.equal(shown.text, '$0.04 / image · from pricing page, 2026-09-29')
  assert.equal(shown.variants, undefined)
})

test('a step whose row only has variants is not included: price varies', () => {
  const estimate = estimateBatchUsd([
    step({ id: 'script-only', unit: undefined, quantity: null, unitNote: 'priced per token',
      model: { ...PAGE, price_usd: {}, price_variants: [{ unit: 'other', variant: 'free tier', unit_text: 'Free of charge' }] } }),
  ])
  assert.equal(estimate.totalUsd, 0)
  assert.equal(estimate.free.length, 0)
  assert.equal(estimate.notIncluded[0]!.reason, 'price varies: see variants (free tier)')
})
