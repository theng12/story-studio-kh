import { createHash } from 'node:crypto'
import { findGenStudioProduct, type GenStudioProductIdentity } from '../contracts/genstudio-product-identity.js'
import { parsePromptCharCap } from './prompt-char-cap.js'

export interface StoredPresetLike {
  id: string
  name?: string
  type?: string
  data?: Record<string, any>
  [key: string]: any
}

export function resolveExactPreset(
  config: any,
  listKeys: string | string[],
  activeKeys: string[],
  explicitId: unknown,
  label: string,
  explicitProvided = explicitId !== undefined,
): { preset: StoredPresetLike | null; missingReason: string | null } {
  const keys = Array.isArray(listKeys) ? listKeys : [listKeys]
  const list: StoredPresetLike[] = keys.flatMap(key => Array.isArray(config?.[key]) ? config[key] : [])
  const requestedId = typeof explicitId === 'string' ? explicitId.trim() : ''
  if (explicitProvided) {
    if (!requestedId) {
      return { preset: null, missingReason: `The requested ${label} preset id must be a non-empty string.` }
    }
    const preset = list.find(item => item?.id === requestedId) || null
    return preset
      ? { preset, missingReason: null }
      : { preset: null, missingReason: `The requested ${label} preset is not in its current preset collection.` }
  }

  let selectedId = ''
  for (const key of activeKeys) {
    const value = typeof config?.[key] === 'string' ? config[key].trim() : ''
    if (!value) continue
    selectedId = value
    break
  }
  if (!selectedId) {
    return { preset: null, missingReason: `No active preset for ${label}. Apply a preset, then retry.` }
  }
  const preset = list.find(item => item?.id === selectedId) || null
  return preset
    ? { preset, missingReason: null }
    : { preset: null, missingReason: `The selected ${label} preset is missing or was deleted. Pick another preset, then retry.` }
}

/** The channel's CURRENT automatic scene approval: the active Scene Review preset (the one Pipeline
 * runs, keys mirror PRESET_KEYS.scene_review) saved with `auto_approve_generated` on. */
export function sceneReviewAutoApproveOn(config: unknown): boolean {
  const { preset } = resolveExactPreset(
    config, 'scene_review_genstudio_presets', ['scene_review_genstudio_last_preset_scene-review'], undefined, 'Scene Review')
  return preset?.data?.auto_approve_generated === true
}

const SCENE_PLAN_REUSABLE_KEYS = [
  'model',
  'use_research',
  'prompt_pack_size',
  'prompt_max_tokens',
  'intended_image_model',
  'prompt_char_cap',
  'creative_direction',
  'reusable_guidance',
  'avoid_legible_text',
  'pacing',
  'motion_scope',
  'motion_level',
] as const

export function sanitizeScenePlanPresetData(value: unknown): Record<string, any> {
  const data = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : {}
  const sanitized = Object.fromEntries(
    SCENE_PLAN_REUSABLE_KEYS
      .filter(key => data[key] !== undefined)
      .map(key => [key, structuredClone(data[key])]),
  )
  if (sanitized.motion_scope?.mode === 'selected') delete sanitized.motion_scope
  return sanitized
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function scenePlanPresetReceipt(preset: StoredPresetLike) {
  const data = sanitizeScenePlanPresetData(preset.data ?? preset)
  return {
    pool: 'scene_plan_presets',
    id: preset.id,
    content_fingerprint: createHash('sha256').update(stableJson(data)).digest('hex'),
    data,
  }
}

export function composeScenePlanGuidance(episodeGuidance: unknown, reusableGuidance: unknown): string | undefined {
  const parts = [episodeGuidance, reusableGuidance]
    .filter((value): value is string => typeof value === 'string')
    .map(value => value.trim())
    .filter(Boolean)
  return parts.length ? parts.join('\n\n') : undefined
}

/**
 * The CHARACTER CEILING a preset asks for, resolved against the LIVE image
 * catalogue.
 *
 * `intended_image_model` names the image model the prompts are written FOR;
 * `prompt_char_cap` is the saved SELECTION — 'auto' (follow that model), 'none'
 * (no ceiling), or an explicit number. The published ceiling comes from the
 * catalogue, never from a list kept here, so a model that changes its ceiling
 * changes it on the next admission.
 *
 * The label names the surface in the refusal, because this resolver is shared
 * by the Scene Plan step and the Thumbnail Prompts step.
 */
export function resolveScenePlanPromptCharCap(
  data: Record<string, any>,
  catalog: ReadonlyArray<GenStudioProductIdentity & { max_prompt_characters?: number }>,
  label = 'The Scene Plan preset',
): number | undefined {
  const intended = typeof data.intended_image_model === 'string' ? data.intended_image_model.trim() : ''
  if (!intended) return parsePromptCharCap(data.prompt_char_cap)
  const model = findGenStudioProduct(catalog, intended)
  if (!model) throw new Error(`${label}'s intended image model is not in the current image catalogue.`)
  const published = parsePromptCharCap(model.max_prompt_characters)
  if (data.prompt_char_cap === 'auto') return published
  if (data.prompt_char_cap === 'none') return undefined
  const selected = parsePromptCharCap(data.prompt_char_cap)
  return selected && published ? Math.min(selected, published) : selected
}

/**
 * The Thumbnail Prompts preset's own ceiling inputs.
 *
 * The Thumbnail Prompts page saves its settings under `{ form: { … } }` (see
 * its preset snapshot), while a Scene Plan preset keeps its reusable settings
 * at the top level. Only the two fields the character ceiling needs are read
 * here — this is NOT a general preset sanitizer, and it changes nothing that is
 * stored.
 */
export function thumbnailPromptPresetCapInputs(preset: StoredPresetLike | undefined | null): { intended_image_model: string; prompt_char_cap: unknown } {
  const data = (preset?.data ?? preset ?? {}) as Record<string, any>
  const form = data.form && typeof data.form === 'object' && !Array.isArray(data.form) ? data.form : null
  const source = (form ?? data) as Record<string, any>
  return {
    intended_image_model: typeof source.intended_image_model === 'string' ? source.intended_image_model : '',
    prompt_char_cap: source.prompt_char_cap,
  }
}
