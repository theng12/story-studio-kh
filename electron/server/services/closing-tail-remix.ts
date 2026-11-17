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
 *
 * The work is durable. Before the merge starts, a note beside the tracks (`remix-intent.json`) records
 * what to put back; it is removed only once the new track is pinned or the folder is restored. A stop in
 * between (an update, a crash) is picked up by the next re-mix: a complete, valid new track is adopted,
 * anything else is rolled back. The pinned track also records which one it replaced
 * (`closing_tail_remix_of`), so a render accepted with the old track resolves to it on Retry.
 */

import fs from 'fs/promises'
import path from 'path'
import { writeJsonAtomic } from '../lib/atomic-store.js'
import type { Job, VideoPostAudio } from '../models/types.js'
import {
  mergedAudioCompletionPath, mergedBackgroundMusic, mergedClosingOutroSec, mergedClosingTailSec, postRollSeconds,
} from '../lib/closing-tail.js'
import { closingMusicWanted } from '../lib/final-video-check.js'
import { resolveEpisodeMergedAudioFilename, writeSelectedMergedAudio } from '../lib/merged-audio-selection.js'
import { MERGED_AUDIO_TOLERANCE_SEC } from '../lib/scene-plan-timeline.js'
import { introLeadInFrom } from '../lib/intro-lead-in.js'

/** A re-mix may not move the speech's start by more than this (the caption clock follows it). */
const LEAD_IN_TOLERANCE_SEC = 0.1
/** Sidecars a merge rewrites beside the track; put back if the re-mix is undone. */
const MERGE_SIDECARS = ['audio_chapters.json', 'audio_sentences.json']

/**
 * The mix settings an outro re-mix must copy from the ORIGINAL merge. Everything else — chapters,
 * episode paths, the closing itself — is resolved for this episode. No secret or provider field is
 * among them: a merge is local FFmpeg work.
 */
const ORIGINAL_MIX_KEYS = [
  'intro', 'music', 'background_noise', 'ambient_tracks', 'effects_tracks', 'background_voice_tracks',
  'narration_volume', 'normalize_volume', 'gap_duration', 'chunk_silence_sec',
] as const

/** A copy of just the mix settings in `source`; null when it carries none (never a guessed default). */
export function originalMixSettings(source: Record<string, any> | null | undefined): Record<string, any> | null {
  if (!source || typeof source !== 'object') return null
  const mix: Record<string, any> = {}
  for (const key of ORIGINAL_MIX_KEYS) {
    if (source[key] !== undefined) mix[key] = JSON.parse(JSON.stringify(source[key]))
  }
  return Object.keys(mix).length ? mix : null
}

/**
 * The original bed, pinned for an outro-only re-mix: `source: 'manual'` with the EXACT recorded file
 * list, so the generator's Music Pool step cannot take a new pick. Null when the original mix names
 * no enabled music files — an enabled bed without them is missing evidence, never a reason to guess
 * (AGENTS §6). Other mix settings are carried through unchanged.
 */
export function pinOriginalOutroMix(mix: Record<string, any> | null | undefined): Record<string, any> | null {
  if (!mix || typeof mix !== 'object') return null
  const music = mix.music
  const files = music?.files
  if (music?.enabled !== true || !Array.isArray(files) || files.length === 0) return null
  if (files.some((file: any) => typeof file !== 'string' || !file.trim())) return null
  return { ...mix, music: { ...music, source: 'manual', files: [...files] } }
}

export type OriginalMixEvidence =
  | { action: 'mix'; mix: Record<string, any>; source: 'record' | 'job' }
  | { action: 'none' }
  | { action: 'refuse'; reason: string }

/**
 * The mix that wrote `mergedPath`, for an outro re-mix. The completion record's own snapshot is
 * proof; a merge made before that snapshot existed is proven by exactly ONE done Audio Assembly job
 * of this episode whose output line names this exact file and whose params carry mix settings.
 * Anything else is refused before any write: a second matching job, a job that names another file,
 * no job at all, or a record that does not say whether it had a bed (AGENTS §6 — unknown is never
 * "none"). `background_music: false` is the original's answer: the outro stays silent. A bed
 * recorded as present must name an enabled music track with exact files — a mix carrying only
 * levels is not proof of what played.
 */
