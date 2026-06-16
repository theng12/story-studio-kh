/**
 * Subtitle selection + burn-target resolution (v1.0.396).
 *
 * An episode's subtitles dir can hold several burnable files at once — e.g.
 * a full `EP0075_stitched.srt`, a `EP0075_whisper.srt`, and per-chapter
 * `EP0075_Chapter_01.srt` … The assembler used to burn `files.find(.srt)` —
 * the FIRST in directory order, which on macOS is alphabetical, so a
 * per-chapter partial (`Chapter_01`) won over the full stitched transcript.
 * That's the "it burned the wrong/short transcript and I couldn't pick"
 * report.
 *
 * Two fixes live here, shared by the burn paths:
 *   - an explicit, persisted user PIN (`.selected_subtitle` sidecar) so the
 *     user can choose exactly which file to burn, and
 *   - a smarter AUTO heuristic for when nothing is pinned: prefer a full
 *     stitched/whisper transcript and skip per-chapter partials.
 *
 * The pin is a tiny dotfile in the subtitles dir (not matched by the
 * .srt/.ass/.vtt burn filter), so it travels with the project folder.
 */

import { existsSync } from 'fs'
import fs from 'fs/promises'
import path from 'path'

/** Dotfile holding the pinned subtitle basename. Co-located with the SRTs. */
export const SELECTED_SUBTITLE_SIDECAR = '.selected_subtitle'

const BURNABLE = /\.(srt|ass|vtt)$/i

/** Read the user-pinned subtitle filename for this dir, or null if none/cleared. */
export async function readSelectedSubtitle(subtitlesDir: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(subtitlesDir, SELECTED_SUBTITLE_SIDECAR), 'utf-8')
    const name = raw.trim()
    return name || null
  } catch {
    return null
  }
}

/** Pin a subtitle filename (basename) to burn. Pass null/'' to clear (→ AUTO). */
export async function writeSelectedSubtitle(subtitlesDir: string, filename: string | null): Promise<void> {
  const p = path.join(subtitlesDir, SELECTED_SUBTITLE_SIDECAR)
  if (!filename || !filename.trim()) {
    await fs.rm(p, { force: true }).catch(() => {})
    return
  }
  await fs.mkdir(subtitlesDir, { recursive: true }).catch(() => {})
  await fs.writeFile(p, filename.trim(), 'utf-8')
}

const extRank = (f: string): number => {
  const e = f.toLowerCase().slice(f.lastIndexOf('.') + 1)
  return e === 'srt' ? 0 : e === 'ass' ? 1 : 2
}
const byExt = (a: string, b: string): number => extRank(a) - extRank(b)

/**
 * Resolve which burnable subtitle file to use, returning its ABSOLUTE path
 * (or null when nothing burnable exists):
 *   1. the user PIN, if it still exists on disk
 *   2. a full stitched transcript  (`*_stitched.{srt,ass,vtt}`)
 *   3. a full whisper transcript   (`*_whisper.{srt,ass,vtt}`)
 *   4. any burnable that is NOT a per-chapter partial (`*_Chapter_NN`)
 *   5. first burnable by SRT → ASS → VTT priority
 */
export async function resolveBurnSubtitle(subtitlesDir: string): Promise<string | null> {
  if (!existsSync(subtitlesDir)) return null
  const files = (await fs.readdir(subtitlesDir).catch(() => [] as string[]))
    .filter(f => BURNABLE.test(f) && !f.startsWith('.tmp_'))
  if (!files.length) return null

  const pinned = await readSelectedSubtitle(subtitlesDir)
  if (pinned && files.includes(pinned)) return path.join(subtitlesDir, pinned)

  const pick = (re: RegExp): string | undefined => files.filter(f => re.test(f)).sort(byExt)[0]
  const chosen =
    pick(/_stitched\.(srt|ass|vtt)$/i) ||
    pick(/_whisper\.(srt|ass|vtt)$/i) ||
    files.filter(f => !/_chapter_\d+/i.test(f)).sort(byExt)[0] ||
    [...files].sort(byExt)[0]!
  return path.join(subtitlesDir, chosen)
}
