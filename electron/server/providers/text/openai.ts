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

const openaiProvider: TextProvider = {
  meta: {
    id: 'openai',
    name: 'OpenAI',
    apiKeyField: 'openai_api_key',
  },

  supportsModel(modelId: string): boolean {
    if (modelId.startsWith('genaipro-')) return false
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
    // HTTP stream instead of letting the model run to max_tokens.
    const reqOpts = signal ? { signal } : undefined

    try {
      if (stream) {
        const collected: string[] = []
        const response = await client.chat.completions.create({
          model,
          max_tokens: maxTokens || 16000,
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
          max_tokens: maxTokens || 8000,
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
