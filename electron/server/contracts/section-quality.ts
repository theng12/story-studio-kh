/**
 * Per-chapter result of the Studio Hub's narration section check (Hub 0.6.137+),
 * as the audio job records it (`job.result.section_quality[chapter]`) and the
 * Audio page shows it. Zero-dependency: also imported by the frontend runtime.
 */
export interface ChapterSectionQuality {
  /** Sections the Mac checked in this chapter. */
  sections: number
  /** Re-makes in all (a section made three times counts two). */
  remade: number
  /** Plain reason when a section failed on every try and the chapter was not saved. */
  failed?: string
}

/** One line for the chapter row. */
export function describeChapterSectionQuality(quality: ChapterSectionQuality): string {
  if (quality.failed) return quality.failed
  if (quality.remade) {
    return `Checked by the Mac: it re-made ${quality.remade === 1 ? 'a section' : `${quality.remade} sections`} that came out wrong (silent, humming or missing words), and all ${quality.sections} now pass.`
  }
  return `Checked by the Mac: all ${quality.sections} section${quality.sections === 1 ? '' : 's'} came out right the first time.`
}
