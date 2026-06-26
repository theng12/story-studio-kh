/**
 * Research adapter: LLM-only with disclaimers (v1.0.142+).
 *
 * No live web access. Uses any existing text provider — OpenAI,
 * Anthropic, or kie.ai — via the shared callAi gateway.
 * The system prompt explicitly tells the LLM:
 *   - Don't fabricate URLs.
 *   - Mark every claim with confidence + a manual-verification path.
 *   - The user does the actual fact-checking after this; the LLM is
 *     just producing a starting checklist.
 *
 * Useful when:
 *   - You don't have a Perplexity key set up.
 *   - You want to draft research outside of work hours without
 *     spending on web-search credits.
 *   - You're researching a topic the LLM's training data covers well
 *     (e.g. canonical historical events) where the value-add of live
 *     web search is marginal.
 *
 * Lower quality than the web-search adapters, but free at the cost
 * of the underlying text-provider call.
 *
 * Defaults to `deepseek-v4-flash` (v1.0.235+ — the project-wide default
 * text model; cheapest). The frontend will offer a model picker in a
 * future iteration; this release ships with a sensible default.
 */

import { getApiKey } from '../app-secrets-store.js'
import { callAi, callAiWithRetry } from '../../lib/ai-client.js'
import type { ResearchAdapter } from './types.js'
import type {
  ResearchOutput,
  ResearchRunOptions,
} from '../../models/types.js'
import { buildResearchPrompt, assembleOutput } from './prompt.js'

const DEFAULT_MODEL = 'deepseek-v4-flash'

class LlmOnlyAdapter implements ResearchAdapter {
  readonly provider = 'llm-only' as const
  readonly displayName = 'LLM-only (no web search)'
  readonly helperText =
    'Drafts a research checklist using your existing LLM provider. No live web search — the LLM marks uncertain claims for manual verification. Use when you don\'t want to pay for web search credits or when training data covers the topic well.'

  async isConfigured(): Promise<boolean> {
    // At least one text-provider key must exist somewhere. Check the
    // ones callAi can resolve (anthropic, openai, kie).
    const keys = await Promise.all([
      getApiKey('anthropic').catch(() => ''),
      getApiKey('openai').catch(() => ''),
      getApiKey('kie').catch(() => ''),
    ])
    return keys.some(k => !!(k && k.trim()))
  }

  async run(opts: ResearchRunOptions): Promise<ResearchOutput> {
    // v1.0.175 — the model is now user-selectable (kie.ai, OpenAI, DeepSeek,
    // Anthropic…). callAi resolves the right provider + key from the model
    // id via the provider registry, so any configured provider works.
    // Falls back to DEFAULT_MODEL only when nothing was picked.
    const model = (opts.model && opts.model.trim()) ? opts.model.trim() : DEFAULT_MODEL

    // Legacy apiKeys bag — callAi prefers the registry/key-store resolver,
    // but we still pass these so the common providers work without a slug.
    const [anthropic_api_key, openai_api_key, kie_api_key] = await Promise.all([
      getApiKey('anthropic').catch(() => ''),
      getApiKey('openai').catch(() => ''),
      getApiKey('kie').catch(() => ''),
    ])

    const { system, user } = buildResearchPrompt(opts, 'llm-only')
    const raw = await callAiWithRetry(
      model,
      system,
      user,
      { anthropic_api_key, openai_api_key, kie_api_key },
      false,
    ).catch((err: any) => {
      throw new Error(`LLM-only research failed: ${err?.message || String(err)}`)
    })

    // No live citations — the LLM was told not to fabricate URLs.
    // assembleOutput merges with any LLM-supplied citations from the
    // JSON (typically empty or canonical references with no URL).
    return assembleOutput(raw, [], {
      topic: opts.topic,
      specific_questions: opts.specific_questions,
      provider: 'llm-only',
      model,
    })
  }
}

export const llmOnly: ResearchAdapter = new LlmOnlyAdapter()
