/**
 * GenStudio's CONFIRMED web-research envelope contract.
 *
 * v1.0.764 shipped web-research mode parsing defensively-GUESSED field names
 * (`web_search_count` / `web_searches_performed`, `credits_charged` /
 * `credit_cost`). GenStudio has since published the real ones. Source of
 * truth, read directly rather than guessed again:
 *
 *   genstudiokh/apps/cloud-api/app/modules/chat/schemas.py
 *     :: OpenAIChatCompletionResponse  (~line 343)
 *     :: ChatJobResponse               (~line 224)
 *   genstudiokh/apps/cloud-api/app/modules/chat/router.py
 *     :: create_chat_completion / _response (~line 238)
 *
 * Confirmed: `research_ran_at`, `web_searches_executed`,
 * `web_search_credit_cost`, `citations`, `citation_claims`.
 *
 * ZERO paid calls: every envelope below is hand-written. Nothing here touches
 * GenStudio.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  callChatWithGenStudio,
  describeGenStudioLanguageFailure,
  GenStudioApiError,
  GenStudioChatTerminalFailureError,
  isGenStudioSettledOutcomeError,
  isGenStudioSubmissionUncertain,
  parseGenStudioCitationClaims,
  parseGenStudioCitations,
  GENSTUDIO_LANGUAGE_FAILURE_CODES,
} from '../lib/genstudio-client.js'
import {
  readResearchWebRun,
  researchRanAt,
  webRunUsageSentence,
} from '../services/research/provenance.js'
import type { ResearchWebRunReport } from '../models/types.js'

const RESEARCH_RAN_AT = '2026-07-15T09:30:00.000Z'

function researchProduct() {
  return [{
    id: 'research-alpha',
    display_name: 'Research Alpha',
    available: true,
    qualification_only: false,
    context_window_tokens: 200_000,
    max_output_tokens: 16_384,
    controls: [],
    activation_blockers: [],
    structured_output_mode: 'json_object',
    supports_structured_output: true,
    supports_web_search: true,
    returns_citations: true,
    citation_format: 'structured',
    supports_domain_filters: false,
    research_qualified: true,
    web_search_credits_per_search: 5,
    max_web_searches: null,
  }]
}

function accountOverview() {
  return {
    paid_concurrency_limit: 5,
    paid_active_jobs: 0,
    paid_queued_jobs: 0,
    max_queued_jobs: 25,
    generation_submissions_per_minute: 30,
    relaxed_concurrency_limit: 1,
  }
}

/**
 * Run one web-search chat call against a hand-written envelope.
 *
 * The default route is now the durable `/v1/chat/responses` job, so this
 * exercises the envelope as it arrives on `ChatJobResponse` — same top-level
 * field names as the synchronous completion envelope carried. `transport`
 * re-runs the identical assertions against the rollback route so the two
 * cannot silently diverge.
 */
async function webCall(
  envelopeExtras: Record<string, unknown>,
  transport: 'responses' | 'completions' = 'responses',
) {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async (input) => {
      const url = String(input)
      if (url.endsWith('/v1/chat/models')) return Response.json(researchProduct())
      if (url.endsWith('/v1/account/overview')) return Response.json(accountOverview())
      if (transport === 'completions') {
        return Response.json({
          id: 'job_web_1',
          object: 'chat.completion',
          model: 'research-alpha',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: '{"summary":"ok"}' },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
          ...envelopeExtras,
        })
      }
      return Response.json({
        id: 'job_web_1',
        state: 'succeeded',
        operation: 'chat.response',
        dispatch_mode: 'asynchronous',
        model_id: 'research-alpha',
        output_text: '{"summary":"ok"}',
        output_retained: true,
        finish_reason: 'stop',
        failure_code: null,
        routing_status_code: null,
        credit_cost: 12,
        remaining_credits: 800,
        idempotent_replay: false,
        ...envelopeExtras,
      })
    }
    return await callChatWithGenStudio(`web-envelope-key-${transport}`, {
      modelId: 'research-alpha',
      system: '',
      userMessage: 'Research volcanic soil.',
      outputContract: { mode: 'json_object' },
      outputBudget: 'long',
      webSearch: { enabled: true, allowed_domains: [], blocked_domains: [] },
      transport,
    })
  } finally {
    globalThis.fetch = originalFetch
  }
}

