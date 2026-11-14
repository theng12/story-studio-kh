import type { ImageModelConfig, ImageOutputOption, ProjectConfig } from '../models/types.js'
import { listImageModels, type GenStudioImageModel, type GenStudioImageOutputOption } from '../lib/genstudio-client.js'
import { resolveGenStudioModelId } from './genstudio-model-migration.js'
import { findGenStudioProduct } from '../contracts/genstudio-product-identity.js'
import {
  isPublishedAspectRatio,
  publishedAspectRatios,
  storyDefaultAspectRatio,
  storyDefaultOutputOption,
} from '../contracts/genstudio-image-defaults.js'

/**
 * Every capability field is parsed exactly once, in the catalogue mapper in
 * `genstudio-client.ts`, and reaches this module already typed on
 * `GenStudioImageModel`. Nothing here re-derives a capability, and nothing
 * substitutes a value for one GenStudio did not publish: `undefined` means
 * "no contract", which is "omit the control" or "leave the behaviour to the
 * provider" — never "assume false" and never "assume a plausible number".
 */

/**
 * True when this model can consume reference images at all, judged ONLY on
 * what GenStudio published — never on the model's name. `max_reference_images`
 * has to be at least one for a reference to have anywhere to go.
 */
export function publishedSupportsReferenceImages(model: GenStudioImageModel): boolean {
  if (model.supports_reference_images && model.max_reference_images >= 1) return true
  // Some catalogues express the same capability as an explicit img2img flag
  // or an `image.edit` operation rather than the reference-image pair.
  if (model.supports_image_to_image === true) return true
  return model.operations?.some(op => op === 'image.edit' || op === 'image.to_image') === true
}

/**
 * The largest reference edge that EVERY reference-capable product will accept,
 * or undefined when the catalogue states no ceiling at all.
 *
 * Used at the upload boundary, where no single model is in scope yet: a
 * reference stored at this size is submittable to whichever model the customer
 * later picks. It is the MINIMUM of the published ceilings for that reason —
 * the maximum would store a file the stricter half of the catalogue rejects,
 * which is the failure this is here to remove.
 *
 * Nothing is invented. A model publishing no ceiling contributes none, and if
 * no model publishes one this returns undefined and the caller stores the
 * bytes untouched. When GenStudio raises its ceilings the app follows on the
 * next catalogue read, with no constant to remember to edit.
 */
export function publishedReferenceCeiling(models: GenStudioImageModel[]): number | undefined {
  const ceilings = models
    .filter(publishedSupportsReferenceImages)
    .map(model => model.reference_image_max_dimension)
    .filter((value): value is number => Number.isInteger(value) && (value as number) > 0)
  return ceilings.length ? Math.min(...ceilings) : undefined
}

/** Human-readable reason a model cannot be submitted right now, or ''. */
export function publishedAvailabilityProblem(model: GenStudioImageModel): string {
  if (model.locked) {
    return `${model.display_name} is visible for comparison but locked for this Gateway account. Choose an unlocked published model.`
  }
  if (!model.available) {
    return `${model.display_name} is currently unavailable in the Gateway. Choose a published model.`
  }
  if (model.qualification_only) {
    return `${model.display_name} is qualification-only for this account and cannot be submitted.`
  }
  return ''
}

/**
 * Never substitute a different frame for the one the model itself declares.
 *
 * A model that declares `default_aspect_ratio` 16:9 but publishes only a 1:1
 * output row used to fall through to that row, so a batch billed for 1:1 while
 * the owner had chosen a 16:9 model (live evidence, 1.4.401). Refuse loudly
 * instead; the declared default still wins when it IS published, and the Story
 * 16:9 preference still applies when it is published alongside a different
 * declared default.
 */
function assertDeclaredDefaultIsPublished(
  model: {
    default_aspect_ratio?: string
    aspect_ratios?: string[]
    output_options?: Array<{ resolution: string; aspect_ratio: string }>
  },
  declared: string | undefined,
  label: string,
): void {
  const ratio = (declared || '').trim()
  if (ratio && !isPublishedAspectRatio(model, ratio)) {
    throw new Error(`${label} publishes no ${ratio} output. Choose another model or ratio.`)
  }
}

/**
 * Resolve the aspect ratio a submission may actually use.
 *
 * An empty request is MISSING, not a literal 16:9: it uses the shared Story
 * default (`contracts/genstudio-image-defaults.ts`) — 16:9 when the live
 * catalogue publishes a renderable 16:9, otherwise the model's own published
 * fallback. That is the owner's 2026-10-17 reversal of the old
 * "provider default only" rule. A ratio the model does not publish is still
 * refused instead of being silently substituted (which would bill the
 * customer for a frame they did not choose).
 */
