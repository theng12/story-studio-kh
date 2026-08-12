/**
 * normalizeForTts — rewrite narration into clean, spoken-friendly text before
 * it's sent to ANY TTS engine (v1.0.215+; spoken numbers v1.0.827+).
 *
 * LLM-written narration loves em dashes, smart quotes, ellipses, semicolons,
 * and the odd stray markdown mark. Robust cloud voices (ElevenLabs) mostly
 * cope, but local engines (Kokoro, Bark, …) read an em dash as a garbled
 * run-on ("eyes—a" → "eyesa") or an unnatural pause — which is what makes the
 * audio sound fake. This is the deterministic SAFEGUARD: it runs on every
 * section of every generation, so the audio reads naturally regardless of
 * what the script carried (and regardless of whether the LLM obeyed the
 * TTS-friendly writing instruction in the script prompt).
 *
 * Conservative by design — it rewrites ordinary prose numbers and notation
 * that reliably hurts spoken delivery, while exact technical literals remain
 * byte-identical. A normal ASCII hyphen ("well-being") is left intact.
 *
 * IMPORTANT: must be applied identically everywhere narration is chunked for
 * TTS — the audio generator AND the audio reconciler — or chunk boundaries
 * (and therefore the predicted chunk filenames) would diverge and a fully
 * generated section would look "missing".
 */

export interface TtsNormalizeResult {
  text: string
  /** Count of TTS-hostile marks rewritten (for an operator-facing log line). */
  changes: number
  /** Subset of `changes` caused by converting speakable numbers to words. */
  spoken_number_changes: number
  /** Subset of `changes` caused by punctuation / Markdown cleanup. */
  punctuation_changes: number
}

export interface SpokenNumberNormalizeResult {
  text: string
  changes: number
}

const SMALL_CARDINALS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen',
] as const

const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'] as const
const SMALL_ORDINALS = [
  'zeroth', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh',
  'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth', 'thirteenth', 'fourteenth',
  'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth',
] as const
const TENS_ORDINALS: Record<number, string> = {
  20: 'twentieth', 30: 'thirtieth', 40: 'fortieth', 50: 'fiftieth',
  60: 'sixtieth', 70: 'seventieth', 80: 'eightieth', 90: 'ninetieth',
}
const DECADES: Record<number, string> = {
  10: 'tens', 20: 'twenties', 30: 'thirties', 40: 'forties', 50: 'fifties',
  60: 'sixties', 70: 'seventies', 80: 'eighties', 90: 'nineties',
}
const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December'
const SCALES = [
  { value: 1_000_000_000_000, name: 'trillion' },
  { value: 1_000_000_000, name: 'billion' },
  { value: 1_000_000, name: 'million' },
  { value: 1_000, name: 'thousand' },
] as const

function underHundred(value: number): string {
  if (value < 20) return SMALL_CARDINALS[value]!
  const tens = Math.floor(value / 10)
  const ones = value % 10
  return ones ? `${TENS[tens]}-${SMALL_CARDINALS[ones]}` : TENS[tens]!
}

function cardinal(value: number): string | null {
  if (!Number.isSafeInteger(value) || value < 0 || value >= 1_000_000_000_000_000) return null
  if (value < 100) return underHundred(value)
  if (value < 1_000) {
    const hundreds = Math.floor(value / 100)
    const rest = value % 100
    return `${SMALL_CARDINALS[hundreds]} hundred${rest ? ` ${underHundred(rest)}` : ''}`
  }
  for (const scale of SCALES) {
    if (value < scale.value) continue
    const lead = cardinal(Math.floor(value / scale.value))
    const rest = value % scale.value
    const tail = rest ? cardinal(rest) : ''
    return lead ? `${lead} ${scale.name}${tail ? ` ${tail}` : ''}` : null
  }
  return null
}

function ordinal(value: number): string | null {
  if (!Number.isSafeInteger(value) || value < 0 || value >= 1_000_000_000_000_000) return null
  if (value < 20) return SMALL_ORDINALS[value]!
  if (value < 100) {
    if (TENS_ORDINALS[value]) return TENS_ORDINALS[value]!
    const tens = Math.floor(value / 10) * 10
    return `${TENS[tens / 10]}-${SMALL_ORDINALS[value % 10]}`
  }
  for (const scale of [{ value: 1_000_000_000_000, name: 'trillion' }, ...SCALES.slice(1), { value: 100, name: 'hundred' }] as const) {
    if (value < scale.value) continue
    const lead = cardinal(Math.floor(value / scale.value))
    const rest = value % scale.value
    if (!lead) return null
    if (!rest) return `${lead} ${scale.name}th`
    const tail = ordinal(rest)
    return tail ? `${lead} ${scale.name} ${tail}` : null
  }
  return null
}

