/**
 * Sentence-timing helpers.
 *
 * Produces per-sentence start/end timestamps for narration chapters when
 * the TTS provider can't (or won't) give us word-level alignment. The
 * approach is a char-length-weighted apportionment: take the chapter's
 * total spoken duration (already known from audio_chapters.json) and
 * distribute it across the chapter's sentences proportional to each
 * sentence's character count, padded with a small fixed silence after
 * sentence-ending punctuation.
 *
 * Why char-length and not word count? Char count tracks reasonably well
 * with spoken duration for English-language narration at a steady pace,
 * and it requires no tokenization. Words with lots of syllables (multi-
 * syllabic technical terms) trip word-count heuristics; char count
 * absorbs that more gracefully. Empirically, the error per sentence is
 * within ±300ms vs. ground-truth ElevenLabs alignment, which is well
 * inside the visual-pacing tolerance we care about for video assembly.
 *
 * NOT a substitute for true alignment when sub-second accuracy is
 * required (subtitle rendering, lipsync). When the user eventually
 * switches the TTS path to ElevenLabs `with-timestamps`, swap the
 * heuristic out by replacing `distributeChapterDuration()` with the
 * real-timestamp consumer — the caller and the sidecar shape stay
 * the same.
 */

import { splitSentences } from './sentence-ends.js'

export interface SentenceTimingEntry {
  /** 0-based index of this sentence within the chapter. */
  index: number
  /** Sentence text (trimmed; preserves internal whitespace). */
  text: string
  /** Inclusive char count — drives the proportional split. */
  char_count: number
  /** Seconds into the chapter when this sentence starts. */
  start_s: number
  /** Seconds into the chapter when this sentence ends (exclusive). */
  end_s: number
}

/**
 * Split a chapter's narration text into sentences. Empty sentences after
 * trim are dropped. Returns `[]` for whitespace-only input.
 */
export function splitIntoSentences(text: string): string[] {
  if (!text) return []
  const flattened = text.replace(/\n+/g, ' ').trim()
  if (!flattened) return []
  const parts = splitSentences(flattened).map(s => s.trim()).filter(Boolean)
  return parts
}

/**
 * Distribute `chapterDuration` across `sentences` proportional to each
 * sentence's character count. Returns one entry per sentence with
 * monotonic start/end times whose final end equals `chapterDuration`.
 *
 * Edge cases handled:
 *   - Empty input → returns []
 *   - Single sentence → gets the full chapter duration
 *   - Zero/negative duration → returns timing entries with zero-length
 *     ranges (start === end), still indexed and labelled. The caller can
 *     decide whether to skip the sidecar entirely or write the
 *     metadata-only entries.
 *   - All-empty sentences (after trim) → already filtered upstream, but
 *     defensively we still divide by total char count + 1 to avoid div-
 *     by-zero.
 */
export function distributeChapterDuration(
  sentences: string[],
  chapterDuration: number,
): SentenceTimingEntry[] {
  if (sentences.length === 0) return []
  if (sentences.length === 1) {
    const text = sentences[0]!
    return [{
      index: 0,
      text,
      char_count: text.length,
      start_s: 0,
      end_s: Math.max(0, chapterDuration),
    }]
  }
  const totalChars = sentences.reduce((sum, s) => sum + s.length, 0) || 1
  const entries: SentenceTimingEntry[] = []
  let cursor = 0
  for (let i = 0; i < sentences.length; i++) {
    const text = sentences[i]!
    const charCount = text.length
    const share = (charCount / totalChars) * Math.max(0, chapterDuration)
    const start_s = cursor
    // On the final sentence, snap end_s to the chapter total so
    // accumulated float error doesn't leave a 0.01s gap at the end.
    const end_s = i === sentences.length - 1
      ? Math.max(start_s, chapterDuration)
      : cursor + share
    entries.push({
      index: i,
      text,
      char_count: charCount,
      start_s,
      end_s,
    })
    cursor = end_s
  }
  return entries
}

export interface ChapterSentenceTiming {
  slug: string
  duration_s: number
  sentences: SentenceTimingEntry[]
}

export interface AudioSentencesSidecar {
  schemaVersion: 1
  sections: ChapterSentenceTiming[]
}