export function selectOriginalMix(opts: {
  record: any
  jobs: ReadonlyArray<Pick<Job, 'status' | 'episode_id' | 'output_lines' | 'params'>>
  code: string
  mergedPath: string
}): OriginalMixEvidence {
  const { record, code, mergedPath } = opts
  if (record?.background_music === false) return { action: 'none' }
  if (record?.background_music !== true) {
    return {
      action: 'refuse',
      reason: 'the merge record does not say whether this audio carries a music bed, so the original mix cannot be proven',
    }
  }
  // A snapshot that exists is the evidence; an incomplete one is refused, never replaced by a job.
  if (record?.original_mix && typeof record.original_mix === 'object') {
    const recorded = pinOriginalOutroMix(originalMixSettings(record.original_mix))
    if (recorded) return { action: 'mix', mix: recorded, source: 'record' }
    return {
      action: 'refuse',
      reason: 'the merge record names no enabled background music files, so the outro cannot be re-made from it without guessing',
    }
  }
  const marker = `Output: ${mergedPath}`
  const matches = opts.jobs.filter(job =>
    job.status === 'done'
    && String(job.episode_id || '').toUpperCase() === code
    && Array.isArray(job.output_lines) && job.output_lines.includes(marker))
  if (matches.length > 1) {
    return {
      action: 'refuse',
      reason: `${matches.length} completed Audio Assembly jobs claim to have written ${path.basename(mergedPath)}, so the original mix cannot be told apart`,
    }
  }
  const mix = matches.length === 1 ? pinOriginalOutroMix(originalMixSettings(matches[0].params as any)) : null
  if (mix) return { action: 'mix', mix, source: 'job' }
  return {
    action: 'refuse',
    reason: matches.length === 1
      ? `the completed Audio Assembly job that wrote ${path.basename(mergedPath)} records no enabled background music files`
      : `no completed Audio Assembly job records the mix that wrote ${path.basename(mergedPath)}`,
  }
}

/**
 * The baked tail an outro re-mix asks for: the ORIGINAL held tail (the audio is the truth), plus
 * the outro. A track with no tail keeps the caller's post-roll — there is nothing to preserve.
 */
export function closingTailRemixSpan(opts: {
  currentTailSec: number
  currentOutroSec: number
  postRollSec: number
  outroSec: number
}): { heldSec: number; totalSec: number } {
  const heldSec = opts.outroSec > 0 && opts.currentTailSec > 0
    ? Math.max(0, opts.currentTailSec - opts.currentOutroSec)
    : Math.max(0, opts.postRollSec)
  return { heldSec, totalSec: heldSec + Math.max(0, opts.outroSec) }
}


export type ClosingTailVerdict =
  | { action: 'none' }
  | { action: 'refuse'; reason: string }
  /** This render was accepted with a track that has since been re-mixed: use the re-mixed one. */
  | { action: 'use'; filename: string }
  /** A re-mix was stopped part-way: the render finishes or undoes it (`recoverPendingRemix`) before anything else. */
  | { action: 'recover'; wantedSec: number; wantedOutroSec: number; track: MergedTrack }
  | { action: 'remix'; wantedSec: number; wantedOutroSec: number; params: Record<string, any>; track: MergedTrack; settings: string[] }

interface MergedTrack {
  dir: string
  code: string
  filename: string
  episodeDir: string
  /** The completion record exactly as it was, to put back if the re-mix is undone. */
  recordText: string
  durationSec: number
  /** The closing tail already in this track (seconds of music after the narration). */
  tailSec: number
  leadInSec: number | null
}

/** What a started re-mix writes down first, so a stop at any point can be finished or undone. */
interface RemixIntent {
  base_filename: string
  /** The base track's completion record, which the re-mix overwrites. */
  base_record_text: string
  episode_dir: string
  /** Files in the folder before the merge started. */
  before: string[]
  /** `audio_chapters.json` / `audio_sentences.json` as they were (null = absent). */
  sidecars: Record<string, string | null>
}

const intentPath = (dir: string, code: string) => path.join(dir, `${code}_merged_audio.remix-intent.json`)

