/**
 * The prompt-character cap an image prompt is WRITTEN AGAINST.
 *
 * WHY THIS EXISTS
 * ---------------
 * One LLM writes the image prompts; a separately chosen image model renders
 * them. Nothing used to connect the two, so the writer happily produced a
 * 6,000-character prompt for a model that publishes a 4,800-character ceiling
 * and the failure only surfaced later, at render time, in
 * `providers/image/genstudio.ts`.
 *
 * WHERE THE NUMBER COMES FROM
 * ---------------------------
 * From GenStudio's published `max_prompt_characters` for the image model the
 * user intends to render with — never from a list of numbers kept here. This
 * module is deliberately ignorant of the catalogue: the SELECTION ('auto' /
 * 'none' / a whole number) and the image model it was chosen for travel with
 * the request, and the server resolves the published figure against the LIVE
 * catalogue when the work runs — see services/image-prompt-cap.ts. No published
 * cap means no number, and every function below degrades to "no cap": no
 * instruction, no warning.
 *
 * `prompt_token_allowance` is published separately and is measured in TOKENS.
 * It is never converted into characters — characters per token differ sharply
 * by script, and Khmer narration would be badly mis-capped by any such ratio.
 *
 * NOTHING HERE EVER SHORTENS A PROMPT
 * -----------------------------------
 * The cap is a ceiling handed to the LLM, plus a reading taken on the
 * result. A prompt that comes back over the cap is reported, never truncated:
 * silently cutting one would damage text the user may have iterated on, and it
 * is their call whether to trim it, raise the cap, or render anyway.
 */

/** Character counting matches the submit-time guard in the GenStudio image
 *  provider EXACTLY (`request.prompt.trim().length`), so a prompt this module
 *  reports as fitting is a prompt that boundary will accept. */
export function promptCharacterCount(text: unknown): number {
  return typeof text === 'string' ? text.trim().length : 0
}

/**
 * Shape-only parse of a request field. A positive whole number is a cap;
 * anything else — absent, empty, zero, negative, a word — means NO cap.
 *
 * There is deliberately no upper bound and no membership test against a fixed
 * ladder: what is legal belongs to the image model, which this module has not
 * been told about.
 */
export function parsePromptCharCap(value: unknown): number | undefined {
  if (value == null || value === '') return undefined
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined
}

/**
 * The CEILING handed to the prompt-writing LLM, or '' when there is no cap — in
 * which case callers append nothing and the model is left unconstrained rather
 * than being handed an invented number.
 *
 * WHY THE WORDING MATTERS
 * ----------------------
 * A model told it has "8,000 characters available" will spend 8,000 characters.
 * That inflates the completion-token bill on every scene and produces padded,
 * weaker prompts. So the number is stated ONLY as a limit that must not be
 * breached — never as a budget, an allowance, or something to reach. A scene
 * that wants a vivid 500-character prompt keeps its 500 characters under an
 * 8,000 ceiling. The existing length/detail guidance still shapes the prompt;
 * this is one extra constraint layered on top of it, not a replacement.
 *
 * THE BODY-BUDGET FORM
 * -------------------
 * When the number handed over is the BODY budget — the published ceiling minus
 * the characters the final assembly adds on top — the instruction says so, and
 * names the published ceiling as the model's real limit. Stating the body
 * budget as if it were the model's limit would be a small lie the writer
 * cannot check; stating the published limit alone would invite it to spend
 * exactly the characters the assembly is going to need.
 */
export function buildPromptCharCapInstruction(
  cap: number | undefined,
  options: { publishedCap?: number; reservedCharacters?: number } = {},
): string {
  const limit = parsePromptCharCap(cap)
  if (!limit) return ''
  const published = parsePromptCharCap(options.publishedCap) ?? limit
  const reserved = Math.max(0, Math.floor(Number(options.reservedCharacters) || 0))
  if (!reserved || published <= limit) {
    const ceiling = limit.toLocaleString()
    return `PROMPT LENGTH LIMIT: the image model that will render these prompts refuses any prompt longer than ${ceiling} characters. `
      + 'Write each prompt at whatever length the scene genuinely needs, following the length and detail guidance above; a prompt that is naturally short must stay short. '
      + `${ceiling} is a hard ceiling the prompt must not exceed — never pad, restate, or add detail in order to approach it. `
      + 'Count characters, not words. Do not cut a prompt off mid-sentence, and do not mention this limit in the prompt text.'
  }
  const ceiling = published.toLocaleString()
  const reservedText = reserved.toLocaleString()
  const budget = limit.toLocaleString()
  return `PROMPT LENGTH LIMIT: the image model that will render these prompts refuses any prompt longer than ${ceiling} characters. `
    + `${reservedText} of those characters are added on top of your prompt — the aspect-ratio and title clauses the save step appends, and the extras the render adds — `
    + `so your prompt text must be at most ${budget} characters. `
    + 'Write each prompt at whatever length the scene genuinely needs, following the length and detail guidance above; a prompt that is naturally short must stay short. '
    + `${budget} is a hard ceiling the prompt must not exceed — never pad, restate, or add detail in order to approach it. `
    + 'Count characters, not words. Do not cut a prompt off mid-sentence, and do not mention this limit in the prompt text.'
}