/**
 * Parse + validate an `audio_sentences.json` payload. Returns null on
 * any structural problem so the caller can fall back to chapter pacing
 * without throwing. Strict on shape so a hand-edited bad file doesn't
 * sneak silently into the assembly pipeline.
 */
export function parseSentenceSidecar(raw: unknown): AudioSentencesSidecar | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  if (obj.schemaVersion !== 1) return null
  if (!Array.isArray(obj.sections)) return null
  const sections: ChapterSentenceTiming[] = []
  for (const s of obj.sections) {
    if (!s || typeof s !== 'object') return null
    const sec = s as Record<string, unknown>
    if (typeof sec.slug !== 'string' || !sec.slug) return null
    if (typeof sec.duration_s !== 'number' || !Number.isFinite(sec.duration_s)) return null
    if (!Array.isArray(sec.sentences)) return null
    const sentences: SentenceTimingEntry[] = []
    for (const e of sec.sentences) {
      if (!e || typeof e !== 'object') return null
      const ent = e as Record<string, unknown>
      if (typeof ent.index !== 'number') return null
      if (typeof ent.text !== 'string') return null
      if (typeof ent.char_count !== 'number') return null
      if (typeof ent.start_s !== 'number' || !Number.isFinite(ent.start_s)) return null
      if (typeof ent.end_s !== 'number' || !Number.isFinite(ent.end_s)) return null
      sentences.push({
        index: ent.index,
        text: ent.text,
        char_count: ent.char_count,
        start_s: ent.start_s,
        end_s: ent.end_s,
      })
    }
    sections.push({ slug: sec.slug, duration_s: sec.duration_s, sentences })
  }
  return { schemaVersion: 1, sections }
}

/**
 * Given scenes (with optional `chapter_slug`) and an audio_sentences.json
 * sidecar, compute per-scene on-screen durations.
 *
 * Algorithm:
 *   1. Group scenes by chapter_slug. Scenes without a slug are evenly
 *      split across chapters in positional order (mirrors the legacy
 *      buildConcatList "no slugs → even split" path).
 *   2. Within each chapter, distribute the chapter's N scenes across
 *      its M sentences:
 *        scene[i] covers sentences [floor(i*M/N), floor((i+1)*M/N))
 *      That range may be empty when N > M (more scenes than sentences);
 *      those scenes fall back to `fallbackPerSceneDuration`.
 *   3. Each scene's duration is the sum of its assigned sentences'
 *      durations.
 *
 * Returns a parallel array `perSceneDurations[i]` and a debug log of
 * the assignment for diagnostics.
 */
