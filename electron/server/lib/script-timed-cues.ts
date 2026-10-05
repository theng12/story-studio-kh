/**
 * Script-timed subtitles (owner decision 2026-10-05): we wrote every word the
 * narrator says, so captions need only the TIMING of known text, not speech
 * recognition (which cannot read Khmer at all: `_orchestra/audit-20261001/tts-khmer/GATE.md`).
 *
 * Input is a list of spans: stretches of audio known to hold exactly `text`
 * (one Studio Hub section, or a whole part/chapter when no section timeline was
 * delivered). Each span becomes cues per sentence (Khmer ។ ៕ and CJK stops via
 * `sentence-ends.ts`), a long sentence split at a clause, and the span's time is
 * shared by spoken length. A cue never leaves its span, so no cue crosses a join
 * pause and every span boundary is exact.
 *
 * ponytail: proportional inside a span; a forced aligner (Hub MMS /
 * qwen3_forced_aligner) can refine word times later by replacing `cuesForSpan`'s
 * share with measured times — the spans stay the same.
 */

import { splitAtLimit, splitSentences } from './sentence-ends.js'
import type { SrtCue } from './subtitle-builder.js'
import { formatSrtTime } from './subtitle-builder.js'

export interface TimedSpan {
  start_s: number
  end_s: number
  /** Exactly what is spoken between start_s and end_s. */
  text: string
}

/** Two lines of 42: the usual caption limit. */
export const MAX_CUE_CHARS = 84

const WIDE = /[ᄀ-ᇿ぀-ヿ㐀-鿿가-힯豈-﫿]/u
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/**
 * Spoken length, like the Hub's `_spoken_characters`: whitespace collapsed,
 * counted in grapheme clusters (a Khmer consonant with its vowel signs is one),
 * a CJK/kana/hangul character weighing three Latin ones.
 */
export function spokenWeight(text: string): number {
  let weight = 0
  for (const { segment } of graphemes.segment(text.replace(/\s+/g, ' ').trim())) weight += WIDE.test(segment) ? 3 : 1
  return weight
}

/** A sentence longer than `max` → pieces at the clause break nearest the middle, else at a safe point. */
export function splitLongCue(sentence: string, max = MAX_CUE_CHARS): string[] {
  if (sentence.length <= max) return [sentence]
  const middle = sentence.length / 2
  let best = -1
  for (const match of sentence.matchAll(/[,;:،、，；：]\s*|\s+[—–]\s+/gu)) {
    const cut = match.index! + match[0].length
    if (cut < 12 || sentence.length - cut < 12) continue
    if (best < 0 || Math.abs(cut - middle) < Math.abs(best - middle)) best = cut
  }
  if (best < 0) return splitAtLimit(sentence, max)
  return [...splitLongCue(sentence.slice(0, best).trim(), max), ...splitLongCue(sentence.slice(best).trim(), max)]
}

/** One span → its cues, time shared by spoken length, first start and last end exact. */
export function cuesForSpan(span: TimedSpan, max = MAX_CUE_CHARS): Array<Omit<SrtCue, 'index'>> {
  const pieces = splitSentences(span.text.replace(/\s+/g, ' ').trim())
    .flatMap(sentence => splitLongCue(sentence.trim(), max))
    .filter(piece => piece.trim())
  const total = pieces.reduce((sum, piece) => sum + spokenWeight(piece), 0)
  const duration = Math.max(0, span.end_s - span.start_s)
  if (!pieces.length || !total || !duration) return []
  const cues: Array<Omit<SrtCue, 'index'>> = []
  let spoken = 0
  for (const [i, piece] of pieces.entries()) {
    const start = span.start_s + duration * (spoken / total)
    spoken += spokenWeight(piece)
    const end = i === pieces.length - 1 ? span.end_s : span.start_s + duration * (spoken / total)
    cues.push({ start_sec: start, end_sec: end, text: piece })
  }
  return cues
}

/** Spans (in time order) → numbered cues. */
export function cuesForSpans(spans: TimedSpan[], max = MAX_CUE_CHARS): SrtCue[] {
  return spans.flatMap(span => cuesForSpan(span, max)).map((cue, i) => ({ index: i + 1, ...cue }))
}

/** The same SRT shape every other Story writer produces. */
export function cuesToSrt(cues: SrtCue[]): string {
  return cues.map((c, i) => `${i + 1}\n${formatSrtTime(c.start_sec)} --> ${formatSrtTime(c.end_sec)}\n${c.text}`).join('\n\n') + '\n'
}

/**
 * Show the script's own words where the spoken text differs only by TTS
 * normalisation (numbers spelled out, dashes made commas): when both split into
 * the same number of sentences, each cue's sentence is swapped for the script's
 * when it is one cue; a sentence split over several cues keeps the spoken words.
 */
export function scriptWordsFor(cues: SrtCue[], scriptText: string): SrtCue[] {
  const script = splitSentences(scriptText.replace(/\s+/g, ' ').trim()).map(s => s.trim()).filter(Boolean)
  const key = (s: string) => s.replace(/\s+/g, ' ').trim()
  const spoken = cues.map(cue => key(cue.text))
  const joined = splitSentences(spoken.join(' ')).map(s => s.trim()).filter(Boolean)
  if (joined.length !== script.length) return cues
  const out = cues.map(cue => ({ ...cue }))
  let cueIndex = 0
  for (const [i, sentence] of joined.entries()) {
    if (cueIndex < out.length && spoken[cueIndex] === sentence) out[cueIndex]!.text = script[i]!
    // advance past every cue that belongs to this sentence
    let rest = sentence
    while (cueIndex < out.length && rest.startsWith(spoken[cueIndex]!)) {
      rest = rest.slice(spoken[cueIndex]!.length).trim()
      cueIndex++
      if (!rest) break
    }
  }
  return out
}