async function readIntent(dir: string, code: string): Promise<RemixIntent | null> {
  try {
    const intent = JSON.parse(await fs.readFile(intentPath(dir, code), 'utf-8'))
    return typeof intent?.base_filename === 'string' && typeof intent.base_record_text === 'string' ? intent : null
  } catch { return null }
}

const readText = (file: string) => fs.readFile(file, 'utf-8').catch(() => null)

/**
 * What precedes the narration in an existing merge, measured from the file's own recorded duration and
 * the chapter sidecar. The record supplies the intro's identity; its number can be partial or stale, so
 * the audio is the authority (AGENTS §6: a measurement that is not there is never read as 0). Null when
 * neither the measurement nor a complete record can say.
 */
async function measuredLeadIn(episodeDir: string, record: any): Promise<number | null> {
  const chapters = JSON.parse(await readText(path.join(episodeDir, 'audio_chapters.json')) ?? 'null')
  const sections = Array.isArray(chapters?.sections) ? chapters.sections : []
  const gap = typeof chapters?.gap_duration_s === 'number' ? chapters.gap_duration_s : 0
  const duration = Number(record?.duration_sec) - Math.max(0, Number(record?.closing_tail_sec) || 0)
  const measured = introLeadInFrom(duration, sections, gap)
  if (measured.status === 'measured') return measured.seconds
  const recorded = Number(record?.opening?.lead_in_sec)
  return Number.isFinite(recorded) ? recorded : null
}

/** Both timings must be real numbers; `{}` or a partial opening is measured, never read as 0 or left to the preset. */
function recordedOpening(record: any): boolean {
  const o = record?.opening
  return !!o && typeof o === 'object' && Number.isFinite(o.lead_in_sec) && Number.isFinite(o.music_lead_in_sec)
}

/** The recorded gap, intro and lead-in become the re-mix's own settings; the log says which is which. */
function applyRecordedSettings(
  params: Record<string, any>,
  record: any,
  chapters: any,
  settings: string[],
): string | null {
  const gap = Number(chapters?.gap_duration_s)
  if (chapters?.gap_duration_s != null && Number.isFinite(gap) && gap >= 0) {
    params.gap_duration = gap
    settings.push(`gap between chapters: ${gap} s — recorded with the original merge`)
    const chunk = Number(chapters?.chunk_silence_sec)
    if (Number.isFinite(chunk) && chunk >= 0) params.chunk_silence_sec = chunk
  } else {
    settings.push(`gap between chapters: ${params.gap_duration ?? 0} s — not recorded, the current Audio Assembly preset's`)
  }
  const opening = record?.opening
  if (!recordedOpening(record)) {
    settings.push('opening timing: not recorded, measuring it from the original audio')
    return null
  }
  const intro = opening.intro
  if (!intro) {
    params.intro = { ...(params.intro || {}), enabled: false }
    settings.push('intro: none — recorded with the original merge')
  } else {
    const current = String(params.intro?.file || '')
    if (!params.intro?.enabled || path.basename(current) !== intro.filename) {
      return `the original merge opened with the intro ${intro.filename}, which the saved Audio Assembly preset no longer names`
    }
    params.intro = { ...params.intro, gap_after: Number(intro.gap_after_sec) || 0 }
    settings.push(`intro: ${intro.filename}, ${Number(intro.gap_after_sec) || 0} s gap — recorded with the original merge`)
  }
  const lead = Number(opening.music_lead_in_sec)
  if (Number.isFinite(lead) && params.music) {
    params.music = { ...params.music, lead_in_enabled: lead > 0, lead_in_seconds: lead }
    settings.push(`lead-in: ${lead} s of music before the narration — recorded with the original merge`)
  }
  return null
}

/** The re-mix of `base` that is the track now, or null. Read from the completion record the re-mix pinned. */
async function remixSuccessor(
  dir: string, code: string, base: string, wantedSec: number, wantedOutroSec: number,
): Promise<string | null> {
  try {
    const record = JSON.parse(await fs.readFile(mergedAudioCompletionPath(path.join(dir, base), code), 'utf-8'))
    if (record?.closing_tail_remix_of !== base || record.output_filename === base) return null
    if (!(Number(record.closing_tail_sec) >= wantedSec - 0.5)) return null
    // The outro span must match too: a successor baked for a different (or no) outro is not this render's.
    if (Math.abs((Number(record.closing_outro_sec) || 0) - wantedOutroSec) > 0.5) return null
    return (await fs.stat(path.join(dir, record.output_filename)).catch(() => null)) ? record.output_filename : null
  } catch { return null }
}