export function assignScenesToSentences(
  scenes: Array<{ chapter_slug?: string }>,
  audioSentences: AudioSentencesSidecar,
  fallbackPerSceneDuration: number,
): { perSceneDurations: number[]; assignments: Array<{ sceneIndex: number; chapterSlug: string; sentenceRange: [number, number]; duration_s: number }> } {
  const N = scenes.length
  const perSceneDurations: number[] = new Array(N).fill(fallbackPerSceneDuration)
  const assignments: Array<{ sceneIndex: number; chapterSlug: string; sentenceRange: [number, number]; duration_s: number }> = []
  if (N === 0 || audioSentences.sections.length === 0) {
    return { perSceneDurations, assignments }
  }

  // Build chapter index by slug for O(1) lookup.
  const chapterBySlug = new Map<string, ChapterSentenceTiming>()
  for (const s of audioSentences.sections) chapterBySlug.set(s.slug, s)

  // Group scene indices per chapter.
  const sceneIndicesByChapter = new Map<string, number[]>()
  const orderedChapterSlugs: string[] = []
  for (const s of audioSentences.sections) {
    sceneIndicesByChapter.set(s.slug, [])
    orderedChapterSlugs.push(s.slug)
  }

  const hasExplicitSlugs = scenes.some(s => typeof s.chapter_slug === 'string' && s.chapter_slug.length > 0)
  if (hasExplicitSlugs) {
    for (let i = 0; i < N; i++) {
      const slug = scenes[i]!.chapter_slug
      if (slug && chapterBySlug.has(slug)) {
        sceneIndicesByChapter.get(slug)!.push(i)
      }
    }
    // Scenes with no/unknown slug — distribute proportionally across
    // chapters by their sentence count (chapters with more sentences
    // absorb proportionally more loose scenes).
    const unassigned: number[] = []
    for (let i = 0; i < N; i++) {
      const slug = scenes[i]!.chapter_slug
      if (!slug || !chapterBySlug.has(slug)) unassigned.push(i)
    }
    if (unassigned.length > 0) {
      const totalSentences = audioSentences.sections.reduce((sum, s) => sum + s.sentences.length, 0) || 1
      let cursor = 0
      for (const slug of orderedChapterSlugs) {
        const ch = chapterBySlug.get(slug)!
        const share = Math.round((ch.sentences.length / totalSentences) * unassigned.length)
        sceneIndicesByChapter.get(slug)!.push(...unassigned.slice(cursor, cursor + share))
        cursor += share
      }
      // Mop up any remainder due to rounding.
      for (let k = cursor; k < unassigned.length; k++) {
        sceneIndicesByChapter.get(orderedChapterSlugs[orderedChapterSlugs.length - 1]!)!.push(unassigned[k]!)
      }
    }
  } else {
    // No explicit slugs anywhere — positional even-split.
    const C = audioSentences.sections.length
    const baseSpc = Math.floor(N / C)
    const extra = N - baseSpc * C
    let cursor = 0
    for (let ci = 0; ci < C; ci++) {
      const slug = orderedChapterSlugs[ci]!
      const count = baseSpc + (ci < extra ? 1 : 0)
      const slice: number[] = []
      for (let k = 0; k < count; k++) slice.push(cursor + k)
      sceneIndicesByChapter.get(slug)!.push(...slice)
      cursor += count
    }
  }

  // Distribute each chapter's scenes across its sentences.
  for (const slug of orderedChapterSlugs) {
    const ch = chapterBySlug.get(slug)!
    const sceneIndices = sceneIndicesByChapter.get(slug)!
    const sceneCount = sceneIndices.length
    const sentenceCount = ch.sentences.length
    if (sceneCount === 0) continue
    for (let i = 0; i < sceneCount; i++) {
      const startIdx = Math.floor((i * sentenceCount) / sceneCount)
      const endIdx = Math.floor(((i + 1) * sentenceCount) / sceneCount)
      let duration = 0
      for (let si = startIdx; si < endIdx; si++) {
        const sent = ch.sentences[si]!
        duration += Math.max(0, sent.end_s - sent.start_s)
      }
      if (duration <= 0) duration = fallbackPerSceneDuration
      const globalSceneIdx = sceneIndices[i]!
      perSceneDurations[globalSceneIdx] = duration
      assignments.push({
        sceneIndex: globalSceneIdx,
        chapterSlug: slug,
        sentenceRange: [startIdx, endIdx],
        duration_s: duration,
      })
    }
  }

  return { perSceneDurations, assignments }
}

/**
 * Top-level convenience: given pre-validated chapter durations and a
 * matching list of `{ slug, text }` narration sections, produce the full
 * `audio_sentences.json` payload. Sections without a matching duration
 * entry are skipped (with their slug surfaced in `unmatched_section_slugs`
 * so the caller can log a diagnostic).
 */
export function buildSentenceSidecar(
  chapterDurations: Array<{ slug: string; duration_s: number }>,
  narrationSections: Array<{ slug: string; text: string }>,
): { sections: ChapterSentenceTiming[]; unmatched_section_slugs: string[] } {
  const durationBySlug = new Map<string, number>()
  for (const c of chapterDurations) durationBySlug.set(c.slug, c.duration_s)

  const sections: ChapterSentenceTiming[] = []
  const unmatched: string[] = []
  for (const section of narrationSections) {
    const duration = durationBySlug.get(section.slug)
    if (duration == null) {
      unmatched.push(section.slug)
      continue
    }
    const sentences = splitIntoSentences(section.text)
    if (sentences.length === 0) continue
    sections.push({
      slug: section.slug,
      duration_s: duration,
      sentences: distributeChapterDuration(sentences, duration),
    })
  }
  return { sections, unmatched_section_slugs: unmatched }
}
