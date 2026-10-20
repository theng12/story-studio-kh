/**
 * An old merge asked for a closing it never had (Night Atlas History EP0012–14, 2026-10-20).
 *
 * The closing music is baked into the merged audio at Audio Assembly (1.4.327, lib/closing-tail.ts).
 * A track mixed before that carries none (`closing_tail_sec` 0), so a Video Assembly preset asking for
 * a 25 s closing WITH music drew a silent, padded tail that only the final check caught, hours later.
 *
 * ONE decision, shared by Pipeline preflight, the admission route and the render (`guardClosingTail`
 * in generators/video.ts): re-mix the audio with the tail first, or refuse in plain words. The re-mix
 * is the ordinary Audio Assembly merge written as a NEW track beside the original, accepted only if the
 * narration and its lead-in came out where they were; the tail sits after the speech, so the Scene
 * Plan and subtitles do not move. The new track becomes the episode's pinned one only after that check.
 */

import fs from 'fs/promises'
import path from 'path'
import type { Job, VideoPostAudio } from '../models/types.js'
import { mergedAudioCompletionPath, mergedClosingTailSec, postRollSeconds, resolveProjectClosingTail } from '../lib/closing-tail.js'
import { closingMusicWanted } from '../lib/final-video-check.js'
import { resolveEpisodeMergedAudioFilename, writeSelectedMergedAudio } from '../lib/merged-audio-selection.js'
import { MERGED_AUDIO_TOLERANCE_SEC } from '../lib/scene-plan-timeline.js'

/** A re-mix may not move the speech's start by more than this (the caption clock follows it). */
const LEAD_IN_TOLERANCE_SEC = 0.1
/** Sidecars a merge rewrites beside the track; put back if the re-mix is undone. */
const MERGE_SIDECARS = ['audio_chapters.json', 'audio_sentences.json']

export type ClosingTailVerdict =
  | { action: 'none' }
  | { action: 'refuse'; reason: string }
  | { action: 'remix'; wantedSec: number; params: Record<string, any>; track: MergedTrack }

interface MergedTrack {
  dir: string
  filename: string
  episodeDir: string
  /** The completion record exactly as it was, to put back if the re-mix is undone. */
  recordText: string
  durationSec: number
  leadInSec: number | null
}

/**
 * Does rendering this episode with `postAudio` need its audio re-mixed with a closing tail?
 *
 * `none` for every request that does not ask for closing music over a tail, for a track that already
 * carries a tail (the merged audio is the truth, 1.4.327), and for a channel whose saved Audio Assembly
 * preset mixes no background music (its tail is silent by design). `preferredFilename` is the track the
 * render is about to lay down; without it the episode's own selection is read.
 */
export async function planClosingTailRemix(opts: {
  slug: string
  code: string
  postAudio: VideoPostAudio | undefined
  preferredFilename?: string | null
}): Promise<ClosingTailVerdict> {
  const code = opts.code.toUpperCase()
  const wanted = postRollSeconds(opts.postAudio)
  if (!(wanted > 0) || !closingMusicWanted(opts.postAudio)) return { action: 'none' }

  const { resolveEpisodePathsByCodeWithSidecar } = await import('./utils.js')
  const paths = await resolveEpisodePathsByCodeWithSidecar(opts.slug, code, 'audio_chapters.json').catch(() => null)
  if (!paths?.merged_audio_dir) return { action: 'none' }
  const dir = paths.merged_audio_dir
  const filename = opts.preferredFilename || await resolveEpisodeMergedAudioFilename(dir, code)
  if (!filename) return { action: 'none' }
  const mergedPath = path.join(dir, filename)
  if (await mergedClosingTailSec(mergedPath, code) > 0) return { action: 'none' }

  const pm = await import('./project-manager.js')
  const { findActivePreset, resolveStepParams } = await import('../routes/pipeline.js')
  const { getEffectiveFormat } = await import('./format-loader.js')
  const config = await pm.getConfig(opts.slug)
  const { preset } = findActivePreset(config, 'audio_merge')
  const params = preset ? resolveStepParams('audio_merge', code, '', preset, await getEffectiveFormat(opts.slug)) : null
  if (!params?.music?.enabled) return { action: 'none' }

  const seconds = Number(wanted.toFixed(1))
  const refuse = (why: string): ClosingTailVerdict => ({
    action: 'refuse',
    reason: `${code}: this episode's audio was mixed before closing music existed; re-mix the audio to add the `
      + `${seconds} s closing, then render again. Story cannot do it by itself here: ${why}`,
  })

  if (!params.music.files?.length) {
    const { pickPoolMusic } = await import('./music-pool.js')
    if (!await pickPoolMusic(opts.slug, code, params.music)) {
      return refuse('the Audio Assembly preset has background music on, but its Music Pool has no track to give.')
    }
  }
  if ((await resolveProjectClosingTail(opts.slug)).seconds + 0.5 < wanted) {
    return refuse(`the saved Video Assembly preset does not ask for ${seconds} s, and Audio Assembly bakes what it saves. Save the Video Assembly preset with that closing first.`)
  }
  let recordText = ''
  let record: any = null
  try {
    recordText = await fs.readFile(mergedAudioCompletionPath(mergedPath, code), 'utf-8')
    record = JSON.parse(recordText)
  } catch { /* no record */ }
  if (record?.output_filename !== filename || !(Number(record?.duration_sec) > 0)) {
    return refuse(`${filename} has no Audio Assembly record, so there is no proof that re-mixing the chapters gives the same narration.`)
  }
  const lead = Number(record.opening?.lead_in_sec)
  return {
    action: 'remix',
    wantedSec: wanted,
    params: { ...params, episode_id: code, write_mode: 'new' },
    track: {
      dir, filename, episodeDir: paths.episode_dir, recordText,
      durationSec: Number(record.duration_sec), leadInSec: Number.isFinite(lead) ? lead : null,
    },
  }
}

