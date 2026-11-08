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

/**
 * The post-audio block a NEW render may draw (owner, 2026-11-07: prevent new
 * black endings; finished videos are never touched). `black-screen` and
 * `fade-to-black` become `hold-last-scene` over the SAME tail length — the
 * seconds `postRollSeconds` already returned for them, carried across — so the
 * closing music, the video's length and every duration/frame check stay exactly
 * what they were. Stored presets and requests are not modified: this returns a
 * block for the draw, and the caller says what it substituted.
 */
export function preventBlackTail(postAudio: VideoPostAudio): VideoPostAudio {
  const behavior = postAudio.behavior
  if (behavior === 'hold-last-scene' || behavior === 'hard-cut' || behavior === 'continue-cycling') return postAudio
  // black-screen, fade-to-black, or a legacy block that names no behavior (the
  // old default was fade-to-black at 5 s): hold over exactly the seconds
  // postRollSeconds already gives that block — one formula, one answer.
  return { ...postAudio, behavior: 'hold-last-scene', tail_seconds: postRollSeconds(postAudio) }
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
 * The closing a render's `post_audio` block asks for, in the shape Audio Assembly bakes.
 *
 * `postAudio` is the block of THE render this audio is for: a Pipeline run's Video Assembly bundle, or
 * the request the render guard holds. Whatever will actually be drawn is the truth about what to bake.
 */
export function closingTailFromPostAudio(postAudio: VideoPostAudio | null | undefined): ClosingTailRequest {
  return { seconds: postRollSeconds(postAudio), music: postAudio?.closing_music }
}

/**
 * The `post_audio` block a MANUAL Audio Assembly of this episode bakes, from the project's config: the
 * episode's own last Video Assembly render, else the active timeline preset — the order the page
 * restores for this episode.
 *
 * The CHANNEL-level last render is deliberately not a source. It is another episode's choice, offered
 * to the page only as a starting point, and letting it decide how long THIS episode's audio runs would
 * leak one episode's closing into another's (AGENTS.md §4). A last render whose timeline names no
 * `post_audio` leaves the preset's in place, as the page's `applyTimelineData` does.
 *
 * A Pipeline run or a render does not come through here: both carry the block they will draw
 * (`closing_post_audio` on the merge), which outranks anything saved.
 */
export async function resolveClosingPostAudio(config: any, episodeId: string): Promise<VideoPostAudio | undefined> {
  const { resolveTimelineSlot } = await import('../services/opening-assets.js')
  const own = config?.video_assembly_last_used?.episodes?.[episodeId.trim().toUpperCase()]?.settings
  const rendered = own?.timeline?.post_audio
  if (rendered && typeof rendered === 'object') return rendered as VideoPostAudio
  return resolveTimelineSlot(config)?.post_audio as VideoPostAudio | undefined
}

/**
 * The closing tail a manual Audio Assembly of this episode bakes (`resolveClosingPostAudio`). 0 when the
 * project has no Video Assembly setting, when it asks for no tail, or when the config cannot be read at
 * all: an unreadable setting is no tail, never a guessed one.
 */
export async function resolveProjectClosingTail(slug: string, episodeId: string): Promise<ClosingTailRequest> {
  try {
    const pm = await import('../services/project-manager.js')
    return closingTailFromPostAudio(await resolveClosingPostAudio(await pm.getConfig(slug), episodeId))
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
 * How much of `mergedClosingTailSec` the merge baked under an appended outro (0 when the record does
 * not say, when it describes a different file, or when no outro music was baked). The renderer keeps
 * `closing_tail_sec - closing_outro_sec` as the held post-audio tail and appends the outro for the rest,
 * so the picture's length is unchanged while the music reaches the true end.
 */
export async function mergedClosingOutroSec(mergedAudioPath: string, code: string): Promise<number> {
  try {
    const record = JSON.parse(await fs.readFile(mergedAudioCompletionPath(mergedAudioPath, code), 'utf-8'))
    if (record?.output_filename !== path.basename(mergedAudioPath)) return 0
    const sec = Number(record?.closing_outro_sec)
    return Number.isFinite(sec) && sec > 0 ? sec : 0
  } catch {
    return 0
  }
}

/**
 * Whether the merge recorded a background music bed in this file: true / false as written, null when
 * the record does not say (no record, a record for a different file, or one written before 1.4.352).
 * Null is "could not tell", which the caller must not read as "no bed" (AGENTS.md §6).
 */
export async function mergedBackgroundMusic(mergedAudioPath: string, code: string): Promise<boolean | null> {
  try {
    const record = JSON.parse(await fs.readFile(mergedAudioCompletionPath(mergedAudioPath, code), 'utf-8'))
    if (record?.output_filename !== path.basename(mergedAudioPath)) return null
    return typeof record?.background_music === 'boolean' ? record.background_music : null
  } catch {
    return null
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
