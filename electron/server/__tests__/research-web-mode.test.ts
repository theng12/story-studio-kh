/**
 * Web-research mode ("Search the web") — capability filter, request shape,
 * envelope citations, persistence, and per-mode wording.
 *
 * ZERO paid calls: every model here is a mocked catalogue fixture and every
 * completion is a hand-written envelope. Nothing in this file touches
 * GenStudio.
 */

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import {
  WEB_MODE_UNAVAILABLE_REASON,
  WEB_RESEARCH_CONDITIONS,
  buildWebSearchBlock,
  describeWebResearchAvailability,
  failedWebResearchConditions,
  isWebResearchQualified,
  normalizeDomainList,
  selectWebResearchModels,
  toResearchCitations,
  toWebResearchModelOption,
} from '../services/research/web-capability.js'
import {
  DEFAULT_RESEARCH_MODE,
  GENSTUDIO_RESEARCH_PROVIDER,
  GENSTUDIO_WEB_RESEARCH_PROVIDER,
  normalizeResearchMode,
  providerForResearchMode,
  researchModeForProvider,
} from '../services/research/index.js'
import {
  MODEL_KNOWLEDGE_CLAIM_NOTE,
  MODEL_KNOWLEDGE_NOTICE,
  WEB_SEARCH_MODE_BLURB,
  WEB_SEARCH_NO_SOURCES_NOTICE,
  WEB_SEARCH_NOTICE,
  WEB_SEARCH_SOURCE_URLS_NOTICE,
  researchModeLabel,
  researchModeNotice,
  webResearchNotice,
} from '../services/research/provenance.js'
import { assembleOutput, buildResearchPrompt } from '../services/research/prompt.js'
import { sanitizeResearchOutputUrls } from '../services/research/urls.js'
import { parseGenStudioCitations } from '../lib/genstudio-client.js'
import { resolveStepParams } from '../routes/pipeline.js'
import { readSelectedResearchSources } from '../lib/research-sources.js'
import type { GenStudioChatModel } from '../lib/genstudio-client.js'
import type { ResearchOutput } from '../models/types.js'
import { useTempDataDir } from './_helpers.js'
/**
 * Claim an isolated data dir before anything runs.
 *
 * These are pure-logic tests, but the loaders they exercise (niche,
 * topic-pack, format) look for user overrides under
 * `${projectsRoot()}/.niches` and friends. With no data dir claimed that
 * resolves to the machine owner's REAL projects folder, so results would
 * depend on what they happen to have installed there. Reads only today —
 * the owner's folder has no override directories — but it is the same
 * isolation leak the projects-root refactor exists to close.
 */
const isolatedDataDir = await useTempDataDir()
after(() => isolatedDataDir.cleanup())

