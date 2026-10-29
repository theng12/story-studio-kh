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
 * THE ONE NAMED CONTROL (owner, 2026-10-29): `delivery_instruction`. It is
 * named because the Gateway's TTS request body has a field with that name —
 * it is a published contract field, not an opinion about the catalogue — and
 * because it is the one control that leaves as a top-level request parameter
 * with the model's own guidance beside it, rather than as a member of the
 * generic `controls` map. Everything else in the module still names nothing.
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
    // The delivery/emotion control has its own reader below and leaves as a
    // top-level request field, so it never enters the generic map. One owner,
    // or a model publishing both would send the same text twice.
    if (name === DELIVERY_INSTRUCTION_CONTROL) continue
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

// ── Delivery / emotion (owner, 2026-10-29) ──────────────────────────────
//
// A model whose own record publishes the `delivery_instruction` control takes
// a free-text direction for HOW the words are read ("warm, unhurried, a little
// amused"). The Gateway publishes that control ONLY for models whose Studio Hub
// publishes the capability, with the model's own guidance inside it (free text,
// example instructions, a language rule, the inline vocal events the engine
// accepts, and the source link). A model that publishes nothing gets no box.
//
// Nothing here invents guidance. A key the Gateway did not send produces
// nothing, and the page prints only what arrived — which is why the reader
// below accepts a plain string, an object, or the several key spellings a
// model card may use, and never a phrase of its own.

/** The Gateway's published name for this control, and for the request field it leaves as. */
export const DELIVERY_INSTRUCTION_CONTROL = 'delivery_instruction'

/** One inline vocal event the engine accepts: how it is written, what it does, and where. */
export interface DeliveryInstructionEvent {
  /** The published syntax, exactly as the model card writes it. Empty when unpublished. */
  syntax: string
  /** What it does, in the model card's own words (`event` in the Hub's own shape). */
  meaning: string
  /** Where in the words it may be written, when the card states it. */
  where: string
}

/**
 * The model's own guidance, normalised for display. Every member is empty/null
 * when the Gateway published nothing for it; none is ever filled in here.
 */
export interface DeliveryInstructionGuidance {
  /** What kind of input the model takes, in the card's own words (e.g. free text). */
  kind: string
  /** How the engine applies it (`instruct`, `text_prefix`), when the card says. */
  engineForm: string
  /** The model card's own words about the instruction. */
  text: string
  /** Example instructions, as the card shows them. */
  examples: string[]
  /** The card's language rule, joined into one line when it published several. */
  languageRule: string
  /** Inline vocal events the engine accepts, with their syntax. */
  inlineEvents: DeliveryInstructionEvent[]
  /** Where the guidance came from (the model card's URL), when published. */
  sourceUrl: string
  /** The card's own caveat, when it published one. */
  note: string
}

/** The published delivery/emotion control for one model, or absent. */
export interface GenStudioDeliveryInstructionControl {
  /** The Gateway's label; its own name for the control when it published none. */
  label: string
  /** Published `max_length`. `null` = none published, so none enforced here. */
  max_length: number | null
  /** The model's guidance, in the Gateway's own words. `null` = none published. */
  guidance: DeliveryInstructionGuidance | null
}

const GUIDANCE_KIND_KEYS = ['kind', 'kind_label', 'input_kind', 'instruction_kind']
const GUIDANCE_ENGINE_FORM_KEYS = ['engine_form', 'engineForm', 'form_of_input']
const GUIDANCE_TEXT_KEYS = ['text', 'guidance', 'instructions', 'instruction', 'summary', 'description']
const GUIDANCE_EXAMPLE_KEYS = ['examples', 'example', 'example_instructions', 'example_instruction', 'sample_instructions']
const GUIDANCE_LANGUAGE_KEYS = ['language_rule', 'language_rules', 'language_note', 'language', 'languages']
const GUIDANCE_EVENT_KEYS = ['inline_events', 'inline_vocal_events', 'vocal_events', 'events']
const GUIDANCE_SOURCE_KEYS = ['source', 'source_url', 'sourceUrl', 'url', 'docs', 'documentation_url', 'reference']
const EXAMPLE_TEXT_KEYS = ['text', 'example', 'instruction', 'instruction_text', 'value', 'line']
const GUIDANCE_NOTE_KEYS = ['note', 'caution', 'caveat']
const EVENT_SYNTAX_KEYS = ['syntax', 'tag', 'markup', 'token', 'written', 'form', 'label']
const EVENT_MEANING_KEYS = ['event', 'meaning', 'when', 'description', 'effect', 'what', 'does', 'note', 'purpose']
const EVENT_WHERE_KEYS = ['where', 'placement', 'position', 'scope']

function firstPublishedText(record: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = publishedText(record[key])
    if (value) return value
  }
  return ''
}

function publishedExample(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
  return firstPublishedText(value as Record<string, unknown>, EXAMPLE_TEXT_KEYS)
}

function firstPublishedList(record: Record<string, unknown>, keys: readonly string[]): string[] {
  for (const key of keys) {
    const raw = record[key]
    if (raw === undefined || raw === null) continue
    const rows = Array.isArray(raw) ? raw : [raw]
    const lines = rows.map(publishedExample).filter(Boolean)
    if (lines.length) return lines
  }
  return []
}

