/**
 * LIVE per-model token limits.
 *
 * GenStudio publishes each product's own `context_window_tokens` and
 * `max_output_tokens`. Story Studio must read them and hold none of its own:
 * no 200K context, no 32K output ceiling, no 500,000-character cap, and no
 * limit inferred from a model NAME.
 *
 * THE BUGS THIS GUARDS
 * --------------------
 *  1. The catalogue read `context_limit_tokens`, GenStudio's deprecated alias.
 *     New code must prefer `context_window_tokens` and use the alias only when
 *     the current field is absent (an older GenStudio release).
 *  2. Scene Plan offered a FIXED option set topping out at 32,768 and clamped
 *     every request with `Math.min(32_768, …)`, so a product publishing
 *     128,000 could not be used past a quarter of its allowance.
 *  3. The prose wrapper schema carried `maxLength: 500_000` — and that schema
 *     was sent to the provider as a strict schema, so it constrained generation.
 *     At ~4 characters per token a 128,000-token allowance already passes
 *     500,000 characters, and characters-per-token differs by language anyway.
 *     The schema is now GONE rather than merely uncapped: a prose contract
 *     requests `{ type: 'text' }` and sends no schema and no wrapper at all.
 *     `genstudio-product-bridge` pins that, which is a strictly stronger guard
 *     than asserting the absence of one field on a schema still being sent.
 *
 * ZERO paid calls: every catalogue and envelope below is a hand-written
 * fixture. Nothing here touches GenStudio.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { listChatModels, clearGenStudioCatalogCache } from '../lib/genstudio-client.js'
import {
  availableInputTokens,
  parseScenePromptTokenSetting,
  resolveScenePromptTokenBudget,
  scenePromptTokenOptions,
} from '../services/scene-prompt-batching.js'
import {
  describeWebResearchAvailability,
  toWebResearchModelOption,
} from '../services/research/web-capability.js'
import type { GenStudioChatModel } from '../lib/genstudio-client.js'

/** The client caches per API key, so each fixture read needs its own key. */
let keySeq = 0

/** Read one hand-written `/v1/chat/models` payload through the real client. */
async function readCatalog(entries: Array<Record<string, unknown>>): Promise<GenStudioChatModel[]> {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async (input) => {
      const url = String(input)
      if (url.endsWith('/v1/chat/models')) return Response.json(entries)
      throw new Error(`unexpected fetch in fixture: ${url}`)
    }
    keySeq += 1
    return await listChatModels(`live-limits-key-${keySeq}`)
  } finally {
    globalThis.fetch = originalFetch
    clearGenStudioCatalogCache()
  }
}

function chatEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'writer-alpha',
    display_name: 'Writer Alpha',
    available: true,
    qualification_only: false,
    max_output_tokens: 128_000,
    controls: ['temperature', 'max_output_tokens'],
    activation_blockers: [],
    structured_output_mode: 'json_object',
    supports_structured_output: true,
    ...overrides,
  }
}

// ── 1. context_window_tokens is preferred; the alias is only a fallback ────

test('context_window_tokens is the field read from the catalogue', async () => {
  const [model] = await readCatalog([chatEntry({ context_window_tokens: 1_050_000 })])
  assert.equal(model?.context_window_tokens, 1_050_000)
})

test('the deprecated context_limit_tokens alias is used ONLY when the new field is absent', async () => {
  const [older] = await readCatalog([chatEntry({ context_limit_tokens: 200_000 })])
  assert.equal(older?.context_window_tokens, 200_000, 'an older GenStudio must still be readable')

  // Both published and disagreeing: the CURRENT field wins. If the alias could
  // override it, a newer GenStudio would be silently downgraded to a legacy
  // number it no longer publishes as authoritative.
  const [both] = await readCatalog([
    chatEntry({ context_window_tokens: 1_050_000, context_limit_tokens: 200_000 }),
  ])
  assert.equal(both?.context_window_tokens, 1_050_000)
})

test('an unpublished context window reads as 0 — "unknown", never a Story Studio guess', async () => {
  const [model] = await readCatalog([chatEntry({})])
  assert.equal(model?.context_window_tokens, 0)
})

// ── 2. The output selector's maximum is the model's max_output_tokens ──────

test('the output option list derives from the model and always offers its exact maximum', () => {
  const big = scenePromptTokenOptions(128_000)
  assert.equal(big.at(-1), 128_000, 'the product maximum is always selectable')
  assert.ok(big.some(option => option > 32_768), 'a 128,000-token product must offer beyond 32,768')
  assert.ok(big.includes(65_536))

  const small = scenePromptTokenOptions(32_768)
  assert.equal(small.at(-1), 32_768)
  assert.ok(!small.some(option => option > 32_768), 'a 32,768-token product must offer nothing larger')
  // The historical ladder is preserved for a product that still publishes it.
  assert.deepEqual(small, [4096, 6144, 8192, 12288, 16384, 24576, 32768])
})

test('a tiny product is offered exactly what it publishes, not a ladder floor', () => {
  assert.deepEqual(scenePromptTokenOptions(2_048), [2_048])
})

test('the option list carries no fixed ceiling — a larger product simply offers more', () => {
  const huge = scenePromptTokenOptions(1_000_000)
  assert.equal(huge.at(-1), 1_000_000)
  assert.ok(huge.length > scenePromptTokenOptions(128_000).length)
})

// ── An over-large selection clamps to the newly selected model ─────────────

