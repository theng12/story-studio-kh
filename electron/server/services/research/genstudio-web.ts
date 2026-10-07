/**
 * GenStudio web-search Research adapter ("Search the web" mode).
 *
 * Same GenStudio boundary as the model-knowledge adapter — same key, same
 * language route. This adapter names NO route of its own: it calls
 * `callChatWithGenStudio`, which resolves the route once at
 * `resolveGenStudioChatTransport()` (genstudio-client.ts).
 *
 * WHICH ROUTE IS LIVE IS NOT WRITTEN DOWN HERE. Two successive versions of
 * this comment each named a route, each was wrong, and each cost a debugging
 * session. The switch is `STORY_STUDIO_GENSTUDIO_CHAT_TRANSPORT`; read
 * `describeGenStudioChatTransport` for the value when it is unset, or the
 * `[genstudio] Language transport:` line the app writes at startup, which
 * states the route and where the choice came from.
 *
 * Two differences from the model-knowledge adapter matter:
 *
 *   1. The request carries a `web_search` block, built from the SELECTED
 *      product's published capability (see web-capability.ts). Story Studio
 *      never asks for a feature the product has not advertised.
 *   2. Sources come from the RESPONSE ENVELOPE, not from the model's JSON.
 *      They are the provider's record of what it actually read, which is why
 *      this mode may say "cited its sources" while model-knowledge mode may
 *      not.
 *
 * A product must pass all five published conditions before it is offered here.
 * Today every product reports `research_qualified: false`, so this adapter
 * refuses to run with a plain explanation rather than falling back to the
 * no-web-access route — silently downgrading would hand the user unsourced
 * claims while the page said "searched the web".
 */

import { getApiKey } from '../app-secrets-store.js'
import { noWritingModelChosenMessage } from '../genstudio-default-model.js'
import { callChatWithGenStudio, GenStudioChatCapabilityUnavailableError, GenStudioChatProductUnavailableError, listChatModels, type GenStudioChatModel } from '../../lib/genstudio-client.js'
import { executePipelineModelPolicy, resolveLivePipelineModel } from '../../lib/ai-client.js'
import { pipelinePolicyInputFingerprint } from '../../lib/pipeline-model-policy.js'
import { JSON_OBJECT_OUTPUT_CONTRACT } from '../../lib/json-output-contract.js'
import type { ResearchAdapter } from './types.js'
import type { ResearchOutput, ResearchRunOptions, ResearchWebRunReport } from '../../models/types.js'
import { buildResearchPrompt, assembleOutput } from './prompt.js'
import {
  WEB_MODE_UNAVAILABLE_REASON,
  buildWebSearchBlock,
  failedWebResearchConditions,
  isWebResearchQualified,
  selectWebResearchModels,
  toResearchCitations,
} from './web-capability.js'
import { findGenStudioProduct } from '../../contracts/genstudio-product-identity.js'

export const GENSTUDIO_WEB_RESEARCH_PROVIDER = 'genstudio-web' as const

class GenStudioWebResearchAdapter implements ResearchAdapter {
  readonly provider = GENSTUDIO_WEB_RESEARCH_PROVIDER
  readonly displayName = 'Gateway web search'
  readonly helperText =
    'Searches the web through a qualified Gateway model and records the sources it read.'

  async isConfigured(): Promise<boolean> {
    const key = await getApiKey('genstudio').catch(() => '')
    return !!key.trim()
  }

