/**
 * fal.ai image-to-video provider — Veo, Hailuo, Wan, etc.
 * Each fal video model is addressed by a different slug; the slug lives in
 * the per-project `video_models[id].provider_params.slug` field.
 *
 * Image-to-video: local image paths are sent as base64 data URIs in `image_url`,
 * which fal transparently uploads to their CDN.
 */

import fs from 'fs/promises'
import path from 'path'
import { generateFalVideo } from '../../lib/fal-video-client.js'
import { registry } from '../registry.js'
import { runLimitedSettled } from '../../lib/http-retry.js'
import type { VideoProvider, VideoGenerationRequest, VideoGenerationResult } from '../types.js'

// fal has tight per-second submit limits; 2 in flight is safe across tiers.
const VIDEO_CONCURRENCY = 2

function extMime(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase().replace('.', '')
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'gif') return 'image/gif'
  return 'image/png'
}

async function fileToDataUri(filePath: string): Promise<string> {
  const buf = await fs.readFile(filePath)
  return `data:${extMime(filePath)};base64,${buf.toString('base64')}`
}

const falVideoProvider: VideoProvider = {
  meta: {
    id: 'fal-video',
    name: 'fal.ai Video',
    apiKeyField: 'fal_api_key',
  },

  supportsModel(modelId: string): boolean {
    return modelId.startsWith('fal-')
  },

  async generateVideo(request: VideoGenerationRequest): Promise<VideoGenerationResult> {
    const { mode, prompt, apiKey, aspectRatio, numberOfVideos, startImagePath, providerParams, isCancelled } = request
    if (!apiKey) throw new Error('No fal.ai API key configured. Add one in Settings → API Keys.')
    if (mode !== 'frames' || !startImagePath) throw new Error('fal.ai image-to-video requires a source image.')

    const slug = providerParams?.slug
    if (!slug) throw new Error('fal.ai video model config is missing `provider_params.slug`.')

    // Build fal payload — each model takes slightly different fields but these are the common set
    const payload: Record<string, any> = { prompt }

    // Aspect ratio — fal uses strings like "16:9" / "9:16"
    payload.aspect_ratio = aspectRatio === 'portrait' ? '9:16' : '16:9'

    // Duration — default tuned per model in providerParams.default_duration
    if (providerParams?.default_duration) payload.duration = providerParams.default_duration

    // Resolution
    if (providerParams?.default_resolution) payload.resolution = providerParams.default_resolution

    // Image-to-video: attach local image as base64 data URI
    payload.image_url = await fileToDataUri(startImagePath)

    // Allow provider_params to add/override any fields (e.g. generate_audio)
    if (providerParams?.extra_payload && typeof providerParams.extra_payload === 'object') {
      Object.assign(payload, providerParams.extra_payload)
    }

    // Multiple videos — most fal models don't take a count. Fan out with a
    // hard concurrency cap to avoid 429 storms, and use allSettled so one
    // submit failure doesn't discard the other N-1 videos the user just
    // paid for. Partial success returns whatever succeeded; full failure
    // throws with the first rejection's message.
    const n = Math.max(1, Math.min(4, numberOfVideos))
    const settled = await runLimitedSettled(n, VIDEO_CONCURRENCY, () =>
      generateFalVideo({ apiKey, modelSlug: slug, payload, isCancelled }),
    )
    const urls: string[] = []
    const errors: string[] = []
    for (const r of settled) {
      if (r.status === 'fulfilled') urls.push(...r.value)
      else errors.push(String((r.reason as any)?.message || r.reason))
    }
    if (!urls.length) {
      throw new Error(`All ${n} fal.ai video submissions failed: ${errors[0] || 'unknown'}`)
    }
    return { videoUrls: urls }
  },
}

registry.registerVideo(falVideoProvider)
