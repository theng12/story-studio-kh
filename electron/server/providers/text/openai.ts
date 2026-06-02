/**
 * OpenAI text provider (GPT models).
 * Self-registers with the provider registry on import.
 */

import OpenAI from 'openai'
import { registry } from '../registry.js'
import { redactSecrets } from '../../lib/redact-secrets.js'
import type { TextProvider, TextGenerationRequest } from '../types.js'

const MODELS = [
  'gpt-5', 'gpt-5-mini',
  'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano',
  'gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo',
  'o3', 'o3-mini', 'o4-mini', 'o1', 'o1-mini',
]

/**
 * True for OpenAI models that REQUIRE `max_completion_tokens` and reject
 * the legacy `max_tokens` parameter. As of 2026-04 this covers:
 *   - gpt-5 family (gpt-5, gpt-5-mini, …)
 *   - all reasoning models: o1*, o3*, o4*, o5+, o-series
 * Legacy chat completions (gpt-4o, gpt-4.1, gpt-4-turbo, gpt-3.5) still
 * accept `max_tokens`, so we keep using it there to avoid forcing every
 * preset onto the new SDK field. Pattern-based so as new models drop
 * (gpt-6, o5-mini, etc.) they're covered without a code change.
 */
export function isCompletionTokensModel(model: string): boolean {
  const m = model.toLowerCase()
  if (m.startsWith('gpt-5')) return true
  if (/^o[1-9]/.test(m)) return true   // o1, o3, o4-mini, o5, …
  return false
}

const openaiProvider: TextProvider = {
  meta: {
    id: 'openai',
    name: 'OpenAI',
    apiKeyField: 'openai_api_key',
  },

  supportsModel(modelId: string): boolean {
    // `-kie` ids are GPT-via-kie.ai (routed through the kie provider with the
    // kie_api_key) — don't claim them here, or we'd call OpenAI direct with a
    // bogus model id and the wrong key.
    if (modelId.endsWith('-kie')) return false
    return MODELS.includes(modelId)
      || modelId.startsWith('gpt-')
      || /^o[1-9]/.test(modelId)
  },

  async callText(request: TextGenerationRequest): Promise<string> {
    const { model, system, userMessage, apiKey, stream, maxTokens, signal } = request

    if (!apiKey) {
      throw new Error('No OpenAI API key configured. Add one in Settings → API Keys.')
    }

    const client = new OpenAI({ apiKey })

    // Request options (second argument) carries the AbortSignal — the SDK
    // threads it to the underlying fetch, so a user cancel tears down the
    // HTTP stream instead of letting the model run to max output tokens.
    const reqOpts = signal ? { signal } : undefined

    // Token-cap field: legacy chat models accept `max_tokens`; gpt-5 and
    // every reasoning model (o1/o3/o4-…) reject it and require the newer
    // `max_completion_tokens` instead. Detect by family — anything that
    // looks like a reasoning model OR the gpt-5 family takes the new
    // field; gpt-4/gpt-4o/gpt-4-turbo etc. stay on the legacy field.
    const usesCompletionTokens = isCompletionTokensModel(model)
    const tokenCap = maxTokens || (stream ? 16000 : 8000)
    const tokenField = usesCompletionTokens
      ? { max_completion_tokens: tokenCap }
      : { max_tokens: tokenCap }

    try {
      if (stream) {
        const collected: string[] = []
        const response = await client.chat.completions.create({
          model,
          ...tokenField,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: userMessage },
          ],
          stream: true,
        }, reqOpts)
        for await (const chunk of response) {
          const delta = chunk.choices[0]?.delta?.content
          if (delta) collected.push(delta)
        }
        return collected.join('')
      } else {
        const response = await client.chat.completions.create({
          model,
          ...tokenField,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: userMessage },
          ],
        }, reqOpts)
        return response.choices[0]?.message?.content || ''
      }
    } catch (err: any) {
      // Surface user-aborted streams as a cancel error so the queue
      // classifies this as 'cancelled', not 'error'.
      if (err?.name === 'AbortError' || signal?.aborted) {
        throw new Error('Cancelled by user')
      }
      const rawMsg = err instanceof Error ? err.message : String(err)
      const msg = redactSecrets(rawMsg, apiKey)
      if (msg.includes('401') || msg.includes('Incorrect API key')) {
        throw new Error('OpenAI API key is invalid or expired. Check Settings → API Keys.')
      }
      if (msg.includes('429') || msg.includes('Rate limit')) {
        throw new Error('OpenAI rate limit exceeded. Wait a moment and try again.')
      }
      throw new Error(`OpenAI API error: ${msg}`)
    }
  },
}

// Self-register
registry.registerText(openaiProvider)
