/**
 * Corrected-SRT pass — ASR timings, script words (v1.0.797+).
 *
 * WHY THIS EXISTS
 * ---------------
 * Whisper transcribes the narration audio we generated from our own script.
 * Its TIMINGS are the only source of speech alignment we have — the script
 * carries none — but its WORDS are not authoritative: they are a lossy
 * re-reading of text we already possess perfectly.
 *
 * Two failure modes were measured on EP0067:
 *
 *   1. Proper nouns get re-spelled. `Neorion` → `Mirion`, `Sycae` → `Sicke`,
 *      `Procopius` → `Bocopius`. These reached real image prompts (a Byzantine
 *      harbour that does not exist, across four scenes) and an on-screen
 *      contextual cue ("Port of Mirion" under a map pin).
 *   2. Whisper hallucinates into near-silence. Three cues carried 22, 5 and
 *      221 words across 43ms, 256ms and 260ms — 512, 20 and 850 words/second
 *      against a 3.65 w/s narration baseline. Pure fabrication.
 *
 * This module rebuilds each cue's TEXT from the script that was fed to TTS
 * while preserving its TIMESTAMPS byte-for-byte. A cue with no script
 * counterpart is dropped, which removes the hallucinations as a side effect
 * of the same pass rather than through a separate heuristic.
 *
 * Nothing here depends on a TTS provider's word-timing feature. The owner's
 * constraint, 2026-08-07: "other providers might not have so we can't rely on
 * a provider's feature for our own internal app." The only inputs are the
 * script text and the ASR cues, both of which every provider produces.
 *
 * THE SAFETY PROPERTY
 * -------------------
 * Blind replacement is only safe while the audio actually matches the script.
 * If audio is regenerated from a different script revision — or the script is
 * edited after TTS — alignment would confidently write the WRONG words onto
 * the screen, which is worse than the ASR errors it replaces. So every
 * chapter is scored and a chapter that scores badly is REFUSED: it keeps its
 * original ASR cues verbatim, hallucinations and all, because in a chapter we
 * do not trust we cannot tell a hallucination from real speech.
 *
 * See `evaluateChapterTrust` for the metric and the justification of each
 * threshold.
 *
 * Pure module: no fs, no network. `services/subtitle-correction.ts` owns the
 * disk side.
 */

import type { SrtCue } from './subtitle-builder.js'
import { normalizeForTts } from './tts-text.js'

// ── Thresholds ─────────────────────────────────────────────────────────────

export interface CorrectionThresholds {
  /** Refuse a chapter whose mismatch rate exceeds this fraction of script words. */
  max_mismatch_rate: number
  /** Refuse a chapter containing a contiguous disagreement run longer than this. */
  max_mismatch_run: number
  /** Chapters with at most this many mismatched words bypass the RATE gate
   *  (a 12-word chapter cannot be judged by a percentage). The RUN gate
   *  still applies. */
  mismatch_words_floor: number
  /** Words-per-second above which a cue is treated as fabricated rather than
   *  spoken, for the purpose of scoring trust. */
  implausible_words_per_sec: number
  /** A cue must carry at least this many words before its word-rate is
   *  allowed to excuse it as a hallucination. Keeps a clipped one-word cue
   *  from being waved through. */
  min_words_for_density: number
  /** Alignment is O(n*m); refuse rather than allocate beyond this per side. */
  max_align_words: number
}

/**
 * Defaults, each justified against measured EP0067 data.
 *
 * `max_mismatch_rate: 0.08` — measured ASR quality on real narration audio is
 *   0.41% WER with zero deletions. 8% is ~20x that baseline: far above any
 *   realistic per-chapter ASR variance (a genuinely hard chapter might reach
 *   3–5%) and far below what content divergence produces (swapping a
 *   chapter's script scores 80–100%).
 *
 * `max_mismatch_run: 6` — the rate gate alone cannot catch a small edit: one
 *   rewritten 15-word sentence in a 250-word chapter is 6%, under the rate
 *   gate, and would be confidently written over audio that says something
 *   else. But ASR noise and real edits have different SHAPES. ASR errors are
 *   scattered single words — every substitution measured on EP0067 was a run
 *   of exactly 1 (`Procopius`→`Bocopius`, `Neorion`→`Mirion`, `Sycae`→
 *   `Sicke`). An edited clause is contiguous and essentially never shorter
 *   than 6 words. 6 gives ~2x headroom over the worst realistic ASR run while
 *   catching any real edit longer than half a sentence.
 *
 * `implausible_words_per_sec: 12` — on EP0067 the fastest genuine cue runs at
 *   5.9 w/s (p95 = 4.48, mean 3.65); the three hallucinations run at 19.5,
 *   511.6 and 850.0 w/s. 12 sits in the empty gap between those populations:
 *   2.0x above the fastest real speech and 1.6x below the slowest
 *   hallucination. Human narration does not exceed ~8 w/s.
 */
