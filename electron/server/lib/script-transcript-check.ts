/**
 * Script-vs-transcript check: which script sentences the narration never said.
 *
 * Story's subtitle-gap gate only sees silences longer than 30 s, so a voice
 * that skipped one sentence (or babbled through it) inside a shorter pause
 * passed every check. Dreamlands E2E 2026-10-03: comparing each chapter's
 * script with its own transcript found 59 skipped sentences Story never
 * flagged. This is that comparison.
 *
 * A sentence counts as heard when at least 60 % of its words of 4+ letters
 * occur anywhere in the chapter's transcript. Deliberately lenient (word order,
 * punctuation and Whisper's spelling of names do not matter), so what it does
 * report is a sentence whose words are mostly absent from the audio.
 * ponytail: bag-of-words per chapter; a real alignment (word order / position)
 * would also catch a sentence whose words happen to recur elsewhere.
 */

import fs from 'fs/promises'
import path from 'path'

const MIN_WORDS = 4
const HEARD_SHARE = 0.6

const words = (text: string): string[] =>
  (text.toLowerCase().replace(/[’‘]/g, "'").match(/[a-z']+/g) || [])
    .map(word => word.replace(/^'+|'+$/g, ''))
    .filter(word => word.length >= 4)

/** Script markdown → narrated sentences (headings and markup dropped). */
export function scriptSentences(markdown: string): string[] {
  const body = markdown
    .split('\n')
    .filter(line => !/^\s*#/.test(line))
    .join('\n')
    .replace(/[*_`>]/g, ' ')
  return body
    .split(/(?<=[.!?…]["”’)]?)\s+/)
    .map(sentence => sentence.replace(/\s+/g, ' ').trim())
    .filter(sentence => words(sentence).length >= MIN_WORDS)
}

/** SRT → the spoken text only (no indices, no timestamps). */
export function transcriptText(srt: string): string {
  return srt
    .split('\n')
    .filter(line => line.trim() && !/^\d+\s*$/.test(line.trim()) && !/-->/.test(line))
    .join(' ')
}

/** Index of the text that holds most of `sentence`'s words (first on a tie): which narration part said it. */
export function partHoldingSentence(sentence: string, partTexts: string[]): number {
  const own = words(sentence)
  let best = 0
  let bestShare = -1
  partTexts.forEach((text, index) => {
    const there = new Set(words(text))
    const share = own.filter(word => there.has(word)).length / Math.max(1, own.length)
    if (share > bestShare) { best = index; bestShare = share }
  })
  return best
}

export function findMissingSentences(scriptMarkdown: string, srt: string): string[] {
  const heard = new Set(words(transcriptText(srt)))
  return scriptSentences(scriptMarkdown).filter(sentence => {
    const own = words(sentence)
    return own.filter(word => heard.has(word)).length / own.length < HEARD_SHARE
  })
}

export interface ChapterMissingSentences {
  slug: string
  sentences: string[]
}

/**
 * Every chapter with both a script (`<CODE>_<slug>.md` in the script folder)
 * and its own transcript (`<CODE>_<slug>.srt`), minus `skip` (stale transcripts
 * describe old audio). Chapters with nothing missing are left out.
 */
export async function inspectMissingSentences(
  scriptDir: string,
  subtitlesDir: string,
  episodeId: string,
  skip: Iterable<string> = [],
): Promise<ChapterMissingSentences[]> {
  const code = episodeId.toUpperCase()
  const skipped = new Set(Array.from(skip, slug => slug.toLowerCase()))
  let scripts: string[]
  try {
    scripts = await fs.readdir(scriptDir)
  } catch {
    return []
  }
  const prefix = `${code}_`.toLowerCase()
  const found: ChapterMissingSentences[] = []
  for (const name of scripts.sort()) {
    const lower = name.toLowerCase()
    if (!lower.startsWith(prefix) || !lower.endsWith('.md')) continue
    const slug = name.slice(prefix.length, -'.md'.length)
    if (!/^chapter_\d+$/i.test(slug) || skipped.has(slug.toLowerCase())) continue
    const srt = await fs.readFile(path.join(subtitlesDir, `${code}_${slug}.srt`), 'utf-8').catch(() => null)
    if (srt === null) continue
    const markdown = await fs.readFile(path.join(scriptDir, name), 'utf-8').catch(() => '')
    const sentences = findMissingSentences(markdown, srt)
    if (sentences.length) found.push({ slug, sentences })
  }
  return found
}