/**
 * Run the re-mix a `remix` verdict asked for and return the new track's filename (now the episode's
 * pinned one). Anything that goes wrong, including a re-mix whose narration or lead-in moved, puts the
 * folder back exactly as it was and throws the reason.
 */
export async function remixForClosingTail(
  job: Job,
  slug: string,
  code: string,
  verdict: Extract<ClosingTailVerdict, { action: 'remix' }>,
): Promise<string> {
  const { track, wantedSec } = verdict
  const seconds = Number(wantedSec.toFixed(1))
  const recordPath = mergedAudioCompletionPath(path.join(track.dir, track.filename), code)
  const read = (file: string) => fs.readFile(file, 'utf-8').catch(() => null)
  const sidecars = await Promise.all(MERGE_SIDECARS.map(async name => [name, await read(path.join(track.episodeDir, name))] as const))
  const before = new Set(await fs.readdir(track.dir))
  job.output_lines.push(
    `Closing tail: ${track.filename} was mixed without the ${seconds} s closing music this render asks for — `
    + 're-mixing the audio with it first (a new track beside the original; the narration is not touched).',
  )
  const { generateAudioMerge } = await import('../generators/audio-merge.js')
  try {
    await generateAudioMerge({ ...job, type: 'audio_merge', params: verdict.params, progress: 0, result: undefined } as Job)
    const record = JSON.parse(await fs.readFile(recordPath, 'utf-8'))
    const tail = Number(record.closing_tail_sec) || 0
    const speech = Number(record.duration_sec) - tail
    const lead = Number(record.opening?.lead_in_sec)
    const problems: string[] = []
    if (tail < wantedSec - 0.5) problems.push(`the re-mix carries a ${tail.toFixed(1)} s closing, not ${seconds} s`)
    if (Math.abs(speech - track.durationSec) > MERGED_AUDIO_TOLERANCE_SEC) {
      problems.push(`its narration came out ${speech.toFixed(1)} s instead of ${track.durationSec.toFixed(1)} s`)
    }
    if (track.leadInSec !== null && Math.abs(lead - track.leadInSec) > LEAD_IN_TOLERANCE_SEC) {
      problems.push(`its lead-in came out ${lead.toFixed(2)} s instead of ${track.leadInSec.toFixed(2)} s`)
    }
    if (problems.length) {
      throw new Error(`${code}: the re-mix with the ${seconds} s closing was undone and the original audio kept, because ${problems.join(' and ')}. `
        + 'The narration would no longer match the Scene Plan and subtitles; check the Audio Assembly preset and chapters, then re-mix the audio yourself.')
    }
    await writeSelectedMergedAudio(track.dir, record.output_filename)
    job.output_lines.push(`Closing tail: ${record.output_filename} now carries the ${seconds} s closing and is this episode's selected audio.`)
    return record.output_filename
  } catch (error) {
    for (const file of await fs.readdir(track.dir)) if (!before.has(file)) await fs.rm(path.join(track.dir, file), { force: true })
    await fs.writeFile(recordPath, track.recordText, 'utf-8')
    for (const [name, text] of sidecars) if (text !== null) await fs.writeFile(path.join(track.episodeDir, name), text, 'utf-8')
    throw error
  }
}