export const DEFAULT_CORRECTION_THRESHOLDS: CorrectionThresholds = {
  max_mismatch_rate: 0.08,
  max_mismatch_run: 6,
  mismatch_words_floor: 3,
  implausible_words_per_sec: 12,
  min_words_for_density: 3,
  max_align_words: 8_000,
}

// ── Tokenisation ───────────────────────────────────────────────────────────

export interface WordToken {
  /** The word as it should appear on screen, punctuation attached. */
  raw: string
  /** Comparison key: lowercased, punctuation and grouping commas removed. */
  norm: string
}

/** Digit-grouping commas are stripped before splitting so "70,000" is one
 *  token rather than "70" + "000". Everything else splits on whitespace, which
 *  keeps punctuation attached to its word so re-joining reads naturally. */
export function tokenizeWords(text: string): WordToken[] {
  if (!text) return []
  const degrouped = text.replace(/(\d),(?=\d{3}\b)/g, '$1')
  const out: WordToken[] = []
  for (const piece of degrouped.split(/\s+/)) {
    const raw = piece.trim()
    if (!raw) continue
    const norm = normalizeWord(raw)
    // A unit that normalises to nothing (a lone dash, a stray quote) carries
    // no comparable content but must still survive onto the screen, so it is
    // kept with an empty key and skipped by the aligner.
    out.push({ raw, norm })
  }
  return out
}

