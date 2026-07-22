/**
 * GenStudio-only Research adapter.
 *
 * Story Studio never resolves or stores an upstream LLM provider key here.
 * The shared AI client accepts a published GenStudio model id (or an explicit
 * legacy alias), and its provider boundary rejects every non-GenStudio route.
 */

import { getApiKey } from '../app-secrets-store.js'
import { callAiWithRetry } from '../../lib/ai-client.js'
import type { ResearchAdapter } from './types.js'
import type { ResearchOutput, ResearchRunOptions } from '../../models/types.js'
import { buildResearchPrompt, assembleOutput } from './prompt.js'

const DEFAULT_MODEL = 'deepseek-v4-flash'

class GenStudioResearchAdapter implements ResearchAdapter {
  readonly provider = 'llm-only' as const
  readonly displayName = 'GenStudio LLM'
  readonly helperText =
    'Uses your published GenStudio language-model catalog. Claims remain unverified until you review them.'

  async isConfigured(): Promise<boolean> {
    const key = await getApiKey('genstudio').catch(() => '')
    return !!key.trim()
  }

  async run(opts: ResearchRunOptions): Promise<ResearchOutput> {
    const model = opts.model?.trim() || DEFAULT_MODEL
    const { system, user } = buildResearchPrompt(opts, 'llm-only')
    const raw = await callAiWithRetry(model, system, user, {}, false).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`GenStudio research failed: ${message}`)
    })

    return assembleOutput(raw, [], {
      topic: opts.topic,
      specific_questions: opts.specific_questions,
      provider: 'llm-only',
      model,
    })
  }
}

export const genStudioResearch: ResearchAdapter = new GenStudioResearchAdapter()
