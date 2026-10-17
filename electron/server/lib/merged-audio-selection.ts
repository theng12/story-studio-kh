/**
 * Which merged track is THIS episode's narration (v1.4.314).
 *
 * ── The defect this exists to end ──
 *
 * `write_mode: 'new'` leaves `{CODE}_merged_audio_v2.mp3` (and `_v3`…) beside the
 * base `{CODE}_merged_audio.mp3`, and the app then answers "which narration?"
 * four different ways depending on who is asking:
 *
 *   - `selectMergedAudioFilename` (this file) — the BASE track, by code-unit sort;
 *     used by the subtitle stitcher, the Video Assembly intro row and the Scene
 *     Plan readiness gate;
 *   - `scanEpisodeAssets` (`generators/video.ts`) — the FIRST file in raw
 *     `readdir` order, which becomes `merged_audio[0]` and is what the RENDER
 *     lays under the pictures;
 *   - `inspectAudioMergeAtPaths` (`services/asset-status.ts`) — the HIGHEST `_vN`,
 *     used by `audio-merge-status` and by B-Roll's narration authority;
 *   - `routes/scene-review.ts` — the LARGEST `.mp3` by byte size.
 *
 * For PR0002/PR0003 the owner chose the latest (`_v2`) merge. The Final Video
 * path (stitch, plan gate, render, Scene Review) kept selecting the base
 * 14-voice test track while `audio-merge-status` and B-Roll selected the `_v2`,
 * so a forced `subtitles` re-run did nothing (the stitch fingerprint matched the
 * file it had already chosen) and every timing that was "reconciled" was
 * reconciled against the track the owner had NOT chosen. No single selector can
 * fix this by fiat — deciding which narration a customer's video carries is
 * editorial, and picking the highest version for every episode would silently
 * re-time episodes whose owner never asked for the `_v2`.
 *
 * ── The fix: one explicit, episode-owned choice, honoured everywhere ──
 *
 * The owner pins a filename exactly as he already pins a subtitle file: a tiny
 * dotfile sidecar (`.selected_merged_audio`) co-located with the tracks, holding
 * one basename. It travels with the episode folder, so it is episode state and
 * not a preset. Every selector above consults this choice FIRST, and falls back
 * to its own long-standing rule only when no choice was made — so an episode
 * nobody pinned behaves exactly as it did before, and an episode the owner
 * pinned behaves the same way in all four places.
 *
 * The pin is validated by MEMBERSHIP, not by parsing: it must name a real merged
 * track (`{CODE}_merged_audio(_vN)?.{mp3,wav,m4a}`) that is present in THIS
 * episode's folder. A pin that names a missing or foreign file is not silently
 * discarded — that would be the same silent substitution the whole module is
 * here to prevent — it is reported as `invalid`, and the callers that choose the
 * artifact a render uses refuse rather than guess.
 */

import fs from 'fs/promises'
import path from 'path'

/** Dotfile holding the pinned merged-audio basename. Co-located with the tracks. */
export const SELECTED_MERGED_AUDIO_SIDECAR = '.selected_merged_audio'

/**
 * A merged-audio track: `{CODE}_merged_audio.{ext}` or its `_v2`/`_v3`… revisions.
 *
 * Deliberately identical to `isMergedFilename` in `generators/video.ts` (the
 * asset scanner) and to the private pattern this module used to hold, because
 * the choice computed here must describe the very file the renderer lays under
 * the pictures. It ENDS at a real audio extension, so the
 * `{CODE}_merged_audio.completion.json` record written beside the track (v1.3.4)
 * is never mistaken for one.
 */
export const MERGED_AUDIO_FILENAME = /_merged_audio(?:_v\d+)?\.(?:mp3|wav|m4a)$/i

/**
 * Is `name` a merged track that belongs to `episodeCode`'s own folder?
 *
 * Ownership is read from the filename the app itself writes — every merged track
 * is prefixed with its episode code — and the answer is a fact, not a guess.
 */
export function isEpisodeMergedAudioFilename(name: string, episodeCode: string): boolean {
  const code = String(episodeCode || '').toUpperCase()
  return typeof name === 'string'
    && code.length > 0
    && !name.startsWith('.')
    && name.toLowerCase().startsWith(`${code.toLowerCase()}_`)
    && MERGED_AUDIO_FILENAME.test(name)
}

/** Read the owner-pinned merged track for this folder, or null if none/cleared. */
export async function readSelectedMergedAudio(mergedAudioDir: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(mergedAudioDir, SELECTED_MERGED_AUDIO_SIDECAR), 'utf-8')
    const name = raw.trim()
    return name || null
  } catch {
    return null
  }
}

/** Pin a merged-audio filename (basename) for this folder. Pass null/'' to clear. */
export async function writeSelectedMergedAudio(mergedAudioDir: string, filename: string | null): Promise<void> {
  const p = path.join(mergedAudioDir, SELECTED_MERGED_AUDIO_SIDECAR)
  if (!filename || !filename.trim()) {
    await fs.rm(p, { force: true }).catch(() => {})
    return
  }
  await fs.mkdir(mergedAudioDir, { recursive: true }).catch(() => {})
  await fs.writeFile(p, filename.trim(), 'utf-8')
}