// ── The three confirmed names ────────────────────────────────────────────

test('the confirmed envelope field names parse', async () => {
  const envelope = {
    web_search_requested: true,
    web_searches_executed: 4,
    web_search_credit_cost: 20,
    research_ran_at: RESEARCH_RAN_AT,
    citations: [{ id: 'src-1', url: 'https://example.invalid/a', title: 'A' }],
  }
  const result = await webCall(envelope)
  assert.equal(result.webSearch.searchesExecuted, 4)
  assert.equal(result.webSearch.searchCreditCost, 20)
  assert.equal(result.webSearch.researchRanAt, RESEARCH_RAN_AT)
  assert.equal(result.citations.length, 1)
})

test('the durable job and the completion envelope report a web run identically', async () => {
  // Web research moved onto `/v1/chat/responses` with everything else, and
  // `ChatJobResponse` carries the evidence envelope at the same top level the
  // completion envelope did (docs/genstudio-web-search-request.md §3 asked for
  // citations "as their own field on the job response"). If those two ever
  // drift, research provenance silently empties out on the default route —
  // so assert them equal rather than trusting one of them.
  const envelope = {
    web_search_requested: true,
    web_searches_executed: 6,
    web_search_credit_cost: 30,
    research_ran_at: RESEARCH_RAN_AT,
    citations: [{ id: 'src-1', url: 'https://example.invalid/a', title: 'A' }],
    citation_claims: [{ claim_id: 'c1', citation_ids: ['src-1'] }],
  }
  const durable = await webCall(envelope, 'responses')
  const synchronous = await webCall(envelope, 'completions')
  assert.deepEqual(durable.webSearch, synchronous.webSearch)
  assert.deepEqual(durable.citations, synchronous.citations)
  assert.equal(durable.webSearch.searchesExecuted, 6)
  assert.equal(durable.webSearch.searchCreditCost, 30)
  assert.equal(durable.webSearch.researchRanAt, RESEARCH_RAN_AT)
  assert.deepEqual(durable.webSearch.citationClaims, [{ claim_id: 'c1', citation_ids: ['src-1'] }])
})

test('the retired GUESSED names are no longer read off the wire', async () => {
  // If an envelope only carries the names v1.0.764 invented, that is not a
  // GenStudio report — it is noise, and must surface as "not reported" rather
  // than as a number the app presents as fact.
  const result = await webCall({
    web_search_count: 9,
    web_searches_performed: 9,
    credits_charged: 99,
    credit_cost: 99,
  })
  assert.equal(result.webSearch.searchesExecuted, null)
  assert.equal(result.webSearch.searchCreditCost, null)
})

test('absent fields stay null and are rendered "not reported"', async () => {
  const result = await webCall({})
  assert.equal(result.webSearch.searchesExecuted, null)
  assert.equal(result.webSearch.searchCreditCost, null)
  assert.equal(result.webSearch.researchRanAt, null)
  assert.deepEqual(result.webSearch.citationClaims, [])

  // Nothing reported at all — one honest sentence, no invented zeroes.
  assert.match(webRunUsageSentence({}), /did not report/i)
  assert.doesNotMatch(webRunUsageSentence({}), /\b0\b/)
  // Partially reported — the missing half says so, the present half does not.
  const partial = webRunUsageSentence({ web_searches_executed: 3 })
  assert.match(partial, /Searches executed: 3\./)
  assert.match(partial, /Web search cost: not reported\./)
})

test('a locally computed charge is never substituted for a missing one', () => {
  // The catalogue publishes a per-search RATE; 3 searches x 5 credits is a
  // number this app must never present as the customer's charge.
  const run: ResearchWebRunReport = { web_searches_executed: 3, credits_per_search: 5 }
  const sentence = webRunUsageSentence(run)
  assert.match(sentence, /Web search cost: not reported\./)
  assert.doesNotMatch(sentence, /15/)
})

