/**
 * What the words on a thumbnail should BE — chosen deliberately, not guessed.
 *
 * There used to be two modes, and the recipe picked between them: the full
 * episode title, or a "curiosity hook". The owner set a symbolic-split recipe
 * and an impasto style, and got the entire title — "The Psychology of the
 * Weight of Invisible Chains" — sprawled in gold serif across the frame:
 *
 *   "im using the thumbnail format and the impasto style but the text is not as
 *    the thumbnail. so this is where my frustation lies ... since i let LLM
 *    decide right here. there's no proper control."
 *
 * He is right. A full title is a search string; thumbnail text is a hook, and
 * the two are different jobs. He named three he wanted immediately — the title,
 * a curious idea, and "sometimes i want 2-3 words text in thumbnail" — and said
 * there would be more.
 *
 * EVERY MODE STATES AN EXACT WORD BUDGET. That is the control that was missing:
 * "curiosity hook" without a length is an invitation to write a sentence.
 */

export interface HeadlineMode {
  id: string
  /** Shown in the picker. Plain enough to choose without knowing the jargon. */
  label: string
  /** One line saying what you get, so the choice is legible before generating. */
  summary: string
  /** Injected into the prompt. Written as an order, with the budget in it. */
  instruction: string
  /** Whether the model invents the text (and returns it) or renders the title. */
  invents: boolean
}

const RENDER_RULE =
  'Render that exact text inside the image as large, bold, highly legible display type. ' +
  'Do not render placeholder text, gibberish, a watermark, a logo, or any other words.'

const INVENT_RULE =
  "Return the exact words you chose in that variation's \"title\" field so they can be reviewed, " +
  'and render those same words and nothing else. Do not render the full episode title instead — ' +
  'falling back to it is the exact failure this mode exists to prevent.'

export const HEADLINE_MODES: readonly HeadlineMode[] = [
  {
    id: 'episode-title',
    label: 'Full episode title',
    summary: 'The episode title exactly as written. Long titles will dominate the frame.',
    invents: false,
    instruction: `TITLE: render this exact episode title inside the image: "{{TITLE}}". Integrate it into the composition. ${RENDER_RULE}`,
  },
  {
    id: 'short-hook',
    label: 'Two or three words',
    summary: 'A blunt fragment. The largest, most readable option on a phone.',
    invents: true,
    instruction: `HEADLINE: choose a blunt two-or-three-word fragment that names the episode's real subject. Hard limit: 3 words. No punctuation, no sentence, no article at the start. ${INVENT_RULE} ${RENDER_RULE}`,
  },
  {
    id: 'curiosity-hook',
    label: 'A curious question',
    summary: 'A short question that sharpens the episode’s real question. Up to 5 words.',
    invents: true,
    instruction: `HEADLINE: invent one truthful, curiosity-driving question of at most 5 words, ending in a question mark. It must sharpen the episode's real question without overstating, hiding, or changing the facts. ${INVENT_RULE} ${RENDER_RULE}`,
  },
  {
    id: 'summary-line',
    label: 'One-line summary',
    summary: 'What the episode actually shows, in a single short line. Up to 7 words.',
    invents: true,
    instruction: `HEADLINE: write one plain statement of what the episode actually shows, at most 7 words. No question mark, no hype, no words the episode does not support. ${INVENT_RULE} ${RENDER_RULE}`,
  },
  {
    id: 'contrast',
    label: 'This versus that',
    summary: 'Two opposed ideas set against each other. Up to 5 words.',
    invents: true,
    instruction: `HEADLINE: set the episode's central tension as two opposed terms, at most 5 words total, in the shape "X vs Y" or "X, not Y". Both terms must be true to the episode. ${INVENT_RULE} ${RENDER_RULE}`,
  },
  {
    id: 'stakes',
    label: 'The cost or the warning',
    summary: 'What it costs, or what goes wrong. Up to 5 words, never invented danger.',
    invents: true,
    instruction: `HEADLINE: name the cost, the risk or the consequence the episode really documents, at most 5 words. Never invent a danger the episode does not establish. ${INVENT_RULE} ${RENDER_RULE}`,
  },
  {
    id: 'number',
    label: 'A number',
    summary: 'A count or figure the episode genuinely contains. Up to 4 words.',
    invents: true,
    instruction: `HEADLINE: lead with a number the episode genuinely contains — a count, a year, a measure — in at most 4 words. If the episode contains no such number, fall back to a blunt three-word fragment instead of inventing one. ${INVENT_RULE} ${RENDER_RULE}`,
  },
  {
    id: 'quote',
    label: 'A line from the episode',
    summary: 'A short phrase taken from the script itself. Up to 6 words.',
    invents: true,
    instruction: `HEADLINE: take a short phrase of at most 6 words from the episode's own narration, quoted accurately. Do not paraphrase it into something the script never says. ${INVENT_RULE} ${RENDER_RULE}`,
  },
  {
    id: 'none',
    label: 'No text at all',
    summary: 'A wordless image. For looks that carry themselves, or text added later.',
    invents: false,
    instruction: 'NO HEADLINE: render no words, letters, captions, watermarks or logos anywhere in the image. The composition must work with no text at all.',
  },
] as const

/**
 * The fallback when NOBODY has chosen — not the recipe, not the customer.
 *
 * Deliberately still the episode title. Changing it would silently rewrite what
 * every existing recipe produces, and a recipe that never asked for a hook has
 * not consented to one. The place the owner's preference belongs is the
 * PICKER's initial value, which starts on "two or three words" for new work;
 * this constant only catches callers that said nothing at all.
 */
export const DEFAULT_HEADLINE_MODE = 'episode-title'

/** What the Thumbnail Prompts page starts on, for work the owner is creating
 *  now. He asked for short text; a recipe or an explicit choice still wins. */
export const PREFERRED_NEW_HEADLINE_MODE = 'short-hook'

export function headlineMode(id: string | undefined): HeadlineMode {
  return HEADLINE_MODES.find(mode => mode.id === id)
    || HEADLINE_MODES.find(mode => mode.id === DEFAULT_HEADLINE_MODE)!
}

export function headlineInstruction(id: string | undefined, title: string): string {
  return headlineMode(id).instruction.replace('{{TITLE}}', title)
}

export const HEADLINE_MODE_IDS: readonly string[] = HEADLINE_MODES.map(mode => mode.id)
