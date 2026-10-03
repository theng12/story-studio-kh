/**
 * Episode Builder → Video Assembly hand-off (SPEC §4–5).
 *
 * Stitches the episode's songs into `<CODE>_merged_audio.m4a` (join style and loudness
 * from the episode settings), writes the tracklist, and re-times `scene_plan.json`
 * from the MEASURED song lengths, so chapters and scene changes land exactly on the
 * stitched song boundaries. Video Assembly then sees an ordinary Scene Plan episode.
 *
 * This job spends nothing and makes no songs: every song already exists in a pool.
 * Plays are NOT recorded here — only once Video Assembly has rendered the episode.
 */

import fs from 'fs/promises'
import { spawn } from 'child_process'
import path from 'path'
import * as jq from '../services/job-queue.js'
import { getAudioDuration, runFfmpeg } from '../lib/ffmpeg-utils.js'
import { getFFmpegPath } from '../services/ffmpeg-manager.js'
import { requireJobCompletion } from '../services/job-completion.js'
import { resolveEpisodePathsByCode, resolveSubfolderNames } from '../services/utils.js'
import { findEpisodeSubfolderDir } from '../services/media-root.js'
import { buildTimeline, renderEpisodeTracklist, songKey, type EpisodeSettings } from '../services/music-episode.js'
import {
  MUSIC_EPISODE_FILENAME,
  loadEpisodeContext,
  readEpisodeDoc,
  writeDerivedScenePlan,
} from '../services/music-episode-store.js'
import { writeJsonAtomic } from '../lib/atomic-store.js'
import type { Job } from '../models/types.js'

export interface StitchInput { path: string; gain_db: number }

/** A song's gain is clamped so one bad measurement cannot blow the mix up. */
export const MAX_GAIN_DB = 20

/**
 * One ffmpeg call: per-song gain to the channel loudness target, the join style,
 * then a limiter at the true-peak ceiling. AAC 256k m4a (owner: AAC for audio).
 *
 * ponytail: the limiter works on sample peaks; true peak can sit a little above
 * it after AAC encoding. The job measures the finished file and logs both figures.
 */
export function buildEpisodeStitchArgs(
  inputs: readonly StitchInput[],
  join: EpisodeSettings['join'],
  joinSeconds: number,
  truePeakDb: number,
  outPath: string,
): string[] {
  const n = inputs.length
  const filters = inputs.map((input, i) =>
    `[${i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${input.gain_db.toFixed(2)}dB[s${i}]`)
  if (n === 1) {
    filters.push('[s0]anull[mix]')
  } else if (join.style === 'crossfade' && joinSeconds > 0) {
    let last = 's0'
    for (let i = 1; i < n; i++) {
      const out = i === n - 1 ? 'mix' : `x${i}`
      filters.push(`[${last}][s${i}]acrossfade=d=${joinSeconds.toFixed(3)}:c1=tri:c2=tri[${out}]`)
      last = out
    }
  } else {
    const parts: string[] = []
    for (let i = 0; i < n; i++) {
      if (join.style === 'silence' && i < n - 1) {
        filters.push(`[s${i}]apad=pad_dur=${join.seconds.toFixed(3)}[p${i}]`)
        parts.push(`[p${i}]`)
      } else {
        parts.push(`[s${i}]`)
      }
    }
    filters.push(`${parts.join('')}concat=n=${n}:v=0:a=1[mix]`)
  }
  const limit = Math.max(0.0625, Math.min(1, 10 ** (truePeakDb / 20)))
  filters.push(`[mix]alimiter=limit=${limit.toFixed(4)}:level=false[out]`)
  return [
    '-hide_banner', '-nostdin', '-y',
    ...inputs.flatMap(input => ['-i', input.path]),
    '-filter_complex', filters.join(';'),
    '-map', '[out]',
    '-c:a', 'aac', '-b:a', '256k', '-ar', '48000',
    '-movflags', '+faststart',
    '-f', 'mp4',
    outPath,
  ]
}