test('sidecars written by v1.0.764 still display under the old names', () => {
  const legacy: ResearchWebRunReport = { searches_performed: 7, credits_charged: 35 }
  const read = readResearchWebRun(legacy)
  assert.equal(read.searchesExecuted, 7)
  assert.equal(read.searchCreditCost, 35)
  // A confirmed name always wins over a legacy one on the same record.
  assert.equal(
    readResearchWebRun({ web_searches_executed: 2, searches_performed: 7 }).searchesExecuted,
    2,
  )
})

// ── research_ran_at beats generated_at ───────────────────────────────────

test('research_ran_at is preferred over generated_at, and falls back', () => {
  const generatedAt = '2026-07-20T00:00:00.000Z'
  // GenStudio's own record of the run wins.
  assert.equal(researchRanAt({ research_ran_at: RESEARCH_RAN_AT }, generatedAt), RESEARCH_RAN_AT)
  // Absent, empty, or an unusable value falls back to the local stamp.
  assert.equal(researchRanAt({}, generatedAt), generatedAt)
  assert.equal(researchRanAt(undefined, generatedAt), generatedAt)
  assert.equal(researchRanAt({ research_ran_at: '   ' }, generatedAt), generatedAt)
  // Nothing anywhere is an empty string, never the word "undefined".
  assert.equal(researchRanAt(undefined, undefined), '')
})

test('an unparseable research_ran_at is dropped rather than displayed', async () => {
  const result = await webCall({ research_ran_at: 'sometime last week' })
  assert.equal(result.webSearch.researchRanAt, null)
})

// ── citation_claims: parsed, not yet displayed ───────────────────────────

test('citation_claims parses when present and is empty when absent', async () => {
  const present = await webCall({
    citations: [{ id: 'src-1', url: 'https://example.invalid/a' }],
    citation_claims: [{ claim_id: 'c1', citation_ids: ['src-1'] }],
  })
  assert.deepEqual(present.webSearch.citationClaims, [{ claim_id: 'c1', citation_ids: ['src-1'] }])

  const absent = await webCall({})
  assert.deepEqual(absent.webSearch.citationClaims, [])

  // Direct parser: garbage entries are dropped, never half-parsed. A claim
  // with no source ids is not linkage.
  assert.deepEqual(parseGenStudioCitationClaims(undefined), [])
  assert.deepEqual(parseGenStudioCitationClaims('nope'), [])
  assert.deepEqual(
    parseGenStudioCitationClaims([
      { claim_id: 'c1', citation_ids: [] },
      { claim_id: '', citation_ids: ['s1'] },
      null,
      { claim_id: 'c2', citation_ids: ['s1', 'ignored', 7] },
    ]),
    [{ claim_id: 'c2', citation_ids: ['s1', 'ignored'] }],
  )
})

test('publisher, published_at and excerpts stay absent rather than invented', () => {
  // GenStudio's contract has the fields; no provider populates them today.
  // They must be optional and simply missing, never filled with a placeholder.
  const [citation] = parseGenStudioCitations([{ id: 's1', url: 'https://example.invalid/a' }])
  assert.equal(citation?.publisher, null)
  assert.equal(citation?.published_at, null)
  assert.equal(citation?.quote, null)
  assert.equal(citation?.title, null)
})

// ── The two language failure codes ───────────────────────────────────────

test('both published failure codes produce a clear, actionable message', () => {
  const failed = describeGenStudioLanguageFailure(GENSTUDIO_LANGUAGE_FAILURE_CODES.PROVIDER_FAILED)
  assert.ok(failed)
  assert.match(failed!, /language provider/i)
  assert.match(failed!, /retry|different language product/i)
  // Never leaks the raw code as the whole explanation.
  assert.doesNotMatch(failed!, /^LANGUAGE_/)

  const uncertain = describeGenStudioLanguageFailure(
    GENSTUDIO_LANGUAGE_FAILURE_CODES.SUBMISSION_UNCERTAIN,
  )
  assert.ok(uncertain)
  // The user is told WHY nothing happened automatically: a second paid
  // submission was the alternative.
  assert.match(uncertain!, /could not confirm/i)
  assert.match(uncertain!, /twice|duplicate/i)
  assert.match(uncertain!, /did NOT retry it automatically/)

  // Unknown / absent codes are not given invented meanings.
  assert.equal(describeGenStudioLanguageFailure(null), null)
  assert.equal(describeGenStudioLanguageFailure(''), null)
  assert.equal(describeGenStudioLanguageFailure('SOMETHING_ELSE'), null)
})

