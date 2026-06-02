/**
 * kie.ai text provider. Self-registers with the provider registry on import.
 *
 * kie.ai's chat surface is NOT one uniform endpoint — it's a patchwork of
 * per-family shapes, each reached at a different path, with inconsistent
 * slug formatting (some dotted, some hyphenated). We route every kie chat
 * model through an explicit table (KIE_CHAT_MODELS) keyed by our internal
 * `-kie`-suffixed id, so each entry is intentional and verifiable:
 *
 *   • Claude  → Anthropic Messages API  `https://api.kie.ai/claude/v1/messages`
 *               (one shared endpoint; the model id rides in the body)
 *   • GPT-5.2 → OpenAI chat-completions  `https://api.kie.ai/gpt-5-2/v1/chat/completions`
 *   • GPT-5.4 / 5.5 → OpenAI Responses API `https://api.kie.ai/codex/v1/responses`
 *   • Gemini  → OpenAI-compatible chat    `https://api.kie.ai/<slug>/v1/chat/completions`
 *               (slugs are inconsistent: gemini-3-pro / gemini-3-flash /
 *                gemini-2-5-pro use hyphens, but gemini-2.5-flash /
 *                gemini-3.1-pro keep the dot — verified against the docs)
 *
 * Every model authenticates with the single `kie_api_key`. (The old kie
 * DeepSeek models were retired in v1.0.235 — kie dropped support; use the
 * official DeepSeek provider instead.)
 *
 * Slugs verified against https://docs.kie.ai/market/* on 2026-06-03.
 * Models that only expose a non-chat shape (Gemini 3.5 Flash → Google-native
 * generateContent; OpenAI Codex → coding-agent) are intentionally NOT listed
 * here — they'd need their own adapter.
 */

import OpenAI from 'openai'
import Anthropic from '@anthropic-ai/sdk'
import { registry } from '../registry.js'
import { redactSecrets } from '../../lib/redact-secrets.js'
import type { TextProvider, TextGenerationRequest } from '../types.js'

type KieShape = 'anthropic' | 'openai-chat' | 'openai-responses'

interface KieChatModel {
  /** The exact model identifier kie expects (in the body, and usually the path). */
  slug: string
  shape: KieShape
  /** Base URL the SDK is pointed at; the SDK appends the shape's path. */
  baseURL: string
}

/**
 * Explicit catalog of the kie.ai chat models we expose. Keyed by our internal
 * `<slug>-kie` id (what the model dropdown + jobs persist). DO NOT derive the
 * slug or base URL algorithmically — kie's formatting is inconsistent enough
 * that only an explicit table is safe.
 */
const KIE_CHAT_MODELS: Record<string, KieChatModel> = {
  // ── Claude (Anthropic Messages shape, one shared endpoint) ──────────────
  'claude-opus-4-8-kie':   { slug: 'claude-opus-4-8',   shape: 'anthropic', baseURL: 'https://api.kie.ai/claude' },
  'claude-opus-4-7-kie':   { slug: 'claude-opus-4-7',   shape: 'anthropic', baseURL: 'https://api.kie.ai/claude' },
  'claude-opus-4-6-kie':   { slug: 'claude-opus-4-6',   shape: 'anthropic', baseURL: 'https://api.kie.ai/claude' },
  'claude-opus-4-5-kie':   { slug: 'claude-opus-4-5',   shape: 'anthropic', baseURL: 'https://api.kie.ai/claude' },
  'claude-sonnet-4-6-kie': { slug: 'claude-sonnet-4-6', shape: 'anthropic', baseURL: 'https://api.kie.ai/claude' },
  'claude-sonnet-4-5-kie': { slug: 'claude-sonnet-4-5', shape: 'anthropic', baseURL: 'https://api.kie.ai/claude' },
  'claude-haiku-4-5-kie':  { slug: 'claude-haiku-4-5',  shape: 'anthropic', baseURL: 'https://api.kie.ai/claude' },

  // ── GPT ──────────────────────────────────────────────────────────────
  // 5.2 is the OpenAI chat-completions shape at its own path; 5.4 + 5.5 moved
  // to the unified `/codex/v1/responses` Responses-API endpoint.
  'gpt-5-2-kie': { slug: 'gpt-5-2', shape: 'openai-chat',      baseURL: 'https://api.kie.ai/gpt-5-2/v1' },
  'gpt-5-4-kie': { slug: 'gpt-5-4', shape: 'openai-responses', baseURL: 'https://api.kie.ai/codex/v1' },
  'gpt-5-5-kie': { slug: 'gpt-5-5', shape: 'openai-responses', baseURL: 'https://api.kie.ai/codex/v1' },

  // ── Gemini (OpenAI-compatible chat; note the inconsistent slugs) ────────
  'gemini-3-pro-kie':     { slug: 'gemini-3-pro',     shape: 'openai-chat', baseURL: 'https://api.kie.ai/gemini-3-pro/v1' },
  'gemini-3-flash-kie':   { slug: 'gemini-3-flash',   shape: 'openai-chat', baseURL: 'https://api.kie.ai/gemini-3-flash/v1' },
  'gemini-3.1-pro-kie':   { slug: 'gemini-3.1-pro',   shape: 'openai-chat', baseURL: 'https://api.kie.ai/gemini-3.1-pro/v1' },
  'gemini-2-5-pro-kie':   { slug: 'gemini-2-5-pro',   shape: 'openai-chat', baseURL: 'https://api.kie.ai/gemini-2-5-pro/v1' },
  'gemini-2.5-flash-kie': { slug: 'gemini-2.5-flash', shape: 'openai-chat', baseURL: 'https://api.kie.ai/gemini-2.5-flash/v1' },
}

