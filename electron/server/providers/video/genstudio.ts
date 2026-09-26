/** GenStudio-only image-to-video provider. */

import { registry } from '../registry.js'
import type { VideoGenerationRequest, VideoGenerationResult, VideoProvider } from '../types.js'
import {
  cheapestGenStudioVideoVariant,
  describeGenStudioVideoVariant,
  findGenStudioVideoVariant,
  generateVideoWithGenStudio,
  listVideoModels,
  supportsGenStudioVideoMode,
  STORY_STUDIO_VIDEO_MODE,
  variantsForGenStudioVideoOperation,
  type GenStudioVideoVariant,
} from '../../lib/genstudio-client.js'
import { findGenStudioProduct } from '../../contracts/genstudio-product-identity.js'

const PREFIX = 'genstudio-video:'

/**
 * Choose the variant this request will be billed at, from what the model
 * PUBLISHES.
 *
 * This used to be two ternaries that coerced anything unrecognised down to
 * `5s / 720p`. That is the worst of both worlds: a caller asking for a
 * combination the model genuinely cannot do got a different clip than it
 * asked for, silently, and a caller asking for a combination the model DOES
 * publish (say 8s, or 4k) was downgraded for no reason. Now:
 *
 *   - nothing requested        → the model's cheapest published variant;
 *   - a published combination  → exactly that variant;
 *   - anything else            → a loud error naming what IS published.
 *
 * **Two variants can share a duration and resolution and differ only in aspect
 * ratio.** A Studio Hub video lane publishes canvases as PAIRS — its `448p` class
 * carries 704x448 (11:7) and 448x448 (1:1) — so `(duration, resolution)` alone does
 * not name one picture, and the orientation the caller asked for is what tells them
 * apart. The published ratio travels back with the variant so the request can carry
 * the ratio that variant actually has, instead of Story Studio's old guess.
 */
interface ResolvedVideoVariant {
  variant: GenStudioVideoVariant
  /** Every aspect ratio the model publishes, in published order. Empty when it states none. */
  publishedAspectRatios: string[]
}

/** Whether a published `w:h` ratio is taller than it is wide. Unparseable ratios are neither. */
function isPortraitRatio(ratio: string): boolean | undefined {
  const match = /^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/.exec(ratio)
  if (!match) return undefined
  const width = Number(match[1])
  const height = Number(match[2])
  if (!(width > 0) || !(height > 0)) return undefined
  return height > width
}

async function resolveRequestedVariant(
  apiKey: string,
  modelId: string,
  providerParams: Record<string, any> | undefined,
  portrait: boolean,
): Promise<ResolvedVideoVariant> {
  const catalog = await listVideoModels(apiKey)
  // Resolved by ANY identifier the catalog publishes — id, customer handle, or
  // a published legacy id — so a motion preset saved before a product was
  // renamed still finds its product instead of failing at submit time.
  const model = findGenStudioProduct(catalog, modelId)
  if (!model || !model.available || !supportsGenStudioVideoMode(model)) {
    throw new Error(
      `GenStudio does not currently publish an available image-to-video model with id "${modelId}".`,
    )
  }
  const operation = providerParams?.operation
  if (operation !== STORY_STUDIO_VIDEO_MODE) {
    throw new Error(`GenStudio video requests must include the published ${STORY_STUDIO_VIDEO_MODE} operation.`)
  }
  const published = variantsForGenStudioVideoOperation(model.variants, operation)
  if (!published.length) {
    throw new Error(
      `GenStudio publishes no priced duration/resolution variant for "${model.display_name}", `
      + 'so Story Studio cannot submit a clip for it.',
    )
  }
  const publishedAspectRatios = Array.isArray(model.aspect_ratios) ? [...model.aspect_ratios] : []

  /** When several variants share a duration and resolution, the orientation picks between them. */
  const forOrientation = (candidates: GenStudioVideoVariant[]): GenStudioVideoVariant => {
    const withRatios = candidates.filter(candidate => typeof candidate.aspect_ratio === 'string')
    if (!withRatios.length) return candidates[0]
    const wanted = withRatios.find(candidate => isPortraitRatio(candidate.aspect_ratio!) === portrait)
    return wanted ?? withRatios[0]
  }

  const requestedDuration = providerParams?.duration_seconds
  const requestedResolution = providerParams?.resolution
  const askedForDuration = requestedDuration !== undefined && requestedDuration !== null && requestedDuration !== ''
  const askedForResolution = typeof requestedResolution === 'string' && requestedResolution.trim().length > 0

  if (!askedForDuration && !askedForResolution) {
    const cheapest = cheapestGenStudioVideoVariant(published)!
    const samePriced = published.filter(candidate => (
      candidate.duration_seconds === cheapest.duration_seconds
      && candidate.resolution === cheapest.resolution
    ))
    return { variant: forOrientation(samePriced.length ? samePriced : [cheapest]), publishedAspectRatios }
  }

  const cheapest = cheapestGenStudioVideoVariant(published)!
  const duration = askedForDuration ? Number(requestedDuration) : cheapest.duration_seconds
  const resolution = askedForResolution ? String(requestedResolution).trim() : cheapest.resolution
  const matches = published.filter(candidate => (
    candidate.duration_seconds === duration && candidate.resolution === resolution
  ))
  if (matches.length) return { variant: forOrientation(matches), publishedAspectRatios }

  throw new Error(
    `"${model.display_name}" does not publish a ${duration}s at ${resolution} option. `
    + `GenStudio publishes: ${published.map(describeGenStudioVideoVariant).join(', ')}. `
    + 'Story Studio will not substitute a different length or resolution for the one requested.',
  )
}

