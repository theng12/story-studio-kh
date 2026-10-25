/**
 * The wire shape of "is this chapter's narration out of date?" — shared by the
 * backend rule (electron/server/services/narration-staleness.ts) and the two
 * panels that show it (the Audio page's chapter selector and the Scripts page's
 * chapter panel).
 *
 * It is an object, not a boolean, for the reason AGENTS.md §6 gives: "this audio
 * is fresh" and "there was nothing to compare" must never be the same answer,
 * and a reader must be able to tell which rule noticed — the recorded text
 * fingerprint (`content`) or the honest mtime fallback for narration made before
 * that record existed (`legacy_mtime`).
 *
 * Type-only: no runtime value crosses the boundary. The sentence the UI shows is
 * the backend's own `detail`, so a message that says "the script changed" is true
 * by construction.
 */

export type NarrationStalenessState = 'fresh' | 'stale' | 'unknown'

export type NarrationStalenessBasis = 'content' | 'legacy_mtime' | 'none'

export type NarrationStalenessReason =
  /** A recorded fingerprint matched the chapter's current text. */
  | 'text_unchanged'
  /** A recorded fingerprint differs from the chapter's current text. */
  | 'text_changed'
  /** No fingerprint recorded; the chapter file is newer than every audio chunk. */
  | 'legacy_script_newer_than_audio'
  /** No fingerprint recorded; the audio is at least as new as the chapter file. */
  | 'legacy_script_not_newer'
  /** Nothing generated for this section. */
  | 'no_audio'
  /** The chapter's text could not be read, so there is nothing to compare it with. */
  | 'script_absent'

export interface NarrationStaleness {
  state: NarrationStalenessState
  basis: NarrationStalenessBasis
  reason: NarrationStalenessReason
  /** One sentence the UI may show verbatim. */
  detail: string
}
