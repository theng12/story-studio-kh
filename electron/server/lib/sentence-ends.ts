/**
 * The one definition of where a sentence ends, for narration, TTS requests and
 * subtitle timing. Khmer (។ ៕) and CJK (。！？) write no space after a stop, so
 * their stops split a sentence with or without whitespace after them; the Latin
 * .!? only count before whitespace (so "3.5" stays whole).
 */

/** Latin plus Khmer (U+17D4 ។, U+17D5 ៕) and CJK full stops. */
export const SENTENCE_END_CHARS = '.!?。！？។៕'
export const SENTENCE_END = new RegExp(`[${SENTENCE_END_CHARS}]`)
/** The stops of scripts that put no space after them. */
export const UNSPACED_SENTENCE_END = /[。！？។៕]/
/** A word that ends a sentence (also counts an ellipsis and a closing quote or bracket). */
export const endsSentence = (word: string): boolean => /[.!?…。！？។៕]["')\]»”’」』）]*$/u.test(word)

const BOUNDARY = /((?<=[.!?])\s+|(?<=[。！？។៕])\s*)/

/** The stop to put at the end of `text` when a sentence is cut in two: ។ after Khmer, 。 after CJK, else '.'. */
export function terminatorFor(text: string): string {
  const last = text.trimEnd().at(-1) ?? ''
  return /[ក-៿]/.test(last) ? '។' : /[぀-ヿ㐀-鿿]/.test(last) ? '。' : '.'
}

/**
 * Split `text` into sentences. Each piece keeps ONE trailing space where the
 * text had whitespace after it, so concatenating the pieces rebuilds the text
 * (whitespace runs collapsed) and unspaced Khmer/CJK is not given spaces.
 */
export function splitSentences(text: string): string[] {
  const parts = text.split(BOUNDARY)
  const pieces: string[] = []
  for (let i = 0; i < parts.length; i += 2) {
    if (parts[i]) pieces.push(parts[i]! + (parts[i + 1] ? ' ' : ''))
  }
  return pieces
}

/** Cut index (1..max) for `text` that stays under `max`: last whitespace, else a point that is not inside a Khmer syllable. */
function cutPoint(text: string, max: number): number {
  const space = text.slice(0, max + 1).search(/\s\S*$/)
  if (space > 0) return space
  // A cut must not land before a combining mark / coeng (U+17B6–U+17D3, any \p{M}), after a coeng
  // (U+17D2, whose next consonant is the subscript), or between the halves of a surrogate pair.
  const unsafe = (i: number) => /\p{M}/u.test(text[i]!) || text.charCodeAt(i - 1) === 0x17D2 || /[\uDC00-\uDFFF]/.test(text[i]!)
  let cut = max
  while (cut > 1 && unsafe(cut)) cut -= 1
  if (cut > 1) return cut
  cut = max
  while (cut < text.length && unsafe(cut)) cut += 1
  return cut
}

/** Hard-split `text` into pieces of at most `max` characters at a space, else at a safe point. */
export function splitAtLimit(text: string, max: number): string[] {
  const pieces: string[] = []
  let rest = text
  while (rest.length > max) {
    const cut = cutPoint(rest, max)
    pieces.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  if (rest) pieces.push(rest)
  return pieces
}