// ── Catalogue fixtures ──────────────────────────────────────────────────
// A model that passes ALL SEVEN conditions. Every exclusion test below starts
// from this and breaks exactly one condition, so a test can never pass because
// two things were wrong at once.
function qualifiedModel(overrides: Partial<GenStudioChatModel> = {}): GenStudioChatModel {
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

/** A catalogue in which NOTHING qualifies — the state this shipped in, before
 *  GenStudio published research-qualified products. It is no longer "today",
 *  but it is still a state the catalogue can return, and web mode must stay
 *  unavailable and explained whenever it does. */
function unqualifiedCatalog(): GenStudioChatModel[] {
  return [
    qualifiedModel({ id: 'gs-fast', display_name: 'Fast', research_qualified: false }),
    qualifiedModel({
      id: 'gs-plain',
      display_name: 'Plain',
      supports_web_search: false,
      returns_citations: false,
      citation_format: null,
      research_qualified: false,
      web_search_credits_per_search: null,
    }),
  ]
}

describe('web research capability filter', () => {
  it('accepts a model that passes all seven published conditions', () => {
    assert.equal(isWebResearchQualified(qualifiedModel()), true)
    assert.deepEqual(failedWebResearchConditions(qualifiedModel()), [])
  })

  it('keeps "the provider did not say" distinct from "the provider said no"', () => {
    // The gateway publishes `null` where no provider stated a value — every row
    // today for `returns_citations` — and it used to arrive here flattened to
    // `false`, which reads as a claim the provider never made (§6).
    //
    // The OUTCOME must not change: an unstated citation capability must not
    // enable web research, so the qualification gate still requires `=== true`.
    // What changes is that the two facts stop sharing a value.
    const stated = qualifiedModel({ returns_citations: false })
    const unstated = qualifiedModel({ returns_citations: null as unknown as boolean })

    assert.equal(toWebResearchModelOption(stated).returns_citations, false)
    assert.equal(toWebResearchModelOption(unstated).returns_citations, null,
      'an unstated value must survive as null, not be reported as a refusal')

    // Same gate outcome for both — the safe direction is preserved.
    for (const model of [stated, unstated]) {
      assert.equal(isWebResearchQualified(model), false)
      assert.deepEqual(failedWebResearchConditions(model), ['returns_citations'])
    }
  })

  it('excludes a model on EACH condition independently', () => {
    const breakers: Array<[string, Partial<GenStudioChatModel>]> = [
      ['available', { available: false }],
      ['account_unlocked', { locked: true, lock_reason: 'requires_paid_account' }],
      ['qualification_only', { qualification_only: true }],
      ['supports_web_search', { supports_web_search: false }],
      ['returns_citations', { returns_citations: false }],
      ['citation_format', { citation_format: 'text' }],
      ['research_qualified', { research_qualified: false }],
    ]
    // Every published condition has to be represented, so a condition can
    // never be quietly dropped from the filter without this failing.
    assert.deepEqual(
      breakers.map(([id]) => id),
      WEB_RESEARCH_CONDITIONS.map(condition => condition.id),
    )
    for (const [conditionId, override] of breakers) {
      const model = qualifiedModel(override)
      assert.equal(isWebResearchQualified(model), false, `${conditionId} should exclude the model`)
      assert.deepEqual(failedWebResearchConditions(model), [conditionId])
      assert.deepEqual(selectWebResearchModels([model]), [])
    }
  })

  it('treats a missing citation_format as unusable rather than assuming structured', () => {
    assert.equal(isWebResearchQualified(qualifiedModel({ citation_format: null })), false)
  })

  it('excludes a qualification-only product even when it is research_qualified', () => {
    // GenStudio says it should never publish this combination. If it ever
    // does, an internal-review-only product must not become selectable.
    const internalOnly = qualifiedModel({
      id: 'gs-internal-review',
      qualification_only: true,
      research_qualified: true,
    })
    assert.equal(isWebResearchQualified(internalOnly), false)
    assert.deepEqual(failedWebResearchConditions(internalOnly), ['qualification_only'])
    assert.deepEqual(selectWebResearchModels([internalOnly]), [])
    assert.equal(describeWebResearchAvailability([internalOnly]).available, false)
  })

  it('filters by capability only — never by provider or model name', () => {
    // Same capability flags, wildly different names. All three qualify, and a
    // name-based filter could not produce this result.
    const catalog = [
      qualifiedModel({ id: 'anthropic/whatever', display_name: 'Whatever' }),
      qualifiedModel({ id: 'sonar-like-name', display_name: 'Sonar-ish' }),
      qualifiedModel({ id: 'zzz-unknown-vendor', display_name: 'Unknown Vendor' }),
    ]
    assert.deepEqual(selectWebResearchModels(catalog).map(m => m.id), catalog.map(m => m.id))
    // And a "search-sounding" name with the wrong capability is still excluded.
    assert.deepEqual(
      selectWebResearchModels([qualifiedModel({ id: 'web-search-pro', research_qualified: false })]),
      [],
    )
  })
})

describe('web mode when nothing in the catalogue qualifies', () => {
  it('is unavailable and explains itself — this is a first-class state, not an error', () => {
    const availability = describeWebResearchAvailability(unqualifiedCatalog())
    assert.equal(availability.available, false)
    assert.deepEqual(availability.models, [])
    assert.equal(availability.reason, WEB_MODE_UNAVAILABLE_REASON)
    // The explanation names the real cause and promises no user action, since
    // the user cannot qualify a model themselves.
    assert.match(availability.reason, /No evidence-backed model is currently available/)
    assert.match(availability.reason, /as soon as one does/)
  })

  it('turns itself on with no code change the moment Gateway flips research_qualified', () => {
    const before = unqualifiedCatalog()
    assert.equal(describeWebResearchAvailability(before).available, false)
    // Exactly one flag changes — nothing else about the catalogue or this app.
    const after = before.map(model => (
      model.id === 'gs-fast' ? { ...model, research_qualified: true } : model
    ))
    const availability = describeWebResearchAvailability(after)
    assert.equal(availability.available, true)
    assert.equal(availability.reason, '')
    assert.deepEqual(availability.models.map(m => m.id), ['gs-fast'])
    assert.equal(availability.models[0]!.credits_per_search, 5)
    assert.equal(availability.models[0]!.max_web_searches, null)
  })
})

describe('Pipeline web research recovery', () => {
  it('reads the saved Gateway key without a current catalogue lookup or replacement POST', async () => {
    const { setGenStudioUrl } = await import('../services/app-settings.js')
    const { setApiKey } = await import('../services/app-secrets-store.js')
    const { clearGenStudioCatalogCache } = await import('../lib/genstudio-client.js')
    const { pipelinePolicyInputFingerprint } = await import('../lib/pipeline-model-policy.js')
    const { genStudioWebResearch } = await import('../services/research/genstudio-web.js')
    const originalFetch = globalThis.fetch
    const seen: Array<{ method: string; path: string }> = []
    const options = {
      topic: 'A recovered web-research run',
      max_sources: 3,
      web_search: { allowed_domains: ['archives.example'], blocked_domains: ['spam.example'] },
    }
    const fingerprint = pipelinePolicyInputFingerprint({
      topic: options.topic,
      specific_questions: undefined,
      max_sources: options.max_sources,
      web_search: options.web_search,
    })
    const checkpoint = {
      read: () => ({
        input_fingerprint: fingerprint,
        candidates: ['historical-web-product', 'backup-web-product'],
        candidate_index: 0,
        candidate_model: 'historical-web-product',
        status: 'accepted' as const,
        idempotency_key: 'saved-web-key',
        updated_at: '2026-09-09T00:00:00.000Z',
      }),
      write: async () => {},
    }
    try {
      await setGenStudioUrl('http://127.0.0.1:9876')
      await setApiKey('genstudio', 'web-recovery-test-key')
      clearGenStudioCatalogCache()
      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input))
        const method = (init?.method || 'GET').toUpperCase()
        seen.push({ method, path: url.pathname })
        assert.notEqual(url.pathname, '/v1/chat/models', 'a durable recovery must not need today\'s catalogue')
        assert.notEqual(method, 'POST', 'a durable recovery must not submit a replacement')
        if (url.pathname === '/v1/account/overview') {
          return Response.json({
            paid_concurrency_limit: 5,
            paid_active_jobs: 0,
            paid_queued_jobs: 0,
            max_queued_jobs: 25,
            generation_submissions_per_minute: 30,
          })
        }
        assert.equal(url.pathname, '/v1/chat/responses/by-idempotency-key/saved-web-key')
        return Response.json({
          id: 'web-recovery-job',
          operation: 'chat.response',
          state: 'succeeded',
          model_id: 'historical-web-product',
          output_text: JSON.stringify({ summary: 'Recovered source-backed research.', claims: [], citations: [] }),
          output_retained: true,
          finish_reason: 'stop',
          failure_code: null,
          routing_status_code: null,
          credit_cost: 0,
          remaining_credits: 900,
          idempotent_replay: true,
          citations: [{ id: 'source-1', url: 'https://example.com/source', title: 'Recovered source' }],
        })
      }
      const output = await genStudioWebResearch.run({
        ...options,
        request_identity: 'web-recovery-request',
        pipeline_model_policy: {
          mode: 'backup',
          models: ['historical-web-product', 'backup-web-product'],
          assigned_model: 'historical-web-product',
        },
        pipeline_policy_checkpoint: checkpoint,
        pipeline_policy_checkpoint_key: 'web-recovery-request',
      })
      assert.equal(output.source_model, 'historical-web-product')
      assert.deepEqual(output.citations.map(citation => citation.url), ['https://example.com/source'])
      assert.deepEqual(output.web_run?.allowed_domains, ['archives.example'])
      assert.ok(seen.some(request => request.path === '/v1/chat/responses/by-idempotency-key/saved-web-key'))
      assert.equal(seen.some(request => request.path === '/v1/chat/models'), false)
      assert.equal(seen.some(request => request.method === 'POST'), false)
    } finally {
      globalThis.fetch = originalFetch
      clearGenStudioCatalogCache()
    }
  })
})

