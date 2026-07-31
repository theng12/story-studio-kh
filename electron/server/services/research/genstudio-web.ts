/**
 * GenStudio web-search Research adapter ("Search the web" mode).
 *
 * Same GenStudio boundary as the model-knowledge adapter — same key, same
 * `/v1/chat/completions` path — with two differences that matter:
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
import { callChatWithGenStudio, listChatModels } from '../../lib/genstudio-client.js'
import { JSON_OBJECT_OUTPUT_CONTRACT } from '../../lib/json-output-contract.js'
import type { ResearchAdapter } from './types.js'
import type { ResearchOutput, ResearchRunOptions, ResearchWebRunReport } from '../../models/types.js'
import { buildResearchPrompt, assembleOutput } from './prompt.js'
import {
  WEB_MODE_UNAVAILABLE_REASON,
  buildWebSearchBlock,
  isWebResearchQualified,
  selectWebResearchModels,
  toResearchCitations,
} from './web-capability.js'

export const GENSTUDIO_WEB_RESEARCH_PROVIDER = 'genstudio-web' as const

class GenStudioWebResearchAdapter implements ResearchAdapter {
  readonly provider = GENSTUDIO_WEB_RESEARCH_PROVIDER
  readonly displayName = 'GenStudio web search'
  readonly helperText =
    'Searches the web through a qualified GenStudio model and records the sources it read.'

  async isConfigured(): Promise<boolean> {
    const key = await getApiKey('genstudio').catch(() => '')
    return !!key.trim()
  }

  async run(opts: ResearchRunOptions): Promise<ResearchOutput> {
    const apiKey = await getApiKey('genstudio').catch(() => '')
    if (!apiKey) {
      throw new Error('No scoped GenStudio API key configured. Add it in Settings → This Mac before running research.')
    }

    const qualified = selectWebResearchModels(await listChatModels(apiKey))
    if (!qualified.length) throw new Error(WEB_MODE_UNAVAILABLE_REASON)

    // An explicitly requested model is honoured only if it still qualifies.
    // Healing to a different product would change what the user is charged
    // for without telling them, so an unqualified request is refused by name.
    const requested = opts.model?.trim() || ''
    let product = qualified[0]!
    if (requested) {
      const match = qualified.find(model => model.id === requested)
      if (!match) {
        throw new Error(
          `"${requested}" cannot be used for web research: it is not a model that returns structured citations and `
          + 'is qualified for research. Pick one of the models offered for web search, or use model-knowledge mode.',
        )
      }
      product = match
    }
    // Defensive: the list above is already filtered, but the qualification rule
    // is the one thing that must never be bypassed by a future refactor.
    if (!isWebResearchQualified(product)) throw new Error(WEB_MODE_UNAVAILABLE_REASON)

    const webSearch = buildWebSearchBlock(product, opts.web_search, opts.max_sources ?? null)
    const { system, user } = buildResearchPrompt(opts, 'web')

    const result = await callChatWithGenStudio(apiKey, {
      modelId: product.id,
      system,
      userMessage: user,
      outputContract: JSON_OBJECT_OUTPUT_CONTRACT,
      // Same long-form shape as model-knowledge research, and the same
      // truncation risk — web mode also has to fit its sources in.
      outputBudget: 'long',
      webSearch,
    }).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`GenStudio web research failed: ${message}`)
    })

    // Report what GenStudio actually reported, and nothing more. A null field
    // stays ABSENT so the UI can say "not reported" instead of showing a
    // number this app made up. Field names are GenStudio's confirmed contract
    // (schemas.py :: OpenAIChatCompletionResponse), not the names v1.0.764
    // guessed.
    const webRun: ResearchWebRunReport = {
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
      ...(product.web_search_credits_per_search !== null
        ? { credits_per_search: product.web_search_credits_per_search }
        : {}),
      ...(product.web_research_credits_per_request !== null
        ? { credits_per_request: product.web_research_credits_per_request }
        : {}),
      ...(webSearch.allowed_domains.length ? { allowed_domains: webSearch.allowed_domains } : {}),
      ...(webSearch.blocked_domains.length ? { blocked_domains: webSearch.blocked_domains } : {}),
    }

    return assembleOutput(result.text, toResearchCitations(result.citations), {
      topic: opts.topic,
      specific_questions: opts.specific_questions,
      provider: GENSTUDIO_WEB_RESEARCH_PROVIDER,
      model: product.id,
      mode: 'web-search',
      web_run: webRun,
    })
  }
}

export const genStudioWebResearch: ResearchAdapter = new GenStudioWebResearchAdapter()
