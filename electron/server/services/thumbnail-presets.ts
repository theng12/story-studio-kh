/**
 * The two thumbnail steps' saved presets, and the model each one must name.
 *
 * Both steps are preset-only by design (AGENTS §7): Thumbnail **Prompts** is
 * the writing surface with `thumbnail_prompts_presets` /
 * `thumbnail_prompts_last_preset`, and the Thumbnail **Generator** is the
 * rendering surface with `thumbnail_generator_presets` /
 * `thumbnail_generator_last_preset`. This module is the ONE place that reads
 * those keys — the Pipeline's preflight, the Pipeline's params mapper, and the
 * two enqueue routes all ask here, so they cannot disagree about what a channel
 * chose.
 *
 * Why a model must be named at all: Story Studio does not own the model
 * (AGENTS §1, owner 2026-10-17). It must never pick one, so a run with nothing
 * chosen is REFUSED before it is admitted, in plain words naming the page to
 * open — never admitted to fail a minute later against a model nobody picked.
 * The defect this closes is recorded on the owner's own projects (`image_prompts`
 * jobs admitted with `model: ''` and a channel whose `thumbnail_prompts_presets`
 * was empty failed instantly inside the generator).
 *
 * Preset shapes are not uniform: a typed preset nests its form, an older one is
 * flat, and the Thumbnail Prompts page has stored the writing model under
 * `model`, `form.model` and `prompt_model` over its life. All three are read, so
 * a preset the page itself can read is never reported as model-less.
 */

import { noWritingModelChosenMessage } from './genstudio-default-model.js'

/** A stored preset, in the shape `usePresets` writes and older builds wrote. */
type StoredPreset = { id?: string; name?: string; type?: string; data?: any; [key: string]: any }

/**
 * The §7 storage keys for each step. Mirrors `PRESET_KEYS` in
 * `routes/pipeline.ts`; kept in step with it by
 * `__tests__/thumbnail-count-defaults.test.ts`.
 */
export const THUMBNAIL_PRESET_KEYS = {
  image_prompts: {
    list: 'thumbnail_prompts_presets',
    activeKeys: ['thumbnail_prompts_last_preset'],
  },
  thumb_images: {
    list: 'thumbnail_generator_presets',
    activeKeys: ['thumbnail_generator_last_preset'],
  },
} as const

export type ThumbnailStep = keyof typeof THUMBNAIL_PRESET_KEYS

/** The preset body — `{ id, name, type, data }`, or the body at the root. */
function presetBody(preset: unknown): Record<string, any> | null {
  const data = (preset as StoredPreset | undefined)?.data ?? preset
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  return data as Record<string, any>
}

/**
 * The channel's active preset for one thumbnail step, or null.
 *
 * Resolution order is the page's own: the active pointer, then a preset marked
 * last-used, then the newest stored one. A pointer naming a preset that is no
 * longer in the list falls through rather than reporting "no preset" — the same
 * tolerance `modelFromThumbnailPromptsPreset` has always had.
 */
export function activeThumbnailPreset(
  config: Record<string, any> | null | undefined,
  step: ThumbnailStep,
): StoredPreset | null {
  if (!config) return null
  const { list, activeKeys } = THUMBNAIL_PRESET_KEYS[step]
  const presets = Array.isArray(config[list]) ? config[list] as StoredPreset[] : []
  if (!presets.length) return null
  const activeId = activeKeys
    .map(key => config[key])
    .find(value => typeof value === 'string' && value) || ''
  return presets.find(entry => entry?.id === activeId)
    || presets.find(entry => entry?.last_used === true)
    || presets[presets.length - 1]
    || null
}

/**
 * The writing model a Thumbnail Prompts preset names ('' when it names none).
 *
 * Exported because the Pipeline's `PRESET_MODEL_READERS` reads the same shape
 * off a preset body rather than a whole config.
 */
export function thumbnailPromptsModelFromPreset(preset: unknown): string {
  const body = presetBody(preset)
  if (!body) return ''
  return String(body.form?.model || body.model || body.prompt_model || '').trim()
}

/** The image model a Thumbnail Generator preset names ('' when it names none). */
export function thumbnailGeneratorModelFromPreset(preset: unknown): string {
  const body = presetBody(preset)
  if (!body) return ''
  return String(body.form?.model || body.model || '').trim()
}

/** The writing model this channel's active Thumbnail Prompts preset names. */
export function modelFromThumbnailPromptsPreset(config: Record<string, any> | null | undefined): string {
  return thumbnailPromptsModelFromPreset(activeThumbnailPreset(config, 'image_prompts'))
}

/** The image model this channel's active Thumbnail Generator preset names. */
export function modelFromThumbnailGeneratorPreset(config: Record<string, any> | null | undefined): string {
  return thumbnailGeneratorModelFromPreset(activeThumbnailPreset(config, 'thumb_images'))
}

/**
 * The model a thumbnail run should use: what the request named, else what the
 * channel's saved preset names. '' when neither has one — the caller refuses
 * with `noThumbnailModelMessage` rather than substituting a model.
 */
export function resolveThumbnailModel(
  config: Record<string, any> | null | undefined,
  step: ThumbnailStep,
  requested?: unknown,
): string {
  const asked = typeof requested === 'string' ? requested.trim() : ''
  if (asked) return asked
  return step === 'image_prompts'
    ? modelFromThumbnailPromptsPreset(config)
    : modelFromThumbnailGeneratorPreset(config)
}

/** The page a caller must send the customer to for each step. */
export function thumbnailStepPage(step: ThumbnailStep): string {
  return step === 'image_prompts' ? 'the Thumbnail Prompts page' : 'the Thumbnail Generator page'
}

/**
 * Plain words for a thumbnail run that has no model — the sentence the Pipeline
 * preflight and both enqueue routes give, so a refused run reads the same
 * wherever it was started.
 *
 * The writing step reuses the app's one "choose a writing model" sentence; the
 * rendering step names an IMAGE model, because that is what it needs and
 * "writing model" would send the customer to the wrong control.
 */
export function noThumbnailModelMessage(step: ThumbnailStep): string {
  if (step === 'image_prompts') return noWritingModelChosenMessage(thumbnailStepPage(step))
  return 'No image model is chosen for this step. Choose one on '
    + `${thumbnailStepPage(step)}, then run it again. `
    + 'Story Studio does not pick an image model for you.'
}