export interface LoudnessMeasurement { lufs: number | null; true_peak_db: number | null }

/** Parse ffmpeg's ebur128 summary. `null` = not measurable, never a made-up zero. */
export function parseEbur128Summary(stderr: string): LoudnessMeasurement {
  const summary = stderr.slice(stderr.lastIndexOf('Summary:'))
  const lufs = summary.match(/I:\s+(-?\d+(?:\.\d+)?) LUFS/)
  const peak = summary.match(/True peak:\s+Peak:\s+(-?\d+(?:\.\d+)?|-inf) dBFS/)
  return {
    lufs: lufs ? Number(lufs[1]) : null,
    true_peak_db: peak && peak[1] !== '-inf' ? Number(peak[1]) : null,
  }
}

/** Integrated loudness + true peak of one file (ffmpeg ebur128). */
export async function measureLoudness(filePath: string): Promise<LoudnessMeasurement> {
  const bin = await getFFmpegPath()
  return new Promise(resolve => {
    const proc = spawn(bin, ['-hide_banner', '-nostdin', '-i', filePath, '-af', 'ebur128=peak=true', '-f', 'null', '-'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    jq.trackChild(proc)
    let stderr = ''
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
      if (stderr.length > 512 * 1024) stderr = stderr.slice(-256 * 1024)
    })
    proc.on('error', () => resolve({ lufs: null, true_peak_db: null }))
    proc.on('close', code => resolve(code === 0 ? parseEbur128Summary(stderr) : { lufs: null, true_peak_db: null }))
  })
}

