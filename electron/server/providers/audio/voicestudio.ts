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
import type { AudioProvider, AudioGenerationRequest, AudioGenerationResult } from '../types.js'

function buildParams(req: AudioGenerationRequest): VoiceStudioTxt2SpeechParams {
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
  if (req.voiceId) {
    params[engine.voiceField] = req.voiceId
  }
  if (typeof req.speed === 'number') params.speed = req.speed
  return params
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
  if (!baseUrl) {
    throw new Error(
      'Voice Studio modal URL not configured. ' +
      'Open App Settings → Local Models and set the URL (Tailscale IP + port).',
    )
  }
  const params = buildParams(req)
  const submit = await submitTxt2Speech(baseUrl, params)
  await pollJob(baseUrl, submit.job_id, { isCancelled: opts.isCancelled })

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
    await downloadAudio(baseUrl, submit.job_id, tmpDownload, {
      signal: opts.signal,
      onProgress: opts.onProgress,
    })
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