test('the failure code drives the surfaced error message', () => {
  const error = new GenStudioApiError(
    502, 'language generation failed', GENSTUDIO_LANGUAGE_FAILURE_CODES.SUBMISSION_UNCERTAIN,
  )
  assert.equal(error.languageFailureCode, GENSTUDIO_LANGUAGE_FAILURE_CODES.SUBMISSION_UNCERTAIN)
  assert.match(error.message, /could not confirm/i)
  assert.equal(isGenStudioSubmissionUncertain(error), true)

  // A 502 that identifies no code keeps the existing generic wording and is
  // NOT assumed to be either published code.
  const plain = new GenStudioApiError(502, 'language generation failed')
  assert.equal(plain.languageFailureCode, null)
  assert.equal(isGenStudioSubmissionUncertain(plain), false)
  assert.match(plain.message, /provider behind this GenStudio KH product failed/i)

  // The code is also recovered when GenStudio quotes it in the detail string.
  const quoted = new GenStudioApiError(502, 'route failed: LANGUAGE_PROVIDER_FAILED')
  assert.equal(quoted.languageFailureCode, GENSTUDIO_LANGUAGE_FAILURE_CODES.PROVIDER_FAILED)
  assert.match(quoted.message, /language provider/i)
})

test('SUBMISSION_UNCERTAIN never triggers an automatic resubmit', async () => {
  const originalFetch = globalThis.fetch
  let submissions = 0
  try {
    globalThis.fetch = async (input) => {
      const url = String(input)
      if (url.endsWith('/v1/chat/models')) return Response.json(researchProduct())
      if (url.endsWith('/v1/account/overview')) return Response.json(accountOverview())
      submissions += 1
      // 502 is normally a RETRYABLE status (>= 500). This code must override
      // that: GenStudio stopped precisely to avoid a second paid request, and
      // Story Studio reconnecting would reintroduce the risk it declined.
      return Response.json(
        { detail: 'language generation failed', code: 'LANGUAGE_PROVIDER_SUBMISSION_UNCERTAIN' },
        { status: 502 },
      )
    }
    const error = await callChatWithGenStudio('uncertain-key', {
      modelId: 'research-alpha',
      system: '',
      userMessage: 'Research volcanic soil.',
      outputContract: { mode: 'json_object' },
      outputBudget: 'long',
    }).then(() => null, (err: unknown) => err)

    assert.ok(error instanceof GenStudioApiError)
    assert.equal(isGenStudioSubmissionUncertain(error), true)
    assert.match((error as Error).message, /could not confirm/i)
    assert.equal(submissions, 1, 'an uncertain submission must be sent exactly once')
  } finally {
    globalThis.fetch = originalFetch
  }
})

/**
 * Settle a durable language job as `failed` with one published failure code and
 * report what Story Studio did about it.
 *
 * THIS IS THE MIGRATION'S WHOLE POINT. Over `/v1/chat/completions` both codes
 * arrive as the same bodiless 502 — `{"detail": "language generation failed"}`
 * — so the app cannot tell "retry is free" from "retrying might be charged
 * twice". `ChatJobResponse.failure_code` is the field that separates them.
 */
async function failedChatJob(failureCode: string, key: string) {
  const originalFetch = globalThis.fetch
  const submits: string[] = []
  let polls = 0
  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      if (url.endsWith('/v1/chat/models')) return Response.json(researchProduct())
      if (url.endsWith('/v1/account/overview')) return Response.json(accountOverview())
      const method = (init?.method || 'GET').toUpperCase()
      const settled = {
        id: 'job_failed_1',
        state: 'failed',
        operation: 'chat.response',
        model_id: 'research-alpha',
        output_text: null,
        finish_reason: null,
        failure_code: failureCode,
        routing_status_code: null,
        credit_cost: 0,
        remaining_credits: 800,
      }
      if (method === 'POST') {
        submits.push(String((init?.headers as Record<string, string>)['Idempotency-Key']))
        return Response.json({ ...settled, state: 'running', failure_code: null }, { status: 202 })
      }
      polls += 1
      return Response.json(settled)
    }
    const error = await callChatWithGenStudio(key, {
      modelId: 'research-alpha',
      system: '',
      userMessage: 'Research volcanic soil.',
      outputContract: { mode: 'json_object' },
      outputBudget: 'long',
    }).then(() => null, (err: unknown) => err)
    return { error, submits, polls }
  } finally {
    globalThis.fetch = originalFetch
  }
}