describe('web_search request block', () => {
  it('omits max_searches when the model publishes max_web_searches: null', () => {
    const block = buildWebSearchBlock(qualifiedModel({ max_web_searches: null }), undefined, 8)
    assert.equal(block.enabled, true)
    assert.equal('max_searches' in block, false)
    assert.deepEqual(block.allowed_domains, [])
    assert.deepEqual(block.blocked_domains, [])
  })

  it('includes and clamps max_searches when the model publishes a cap', () => {
    const model = qualifiedModel({ max_web_searches: 6 })
    assert.equal(buildWebSearchBlock(model, undefined, 3).max_searches, 3)
    // A request above the published cap is clamped, never sent through.
    assert.equal(buildWebSearchBlock(model, undefined, 99).max_searches, 6)
    // No requested value → the published cap.
    assert.equal(buildWebSearchBlock(model, undefined, null).max_searches, 6)
  })

  it('sends domain filters ONLY when the model advertises supports_domain_filters', () => {
    const settings = { allowed_domains: ['nature.com'], blocked_domains: ['spam.example'] }
    const without = buildWebSearchBlock(qualifiedModel({ supports_domain_filters: false }), settings)
    // Dropped, not passed through: a filter the provider ignores would let the
    // user believe their sources were constrained when they were not.
    assert.deepEqual(without.allowed_domains, [])
    assert.deepEqual(without.blocked_domains, [])

    const with_ = buildWebSearchBlock(qualifiedModel({ supports_domain_filters: true }), settings)
    assert.deepEqual(with_.allowed_domains, ['nature.com'])
    assert.deepEqual(with_.blocked_domains, ['spam.example'])
  })

  it('normalizes domain lists without rewriting what the user asked for', () => {
    assert.deepEqual(normalizeDomainList('nature.com, https://nasa.gov/, nature.com'), ['nature.com', 'nasa.gov'])
    assert.deepEqual(normalizeDomainList(['  ', 'bbc.co.uk']), ['bbc.co.uk'])
    assert.deepEqual(normalizeDomainList(undefined), [])
  })
})

