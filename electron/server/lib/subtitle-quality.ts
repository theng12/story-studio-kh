/**
 * Subtitle text-quality inspection — v1.2.2
 *
 * Whisper hallucinates. Not "occasionally, in theory": across the owner's own
 * library of 4,032 real subtitle files, 18.7% contain letters from a script
 * the narration was never spoken in, and 4.4% contain U+FFFD replacement
 * characters. Real cues from that library:
 *
 *   "马 West outside The gust,"
 *   "ראing the mouth on the ground to the гол spout her"
 *   "and��GRientos"
 *   "So we left intell intell intell intell intell …" (218 times)
 *
 * A worker-side decode fix removes most of this at the source, but no decode
 * setting eliminates hallucination, and the existing library keeps what it
 * already has — the owner has decided not to re-transcribe old episodes. So
 * this is the second layer: make sure garbage never reaches a customer's video
 * unnoticed.
 *
 * Three rules govern everything here:
 *
 *   1. DETECT, NEVER EDIT. A mangled word is not automatically repairable —
 *      nobody knows what was actually said. We report; a person decides. The
 *      only real repair is re-transcription, which is a person's call.
 *   2. ADVISORY, NEVER BLOCKING. A person may knowingly ship a caption with an
 *      odd character in it. Nothing here may gate a render.
 *   3. A RULE THAT MISFIRES IS WORSE THAN NO RULE, because it teaches people to
 *      ignore the warning. Every rule below was measured across all 4,032 files
 *      before shipping, and the measured flag rate is recorded on the rule.
 *
 * The product is English-only by deliberate commercial choice, so a non-Latin
 * letter in a transcript is corruption, full stop — no language-conditional
 * logic, which is both simpler and more reliable.
 *
 * What is deliberately NOT flagged, because these are legitimate and flagging
 * them would discredit the whole feature: Latin-script diacritics (café,
 * Škoda, Zoë, naïve, gelmiş, Đ), curly quotes, em-dashes, ellipses, music
 * notes, emoji, and short deliberate repetition ("No, no, no, no, no!",
 * "Tap, tap, tap."). All four appear in the real corpus as normal narration.
 */

import { parseSrt } from './subtitle-builder.js'
import { truncateChars } from './well-formed-text.js'

export type SubtitleQualityRuleId =
  | 'non_latin_script'
  | 'replacement_character'
  | 'control_character'
  | 'misplaced_combining_mark'
  | 'repeated_word_run'

export interface SubtitleQualityRule {
  id: SubtitleQualityRuleId
  /** Short human label, shown verbatim in the UI. */
  label: string
  /** Measured share of the owner's 4,032-file corpus this rule flags. */
  measured_flag_rate: string
  test: (text: string) => boolean
}

export interface SubtitleQualityFinding {
  rule: SubtitleQualityRuleId
  label: string
  /** SRT cue number, so a person can find it in the file. */
  cue: number
  /** Cue start time in seconds, so a person can scrub to it. */
  start_sec: number
  /** The cue's text, truncated — enough to judge in a second. */
  text: string
}

export interface SubtitleQualityReport {
  /** True when nothing was found. The only value the UI needs for "is it OK?". */
  clean: boolean
  /** Cues parsed out of the file. Zero means the file was empty or unparseable. */
  cues: number
  /** How many distinct cues tripped at least one rule. */
  affected_cues: number
  /** Rule ids that fired, in the order the rules are declared. */
  rules: SubtitleQualityRuleId[]
  /** Capped sample of findings — see MAX_FINDINGS. */
  findings: SubtitleQualityFinding[]
  /** True when `findings` was capped and more exist. */
  truncated: boolean
}

/**
 * One corrupt transcript can trip hundreds of cues (the worst real file repeats
 * a word 218 times). A person needs enough to judge, not the whole list.
 */
export const MAX_FINDINGS = 20

/** Longest excerpt shown per finding. */
const MAX_EXCERPT = 160

/**
 * Consecutive identical words before a run counts as a Whisper loop.
 *
 * Measured across all 4,032 files: threshold 3 flags 0.99% and catches
 * legitimate narration ("Tap, tap, tap.", "Click. Click. Click.", "Oh, oh,
 * oh."); threshold 4 still catches "No, no, no, no." and "slow, slow, slow,
 * slow."; threshold 5 still catches "No, no, no, no, no!". At 6 every single
 * remaining hit in the corpus was genuine corruption, verified by reading all
 * 50 cues with a run of 3 or more. 6 it is.
 */
const REPEAT_RUN_THRESHOLD = 6

/**
 * Any letter that is not Latin script.
 *
 * Written as a double negation — "not (a non-letter or a Latin letter)" — so it
 * covers every non-Latin script that exists rather than a hand-kept list of
 * ranges that silently misses Ethiopic or Tamil. Combining marks are \p{M},
 * not \p{L}, so they fall to the combining-mark rule instead; digits and
 * punctuation are not letters at all, so em-dashes, curly quotes, ellipses and
 * music notes pass through untouched.
 */
