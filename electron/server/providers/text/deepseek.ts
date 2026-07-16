/**
 * DeepSeek (official) text provider. Self-registers on import.
 *
 * Plain OpenAI-compatible API: base `https://api.deepseek.com`, Bearer auth,
 * model in the body. Verified against https://api-docs.deepseek.com on
 * 2026-06-03 — current models are `deepseek-v4-flash` and `deepseek-v4-pro`
 * (`deepseek-chat` / `deepseek-reasoner` are deprecated 2026/07 and omitted).
 *
 * Exact-match catalog so we never cross-claim the OpenRouter-routed
 * `deepseek-v4-flash-openrouter` id (which startsWith('deepseek') too).
 *
 * App-level key only (`deepseek` secret bucket); callAi tier-3 resolves it.
 */

import OpenAI from 'openai'
import { registry } from '../registry.js'
import { redactSecrets } from '../../lib/redact-secrets.js'
import type { TextProvider, TextGenerationRequest } from '../types.js'

const DEEPSEEK_BASE = 'https://api.deepseek.com'

/** Internal id === upstream slug here, but kept as a table for indirection. */
const MODELS: Record<string, string> = {
  'deepseek-v4-flash': 'deepseek-v4-flash',
  'deepseek-v4-pro': 'deepseek-v4-pro',
}

const deepseekProvider: TextProvider = {
  meta: {
    id: 'deepseek',
    name: 'DeepSeek',
    apiKeyField: 'deepseek_api_key',
  },

  supportsModel(modelId: string): boolean {
    return modelId in MODELS
  },

  async callText(request: TextGenerationRequest): Promise<string> {
    const { model, system, userMessage, apiKey, stream, maxTokens, signal } = request

    if (!apiKey) {
      throw new Error('No DeepSeek API key configured. Add one in Settings → API Keys.')
    }

    const slug = MODELS[model]
    if (!slug) throw new Error(`Unsupported DeepSeek model: ${model}`)

    const client = new OpenAI({ apiKey, baseURL: DEEPSEEK_BASE, maxRetries: 0 })
    const reqOpts = signal ? { signal } : undefined
    const messages = [
      { role: 'system' as const, content: system },
      { role: 'user' as const, content: userMessage },
    ]

    try {
      if (stream) {
        const collected: string[] = []
        const response = await client.chat.completions.create({
          model: slug,
          max_tokens: maxTokens || 16000,
          messages,
          stream: true,
        }, reqOpts)
        for await (const chunk of response) {
          const delta = chunk.choices[0]?.delta?.content
          if (delta) collected.push(delta)
        }
        return collected.join('')
      }
      const response = await client.chat.completions.create({
        model: slug,
        max_tokens: maxTokens || 8000,
        messages,
      }, reqOpts)
      return response.choices[0]?.message?.content || ''
    } catch (err: any) {
      if (err?.name === 'AbortError' || signal?.aborted) {
        throw new Error('Cancelled by user', { cause: err })
      }
      const msg = redactSecrets(err instanceof Error ? err.message : String(err), apiKey)
      if (msg.includes('401')) {
        throw new Error('DeepSeek API key is invalid or expired. Check Settings → API Keys.', { cause: err })
      }
      if (msg.includes('402')) {
        throw new Error('DeepSeek account is out of credit. Top up at platform.deepseek.com.', { cause: err })
      }
      throw new Error(`DeepSeek API error: ${msg}`, { cause: err })
    }
  },
}

/** Exposed for the catalog/health route + tests. */
export const DEEPSEEK_MODEL_IDS = Object.keys(MODELS)

// Self-register
registry.registerText(deepseekProvider)
