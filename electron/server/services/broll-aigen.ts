/**
 * Scripted B-Roll — styled AI-gen fallback (Phase 4).
 *
 * When a beat finds no stock match, generate a CHANNEL-STYLED still (the beat's
 * subject prefixed with the plan's `broll_style`), turn it into a short clip,
 * and drop it into the SAME video pool so it concatenates seamlessly with the
 * stock clips (no separate render path). Reuses the project's image-generation
 * stack exactly as the Image Pool generator does.
 *
 * Opt-in + best-effort: callers only invoke it when the user enabled it and
 * picked an image model; any failure leaves the beat empty.
 */
import path from 'path'
import fs from 'fs/promises'
import { registry, resolveApiKeyForProvider } from '../providers/registry.js'
import { downloadImage } from '../lib/kie-client.js'
import * as pm from '../services/project-manager.js'
import * as bp from '../services/broll-pool-manager.js'
import { runFfmpeg } from '../lib/ffmpeg-utils.js'
import type { ImageModelConfig } from '../models/types.js'
import type { BrollBeat } from './broll-plan.js'

/** Resolve the project's image provider + key for `model` (mirrors image-pool-generate). */
async function resolveImageGen(slug: string, model: string) {
  const config = await pm.getConfig(slug)
  if (!config) throw new Error('Project config not found')
  let modelConfig: ImageModelConfig | undefined = config.image_models?.[model]
  if (!modelConfig) {
    const { repoForModelId } = await import('../lib/imagestudio-client.js')
    const repo = repoForModelId(model)
    if (repo) {
      modelConfig = {
        label: repo, credits_per_image: 0, prompt_char_cap: 1000,
        endpoint: '', poll: '', type: 'local', api_model: repo,
        provider: 'imagestudio', supports_reference_images: true,
      } as any
    }
  }
  if (!modelConfig) throw new Error(`Unknown image model: ${model}`)
  const providerId = (modelConfig as any).provider || 'kie'
  const imageProvider = registry.getImageProvider(providerId)
  if (!imageProvider) throw new Error(`No image provider registered for: ${providerId}`)
  const providerParams = (modelConfig as any).provider_params || {
    endpoint: modelConfig.endpoint, poll: modelConfig.poll, type: modelConfig.type,
    api_model: modelConfig.api_model, aspect_field: (modelConfig as any).aspect_field,
  }
  const apiKey = await resolveApiKeyForProvider(slug, imageProvider.meta, { model })
  if (!apiKey && providerId !== 'imagestudio') {
    throw new Error(`No API key for ${imageProvider.meta.name}. Add one in Settings → API Keys.`)
  }
  return { imageProvider, apiKey, providerParams, model }
}

export async function isAiGenAvailable(slug: string, model: string): Promise<boolean> {
  try { await resolveImageGen(slug, model); return true } catch { return false }
}

/** Style-prefixed visual prompt for a beat. Pure. */
export function buildAiGenPrompt(beat: Pick<BrollBeat, 'queries' | 'line'>, brollStyle: string): string {
  const subject = (beat.queries[0] || beat.line || '').trim()
  const style = (brollStyle || '').trim()
  return style ? `${style}. ${subject}` : subject
}

/** Pure ffmpeg argv: a still → a 1080p H.264 clip of `durationSec` (static, padded/cropped). */
export function buildImageToClipArgs(imagePath: string, outPath: string, durationSec: number, fps = 30): string[] {
  const d = Math.max(0.5, durationSec)
  return [
    '-y', '-loop', '1', '-i', imagePath,
    '-t', d.toFixed(2), '-r', String(fps),
    '-vf', 'scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,format=yuv420p',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', outPath,
  ]
}

/**
 * Generate a styled clip for one beat into `pool` (video pool). Returns the clip
 * filename, or null on failure. The intermediate PNG is removed; only the .mp4
 * remains for the indexer to pick up.
 */
export async function aiGenFallbackForBeat(
  slug: string,
  beat: BrollBeat,
  pool: bp.BrollPool,
  brollStyle: string,
  model: string,
): Promise<string | null> {
  const gen = await resolveImageGen(slug, model).catch(() => null)
  if (!gen) return null
  const prompt = buildAiGenPrompt(beat, brollStyle)
  let urls: string[] = []
  try {
    const result = await gen.imageProvider.generateImage({
      prompt, apiKey: gen.apiKey, aspectRatio: '16:9', modelId: gen.model,
      providerParams: gen.providerParams, isCancelled: () => false,
    })
    urls = result.urls || []
  } catch { return null }
  if (!urls.length) return null

  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e4)}`
  const imgPath = path.join(pool.folder_path, `.aigen-${stamp}.png`)
  const clipName = `aigen-${stamp}.mp4`
  const clipPath = path.join(pool.folder_path, clipName)
  try {
    await downloadImage(urls[0]!, imgPath)
    await runFfmpeg(buildImageToClipArgs(imgPath, clipPath, beat.end_sec - beat.start_sec))
  } catch {
    await fs.unlink(clipPath).catch(() => {})
    return null
  } finally {
    await fs.unlink(imgPath).catch(() => {})
  }
  return clipName
}
