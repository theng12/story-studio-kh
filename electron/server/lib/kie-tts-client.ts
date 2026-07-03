/**
 * kie.ai ElevenLabs TTS client — a fourth ElevenLabs gateway (alongside direct,
 * fal, and GenAIPro), notable for the cheapest per-character pricing.
 *
 * kie.ai's unified "jobs" API: POST /jobs/createTask returns a taskId; poll
 * /jobs/recordInfo until success, then download the audio from resultUrls[0].
 * Same pattern as the image client (lib/kie-client.ts); this one carries the
 * ElevenLabs TTS input shape and returns the finished audio URL (the audio
 * generator downloads it, mirroring the genaipro/fal path).
 *
 * Docs: https://docs.kie.ai/market/elevenlabs/text-to-speech-multilingual-v2
 *       https://docs.kie.ai/market/elevenlabs/text-to-dialogue-v3
 */
import { redactSecrets } from './redact-secrets.js'

const KIE_BASE_URL = 'https://api.kie.ai/api/v1'
const POLL_INTERVAL = 2000
const MAX_WAIT = 5 * 60 * 1000

/** Catalog key → kie.ai model string. */
const KIE_TTS_MODELS: Record<string, string> = {
  'kie-eleven-turbo-v2.5': 'elevenlabs/text-to-speech-turbo-2-5',
  'kie-eleven-multilingual-v2': 'elevenlabs/text-to-speech-multilingual-v2',
  'kie-eleven-v3': 'elevenlabs/text-to-dialogue-v3',
}

export function kieTtsModelFor(catalogKey: string | undefined): string | undefined {
  return catalogKey ? KIE_TTS_MODELS[catalogKey] : undefined
}
export function isKieTtsModel(catalogKey: string | undefined): boolean {
  return !!kieTtsModelFor(catalogKey)
}

export interface KieTtsOptions {
  /** Catalog key (e.g. 'kie-eleven-turbo-v2.5'). */
  model?: string
  /** ElevenLabs voice id (kie's `voice` field). Required. */
  voiceId?: string
  stability?: number
  similarity?: number
  style?: number
  /** 0.7–1.2 */
  speed?: number
  signal?: AbortSignal
  isCancelled?: () => boolean
}

export function buildKieTtsInput(kieModel: string, text: string, opts: KieTtsOptions): Record<string, any> {
  const voice = opts.voiceId || ''
  const num = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  // text-to-dialogue-v3 takes an array of turns; narration is a single turn.
  if (kieModel.endsWith('text-to-dialogue-v3')) {
    const input: Record<string, any> = { dialogue: [{ text, voice }] }
    if (num(opts.stability) !== undefined) input.stability = opts.stability
    return input
  }
  const input: Record<string, any> = { text, voice }
  if (num(opts.stability) !== undefined) input.stability = opts.stability
  if (num(opts.similarity) !== undefined) input.similarity_boost = opts.similarity
  if (num(opts.style) !== undefined) input.style = opts.style
  if (num(opts.speed) !== undefined) input.speed = opts.speed
  return input
}

async function submitTask(text: string, apiKey: string, opts: KieTtsOptions): Promise<string> {
  const kieModel = kieTtsModelFor(opts.model)
  if (!kieModel) throw new Error(`Unknown kie.ai TTS model: ${opts.model}`)
  if (!opts.voiceId) throw new Error('A voice is required for kie.ai ElevenLabs TTS.')

  const resp = await fetch(`${KIE_BASE_URL}/jobs/createTask`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: kieModel, input: buildKieTtsInput(kieModel, text, opts) }),
    signal: opts.signal ?? AbortSignal.timeout(30_000),
  })
  if (!resp.ok) {
    const t = await resp.text().catch(() => '')
    throw new Error(`kie.ai createTask ${resp.status}: ${redactSecrets(t, apiKey).slice(0, 200)}`)
  }
  const data = (await resp.json()) as any
  if (data?.code && data.code !== 200 && data.code !== '200') {
    throw new Error(`kie.ai createTask error: ${redactSecrets(data.msg || JSON.stringify(data), apiKey).slice(0, 200)}`)
  }
  const taskId = data?.data?.taskId || data?.taskId || data?.data?.task_id
  if (!taskId) throw new Error(`kie.ai: no taskId in response: ${redactSecrets(JSON.stringify(data), apiKey).slice(0, 200)}`)
  return String(taskId)
}

function extractAudioUrl(taskData: any): string | null {
  const r = taskData.response
  if (r && typeof r === 'object') {
    const urls = r.resultUrls || r.audioUrls || []
    if (Array.isArray(urls) && urls.length) return urls.find((u: any) => typeof u === 'string' && u) || null
    if (r.resultUrl || r.audioUrl) return r.resultUrl || r.audioUrl
  }
  if (taskData.resultJson) {
    try {
      const rj = typeof taskData.resultJson === 'string' ? JSON.parse(taskData.resultJson) : taskData.resultJson
      const urls = rj.resultUrls || rj.audioUrls || []
      if (Array.isArray(urls) && urls.length) return urls.find((u: any) => typeof u === 'string' && u) || null
    } catch { /* ignore */ }
  }
  const single = taskData.resultUrl || taskData.audioUrl || taskData.outputUrl
  return typeof single === 'string' && single ? single : null
}

function sleep(ms: number): Promise<void> {
  return new Promise(res => setTimeout(res, ms))
}

async function pollAudioUrl(taskId: string, apiKey: string, opts: KieTtsOptions): Promise<string> {
  const deadline = Date.now() + MAX_WAIT
  const headers = { Authorization: `Bearer ${apiKey}` }
  while (Date.now() < deadline) {
    if (opts.isCancelled?.()) throw new Error('Cancelled by user')
    const resp = await fetch(`${KIE_BASE_URL}/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`, {
      headers, signal: AbortSignal.timeout(30_000),
    })
    if (resp.ok) {
      const data = (await resp.json()) as any
      const taskData = data.data || data
      let status: string
      const flag = taskData.successFlag
      if (flag !== undefined && flag !== null) status = flag === 1 ? 'success' : flag >= 2 ? 'failed' : 'pending'
      else status = String(taskData.state || taskData.status || '').toLowerCase()

      if (['success', 'completed', 'finished', 'succeed'].includes(status)) {
        const url = extractAudioUrl(taskData)
        if (url) return url
        throw new Error('kie.ai TTS succeeded but no audio URL in response')
      }
      if (['failed', 'error', 'fail'].includes(status)) {
        throw new Error(`kie.ai TTS failed: ${redactSecrets(taskData.errorMessage || taskData.error || 'provider reported failure', apiKey)}`)
      }
    }
    await sleep(POLL_INTERVAL)
  }
  throw new Error(`kie.ai TTS did not complete within ${MAX_WAIT / 1000}s`)
}

/** Submit + poll; returns the finished audio file URL (caller downloads it). */
export async function generateTtsToUrl(text: string, apiKey: string, opts: KieTtsOptions): Promise<string> {
  const taskId = await submitTask(text, apiKey, opts)
  return pollAudioUrl(taskId, apiKey, opts)
}
