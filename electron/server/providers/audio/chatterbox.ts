/**
 * Chatterbox audio provider — self-hosted TTS via local Mac mini over Tailscale.
 *
 * Two model ids resolve here today (see models/defaults.ts):
 *   - `chatterbox-default` → built-in voice (no reference_id)
 *   - `chatterbox-cloned`  → uses the per-project chatterbox_reference_id
 *
 * The provider returns a `file://` URL pointing at a temp WAV. Routes that
 * call this directly via the registry (e.g. preview-voice) can convert it
 * to bytes; the audio generator goes through `generateTtsToFile` instead so
 * the WAV streams straight to its final destination on disk.
 *
 * Cancellation note: Chatterbox has no documented cancel endpoint, so a
 * user-cancelled job stops *our* polling but the server runs to completion
 * and discards the result. Acceptable for a local server.
 */

import os from 'os'
import path from 'path'
import { pathToFileURL } from 'url'
import { randomUUID } from 'crypto'
import { registry } from '../registry.js'
import {
  submitBatch, pollJob, downloadAudio,
  DEFAULT_CHATTERBOX_BASE_URL,
  type ChatterboxGenerateParams,
} from '../../lib/chatterbox-client.js'
import type { AudioProvider, AudioGenerationRequest, AudioGenerationResult } from '../types.js'

/**
 * Map a Story Studio request to the Chatterbox params for one of our model ids.
 * Other params (temperature, exaggeration, etc.) take Chatterbox's defaults.
 */
function buildParams(req: AudioGenerationRequest, referenceId?: string): ChatterboxGenerateParams {
  const useClone = req.modelId === 'chatterbox-cloned'
  const params: ChatterboxGenerateParams = {
    text: req.text,
    output_format: 'wav',
  }
  if (useClone) {
    if (!referenceId) {
      throw new Error(
        'Chatterbox cloned voice selected but no reference clip is uploaded. ' +
        'Upload a 5–15s sample in Settings → Local TTS, or switch to "Chatterbox – Default Voice".',
      )
    }
    params.reference_id = referenceId
  }
  if (typeof req.speed === 'number') params.speed = req.speed
  return params
}

/**
 * Generate audio and write the WAV directly to `outPath`. Used by the audio
 * generator so we don't pay an extra disk roundtrip through a temp file.
 */
export async function generateTtsToFile(
  baseUrl: string,
  outPath: string,
  req: AudioGenerationRequest,
  opts: {
    referenceId?: string
    signal?: AbortSignal
    isCancelled?: () => boolean
    onProgress?: (received: number, total?: number) => void
  } = {},
): Promise<void> {
  if (!baseUrl) {
    throw new Error(
      'Chatterbox base URL not configured. Enable Local TTS in Settings → Local TTS ' +
      'and confirm the URL points at your Mac mini.',
    )
  }
  const params = buildParams(req, opts.referenceId)
  const submit = await submitBatch(baseUrl, params)
  await pollJob(baseUrl, submit.job_id, { isCancelled: opts.isCancelled })
  await downloadAudio(baseUrl, submit.job_id, outPath, {
    signal: opts.signal,
    onProgress: opts.onProgress,
  })
}

const chatterboxAudioProvider: AudioProvider = {
  meta: {
    id: 'chatterbox',
    name: 'Chatterbox (Local)',
    // The "key" slot for chatterbox carries the base URL, not a secret.
    // Bucket id is `chatterbox`; see app-secrets-store SECRET_PROVIDERS.
    apiKeyField: 'chatterbox_base_url',
    providerId: 'chatterbox',
  },

  /**
   * Registry-facing path — used by preview-voice and any other caller that
   * doesn't want to manage the temp-file dance itself. Writes a temp WAV and
   * returns its file:// URL. Caller is responsible for cleanup; preview-voice
   * just inlines the bytes as a data URL and discards the temp file via the
   * OS tmp sweep.
   */
  async generateAudio(request: AudioGenerationRequest): Promise<AudioGenerationResult> {
    const baseUrl = (request.apiKey || '').trim() || DEFAULT_CHATTERBOX_BASE_URL
    const tmpDir = os.tmpdir()
    const tmpPath = path.join(tmpDir, `chatterbox-${randomUUID()}.wav`)
    await generateTtsToFile(baseUrl, tmpPath, request)
    return { audioUrl: pathToFileURL(tmpPath).href, contentType: 'audio/wav' }
  },
}

registry.registerAudio(chatterboxAudioProvider)
