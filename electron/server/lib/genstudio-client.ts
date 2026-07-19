/**
 * GenStudio KH client boundary for Story Studio.
 *
 * This module knows only the public GenStudio API contract. It has no Studio
 * Hub URL, token, worker list, or direct Voice Studio connection. Keeping that
 * boundary here lets the existing direct/Hub provider remain fully operational
 * while GenStudio is qualified in parallel.
 */

import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import { getGenStudioUrl } from '../services/app-settings.js'
import { runFfmpeg } from './ffmpeg-utils.js'

const POLL_INTERVAL_MS = 1_000
const DEFAULT_TIMEOUT_MS = 20 * 60_000

interface GenStudioJob {
  id: string
  state: 'accepted' | 'reserved' | 'dispatched' | 'running' | 'validating' | 'succeeded' | 'failed' | 'reconciling'
  failure_code?: string | null
  audio_url?: string | null
}

export interface GenStudioTtsRequest {
  text: string
  voiceId?: string
  signal?: AbortSignal
  isCancelled?: () => boolean
  onProgress?: (received: number, total?: number) => void
}

export interface GenStudioVoice {
  id: string
  display_name: string
  language?: string
  description?: string
  provider?: string
  generation_enabled?: boolean
}

export function catalogHasVoice(voices: GenStudioVoice[], voiceId: unknown): boolean {
  if (typeof voiceId !== 'string' || !voiceId.trim()) return false
  return voices.some(voice => voice.id === voiceId.trim() && voice.generation_enabled !== false)
}

function apiBase(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

function requestUrl(baseUrl: string, value: string): string {
  return value.startsWith('http://') || value.startsWith('https://')
    ? value
    : `${apiBase(baseUrl)}${value.startsWith('/') ? '' : '/'}${value}`
}

function authorization(apiKey: string): Record<string, string> {
  if (!apiKey.trim()) throw new Error('No GenStudio KH API key configured. Open Settings → This Mac → API Keys.')
  return { Authorization: `Bearer ${apiKey.trim()}` }
}

async function readJson(response: Response): Promise<any> {
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const detail = typeof body?.detail === 'string' ? body.detail : `HTTP ${response.status}`
    throw new Error(`GenStudio KH request failed: ${detail}`)
  }
  return body
}

/** Fetch the account-visible catalog so callers never need to know voice IDs. */
export async function listVoices(apiKey: string): Promise<GenStudioVoice[]> {
  const baseUrl = await getGenStudioUrl()
  const payload = await readJson(await fetch(`${apiBase(baseUrl)}/v1/voices`, {
    headers: authorization(apiKey),
    signal: AbortSignal.timeout(8_000),
  }))
  if (!Array.isArray(payload)) throw new Error('GenStudio KH returned an invalid voice catalog')
  return payload.map((value: any) => ({
    id: typeof value?.id === 'string' ? value.id.trim() : '',
    display_name: typeof value?.display_name === 'string' ? value.display_name.trim() : '',
    language: typeof value?.language === 'string' ? value.language : undefined,
    description: typeof value?.description === 'string' ? value.description : undefined,
    provider: typeof value?.provider === 'string' ? value.provider : undefined,
    generation_enabled: typeof value?.generation_enabled === 'boolean' ? value.generation_enabled : undefined,
  })).filter((voice: GenStudioVoice) => voice.id && voice.display_name && voice.generation_enabled !== false)
}

async function waitForJob(
  baseUrl: string,
  apiKey: string,
  job: GenStudioJob,
  request: GenStudioTtsRequest,
): Promise<GenStudioJob> {
  const deadline = Date.now() + DEFAULT_TIMEOUT_MS
  let current = job
  while (current.state !== 'succeeded' && current.state !== 'failed') {
    if (request.isCancelled?.()) throw new Error('Cancelled by user')
    if (Date.now() >= deadline) throw new Error('GenStudio KH job timed out while waiting for completion')
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
    const response = await fetch(`${apiBase(baseUrl)}/v1/jobs/${encodeURIComponent(current.id)}`, {
      headers: authorization(apiKey), signal: request.signal,
    })
    current = await readJson(response) as GenStudioJob
  }
  if (current.state === 'failed') {
    throw new Error(`GenStudio KH generation failed${current.failure_code ? ` (${current.failure_code})` : ''}. No direct Studio Hub fallback was attempted.`)
  }
  return current
}

/** Generate a GenStudio API TTS job, then convert its private WAV response to Story's MP3 contract. */
export async function generateTtsToFile(
  apiKey: string,
  outPath: string,
  request: GenStudioTtsRequest,
): Promise<void> {
  const voiceId = request.voiceId?.trim() || ''
  if (!voiceId) throw new Error('Select a GenStudio KH voice before generating audio.')
  const baseUrl = await getGenStudioUrl()
  const idempotencyKey = `story-${randomUUID()}`
  const submitted = await readJson(await fetch(`${apiBase(baseUrl)}/v1/audio/speech`, {
    method: 'POST',
    headers: {
      ...authorization(apiKey),
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({ text: request.text, voice_id: voiceId }),
    signal: request.signal,
  })) as GenStudioJob
  const completed = await waitForJob(baseUrl, apiKey, submitted, request)
  if (!completed.audio_url) throw new Error('GenStudio KH job completed without an audio download URL')

  const tempPath = path.join(os.tmpdir(), `genstudio-audio-${randomUUID()}.wav`)
  try {
    const audioResponse = await fetch(requestUrl(baseUrl, completed.audio_url), {
      headers: authorization(apiKey), signal: request.signal,
    })
    if (!audioResponse.ok) throw new Error(`GenStudio KH audio download failed (HTTP ${audioResponse.status})`)
    const body = audioResponse.body as ReadableStream<Uint8Array> | null
    if (!body) throw new Error('GenStudio KH audio download returned no body')
    const file = await fs.open(tempPath, 'w')
    let received = 0
    try {
      const reader = body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          await file.write(value)
          received += value.length
          request.onProgress?.(received, Number(audioResponse.headers.get('content-length')) || undefined)
        }
      }
    } finally {
      await file.close()
    }
    await fs.mkdir(path.dirname(outPath), { recursive: true })
    await runFfmpeg(['-y', '-i', tempPath, '-c:a', 'libmp3lame', '-b:a', '192k', outPath])
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {})
  }
}
