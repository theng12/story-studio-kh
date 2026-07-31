/**
 * GenStudio KH image provider.
 *
 * GenStudio owns model inventory, fleet routing, idempotent jobs, polling,
 * validation, and private artifact storage. Story Studio only supplies the
 * creative request and persists the verified PNG returned by that boundary.
 *
 * Every guard in `generateImage` runs against the LIVE catalogue entry before
 * the charged POST. Nothing here infers a capability from a model's name, and
 * nothing invents a value GenStudio did not publish.
 */

import path from 'path'
import { registry } from '../registry.js'
import type { ImageGenerationRequest, ImageGenerationResult, ImageProvider } from '../types.js'
import { GenStudioApiError, generateImageWithGenStudio, listImageModels, uploadImageSourceWithGenStudio } from '../../lib/genstudio-client.js'
import { assertDecodableImage } from '../../lib/image-validation.js'
import { resolveGenStudioModelId, unavailableLegacyModelMessage } from '../../services/genstudio-model-migration.js'
import {
  publishedAvailabilityProblem,
  publishedSupportsReferenceImages,
  resolvePublishedAspectRatio,
  resolvePublishedOutputOption,
} from '../../services/image-model-resolver.js'

const genstudioImageProvider: ImageProvider = {
  meta: {
    id: 'genstudio-image',
    name: 'GenStudio KH',
    apiKeyField: 'genstudio_api_key',
    providerId: 'genstudio',
  },

  supportsModel(modelId: string, providerParams: Record<string, any>): boolean {
    return providerParams?.provider === 'genstudio-image' || modelId.startsWith('genstudio-image-')
  },

  async generateImage(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    const modelId = resolveGenStudioModelId('image', request.modelId)
    if (!modelId) throw new Error(unavailableLegacyModelMessage('image', request.modelId))
    // One cached, coalesced catalogue read serves every guard below, so a
    // 25-scene batch still performs a single GET.
    const model = (await listImageModels(request.apiKey)).find(item => item.id === modelId)
    if (!model) {
      throw new Error('The selected GenStudio image model is no longer available. Refresh the model picker and choose a current model.')
    }

    // Availability is checked on EVERY submit path, not only when a reference
    // is attached — a plain text2img POST to a retired or qualification-only
    // model would otherwise be accepted and billed. Mirrors the chat path.
    const unavailable = publishedAvailabilityProblem(model)
    if (unavailable) throw new Error(`${unavailable} No request or credit charge was made.`)

    const supportsReferences = publishedSupportsReferenceImages(model)
    const maxReferences = model.max_reference_images >= 1
      ? model.max_reference_images
      : (supportsReferences ? 1 : 0)
    const minReferences = model.min_reference_images ?? 0

    // Prompt ceiling comes from the model's own published cap, checked before
    // the charged POST. No published cap means no local check — GenStudio
    // decides. `prompt_token_allowance` is never converted into characters.
    const promptLength = request.prompt.trim().length
    if (model.max_prompt_characters && promptLength > model.max_prompt_characters) {
      throw new Error(
        `${model.display_name} accepts up to ${model.max_prompt_characters.toLocaleString()} prompt characters; ` +
        `this prompt is ${promptLength.toLocaleString()}. No request or credit charge was made.`,
      )
    }

    const requestedReferences = (request.referenceImagePaths || []).filter(Boolean)
    if (requestedReferences.length && (!supportsReferences || !model.chargeable)) {
      throw new Error('The selected GenStudio KH image model does not support private reference-image generation. Choose a reference-capable model.')
    }
    // Submit as many references as the model publishes room for, not the one
    // the old `[0]` slice allowed. Extra references are dropped at the
    // boundary rather than rejected: the render is still the one the user
    // asked for, and GenStudio would reject the oversized list outright.
    const referencePaths = requestedReferences.slice(0, maxReferences)
    if (referencePaths.length < minReferences) {
      throw new Error(
        `${model.display_name} requires at least ${minReferences} reference image(s); ` +
        `${referencePaths.length} were supplied. No request or credit charge was made.`,
      )
    }
    if (!referencePaths.length && minReferences > 0) {
      throw new Error(
        `${model.display_name} renders only from reference images. Attach at least ${minReferences}. ` +
        'No request or credit charge was made.',
      )
    }

    // Pixel ceiling on every reference, checked BEFORE the upload and before
    // the charged POST. The 10 MB byte cap in routes/image-references.ts is a
    // local storage bound and says nothing about pixels: a 9 MB 8000x8000 PNG
    // passes it and is then rejected at the GenStudio boundary after the whole
    // file has been uploaded. A model that publishes no dimension gets NO
    // local check — Story Studio does not invent a ceiling GenStudio never
    // stated. The message names the model, the limit, and the actual size so
    // the customer can resize instead of guessing.
    const maxReferenceDimension = model.reference_image_max_dimension
    if (referencePaths.length && Number.isInteger(maxReferenceDimension) && maxReferenceDimension! > 0) {
      for (const referencePath of referencePaths) {
        const info = await assertDecodableImage(referencePath, 'Reference image')
        const longestEdge = Math.max(info.width, info.height)
        if (longestEdge > maxReferenceDimension!) {
          throw new Error(
            `${model.display_name} accepts reference images up to ${maxReferenceDimension!.toLocaleString()}px on the longest side; ` +
            `"${path.basename(referencePath)}" is ${info.width.toLocaleString()}x${info.height.toLocaleString()}px. ` +
            'Resize it and retry. No request or credit charge was made.',
          )
        }
      }
    }

    // Ratio comes from the published list, defaulting to the model's own
    // `default_aspect_ratio` — never a hardcoded '16:9'.
    const aspectRatio = resolvePublishedAspectRatio(model, request.aspectRatio)

    // The published `(resolution, aspect_ratio)` row this render belongs to.
    // `undefined` means the model publishes no output options, so nothing
    // resolution-shaped is sent and GenStudio applies its own default — the
    // behaviour every model had before output options existed.
    const outputOption = resolvePublishedOutputOption(model, aspectRatio, request.resolution)

    // `supports_seed` is honoured when published. Absent means GenStudio said
    // nothing about seeds, and the request field is part of the published
    // image contract, so the caller's seed still travels.
    const seed = model.supports_seed === false ? undefined : request.seed

    const submit = async () => {
      const sources = referencePaths.length
        ? await Promise.all(referencePaths.map(path => uploadImageSourceWithGenStudio(request.apiKey, path)))
        : []
      return generateImageWithGenStudio(request.apiKey, {
        prompt: request.prompt,
        modelId,
        aspectRatio,
        ...(outputOption ? { resolution: outputOption.resolution } : {}),
        // A published output option IS the output size, so the caller's
        // legacy render-size pair is not also sent — two different size
        // instructions on one request could bill a combination other than the
        // one the customer was shown. Models publishing no options keep the
        // old pass-through untouched.
        ...(outputOption ? {} : { width: request.width, height: request.height }),
        seed,
        requestIdentity: request.idempotencyIdentity,
        isCancelled: request.isCancelled,
        onJobAccepted: request.onJobAccepted,
        onReconnect: request.onReconnect,
        ...(sources.length ? { referenceAssetIds: sources.map(source => source.id) } : {}),
      })
    }
    let result
    try { result = await submit() } catch (error) {
      // The project-owned reference is still present locally. Refresh its
      // short-lived private asset exactly once; never degrade to text-only.
      if (!(error instanceof GenStudioApiError) || error.code !== 'REFERENCE_ASSET_EXPIRED' || !referencePaths.length) throw error
      result = await submit()
    }
    return { urls: [result.url], taskId: result.jobId }
  },
}

registry.registerImage(genstudioImageProvider)