const NON_LATIN_LETTER = /[^\P{L}\p{Script=Latin}]/u

/** Unicode's own "I could not decode this byte" character. */
const REPLACEMENT_CHARACTER = /�/u

/**
 * Control and invisible-formatting characters: C0/C1 controls plus the format
 * category, which is where zero-width spaces, bidi overrides and stray BOMs
 * live. Tab, newline and carriage return are legitimate and excluded.
 */
const CONTROL_CHARACTER = /[^\P{Cc}\t\n\r]|\p{Cf}/u

/**
 * A combining mark in a position it cannot legitimately occupy: orphaned (not
 * attached to a letter) or stacked three deep.
 *
 * Deliberately narrow. Flagging combining marks in general would flag any
 * NFD-normalised file — where every "café" is c-a-f-e + U+0301 — which is a
 * perfectly valid way to store text and common on macOS. Two stacked marks is
 * also legitimate (Vietnamese "ế" decomposes to exactly that), so the stack
 * threshold is three. "Orphaned" means preceded by nothing, whitespace or
 * punctuation; a mark after a letter, digit or symbol has something to attach
 * to. Variation selectors are excluded outright — they follow symbols by
 * design, and flagging them would flag every emoji written as "☀️".
 */
const VARIATION_SELECTOR = '\\uFE00-\\uFE0F'
const ORPHAN_COMBINING_MARK = new RegExp(`(?:^|[\\s\\p{P}])(?![${VARIATION_SELECTOR}])\\p{M}`, 'u')
const STACKED_COMBINING_MARKS = new RegExp(`(?:(?![${VARIATION_SELECTOR}])\\p{M}){3,}`, 'u')

/** Longest run of the same word repeated back to back, case- and punctuation-insensitive. */
export function longestRepeatedWordRun(text: string): number {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
  let best = words.length > 0 ? 1 : 0
  let run = 1
  for (let i = 1; i < words.length; i++) {
    if (words[i] === words[i - 1]) {
      run += 1
      if (run > best) best = run
    } else {
      run = 1
    }
  }
  return best
}

/**
 * The shipped rules, with the flag rate each one measured across the owner's
 * whole 4,032-file corpus. Order is the order findings are reported in.
 */
export const SUBTITLE_QUALITY_RULES: SubtitleQualityRule[] = [
  {
    id: 'non_latin_script',
    label: 'Characters from another writing system',
    measured_flag_rate: '18.7%',
    test: text => NON_LATIN_LETTER.test(text),
  },
  {
    id: 'replacement_character',
    label: 'Undecodable characters (�)',
    measured_flag_rate: '4.4%',
    test: text => REPLACEMENT_CHARACTER.test(text),
  },
  {
    id: 'repeated_word_run',
    label: 'A word repeated over and over',
    measured_flag_rate: '0.4%',
    test: text => longestRepeatedWordRun(text) >= REPEAT_RUN_THRESHOLD,
  },
  {
    id: 'control_character',
    label: 'Invisible control characters',
    measured_flag_rate: '0.1%',
    test: text => CONTROL_CHARACTER.test(text),
  },
  {
    id: 'misplaced_combining_mark',
    label: 'Accent marks with nothing to attach to',
    measured_flag_rate: '0.05%',
    test: text => ORPHAN_COMBINING_MARK.test(text) || STACKED_COMBINING_MARKS.test(text),
  },
]

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > MAX_EXCERPT ? `${truncateChars(flat, MAX_EXCERPT - 1)}…` : flat
}

/**
 * Inspect the text of one subtitle file.
 *
 * Takes the raw file contents so callers can reuse whatever they already read.
 * Never throws: an unparseable file reports zero cues and stays "clean", because
 * this check exists to warn about text quality, not to police file structure —
 * `inspectSubtitleCompletion` already owns whether a file is usable at all.
 */
export function inspectSubtitleText(raw: string): SubtitleQualityReport {
  const cues = parseSrt(raw)
  const findings: SubtitleQualityFinding[] = []
  const rulesFired = new Set<SubtitleQualityRuleId>()
  let affected = 0
  let total = 0

  for (const cue of cues) {
    let cueAffected = false
    for (const rule of SUBTITLE_QUALITY_RULES) {
      if (!rule.test(cue.text)) continue
      cueAffected = true
      rulesFired.add(rule.id)
      total += 1
      if (findings.length < MAX_FINDINGS) {
        findings.push({
          rule: rule.id,
          label: rule.label,
          cue: cue.index,
          start_sec: cue.start_sec,
          text: excerpt(cue.text),
        })
      }
    }
    if (cueAffected) affected += 1
  }

  return {
    clean: affected === 0,
    cues: cues.length,
    affected_cues: affected,
    rules: SUBTITLE_QUALITY_RULES.filter(r => rulesFired.has(r.id)).map(r => r.id),
    findings,
    truncated: total > findings.length,
  }
}
