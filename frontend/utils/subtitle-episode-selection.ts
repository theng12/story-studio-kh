/**
 * What Step 5 SHOWS about the subtitle file this episode will be rendered with.
 *
 * ── What this module used to be, and why it changed (v1.4.0) ──
 *
 * In v1.3.4 this file decided which transcript Video Assembly would burn. It
 * existed because a finished EP0047 video went out carrying EP0048's captions:
 * `subtitles.srt_path` was an absolute path held in page state and carried
 * straight across an episode change, and the reload that refreshed the file list
 * only ever filled an EMPTY selection. The fix re-resolved the path to this
 * episode's equivalent and announced every change.
 *
 * That fix worked, and the owner then asked for the problem to be removed rather
 * than managed: *"there's no need for me to select which subtitle but
 * automatically selected the stitched subtitle. you don't need to show the
 * several chapters ones as well"*.
 *
 * So the decision has left the browser entirely. The backend's
 * `resolveBurnSubtitle` — the one the renderer itself calls — now reports its
 * answer as `burn_target` on the subtitles status endpoint, and this module only
 * describes it. That is deliberately not a smaller version of the old job: a
 * frontend re-implementing the precedence rule could show one filename while the
 * encoder burned another, which is a quieter version of the very bug this module
 * was written for. The page displays the renderer's own answer or nothing.
 *
 * The whole class of defect goes with it. No episode-specific subtitle state is
 * held in the page any more, so there is nothing left that could survive an
 * episode change: every field here is derived from a status response fetched for
 * the episode currently on screen.
 *
 * This file was rewritten rather than deleted, and says why, so the next reader
 * finds the reasoning instead of an unexplained absence — the same treatment
 * `continuityPresetPacing.test.ts` was given for the same reason.
 */

export interface EpisodeSubtitleFile {
  path: string
  filename: string
}

/**
 * A per-chapter partial (`EP0048_Chapter_03.srt`) — a fragment of the episode,
 * never a burn target. The backend's AUTO rule has excluded these since
 * v1.0.418; from v1.4.0 they are not offered on screen either, so the list a
 * person reads matches the list the renderer would consider.
 */
export function isChapterPartial(filename: string): boolean {
  return /_chapter_\d+/i.test(String(filename || ''))
}

export interface SubtitleStatusLike {
  existing_srts?: EpisodeSubtitleFile[] | null
  /** The file the renderer would burn, decided server-side. */
  burn_target?: string | null
  /** The customer's `.selected_subtitle` pin, when there is one. */
  selected_subtitle?: string | null
}

export interface SubtitleBurnView {
  /** Filename the render will burn. Null when this episode has no transcript. */
  burning: string | null
  /** Whether that came from the customer's own pin rather than the automatic rule. */
  pinned: boolean
  /** Full-episode transcripts he may switch to, excluding the active one. */
  alternatives: EpisodeSubtitleFile[]
  /** How many per-chapter partials exist but are deliberately not listed. */
  hidden_chapter_count: number
}

/**
 * Describe the burn selection for display. Pure — the page holds none of this.
 */
export function describeSubtitleBurn(status: SubtitleStatusLike | null | undefined): SubtitleBurnView {
  const all = Array.isArray(status?.existing_srts) ? status.existing_srts : []
  const full = all.filter(s => !isChapterPartial(s.filename))
  const burning = status?.burn_target || null
  const pin = status?.selected_subtitle || null
  return {
    burning,
    // A pin only counts when it names the file actually being burned. A pin
    // pointing at a file that has since been deleted is honoured by nothing, and
    // saying "you chose this" about a file the renderer ignored would be a lie.
    pinned: !!pin && pin === burning,
    alternatives: full.filter(s => s.filename !== burning),
    hidden_chapter_count: all.length - full.length,
  }
}
