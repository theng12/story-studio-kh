/**
 * OpenRouter text provider. Self-registers with the provider registry on import.
 *
 * OpenRouter is a plain OpenAI-compatible gateway: one base URL
 * (`https://openrouter.ai/api/v1`), Bearer auth, model specified by slug
 * (e.g. `deepseek/deepseek-v4-flash`). The optional HTTP-Referer / X-Title
 * headers identify the app on OpenRouter's rankings (harmless, not required).
 *
 * Curated, exact-match catalog — we deliberately expose only a hand-picked
 * set rather than OpenRouter's full model list. Keyed by our internal id
 * (`<name>-openrouter`) → the upstream OpenRouter slug. Add a line per model.
 *
 * App-level key only (`openrouter` secret bucket); callAi tier-3 resolves it.
 */

import OpenAI from 'openai'
import { registry } from '../registry.js'
import { redactSecrets } from '../../lib/redact-secrets.js'
import type { TextProvider, TextGenerationRequest, TextGenerationDiagnostics } from '../types.js'

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1'

/** Internal id → OpenRouter model slug. Exact-match only (no prefix claim). */
const MODELS: Record<string, string> = {
  'deepseek-v4-flash-openrouter': 'deepseek/deepseek-v4-flash',
}

/** OpenRouter-specific request fields are not part of the OpenAI SDK's
 * generated types, even though OpenRouter accepts them on this endpoint. */
export function openRouterRequestExtras(request: Pick<TextGenerationRequest, 'jsonMode' | 'disableReasoning' | 'temperature'>): Record<string, unknown> {
  return {
    ...(request.jsonMode ? { response_format: { type: 'json_object' } } : {}),
    ...(request.disableReasoning ? { reasoning: { effort: 'none' } } : {}),
    ...(request.temperature != null ? { temperature: request.temperature } : {}),
  }
}

function responseDiagnostics(response: any): TextGenerationDiagnostics {
  const choice = response?.choices?.[0]
  const usage = response?.usage
  return {
    requestId: response?.id,
    model: response?.model,
    provider: response?.provider,
    finishReason: choice?.finish_reason,
    nativeFinishReason: choice?.native_finish_reason,
    promptTokens: usage?.prompt_tokens,
    completionTokens: usage?.completion_tokens,
    reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens,
    totalTokens: usage?.total_tokens,
  }
}

const openrouterProvider: TextProvider = {
  meta: {
    id: 'openrouter',
    name: 'OpenRouter',
    apiKeyField: 'openrouter_api_key',
  },

  supportsModel(modelId: string): boolean {
    return modelId in MODELS
  },

  async callText(request: TextGenerationRequest): Promise<string> {
    const { model, system, userMessage, apiKey, stream, maxTokens, signal } = request

    if (!apiKey) {
      throw new Error('No OpenRouter API key configured. Add one in Settings → API Keys.')
    }

    const slug = MODELS[model]
    if (!slug) throw new Error(`Unsupported OpenRouter model: ${model}`)

    const client = new OpenAI({
      apiKey,
      baseURL: OPENROUTER_BASE,
      defaultHeaders: {
        'HTTP-Referer': 'https://story-studio-kh.local',
        'X-Title': 'Story Studio KH',
      },
    })
    const reqOpts = signal ? { signal } : undefined
    const messages = [
      { role: 'system' as const, content: system },
      { role: 'user' as const, content: userMessage },
    ]
    const extras = openRouterRequestExtras(request)

    try {
      if (stream) {
        const collected: string[] = []
        const response: any = await client.chat.completions.create({
          model: slug,
          max_tokens: maxTokens || 16000,
          messages,
          stream: true,
          ...extras,
        } as any, reqOpts)
        let lastChunk: any
        for await (const chunk of response) {
          lastChunk = chunk
          const delta = chunk.choices[0]?.delta?.content
          if (delta) collected.push(delta)
        }
        if (lastChunk) request.onDiagnostics?.(responseDiagnostics(lastChunk))
        return collected.join('')
      }
      const response = await client.chat.completions.create({
        model: slug,
        max_tokens: maxTokens || 8000,
        messages,
        ...extras,
      } as any, reqOpts)
      request.onDiagnostics?.(responseDiagnostics(response))
      return response.choices[0]?.message?.content || ''
    } catch (err: any) {
      if (err?.name === 'AbortError' || signal?.aborted) {
        throw new Error('Cancelled by user', { cause: err })
      }
      const msg = redactSecrets(err instanceof Error ? err.message : String(err), apiKey)
      if (msg.includes('401')) {
        throw new Error('OpenRouter API key is invalid or expired. Check Settings → API Keys.', { cause: err })
      }
      if (msg.includes('402')) {
        throw new Error('OpenRouter account is out of credit. Top up at openrouter.ai.', { cause: err })
      }
      throw new Error(`OpenRouter API error: ${msg}`, { cause: err })
    }
  },
}

/** Exposed for the catalog/health route + tests. */
export const OPENROUTER_MODEL_IDS = Object.keys(MODELS)

// Self-register
registry.registerText(openrouterProvider)