export async function generateMusicEpisodeBuild(job: Job): Promise<void> {
  const code = String(job.params?.episode_id || job.episode_id || '').toUpperCase()
  if (!code) throw new Error('episode_id is required')
  const slug = job.project_slug
  const doc = await readEpisodeDoc(slug, code)
  if (!doc) throw new Error(`${code} has no Episode Builder plan yet. Open Episode Builder and draw songs first.`)
  if (!doc.songs.length) throw new Error(`${code} has no songs. Draw songs in Episode Builder first.`)

  const ctx = await loadEpisodeContext(slug, code, doc.settings)
  const songs = doc.songs.map(ref => ctx.byKey.get(songKey(ref)))
  const missing = doc.songs.filter((ref, i) => !songs[i] || !songs[i]!.drawable).map(songKey)
  if (missing.length) {
    throw new Error(
      `${missing.length} song(s) in ${code} can no longer be used (removed, rejected or switched off): ${missing.slice(0, 5).join(', ')}. `
      + 'Swap or remove them in Episode Builder, then send again.',
    )
  }
  job.output_lines.push(`${songs.length} song(s), join: ${doc.settings.join.style}${doc.settings.join.style === 'butt' ? '' : ` ${doc.settings.join.seconds} s`}, target ${doc.settings.loudness_lufs} LUFS / ${doc.settings.true_peak_db} dBTP. Nothing is generated or bought.`)

  // ── Measure: lengths always, loudness only where the pool has none ──
  const durations: number[] = []
  const inputs: StitchInput[] = []
  for (const [i, song] of songs.entries()) {
    jq.throwIfPauseRequested(job.job_id)
    if (jq.isCancelled(job.job_id)) throw new Error('Cancelled by user')
    const seconds = await getAudioDuration(song!.path)
    if (!(Number(seconds) > 0)) throw new Error(`Could not read the length of "${song!.title}" (${song!.file}). Check the file in the Song Pool.`)
    durations.push(seconds!)
    let lufs = song!.lufs
    if (typeof lufs !== 'number') {
      lufs = (await measureLoudness(song!.path)).lufs ?? undefined
      job.output_lines.push(typeof lufs === 'number'
        ? `Measured "${song!.title}": ${lufs.toFixed(1)} LUFS (the pool had no measurement).`
        : `"${song!.title}" could not be measured; it is left at its own level.`)
    }
    const gain = typeof lufs === 'number' ? Math.max(-MAX_GAIN_DB, Math.min(MAX_GAIN_DB, doc.settings.loudness_lufs - lufs)) : 0
    inputs.push({ path: song!.path, gain_db: gain })
    job.progress = Math.round(5 + (25 * (i + 1)) / songs.length)
  }
  const timeline = buildTimeline(durations, doc.settings.join)

  // ── Stitch ──
  const paths = await resolveEpisodePathsByCode(slug, code)
  const names = await resolveSubfolderNames(slug, code)
  const mergedDir = await findEpisodeSubfolderDir(slug, code, 'merged_audio', paths.episode_dir, names.merged_audio)
    || paths.merged_audio_dir
  await fs.mkdir(mergedDir, { recursive: true })
  const finalPath = path.join(mergedDir, `${code}_merged_audio.m4a`)
  const tempPath = path.join(mergedDir, `.tmp_${code}_merged_audio.m4a`)
  jq.throwIfPauseRequested(job.job_id)
  if (jq.isCancelled(job.job_id)) throw new Error('Cancelled by user')
  job.output_lines.push('Stitching the songs…')
  await runFfmpeg(buildEpisodeStitchArgs(inputs, doc.settings.join, timeline.join_seconds, doc.settings.true_peak_db, tempPath))
  await fs.rename(tempPath, finalPath)
  job.progress = 80

  // ── Prove it ──
  const stitched = await getAudioDuration(finalPath)
  const drift = Math.abs(Number(stitched) - timeline.total)
  if (!(Number(stitched) > 0) || drift > 1.5) {
    throw new Error(
      `The stitched mix is ${Number(stitched || 0).toFixed(1)} s but the songs add up to ${timeline.total.toFixed(1)} s. `
      + 'Nothing was handed to Video Assembly. Retry; if it repeats, one song file is probably damaged.',
    )
  }
  const loudness = await measureLoudness(finalPath)
  job.output_lines.push(
    `Mix: ${Math.round(timeline.total / 60)} min`
    + (loudness.lufs !== null ? `, ${loudness.lufs.toFixed(1)} LUFS` : ', loudness not measurable')
    + (loudness.true_peak_db !== null ? `, true peak ${loudness.true_peak_db.toFixed(1)} dBTP` : '')
    + '.',
  )

  // ── Tracklist + measured timings ──
  const tracklist = renderEpisodeTracklist(songs.map(song => song!.title), timeline.starts)
  const tracklistPath = path.join(paths.episode_dir, `${code}_tracklist.txt`)
  await fs.writeFile(tracklistPath, `${tracklist}\n`, 'utf8')
  const built = {
    at: new Date().toISOString(),
    merged_audio: finalPath,
    tracklist_path: tracklistPath,
    total_sec: Math.round(timeline.total * 1000) / 1000,
    starts: timeline.starts.map(s => Math.round(s * 1000) / 1000),
    song_keys: doc.songs.map(songKey),
    join_seconds: timeline.join_seconds,
    ...(loudness.lufs !== null ? { lufs: loudness.lufs } : {}),
    ...(loudness.true_peak_db !== null ? { true_peak_db: loudness.true_peak_db } : {}),
  }
  const next = { ...doc, built, updated_at: new Date().toISOString() }
  await writeJsonAtomic(path.join(paths.episode_dir, MUSIC_EPISODE_FILENAME), next)
  const plan = await writeDerivedScenePlan(slug, code, next, ctx.byKey)

  job.output_dir = mergedDir
  job.result = { merged_audio: finalPath, tracklist: tracklistPath, total_sec: built.total_sec, scenes: plan.scenes.length }
  job.progress = 100
  requireJobCompletion(job, {
    label: 'Music episode',
    expected: 1,
    completed: 1,
    retry_hint: 'Retry stitches the same songs again; nothing is generated or bought.',
  })
  job.output_lines.push(`Ready for Video Assembly: ${plan.scenes.length} scene(s), tracklist ${path.basename(tracklistPath)}.`)
}
