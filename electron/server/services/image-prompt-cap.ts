/**
 * The CHARACTER CEILING a thumbnail prompt is written under — resolved LIVE.
 *
 * WHY THIS EXISTS
 * ---------------
 * The ceiling belongs to the image model the customer intends to render with,
 * and only GenStudio publishes it. A client that resolved the number earlier
 * and sent it as a VALUE froze the ceiling at the moment the page loaded: a
 * model change, a catalogue change, or a different Mac left the writer working
 * to a number that was no longer true — and the "auto" choice silently became
 * a fixed number that no longer followed the model.
 *
 * So the CLIENT sends the SELECTION — 'auto' (follow the selected model),
 * 'none' (no ceiling), or a whole number the customer chose — together with
 * the model id it selected. The server resolves that selection against the
 * LIVE catalogue with the same helper the Pipeline's admission check uses, so
 * the ceiling always follows the model.
 *
 * WHAT THE SELECTION MEANS (the helper's semantics, unchanged)
 * -----------------------------------------------------------
 *   'auto' → the model's published `max_prompt_characters` right now; if the
 *            model publishes none, no ceiling is in force (nothing invented).
 *   'none' → no ceiling at all.
 *   number → the customer's own ceiling. A TIGHTER allowance stays tighter;
 *            a looser one cannot push a prompt past what the model accepts.
 *
 * NOTHING HERE INVENTS A NUMBER. A model the catalogue no longer publishes,
 * a malformed selection and a missing Gateway key are all REFUSED with a
 * reason. An unpublished cap for a valid model means NO ceiling is in force,
 * not an error — only an explicit customer ceiling survives that case.
 */

import { listImageModels } from '../lib/genstudio-client.js'
import { findGenStudioProduct } from '../contracts/genstudio-product-identity.js'
import { getApiKey } from './app-secrets-store.js'
import { resolveGenStudioModelId } from './genstudio-model-migration.js'
import { resolveScenePlanPromptCharCapDetail } from './preset-authority.js'
import { ImagePromptCapUnavailableError, parsePromptCharCap } from './prompt-char-cap.js'

/** The persisted SELECTION. A number is the customer's own ceiling. */
export type PromptCharCapSelection = 'auto' | 'none' | number

export interface LiveImagePromptCapRequest {
  /** The image model these prompts are written FOR, as the customer selected it. */
  intendedImageModel?: unknown
  /** The selection: 'auto' | 'none' | a whole number. */
  setting?: unknown
  /** How the refusal names the surface. */
  label?: string
  /** What did NOT happen, appended to a refusal. */
  nothingHappened?: string
}

export interface LiveImagePromptCap {
  /** The ceiling to enforce, or undefined when no ceiling is in force. */
  cap?: number
  /** The model's published figure, when the catalogue supplied one. Kept
   *  apart from `cap` so a tighter customer choice is never described as the
   *  model's limit. */
  publishedCap?: number
  /** Why the request cannot be honoured, when it cannot. */
  error?: string
}

/**
 * Read the selection, or say plainly that it is not one.
 *
 * Only the three shapes the customer can choose are accepted: the literals
 * 'auto' / 'none', or a positive whole number. Numeric strings are accepted
 * too, because legacy presets may persist the cap as a string and the
 * Pipeline admission path (`parsePromptCharCap`) already treats them as
 * numbers — refusing them here would admit a preset at the Pipeline gate
 * and then kill it inside the executor. Booleans, arrays and objects are
 * refused rather than quietly coerced, because `Number(true) === 1` would
 * otherwise resolve to a ceiling the customer never chose.
 */
function readSelection(value: unknown): { ok: true; selection?: PromptCharCapSelection } | { ok: false; error: string } {
  if (value === undefined || value === null || value === '') return { ok: true, selection: undefined }
  if (value === 'auto' || value === 'none') return { ok: true, selection: value }
  if (typeof value !== 'number' && typeof value !== 'string') {
    return {
      ok: false,
      error: 'The character limit must be "auto", "none", or a whole number of characters.',
    }
  }
  const parsed = parsePromptCharCap(value)
  if (parsed !== undefined) return { ok: true, selection: parsed }
  return {
    ok: false,
    error: 'The character limit must be "auto", "none", or a whole number of characters.',
  }
}

/**
 * Resolve the ceiling for a request that names the image model it is written
 * for, against the LIVE catalogue.
 *
 * No model named → no catalogue is needed: the customer's own number is the
 * only ceiling there is, and no Gateway key is required for a request that
 * asks for no model.
 */