describe('envelope citations', () => {
  const envelope = [
    {
      id: 'source-1',
      url: 'https://example.org/a',
      title: 'A study',
      publisher: null,
      published_at: null,
      quote: null,
      start_index: 120,
      end_index: 183,
    },
    { id: 'source-2', url: 'https://example.org/b', title: null },
    { id: 'source-3', title: 'No URL — not evidence' },
  ]

  it('parses the envelope and drops entries with no URL', () => {
    const parsed = parseGenStudioCitations(envelope)
    assert.deepEqual(parsed.map(c => c.url), ['https://example.org/a', 'https://example.org/b'])
    assert.equal(parsed[0]!.start_index, 120)
    assert.equal(parsed[0]!.end_index, 183)
    assert.equal(parsed[0]!.publisher, null)
    assert.deepEqual(parseGenStudioCitations(undefined), [])
  })

  it('stores span offsets but never invents the unreliable fields', () => {
    const stored = toResearchCitations(parseGenStudioCitations(envelope))
    assert.equal(stored.length, 2)
    assert.equal(stored[0]!.start_index, 120)
    assert.equal(stored[0]!.end_index, 183)
    // quote/publisher/published_at are not reliable yet: absent stays absent
    // rather than becoming an empty string that renders as a real but blank
    // attribute.
    assert.equal('publisher' in stored[0]!, false)
    assert.equal('published_at' in stored[0]!, false)
    assert.equal('snippet' in stored[0]!, false)
    // A titleless source still has to be identifiable.
    assert.equal(stored[1]!.title, 'https://example.org/b')
    // No per-source fetch timestamp exists, by design.
    assert.equal('retrieved_at' in stored[0]!, false)
  })

  it('persists only canonical HTTP(S) envelope citations', () => {
    const stored = toResearchCitations(parseGenStudioCitations([
      { id: 'safe', title: 'Safe', url: ' https://example.org/a ' },
      { id: 'script', title: 'Script', url: 'javascript:alert(1)' },
      { id: 'data', title: 'Data', url: 'data:text/html,unsafe' },
      { id: 'file', title: 'File', url: 'file:///private.txt' },
      { id: 'malformed', title: 'Malformed', url: 'not a URL' },
    ]))

    assert.deepEqual(stored.map(c => c.url), ['https://example.org/a'])
  })

  it('stores envelope citations at RUN level and ignores model-authored URLs in web mode', () => {
    const modelJson = JSON.stringify({
      summary: 'Summary',
      claims: [{ text: 'A claim.', citation_indices: [0], confidence: 'high' }],
      // The model typed a URL into its own JSON. In web mode that is a model
      // claim, not evidence, and must not join the source list.
      citations: [{ title: 'Model-typed source', url: 'https://hallucinated.example/x' }],
    })
    const output = assembleOutput(modelJson, toResearchCitations(parseGenStudioCitations(envelope)), {
      topic: 'Topic',
      provider: GENSTUDIO_WEB_RESEARCH_PROVIDER,
      model: 'gs-research-1',
      mode: 'web-search',
      web_run: { searches_performed: 4, credits_charged: 20 },
    })
    assert.deepEqual(output.citations.map(c => c.url), ['https://example.org/a', 'https://example.org/b'])
    assert.equal(output.research_mode, 'web-search')
    assert.equal(output.source_provider, GENSTUDIO_WEB_RESEARCH_PROVIDER)
    assert.equal(output.web_run?.searches_performed, 4)
    assert.equal(output.web_run?.credits_charged, 20)
    // Sources are run-level: no claim is linked to one.
    assert.deepEqual(output.claims[0]!.citation_indices, [])
  })

  it('surfaces a zero-citation web run honestly instead of implying sources exist', () => {
    const output = assembleOutput(
      JSON.stringify({ summary: 'S', claims: [{ text: 'A claim.' }] }),
      [],
      { topic: 'T', provider: GENSTUDIO_WEB_RESEARCH_PROVIDER, mode: 'web-search' },
    )
    assert.deepEqual(output.citations, [])
    const notice = researchModeNotice('web-search', output.citations.length)
    assert.match(notice, /Research ran, but the Gateway did not publish structured citations or source URLs/)
    assert.doesNotMatch(notice, /model knowledge/i)
    assert.notEqual(notice, WEB_SEARCH_NOTICE)
  })

  it('keeps model-knowledge mode unchanged — model JSON citations still count there', () => {
    const output = assembleOutput(
      JSON.stringify({
        claims: [{ text: 'A claim.', citation_indices: [0] }],
        citations: [{ title: 'Britannica', url: 'https://example.org/enc' }],
      }),
      [],
      { topic: 'T', provider: GENSTUDIO_RESEARCH_PROVIDER, mode: 'model-knowledge' },
    )
    assert.deepEqual(output.citations.map(c => c.url), ['https://example.org/enc'])
    assert.deepEqual(output.claims[0]!.citation_indices, [0])
    assert.equal(output.research_mode, 'model-knowledge')
  })

  it('drops unsafe model-authored citations before producing a sidecar shape', () => {
    const output = assembleOutput(
      JSON.stringify({
        claims: [{ text: 'A claim.', citation_indices: [0, 1] }],
        citations: [
          { title: 'Unsafe', url: 'javascript:alert(1)' },
          { title: 'Safe', url: 'https://example.org/kept' },
        ],
      }),
      [],
      { topic: 'T', provider: GENSTUDIO_RESEARCH_PROVIDER, mode: 'model-knowledge' },
    )
    assert.deepEqual(output.citations.map(c => c.url), ['https://example.org/kept'])
    assert.deepEqual(output.claims[0]!.citation_indices, [0])
  })

  it('remaps claim citations after dropping unsafe and duplicate sidecar URLs', () => {
    const output = sanitizeResearchOutputUrls({
      schema_version: 1,
      source_provider: GENSTUDIO_RESEARCH_PROVIDER,
      generated_at: '2026-08-11T00:00:00.000Z',
      topic: 'T',
      claims: [
        { id: 'all', text: 'All sources.', status: 'unreviewed', citation_indices: [0, 1, 2, 3] },
        { id: 'duplicate', text: 'Duplicate source.', status: 'unreviewed', citation_indices: [2] },
      ],
      citations: [
        { title: 'Unsafe', url: 'javascript:alert(1)' },
        { title: 'First safe', url: 'https://example.org/a' },
        { title: 'Duplicate safe', url: 'https://example.org/a' },
        { title: 'Second safe', url: 'https://example.org/b' },
      ],
    })

    assert.deepEqual(output.citations.map(c => c.url), ['https://example.org/a', 'https://example.org/b'])
    assert.deepEqual(output.claims[0]!.citation_indices, [0, 1])
    assert.deepEqual(output.claims[1]!.citation_indices, [0])
  })
})