test('an over-large allowance clamps DOWN to what the selected model publishes', () => {
  // Chosen on a 128,000-token product, then the user switches to a 32,768 one.
  assert.equal(resolveScenePromptTokenBudget(32_768, 128_000), 32_768)
  // And is untouched when it still fits.
  assert.equal(resolveScenePromptTokenBudget(128_000, 65_536), 65_536)
})

test('auto means THIS product\'s maximum, with no 32,768 ceiling in the way', () => {
  assert.equal(resolveScenePromptTokenBudget(128_000, 'auto'), 128_000)
  assert.equal(resolveScenePromptTokenBudget(32_768, 'auto'), 32_768)
})

test('any positive allowance parses; legality belongs to the selected product', () => {
  assert.equal(parseScenePromptTokenSetting(65_536), 65_536)
  assert.equal(parseScenePromptTokenSetting(128_000), 128_000)
  assert.equal(parseScenePromptTokenSetting('auto'), 'auto')
  assert.equal(parseScenePromptTokenSetting(undefined), 'auto')
  assert.equal(parseScenePromptTokenSetting(0), 'auto')
  assert.equal(parseScenePromptTokenSetting(-5), 'auto')
  assert.equal(parseScenePromptTokenSetting('nonsense'), 'auto')
})

// ── 3. available_input_tokens = max(0, context_window - selected_output) ───

test('available input budget is the published difference, floored at zero', () => {
  assert.equal(availableInputTokens(1_050_000, 128_000), 922_000)
  assert.equal(availableInputTokens(1_048_576, 65_536), 983_040)
  // The floor: a pathological catalogue must never produce a negative budget.
  assert.equal(availableInputTokens(8_192, 32_768), 0)
  assert.equal(availableInputTokens(32_768, 32_768), 0)
})

test('an unpublished context window yields no budget claim at all', () => {
  assert.equal(availableInputTokens(0, 32_768), 0)
  assert.equal(availableInputTokens(null, 32_768), 0)
})

// ── 4. Both published web-research rates surface ──────────────────────────

function webModel(overrides: Partial<GenStudioChatModel> = {}): GenStudioChatModel {
  return {
    id: 'gs-research-1',
    display_name: 'Research Product 1',
    available: true,
    qualification_only: false,
    discount: false,
    discount_disclaimer: null,
    // The shelf a product sells on. `direct` here so this fixture is the
    // ordinary, undivided catalogue every other assertion in this file assumes.
    queue_class: 'direct',
    relaxed_queue_hint: null,
    standard_input_credits_per_million_tokens: null,
    standard_output_credits_per_million_tokens: null,
    // Added when v1.4.71 made the deprecation-window fields required on
    // GenStudioChatModel without updating this fixture — the electron
    // typecheck has been red on `main` since that release. Unrelated to the
    // change this branch makes; fixed here only so the gate is usable.
    deprecation_warning: false,
    deprecation_warning_at: null,
    scheduled_retirement_at: null,
    upstream_shutdown_at: null,
    retires_at: null,
    replacement_model_id: null,
    context_window_tokens: 128_000,
    max_output_tokens: 8_192,
    // These fixtures are catalogue rows built by hand, not parsed ones, so they state
    // the absence explicitly rather than omitting a required field.
    max_output_tokens_source: null,
    max_structured_items_per_request: null,
    controls: [],
    activation_blockers: [],
    input_credits_per_million_tokens: 100,
    output_credits_per_million_tokens: 300,
    minimum_credits: 1,
    price_version: 'v1',
    input_modalities: ['text'],
    supports_vision: false,
    max_input_images: 0,
    accepted_image_mime_types: [],
    max_image_bytes: 0,
    max_image_dimension: 0,
    supported_detail_levels: [],
    supports_structured_output: true,
    structured_output_mode: 'json_object',
    supports_web_search: true,
    returns_citations: true,
    citation_format: 'structured',
    supports_domain_filters: false,
    research_qualified: true,
    supports_claim_attribution: true,
    web_search_credits_per_search: 5,
    web_research_credits_per_request: 20,
    max_web_searches: null,
    ...overrides,
  }
}

test('the catalogue reads BOTH published web-research rates', async () => {
  const [model] = await readCatalog([chatEntry({
    web_search_credits_per_search: 5,
    web_research_credits_per_request: 20,
  })])
  assert.equal(model?.web_search_credits_per_search, 5)
  assert.equal(model?.web_research_credits_per_request, 20)
})

test('an unpublished per-request rate stays null rather than becoming zero', async () => {
  const [model] = await readCatalog([chatEntry({ web_search_credits_per_search: 5 })])
  assert.equal(model?.web_research_credits_per_request, null)
})

test('the web-research disclosure surfaces the per-request rate alongside the per-search one', () => {
  const option = toWebResearchModelOption(webModel())
  assert.equal(option.credits_per_search, 5)
  assert.equal(option.credits_per_request, 20)
  // The picker shows the model's published research facts, so `returns_citations`
  // travels with the rates rather than being inferred from the model's presence
  // in a list that happens to filter on it.
  assert.equal(option.returns_citations, true)
  assert.equal(toWebResearchModelOption(webModel({ returns_citations: false })).returns_citations, false)

  const availability = describeWebResearchAvailability([webModel()])
  assert.equal(availability.available, true)
  assert.equal(availability.models[0]!.credits_per_request, 20)
})
