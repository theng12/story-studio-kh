/**
 * kie.ai video provider — Sora 2, Kling 3.0, etc. via the jobs endpoint.
 * Per-model slug + optional extra payload come from video_models[id].provider_params.
 *
 * Image-to-video: local image paths are sent as base64 data URIs in `image_urls[]`.
 */

import fs from 'fs/promises'
import path from 'path'
import { generateKieVideo } from '../../lib/kie-video-client.js'
import { registry } from '../registry.js'
import { runLimitedSettled } from '../../lib/http-retry.js'
import type { VideoProvider, VideoGenerationRequest, VideoGenerationResult } from '../types.js'

// kie.ai 429s aggressively above ~2 concurrent jobs. Cap the fan-out so a
// request for 4 videos doesn't lose 3 of them to rate limits.
const VIDEO_CONCURRENCY = 2

function collect(settled: PromiseSettledResult<string[]>[], providerLabel: string): string[] {
  const urls: string[] = []
  const errors: string[] = []
  for (const r of settled) {
    if (r.status === 'fulfilled') urls.push(...r.value)
    else errors.push(String((r.reason as any)?.message || r.reason))
  }
  if (!urls.length) throw new Error(`All ${settled.length} ${providerLabel} submissions failed: ${errors[0] || 'unknown'}`)
  return urls
}

function extMime(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase().replace('.', '')
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'webp') return 'image/webp'
  return 'image/png'
}

async function fileToDataUri(filePath: string): Promise<string> {
  const buf = await fs.readFile(filePath)
  return `data:${extMime(filePath)};base64,${buf.toString('base64')}`
}

const kieVideoProvider: VideoProvider = {
  meta: {
    id: 'kie-video',
    name: 'kie.ai Video',
    apiKeyField: 'kie_api_key',
  },

  supportsModel(modelId: string): boolean {
    return modelId.startsWith('kie-')
  },

  async generateVideo(request: VideoGenerationRequest): Promise<VideoGenerationResult> {
    const { mode, prompt, apiKey, aspectRatio, numberOfVideos, startImagePath, providerParams, isCancelled } = request
    if (!apiKey) throw new Error('No kie.ai API key configured. Add one in Settings → API Keys.')

    const type = (providerParams?.type || 'jobs') as 'jobs' | 'veo' | 'runway'
    const apiModel = providerParams?.api_model
    const n = Math.max(1, Math.min(4, numberOfVideos))

    // ── Veo endpoint (dedicated) — /veo/generate ───────────────────────────
    if (type === 'veo') {
      // Veo takes camelCase `aspect_ratio` values "16:9" / "9:16" and a
      // generationType field indicating text-to-video vs frames.
      const input: Record<string, any> = {
        prompt,
        aspect_ratio: aspectRatio === 'portrait' ? '9:16' : '16:9',
        generationType: mode === 'frames' ? 'FIRST_AND_LAST_FRAMES_2_VIDEO' : 'TEXT_2_VIDEO',
      }
      if (mode === 'frames') {
        if (!startImagePath) throw new Error('Veo image-to-video requires a start image.')
        input.imageUrls = [await fileToDataUri(startImagePath)]
      }
      if (providerParams?.extra_input) Object.assign(input, providerParams.extra_input)

      const settled = await runLimitedSettled(n, VIDEO_CONCURRENCY, () =>
        generateKieVideo({ apiKey, type: 'veo', apiModel, input, isCancelled }),
      )
      return { videoUrls: collect(settled, 'kie.ai Veo') }
    }

    // ── Runway endpoint (dedicated) — /runway/generate ─────────────────────
    if (type === 'runway') {
      // Runway uses camelCase field names and discrete `duration` / `quality` enums.
      const input: Record<string, any> = {
        prompt,
        aspectRatio: aspectRatio === 'portrait' ? '9:16' : '16:9',
        duration: providerParams?.default_duration || 5,
        quality: providerParams?.default_quality || '720p',
      }
      if (mode === 'frames') {
        if (!startImagePath) throw new Error('Runway image-to-video requires a start image.')
        input.imageUrl = await fileToDataUri(startImagePath)
      }
      if (providerParams?.extra_input) Object.assign(input, providerParams.extra_input)

      const settled = await runLimitedSettled(n, VIDEO_CONCURRENCY, () =>
        generateKieVideo({ apiKey, type: 'runway', input, isCancelled }),
      )
      return { videoUrls: collect(settled, 'kie.ai Runway') }
    }

    // ── Default: jobs endpoint (Sora 2, Kling 3.0, etc.) ───────────────────
    if (!apiModel) throw new Error('kie.ai video model config is missing `provider_params.api_model`.')
    const input: Record<string, any> = {
      prompt,
      aspect_ratio: aspectRatio === 'portrait' ? '9:16' : '16:9',
    }
    if (providerParams?.default_duration) input.duration = providerParams.default_duration
    if (mode === 'frames') {
      if (!startImagePath) throw new Error('Image-to-video requires a start image.')
      input.image_urls = [await fileToDataUri(startImagePath)]
    }
    if (providerParams?.extra_input) Object.assign(input, providerParams.extra_input)

    const settled = await runLimitedSettled(n, VIDEO_CONCURRENCY, () =>
      generateKieVideo({ apiKey, type: 'jobs', apiModel, input, isCancelled }),
    )
    return { videoUrls: collect(settled, 'kie.ai jobs') }
  },
}

registry.registerVideo(kieVideoProvider)