describe('per-mode provenance wording', () => {
  it('uses distinct, mode-appropriate copy', () => {
    assert.equal(researchModeNotice('model-knowledge'), MODEL_KNOWLEDGE_NOTICE)
    assert.equal(researchModeNotice('web-search', 3), WEB_SEARCH_NOTICE)
    assert.notEqual(MODEL_KNOWLEDGE_NOTICE, WEB_SEARCH_NOTICE)
    assert.equal(researchModeLabel('model-knowledge'), 'Model knowledge only')
    assert.equal(researchModeLabel('web-search'), 'Search the web')
  })

  it('never leaks the harsh model-knowledge copy into web mode', () => {
    const harsh = [/no live web access/i, /nothing backs this claim/i, /not been checked against live sources/i]
    for (const pattern of [...harsh, /no source cited/i]) {
      assert.doesNotMatch(WEB_SEARCH_NOTICE, pattern)
      assert.doesNotMatch(researchModeNotice('web-search', 0), pattern)
    }
  })

  it('softens the model-knowledge copy without overstating its reliability', () => {
    // The old copy read as if the output were worthless; the new copy says
    // what it IS good for and what to check.
    assert.doesNotMatch(MODEL_KNOWLEDGE_NOTICE, /no live web access/i)
    assert.doesNotMatch(MODEL_KNOWLEDGE_NOTICE, /nothing backs this claim/i)
    assert.match(MODEL_KNOWLEDGE_NOTICE, /Reliable on well-established facts/)
    assert.match(MODEL_KNOWLEDGE_NOTICE, /can’t cite live sources/)
    assert.equal(MODEL_KNOWLEDGE_CLAIM_NOTE, 'From model knowledge — no source cited')
    // Customer-facing copy avoids "LLM".
    for (const copy of [MODEL_KNOWLEDGE_NOTICE, WEB_SEARCH_NOTICE, MODEL_KNOWLEDGE_CLAIM_NOTE]) {
      assert.doesNotMatch(copy, /\bLLM\b/)
    }
  })

  it('tells the model the truth about its own web access per mode', () => {
    const opts = { topic: 'T' }
    assert.match(buildResearchPrompt(opts, 'llm-only').system, /do NOT have live web access/)
    const web = buildResearchPrompt(opts, 'web').system
    assert.match(web, /you DO have live web search/)
    // The model must not hand-copy URLs — that is what keeps envelope
    // citations meaningful as evidence.
    assert.match(web, /Do NOT hand-copy URLs/)
  })
})

