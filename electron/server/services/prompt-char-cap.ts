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
 * When the number handed over is the BODY budget — the effective ceiling minus
 * the characters the final assembly adds on top — the instruction says so, and
 * keeps the model's published ceiling separate from the writer's smaller body
 * allowance. Stating the body budget as if it were the model's limit would be a
 * small lie the writer cannot check; stating the published limit alone would
 * invite it to spend exactly the characters the assembly is going to need.
 *
 * AND NEVER CALL A CHOSEN LIMIT PUBLISHED
 * ---------------------------------------
 * The ceiling can come from three places, and the writer is told which:
 *   'model'  — the image model's own published figure (default; unchanged
 *              wording for every existing caller);
 *   'chosen' — a limit selected for this run, including a tighter one than the
 *              model publishes;
 *   'saved'  — a numeric allowance carried by a job accepted by an older
 *              version. Nothing may present that number as the model's.
 */

/** Where the enforced ceiling came from. */
export type PromptCharCapSource = 'model' | 'chosen' | 'saved'

export interface PromptCharCapInstructionOptions {
  /** The model's published ceiling, when one was actually read. */
  publishedCap?: number
  /** Characters the final assembly adds on top of the prompt body. */
  reservedCharacters?: number
  /** Exactly what those reserved characters are. Defaults to the Thumbnail
   *  Prompts wording (save-step clauses plus render extras). */
  reservedDescription?: string
  /** 'model' (default) keeps the historical wording. */
  capSource?: PromptCharCapSource
  /**
   * SCENE prompts only: the image model is handed this text ALONE, so whatever
   * names the subject has to survive any shortening. Adds one sentence saying
   * so. Thumbnail callers leave this unset — their subject is the episode
   * itself, not the writer's to choose — so their instruction stays
   * byte-for-byte what it was before this existed.
   */
  keepNamedSubject?: boolean
}

/**
 * Build the writer instruction for a ceiling.
 *
 * `cap` is the ceiling for the TEXT the writer produces. When
 * `reservedCharacters` is given, the caller has already subtracted it — `cap`
 * is the body budget and the assembled ceiling is `cap + reservedCharacters`.
 * The instruction names both, and names the source so a chosen or saved number
 * is never presented as the model's published limit.
 */
export function buildPromptCharCapInstruction(
  cap: number | undefined,
  options: PromptCharCapInstructionOptions = {},
): string {
  const limit = parsePromptCharCap(cap)
  if (!limit) return ''
  const published = parsePromptCharCap(options.publishedCap)
  const reserved = Math.max(0, Math.floor(Number(options.reservedCharacters) || 0))
  const source: PromptCharCapSource = options.capSource === 'chosen' || options.capSource === 'saved'
    ? options.capSource
    : 'model'
  const reservedDescription = (options.reservedDescription
    || 'the aspect-ratio and title clauses the save step appends, and the extras the render adds').trim()
  // `cap` is the ceiling for the writer's TEXT. When a reserve is given, the
  // caller has already subtracted it, so the number here is the body budget and
  // the assembled ceiling is that plus the reserve.
  const bodyText = limit.toLocaleString()
  const assembled = reserved > 0 ? limit + reserved : limit
  const assembledText = assembled.toLocaleString()
  // A published figure above the assembled ceiling means the customer chose a
  // tighter ceiling. Saying the model publishes the smaller number would be a
  // lie the writer cannot check.
  const tighterThanPublished = published !== undefined && published > assembled
  const modelFigureInForce = source === 'model' && (published === undefined || published === assembled)

  let head: string
  if (tighterThanPublished) {
    head = `PROMPT LENGTH LIMIT: the image model that will render these prompts accepts prompts up to ${published!.toLocaleString()} characters. `
      + `The limit chosen for these prompts is tighter: ${assembledText} characters in total for the assembled prompt.`
  } else if (modelFigureInForce) {
    head = `PROMPT LENGTH LIMIT: the image model that will render these prompts refuses any prompt longer than ${assembledText} characters.`
  } else if (source === 'saved') {
    head = `PROMPT LENGTH LIMIT: this run carries a limit of ${assembledText} characters for the assembled prompt — `
      + 'a limit saved with the run, not a figure read live from the image model.'
  } else {
    head = `PROMPT LENGTH LIMIT: the assembled prompt for these scenes is limited to ${assembledText} characters. `
      + 'That limit was chosen for this run, not read as a published model figure.'
  }
  const reservedSentence = reserved > 0
    ? ` ${reserved.toLocaleString()} of those characters are added on top of your prompt — ${reservedDescription} — `
      + `so your prompt text must be at most ${bodyText} characters.`
    : ''
  // A ceiling tells the writer what to CUT. Without this sentence the obvious
  // thing to cut is the longest phrase — and on a scene prompt that phrase is
  // often the only place the subject is named, which is how a zipper's teeth
  // became human teeth (WI0004, 2026-10-25). See SCENE_SUBJECT_GUIDANCE.
  const subjectSentence = options.keepNamedSubject
    ? ' The SUBJECT is the last thing to go: if a prompt has to come in shorter, drop adjectives, atmosphere, and secondary detail first — never the noun that names what the image actually shows.'
    : ''
  return `${head}${reservedSentence} `
    + 'Write each prompt at whatever length the scene genuinely needs, following the length and detail guidance above; a prompt that is naturally short must stay short. '
    + `${bodyText} is a hard ceiling the prompt must not exceed — never pad, restate, or add detail in order to approach it. `
    + 'Count characters, not words. Do not cut a prompt off mid-sentence, and do not mention this limit in the prompt text.'
    + subjectSentence
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

/** One already-counted piece (e.g. a text a writer prepends itself), named for
 *  reporting. Nothing is estimated: the caller passes the exact count. */
export function assemblyOverheadOf(label: string, characters: number): AssemblyOverhead {
  const counted = Math.max(0, Math.floor(Number(characters) || 0))
  return counted ? { characters: counted, parts: [{ label, characters: counted }] } : { characters: 0, parts: [] }
}

/**
 * The ceiling the prompt BODY may occupy: the effective cap minus everything
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
export function promptBodyCeiling(
  cap: number | undefined,
  overhead: AssemblyOverhead,
  opts: { detail?: string } = {},
): number | undefined {
  const limit = parsePromptCharCap(cap)
  if (!limit) return undefined
  const reserved = Math.max(0, overhead?.characters || 0)
  const remaining = limit - reserved
  if (remaining < 1) {
    throw new PromptAssemblyTooLargeError({ cap: limit, overhead: reserved, detail: opts.detail })
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
