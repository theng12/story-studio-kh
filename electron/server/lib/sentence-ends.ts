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
 * Abbreviations whose trailing period is NOT a sentence end.
 *
 * A short, closed list of the ones a narrator actually says: titles, ranks
 * and the common short forms. It is a list of words, not of languages or
 * scripts — nothing here decides whether a LANGUAGE is punctuated this way,
 * only whether this particular word is an abbreviation.
 */
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'rev', 'hon', 'st', 'mt', 'fr', 'sr', 'jr',
  'vs', 'etc', 'al', 'inc', 'ltd', 'co', 'corp', 'dept', 'est', 'fig',
  'vol', 'pp', 'approx',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
])

/**
 * Does this word end with a period that is NOT a sentence end?
 *
 * Two cases, and both are real sentences that were being cut in half:
 *
 *  - an INITIAL: a single capital letter, optionally with more single
 *    capitals after the dots ("K. Theron", "J. R. R. Tolkien");
 *  - an ABBREVIATION: "Dr.", "Prof.", "U.S.", "etc.".
 *
 * A word that merely ENDS in a capital letter ("... the Senate.") is not one
 * of these: the rule is about the word BEFORE the period, not the one after
 * it, so a real sentence that ends in a capital-letter word still splits.
 */
function isAbbreviationEnd(word: string): boolean {
  // The word before the period, without any trailing dot.
  const bare = word.replace(/\.+$/, '')
  if (!bare) return false
  // An initial: one capital letter, or a run of single capital letters
  // separated by dots (J. R. R.).
  if (/^(?:[A-Z]\.)*[A-Z]$/.test(bare)) return true
  // A dotted abbreviation: U.S., U.S.A., e.g.
  if (/^(?:[A-Za-z]\.){2,}[A-Za-z]?$/.test(bare)) return true
  // A plain abbreviation from the list.
  if (ABBREVIATIONS.has(bare.toLowerCase())) return true
  return false
}

/**
 * Split `text` into sentences. Each piece keeps ONE trailing space where the
 * text had whitespace after it, so concatenating the pieces rebuilds the text
 * (whitespace runs collapsed) and unspaced Khmer/CJK is not given spaces.
 *
 * v1.4.374 — a period that ends an INITIAL or an ABBREVIATION no longer ends
 * a sentence (owner, 2026-11-01). "K. Theron published what is widely cited."
 * was cut into "K." and "Theron published what is widely cited.", and the
 * one-scene-per-sentence planner then made a 0.125-second SCENE out of "K."
 * — a real scene for a name's initial.
 *
 * The rule is about the word BEFORE the period, so a sentence that really
 * ends in a capital-letter word ("... the Senate.") still splits, and a Khmer
 * ។ or a CJK stop is untouched: those scripts write no space after their
 * stop, so there is no word before the period to be an abbreviation.
 */
export function splitSentences(text: string): string[] {
  const parts = text.split(BOUNDARY)
  const pieces: string[] = []
  for (let i = 0; i < parts.length; i += 2) {
    const body = parts[i]
    if (!body) continue
    // A Latin stop that closes an abbreviation or an initial does not end the
    // sentence: the piece continues into the next one. The word examined is
    // the LAST one before the period, so "A.B.C. Corp." is judged on "Corp".
    //
    // The check runs on the piece as it grows, so a run of abbreviations
    // ("A.B.C. Corp. Ltd.") is joined all the way to the sentence end. Each
    // absorbed part keeps its own trailing separator, so joining the pieces
    // rebuilds the text.
    let piece = body
    let index = i
    while (index + 2 < parts.length) {
      const match = /(\S*[A-Za-z])\.$/.exec(piece)
      if (!match || !isAbbreviationEnd(match[1]!)) break
      piece += (parts[index + 1] || '') + parts[index + 2]!
      index += 2
    }
    // The piece keeps ONE trailing space where the text had whitespace after
    // it, so joining the pieces rebuilds the text.
    pieces.push(piece + (parts[index + 1] ? ' ' : ''))
    i = index
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
