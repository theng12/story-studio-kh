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
 * module is deliberately ignorant of the catalogue: the surface that knows
 * WHICH image model is selected (the workspace) resolves the published figure
 * and sends the resulting number. No published cap means no number is sent,
 * and every function below degrades to "no cap": no instruction, no warning.
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
 */
export function buildPromptCharCapInstruction(cap: number | undefined): string {
  if (!cap) return ''
  const limit = cap.toLocaleString()
  return `PROMPT LENGTH LIMIT: the image model that will render these prompts refuses any prompt longer than ${limit} characters. `
    + 'Write each prompt at whatever length the scene genuinely needs, following the length and detail guidance above; a prompt that is naturally short must stay short. '
    + `${limit} is a hard ceiling the prompt must not exceed — never pad, restate, or add detail in order to approach it. `
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