/** Map a kie API error into a friendly, secret-free message. */
function kieError(err: any, apiKey: string, signal?: AbortSignal): Error {
  if (err?.name === 'AbortError' || signal?.aborted) {
    return new Error('Cancelled by user')
  }
  const rawMsg = err instanceof Error ? err.message : String(err)
  const msg = redactSecrets(rawMsg, apiKey)
  if (msg.includes('401') || msg.includes('invalid x-api-key')) {
    return new Error('kie.ai API key is invalid or expired. Check Settings → API Keys.')
  }
  if (msg.includes('429') || msg.includes('rate_limit')) {
    return new Error('kie.ai rate limit exceeded. Wait a moment and try again.')
  }
  return new Error(`kie.ai API error: ${msg}`)
}

/** Claude-via-kie — Anthropic Messages API at a kie base URL. */
async function callAnthropicShape(
  entry: KieChatModel, req: TextGenerationRequest,
): Promise<string> {
  const { system, userMessage, apiKey, stream, maxTokens, signal } = req
  const client = new Anthropic({ apiKey, baseURL: entry.baseURL })
  const reqOpts = signal ? { signal } : undefined

  if (stream) {
    const collected: string[] = []
    const streamObj = client.messages.stream({
      model: entry.slug,
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
  }
  const response = await client.messages.create({
    model: entry.slug,
    max_tokens: maxTokens || 8000,
    system,
    messages: [{ role: 'user', content: userMessage }],
  }, reqOpts)
  const block = response.content[0]
  return block && block.type === 'text' ? block.text : ''
}

/** GPT/Gemini-via-kie — OpenAI chat-completions at a kie base URL. */
async function callOpenAiChatShape(
  entry: KieChatModel, req: TextGenerationRequest,
): Promise<string> {
  const { system, userMessage, apiKey, stream, maxTokens, signal } = req
  const client = new OpenAI({ apiKey, baseURL: entry.baseURL })
  const reqOpts = signal ? { signal } : undefined
  const messages = [
    { role: 'system' as const, content: system },
    { role: 'user' as const, content: userMessage },
  ]

  if (stream) {
    const collected: string[] = []
    const response = await client.chat.completions.create({
      model: entry.slug,
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
    model: entry.slug,
    max_tokens: maxTokens || 8000,
    messages,
  }, reqOpts)
  return response.choices[0]?.message?.content || ''
}

/** GPT-5.4/5.5-via-kie — OpenAI Responses API at `/codex/v1/responses`.
 *  We always read the full text (no token streaming); callText returns the
 *  whole string anyway, so this only loses abort granularity mid-response. */
async function callOpenAiResponsesShape(
  entry: KieChatModel, req: TextGenerationRequest,
): Promise<string> {
  const { system, userMessage, apiKey, maxTokens, signal } = req
  const client = new OpenAI({ apiKey, baseURL: entry.baseURL })
  const reqOpts = signal ? { signal } : undefined

  const response = await client.responses.create({
    model: entry.slug,
    instructions: system || undefined,
    input: userMessage,
    max_output_tokens: maxTokens || 16000,
  }, reqOpts)
  return response.output_text || ''
}

const kieTextProvider: TextProvider = {
  meta: {
    id: 'kie',
    name: 'kie.ai',
    apiKeyField: 'kie_api_key',
  },

  supportsModel(modelId: string): boolean {
    return modelId in KIE_CHAT_MODELS
  },

  async callText(request: TextGenerationRequest): Promise<string> {
    const { model, apiKey, signal } = request

    if (!apiKey) {
      throw new Error('No kie.ai API key configured. Add one in Settings → API Keys.')
    }

    const entry = KIE_CHAT_MODELS[model]
    if (!entry) throw new Error(`Unsupported kie.ai model: ${model}`)
    try {
      switch (entry.shape) {
        case 'anthropic':        return await callAnthropicShape(entry, request)
        case 'openai-responses': return await callOpenAiResponsesShape(entry, request)
        case 'openai-chat':
        default:                 return await callOpenAiChatShape(entry, request)
      }
    } catch (err: any) {
      throw kieError(err, apiKey, signal)
    }
  },
}

/** Exposed for the catalog/health route + tests — the kie chat model ids
 *  this provider can route, in display order. */
export const KIE_CHAT_MODEL_IDS = Object.keys(KIE_CHAT_MODELS)

// Self-register
registry.registerText(kieTextProvider)
