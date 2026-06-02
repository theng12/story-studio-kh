/**
 * Research adapter: direct Perplexity API (v1.0.142+).
 *
 * The live-web-search research source. Requires a Perplexity API key
 * (add it under App Settings → API Keys). Combines LLM generation with
 * live web search + citations in one call.
 *
 * API: https://docs.perplexity.ai/api-reference/chat-completions
 *   POST https://api.perplexity.ai/chat/completions
 *   Authorization: Bearer <key>
 *   OpenAI-compatible request shape (model + messages + max_tokens).
 *
 * Models: `sonar`, `sonar-pro`, `sonar-reasoning`. We default to
 * `sonar` (cheapest, ~$1/1M input + $1/1M output as of 2026-04).
 *
 * Citations: Perplexity returns them in the top-level `citations`
 * array as a list of URL strings (sometimes with title), normalized
 * via the shared assembleOutput() helper in prompt.ts.
 */

import OpenAI from 'openai'
import { getApiKey } from '../app-secrets-store.js'
import { redactSecrets } from '../../lib/redact-secrets.js'
import type { ResearchAdapter } from './types.js'
import type {
  ResearchCitation,
  ResearchOutput,
  ResearchRunOptions,
} from '../../models/types.js'
import { buildResearchPrompt, assembleOutput } from './prompt.js'

const PERPLEXITY_BASE = 'https://api.perplexity.ai'
const DEFAULT_MODEL = 'sonar'

class PerplexityAdapter implements ResearchAdapter {
  readonly provider = 'perplexity' as const
  readonly displayName = 'Perplexity (direct)'
  readonly helperText =
    'Direct Perplexity API with live web search + citations. Requires a Perplexity API key (add it under App Settings → API Keys).'

  async isConfigured(): Promise<boolean> {
    const k = await getApiKey('perplexity').catch(() => '')
    return !!(k && k.trim())
  }

  async run(opts: ResearchRunOptions): Promise<ResearchOutput> {
    const apiKey = await getApiKey('perplexity')
    if (!apiKey) {
      throw new Error('Perplexity API key not configured. Add it under App Settings → API Keys.')
    }

    // OpenAI SDK works fine against Perplexity (same wire format).
    const client = new OpenAI({
      apiKey,
      baseURL: PERPLEXITY_BASE,
    })

    const { system, user } = buildResearchPrompt(opts)
    const response = await client.chat.completions.create({
      model: DEFAULT_MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      max_tokens: 4000,
    }).catch((err: any) => {
      const msg = redactSecrets(err?.message || String(err), apiKey)
      if (msg.includes('401') || /invalid.*api.*key/i.test(msg)) {
        throw new Error('Perplexity API key is invalid or expired. Check App Settings → API Keys.')
      }
      if (msg.includes('429') || /rate.?limit/i.test(msg)) {
        throw new Error('Perplexity rate limit hit. Wait a moment and retry, or upgrade your plan.')
      }
      throw new Error(`Perplexity research failed: ${msg}`)
    })

    const raw = response.choices[0]?.message?.content || ''
    // Perplexity attaches citations as a top-level array on the
    // response — typically just URL strings, sometimes structured.
    const topCitations: any[] = (response as any).citations || []
    const liveCitations: ResearchCitation[] = []
    for (const c of topCitations) {
      if (typeof c === 'string') {
        liveCitations.push({ title: c, url: c })
      } else if (c?.url) {
        liveCitations.push({ title: c.title || c.url, url: c.url, snippet: c.snippet })
      }
    }

    return assembleOutput(raw, liveCitations, {
      topic: opts.topic,
      specific_questions: opts.specific_questions,
      provider: 'perplexity',
      model: DEFAULT_MODEL,
    })
  }
}

export const perplexity: ResearchAdapter = new PerplexityAdapter()
