/**
 * Subtitle text-quality report — mirrors `electron/server/lib/subtitle-quality.ts`.
 *
 * Advisory only. Nothing in the app gates on these values, and no subtitle file
 * is ever edited because of them: a mangled word cannot be repaired without
 * knowing what was actually said, so the app reports and a person decides.
 */

export type SubtitleQualityRuleId =
  | 'non_latin_script'
  | 'replacement_character'
  | 'control_character'
  | 'misplaced_combining_mark'
  | 'repeated_word_run'

export interface SubtitleQualityFinding {
  rule: SubtitleQualityRuleId
  label: string
  cue: number
  start_sec: number
  text: string
}

export interface SubtitleQualityReport {
  clean: boolean
  cues: number
  affected_cues: number
  rules: SubtitleQualityRuleId[]
  findings: SubtitleQualityFinding[]
  truncated: boolean
}

/** True when a report exists and actually found something worth showing. */
export function hasQualityFindings(
  quality: SubtitleQualityReport | null | undefined,
): quality is SubtitleQualityReport {
  return !!quality && !quality.clean && quality.affected_cues > 0
}
