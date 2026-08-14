import type { ImageModelConfig, ImageOutputOption, ProjectConfig } from '../models/types.js'
import { listImageModels, type GenStudioImageModel, type GenStudioImageOutputOption } from '../lib/genstudio-client.js'
import { resolveGenStudioModelId } from './genstudio-model-migration.js'

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

/** Human-readable reason a model cannot be submitted right now, or ''. */
export function publishedAvailabilityProblem(model: GenStudioImageModel): string {
  if (model.locked) {
    return `${model.display_name} is visible for comparison but locked for this GenStudio account. Choose an unlocked published model.`
  }
  if (!model.available) {
    return `${model.display_name} is currently unavailable in GenStudio. Choose a published model.`
  }
  if (model.qualification_only) {
    return `${model.display_name} is qualification-only for this account and cannot be submitted.`
  }
  return ''
}

/**
 * Resolve the aspect ratio a submission may actually use.
 *
 * An empty request falls back to the model's PUBLISHED default rather than a
 * hardcoded '16:9', and a ratio the model does not publish is refused instead
 * of being silently substituted (which would bill the customer for a frame
 * they did not choose).
 */
export function resolvePublishedAspectRatio(
  model: GenStudioImageModel,
  requested: string | undefined,
): string {
  const wanted = (requested || '').trim()
  const ratios = model.aspect_ratios || []
  const fallback = (model.default_aspect_ratio || '').trim() || ratios[0] || ''
  if (!wanted) {
    if (!fallback) {
      throw new Error(`${model.display_name} publishes no aspect ratios. Refresh the model picker and choose a current model.`)
    }
    return fallback
  }
  if (ratios.length && !ratios.includes(wanted)) {
    throw new Error(`${model.display_name} does not support ${wanted}. Choose ${ratios.join(', ')}.`)
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
  const ratios = config.aspect_ratios || []
  const fallback = (config.default_aspect_ratio || '').trim() || ratios[0] || ''
  if (!wanted) {
    if (!fallback) {
      throw new Error(`${config.label} publishes no aspect ratios. Refresh the model picker and choose a current model.`)
    }
    return fallback
  }
  if (ratios.length && !ratios.includes(wanted)) {
    throw new Error(`${config.label} does not support ${wanted}. Choose ${ratios.join(', ')}.`)
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
 * The row a picker should preselect for a model, with no ratio chosen yet.
 *
 * `is_default` first, then the published `default_resolution` +
 * `default_aspect_ratio` pair. Nothing is chosen by position.
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
  const rows = options || []
  if (!rows.length) return undefined
  const flagged = rows.find(row => row.is_default)
  if (flagged) return flagged
  const resolution = (defaultResolution || '').trim()
  const ratio = (defaultAspectRatio || '').trim()
  if (!resolution || !ratio) return undefined
  return rows.find(row => row.resolution === resolution && row.aspect_ratio === ratio)
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
    throw new Error('Add the GenStudio API key in Settings before generating images.')
  }
  const model = (await listImageModels(apiKey)).find(item => item.id === resolvedModelId)
  if (!model) return undefined
  return buildImageModelConfig(config, modelId, model)
}