function spokenYear(value: number): string | null {
  if (!Number.isInteger(value)) return null
  if (value === 1000) return 'one thousand'
  if (value >= 1001 && value <= 1009) return `one thousand ${SMALL_CARDINALS[value - 1000]}`
  if (value >= 1010 && value <= 1099) return `ten ${underHundred(value - 1000)}`
  if (value >= 1100 && value <= 1999) {
    const century = Math.floor(value / 100)
    const rest = value % 100
    const lead = underHundred(century)
    if (rest === 0) return `${lead} hundred`
    if (rest < 10) return `${lead} oh ${SMALL_CARDINALS[rest]}`
    return `${lead} ${underHundred(rest)}`
  }
  if (value === 2000) return 'two thousand'
  if (value >= 2001 && value <= 2009) return `two thousand ${SMALL_CARDINALS[value - 2000]}`
  if (value >= 2010 && value <= 2099) return `twenty ${underHundred(value - 2000)}`
  return null
}

function spokenDecade(value: number): string | null {
  if (!Number.isInteger(value) || value % 10 !== 0) return null
  if (value >= 1100 && value <= 1990) {
    const century = underHundred(Math.floor(value / 100))
    const rest = value % 100
    return rest === 0 ? `${century} hundreds` : `${century} ${DECADES[rest]}`
  }
  if (value === 2000) return 'two thousands'
  if (value >= 2010 && value <= 2090) return `twenty ${DECADES[value - 2000]}`
  return null
}

function validNumericToken(raw: string): { sign: string; integer: string; fraction: string } | null {
  const match = raw.match(/^([+-]?)(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d+))?$/)
  if (!match) return null
  const integer = match[2]!
  if (integer.includes(',') && !/^\d{1,3}(?:,\d{3})+$/.test(integer)) return null
  return { sign: match[1]!, integer: integer.replace(/,/g, ''), fraction: match[3] || '' }
}

function numberTokenToWords(raw: string, allowYear = true): string | null {
  const parsed = validNumericToken(raw)
  if (!parsed) return null
  const value = Number(parsed.integer)
  if (!Number.isSafeInteger(value)) return null
  const base = parsed.fraction
    ? `${cardinal(value)} point ${parsed.fraction.split('').map(digit => SMALL_CARDINALS[Number(digit)]).join(' ')}`
    : (allowYear && !raw.includes(',') ? spokenYear(value) : null) || cardinal(value)
  if (!base) return null
  if (parsed.sign === '-') return `minus ${base}`
  if (parsed.sign === '+') return `plus ${base}`
  return base
}

function placeholderName(index: number): string {
  let value = index
  let out = ''
  do {
    out = String.fromCharCode(65 + (value % 26)) + out
    value = Math.floor(value / 26) - 1
  } while (value >= 0)
  return `\uE000${out}\uE001`
}

