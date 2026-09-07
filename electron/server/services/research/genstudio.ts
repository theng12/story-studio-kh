/**
 * GenStudio-only Research adapter.
 *
 * Story Studio never resolves or stores an upstream LLM provider key here.
 * The shared AI client accepts a published GenStudio model id (or an explicit
 * legacy alias), and its provider boundary rejects every non-GenStudio route.
 */

import { getApiKey } from '../app-secrets-store.js'
import { callAiWithRetry } from '../../lib/ai-client.js'
import { resolveDefaultChatModel } from '../genstudio-default-model.js'
import { JSON_OBJECT_OUTPUT_CONTRACT } from '../../lib/json-output-contract.js'
import type { ResearchAdapter } from './types.js'
import type { ResearchOutput, ResearchRunOptions } from '../../models/types.js'
import { buildResearchPrompt, assembleOutput } from './prompt.js'

class GenStudioResearchAdapter implements ResearchAdapter {
  readonly provider = 'llm-only' as const
  readonly displayName = 'GenStudio LLM'
  readonly helperText =
    'Uses the model’s own knowledge through your published GenStudio catalog. Reliable on well-established '
    + 'facts, but it cannot cite live sources.'

  async isConfigured(): Promise<boolean> {
    const key = await getApiKey('genstudio').catch(() => '')
    return !!key.trim()
  }

  async run(opts: ResearchRunOptions): Promise<ResearchOutput> {
    const requestedModel = opts.model?.trim() || ''
    // A missing model is resolved against GenStudio's live catalog rather
    // than a hardcoded external product id — GenStudio owns the catalog and
    // a retired/renamed literal must never be submitted blind.
    let model = requestedModel
    if (!model) {
      const apiKey = await getApiKey('genstudio').catch(() => '')
      if (!apiKey) throw new Error('No GenStudio API key configured. Add it in Settings → This Mac before running research.')
      model = (await resolveDefaultChatModel(apiKey)).modelId
    }
    const { system, user } = buildResearchPrompt(opts, 'llm-only')
    // Long-form: a research pass returns a summary, a claims list, a citation
    // list and an episode outline in one JSON object. The 2,048-token
    // short-form default truncated it, which GenStudio then refused to settle.
    const raw = await callAiWithRetry(model, system, user, {}, false, {
      // A research pass IS one JSON object — `assembleOutput` parses it. Asking
      // for prose and hoping left the model free to wrap that object in
      // commentary, and a prose-wrapped response is discarded after it has
      // already been paid for. The web adapter has always declared this
      // contract; the model-knowledge adapter now declares the same one.
      outputContract: JSON_OBJECT_OUTPUT_CONTRACT,
      outputBudget: 'long',
      requestIdentity: opts.request_identity,
    }).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`GenStudio research failed: ${message}`)
    })

    return assembleOutput(raw, [], {
      topic: opts.topic,
      specific_questions: opts.specific_questions,
      provider: 'llm-only',
      model,
      mode: 'model-knowledge',
    })
  }
}

export const genStudioResearch: ResearchAdapter = new GenStudioResearchAdapter()