export function resolvePublishedAspectRatio(
  model: GenStudioImageModel,
  requested: string | undefined,
): string {
  const wanted = (requested || '').trim()
  if (!wanted) {
    assertDeclaredDefaultIsPublished(model, model.default_aspect_ratio, model.display_name)
    const fallback = storyDefaultAspectRatio(model)
    if (!fallback) {
      throw new Error(`${model.display_name} publishes no aspect ratios. Refresh the model picker and choose a current model.`)
    }
    return fallback
  }
  // Rows are authoritative when the catalogue publishes them: a ratio whose
  // row exists is renderable even if the separate list omits it. Only a model
  // with NO published contract keeps the old pass-through behaviour.
  const published = publishedAspectRatios(model)
  if (published.length && !isPublishedAspectRatio(model, wanted)) {
    throw new Error(`${model.display_name} does not support ${wanted}. Choose ${published.join(', ')}.`)
  }
  return wanted
}

/**
 * Generator-side twin of `resolvePublishedAspectRatio`, working off the
 * resolved config so a bad ratio fails before any job setup rather than at
 * the submit boundary. Old saved configs with no published ratios (the field
 * is optional) fall through to the caller's value unchanged.
 */
export function resolveConfiguredAspectRatio(
  config: ImageModelConfig,
  requested: string | undefined,
): string {
  const wanted = (requested || '').trim()
  if (!wanted) {
    assertDeclaredDefaultIsPublished(config, config.default_aspect_ratio, config.label)
    const fallback = storyDefaultAspectRatio(config)
    if (!fallback) {
      throw new Error(`${config.label} publishes no aspect ratios. Refresh the model picker and choose a current model.`)
    }
    return fallback
  }
  // Same rows-authoritative contract as the catalogue-side twin above. A
  // legacy saved config with no published list or rows still passes through.
  const published = publishedAspectRatios(config)
  if (published.length && !isPublishedAspectRatio(config, wanted)) {
    throw new Error(`${config.label} does not support ${wanted}. Choose ${published.join(', ')}.`)
  }
  return wanted
}

/**
 * Pick the published output option a submission may actually use.
 *
 * Each `output_options[]` row is ONE VALID COMBINATION of resolution and
 * aspect ratio with its own dimensions and its own price. Rows are never
 * recombined here: a ratio available at 1K but not 2K is expressed by that
 * row simply not existing, and pairing a ratio list against a resolution list
 * would advertise combinations GenStudio has not declared valid.
 *
 * Returns `undefined` when the model publishes no output options at all — the
 * caller then sends aspect ratio only and GenStudio applies its own
 * `default_resolution`, which is exactly today's behaviour. It also returns
 * `undefined` when nothing was requested and the model flags no default for
 * the chosen ratio: no row is picked by position, because "first row wins"
 * would silently bill a resolution the customer never chose.
 */
export function selectPublishedOutputOption<T extends {
  resolution: string
  aspect_ratio: string
  is_default: boolean
}>(
  options: T[] | undefined,
  modelLabel: string,
  aspectRatio: string,
  requestedResolution: string | undefined,
  defaultResolution: string | undefined,
): T | undefined {
  const rows = options || []
  if (!rows.length) return undefined
  const forRatio = rows.filter(row => row.aspect_ratio === aspectRatio)
  if (!forRatio.length) {
    const published = [...new Set(rows.map(row => row.aspect_ratio))].join(', ')
    throw new Error(
      `${modelLabel} publishes no output size for ${aspectRatio}. Choose ${published}.`,
    )
  }
  const wanted = (requestedResolution || '').trim()
  if (wanted) {
    const exact = forRatio.find(row => row.resolution === wanted)
    if (!exact) {
      throw new Error(
        `${modelLabel} does not publish ${wanted} at ${aspectRatio}. ` +
        `Choose ${forRatio.map(row => row.resolution).join(', ')}.`,
      )
    }
    return exact
  }
  const fallback = (defaultResolution || '').trim()
  return forRatio.find(row => row.is_default)
    ?? (fallback ? forRatio.find(row => row.resolution === fallback) : undefined)
}

/**
 * The row a picker should preselect for a model when no ratio was chosen.
 *
 * Shared Story-default policy: a renderable 16:9 row first, then the model's
 * published default. Nothing is chosen by position when the catalogue names
 * no default.
 */
export function defaultPublishedOutputOption<T extends {
  resolution: string
  aspect_ratio: string
  is_default: boolean
}>(
  options: T[] | undefined,
  defaultResolution: string | undefined,
  defaultAspectRatio: string | undefined,
): T | undefined {
  return storyDefaultOutputOption({
    output_options: options,
    default_resolution: defaultResolution,
    default_aspect_ratio: defaultAspectRatio,
  }) ?? undefined
}

/** Catalogue-side wrapper used at the charged submit boundary. */
export function resolvePublishedOutputOption(
  model: GenStudioImageModel,
  aspectRatio: string,
  requestedResolution: string | undefined,
): GenStudioImageOutputOption | undefined {
  return selectPublishedOutputOption(
    model.output_options,
    model.display_name,
    aspectRatio,
    requestedResolution,
    model.default_resolution,
  )
}