/**
 * The merged track the app treats as this episode's narration when nothing is
 * pinned.
 *
 * `write_mode: 'new'` can leave `{code}_merged_audio_v2.mp3` (and `_v3`…) beside
 * the original, and a reader that picks its own file answers "which narration?"
 * differently from its neighbour. Sorted by CODE UNIT, not by locale, so `.`
 * (0x2E) precedes `_` (0x5F) and the base track wins over a `_v2` — the order
 * `resolveEpisodeIntroLeadIn` has always used. It is the selection the subtitle
 * stitcher and the merged-record readers share. Null when the folder holds none.
 *
 * This is the FALLBACK, used only when the owner has not pinned a track. Callers
 * that already hold the scan's file (the renderer, the plan builder) should pass
 * THAT file rather than re-selecting here.
 */
export function selectMergedAudioFilename(entries: readonly string[], episodeCode: string): string | null {
  const code = episodeCode.toUpperCase()
  return entries
    .filter(name => !name.startsWith('.')
      && name.toLowerCase().startsWith(`${code.toLowerCase()}_`)
      && MERGED_AUDIO_FILENAME.test(name))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[0] ?? null
}

/**
 * The outcome of applying an owner pin to a folder listing.
 *
 * `source` is the whole answer a caller needs:
 *   - `selected` — a pin names a real member of this folder; use `filename`.
 *   - `unset`    — no pin; apply your own long-standing fallback rule.
 *   - `invalid`  — a pin exists but is not a member (deleted, renamed, or another
 *                  episode's file). Do NOT substitute: `filename` is null and the
 *                  caller decides whether to refuse.
 */
export interface MergedAudioChoice {
  source: 'selected' | 'unset' | 'invalid'
  /** The track to use when `source === 'selected'`; null otherwise. */
  filename: string | null
  /** The pin exactly as it was recorded, when there was one. */
  pinned: string | null
}

/** Pure: apply a recorded pin to a folder listing. No disk, so it can be tested. */
export function applyMergedAudioSelection(
  entries: readonly string[],
  episodeCode: string,
  pinned: string | null | undefined,
): MergedAudioChoice {
  const pin = (pinned || '').trim()
  if (!pin) return { source: 'unset', filename: null, pinned: null }
  const member = entries.includes(pin) && isEpisodeMergedAudioFilename(pin, episodeCode)
  return member
    ? { source: 'selected', filename: pin, pinned: pin }
    : { source: 'invalid', filename: null, pinned: pin }
}

/** Read this folder's pin and apply it to its listing. Never throws. */
export async function resolveEpisodeMergedAudioChoice(
  mergedAudioDir: string,
  episodeCode: string,
): Promise<MergedAudioChoice & { entries: string[] }> {
  const entries = await fs.readdir(mergedAudioDir).catch(() => [] as string[])
  const pinned = await readSelectedMergedAudio(mergedAudioDir)
  return { ...applyMergedAudioSelection(entries, episodeCode, pinned), entries }
}

/**
 * The file this episode's narration is, honouring the pin.
 *
 * `invalid` returns null (there is no safe answer) — callers that must choose an
 * artifact use `resolveEpisodeMergedAudioChoice` and refuse instead.
 */
export async function resolveEpisodeMergedAudioFilename(
  mergedAudioDir: string,
  episodeCode: string,
): Promise<string | null> {
  const choice = await resolveEpisodeMergedAudioChoice(mergedAudioDir, episodeCode)
  if (choice.source === 'selected') return choice.filename
  if (choice.source === 'invalid') return null
  return selectMergedAudioFilename(choice.entries, episodeCode)
}

/**
 * The track to name to a reader that verifies a completion record's own
 * `output_filename` (see `readMergedAudioRecord` / `inspectPlanTimelineDrift`).
 *
 * The result is deliberately discriminated, because `null` is ambiguous to those
 * readers: they take a null/undefined expectation as "do not check the record",
 * so a caller holding an `invalid` pin must NOT hand them one — that would let a
 * record describing a DIFFERENT track stand in and claim the narration is known.
 *
 *   - `{ ok: true, filename }` — name this track: the pin (`selected`) or this
 *     module's base-first fallback (`unset`). `filename` is null only when the
 *     episode holds no merged track at all.
 *   - `{ ok: false, pinned }` — the pin names a track that is not here. The
 *     caller MUST refuse and name the repair; it must not fall through to the
 *     record.
 */
export function expectedMergedAudioFilename(
  choice: MergedAudioChoice & { entries: readonly string[] },
  episodeCode: string,
): { ok: true; filename: string | null } | { ok: false; pinned: string | null } {
  if (choice.source === 'invalid') return { ok: false, pinned: choice.pinned }
  if (choice.source === 'selected') return { ok: true, filename: choice.filename }
  return { ok: true, filename: selectMergedAudioFilename(choice.entries, episodeCode) }
}