/**
 * Does rendering this episode with `postAudio` need its audio re-mixed with a closing tail?
 *
 * `none` for every request that does not ask for closing music over a tail, for a track that already
 * carries the tail AND the outro music this render asks for (the merged audio is the truth, 1.4.327),
 * and for a channel whose saved Audio Assembly preset mixes no background music (its tail is silent by
 * design). `outroSec` is the appended outro's length: when the track's closing tail is shorter than
 * `postRoll + outroSec`, or was baked for a different outro, the music would stop before the true end
 * and the re-mix extends it. With no active Audio Assembly preset it refuses only when the merge
 * recorded a bed (`background_music: true`) it cannot re-make; a merge that recorded none, or an older
 * record that says nothing, stays `none`. The closing re-mixed is the one `postAudio` (this render's
 * own) asks for, whatever else is saved. `preferredFilename` is the track the render is about to lay
 * down; without it the episode's own selection is read. `use` when that track was already re-mixed and
 * the re-mix pinned. An interrupted re-mix reads as `recover` (the render finishes or undoes it
 * first), never as `use`, `remix` or a refusal.
 */
export async function planClosingTailRemix(opts: {
  slug: string
  code: string
  postAudio: VideoPostAudio | undefined
  preferredFilename?: string | null
  /** Seconds of the appended outro the same bed must play under (0 = no outro). */
  outroSec?: number
}): Promise<ClosingTailVerdict> {
  const code = opts.code.toUpperCase()
  const postRoll = postRollSeconds(opts.postAudio)
  if (!(postRoll > 0) || !closingMusicWanted(opts.postAudio)) return { action: 'none' }
  const outroSec = Math.max(0, Number(opts.outroSec) || 0)
  const wanted = postRoll + outroSec

  const { resolveEpisodePathsByCodeWithSidecar } = await import('./utils.js')
  const paths = await resolveEpisodePathsByCodeWithSidecar(opts.slug, code, 'audio_chapters.json').catch(() => null)
  if (!paths?.merged_audio_dir) return { action: 'none' }
  const dir = paths.merged_audio_dir
  const intent = await readIntent(dir, code)
  // An interrupted-work note comes first: neither `use` nor a new re-mix may be answered while it lingers,
  // or the render would lay down a track the folder's pin and the note still disagree about.
  if (intent) {
    let base: any = null
    try { base = JSON.parse(intent.base_record_text) } catch { /* torn: recovery rolls it back */ }
    return {
      action: 'recover',
      wantedSec: wanted,
      wantedOutroSec: outroSec,
      track: {
        dir, code, filename: intent.base_filename, episodeDir: intent.episode_dir, recordText: intent.base_record_text,
        durationSec: Number(base?.duration_sec) || 0,
        tailSec: Math.max(0, Number(base?.closing_tail_sec) || 0),
        leadInSec: await measuredLeadIn(intent.episode_dir, base),
      },
    }
  }
  const filename = opts.preferredFilename || await resolveEpisodeMergedAudioFilename(dir, code)
  if (!filename) return { action: 'none' }
  const mergedPath = path.join(dir, filename)
  const currentTailSec = await mergedClosingTailSec(mergedPath, code)
  const currentOutroSec = await mergedClosingOutroSec(mergedPath, code)
  // The tail already baked is the truth: an outro extends the ORIGINAL held span, never a preset's
  // newer number. A track with no tail keeps the caller's post-roll.
  const span = closingTailRemixSpan({ currentTailSec, currentOutroSec, postRollSec: postRoll, outroSec })
  const remixWanted = span.totalSec
  // The existing track is the truth. It already carries what this render needs only when the music
  // covers the held tail AND the outro span it was baked for; a tail from before this render's outro
  // (or from a different outro length) would stop short of the true end.
  if (currentTailSec >= remixWanted - 0.5 && Math.abs(currentOutroSec - outroSec) <= 0.5) return { action: 'none' }
  const successor = await remixSuccessor(dir, code, filename, remixWanted, outroSec)
  if (successor) return { action: 'use', filename: successor }

  let originalRecordText = ''
  let originalRecord: any = null
  try {
    originalRecordText = await fs.readFile(mergedAudioCompletionPath(mergedPath, code), 'utf-8')
    originalRecord = JSON.parse(originalRecordText)
  } catch { /* no record */ }

  if (outroSec > 0) {
    // The outro plays under the ORIGINAL mix, so the original mix is the only evidence accepted:
    // today's preset may name another track, another level or another bed entirely.
    if (originalRecord?.output_filename !== filename || !(Number(originalRecord?.duration_sec) > 0)) {
      return {
        action: 'refuse',
        reason: `${code}: ${filename} has no Audio Assembly record, so the original mix for the outro cannot be proven; re-run Audio Assembly, then render again.`,
      }
    }
    const { getJobs } = await import('./job-queue.js')
    const jobs = originalMixSettings(originalRecord?.original_mix) ? [] : await getJobs(opts.slug, { type: 'audio_merge' })
    const evidence = selectOriginalMix({ record: originalRecord, jobs, code, mergedPath })
    // The original merge recorded no bed: the outro stays silent, whatever the current preset says.
    if (evidence.action === 'none') return { action: 'none' }
    if (evidence.action === 'refuse') {
      return {
        action: 'refuse',
        reason: `${code}: this render's outro needs the original audio mix, but ${evidence.reason}; re-run Audio Assembly, then render again.`,
      }
    }
    const leadInSec = await measuredLeadIn(paths.episode_dir, originalRecord)
    if (leadInSec === null) {
      return {
        action: 'refuse',
        reason: `${code}: the original opening timing cannot be measured for the outro re-mix; re-run Audio Assembly, then render again.`,
      }
    }
    const outroPostAudio: VideoPostAudio = {
      ...opts.postAudio!, behavior: 'hold-last-scene', tail_seconds: span.heldSec,
    }
    return {
      action: 'remix',
      wantedSec: remixWanted,
      wantedOutroSec: outroSec,
      settings: [
        'mix settings: copied from the original merge record or its completed Audio Assembly job: the original bed, levels and narration, not the current preset',
        `held tail: ${Number(span.heldSec.toFixed(1))} s: the original audio own tail, plus ${Number(outroSec.toFixed(1))} s under the outro`,
      ],
      params: {
        ...evidence.mix, episode_id: code, write_mode: 'new',
        closing_tail_sec_cap: span.heldSec, closing_post_audio: outroPostAudio, closing_outro_sec: outroSec,
      },
      track: {
        dir, code, filename, episodeDir: paths.episode_dir, recordText: originalRecordText,
        durationSec: Number(originalRecord.duration_sec), tailSec: currentTailSec, leadInSec,
      },
    }
  }

  const pm = await import('./project-manager.js')
  const { findActivePreset, resolveStepParams } = await import('../routes/pipeline.js')
  const { getEffectiveFormat } = await import('./format-loader.js')
  const config = await pm.getConfig(opts.slug)
  const { preset } = findActivePreset(config, 'audio_merge')
  const params = preset ? resolveStepParams('audio_merge', code, '', preset, await getEffectiveFormat(opts.slug)) : null
  const seconds = Number(wanted.toFixed(1))
  // No active Audio Assembly preset: there is nothing to re-make the mix from. Refuse only where the
  // merge RECORDED a bed — a render would otherwise draw a silent padded tail over music the owner
  // mixed (Wonder in Ink WI0001, 2026-10-23). A merge that recorded none, and an older record that says
  // nothing either way, keep the behaviour they always had: the final check still looks at the tail.
  if (!preset) {
    if (await mergedBackgroundMusic(mergedPath, code) !== true) return { action: 'none' }
    return {
      action: 'refuse',
      reason: `${code}: this render asks for a ${seconds} s closing with music, but this episode's audio was mixed with background music `
        + 'and without that closing, and the channel has no active Audio Assembly preset to re-mix it from. '
        + `Save an Audio Assembly preset with the music and make it the active one (the audio is then re-mixed with the ${seconds} s closing at render), `
        + `or re-run Audio Assembly now that the ${seconds} s closing is set in Video Assembly, then render again. `
        + 'If the ending should stay silent, re-run Audio Assembly with background music turned off.',
    }
  }
  // A saved preset with music off is the explicit answer: the silent tail is designed.
  if (!params?.music?.enabled) return { action: 'none' }

  const refuse = (why: string): ClosingTailVerdict => ({
    action: 'refuse',
    reason: `${code}: this episode's audio was mixed before closing music existed; re-mix the audio to add the `
      + `${seconds} s closing, then render again. Story cannot do it by itself here: ${why}`,
  })

  // The music: the episode's own recorded track when the preset draws from the Music Pool, so the
  // re-mix never takes a new pick from it.
  const settings: string[] = []
  const poolSource = (params.music.source ?? (params.music.files?.length ? 'manual' : 'pool')) === 'pool'
  const { episodeOwnTrack, musicWithTrack, pickPoolMusic } = await import('./music-pool.js')
  const own = poolSource ? await episodeOwnTrack(opts.slug, code) : null
  if (own) {
    params.music = { ...musicWithTrack(params.music, own), source: 'manual' }
    settings.push(`music: ${own.filename} — recorded as this episode's track`)
  } else if (!params.music.files?.length) {
    if (!await pickPoolMusic(opts.slug, code, params.music)) {
      return refuse('the Audio Assembly preset has background music on, but its Music Pool has no track to give.')
    }
    settings.push('music: the Music Pool\'s next pick — no track is recorded for this episode, the current Audio Assembly preset\'s')
  } else {
    settings.push(`music: ${path.basename(params.music.files[0])} — not recorded, the current Audio Assembly preset\'s`)
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
  const chapters = JSON.parse(await readText(path.join(paths.episode_dir, 'audio_chapters.json')) ?? 'null')
  const conflict = applyRecordedSettings(params, record, chapters, settings)
  if (conflict) return refuse(conflict)
  // The original FILE is the authority on what precedes the narration (1.4.327: the merged audio is the
  // truth). The record supplies the intro's identity; its lead-in can be partial or stale, so the head is
  // measured from the file's duration and the chapter sidecar and that one number is the baseline.
  const leadInSec = await measuredLeadIn(paths.episode_dir, record)
  if (leadInSec === null) {
    return refuse('the original opening timing cannot be measured: neither its record nor the chapter-duration sidecar says what precedes the narration.')
  }
  const recordedLead = Number(record.opening?.lead_in_sec)
  // Keep the recorded intro only when it accounts for the measured head; otherwise the record's identity
  // does not describe this file, so the measured head becomes the music lead-in and no intro is added.
  if (!recordedOpening(record) || Math.abs(leadInSec - recordedLead) > LEAD_IN_TOLERANCE_SEC) {
    params.intro = { ...(params.intro || {}), enabled: false }
    params.music = { ...params.music, lead_in_enabled: leadInSec > 0, lead_in_seconds: leadInSec }
    settings.push(recordedOpening(record)
      ? `opening timing: the record says ${recordedLead.toFixed(2)} s but the original audio measures ${leadInSec.toFixed(2)} s — the audio is authoritative`
      : `intro identity: not recorded; lead-in: ${leadInSec} s — measured from the original audio`)
  }
  settings.push('voice level, music balance and fades, loudness target: not recorded, so the current Audio Assembly and Video Assembly presets apply')
  return {
    action: 'remix',
    wantedSec: wanted,
    wantedOutroSec: outroSec,
    settings,
    params: {
      ...params, episode_id: code, write_mode: 'new',
      closing_tail_sec_cap: wanted, closing_post_audio: opts.postAudio, closing_outro_sec: outroSec,
    },
    track: {
      dir, code, filename, episodeDir: paths.episode_dir, recordText,
      durationSec: Number(record.duration_sec), tailSec: currentTailSec, leadInSec,
    },
  }
}

/** What is wrong with a re-mixed track's record, in words; empty when it is the same narration with the tail. */
export function remixProblems(record: any, track: MergedTrack, wantedSec: number, wantedOutroSec = 0): string[] {
  const seconds = Number(wantedSec.toFixed(1))
  const outroSeconds = Number(wantedOutroSec.toFixed(1))
  const tail = record.closing_tail_sec
  const outro = record.closing_outro_sec
  const duration = record.duration_sec
  const lead = record.opening?.lead_in_sec
  const problems: string[] = []
  // A field the record does not carry is missing evidence, never a pass: `NaN` made every comparison below false (AGENTS §6).
  if (!Number.isFinite(tail)) problems.push('its record does not say how long its closing is')
  else if (tail < wantedSec - 0.5) problems.push(`the re-mix carries a ${tail.toFixed(1)} s closing, not ${seconds} s`)
  if (wantedOutroSec > 0) {
    if (!Number.isFinite(outro)) problems.push('its record does not say how much of that closing plays under the outro')
    else if (outro < wantedOutroSec - 0.5) problems.push(`the re-mix carries ${outro.toFixed(1)} s of closing under the outro, not ${outroSeconds} s`)
  }
  // `duration_sec` is the whole file: narration + its own lead-in + the closing tail. Compare narration to
  // narration, subtracting each file's own head and tail exactly once, so a head that moved is reported as a
  // lead-in move below instead of masquerading as narration drift.
  const narration = Number.isFinite(duration) && Number.isFinite(tail) && Number.isFinite(lead)
    ? duration - tail - lead
    : null
  const originalNarration = track.durationSec - (Number(track.tailSec) || 0) - (track.leadInSec ?? 0)
  if (narration === null) problems.push('its record does not say how long its narration is')
  else if (track.leadInSec === null) {
    problems.push('the original record does not say how long its lead-in is, so its narration cannot be compared')
  } else if (Math.abs(narration - originalNarration) > MERGED_AUDIO_TOLERANCE_SEC) {
    problems.push(`its narration came out ${narration.toFixed(1)} s instead of ${originalNarration.toFixed(1)} s`)
  }
  if (track.leadInSec !== null) {
    if (!Number.isFinite(lead)) problems.push('its record does not say how long its lead-in is')
    else if (Math.abs(lead - track.leadInSec) > LEAD_IN_TOLERANCE_SEC) {
      problems.push(`its lead-in came out ${lead.toFixed(2)} s instead of ${track.leadInSec.toFixed(2)} s`)
    }
  }
  return problems
}

/** Write the note that lets a stopped re-mix be finished or undone. Call it before the merge starts. */
export async function beginClosingTailRemix(verdict: Extract<ClosingTailVerdict, { action: 'remix' }>): Promise<RemixIntent> {
  const { track } = verdict
  const { code } = track
  const sidecars: RemixIntent['sidecars'] = {}
  for (const name of MERGE_SIDECARS) sidecars[name] = await readText(path.join(track.episodeDir, name))
  const intent: RemixIntent = {
    base_filename: track.filename, base_record_text: track.recordText, episode_dir: track.episodeDir,
    before: await fs.readdir(track.dir), sidecars,
  }
  await writeJsonAtomic(intentPath(track.dir, code), intent, { compact: true })
  return intent
}

/** Put the folder back as the note says it was, then drop the note. */
async function rollbackRemix(dir: string, code: string, intent: RemixIntent): Promise<void> {
  const keep = new Set([...intent.before, path.basename(intentPath(dir, code))])
  for (const file of await fs.readdir(dir)) if (!keep.has(file)) await fs.rm(path.join(dir, file), { force: true })
  await fs.writeFile(mergedAudioCompletionPath(path.join(dir, intent.base_filename), code), intent.base_record_text, 'utf-8')
  for (const [name, text] of Object.entries(intent.sidecars)) {
    if (text !== null) await fs.writeFile(path.join(intent.episode_dir, name), text, 'utf-8')
  }
  await fs.rm(intentPath(dir, code), { force: true })
}

/** The new track is good: record what it replaced, pin it, and drop the note. In that order. */
async function pinRemix(dir: string, code: string, recordPath: string, record: any, base: string): Promise<string> {
  await fs.writeFile(recordPath, JSON.stringify({ ...record, closing_tail_remix_of: base }, null, 2), 'utf-8')
  await writeSelectedMergedAudio(dir, record.output_filename)
  await fs.rm(intentPath(dir, code), { force: true })
  return record.output_filename
}

/**
 * Finish or undo a re-mix that was stopped part-way. A new track whose record is complete and passes
 * the same checks as a live re-mix is adopted and pinned; anything else is rolled back.
 */
async function recoverInterruptedRemix(
  track: MergedTrack,
  code: string,
  wantedSec: number,
  wantedOutroSec: number,
  job: Job,
): Promise<string | null> {
  const intent = await readIntent(track.dir, code)
  if (!intent) return null
  const recordPath = mergedAudioCompletionPath(path.join(track.dir, track.filename), code)
  let record: any = null
  try { record = JSON.parse(await fs.readFile(recordPath, 'utf-8')) } catch { /* torn or absent */ }
  const name = record?.output_filename
  // The MP3 and its record are the whole proof (1.4.407: a merge writes no master beside them).
  let adoptable = typeof name === 'string' && name !== intent.base_filename
  if (adoptable) {
    const mp3 = await fs.stat(path.join(track.dir, name)).catch(() => null)
    adoptable = !!mp3 && mp3.size > 0 && mp3.size === Number(record.bytes)
      && remixProblems(record, track, wantedSec, wantedOutroSec).length === 0
  }
  if (adoptable) {
    await pinRemix(track.dir, code, recordPath, record, intent.base_filename)
    job.output_lines.push(`Closing tail: an earlier re-mix of ${intent.base_filename} was interrupted after ${name} was complete; it is checked and now this episode's selected audio.`)
    return name
  }
  await rollbackRemix(track.dir, code, intent)
  job.output_lines.push(`Closing tail: an earlier re-mix of ${intent.base_filename} was interrupted before it was complete; its unfinished files were removed and the audio is re-mixed from the start.`)
  return null
}

/**
 * Finish or undo the interrupted re-mix a `recover` verdict named. The new track's filename when it was
 * adopted and pinned; null when it was rolled back (plan again: the folder is as it was before).
 */
export function recoverPendingRemix(
  job: Job,
  code: string,
  verdict: Extract<ClosingTailVerdict, { action: 'recover' }>,
): Promise<string | null> {
  return recoverInterruptedRemix(verdict.track, code, verdict.wantedSec, verdict.wantedOutroSec, job)
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
  const { track, wantedSec, wantedOutroSec } = verdict
  const seconds = Number(wantedSec.toFixed(1))
  const outroSeconds = Number(wantedOutroSec.toFixed(1))
  const recovered = await recoverInterruptedRemix(track, code, wantedSec, wantedOutroSec, job)
  if (recovered) return recovered
  const recordPath = mergedAudioCompletionPath(path.join(track.dir, track.filename), code)
  const intent = await beginClosingTailRemix(verdict)
  job.output_lines.push(
    `Closing tail: ${track.filename} does not carry the full ${seconds} s closing music this render asks for`
    + (outroSeconds > 0 ? ` (${outroSeconds} s of it under the outro)` : '')
    + ' — re-mixing the audio with it first (a new track beside the original; the narration is not touched).',
    `Closing tail re-mix settings — ${verdict.settings.join('; ')}.`,
  )
  const { generateAudioMerge } = await import('../generators/audio-merge.js')
  try {
    await generateAudioMerge({ ...job, type: 'audio_merge', params: verdict.params, progress: 0, result: undefined } as Job)
    const record = JSON.parse(await fs.readFile(recordPath, 'utf-8'))
    const problems = remixProblems(record, track, wantedSec, wantedOutroSec)
    if (problems.length) {
      throw new Error(`${code}: the re-mix with the ${seconds} s closing was undone and the original audio kept, because ${problems.join(' and ')}. `
        + 'The narration would no longer match the Scene Plan and subtitles; check the Audio Assembly preset and chapters, then re-mix the audio yourself.')
    }
    const filename = await pinRemix(track.dir, code, recordPath, record, track.filename)
    job.output_lines.push(`Closing tail: ${filename} now carries the ${seconds} s closing`
      + (outroSeconds > 0 ? ` (${outroSeconds} s of it under the outro, fading at the true end)` : '')
      + ' and is this episode\'s selected audio.')
    return filename
  } catch (error) {
    await rollbackRemix(track.dir, code, intent)
    throw error
  }
}
