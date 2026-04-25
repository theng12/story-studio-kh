/**
 * Anthropic text provider (Claude models).
 * Self-registers with the provider registry on import.
 */

import Anthropic from '@anthropic-ai/sdk'
import { registry } from '../registry.js'
import { redactSecrets } from '../../lib/redact-secrets.js'
import type { TextProvider, TextGenerationRequest } from '../types.js'

const MODELS = [
  'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5',
  'claude-sonnet-4-5-20250514', 'claude-haiku-3-5',
]

const anthropicProvider: TextProvider = {
  meta: {
    id: 'anthropic',
    name: 'Anthropic',
    apiKeyField: 'anthropic_api_key',
  },

  supportsModel(modelId: string): boolean {
    return MODELS.includes(modelId) || modelId.startsWith('claude-')
  },

  async callText(request: TextGenerationRequest): Promise<string> {
    const { model, system, userMessage, apiKey, stream, maxTokens, signal } = request

    if (!apiKey) {
      throw new Error('No Anthropic API key configured. Add one in Settings → API Keys.')
    }

    const client = new Anthropic({ apiKey })

    // Request options (second argument) carries the AbortSignal — the SDK
    // tears down the stream / fetch on abort, so a user cancel stops paying
    // for a long completion that would otherwise run to max_tokens.
    const reqOpts = signal ? { signal } : undefined

    try {
      if (stream) {
        const collected: string[] = []
        const streamObj = client.messages.stream({
          model,
          max_tokens: maxTokens || 16000,
          system,
          messages: [{ role: 'user', content: userMessage }],
        }, reqOpts)
        for await (const event of streamObj) {
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            collected.push(event.delta.text)
          }
        }
        return collected.join('')
      } else {
        const response = await client.messages.create({
          model,
          max_tokens: maxTokens || 8000,
          system,
          messages: [{ role: 'user', content: userMessage }],
        }, reqOpts)
        const block = response.content[0]
        return block.type === 'text' ? block.text : ''
      }
    } catch (err: any) {
      if (err?.name === 'AbortError' || signal?.aborted) {
        throw new Error('Cancelled by user')
      }
      const rawMsg = err instanceof Error ? err.message : String(err)
      const msg = redactSecrets(rawMsg, apiKey)
      if (msg.includes('401') || msg.includes('invalid x-api-key')) {
        throw new Error('Anthropic API key is invalid or expired. Check Settings → API Keys.')
      }
      if (msg.includes('429') || msg.includes('rate_limit')) {
        throw new Error('Anthropic rate limit exceeded. Wait a moment and try again.')
      }
      if (msg.includes('overloaded') || msg.includes('529')) {
        throw new Error('Anthropic API is overloaded. Try again in a few minutes.')
      }
      throw new Error(`Anthropic API error: ${msg}`)
    }
  },
}

// Self-register
registry.registerText(anthropicProvider)
