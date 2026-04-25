/**
 * kie.ai text provider — OpenAI-compatible API for DeepSeek models.
 * Self-registers with the provider registry on import.
 */

import OpenAI from 'openai'
import { registry } from '../registry.js'
import { redactSecrets } from '../../lib/redact-secrets.js'
import type { TextProvider, TextGenerationRequest } from '../types.js'

const MODEL_MAP: Record<string, string> = {
  'deepseek-v3-kie': 'deepseek-chat',
  'deepseek-r1-kie': 'deepseek-reasoner',
}

const kieTextProvider: TextProvider = {
  meta: {
    id: 'kie',
    name: 'kie.ai (DeepSeek)',
    apiKeyField: 'kie_api_key',
  },

  supportsModel(modelId: string): boolean {
    return modelId in MODEL_MAP || modelId.endsWith('-kie')
  },

  async callText(request: TextGenerationRequest): Promise<string> {
    const { model, system, userMessage, apiKey, stream, maxTokens, signal } = request

    if (!apiKey) {
      throw new Error('No kie.ai API key configured. Add one in Settings → API Keys.')
    }

    const actualModel = MODEL_MAP[model] || model
    const client = new OpenAI({
      apiKey,
      baseURL: 'https://api.kie.ai/api/v1',
    })

    const reqOpts = signal ? { signal } : undefined

    try {
      if (stream) {
        const collected: string[] = []
        const response = await client.chat.completions.create({
          model: actualModel,
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
          model: actualModel,
          max_tokens: maxTokens || 8000,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: userMessage },
          ],
        }, reqOpts)
        return response.choices[0]?.message?.content || ''
      }
    } catch (err: any) {
      if (err?.name === 'AbortError' || signal?.aborted) {
        throw new Error('Cancelled by user')
      }
      const rawMsg = err instanceof Error ? err.message : String(err)
      const msg = redactSecrets(rawMsg, apiKey)
      if (msg.includes('401')) {
        throw new Error('kie.ai API key is invalid or expired. Check Settings → API Keys.')
      }
      throw new Error(`kie.ai API error: ${msg}`)
    }
  },
}

// Self-register
registry.registerText(kieTextProvider)