export async function resolveLiveImagePromptCharCap(
  request: LiveImagePromptCapRequest,
): Promise<LiveImagePromptCap> {
  const label = request.label || 'The Thumbnail Prompts selection'
  const nothing = request.nothingHappened || 'Nothing was changed.'
  const selection = readSelection(request.setting)
  if (!selection.ok) return { error: `${selection.error} ${nothing}` }

  const intended = typeof request.intendedImageModel === 'string' ? request.intendedImageModel.trim() : ''
  // "none" needs no figure from the model, so a retired model or missing key cannot block it.
  if (selection.selection === 'none') return { cap: undefined }
  if (!intended) {
    // No model named: the helper's own rule applies — a number is the
    // ceiling, anything else means no ceiling is in force. Nothing published
    // was read, so nothing is labelled as published.
    const { cap } = resolveScenePlanPromptCharCapDetail(
      { intended_image_model: '', prompt_char_cap: selection.selection },
      [],
      label,
    )
    return { cap }
  }

  const apiKey = await getApiKey('genstudio').catch(() => '')
  if (!apiKey) {
    return {
      error: 'Add the Gateway API Key in Settings before the character limit for the selected image model can be resolved. '
        + nothing,
    }
  }
  const catalogue = await listImageModels(apiKey)
  try {
    const { cap, publishedCap } = resolveScenePlanPromptCharCapDetail(
      { intended_image_model: intended, prompt_char_cap: selection.selection },
      catalogue,
      label,
    )
    return { cap, publishedCap }
  } catch {
    // The selected model is not in the catalogue. Nothing is invented in its
    // place — the customer is told which model could not be resolved.
    return {
      error: `The selected image model "${intended}" is not in the current image catalogue, so its character limit could not be resolved. `
        + nothing,
    }
  }
}

/**
 * The same resolution for a caller that must FAIL rather than answer.
 *
 * Used by an executor, which runs inside a job: there is no HTTP response to
 * carry a refusal, so the refusal is thrown — typed, so the queue refuses to
 * retry it. The job stops with the reason in its log and no prompt is
 * written.
 */
export async function requireLiveImagePromptCharCap(
  request: LiveImagePromptCapRequest,
): Promise<number | undefined> {
  return (await requireLiveImagePromptCharCapDetail(request)).cap
}

/** As above, keeping the model's published figure separate from the enforced
 *  one for callers that must not present a chosen limit as published. */
export async function requireLiveImagePromptCharCapDetail(
  request: LiveImagePromptCapRequest,
): Promise<{ cap?: number; publishedCap?: number }> {
  const result = await resolveLiveImagePromptCharCap(request)
  if (result.error) throw new ImagePromptCapUnavailableError(result.error)
  return { cap: result.cap, publishedCap: result.publishedCap }
}

/**
 * The image model's OWN published `max_prompt_characters`, read live for one
 * scene render.
 *
 * Deliberately NOT a selection: a scene render is not writing a prompt, it is
 * SUBMITTING one, so the only figure that may govern it is the model's own.
 * There is no 'auto' / 'none' / chosen-number choice here to resolve, and no
 * customer ceiling is consulted — a tighter customer writing budget cannot
 * loosen what the model accepts, and a looser one cannot tighten it.
 *
 * Read through the same cached, coalesced catalogue call the model resolver
 * has just made, so a 25-scene batch costs no extra request. That copy is
 * refreshed on the catalogue's own schedule rather than held from an earlier
 * render, so a model that republishes a different figure takes effect on the
 * next render without anything being stored and without a reload.
 *
 * No published figure — an unpublished cap, a saved id the catalogue no longer
 * answers to, a missing key, an unreadable catalogue — means `undefined`.
 * The caller then sends the assembled prompt untrimmed rather than inventing a
 * ceiling (§1), and a catalogue fault never turns a working render into a
 * failed one.
 */
export async function publishedSceneRenderPromptCap(
  apiKey: string,
  modelId: string,
): Promise<number | undefined> {
  const resolved = resolveGenStudioModelId('image', modelId)
  if (!resolved || !apiKey.trim()) return undefined
  const catalogue = await listImageModels(apiKey).catch(() => null)
  if (!catalogue) return undefined
  return parsePromptCharCap(findGenStudioProduct(catalogue, resolved)?.max_prompt_characters)
}
