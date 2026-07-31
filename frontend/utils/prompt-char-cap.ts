/**
 * The prompt-character cap the prompt-writing LLM writes against.
 *
 * THE RULE
 * --------
 * Story Studio publishes NO character limit of its own. Every number offered
 * by this control comes from GenStudio's published `max_prompt_characters` on
 * the live image-model catalogue, and the options are the distinct caps that
 * usable image models actually publish — never a static 2000/4000/8000 ladder.
 * A model that publishes no cap contributes no option and, when it is the
 * selected one, produces NO limit and NO warning rather than an invented number.
 *
 * `prompt_token_allowance` is published separately, in TOKENS, and is never
 * converted into characters: characters per token vary sharply by script and
 * Khmer narration would be badly mis-capped by any fixed ratio.
 *
 * WHAT IS PERSISTED
 * -----------------
 * Only the SELECTION — 'auto' (follow the intended image model), 'none' (no
 * limit), or an explicit number. A resolved catalogue figure is
 * never written into a preset, because GenStudio may change it.
 *
 * NOTHING HERE SHORTENS A PROMPT. The cap is a CEILING for the writer and a
 * reading on the result; an over-cap prompt is flagged amber and left intact.
 * It is never a length to fill — a scene that wants 500 characters keeps 500
 * under an 8,000 ceiling.
 */

/**
 * 'auto'   follow the intended image model's published cap, whatever it is now.
 * 'none'   no limit at all.
 * number   an explicit ceiling. Offered both as the distinct published caps and
 *          as a free "Custom" number, because a SMALLER ceiling is a cost
 *          control: shorter prompts are fewer completion tokens on every scene.
 *          A custom number is therefore never raised to meet the model's
 *          published cap — only flagged when it goes ABOVE it, which is the
 *          case that actually breaks rendering.
 */
export type PromptCharCapSetting = 'auto' | 'none' | number

/** The single catalogue field this module reads. */
export interface PromptCapModel {
  id?: string
  display_name?: string
  available?: boolean
  qualification_only?: boolean
  max_prompt_characters?: number
}

/** `0` means "not published" — never a Story Studio guess. */
function positiveInt(value: unknown): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0
}

/** The cap one model publishes, or 0 when it publishes none. */
export function publishedPromptCharCap(model: PromptCapModel | null | undefined): number {
  return model ? positiveInt(model.max_prompt_characters) : 0
}

/**
 * The selectable ceilings, derived from the DISTINCT caps published across the
 * image models this account can actually submit to. An empty catalogue — or one
 * where nothing publishes a cap — yields an empty list, and the control then
 * offers only "no limit" instead of inventing steps.
 */
export function promptCharCapOptions(models: readonly PromptCapModel[] | null | undefined): number[] {
  if (!models?.length) return []
  const caps = new Set<number>()
  for (const model of models) {
    // A retired or qualification-only model cannot be rendered with, so its cap
    // is not a ceiling anyone should be offered to write against.
    if (model.available === false) continue
    if (model.qualification_only === true) continue
    const cap = publishedPromptCharCap(model)
    if (cap) caps.add(cap)
  }
  return [...caps].sort((a, b) => a - b)
}

/**
 * Turn the persisted SELECTION into the number actually used, given the cap the
 * currently selected image model publishes right now.
 *
 * Returns 0 for "no cap": either the user chose 'none', or 'auto' is in force
 * and the selected model publishes nothing (or no model is selected yet).
 */
export function resolvePromptCharCap(
  setting: PromptCharCapSetting,
  selectedModelCap: number,
): number {
  if (setting === 'none') return 0
  if (setting === 'auto') return positiveInt(selectedModelCap)
  // Deliberately NOT clamped to the model's cap in either direction. Clamping
  // up would destroy the cost control; clamping down would silently override a
  // choice the user made on purpose. Going above is warned about instead.
  return positiveInt(setting)
}

/**
 * True when the ceiling in force is larger than what the intended image model
 * publishes — the one combination that still ends in a render-time refusal.
 * False whenever either number is unpublished/absent, so an unknown model never
 * produces a warning.
 */
export function promptCharCapAboveModel(cap: number, selectedModelCap: number): boolean {
  const chosen = positiveInt(cap)
  const published = positiveInt(selectedModelCap)
  return !!chosen && !!published && chosen > published
}

/** Shape check only — 'auto', 'none', or a positive whole number. What is
 *  LEGAL belongs to the image model, so no option list is consulted here. */
export function normalizePromptCharCapSetting(value: unknown): PromptCharCapSetting {
  if (value === 'none') return 'none'
  if (value === 'auto' || value == null || value === '') return 'auto'
  const cap = Number(value)
  return Number.isInteger(cap) && cap >= 1 ? cap : 'auto'
}

/**
 * Count a prompt exactly the way the submit-time guard in the GenStudio image
 * provider counts it (`prompt.trim().length`), so "fits" here means "accepted"
 * there.
 */
export function promptCharacterCount(text: unknown): number {
  return typeof text === 'string' ? text.trim().length : 0
}

export interface PromptLengthState {
  characters: number
  cap: number
  /** True ONLY when a cap is in force and the prompt is past it. */
  overCap: boolean
  /** Characters past the cap, 0 when inside it or uncapped. */
  overage: number
}

export function promptLengthState(text: unknown, cap: number): PromptLengthState {
  const characters = promptCharacterCount(text)
  const limit = positiveInt(cap)
  if (!limit) return { characters, cap: 0, overCap: false, overage: 0 }
  const overage = Math.max(0, characters - limit)
  return { characters, cap: limit, overCap: overage > 0, overage }
}

/** Badge text: `1,204 / 4,800` when capped, `1,204` when not. */
export function promptLengthLabel(state: PromptLengthState): string {
  return state.cap
    ? `${state.characters.toLocaleString()} / ${state.cap.toLocaleString()}`
    : state.characters.toLocaleString()
}

/**
 * The badge's visual state. Over-cap is AMBER, not red: it is a nudge, not a
 * block — generation already succeeded, the prompt is intact, and the user can
 * render anyway if they judge the published cap generous.
 */
export function promptLengthTone(state: PromptLengthState): 'neutral' | 'ok' | 'warn' {
  if (!state.cap) return 'neutral'
  return state.overCap ? 'warn' : 'ok'
}
