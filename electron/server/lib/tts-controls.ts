/**
 * Published TTS controls — read from the catalogue, never known in advance.
 *
 * GenStudio's `TTSModelResponse.controls[]` declares, per model, every extra
 * knob that model takes: its `name`, human `label`, `type`, published bounds
 * (`minimum`/`maximum`/`step` for numbers, `max_length` for text), its
 * `default` and its `description`. Story Studio renders that list and sends
 * back exactly the names on it.
 *
 * NOTHING in this module — or anywhere else in Story Studio — may name a
 * control, assume its range, or infer one from a model or provider name. A
 * model that publishes a control nobody here has ever seen must work with no
 * code change; a model that publishes none must show none. That property is
 * the whole point, and `__tests__/tts-published-controls.test.ts` fabricates a
 * control to prove it.
 *
 * Forward compatibility: `type` is kept exactly as published, even when it is
 * not one Story Studio can render. GenStudio may add types later, so an
 * unrecognised one is SKIPPED — not rendered, not defaulted, not sent — rather
 * than crashing or being coerced into a shape it does not have.
 */

/** The control types Story Studio can render and submit today. */
export const RENDERABLE_TTS_CONTROL_TYPES = ['number', 'boolean', 'text'] as const
export type RenderableTtsControlType = typeof RENDERABLE_TTS_CONTROL_TYPES[number]

/** Every value shape a control may carry, exactly as the contract allows. */
export type TtsControlValue = number | boolean | string

/**
 * One row of `TTSModelResponse.controls[]`, kept as published.
 *
 * `type` is a plain string rather than a union so an unrecognised published
 * type survives parsing intact and is filtered at the point of use.
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

/** A value map as it travels on a quote or job request. */
export type TtsControlValues = Record<string, TtsControlValue>

function publishedNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function publishedText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** True for a type this build can render, bind and submit. */
export function isRenderableTtsControl(control: { type: string }): boolean {
  return (RENDERABLE_TTS_CONTROL_TYPES as readonly string[]).includes(control.type)
}

/**
 * Parse `TTSModelResponse.controls[]` off a live catalogue row.
 *
 * A row missing the fields that identify it (`name`, `type`) or missing its
 * published `default` is dropped rather than repaired: a control Story Studio
 * would have to invent a default for is a control it cannot honestly render.
 * Everything else is carried through verbatim, including a `type` this build
 * does not recognise.
 */
export function parseTtsControls(value: unknown): GenStudioTtsControl[] {
  if (!Array.isArray(value)) return []
  const parsed: GenStudioTtsControl[] = []
  const seen = new Set<string>()
  for (const row of value) {
    const name = publishedText((row as any)?.name)
    const type = publishedText((row as any)?.type)
    if (!name || !type || seen.has(name)) continue
    const published = (row as any)?.default
    const isValue = typeof published === 'number'
      ? Number.isFinite(published)
      : typeof published === 'boolean' || typeof published === 'string'
    if (!isValue) continue
    seen.add(name)
    parsed.push({
      name,
      // An unpublished label falls back to the control's own name, which is
      // GenStudio's word for it too — never a phrase invented here.
      label: publishedText((row as any)?.label) || name,
      type,
      minimum: publishedNumber((row as any)?.minimum),
      maximum: publishedNumber((row as any)?.maximum),
      default: published as TtsControlValue,
      step: publishedNumber((row as any)?.step),
      max_length: publishedNumber((row as any)?.max_length),
      description: publishedText((row as any)?.description),
    })
  }
  return parsed
}

/**
 * Bring one value inside what the control publishes, or reject it.
 *
 * Numbers are clamped to the published `minimum`/`maximum` — an unpublished
 * bound is no bound, never a bound of Story Studio's own. Text is cut to the
 * published `max_length`. A value of the wrong shape for the type is rejected
 * so the caller falls back to the published default.
 */
export function coerceTtsControlValue(
  control: GenStudioTtsControl,
  value: unknown,
): TtsControlValue | undefined {
  if (!isRenderableTtsControl(control)) return undefined
  if (control.type === 'number') {
    const numeric = typeof value === 'number' ? value : Number(value)
    if (typeof value === 'boolean' || value === null || value === undefined) return undefined
    if (!Number.isFinite(numeric)) return undefined
    let bounded = numeric
    if (control.minimum !== null) bounded = Math.max(control.minimum, bounded)
    if (control.maximum !== null) bounded = Math.min(control.maximum, bounded)
    return bounded
  }
  if (control.type === 'boolean') {
    return typeof value === 'boolean' ? value : undefined
  }
  // text
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
 * THE one place that decides which control values leave Story Studio.
 *
 * Every request — quote and job alike — sends the result of this, never a raw
 * form or a remembered map. It is built from the SELECTED model's published
 * list, so:
 *
 *  - a name the model does not publish cannot ride along, whatever a preset,
 *    a saved project or another model left behind;
 *  - a value outside the published range is clamped before it is sent;
 *  - a value of the wrong shape, or none at all, falls back to the published
 *    default;
 *  - a control whose `type` this build cannot render is omitted entirely.
 *
 * A model publishing no controls yields `{}`, which callers omit from the
 * request and from the idempotency digest.
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

/**
 * Serialize a resolved map with its keys in a stable order.
 *
 * GenStudio hashes `controls` into its own idempotency identity, so Story
 * Studio's key has to move when a control value moves — otherwise two runs at
 * different settings collide on OUR key and the first result replays for the
 * second. Sorting by name keeps the digest independent of the order the
 * catalogue happened to list the controls in.
 */
export function orderedTtsControlValues(values: TtsControlValues): TtsControlValues {
  const ordered: TtsControlValues = {}
  for (const name of Object.keys(values).sort()) ordered[name] = values[name]!
  return ordered
}

/**
 * Read a `controls` map back off a GenStudio response.
 *
 * Purely structural: whatever names GenStudio echoes are kept, because the
 * names belong to the catalogue. Only values outside the contract's
 * `float | bool | str` union are dropped.
 */
export function parseTtsControlValues(value: unknown): TtsControlValues {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const parsed: TtsControlValues = {}
  for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'boolean' || typeof entry === 'string') parsed[name] = entry
    else if (typeof entry === 'number' && Number.isFinite(entry)) parsed[name] = entry
  }
  return parsed
}

/** True when there is nothing to send — the published list was empty. */
export function hasTtsControlValues(values: TtsControlValues | null | undefined): boolean {
  return !!values && Object.keys(values).length > 0
}
