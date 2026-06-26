/**
 * Conversational Co-writer (v1.0.271; multimodal v1.0.283).
 *
 * A chat surface where the user develops an idea / outline / full script with
 * the app's LLM, then sends the result into the pipeline via the existing
 * bring-your-own import endpoints (v1.0.269). Stateless: the frontend holds the
 * message history and sends it whole each turn; we render it into a single
 * prompt for callAi (which is single-turn) under a co-writer system prompt.
 *
 *   POST /api/projects/:slug/cowriter/chat      { model, messages[], images? } → { reply }
 *   POST /api/projects/:slug/cowriter/finalize  { model, messages[], target } →
 *        { target:'script'|'outline', text } | { target:'idea', idea }
 *
 * The finalize pass extracts a clean artifact in the exact shape the import
 * endpoints expect; the frontend shows it for review, then commits it.
 *
 * v1.0.283 — `chat` accepts an optional `images: string[]` (base64 data URLs)
 * on the LAST user turn. The Co-writer frontend caps these at 512×512 / 20
 * per thread and gates the model picker to vision-capable models when any
 * image is attached, so this endpoint just passes them through to callAi.
 * `finalize` does NOT take images — finalization is text-only because the
 * extracted artifact (script / outline / idea) is purely textual.
 */

import { Router } from 'express'
import * as pm from '../services/project-manager.js'
import { callAi, callAiWithRetry } from '../lib/ai-client.js'
import { getApiKey } from '../services/app-secrets-store.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'

export const router = Router()

const CHAT_SYSTEM =
  `You are a collaborative co-writer for a video creator. Help them develop and refine their video's idea, outline, or full narration script through natural conversation. Ask a brief clarifying question when it genuinely helps, but lean toward producing concrete, usable drafts and iterating on the creator's feedback. When they ask for a script, write real spoken-narration prose (not bullet advice). When they ask for an outline, give a clean chapter list. Keep replies focused and free of meta-commentary about being an AI.`

const FINALIZE: Record<string, string> = {
  script: `Now, based ONLY on the conversation above, output the finished narration script ready for production. Use "## Chapter 1: Title" headings for each chapter (and a "# Introduction" heading for an opening if the conversation calls for one). Write natural spoken-narration prose under each heading. Output ONLY the script — no commentary, no preamble, no markdown code fences.`,
  outline: `Now, based ONLY on the conversation above, output the chapter outline as ONE chapter per line, each in the form "Chapter N: Title — one-line synopsis". Output ONLY the list — no commentary, no preamble.`,
  idea: `Now, based ONLY on the conversation above, output a single JSON object with keys "title" (string), "logline" (one-sentence string), and "themes" (array of 2-5 short keyword strings). Output ONLY the JSON object — no other text, no code fences.`,
}

interface ChatMsg { role: 'user' | 'assistant'; content: string }

function renderHistory(messages: ChatMsg[]): string {
  return messages
    .filter(m => m && typeof m.content === 'string' && m.content.trim())
    .map(m => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content.trim()}`)
    .join('\n\n')
}

async function apiKeys() {
  const [anthropic_api_key, openai_api_key, kie_api_key] = await Promise.all([
    getApiKey('anthropic').catch(() => ''),
    getApiKey('openai').catch(() => ''),
    getApiKey('kie').catch(() => ''),
  ])
  return { anthropic_api_key, openai_api_key, kie_api_key }
}

function readReq(req: any): { model: string; messages: ChatMsg[]; images: string[] } {
  const model = typeof req.body?.model === 'string' ? req.body.model.trim() : ''
  const messages: ChatMsg[] = Array.isArray(req.body?.messages)
    ? req.body.messages.filter((m: any) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    : []
  // v1.0.283 — optional images on the latest user turn. Each entry MUST be a
  // base64 data URL (data:image/png;base64,…). We don't validate the bytes —
  // the LLM provider's API surfaces a clear error if the encoding is bad.
  // Frontend caps at 20 images / 512×512 each before sending; we trust that.
  const images: string[] = Array.isArray(req.body?.images)
    ? req.body.images
      .filter((s: any) => typeof s === 'string' && s.startsWith('data:image/'))
      .slice(0, 20)
    : []
  return { model, messages, images }
}

router.post('/projects/:slug/cowriter/chat', async (req, res) => {
  const { slug } = req.params
  if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
  const { model, messages, images } = readReq(req)
  if (!model) return res.status(400).json({ detail: 'model is required' })
  if (!messages.length) return res.status(400).json({ detail: 'messages is required' })
  try {
    const userMsg = `Conversation so far:\n\n${renderHistory(messages)}\n\nReply as the Assistant with ONLY your next message.`
    // v1.0.283 — images forwarded via the callAi context. Providers that
    // don't implement vision ignore the field; we trust the frontend's
    // model gating to not route images to text-only models.
    const reply = await callAiWithRetry(model, CHAT_SYSTEM, userMsg, await apiKeys(), false, {
      slug,
      images: images.length > 0 ? images : undefined,
    })
    res.json({ reply: (reply || '').trim() })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Co-writer chat failed'))
  }
})

router.post('/projects/:slug/cowriter/finalize', async (req, res) => {
  const { slug } = req.params
  if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
  const { model, messages } = readReq(req)
  const target = ['script', 'outline', 'idea'].includes(req.body?.target) ? req.body.target as string : ''
  if (!model) return res.status(400).json({ detail: 'model is required' })
  if (!messages.length) return res.status(400).json({ detail: 'messages is required' })
  if (!target) return res.status(400).json({ detail: 'target must be script | outline | idea' })
  try {
    const sys = `${CHAT_SYSTEM}\n\n${FINALIZE[target]}`
    const out = ((await callAiWithRetry(model, sys, renderHistory(messages), await apiKeys(), false, { slug })) || '').trim()
    if (target === 'idea') {
      let idea = { title: '', logline: '', themes: [] as string[] }
      try {
        const s = out.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim()
        const json = JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1))
        idea = {
          title: String(json.title || '').trim(),
          logline: String(json.logline || '').trim(),
          themes: Array.isArray(json.themes) ? json.themes.map((t: any) => String(t).trim()).filter(Boolean).slice(0, 8) : [],
        }
      } catch { /* leave blank — frontend lets the user edit */ }
      return res.json({ target, idea })
    }
    res.json({ target, text: out })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Co-writer finalize failed'))
  }
})
