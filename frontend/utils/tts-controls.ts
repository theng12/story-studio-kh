/**
 * Rendering the TTS controls a model publishes — without knowing any of them.
 *
 * GenStudio's `TTSModelResponse.controls[]` describes, per model, every extra
 * knob that model takes: `name`, `label`, `type`, the published bounds
 * (`minimum`/`maximum`/`step`, or `max_length` for text), the `default`, and a
 * `description` written for the customer. The Audio Generator renders that list
 * and sends back exactly the names on it.
 *
 * The binding rule (AGENTS.md → "Everything Follows the Selected Model") at
 * full force: NO control name, range, default, step or label may appear in
 * Story Studio's code. Not here, not in the panel component, not in the page.
 * A model that publishes a control nobody has ever seen must render and submit
 * with no code change; a model publishing `controls: []` shows no control
 * section at all. `frontend/__tests__/ttsPublishedControls.test.ts` fabricates
 * a control to prove both.
 *
 * Unknown types degrade safely: GenStudio may add a fourth type later, and an
 * older Story Studio must skip it rather than crash or guess a widget for it.
 */

/** The control types this build can render, bind and submit. */
export const RENDERABLE_TTS_CONTROL_TYPES = ['number', 'boolean', 'text'] as const
export type RenderableTtsControlType = typeof RENDERABLE_TTS_CONTROL_TYPES[number]

/** Every value shape a control may carry, exactly as the contract allows. */
export type TtsControlValue = number | boolean | string
export type TtsControlValues = Record<string, TtsControlValue>

/**
 * One row of `TTSModelResponse.controls[]`, as it arrives.
 *
 * `type` stays a plain string so an unrecognised published type survives the
 * trip intact and is filtered at the point of rendering.
 */
export interface GenStudioTtsControl {
  name: string
  label: string
  type: string
  minimum: number | null
  maximum: number | null
  default: TtsControlValue
  step: number | null
  max_length: number | null
  description: string
}

/** True for a type this build knows how to render. */
export function isRenderableTtsControl(control: { type: string }): boolean {
  return (RENDERABLE_TTS_CONTROL_TYPES as readonly string[]).includes(control.type)
}

/**
 * Bring one value inside what the control publishes, or reject it.
 *
 * Numbers are clamped to the published `minimum`/`maximum`; an unpublished
 * bound is no bound, never a bound invented here. Text is cut to the published
 * `max_length`. A value of the wrong shape is rejected so the caller falls back
 * to the published default.
 */
export function coerceTtsControlValue(
  control: GenStudioTtsControl,
  value: unknown,
): TtsControlValue | undefined {
  if (!isRenderableTtsControl(control)) return undefined
  if (control.type === 'number') {
    if (typeof value === 'boolean' || value === null || value === undefined || value === '') return undefined
    const numeric = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(numeric)) return undefined
    let bounded = numeric
    if (control.minimum !== null) bounded = Math.max(control.minimum, bounded)
    if (control.maximum !== null) bounded = Math.min(control.maximum, bounded)
    return bounded
  }
  if (control.type === 'boolean') return typeof value === 'boolean' ? value : undefined
  if (typeof value !== 'string') return undefined
  return control.max_length !== null && control.max_length >= 0
    ? value.slice(0, control.max_length)
    : value
}

/** The published default, brought inside the control's own published bounds. */
export function defaultTtsControlValue(control: GenStudioTtsControl): TtsControlValue | undefined {
  return coerceTtsControlValue(control, control.default)
}

/**
 * THE one place that decides which control values leave this page.
 *
 * Built from the SELECTED model's published list, so a name that model does not
 * publish cannot ride along — whatever a preset, a remembered form or a
 * previously selected model left behind — and a value outside its published
 * range is clamped before it is sent. A missing or wrongly-shaped value falls
 * back to the published default; a control whose type this build cannot render
 * is omitted entirely.
 *
 * A model publishing no controls yields `{}`, which the request omits.
 */
export function resolveTtsControlValues(
  published: readonly GenStudioTtsControl[] | null | undefined,
  chosen?: Record<string, unknown> | null,
): TtsControlValues {
  const resolved: TtsControlValues = {}
  for (const control of published || []) {
    if (!isRenderableTtsControl(control)) continue
    const supplied = chosen && Object.prototype.hasOwnProperty.call(chosen, control.name)
      ? coerceTtsControlValue(control, chosen[control.name])
      : undefined
    const value = supplied ?? defaultTtsControlValue(control)
    if (value === undefined) continue
    resolved[control.name] = value
  }
  return resolved
}

/** Every control reset to the model's own published default. */
export function defaultTtsControlValues(
  published: readonly GenStudioTtsControl[] | null | undefined,
): TtsControlValues {
  return resolveTtsControlValues(published, null)
}