function normalizeWord(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{N}']/gu, '')
    .replace(/'/g, '')
}

// ── Word-level alignment ───────────────────────────────────────────────────

export type AlignOp = 'match' | 'substitute' | 'delete' | 'insert'

export interface AlignStep {
  op: AlignOp
  /** Index into the script token array, or -1 for an insertion. */
  script_index: number
  /** Index into the ASR token array, or -1 for a deletion. */
  asr_index: number
}

const OP_DIAG = 1
const OP_UP = 2   // script word consumed, no ASR word — ASR dropped it
const OP_LEFT = 3 // ASR word consumed, no script word — ASR invented it

/**
 * Levenshtein alignment with backtrace over normalised words.
 *
 * `delete` = a script word the ASR did not produce.
 * `insert` = an ASR word with no script counterpart.
 *
 * Returns steps in forward order. Throws when either side exceeds
 * `max_align_words` — callers treat that as "refuse to correct".
 */
export function alignWords(
  script: WordToken[],
  asr: WordToken[],
  maxWords: number = DEFAULT_CORRECTION_THRESHOLDS.max_align_words,
): AlignStep[] {
  const n = script.length
  const m = asr.length
  if (n > maxWords || m > maxWords) {
    throw new Error(`Alignment refused: ${Math.max(n, m)} words exceeds the ${maxWords}-word safety cap.`)
  }
  if (n === 0 && m === 0) return []

  const width = m + 1
  const cost = new Int32Array((n + 1) * width)
  const ops = new Uint8Array((n + 1) * width)

  for (let j = 1; j <= m; j++) { cost[j] = j; ops[j] = OP_LEFT }
  for (let i = 1; i <= n; i++) { cost[i * width] = i; ops[i * width] = OP_UP }

  for (let i = 1; i <= n; i++) {
    const a = script[i - 1]!.norm
    const rowBase = i * width
    const prevBase = (i - 1) * width
    for (let j = 1; j <= m; j++) {
      const b = asr[j - 1]!.norm
      const diag = cost[prevBase + j - 1]! + (a === b ? 0 : 1)
      const up = cost[prevBase + j]! + 1
      const left = cost[rowBase + j - 1]! + 1
      let best = diag
      let op = OP_DIAG
      if (up < best) { best = up; op = OP_UP }
      if (left < best) { best = left; op = OP_LEFT }
      cost[rowBase + j] = best
      ops[rowBase + j] = op
    }
  }

  const steps: AlignStep[] = []
  let i = n
  let j = m
  while (i > 0 || j > 0) {
    const op = ops[i * width + j]!
    if (op === OP_DIAG) {
      const same = script[i - 1]!.norm === asr[j - 1]!.norm
      steps.push({ op: same ? 'match' : 'substitute', script_index: i - 1, asr_index: j - 1 })
      i--; j--
    } else if (op === OP_UP) {
      steps.push({ op: 'delete', script_index: i - 1, asr_index: -1 })
      i--
    } else {
      steps.push({ op: 'insert', script_index: -1, asr_index: j - 1 })
      j--
    }
  }
  steps.reverse()
  return steps
}

// ── Trust evaluation ───────────────────────────────────────────────────────

export interface ChapterTrust {
  accepted: boolean
  /** Human-readable reason when refused; empty when accepted. */
  reason: string
  script_words: number
  asr_words: number
  substitutions: number
  /** Script words the ASR never produced. */
  deletions: number
  /** ASR words with no script counterpart, inside cues whose word-rate is
   *  plausible speech — i.e. genuinely spoken audio the script does not have.
   *  These count against trust. */
  plausible_insertions: number
  /** ASR words with no script counterpart inside implausibly fast cues —
   *  fabrication. Expected, and excluded from the score. */
  fabricated_insertions: number
  mismatch_words: number
  mismatch_rate: number
  longest_mismatch_run: number
}

/**
 * Score how well the script explains the audio, from the alignment trace.
 *
 * The metric is deliberately NOT plain WER. Plain WER counts every insertion,
 * so the one chapter carrying a 221-word hallucination — the chapter that most
 * needs correcting — would score ~90% and be refused. Insertions are therefore
 * split by the evidence the owner measured: an insertion inside a cue running
 * at an impossible word-rate is fabrication (expected, excluded), while an
 * insertion inside a normally-paced cue is real speech the script does not
 * contain (divergence, counted).
 *
 * That asymmetry is what closes the dangerous hole: if someone deletes a
 * paragraph from the script after TTS, the audio still speaks it, those words
 * align to nothing, and — because they are spoken at a normal rate — they
 * count against trust instead of being silently discarded from the screen.
 *
 * Two gates, because a rate alone cannot see shape:
 *   - RATE catches wholesale divergence (wrong script, wrong episode).
 *   - RUN catches a small deliberate edit, which is contiguous where ASR
 *     noise is scattered.
 */
export function evaluateChapterTrust(
  steps: AlignStep[],
  script: WordToken[],
  asr: WordToken[],
  asrWordIsFabricated: boolean[],
  thresholds: CorrectionThresholds = DEFAULT_CORRECTION_THRESHOLDS,
): ChapterTrust {
  let substitutions = 0
  let deletions = 0
  let plausibleInsertions = 0
  let fabricatedInsertions = 0
  let run = 0
  let longestRun = 0

  for (const step of steps) {
    if (step.op === 'match') {
      run = 0
      continue
    }
    if (step.op === 'insert') {
      if (asrWordIsFabricated[step.asr_index]) {
        // Fabrication in a silence gap. Neither counted nor allowed to break
        // an otherwise contiguous disagreement run.
        fabricatedInsertions++
        continue
      }
      plausibleInsertions++
    } else if (step.op === 'substitute') {
      substitutions++
    } else {
      deletions++
    }
    run++
    if (run > longestRun) longestRun = run
  }

  const scriptWords = script.length
  const mismatchWords = substitutions + deletions + plausibleInsertions
  const mismatchRate = scriptWords > 0 ? mismatchWords / scriptWords : (mismatchWords > 0 ? 1 : 0)

  let accepted = true
  let reason = ''
  if (scriptWords === 0) {
    accepted = false
    reason = 'the script chapter is empty, so there is nothing to align against'
  } else if (longestRun > thresholds.max_mismatch_run) {
    accepted = false
    reason = `${longestRun} consecutive words disagree with the script (limit ${thresholds.max_mismatch_run}) `
      + '— that is the shape of an edited script, not of transcription noise'
  } else if (mismatchRate > thresholds.max_mismatch_rate && mismatchWords > thresholds.mismatch_words_floor) {
    accepted = false
    reason = `${(mismatchRate * 100).toFixed(1)}% of script words disagree with the audio `
      + `(limit ${(thresholds.max_mismatch_rate * 100).toFixed(0)}%) — the audio does not appear to be this script`
  }

  return {
    accepted,
    reason,
    script_words: scriptWords,
    asr_words: asr.length,
    substitutions,
    deletions,
    plausible_insertions: plausibleInsertions,
    fabricated_insertions: fabricatedInsertions,
    mismatch_words: mismatchWords,
    mismatch_rate: mismatchRate,
    longest_mismatch_run: longestRun,
  }
}

// ── Chapter correction ─────────────────────────────────────────────────────

export interface ChapterCorrectionResult {
  /** Cues to emit. When `trust.accepted` is false these are the ORIGINALS,
   *  unchanged — a refused chapter is passed through, never rewritten. */
  cues: SrtCue[]
  trust: ChapterTrust
  /** Cues dropped because no script word aligned to them. */
  dropped: SrtCue[]
  /** Cues whose text changed (excluding drops). */
  rewritten: number
  /** Sample of the actual word-level changes, for the audit sidecar. */
  samples: Array<{ from: string; to: string }>
}

/** Is this cue running impossibly fast for speech? */
export function isFabricatedCue(cue: SrtCue, wordCount: number, thresholds: CorrectionThresholds): boolean {
  if (wordCount < thresholds.min_words_for_density) return false
  const dur = cue.end_sec - cue.start_sec
  if (!(dur > 0)) return true
  return wordCount / dur > thresholds.implausible_words_per_sec
}

/**
 * Rebuild one chapter's cues from the script.
 *
 * Timestamps are copied by reference-value and never recomputed. Every script
 * word lands in exactly one cue: cue boundaries advance a cursor through the
 * script, so words the ASR dropped are restored into the surrounding cue, and
 * script text trailing the final cue is appended to it rather than lost.
 */
export function correctChapterCues(
  cues: SrtCue[],
  scriptText: string,
  thresholds: CorrectionThresholds = DEFAULT_CORRECTION_THRESHOLDS,
): ChapterCorrectionResult {
  // The audio was spoken from the TTS-normalised script, so align against
  // exactly that. It is also what we want on screen: no markdown, no em
  // dashes, no smart quotes.
  const scriptTokens = tokenizeWords(normalizeForTts(scriptText || '').text)

  const asrTokens: WordToken[] = []
  const cueOfAsrWord: number[] = []
  const wordsPerCue: number[] = []
  for (let k = 0; k < cues.length; k++) {
    const toks = tokenizeWords(cues[k]!.text)
    wordsPerCue.push(toks.length)
    for (const t of toks) { asrTokens.push(t); cueOfAsrWord.push(k) }
  }

  const fabricatedCue = cues.map((c, k) => isFabricatedCue(c, wordsPerCue[k]!, thresholds))
  const asrWordIsFabricated = cueOfAsrWord.map(k => fabricatedCue[k]!)

  let steps: AlignStep[]
  try {
    steps = alignWords(scriptTokens, asrTokens, thresholds.max_align_words)
  } catch (err) {
    return {
      cues: cues.slice(),
      trust: {
        accepted: false,
        reason: err instanceof Error ? err.message : 'alignment failed',
        script_words: scriptTokens.length,
        asr_words: asrTokens.length,
        substitutions: 0, deletions: 0, plausible_insertions: 0, fabricated_insertions: 0,
        mismatch_words: 0, mismatch_rate: 1, longest_mismatch_run: 0,
      },
      dropped: [],
      rewritten: 0,
      samples: [],
    }
  }

  const trust = evaluateChapterTrust(steps, scriptTokens, asrTokens, asrWordIsFabricated, thresholds)
  if (!trust.accepted) {
    return { cues: cues.slice(), trust, dropped: [], rewritten: 0, samples: [] }
  }

  // Highest script index aligned to each cue. Alignment is monotonic, so this
  // is non-decreasing across cues.
  const lastScriptIndex = new Array<number>(cues.length).fill(-1)
  const samples: Array<{ from: string; to: string }> = []
  for (const step of steps) {
    if (step.asr_index < 0 || step.script_index < 0) continue
    const k = cueOfAsrWord[step.asr_index]!
    if (step.script_index > lastScriptIndex[k]!) lastScriptIndex[k] = step.script_index
    if (step.op === 'substitute' && samples.length < 50) {
      samples.push({ from: asrTokens[step.asr_index]!.raw, to: scriptTokens[step.script_index]!.raw })
    }
  }

  const out: SrtCue[] = []
  const dropped: SrtCue[] = []
  let rewritten = 0
  let cursor = 0
  for (let k = 0; k < cues.length; k++) {
    const cue = cues[k]!
    const end = lastScriptIndex[k]! + 1
    if (end <= cursor) {
      // No script word belongs to this cue — it is a hallucination, or an
      // echo of words already emitted. Dropping it is the same pass, not a
      // separate heuristic.
      dropped.push(cue)
      continue
    }
    const text = scriptTokens.slice(cursor, end).map(t => t.raw).join(' ').trim()
    cursor = end
    if (!text) { dropped.push(cue); continue }
    if (text !== cue.text) rewritten++
    // Timestamps preserved exactly; only `text` differs.
    out.push({ index: out.length + 1, start_sec: cue.start_sec, end_sec: cue.end_sec, text })
  }

  // Script that trails the last aligned cue would otherwise vanish. Append it
  // to the final kept cue rather than inventing a timestamp for it.
  if (cursor < scriptTokens.length && out.length) {
    const tail = scriptTokens.slice(cursor).map(t => t.raw).join(' ').trim()
    if (tail) {
      const last = out[out.length - 1]!
      if (last.text !== `${last.text} ${tail}`) rewritten = Math.max(rewritten, 1)
      last.text = `${last.text} ${tail}`.trim()
    }
  }

  return { cues: out, trust, dropped, rewritten, samples }
}