test('a durable job distinguishes the two failure codes the 502 could not', async () => {
  const failed = await failedChatJob(GENSTUDIO_LANGUAGE_FAILURE_CODES.PROVIDER_FAILED, 'job-failed-key')
  assert.ok(failed.error instanceof GenStudioChatTerminalFailureError)
  assert.equal(failed.error.failureCode, GENSTUDIO_LANGUAGE_FAILURE_CODES.PROVIDER_FAILED)
  // Retryable: the reservation was released and nothing was charged twice.
  assert.match((failed.error as Error).message, /Retry this step, or pick a different language product/i)
  assert.equal(isGenStudioSubmissionUncertain(failed.error), false)

  const uncertain = await failedChatJob(
    GENSTUDIO_LANGUAGE_FAILURE_CODES.SUBMISSION_UNCERTAIN, 'job-uncertain-key',
  )
  assert.ok(uncertain.error instanceof GenStudioChatTerminalFailureError)
  assert.equal(uncertain.error.failureCode, GENSTUDIO_LANGUAGE_FAILURE_CODES.SUBMISSION_UNCERTAIN)
  assert.equal(isGenStudioSubmissionUncertain(uncertain.error), true)
  // The user is told to check the account BEFORE resubmitting, and told that
  // Story Studio deliberately did not do it for them.
  assert.match((uncertain.error as Error).message, /could not confirm/i)
  assert.match((uncertain.error as Error).message, /Check the run in your\s+GenStudio account/i)
  assert.match((uncertain.error as Error).message, /did NOT retry it automatically/)

  // Neither code resubmits, and the uncertain one is doubly protected: it is a
  // settled outcome AND it is refused by name in shouldReconnectAcceptedTask.
  assert.equal(failed.submits.length, 1, 'a failed job must not be resubmitted')
  assert.equal(uncertain.submits.length, 1, 'an uncertain job must NEVER be resubmitted')
})

test('a terminal language failure is never reconnected into a second submission', async () => {
  // A settled job can only ever re-read as settled, so reconnecting is dead
  // work for PROVIDER_FAILED and an actual duplicate-charge risk for
  // SUBMISSION_UNCERTAIN. One typed check covers both.
  for (const code of Object.values(GENSTUDIO_LANGUAGE_FAILURE_CODES)) {
    const error = new GenStudioChatTerminalFailureError({ id: 'job_x', state: 'failed', failure_code: code })
    assert.equal(isGenStudioSettledOutcomeError(error), true, `${code} must be settled`)
  }
})

test('an ordinary provider failure is still allowed its normal retries', async () => {
  // The no-retry rule is scoped to the uncertain code alone; a plain 502 must
  // not lose the reconnect behaviour every other request depends on.
  const originalFetch = globalThis.fetch
  let submissions = 0
  try {
    globalThis.fetch = async (input) => {
      const url = String(input)
      if (url.endsWith('/v1/chat/models')) return Response.json(researchProduct())
      if (url.endsWith('/v1/account/overview')) return Response.json(accountOverview())
      submissions += 1
      return Response.json({ detail: 'language generation failed' }, { status: 502 })
    }
    await callChatWithGenStudio('plain-502-key', {
      modelId: 'research-alpha',
      system: '',
      userMessage: 'Research volcanic soil.',
      outputContract: { mode: 'json_object' },
    }).catch(() => null)
    assert.ok(submissions > 1, 'a plain 502 should still reconnect')
  } finally {
    globalThis.fetch = originalFetch
  }
})