  async run(opts: ResearchRunOptions): Promise<ResearchOutput> {
    const apiKey = await getApiKey('genstudio').catch(() => '')
    if (!apiKey) {
      throw new Error('No Gateway API Key configured. Add it in Settings → This Mac before running research.')
    }
    const policy = opts.pipeline_model_policy
    // The Pipeline's model is checked only before a fresh POST. A saved key is
    // a read of already-submitted work, so it must not depend on today's
    // catalogue being reachable or still publishing the historical product.
    const policyCheckpointKey = opts.pipeline_policy_checkpoint_key || opts.request_identity || 'research'
    const qualified = policy ? [] : selectWebResearchModels(await listChatModels(apiKey))
    if (!qualified.length && !policy) throw new Error(WEB_MODE_UNAVAILABLE_REASON)

    // An explicitly requested model is honoured only if it still qualifies.
    // Healing to a different product would change what the user is charged
    // for without telling them, so an unqualified request is refused by name.
    const requested = opts.model?.trim() || ''
    // Never picked for the owner (2026-10-03): no choice on the page or for the Pipeline run is a plain stop.
    if (!requested && !policy) throw new Error(noWritingModelChosenMessage('the Research page (web research model)'))
    let product = qualified[0]!
    if (requested && !policy) {
      const match = findGenStudioProduct(qualified, requested)
      if (!match) {
        throw new Error(
          `"${requested}" cannot be used for web research: it is not a model that returns structured citations and `
          + 'is qualified for research. Pick one of the models offered for web search, or use model-knowledge mode.',
        )
      }
      product = match
    }
    // A Pipeline run's model is validated just before its own submission below.
    if (!policy && !isWebResearchQualified(product)) throw new Error(WEB_MODE_UNAVAILABLE_REASON)

    let actualProduct: GenStudioChatModel | null = policy ? null : product
    let finalWebSearch = actualProduct
      ? buildWebSearchBlock(actualProduct, opts.web_search, opts.max_sources ?? null)
      : null
    const runProduct = async (
      candidateId: string,
      recovery?: { idempotencyKey: string },
      checkpointAccepted?: (idempotencyKey: string) => Promise<void>,
      checkpointPrepared?: (idempotencyKey: string) => Promise<void>,
    ) => {
      const requestIdentity = opts.request_identity
      if (recovery) {
        // Recovery is a GET by a server-owned key. Keep the run's persisted
        // options for its result record, but do not build a new request from
        // a changed product catalogue.
        const webSearch = {
          enabled: true as const,
          allowed_domains: [...(opts.web_search?.allowed_domains || [])],
          blocked_domains: [...(opts.web_search?.blocked_domains || [])],
        }
        finalWebSearch = webSearch
        const { system, user } = buildResearchPrompt(opts, 'web', false)
        return callChatWithGenStudio(apiKey, {
          modelId: candidateId,
          system,
          userMessage: user,
          outputContract: JSON_OBJECT_OUTPUT_CONTRACT,
          outputBudget: 'long',
          webSearch,
          requestIdentity,
          ...(checkpointAccepted ? { onJobAccepted: (_jobId: string, idempotencyKey: string) => checkpointAccepted(idempotencyKey) } : {}),
          ...(checkpointPrepared ? { onRequestPrepared: checkpointPrepared } : {}),
          recoverByIdempotencyKey: true,
          idempotencyKey: recovery.idempotencyKey,
          allowedRecoveryKeys: [recovery.idempotencyKey],
        })
      }
      // The preflight catalogue is only a selection snapshot. Re-read the
      // exact product immediately before each fresh submission so a capability
      // withdrawal (or account lock) cannot turn a web request into a plain
      // chat request after the policy was accepted.
      const liveCandidate = resolveLivePipelineModel(candidateId, await listChatModels(apiKey))
      if (liveCandidate.locked === true) throw new GenStudioChatProductUnavailableError(candidateId)
      if (!isWebResearchQualified(liveCandidate)) {
        const failed = failedWebResearchConditions(liveCandidate)
        throw new GenStudioChatCapabilityUnavailableError(
          candidateId,
          `web research capability check failed (${failed.join(', ') || 'unknown capability mismatch'})`,
        )
      }
      const candidate = liveCandidate
      actualProduct = candidate
      const webSearch = buildWebSearchBlock(candidate, opts.web_search, opts.max_sources ?? null)
      finalWebSearch = webSearch
      // Ask for per-claim sources only when the request also asks GenStudio to
      // ground them. Both come off the one block, so they cannot drift into
      // asking the model for URLs that nothing will check.
      const { system, user } = buildResearchPrompt(opts, 'web', webSearch.claim_attribution === true)
      return callChatWithGenStudio(apiKey, {
        // Keep the policy's saved product identity on the wire. `candidate`
        // is only the live capability record used to build this request.
        modelId: candidateId,
        system,
        userMessage: user,
        outputContract: JSON_OBJECT_OUTPUT_CONTRACT,
        // Same long-form shape as model-knowledge research, and the same
        // truncation risk — web mode also has to fit its sources in.
        outputBudget: 'long',
        webSearch,
        requestIdentity,
        ...(checkpointAccepted ? { onJobAccepted: (_jobId: string, idempotencyKey: string) => checkpointAccepted(idempotencyKey) } : {}),
        ...(checkpointPrepared ? { onRequestPrepared: checkpointPrepared } : {}),
      })
    }
    const result = await (policy
      ? executePipelineModelPolicy(
          policy,
          runProduct,
          opts.pipeline_policy_checkpoint,
          policyCheckpointKey,
          pipelinePolicyInputFingerprint({ topic: opts.topic, specific_questions: opts.specific_questions, max_sources: opts.max_sources, web_search: opts.web_search }),
        )
      : runProduct(product!.id)).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`Gateway web research failed: ${message}`)
    })

    // Report what GenStudio actually reported, and nothing more. A null field
    // stays ABSENT so the UI can say "not reported" instead of showing a
    // number this app made up. Field names are GenStudio's confirmed contract
    // (schemas.py :: ChatJobResponse, which carries the same top-level
    // evidence envelope as OpenAIChatCompletionResponse did), not the names
    // v1.0.764 guessed.
    const webRun: ResearchWebRunReport = {
      ...(result.webSearch.sourceUrls.length
        ? { source_urls: result.webSearch.sourceUrls }
        : {}),
      ...(result.webSearch.researchEvidenceLevel !== null
        ? { research_evidence_level: result.webSearch.researchEvidenceLevel }
        : {}),
      ...(result.webSearch.searchesExecuted !== null
        ? { web_searches_executed: result.webSearch.searchesExecuted }
        : {}),
      ...(result.webSearch.searchCreditCost !== null
        ? { web_search_credit_cost: result.webSearch.searchCreditCost }
        : {}),
      ...(result.webSearch.researchRanAt !== null
        ? { research_ran_at: result.webSearch.researchRanAt }
        : {}),
      // Present in the contract, empty from every provider today. Persisted
      // when it arrives so the run-level display can become per-claim later
      // without a migration; nothing reads it for display yet.
      ...(result.webSearch.citationClaims.length
        ? { citation_claims: result.webSearch.citationClaims }
        : {}),
      ...(actualProduct?.web_search_credits_per_search !== null && actualProduct?.web_search_credits_per_search !== undefined
        ? { credits_per_search: actualProduct.web_search_credits_per_search }
        : {}),
      ...(actualProduct?.web_research_credits_per_request !== null && actualProduct?.web_research_credits_per_request !== undefined
        ? { credits_per_request: actualProduct.web_research_credits_per_request }
        : {}),
      ...(finalWebSearch?.allowed_domains.length ? { allowed_domains: finalWebSearch.allowed_domains } : {}),
      ...(finalWebSearch?.blocked_domains.length ? { blocked_domains: finalWebSearch.blocked_domains } : {}),
    }

    return assembleOutput(result.text, toResearchCitations(result.citations), {
      topic: opts.topic,
      specific_questions: opts.specific_questions,
      provider: GENSTUDIO_WEB_RESEARCH_PROVIDER,
      model: actualProduct?.id || product?.id || policy?.assigned_model || '',
      mode: 'web-search',
      web_run: webRun,
    })
  }
}

export const genStudioWebResearch: ResearchAdapter = new GenStudioWebResearchAdapter()
