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

/**
 * Audio Generator, opened on one chapter with "Re-narrate" ready: re-makes that
 * chapter's narration, then its subtitles. A subtitle gap is almost always the
 * narration (Dreamlands 2026-10-03), and re-transcribing cannot fix that.
 */
export function renarrateLink(projectSlug: string, episodeId: string, slug: string): string {
  const query = new URLSearchParams({ episode_id: episodeId, section: slug, renarrate: '1' })
  return `/projects/${encodeURIComponent(projectSlug)}/audio?${query.toString()}`
}

/** What is under one gap in the chapter audio (`audio` from the Subtitles status), in plain words. */
export function gapAudioSentence(audio?: 'silent' | 'sound'): string {
  if (audio === 'silent') return 'No sound here: the narration skipped this part.'
  if (audio === 'sound') return 'There is sound here. Listen: humming or mumbling means the narration went wrong; clear speech means only the subtitles missed it.'
  return ''
}

/** A chapter-local check has no episode-timeline dependency. Bulk/Pipeline work still does. */
export function isScopedChapterTranscription(request: {
  per_chapter?: unknown; method?: unknown; sections?: unknown; pipeline_repair?: unknown; pipeline_chain?: unknown
}): boolean {
  return (request.per_chapter === true || request.method === 'script')
    && !request.pipeline_repair
    && !(Array.isArray(request.pipeline_chain) && request.pipeline_chain.length)
    && Array.isArray(request.sections)
    && request.sections.length > 0
    && request.sections.every(section => typeof section === 'string' && section.trim().length > 0)
}
