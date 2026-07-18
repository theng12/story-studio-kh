/**
 * Voice Studio KH audio provider — local TTS modal via Tailscale.
 *
 * v1.0.149+ — mirrors the Chatterbox provider's shape but talks to the
 * Voice Studio KH wrapper (Pinokio-launched FastAPI fronting twelve TTS
 * engine families). The "key" slot in the model registry carries the
 * base URL, not a secret — Tailscale handles auth at the network layer.
 *
 * Every engine this provider can drive — its repo, chunk cap, and which
 * submit field carries the voice — is declared once in the catalog
 * (`VOICESTUDIO_ENGINES` in voicestudio-client.ts). This file just reads
 * the catalog row for the requested model id and builds the submit body.
 * Adding an engine is a one-line catalog append; nothing here changes.
 */

import os from 'os'
import path from 'path'
import fs from 'fs/promises'
import { pathToFileURL } from 'url'
import { randomUUID } from 'crypto'
import { registry } from '../registry.js'
import { runFfmpeg } from '../../lib/ffmpeg-utils.js'
import {
  submitTxt2Speech, pollJob, downloadAudio,
  DEFAULT_VOICESTUDIO_BASE_URL,
  engineForModelId,
  type VoiceStudioTxt2SpeechParams,
} from '../../lib/voicestudio-client.js'
import {
  getHubBackend,
  hubBatchArtifactUrl,
  hubHeaders,
  hubPollBatch,
  hubSubmitJob,
} from '../../lib/studiohub-client.js'
import { parseHubVoiceId } from '../../services/voicestudio-voice-pool.js'
import type { AudioProvider, AudioGenerationRequest, AudioGenerationResult } from '../types.js'

/** A 5,000-character Qwen Base dispatch can legitimately take longer than
 * Studio Hub's generic 10-minute batch window on the 1.7B model. */
export const VOICESTUDIO_HUB_TTS_TIMEOUT_MS = 30 * 60_000

/**
 * Stream a Studio Hub artifact to a file (with progress). The Hub proxy is the
 * only valid download path in Hub mode: it authenticates to the selected worker
 * without exposing or requiring Story Studio to know that worker's credential.
 */
export async function downloadHubArtifactToFile(
  hubUrl: string,
  hubToken: string,
  batchId: string,
  itemIndex: number,
  outPath: string,
  opts: { signal?: AbortSignal; onProgress?: (received: number, total?: number) => void } = {},
): Promise<void> {
  const url = hubBatchArtifactUrl(hubUrl, batchId, itemIndex)
  const resp = await fetch(url, {
    headers: hubHeaders(hubToken),
    ...(opts.signal ? { signal: opts.signal } : {}),
  })
  if (!resp.ok) throw new Error(`Studio Hub artifact download failed (${resp.status}) through ${url}`)
  const total = Number(resp.headers.get('content-length')) || undefined
  await fs.mkdir(path.dirname(outPath), { recursive: true }).catch(() => {})
  const body = resp.body as ReadableStream<Uint8Array> | null
  if (!body) {
    const buf = Buffer.from(await resp.arrayBuffer())
    await fs.writeFile(outPath, buf)
    opts.onProgress?.(buf.length, total)
    return
  }
  const fh = await fs.open(outPath, 'w')
  let received = 0
  try {
    const reader = body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        await fh.write(value)
        received += value.length
        opts.onProgress?.(received, total)
      }
    }
  } finally {
    await fh.close()
  }
}

export function buildVoiceStudioParams(req: AudioGenerationRequest): VoiceStudioTxt2SpeechParams {
  // Everything about an engine — repo, and which submit field carries the
  // voice — comes from the catalog (VOICESTUDIO_ENGINES in the client).
  const engine = engineForModelId(req.modelId)
  if (!engine) {
    throw new Error(`Voice Studio provider received unknown model id '${req.modelId}'.`)
  }
  const params: VoiceStudioTxt2SpeechParams = {
    repo: engine.repo,
    text: req.text,
  }
  // voiceId is the audio generator's slot for a free-form voice selector.
  // The catalog says where it goes for this engine:
  //   - `preset_speaker`    → voicepack engines (Kokoro/qwen3 — e.g. `am_liam`)
  //   - `bark_voice_preset` → Bark's `vN/lang_speaker_K` preset
  //   - `voice_library_id`  → cloning engines (VoxCPM — a GET /api/voices id)
  // The picker surfaces the right id space for the selected model, so by
  // the time we get here `voiceId` is already in the correct namespace.
  if (engine.voiceField === 'voice_library_id' && !req.voiceId) {
    throw new Error(
      `${engine.label} needs a saved Voice Studio clone. Pick a voice from the cloned voice library.`,
    )
  }
  if (req.voiceId) {
    if (engine.voiceField === 'voice_library_id' && req.voiceId.startsWith('vsname:')) {
      throw new Error(
        `Voice '${req.voiceId.slice('vsname:'.length)}' was not resolved to this Voice Studio server. ` +
        'Refresh the voice list and retry.',
      )
    }
    params[engine.voiceField] = engine.voiceField === 'voice_library_id'
      ? (parseHubVoiceId(req.voiceId) || req.voiceId)
      : req.voiceId
  }
  if (typeof req.speed === 'number') params.speed = req.speed
  return params
}

/**
 * Hub pooling is safe for model-global preset speakers. A cloned voice id is
 * local to one Voice Studio installation, while Studio Hub currently routes
 * by model only and does not translate a voice name to each server's UUID.
 */