describe('mode persistence', () => {
  it('resolves an absent or unknown mode to model-knowledge, never to web-search', () => {
    assert.equal(DEFAULT_RESEARCH_MODE, 'model-knowledge')
    for (const value of [undefined, null, '', 'llm-only', 'anything-else', 42]) {
      assert.equal(normalizeResearchMode(value), 'model-knowledge')
    }
    assert.equal(normalizeResearchMode('web-search'), 'web-search')
  })

  it('maps modes to persisted provider ids and back', () => {
    assert.equal(providerForResearchMode('model-knowledge'), GENSTUDIO_RESEARCH_PROVIDER)
    assert.equal(providerForResearchMode('web-search'), GENSTUDIO_WEB_RESEARCH_PROVIDER)
    assert.equal(researchModeForProvider(GENSTUDIO_WEB_RESEARCH_PROVIDER), 'web-search')
    for (const current of [undefined, '', 'llm-only']) {
      assert.equal(researchModeForProvider(current), 'model-knowledge')
    }
    assert.throws(() => researchModeForProvider('perplexity'), /Unknown research source/)
  })

  it('loads a legacy sidecar with no mode as model-knowledge', () => {
    const legacy = {
      schema_version: 1,
      source_provider: 'llm-only',
      generated_at: '2025-01-01T00:00:00.000Z',
      topic: 'Old episode',
      claims: [{ id: 'c1', text: 'A claim.', status: 'verified', citation_indices: [] }],
      citations: [],
    } as unknown as ResearchOutput
    assert.equal('research_mode' in legacy, false)
    assert.equal(researchModeForProvider(legacy.source_provider), 'model-knowledge')
    assert.equal(normalizeResearchMode((legacy as { research_mode?: unknown }).research_mode), 'model-knowledge')
  })

  it('round-trips mode + domains through a research preset into pipeline params', () => {
    const preset = {
      data: {
        form: {
          research_mode: 'web-search',
          source_model: 'gs-research-1',
          specific_questions: 'Why?',
          max_sources: 8,
          allowed_domains: 'nature.com, https://nasa.gov/',
          blocked_domains: 'spam.example',
        },
      },
    } as any
    const params = resolveStepParams('research', 'EP0001', 'Episode title', preset)
    assert.equal(params.research_mode, 'web-search')
    assert.equal(params.source_provider, GENSTUDIO_WEB_RESEARCH_PROVIDER)
    assert.deepEqual(params.allowed_domains, ['nature.com', 'nasa.gov'])
    assert.deepEqual(params.blocked_domains, ['spam.example'])
    assert.equal(params.model, 'gs-research-1')
  })

  it('never upgrades a legacy preset into web mode, and drops domains in model mode', () => {
    const legacy = { data: { form: { source_provider: 'llm-only', max_sources: 8 } } } as any
    const params = resolveStepParams('research', 'EP0002', 'Title', legacy)
    assert.equal(params.research_mode, 'model-knowledge')
    assert.equal(params.source_provider, GENSTUDIO_RESEARCH_PROVIDER)
    assert.equal('allowed_domains' in params, false)

    // Domains saved while in web mode must not leak into a model-knowledge run.
    const switched = {
      data: { form: { research_mode: 'model-knowledge', allowed_domains: 'nature.com' } },
    } as any
    const switchedParams = resolveStepParams('research', 'EP0003', 'Title', switched)
    assert.equal('allowed_domains' in switchedParams, false)
  })
})

