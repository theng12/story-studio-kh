/**
 * The closing tail — the music that plays AFTER the spoken content ends.
 *
 * Owner requirement (2026-10-19): every episode closes with 20–30 s of music
 * over either a black screen or the last scene held. Video Assembly already
 * owned the LENGTH of that tail — `post_audio.tail_seconds` for `black-screen` /
 * `hold-last-scene`, `fade_duration` for `fade-to-black` — but the tail it drew
 * was silent: Audio Assembly baked the background music into the merged master
 * and trimmed the bed at the narration's end (`totalDur = narration + leadIn`),
 * and the renderer then padded the picture with `apad` silence.
 *
 * The tail is now baked ONCE, in Audio Assembly, into the single mix. This
 * module is the one definition of how long it is, shared by the generator that
 * bakes it and the renderer that draws the picture under it. There is no second
 * setting to keep in step: Audio Assembly reads the Video Assembly preset's own
 * `post_audio` block, the same value the renderer reads.
 *
 * The merge writes the tail it actually baked into its completion record, and
 * the renderer reads THAT rather than the preset again — the preset describes
 * what is set NOW, and the file was made earlier. `describeMergedAudioOpening`
 * makes the same distinction for the lead-in.
 */

import fs from 'fs/promises'
import path from 'path'
import type { VideoClosingMusic, VideoPostAudio } from '../models/types.js'

/**
 * The post-audio tail's length in seconds — the ONE definition, shared by the
 * generator that bakes the closing music and the renderer that draws the
 * picture under it.
 *
 * `hard-cut` and the legacy `continue-cycling` end the video with the narration,
 * so they carry no tail. An absent `post_audio` is no tail, not the
 * `fade-to-black` default: that default belongs to the Video Assembly form, and
 * a request that never named a behavior has never had a tail drawn for it.
 */
export function postRollSeconds(postAudio: VideoPostAudio | null | undefined): number {
  if (!postAudio) return 0
  const behavior = postAudio.behavior || 'fade-to-black'
  if (behavior === 'fade-to-black') return Math.max(0, postAudio.fade_duration || 5)
  if (behavior === 'black-screen' || behavior === 'hold-last-scene') {
    return Math.max(0, postAudio.tail_seconds ?? 4)
  }
  return 0
}

/** The completion record Audio Assembly writes beside `{code}_merged_audio.mp3`. */
export function mergedAudioCompletionPath(mergedAudioPath: string, code: string): string {
  return path.join(path.dirname(mergedAudioPath), `${code.toUpperCase()}_merged_audio.completion.json`)
}

/** What the channel's Video Assembly preset asks the closing tail to be. */
export interface ClosingTailRequest {
  /** How long the tail runs, in seconds. 0 = no tail. */
  seconds: number
  /** The tail's music controls. Absent = the tuned defaults. */
  music?: VideoClosingMusic
}

/**
 * The closing tail the channel's Video Assembly preset asks for.
 *
 * Audio Assembly calls this so it bakes the tail the renderer will draw — the
 * same `post_audio` block, from the same active timeline slot the page itself
 * resolves (`resolveTimelineSlot`). 0 when the project has no Video Assembly
 * preset, when it asks for no tail, or when the config cannot be read at all: an
 * unreadable setting is no tail, never a guessed one.
 */
export async function resolveProjectClosingTail(slug: string): Promise<ClosingTailRequest> {
  try {
    const { resolveTimelineSlot } = await import('../services/opening-assets.js')
    const pm = await import('../services/project-manager.js')
    const postAudio = resolveTimelineSlot(await pm.getConfig(slug))?.post_audio as VideoPostAudio | undefined
    return { seconds: postRollSeconds(postAudio), music: postAudio?.closing_music }
  } catch {
    return { seconds: 0 }
  }
}

/**
 * The closing tail the merge actually baked into this file, from its completion
 * record. 0 for a merge that baked none, and for every record written before the
 * field existed — those files really do have no tail, which is what 0 says.
 *
 * The record is written once per episode code and overwritten, so a record that
 * names a different file (a `write_mode: 'new'` `_v2` beside the base) says
 * nothing about this one and is ignored — the same guard `mergedAudioMaster`
 * and `describeMergedAudioOpening` apply.
 */
export async function mergedClosingTailSec(mergedAudioPath: string, code: string): Promise<number> {
  try {
    const record = JSON.parse(await fs.readFile(mergedAudioCompletionPath(mergedAudioPath, code), 'utf-8'))
    if (record?.output_filename !== path.basename(mergedAudioPath)) return 0
    const sec = Number(record?.closing_tail_sec)
    return Number.isFinite(sec) && sec > 0 ? sec : 0
  } catch {
    return 0
  }
}

/**
 * How much of a merged master is spoken content: the master's length minus the
 * closing music tail baked into it.
 *
 * Anything that reads a merged master's duration as "how long is the narration"
 * — the Scene Plan's coverage, the plan's length stamp, the Image Pool's picture
 * budget, the render's own clock — wants this number, not the file's. The
 * renderer keeps the master's real length for the video itself, and the tail for
 * the picture it draws after the speech stops.
 */
export function narrationSecFromMaster(masterSec: number, closingTailSec: number): number {
  const master = Number(masterSec) || 0
  const tail = Number(closingTailSec) || 0
  return Math.max(0, master - (tail > 0 ? tail : 0))
}
