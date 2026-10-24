/**
 * Refuse narration in a language the chosen voice model cannot speak, before anything is sent.
 *
 * Owner, 2026-10-24: Khmer channels moved onto Breeze TTS (English and Chinese only) by a "use
 * Breeze everywhere" preset change; every job babbled and failed its quality check four times —
 * fleet time spent on audio that could never pass. The model's own published
 * `supported_languages` decides (AGENTS rule 1); an empty list is "unstated" and never refuses.
 * The Gateway refuses the same requests itself (`LANGUAGE_UNSUPPORTED`); this says so before the
 * first request, in the job's own words.
 *
 * Only writing systems that pin a language down are judged. Latin is shared by too many
 * languages, so Latin text is never refused on its script.
 */

const SCRIPTS: Array<{ name: string, ranges: Array<[number, number]>, codes: string[] }> = [
  { name: 'Khmer', ranges: [[0x1780, 0x17FF], [0x19E0, 0x19FF]], codes: ['km'] },
  { name: 'Thai', ranges: [[0x0E00, 0x0E7F]], codes: ['th'] },
  { name: 'Lao', ranges: [[0x0E80, 0x0EFF]], codes: ['lo'] },
  { name: 'Myanmar', ranges: [[0x1000, 0x109F]], codes: ['my'] },
  { name: 'Korean', ranges: [[0xAC00, 0xD7AF], [0x1100, 0x11FF], [0x3130, 0x318F]], codes: ['ko'] },
  { name: 'Japanese kana', ranges: [[0x3040, 0x30FF]], codes: ['ja'] },
  { name: 'Chinese characters', ranges: [[0x4E00, 0x9FFF], [0x3400, 0x4DBF]], codes: ['zh', 'ja', 'yue', 'cmn'] },
  { name: 'Arabic', ranges: [[0x0600, 0x06FF], [0x0750, 0x077F]], codes: ['ar', 'fa', 'ur', 'ps'] },
  { name: 'Hebrew', ranges: [[0x0590, 0x05FF]], codes: ['he', 'yi'] },
  { name: 'Greek', ranges: [[0x0370, 0x03FF]], codes: ['el'] },
  { name: 'Devanagari', ranges: [[0x0900, 0x097F]], codes: ['hi', 'mr', 'ne', 'sa'] },
  { name: 'Cyrillic', ranges: [[0x0400, 0x04FF]], codes: ['ru', 'uk', 'bg', 'sr', 'be', 'mk', 'kk', 'mn', 'ky', 'tg'] },
  { name: 'Georgian', ranges: [[0x10A0, 0x10FF]], codes: ['ka'] },
  { name: 'Armenian', ranges: [[0x0530, 0x058F]], codes: ['hy'] },
  { name: 'Tamil', ranges: [[0x0B80, 0x0BFF]], codes: ['ta'] },
  { name: 'Bengali', ranges: [[0x0980, 0x09FF]], codes: ['bn', 'as'] },
]

/** A script must be at least this share of the letters to speak for the text. */
const DOMINANT_SHARE = 0.3

export function baseLanguageCode(code: unknown): string {
  return String(code ?? '').trim().toLowerCase().replace(/_/g, '-').split('-')[0] ?? ''
}

/** The non-Latin writing system most of the text's letters use, or null. */
export function dominantScript(text: string): { name: string, codes: string[] } | null {
  const counts = new Map<number, number>()
  let letters = 0
  for (const char of text) {
    const point = char.codePointAt(0)!
    // Khmer vowel signs and subscripts are combining marks, not letters, but they are Khmer.
    if (!/\p{L}/u.test(char) && !(point >= 0x1780 && point <= 0x17FF)) continue
    letters += 1
    const index = SCRIPTS.findIndex(script => script.ranges.some(([low, high]) => point >= low && point <= high))
    if (index >= 0) counts.set(index, (counts.get(index) || 0) + 1)
  }
  if (!letters || !counts.size) return null
  const [index, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!
  return count / letters >= DOMINANT_SHARE ? SCRIPTS[index]! : null
}

/** Why `modelName` cannot narrate these texts, or null when it can (or it cannot be judged). */
export function narrationLanguageRefusal(texts: string[], supportedLanguages: unknown, modelName: string): string | null {
  const published = new Set((Array.isArray(supportedLanguages) ? supportedLanguages : []).map(baseLanguageCode).filter(Boolean))
  if (!published.size) return null
  const script = dominantScript(texts.join('\n'))
  if (!script || script.codes.some(code => published.has(code))) return null
  return `${modelName} cannot speak this narration: it is written in ${script.name} script, and the model `
    + `lists only ${[...published].sort().join(', ')}. Nothing was sent. Choose a voice model that lists `
    + `${script.codes[0]} in the Audio Generator (or in this channel's audio preset).`
}