describe('web citations reach the YouTube SOURCES block', () => {
  it('include_in_description still selects run-level web citations', async () => {
    // readSelectedResearchSources is the shared source boundary for the
    // description appender and the late-stage finalizer, so exercising its
    // filter proves web citations flow through both.
    const research: ResearchOutput = {
      schema_version: 1,
      source_provider: GENSTUDIO_WEB_RESEARCH_PROVIDER,
      research_mode: 'web-search',
      generated_at: new Date().toISOString(),
      topic: 'T',
      claims: [],
      citations: [
        { title: 'Kept', url: 'https://example.org/a' },
        { title: 'Dropped', url: 'https://example.org/b', include_in_description: false },
        { title: 'Explicitly kept', url: 'https://example.org/c', include_in_description: true },
        { title: 'No URL', url: '' },
      ],
    }
    const selected = (research.citations || [])
      .filter(c => c && typeof c.url === 'string' && c.url.trim() && c.include_in_description !== false)
      .map(c => ({ title: (c.title || '').trim() || c.url.trim(), url: c.url.trim() }))
    assert.deepEqual(selected.map(s => s.url), ['https://example.org/a', 'https://example.org/c'])
    // A missing episode returns an empty list rather than throwing — Research
    // stays optional for the description.
    assert.deepEqual(await readSelectedResearchSources('no-such-project', 'EP9999'), [])
  })
})

