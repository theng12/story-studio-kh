/**
 * The Studio Hub (0.6.137+) checks every narration section it makes and makes a
 * bad one again — silent, humming instead of speech, or not saying its words.
 * It records that per request as `section_quality` (one row per attempt), and
 * the Gateway passes it through on the finished job when it can. This turns it
 * into what the Audio page shows per chapter. Anything malformed reads as
 * "nothing reported", never as an error.
 */

import type { ChapterSectionQuality } from '../contracts/section-quality.js'

export type { ChapterSectionQuality }

/** One request's `section_quality` → its counts, or null when nothing usable was reported. */
export function summarizeSectionQuality(raw: unknown): Pick<ChapterSectionQuality, 'sections' | 'remade'> | null {
  const rows = raw && typeof raw === 'object' ? (raw as { sections?: unknown }).sections : null
  if (!Array.isArray(rows)) return null
  const sections = new Set<number>()
  let remade = 0
  for (const row of rows as Array<Record<string, unknown> | null>) {
    if (!row || typeof row !== 'object') continue
    const section = Number(row.section)
    if (Number.isFinite(section)) sections.add(section)
    if (row.accepted === false) remade++
  }
  return sections.size ? { sections: sections.size, remade } : null
}

/** Add one request's counts to its chapter's running total (a chapter can be several requests). */
export function addSectionQuality(
  total: ChapterSectionQuality | undefined,
  part: Pick<ChapterSectionQuality, 'sections' | 'remade'>,
): ChapterSectionQuality {
  return { ...total, sections: (total?.sections || 0) + part.sections, remade: (total?.remade || 0) + part.remade }
}

const WHAT_WENT_WRONG: Array<[RegExp, string]> = [
  [/silent|DC drift/i, 'came out silent'],
  [/longer than its text|babble|humming/i, 'came out as humming or mumbling instead of speech'],
  [/does not say its text|other words/i, 'did not say its words'],
]

/**
 * The Hub's "Section 4 of 9 came out (nearly) silent or as a DC drift on all 4
 * attempts, so the audio was not delivered. …" in plain words, or null when the
 * text is not that failure.
 */
export function plainSectionFailure(text: string): string | null {
  const match = /Section (\d+)(?: of (\d+))? (.+?) on all (\d+) attempts/i.exec(text)
  if (!match) return null
  const what = WHAT_WENT_WRONG.find(([pattern]) => pattern.test(match[3]!))?.[1] || 'came out wrong'
  return `Section ${match[1]}${match[2] ? ` of ${match[2]}` : ''} ${what} on all ${match[4]} tries, so this part was not saved. `
    + 'Re-narrate to try again, or reword that part of the script.'
}
