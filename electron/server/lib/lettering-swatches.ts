/**
 * Visual swatches for the thumbnail lettering catalogues.
 *
 * The owner, choosing a font: "i don't know all the english font names. there's
 * so many i don't know so there's nothing visual for me to see how the font
 * would have looked like. same or text styling. say neon or glow or shadow or
 * bold or whatever. all just words i don't know. i'm not a native speaker so i
 * prefer visual."
 *
 * He is right, and the words are worse than unhelpful — "blackletter gothic
 * calligraphy" and "retro 1970s chrome lettering" are phrases you can only
 * evaluate if you already know what they look like, which is the opposite of
 * what a picker is for.
 *
 * ONE VARIABLE PER SWATCH. A font swatch varies the LETTERFORM and holds the
 * treatment plain; a text swatch varies the TREATMENT and holds the letterform
 * plain. A swatch that changed both would show a combination and teach nothing
 * about either. The same word appears in every one, for the same reason.
 */
import { FONT_STYLES, TEXT_STYLES } from '../models/thumbnail-styles.js'

export type LetteringKind = 'font' | 'text'

/** Short, all-caps, and full of distinct letterforms: a round O, a diagonal
 *  Y, a stem T, an R with a leg. Longer words shrink the letters. */
export const SWATCH_WORD = 'STORY'

/** Held constant on whichever axis the swatch is not showing. */
const PLAIN_TREATMENT = 'clean solid white fill with a soft drop shadow'
const PLAIN_LETTERFORM = 'a heavy bold sans-serif'

/** The framing every swatch shares, so only the style differs between them. */
export const SWATCH_FRAMING =
  `The single word "${SWATCH_WORD}" rendered as very large display lettering filling most of the frame, ` +
  'horizontally centred on a plain mid-grey background. Nothing else in the frame at all: no scene, ' +
  'no objects, no people, no logos, no borders, no extra words, no decoration. Flat even lighting. ' +
  `The word must be spelled exactly ${SWATCH_WORD.split('').join('-')} and nothing else.`

export interface LetteringStyle {
  kind: LetteringKind
  id: string
  /** The exact phrase the prompt builder already injects for this style, so a
   *  swatch shows what the generator will actually ask for — not a paraphrase. */
  phrase: string
}

export function letteringStyles(kind: LetteringKind): LetteringStyle[] {
  const source = kind === 'font' ? FONT_STYLES : TEXT_STYLES
  return Object.entries(source).map(([id, phrase]) => ({ kind, id, phrase }))
}

export function allLetteringStyles(): LetteringStyle[] {
  return [...letteringStyles('font'), ...letteringStyles('text')]
}

export function findLetteringStyle(kind: LetteringKind, id: string): LetteringStyle | null {
  return letteringStyles(kind).find(style => style.id === id) || null
}

/**
 * The cache key half that describes the style. Kept separate from the framing
 * so a wording change to the framing invalidates every swatch at once, which
 * is correct: they would no longer be comparable with each other.
 */
export function swatchStyleTag(style: LetteringStyle): string {
  return style.kind === 'font'
    ? `Letterform: ${style.phrase}. Treatment: ${PLAIN_TREATMENT}`
    : `Letterform: ${PLAIN_LETTERFORM}. Treatment: ${style.phrase}`
}

export function swatchVariantId(kind: LetteringKind): string {
  return kind === 'font' ? 'font-swatch-v1' : 'text-swatch-v1'
}