function firstPublishedLanguage(record: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const raw = record[key]
    if (typeof raw === 'string' && raw.trim()) return raw.trim()
    if (Array.isArray(raw)) {
      const parts = raw.filter((item): item is string => typeof item === 'string' && !!item.trim())
        .map(item => item.trim())
      if (parts.length) return parts.join(', ')
    }
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const nested = firstPublishedText(raw as Record<string, unknown>, GUIDANCE_TEXT_KEYS)
      if (nested) return nested
    }
  }
  return ''
}

function publishedEvent(value: unknown): DeliveryInstructionEvent | null {
  if (typeof value === 'string') return value.trim() ? { syntax: value.trim(), meaning: '', where: '' } : null
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const syntax = firstPublishedText(record, EVENT_SYNTAX_KEYS)
  const meaning = firstPublishedText(record, EVENT_MEANING_KEYS)
  const where = firstPublishedText(record, EVENT_WHERE_KEYS)
  return syntax || meaning || where ? { syntax, meaning, where } : null
}

function firstPublishedEvents(record: Record<string, unknown>, keys: readonly string[]): DeliveryInstructionEvent[] {
  for (const key of keys) {
    const raw = record[key]
    if (raw === undefined || raw === null) continue
    // A map of syntax → meaning (`{"[laugh]": "a light laugh"}`) is a shape a
    // model card can publish, and its key IS the syntax.
    if (!Array.isArray(raw) && typeof raw === 'object') {
      const events = Object.entries(raw as Record<string, unknown>)
        .map(([syntax, meaning]) => ({ syntax: syntax.trim(), meaning: publishedText(meaning), where: '' }))
        .filter(event => event.syntax)
      if (events.length) return events
      continue
    }
    const events = (Array.isArray(raw) ? raw : [raw])
      .map(publishedEvent)
      .filter((event): event is DeliveryInstructionEvent => event !== null)
    if (events.length) return events
  }
  return []
}

/** A published guidance object, normalised; `null` when it published nothing usable. */
export function parseDeliveryInstructionGuidance(raw: unknown): DeliveryInstructionGuidance | null {
  if (typeof raw === 'string') {
    const text = raw.trim()
    return text
      ? { kind: '', engineForm: '', text, examples: [], languageRule: '', inlineEvents: [], sourceUrl: '', note: '' }
      : null
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const guidance: DeliveryInstructionGuidance = {
    kind: firstPublishedText(record, GUIDANCE_KIND_KEYS),
    engineForm: firstPublishedText(record, GUIDANCE_ENGINE_FORM_KEYS),
    text: firstPublishedText(record, GUIDANCE_TEXT_KEYS),
    examples: firstPublishedList(record, GUIDANCE_EXAMPLE_KEYS),
    languageRule: firstPublishedLanguage(record, GUIDANCE_LANGUAGE_KEYS),
    inlineEvents: firstPublishedEvents(record, GUIDANCE_EVENT_KEYS),
    sourceUrl: firstPublishedText(record, GUIDANCE_SOURCE_KEYS),
    note: firstPublishedText(record, GUIDANCE_NOTE_KEYS),
  }
  const published = guidance.kind || guidance.engineForm || guidance.text || guidance.examples.length
    || guidance.languageRule || guidance.inlineEvents.length || guidance.sourceUrl || guidance.note
  return published ? guidance : null
}

/**
 * The delivery/emotion control this model publishes, read off its own
 * `controls[]`. `null` means the Gateway published none for this model: no
 * setting is shown and none is sent.
 */
export function parseDeliveryInstructionControl(value: unknown): GenStudioDeliveryInstructionControl | null {
  if (!Array.isArray(value)) return null
  for (const row of value) {
    if (!row || typeof row !== 'object') continue
    const record = row as Record<string, unknown>
    if (publishedText(record.name) !== DELIVERY_INSTRUCTION_CONTROL) continue
    const type = publishedText(record.type)
    // The published type is the dispatch, here as everywhere: a different type
    // under this name is not this field.
    if (type && type !== 'text') continue
    const maxLength = publishedNumber(record.max_length)
    return {
      // An unpublished label falls back to the control's own name — the
      // Gateway's word for it — never a phrase invented here.
      label: publishedText(record.label) || DELIVERY_INSTRUCTION_CONTROL,
      max_length: maxLength !== null && maxLength >= 0 ? Math.floor(maxLength) : null,
      guidance: parseDeliveryInstructionGuidance(record.guidance),
    }
  }
  return null
}

/**
 * THE one place that decides what instruction leaves Story Studio.
 *
 * Empty when the model publishes no control, so nothing is sent; empty when the
 * customer left the box empty; otherwise the text, trimmed and cut to the
 * model's own published `max_length` (never a limit of Story Studio's). Cuts by
 * code point, because the Gateway counts characters its own way.
 */
export function resolveDeliveryInstruction(
  control: GenStudioDeliveryInstructionControl | null | undefined,
  value: unknown,
): string {
  if (!control || typeof value !== 'string') return ''
  const text = value.trim()
  if (!text) return ''
  if (control.max_length === null) return text
  const points = Array.from(text)
  return points.length > control.max_length
    ? points.slice(0, control.max_length).join('').trimEnd()
    : text
}