function maskProtectedNumbers(input: string): { text: string; restore: (text: string) => string } {
  const saved: string[] = []
  const patterns = [
    /`[^`\n]*`/g,
    /https?:\/\/[^\s)\]}]+/gi,
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    /\b\d{1,4}[/-]\d{1,2}[/-]\d{1,4}\b/g,
    /(?:\/[A-Za-z0-9._-]+){2,}/g,
    /\[\d+(?:[-–,]\s*\d+)*\]/g,
    /\+?\d{1,3}\s*\(\d{2,4}\)\s*\d{3}[-\s]\d{4}\b/g,
    /\b\d{3}[-\s]\d{3}[-\s]\d{4}\b/g,
    /\([A-Z][^()\n,]{0,60},\s*\d{4}[a-z]?\)/g,
    /\b\d{1,3}(?:\.\d{1,3}){3}\b/g,
    /\b\d{1,2}:\d{1,2}(?::\d{1,2}(?:\.\d+)?)?\b/g,
    /\b\d+(?:\.\d+)?(?:\s*[+\-*/=]\s*\d+(?:\.\d+)?){2,}\b/g,
    /\b(?!(?:(?:1[1-9]\d0|20\d0)s|\d+(?:st|nd|rd|th))\b)(?=[A-Za-z0-9._-]*[A-Za-z])(?=[A-Za-z0-9._-]*\d)[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*\b/gi,
  ]
  let text = input
  for (const pattern of patterns) {
    text = text.replace(pattern, (match) => {
      const placeholder = placeholderName(saved.length)
      saved.push(match)
      return placeholder
    })
  }
  // Commas in ordinary prose numbers must be valid three-digit grouping.
  // Decimal-comma and malformed forms are ambiguous English speech, so retain
  // them exactly rather than converting separate fragments.
  text = text.replace(/\b\d+(?:,\d+)+\b/g, (match) => {
    if (validNumericToken(match)) return match
    const placeholder = placeholderName(saved.length)
    saved.push(match)
    return placeholder
  })
  return {
    text,
    restore: (value) => saved.reduce((out, original, index) => out.replaceAll(placeholderName(index), original), value),
  }
}

/**
 * Convert unambiguous numbers in English narration prose to the words a voice
 * should say. Technical literals are masked first and restored byte-for-byte.
 */
export function normalizeSpokenNumbers(input: string): SpokenNumberNormalizeResult {
  if (!input) return { text: input ?? '', changes: 0 }

  const masked = maskProtectedNumbers(input)
  let text = masked.text
  let changes = 0

  const replace = (pattern: RegExp, fn: (match: string, ...captures: string[]) => string | null) => {
    text = text.replace(pattern, (match: string, ...args: unknown[]) => {
      // String.replace appends offset + whole input after the capture groups.
      // These patterns use no named groups, so the final two arguments are
      // always metadata and must not be passed to the semantic replacer.
      const captures = args.slice(0, -2) as string[]
      const next = fn(match, ...captures)
      if (next === null || next === match) return match
      changes++
      return next
    })
  }

  replace(/\b(1[1-9]\d0|20\d0)s\b/g,
    (_match: string, raw: string) => spokenDecade(Number(raw)))

  // Currency is handled before generic numbers so the unit moves to the
  // natural spoken position: "$5 million" → "five million dollars".
  replace(/([$£€])\s*([+-]?\d[\d,]*(?:\.\d{1,2})?)(?:\s+(thousand|million|billion|trillion))?/gi,
    (match: string, symbol: string, raw: string, multiplier?: string) => {
      const units: Record<string, [string, string, string, string]> = {
        '$': ['dollar', 'dollars', 'cent', 'cents'],
        '£': ['pound', 'pounds', 'penny', 'pence'],
        '€': ['euro', 'euros', 'cent', 'cents'],
      }
      const unit = units[symbol]
      const parsed = validNumericToken(raw)
      if (!unit || !parsed) return null
      const whole = Number(parsed.integer)
      if (!Number.isSafeInteger(whole)) return null
      if (multiplier) {
        const amount = numberTokenToWords(raw, false)
        return amount ? `${amount} ${multiplier.toLowerCase()} ${unit[1]}` : null
      }
      const wholeWords = cardinal(whole)
      if (!wholeWords) return null
      const cents = parsed.fraction ? Number(parsed.fraction.padEnd(2, '0')) : 0
      const signedWhole = parsed.sign === '-' ? `minus ${wholeWords}` : wholeWords
      if (whole === 0 && cents > 0) {
        const centWords = cardinal(cents)
        return centWords ? `${centWords} ${cents === 1 ? unit[2] : unit[3]}` : null
      }
      const main = `${signedWhole} ${whole === 1 ? unit[0] : unit[1]}`
      if (!cents) return main
      const centWords = cardinal(cents)
      return centWords ? `${main} and ${centWords} ${cents === 1 ? unit[2] : unit[3]}` : null
    })

  replace(new RegExp(`\\b(${MONTHS})\\s+(\\d{1,2})(?=,|\\s|$)`, 'g'),
    (_match: string, month: string, dayRaw: string) => {
      const day = Number(dayRaw)
      const spoken = day >= 1 && day <= 31 ? ordinal(day) : null
      return spoken ? `${month} ${spoken}` : null
    })

  replace(new RegExp(`\\b(\\d{1,2})\\s+(${MONTHS})\\b`, 'g'),
    (_match: string, dayRaw: string, month: string) => {
      const day = Number(dayRaw)
      const spoken = day >= 1 && day <= 31 ? ordinal(day) : null
      return spoken ? `${spoken} ${month}` : null
    })

  replace(/\b(1[1-9]\d{2}|20\d{2})\s*(?:–|—|-|\bto\b)\s*(1[1-9]\d{2}|20\d{2})\b/g,
    (_match: string, first: string, second: string) => {
      const start = spokenYear(Number(first))
      const end = spokenYear(Number(second))
      return start && end ? `${start} to ${end}` : null
    })

  replace(/(?<![\w.])([+-]?\d+(?:\.\d+)?)\s*%/g,
    (_match: string, raw: string) => {
      const spoken = numberTokenToWords(raw, false)
      return spoken ? `${spoken} percent` : null
    })

  replace(/\b(\d+)(st|nd|rd|th)\b/gi,
    (_match: string, raw: string) => ordinal(Number(raw)))

  replace(/(?<![\w.])([+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)(?!\w)/g,
    (_match: string, raw: string) => numberTokenToWords(raw, true))

  return { text: masked.restore(text), changes }
}

function countMatches(text: string, re: RegExp): number {
  const m = text.match(re)
  return m ? m.length : 0
}

export function normalizeForTts(input: string): TtsNormalizeResult {
  if (!input) return {
    text: input ?? '', changes: 0, spoken_number_changes: 0, punctuation_changes: 0,
  }

  const spoken = normalizeSpokenNumbers(input)
  let t = spoken.text
  let punctuationChanges = 0

  // 1. em / en / horizontal-bar dashes + double-hyphen used as a clause break
  //    → comma (a natural spoken pause). A single ASCII '-' (e.g. "well-being")
  //    is deliberately NOT touched.
  const DASHES = /\s*(?:—|–|―|--)\s*/g
  punctuationChanges += countMatches(t, DASHES)
  t = t.replace(DASHES, ', ')

  // 2. smart/curly quotes → ASCII.
  const SMART_QUOTES = /[“”‘’]/g
  punctuationChanges += countMatches(t, SMART_QUOTES)
  t = t.replace(/[“”]/g, '"').replace(/[‘’]/g, "'")

  // 3. unicode ellipsis → ASCII "..." (engines handle the three-dot form).
  const ELLIPSIS = /…/g
  punctuationChanges += countMatches(t, ELLIPSIS)
  t = t.replace(ELLIPSIS, '...')

  // 4. semicolons read awkwardly aloud → comma.
  const SEMI = /\s*;\s*/g
  punctuationChanges += countMatches(t, SEMI)
  t = t.replace(SEMI, ', ')

  // 5. markdown leaking from LLM output. Strip ONLY leading headings + PAIRED
  //    emphasis markers, keeping the wrapped words. Lone marks are deliberately
  //    left intact so real prose survives — "5 * 3", "rated 4*", a stray
  //    backtick — and underscore emphasis is matched only at word boundaries,
  //    which a snake_case identifier never has (so "snake_case_term" is safe).
  let mdChanges = 0
  // leading ATX heading marker → drop it, keep the heading text.
  t = t.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, () => { mdChanges++; return '' })
  // **bold** / __bold__ → bold (requires a matched pair wrapping non-space).
  t = t.replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, (_m, _mk, inner) => { mdChanges++; return inner })
  // *italic* → italic (paired asterisks wrapping non-space; lone * untouched).
  t = t.replace(/\*(?=\S)([^*\n]+?)(?<=\S)\*/g, (_m, inner) => { mdChanges++; return inner })
  // _italic_ → italic, ONLY at word boundaries so snake_case is never touched.
  t = t.replace(/(^|[\s(])_(?=\S)([^_\n]+?)(?<=\S)_(?=[\s).,!?;:'"]|$)/g, (_m, pre, inner) => { mdChanges++; return pre + inner })
  // `code` → code (paired backticks; a lone backtick is left alone).
  t = t.replace(/`([^`\n]+)`/g, (_m, inner) => { mdChanges++; return inner })
  punctuationChanges += mdChanges

  // 6. cosmetic cleanup (not counted): collapse runs of spaces, pull
  //    punctuation back against its word, and drop comma pile-ups / orphan
  //    commas the substitutions above can create (e.g. "word—." → "word, ." →
  //    "word.").
  t = t
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([,.!?;:])/g, '$1')
    .replace(/,(?:\s*,)+/g, ',')
    .replace(/,\s*([.!?])/g, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .trim()

  return {
    text: t,
    changes: spoken.changes + punctuationChanges,
    spoken_number_changes: spoken.changes,
    punctuation_changes: punctuationChanges,
  }
}
