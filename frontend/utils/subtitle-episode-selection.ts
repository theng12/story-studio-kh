/**
 * Which subtitle file Video Assembly should burn for the episode on screen.
 *
 * v1.3.4, from a real incident: a finished EP0047 video was rendered with
 * EP0048's captions burned across it. `subtitles.srt_path` is an absolute path
 * to one episode's file on disk. It is correctly kept out of presets — and was
 * nonetheless carried straight across an episode change, because the reload
 * that refreshes the file list only ever filled an EMPTY selection. Choosing a
 * transcript for one episode and switching to another left the page pointing at
 * the first one, and the renderer burned it faithfully.
 *
 * This is the fifth instance of one shape (AGENTS.md, "Preset Boundaries"):
 * episode-specific state surviving an episode change.
 *
 * ── The ownership test ──
 *
 * Membership in the episode's own file list, not a parse of the path. The list
 * comes from a backend scan of THIS episode's subtitles folder, so it is
 * authoritative; deciding ownership by reading an episode code out of a string
 * would be a guess where a fact is available.
 *
 * ── Why re-resolve rather than blank ──
 *
 * Blanking is correct but costs the selection on every single episode switch,
 * which is its own daily annoyance. The equivalent file is identifiable rather
 * than guessable: every subtitle this app writes is prefixed with its own
 * episode code, so the remainder of the name states the KIND of transcript
 * (`_stitched.corrected.srt`, `_whisper.srt`, a per-chapter partial) and the
 * same kind in this episode's folder is the same choice, re-expressed. Only
 * when there is no equivalent does the selection clear.
 *
 * Every outcome that CHANGES the words about to be burned is announced by the
 * caller. A silent swap is the same defect in a quieter form.
 */

export interface EpisodeSubtitleFile {
  path: string
  filename: string
}

export type SubtitleEpisodeResolution =
  /** The current selection belongs to this episode (or there is nothing to do). */
  | { action: 'keep' }
  /** Nothing was selected; this is the default for the episode. Not announced. */
  | { action: 'fill'; pick: EpisodeSubtitleFile }
  /** The selection belonged elsewhere and was replaced. Announced. */
  | { action: 'swap'; dropped: string; pick: EpisodeSubtitleFile }
  /** The selection belonged elsewhere and this episode has no replacement. Announced. */
  | { action: 'clear'; dropped: string }

/**
 * Strip a leading episode code so two episodes' equivalents can be matched:
 * `EP0048_stitched.corrected.srt` → `_stitched.corrected.srt`.
 *
 * A file with no code prefix (a hand-imported one) yields its whole name and
 * simply fails to match, falling through to the default pick rather than to a
 * wrong one.
 */
export function subtitleKind(filename: string): string {
  return String(filename || '').replace(/^[A-Za-z]+\d+/, '')
}

/**
 * The default burn target for an episode: the full stitched transcript, then
 * the merged-audio Whisper one. Per-chapter partials are NEVER auto-picked —
 * they are short fragments, exactly the wrong default (v1.0.418).
 */
export function defaultSubtitlePick(
  available: EpisodeSubtitleFile[],
): EpisodeSubtitleFile | undefined {
  return available.find(s => /_stitched\.(srt|ass|vtt)$/i.test(s.filename))
    || available.find(s => /_whisper\.(srt|ass|vtt)$/i.test(s.filename))
}

export function resolveSubtitleForEpisode(
  current: string,
  available: EpisodeSubtitleFile[],
): SubtitleEpisodeResolution {
  const list = Array.isArray(available) ? available : []
  const selected = String(current || '').trim()

  if (!selected) {
    const pick = defaultSubtitlePick(list)
    return pick ? { action: 'fill', pick } : { action: 'keep' }
  }
  if (list.some(s => s.path === selected)) return { action: 'keep' }

  const dropped = selected.split('/').pop() || selected
  const kind = subtitleKind(dropped)
  // The same kind of transcript, this episode's copy — the customer's choice
  // re-expressed rather than re-decided. `kind` is only usable when stripping
  // the code actually removed something; otherwise it is the whole filename
  // and matching it would be matching a foreign name against local ones.
  const sameKind = kind && kind !== dropped
    ? list.find(s => subtitleKind(s.filename) === kind)
    : undefined
  const pick = sameKind || defaultSubtitlePick(list)
  return pick ? { action: 'swap', dropped, pick } : { action: 'clear', dropped }
}