/** One prompt measured against the cap. `over_cap` is false whenever no cap
 *  was given, so an unpublished ceiling produces no warning anywhere. */
export interface PromptLengthReading {
  characters: number
  cap?: number
  over_cap: boolean
  /** Characters past the cap, or 0 when inside it / uncapped. */
  overage: number
}

export function readPromptLength(text: unknown, cap?: number): PromptLengthReading {
  const characters = promptCharacterCount(text)
  const limit = parsePromptCharCap(cap)
  if (!limit) return { characters, over_cap: false, overage: 0 }
  const overage = Math.max(0, characters - limit)
  return { characters, cap: limit, over_cap: overage > 0, overage }
}

// ── The FINAL ASSEMBLY a prompt body is measured against ────────────────────
//
// A stored prompt is not the prompt the image model receives. The save step
// appends the aspect-ratio and title clauses; the render step appends the
// render guidance and the style keywords. Every one of those pieces lands
// ON TOP of the body, so the body must be written under the ceiling MINUS
// them — otherwise a perfectly compliant body still produces a prompt the
// published ceiling refuses.
//
// The pieces are measured, never estimated: each part below is the exact text
// that gets appended, counted with the same `trim().length` the submit guard
// uses. Nothing here invents a reserve number, and nothing here shortens a
// prompt.

/**
 * One piece of the final assembly, named so a report can say WHICH piece
 * pushed a prompt over the model's ceiling.
 */
export interface AssemblyPart {
  label: string
  text: string
}

export interface AssemblyOverhead {
  /** Characters the assembly adds on top of the prompt body. */
  characters: number
  /** Per-part counts, in the order the parts were given. */
  parts: { label: string; characters: number }[]
}

/**
 * Count the final-assembly pieces exactly. A part with no text adds nothing,
 * so an assembly that appends nothing measures zero.
 */
export function measureAssemblyOverhead(parts: readonly AssemblyPart[]): AssemblyOverhead {
  const counted = (Array.isArray(parts) ? parts : [])
    .filter(part => part && typeof part.text === 'string' && part.text.length > 0)
    .map(part => ({ label: String(part.label), characters: part.text.length }))
  return {
    characters: counted.reduce((sum, part) => sum + part.characters, 0),
    parts: counted,
  }
}

/** Add two overheads. Used where the save-side and render-side pieces are
 *  measured separately but spent against the same ceiling. */
export function addAssemblyOverhead(...overheads: AssemblyOverhead[]): AssemblyOverhead {
  const parts: AssemblyOverhead['parts'] = []
  for (const overhead of overheads) {
    for (const part of overhead?.parts || []) parts.push(part)
  }
  return { characters: parts.reduce((sum, part) => sum + part.characters, 0), parts }
}

/**
 * The ceiling the prompt BODY may occupy: the published cap minus everything
 * the final assembly adds on top of it.
 *
 * Undefined when no cap is published — an unknown limit is not a number, and
 * this module never manufactures one.
 *
 * When the assembly alone is longer than the published cap there is NO body
 * that fits. That is refused LOUDLY, with the published cap and the measured
 * overhead, rather than handed a one-character body: a body of one character
 * would be a guess at what still fits, and the model would refuse the result
 * anyway. The refusal is typed and deterministic — the same settings fail the
 * same way — so it is never retried in place.
 */
export function promptBodyCeiling(cap: number | undefined, overhead: AssemblyOverhead): number | undefined {
  const limit = parsePromptCharCap(cap)
  if (!limit) return undefined
  const reserved = Math.max(0, overhead?.characters || 0)
  const remaining = limit - reserved
  if (remaining < 1) {
    throw new PromptAssemblyTooLargeError({ cap: limit, overhead: reserved })
  }
  return remaining
}

// ── The deterministic refusal ───────────────────────────────────────────────

/**
 * The published ceiling is shorter than the clauses and extras the prompt
 * needs — so no prompt body fits at all.
 *
 * Typed and deterministic: the same title, lettering and render settings fail
 * the same way every time, so an automatic retry could only learn the same
 * answer again.
 */
export class PromptAssemblyTooLargeError extends Error {
  /** Deterministic: the same settings fail the same way. Never auto-retried. */
  readonly retryable = false
  readonly cap: number
  readonly overhead: number

  constructor(opts: { cap: number; overhead: number; detail?: string }) {
    super(opts.detail || (
      `The image model accepts up to ${opts.cap.toLocaleString()} prompt characters, `
      + `and the title, lettering and render extras this prompt needs already use `
      + `${opts.overhead.toLocaleString()} of them. There is no room for the prompt itself, `
      + `so no prompt was written and no request was made. `
      + `Shorten the title or the lettering, use a model that publishes a larger limit, or remove the extra render guidance.`
    ))
    this.name = 'PromptAssemblyTooLargeError'
    this.cap = opts.cap
    this.overhead = opts.overhead
  }
}