export function canRouteVoiceThroughHub(
  params: VoiceStudioTxt2SpeechParams,
  selectedVoiceId?: string,
): boolean {
  return !params.voice_library_id || !!parseHubVoiceId(selectedVoiceId)
}

/** Generate audio and write directly to `outPath`. Used by generators/audio. */
export async function generateTtsToFile(
  baseUrl: string,
  outPath: string,
  req: AudioGenerationRequest,
  opts: {
    signal?: AbortSignal
    isCancelled?: () => boolean
    onProgress?: (received: number, total?: number) => void
  } = {},
): Promise<void> {
  const params = buildVoiceStudioParams(req)

  // v1.0.214+ — Transcode to real MP3 on save. Voice Studio returns WAV (some
  // engines FLAC), but the rest of Story Studio's pipeline assumes a uniform
  // real-MP3 contract: the section merge concatenates with `-c copy` (which
  // can't mix codecs), video assembly + upload expect MP3, and WAV is ~10×
  // larger on disk/iCloud. So we download to a temp file, then encode to MP3
  // (192k libmp3lame — transparent for speech) at the requested .mp3 outPath,
  // instead of persisting WAV bytes under a .mp3 name. Download progress still
  // streams to the UI during the fetch; the encode is a quick local step.
  const tmpDownload = path.join(os.tmpdir(), `voicestudio-dl-${randomUUID()}`)
  try {
    // Studio Hub routing (Phase 3): when local_backend === 'hub', submit a
    // 1-item voice batch and let the Hub delegate across the fleet, then pull
    // the produced audio through the Hub's authenticated artifact gateway.
    // Hub and Direct are explicit, mutually exclusive settings: Hub failure is
    // reported and never starts duplicate work against a direct Voice Studio.
    // `prompt` carries the text (the Hub maps it to the
    // studio's native field); engine-specific knobs (voice preset, speed) ride
    // in params as an opaque pass-through.
    const hub = await getHubBackend()
    if (hub.mode === 'hub') {
      if (!hub.hubUrl) {
        throw new Error('Studio Hub routing is selected, but no Hub URL is configured. Open Settings → Local Models → Studio Hub.')
      }
      if (!canRouteVoiceThroughHub(params, req.voiceId)) {
        throw new Error(
          'Studio Hub routing is selected, but this cloned voice belongs to one direct Voice Studio. ' +
          'Select a Hub-managed shared voice, or explicitly switch Settings → Local Models → Generation backend to Direct.',
        )
      }
      const { repo, text, ...voiceParams } = params
      const sub = await hubSubmitJob(hub.hubUrl, hub.hubToken, {
        modality: 'voice', model: repo, label: 'storystudio-kh', routing: 'pool',
        items: [{ prompt: text, params: voiceParams as Record<string, any> }],
      })
      const status = await hubPollBatch(hub.hubUrl, hub.hubToken, sub.batch_id, {
        isCancelled: opts.isCancelled,
        timeoutMs: VOICESTUDIO_HUB_TTS_TIMEOUT_MS,
      })
      const item = status.items?.[0]
      if (!item || item.state !== 'done' || !item.artifact_url) {
        throw new Error(
          `Studio Hub voice job did not produce audio: ${item?.error || item?.state || 'no item'}` +
          `${status.governor_note ? ` (${status.governor_note})` : ''}`,
        )
      }
      await downloadHubArtifactToFile(
        hub.hubUrl,
        hub.hubToken,
        sub.batch_id,
        item.index,
        tmpDownload,
        { signal: opts.signal, onProgress: opts.onProgress },
      )
    } else {
      if (!baseUrl) {
        throw new Error(
          'Direct Voice Studio routing is selected, but no Voice Studio URL is configured. ' +
          'Open Settings → Local Models → Voice Studio and set at least one direct URL.',
        )
      }
      const submit = await submitTxt2Speech(baseUrl, params)
      await pollJob(baseUrl, submit.job_id, { isCancelled: opts.isCancelled })
      await downloadAudio(baseUrl, submit.job_id, tmpDownload, {
        signal: opts.signal, onProgress: opts.onProgress,
      })
    }

    await fs.mkdir(path.dirname(outPath), { recursive: true }).catch(() => {})
    await runFfmpeg(['-y', '-i', tmpDownload, '-c:a', 'libmp3lame', '-b:a', '192k', outPath])
  } finally {
    await fs.rm(tmpDownload, { force: true }).catch(() => {})
  }
}

const voicestudioAudioProvider: AudioProvider = {
  meta: {
    id: 'voicestudio',
    name: 'Voice Studio (Local)',
    // Same pattern as chatterbox — the apiKey slot in the registry actually
    // carries the base URL. Tailscale handles transport security so there's
    // no real "key" to store; reusing the secrets store gives us per-Mac
    // persistence semantics for free.
    apiKeyField: 'voicestudio_base_url',
    providerId: 'voicestudio',
  },

  /**
   * Registry-facing path — preview-voice + anything else that doesn't want
   * to manage the temp-file dance. Writes a temp WAV, returns the file://
   * URL. Caller is responsible for cleanup; preview-voice inlines + deletes.
   */
  async generateAudio(request: AudioGenerationRequest): Promise<AudioGenerationResult> {
    const baseUrl = (request.apiKey || '').trim() || DEFAULT_VOICESTUDIO_BASE_URL
    const tmpDir = os.tmpdir()
    const tmpPath = path.join(tmpDir, `voicestudio-${randomUUID()}.wav`)
    await generateTtsToFile(baseUrl, tmpPath, request)
    return { audioUrl: pathToFileURL(tmpPath).href, contentType: 'audio/wav' }
  },
}

registry.registerAudio(voicestudioAudioProvider)