/**
 * The aspect ratio to send for a resolved variant.
 *
 * The variant's own published ratio first. Where the product publishes no ratio per
 * variant (every cloud video lane), the model's published `aspect_ratios` list is read
 * for one that matches the requested orientation — still published data, never a guess.
 * Where the product publishes no ratio at all, the field is omitted and the lane's own
 * default decides, which is its choice to make and not Story Studio's.
 */
export function aspectRatioForResolvedVariant(
  resolved: ResolvedVideoVariant,
  portrait: boolean,
): string | undefined {
  if (typeof resolved.variant.aspect_ratio === 'string' && resolved.variant.aspect_ratio.trim()) {
    return resolved.variant.aspect_ratio.trim()
  }
  const match = resolved.publishedAspectRatios.find(ratio => isPortraitRatio(ratio) === portrait)
  return match ? match.trim() : undefined
}

const genstudioVideoProvider: VideoProvider = {
  meta: {
    id: 'genstudio-video',
    name: 'GenStudio KH',
    apiKeyField: 'genstudio_api_key',
    providerId: 'genstudio',
  },

  /**
   * `providerParams.provider` is the structural signal. The `PREFIX` test is
   * safe here for a reason that does NOT hold for images: `genstudio-video:` is
   * a transport NAMESPACE that Story Studio itself prepends to whatever product
   * id it resolved (see `generators/ai-video.ts`), not a fragment of the
   * product's own name. `genstudio-video:veo-3-1` still matches, so renaming a
   * product to a customer handle cannot break video selection.
   */
  supportsModel(modelId: string, providerParams?: Record<string, any>): boolean {
    return modelId.startsWith(PREFIX) || providerParams?.provider === 'genstudio-video'
  },

  async generateVideo(request: VideoGenerationRequest): Promise<VideoGenerationResult> {
    if (request.mode !== 'frames' || !request.startImagePath) {
      throw new Error('GenStudio video generation requires an approved source image.')
    }
    const modelId = request.modelId.startsWith(PREFIX)
      ? request.modelId.slice(PREFIX.length)
      : request.modelId
    const portrait = request.aspectRatio === 'portrait'
    const resolved = await resolveRequestedVariant(request.apiKey, modelId, request.providerParams, portrait)
    const variant = resolved.variant
    const duration = variant.duration_seconds
    const resolution = variant.resolution
    // The published ratio for this exact variant. Omitted when the product publishes none,
    // which leaves the choice to the lane rather than to a hardcoded 16:9.
    const aspectRatio = aspectRatioForResolvedVariant(resolved, portrait)
    const results = []
    for (let index = 0; index < Math.max(1, request.numberOfVideos); index++) {
      results.push(await generateVideoWithGenStudio(request.apiKey, {
        prompt: request.prompt,
        modelId,
        sourceImagePath: request.startImagePath,
        ...(aspectRatio ? { aspectRatio } : {}),
        operation: variant.operation,
        durationSeconds: duration,
        resolution,
        requestIdentity: `${request.idempotencyIdentity || request.startImagePath}:variant:${index + 1}`,
        isCancelled: request.isCancelled,
        onJobAccepted: (taskId, idempotencyKey) => request.onJobAccepted?.(taskId, idempotencyKey, index),
      }))
    }
    return {
      videoUrls: results.map(result => result.videoUrl),
      taskIds: results.map(result => result.jobId),
      downloadHeaders: results[0]?.downloadHeaders,
    }
  },
}

registry.registerVideo(genstudioVideoProvider)