/**
 * What the panel renders, one entry per published control it can draw.
 *
 * The `kind` is the published `type`, narrowed to the three this build draws —
 * it is the ONLY thing the panel branches on. Everything else on the entry is
 * carried through from the catalogue verbatim, including the bounds a number
 * input gets and the ceiling a text field gets.
 */
export interface TtsControlField {
  name: string
  label: string
  description: string
  kind: RenderableTtsControlType
  /** Published bounds. `null` means GenStudio published none — so none apply. */
  minimum: number | null
  maximum: number | null
  step: number | null
  maxLength: number | null
  value: TtsControlValue
}

/**
 * Turn the published list plus the chosen values into render descriptors.
 *
 * Controls whose type this build cannot render are skipped silently: the
 * customer sees the ones that work rather than an error, and a newer Story
 * Studio picks them up with no change on GenStudio's side.
 */
export function describeTtsControls(
  published: readonly GenStudioTtsControl[] | null | undefined,
  chosen?: Record<string, unknown> | null,
): TtsControlField[] {
  const values = resolveTtsControlValues(published, chosen)
  const fields: TtsControlField[] = []
  for (const control of published || []) {
    if (!isRenderableTtsControl(control)) continue
    if (!Object.prototype.hasOwnProperty.call(values, control.name)) continue
    fields.push({
      name: control.name,
      label: control.label,
      description: control.description,
      kind: control.type as RenderableTtsControlType,
      minimum: control.minimum,
      maximum: control.maximum,
      step: control.step,
      maxLength: control.max_length,
      value: values[control.name]!,
    })
  }
  return fields
}

/**
 * How many decimals a numeric field should display.
 *
 * Derived from the model's own published `step` — the catalogue decides the
 * granularity, so it decides the display too. No step published means no
 * assumption about precision, so the raw value is shown as-is.
 */
export function ttsControlDecimals(step: number | null): number {
  if (step === null || !Number.isFinite(step) || step <= 0) return 0
  const text = String(step)
  const dot = text.indexOf('.')
  if (dot < 0) return 0
  return Math.min(text.length - dot - 1, 6)
}

// ── Delivery / emotion (owner, 2026-10-29) ──────────────────────────────
//
// A model whose catalogue row publishes the `delivery_instruction` control
// takes a free-text direction for HOW the words are read. The Gateway publishes
// it only for models that take one, with the model's own guidance inside it;
// the backend normalises that guidance (lib/tts-controls.ts) and this page
// prints only what arrived. Nothing here supplies an example, a rule, an event
// syntax, a language, or a character limit of its own.

/** The Gateway's published name for the control, and for the request field it leaves as. */
export const DELIVERY_INSTRUCTION_CONTROL = 'delivery_instruction'

/** One inline vocal event the engine accepts: how it is written, and what it does. */
export interface DeliveryInstructionEvent {
  syntax: string
  /** What it does (`event` in the Hub's own shape). */
  meaning: string
  /** Where in the words it may be written, when the card states it. */
  where: string
}

/** The model's own guidance. Every member is empty when the Gateway published none. */
export interface DeliveryInstructionGuidance {
  /** What kind of input the model takes, in the card's own words (e.g. free text). */
  kind: string
  /** How the engine applies it (`instruct`, `text_prefix`), when the card says. */
  engineForm: string
  text: string
  examples: string[]
  languageRule: string
  inlineEvents: DeliveryInstructionEvent[]
  sourceUrl: string
  /** The card's own caveat, when it published one. */
  note: string
}

/** The published delivery/emotion control for the selected model, or absent. */
export interface GenStudioDeliveryInstructionControl {
  label: string
  /** Published `max_length`. `null` = none published, so none is shown or applied. */
  max_length: number | null
  /** The model's guidance. `null` = none published, so the box shows alone. */
  guidance: DeliveryInstructionGuidance | null
}

/** The published character limit, or `null` when the model published none. */
export function deliveryInstructionLimit(
  control: GenStudioDeliveryInstructionControl | null | undefined,
): number | null {
  return control?.max_length ?? null
}

/**
 * What the request carries: the text trimmed, cut to the model's own published
 * `max_length` (never a limit of ours), and empty when the model publishes no
 * control — in which case the setting is hidden and nothing is sent.
 *
 * Cut by code point, because the Gateway counts characters its own way and a
 * JS string index would split a surrogate pair.
 */
export function resolveDeliveryInstructionText(
  control: GenStudioDeliveryInstructionControl | null | undefined,
  value: unknown,
): string {
  if (!control || typeof value !== 'string') return ''
  const text = value.trim()
  if (!text) return ''
  const limit = deliveryInstructionLimit(control)
  if (limit === null) return text
  const points = Array.from(text)
  return points.length > limit ? points.slice(0, limit).join('').trimEnd() : text
}
