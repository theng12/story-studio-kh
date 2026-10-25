/**
 * The live-catalogue checks every style-preview route shares.
 *
 * A style preview goes through a paid image model, so the model and the aspect
 * ratio are resolved against GenStudio's LIVE catalogue on every call (§1) and
 * a published prompt ceiling is enforced before any request is made. Two routes
 * need exactly this — the owner's own styles (`routes/user-style-previews.ts`)
 * and a channel's custom styles (`routes/channel-style-previews.ts`) — and a
 * second copy of these rules is a second place for them to drift: the refusals
 * carry the model's own published numbers, and a duplicated message is a
 * duplicated chance to state one of them wrongly.
 *
 * It returns the refusal rather than sending it, so each route keeps its own
 * `res` and nothing here depends on Express.
 */

import { listImageModels, type GenStudioImageModel } from './genstudio-client.js'

export interface PreviewImageModelRefusal {
  status: number
  detail: string
}

export type PreviewImageModelResolution =
  | { model: GenStudioImageModel }
  | { refusal: PreviewImageModelRefusal }

/**
 * Resolve the model a preview will be rendered with, or refuse it by name.
 *
 * `prompts` are the exact prompts this call would send, each labelled with what
 * it renders ("the face preview"): the one that does not fit the model's
 * published ceiling is named with both its own length and the model's, and the
 * request is refused before anything is spent. A model that publishes no ceiling
 * gets no local check — never an invented one.
 */
export async function resolvePreviewImageModel(input: {
  apiKey: string
  modelId: string
  aspectRatio: string
  prompts: Array<{ label: string; prompt: string }>
}): Promise<PreviewImageModelResolution> {
  let catalog: GenStudioImageModel[]
  try {
    catalog = await listImageModels(input.apiKey)
  } catch (error: unknown) {
    return { refusal: { status: 502, detail: (error as Error)?.message || 'Could not load the Gateway image catalog' } }
  }
  const model = catalog.find(candidate => candidate.id === input.modelId)
  if (!model) {
    return { refusal: { status: 400, detail: `The selected model is not in the live Gateway image catalog: ${input.modelId}` } }
  }
  if (!model.available) {
    return { refusal: { status: 409, detail: `${model.display_name} is currently unavailable in the Gateway.` } }
  }
  if (model.locked) {
    return { refusal: { status: 409, detail: `${model.display_name} is locked for this Gateway account.` } }
  }
  if (model.aspect_ratios.length && !model.aspect_ratios.includes(input.aspectRatio)) {
    return {
      refusal: {
        status: 400,
        detail: `${model.display_name} does not support ${input.aspectRatio}. Choose ${model.aspect_ratios.join(', ')}.`,
      },
    }
  }
  if (model.max_prompt_characters) {
    for (const { label, prompt } of input.prompts) {
      if (prompt.length <= model.max_prompt_characters) continue
      return {
        refusal: {
          status: 400,
          detail: `${model.display_name} accepts up to ${model.max_prompt_characters.toLocaleString()} prompt characters; ${label} is ${prompt.length.toLocaleString()}. Shorten the style's own text, or choose a model with a longer ceiling.`,
        },
      }
    }
  }
  return { model }
}