/**
 * Generator-side twin working off the resolved config, so an unpublished
 * combination fails before any job setup rather than at the submit boundary.
 * A saved config that predates `output_options` returns `undefined` and the
 * flow degrades to aspect ratio only.
 */
export function resolveConfiguredOutputOption(
  config: ImageModelConfig,
  aspectRatio: string,
  requestedResolution: string | undefined,
): ImageOutputOption | undefined {
  return selectPublishedOutputOption(
    config.output_options,
    config.label,
    aspectRatio,
    requestedResolution,
    config.default_resolution,
  )
}

/**
 * Build the Story-Studio-side view of a live GenStudio image model.
 *
 * Everything capability-shaped is copied from the catalogue entry. Nothing is
 * synthesised: a field GenStudio does not publish is simply left off, so the
 * UI renders "—" instead of a confident lie, and generators that branch on a
 * capability branch on the published value.
 */
export function buildImageModelConfig(
  config: Pick<ProjectConfig, 'image_models'>,
  modelId: string,
  model: GenStudioImageModel,
): ImageModelConfig {
  const supportsReferences = publishedSupportsReferenceImages(model)
  const maxReferenceImages = model.max_reference_images >= 1
    ? model.max_reference_images
    : (supportsReferences ? 1 : 0)
  const shared = {
    supports_reference_images: supportsReferences,
    max_reference_images: maxReferenceImages,
    ...(model.min_reference_images === undefined
      ? {}
      : { min_reference_images: model.min_reference_images }),
    // Copied verbatim like every sibling: absent stays absent, so a model that
    // publishes no pixel ceiling gets no locally-invented one.
    ...(model.reference_image_max_dimension === undefined
      ? {}
      : { reference_image_max_dimension: model.reference_image_max_dimension }),
    ...(model.supports_image_to_image === undefined
      ? {}
      : { supports_image_to_image: model.supports_image_to_image }),
    ...(model.supports_seed === undefined ? {} : { supports_seed: model.supports_seed }),
    aspect_ratios: model.aspect_ratios,
    default_aspect_ratio: model.default_aspect_ratio,
    ...(model.default_resolution === undefined
      ? {}
      : { default_resolution: model.default_resolution }),
    // Copied verbatim, row for row. Nothing is recombined and no row is
    // synthesised — a model that publishes none keeps the field absent, which
    // is what makes the resolution control disappear instead of inventing one.
    ...(model.output_options?.length ? { output_options: model.output_options } : {}),
    available: model.available,
    qualification_only: model.qualification_only,
    chargeable: model.chargeable,
  }
  return {
    label: config.image_models?.[modelId]?.label || model.display_name || model.id,
    // Absent stays absent: a model GenStudio publishes no price for shows no
    // price, rather than a zero the customer would read as "free".
    ...(typeof model.credits_per_image === 'number' ? { credits_per_image: model.credits_per_image } : {}),
    endpoint: '/v1/images/generations',
    poll: '/v1/images/{id}',
    type: 'jobs',
    api_model: model.id,
    provider: 'genstudio-image',
    // Advisory only, and only when GenStudio publishes a ceiling. There is no
    // ratio-derived guess here: characters per token vary sharply by script,
    // and Khmer text would be mis-capped by any such conversion — which is why
    // `prompt_token_allowance` is deliberately NOT read as a character cap.
    ...(model.max_prompt_characters === undefined
      ? {}
      : { prompt_char_cap: model.max_prompt_characters }),
    ...shared,
    // `provider_params` is what `resolveImageProviderParams` hands to the
    // provider and what generators inspect, so the published capability flags
    // have to travel here too — that is exactly what was missing when every
    // model reported "does NOT support references".
    provider_params: { provider: 'genstudio-image', ...shared },
  }
}

/**
 * Resolve a live GenStudio image model into Story Studio's config shape.
 *
 * The catalogue read goes through `listImageModels`, which is already cached
 * and request-coalesced inside genstudio-client, so a 25-scene batch performs
 * one catalogue fetch. Dynamic models are still never written into project
 * config; GenStudio owns availability and capabilities.
 *
 * Returns `undefined` when the id is not a GenStudio image model or is absent
 * from the live catalogue — callers surface that as "Unknown image model",
 * which is the correct outcome for a retired id in an old saved project.
 */
export async function resolveImageModelConfig(
  config: Pick<ProjectConfig, 'image_models'>,
  modelId: string,
  apiKey: string,
): Promise<ImageModelConfig | undefined> {
  const resolvedModelId = resolveGenStudioModelId('image', modelId)
  if (!resolvedModelId) return undefined
  if (!apiKey.trim()) {
    throw new Error('Add the Gateway API Key in Settings before generating images.')
  }
  // Alias-aware: a saved raw id still resolves after GenStudio republishes the
  // product under its customer handle.
  const model = findGenStudioProduct(await listImageModels(apiKey), resolvedModelId)
  if (!model) return undefined
  return buildImageModelConfig(config, modelId, model)
}