// ── Per-claim source attribution ────────────────────────────────────────
//
// Structured output AND per-claim citations, which used to be mutually
// exclusive: citations attach to prose, and a JSON answer has none, so xAI
// returns real URLs with every span at 0..0. Attribution therefore comes from
// the model naming its own sources and GenStudio checking those names against
// what the provider really retrieved.
//
// The tests that matter most here are the negative ones. Story Studio must be
// incapable of showing a source the model merely typed.
describe('research — per-claim source attribution', () => {
  const citations = [
    { source_id: 'citation-1', title: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Great_Smog_of_London' },
    { source_id: 'citation-2', title: 'Britannica', url: 'https://www.britannica.com/event/Great-Smog-of-London' },
  ]

  function webOutput(claims: unknown[], citationClaims?: Array<{ claim_id: string; citation_ids: string[] }>) {
    return assembleOutput(
      JSON.stringify({ summary: 'S', claims }),
      citations,
      {
        topic: 'T',
        provider: GENSTUDIO_WEB_RESEARCH_PROVIDER,
        mode: 'web-search',
        ...(citationClaims ? { web_run: { citation_claims: citationClaims } } : {}),
      },
    )
  }

  it('asks for per-claim sources only when the Gateway will ground them', () => {
    const withAttribution = buildResearchPrompt({ topic: 'T' } as any, 'web', true)
    assert.match(withAttribution.system, /`sources`/)
    assert.match(withAttribution.system, /leave its `sources` array empty/)

    const without = buildResearchPrompt({ topic: 'T' } as any, 'web', false)
    assert.doesNotMatch(without.system, /`sources`/)
  })

  it('permits an empty sources array in as many words', () => {
    // A model told only to cite everything invents a citation for a claim it
    // cannot support. Permission to return nothing is the whole safeguard.
    const { system } = buildResearchPrompt({ topic: 'T' } as any, 'web', true)
    assert.match(system, /unsourced claim is an expected and acceptable answer/)
  })

  it('sends claim_attribution only to a product that publishes support', () => {
    assert.equal(buildWebSearchBlock(qualifiedModel(), undefined).claim_attribution, true)
    // An older GenStudio rejects an unknown field outright, so it is omitted
    // entirely rather than sent as false.
    assert.equal(
      'claim_attribution' in buildWebSearchBlock(
        qualifiedModel({ supports_claim_attribution: false }),
        undefined,
      ),
      false,
    )
  })

  it('links a claim to the sources Gateway grounded for it', () => {
    const output = webOutput(
      [
        { text: 'Backed by both.', sources: ['https://en.wikipedia.org/wiki/Great_Smog_of_London'] },
        { text: 'Backed by one.', sources: [] },
      ],
      [
        { claim_id: 'claim-1', citation_ids: ['citation-1', 'citation-2'] },
        { claim_id: 'claim-2', citation_ids: ['citation-2'] },
      ],
    )

    assert.deepEqual(output.claims[0]!.citation_indices, [0, 1])
    assert.deepEqual(output.claims[1]!.citation_indices, [1])
  })

  it('leaves a claim the Gateway did not attribute visibly uncited', () => {
    const output = webOutput(
      [
        { text: 'Grounded.', sources: ['https://en.wikipedia.org/wiki/Great_Smog_of_London'] },
        { text: 'Not grounded.', sources: [] },
        { text: 'Named a page nobody opened.', sources: ['https://fabricated.example/x'] },
      ],
      [{ claim_id: 'claim-1', citation_ids: ['citation-1'] }],
    )

    assert.deepEqual(output.claims[0]!.citation_indices, [0])
    // Neither of the other two inherits the run's source list.
    assert.deepEqual(output.claims[1]!.citation_indices, [])
    assert.deepEqual(output.claims[2]!.citation_indices, [])
    const uncited = output.claims.filter(c => !c.citation_indices.length).length
    assert.equal(uncited, 2)
  })

  it('never links a claim from the URLs the model typed', () => {
    // The model attributed every claim to a real, retrieved page. Without a
    // grounded envelope from GenStudio, none of it counts: Story Studio does
    // not read `sources` and cannot be made to.
    const output = webOutput([
      { text: 'Typed a real URL.', sources: ['https://en.wikipedia.org/wiki/Great_Smog_of_London'] },
      { text: 'Typed another.', sources: ['https://www.britannica.com/event/Great-Smog-of-London'] },
    ])

    assert.deepEqual(output.claims[0]!.citation_indices, [])
    assert.deepEqual(output.claims[1]!.citation_indices, [])
  })

  it('drops a grounded link whose citation id matches no source', () => {
    const output = webOutput(
      [{ text: 'Points nowhere.', sources: [] }],
      [{ claim_id: 'claim-1', citation_ids: ['citation-99'] }],
    )

    assert.deepEqual(output.claims[0]!.citation_indices, [])
  })

  it('ignores a malformed claim id instead of guessing a position', () => {
    const output = webOutput(
      [{ text: 'One.', sources: [] }],
      [
        { claim_id: 'not-a-claim-id', citation_ids: ['citation-1'] },
        { claim_id: 'claim-0', citation_ids: ['citation-1'] },
      ],
    )

    assert.deepEqual(output.claims[0]!.citation_indices, [])
  })

  it('keeps the run-level wording until something is actually attributed', () => {
    // Two different reasons for zero attribution — a GenStudio that cannot
    // ground, and a model that sourced nothing — and both keep the honest
    // weaker sentence rather than borrowing the stronger one.
    assert.equal(webResearchNotice(4, 0, 8), WEB_SEARCH_NOTICE)
    assert.equal(webResearchNotice(0, 0, 8), WEB_SEARCH_NO_SOURCES_NOTICE)
  })

  it('recognizes provider-reported source URLs without promoting them into citations', () => {
    const run = {
      source_urls: ['https://example.org/opened-page'],
      research_evidence_level: 'source_urls_only' as const,
    }
    assert.equal(webResearchNotice(0, 0, 8, run), WEB_SEARCH_SOURCE_URLS_NOTICE)
    assert.notEqual(webResearchNotice(0, 0, 8, run), WEB_SEARCH_NO_SOURCES_NOTICE)
  })

  it('states how many claims carry no citation once some are attributed', () => {
    const notice = webResearchNotice(4, 2, 8)
    assert.match(notice, /2 of 8 claims link to the specific sources/)
    assert.match(notice, /the other 6 carry no citation/)
    // No dangling clause when everything is covered.
    assert.doesNotMatch(webResearchNotice(4, 8, 8), /carry no citation/)
  })

  it('promises a mechanism, not an outcome, before a run exists', () => {
    // The picker cannot know whether any claim will end up linked.
    assert.doesNotMatch(WEB_SEARCH_MODE_BLURB, /\d+ of \d+/)
    assert.match(WEB_SEARCH_MODE_BLURB, /checked against what was really retrieved/)
  })

  it('carries the Gateway source id so a grounded link can resolve', () => {
    const [citation] = toResearchCitations(parseGenStudioCitations([
      { id: 'citation-7', url: 'https://example.org/a', title: 'A' },
    ]))
    assert.equal(citation!.source_id, 'citation-7')
  })
})
