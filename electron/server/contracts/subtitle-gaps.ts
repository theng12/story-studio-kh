/**
 * One wording for "the transcript skipped speech here", shared by the
 * subtitles job message, Scene Plan and the Subtitles page so all three name
 * the same chapter, time and length. Zero-dependency: also imported by the
 * frontend runtime.
 */
export interface SubtitleGapForDisplay {
  /** Chapter slug such as `Chapter_03`; empty when the gap spans no single chapter. */
  slug?: string
  /** Seconds from the start of that chapter's audio, when known. */
  start_sec?: number
  gap_sec: number
}

/** `Chapter_03` → `Chapter 3`. */
export function subtitleChapterLabel(slug: string): string {
  return slug.replace(/_/g, ' ').replace(/\b0+(?=\d)/g, '').trim()
}

function clock(sec: number): string {
  const whole = Math.max(0, Math.floor(sec))
  const h = Math.floor(whole / 3600)
  const m = Math.floor((whole % 3600) / 60)
  const s = String(whole % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

/**
 * "Chapter 3: 35 s at 5:12; Chapter 11: 32 s at 10:01, 37 s at 10:56; and 2 more chapters"
 * Gaps are grouped by chapter in first-seen order; `limit` counts chapters.
 */
export function describeSubtitleGaps(gaps: SubtitleGapForDisplay[], limit = 5): string {
  const byChapter = new Map<string, SubtitleGapForDisplay[]>()
  for (const gap of gaps) {
    const key = gap.slug || ''
    byChapter.set(key, [...(byChapter.get(key) || []), gap])
  }
  const chapters = Array.from(byChapter.entries())
  const shown = chapters.slice(0, limit).map(([slug, list]) => {
    const label = slug ? subtitleChapterLabel(slug) : 'A part with no single chapter'
    const times = list.map(gap => `${Math.round(gap.gap_sec)} s${gap.start_sec === undefined ? '' : ` at ${clock(gap.start_sec)}`}`)
    return `${label}: ${times.join(', ')}`
  })
  const more = chapters.length - shown.length
  return shown.join('; ') + (more > 0 ? `; and ${more} more chapter${more === 1 ? '' : 's'}` : '')
}