/**
 * The character ceiling could not be RESOLVED — a selected image model the
 * live catalogue no longer publishes, a malformed selection, a missing Gateway
 * key — so the request cannot be honoured.
 *
 * TYPED, and deterministic: the same selection and the same catalogue fail the
 * same way every time, so an automatic retry could only learn the same answer
 * again. The type is what survives the hop through an aggregate job error,
 * where the original wording is gone — `isNonRetryableError` recognises the
 * class rather than matching a string.
 *
 * It lives here, in a module with no imports of its own, because the retry
 * policy has to name it: reaching it through a module that pulls in the
 * Gateway client would close an import cycle.
 */
export class ImagePromptCapUnavailableError extends Error {
  /** Deterministic: nothing about a rerun can change it. Never auto-retried. */
  readonly retryable = false

  constructor(message: string) {
    super(message)
    this.name = 'ImagePromptCapUnavailableError'
  }
}

/**
 * A prompt the selected image model will REFUSE because it is longer than the
 * model's own published `max_prompt_characters`.
 *
 * TYPED rather than matched on its message. The same refusal reaches the queue
 * through an aggregate completion error ("0/3 required items verified"), and a
 * string match is the fragile way to say "running this again cannot change the
 * answer" — the identical bytes are refused identically every time, so an
 * automatic retry burns three attempts to learn nothing.
 */
export class PromptLengthExceededError extends Error {
  /** Deterministic: the same prompt fails the same way. Never auto-retried. */
  readonly retryable = false
  readonly modelLabel: string
  readonly cap: number
  readonly characters: number
  readonly overage: number

  constructor(opts: {
    modelLabel: string
    cap: number
    characters: number
    overage: number
    /** Replaces the default wording when a caller can say more. */
    detail?: string
  }) {
    super(opts.detail || (
      `${opts.modelLabel} accepts up to ${opts.cap.toLocaleString()} prompt characters; `
      + `this prompt is ${opts.characters.toLocaleString()}. `
      + `No request was made for this prompt, and no credits were charged for it.`
    ))
    this.name = 'PromptLengthExceededError'
    this.modelLabel = opts.modelLabel
    this.cap = opts.cap
    this.characters = opts.characters
    this.overage = opts.overage
  }
}

/**
 * Refuse a prompt the published ceiling will reject, BEFORE anything is
 * submitted or charged.
 *
 * No published cap means no local check at all — GenStudio decides, and this
 * module never invents a ceiling it was not told about. The thrown error is
 * typed, so the refusal survives the hop through an aggregate job error and
 * the queue can refuse to retry it.
 */
export function assertPromptWithinCap(
  prompt: unknown,
  cap: number | undefined,
  opts: { modelLabel: string; what: string; remedy?: string },
): void {
  const limit = parsePromptCharCap(cap)
  if (!limit) return
  const reading = readPromptLength(prompt, limit)
  if (!reading.over_cap) return
  const remedy = opts.remedy
    || ' Shorten the prompt, raise the character limit, or render with a model that publishes a larger one.'
  throw new PromptLengthExceededError({
    modelLabel: opts.modelLabel,
    cap: limit,
    characters: reading.characters,
    overage: reading.overage,
    detail: (
      `${opts.modelLabel} accepts up to ${limit.toLocaleString()} prompt characters; `
      + `${opts.what} is ${reading.characters.toLocaleString()}, `
      + `${reading.overage.toLocaleString()} over the limit.`
      + `${remedy} No request was made for this prompt, and no credits were charged for it.`
    ),
  })
}

/**
 * A single advisory job line naming the prompts that came back over the ceiling,
 * or '' when there is nothing to say. Advisory on purpose: the job still
 * SUCCEEDS, every prompt is saved in full, and the user decides what to do.
 */
export function describeOverCapPrompts(
  entries: ReadonlyArray<{ label: string; text: unknown }>,
  cap?: number,
  sampleSize = 5,
): string {
  const limit = parsePromptCharCap(cap)
  if (!limit) return ''
  const over = entries
    .map(entry => ({ label: entry.label, ...readPromptLength(entry.text, limit) }))
    .filter(reading => reading.over_cap)
  if (!over.length) return ''
  const shown = Math.min(over.length, Math.max(1, sampleSize))
  const sample = over
    .slice(0, shown)
    .map(reading => `${reading.label} (${reading.characters.toLocaleString()} chars)`)
    .join(', ')
  const rest = over.length > shown ? `, +${over.length - shown} more` : ''
  return `⚠ ${over.length} prompt(s) exceed the ${limit.toLocaleString()}-character limit: ${sample}${rest}. `
    + 'Nothing was shortened — shorten them yourself, raise the limit, or render as-is.'
}
