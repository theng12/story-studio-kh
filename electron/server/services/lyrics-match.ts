/**
 * Songs with lyrics: how much of the lyric sheet a transcript of the sung song contains (owner 2026-10-12).
 *
 * The share of lyric words that appear in the transcript **in order** (longest common subsequence of
 * words / lyric words): a singer who skips a verse loses that verse's words, one who mumbles loses the
 * mumbled ones, and repeated choruses are matched where they are sung. Section markers ([Verse]) are not
 * words. Case, accents and punctuation are ignored. Pure, for tests.
 * ponytail: O(lyric words × heard words) table; a 12-section song is ~400 × ~500 cells.
 */
import { parseSrt } from '../lib/subtitle-builder.js'

export function lyricWords(text: string): string[] {
  return text.split('\n').filter(line => !/^\s*\[[^\]\n]*\]\s*$/.test(line)).join(' ')
    .toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[’']/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ').filter(Boolean)
}

/** 0..1, or null when the lyrics have no words to match (nothing measurable). */
export function lyricsMatch(lyrics: string, heard: string): number | null {
  const a = lyricWords(lyrics)
  const b = lyricWords(heard)
  if (!a.length) return null
  let prev = new Array<number>(b.length + 1).fill(0)
  for (const word of a) {
    const row = new Array<number>(b.length + 1).fill(0)
    for (let j = 1; j <= b.length; j++) row[j] = word === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, row[j - 1]!)
    prev = row
  }
  return Math.round((prev[b.length]! / a.length) * 1000) / 1000
}

/** The words of an SRT transcript, in order. */
export function srtText(srt: string): string {
  return parseSrt(srt).map(cue => cue.text).join(' ')
}
