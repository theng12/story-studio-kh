/**
 * Audio checks at save (SPEC §2.2 rule 5): measure duration and integrated loudness (ebur128),
 * trim leading/trailing silence, add a 2 s fade-out when a song ends abruptly, and flag a long
 * silence inside a song. One analysis pass; a re-encode only when something is trimmed or faded.
 *
 * Loudness is MEASURED and stored, never applied here — levelling to the channel target happens
 * once, at stitch time (Episode Builder), so a pool song is never re-encoded twice.
 */
import fs from 'fs/promises'
import path from 'path'
import { runFfmpeg } from '../lib/ffmpeg-utils.js'

const SILENCE_DB = -50
const SILENCE_MIN_S = 0.5
const FADE_S = 2
/** Shorter than this at the very end and the song is cut off rather than decaying. */
const ABRUPT_TAIL_S = 0.3

export interface Analysis {
  duration_s: number
  lufs: number | null
  true_peak_db: number | null
  silences: Array<{ start: number; end: number }>
}

export function parseAnalysis(stderr: string, fallbackDuration = 0): Analysis {
  const silences: Analysis['silences'] = []
  let open: number | null = null
  for (const line of stderr.split('\n')) {
    const s = /silence_start:\s*(-?[\d.]+)/.exec(line)
    if (s) { open = Math.max(0, Number(s[1])); continue }
    const e = /silence_end:\s*([\d.]+)/.exec(line)
    if (e && open !== null) { silences.push({ start: open, end: Number(e[1]) }); open = null }
  }
  const time = [...stderr.matchAll(/time=(\d+):(\d+):([\d.]+)/g)].pop()
  const duration = time ? Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3]) : fallbackDuration
  if (open !== null) silences.push({ start: open, end: duration })
  const summary = stderr.slice(stderr.lastIndexOf('Summary:'))
  const i = /I:\s*(-?[\d.]+|-inf)\s*LUFS/.exec(summary)
  const p = /Peak:\s*(-?[\d.]+|-inf)\s*dBFS/.exec(summary)
  const num = (m: RegExpExecArray | null) => (m && m[1] !== '-inf' ? Number(m[1]) : null)
  return { duration_s: duration, lufs: num(i), true_peak_db: num(p), silences }
}

export async function analyse(file: string): Promise<Analysis> {
  const err = await runFfmpeg(['-hide_banner', '-nostats', '-i', file, '-vn',
    '-af', `silencedetect=n=${SILENCE_DB}dB:d=${SILENCE_MIN_S},ebur128=peak=true:framelog=verbose`, '-f', 'null', '-'])
  // -nostats suppresses the progress line; the final "time=" line is still printed at the end.
  return parseAnalysis(err)
}

export interface TrimPlan { lead_s: number; tail_s: number; fade: boolean; gap: { length: number; at: number } | null }

/** What to cut, whether to fade, and the longest inner silence. Pure. */
export function planTrim(a: Analysis): TrimPlan {
  const lead = a.silences.find(s => s.start <= 0.05)
  const tail = a.silences.find(s => s.end >= a.duration_s - 0.05 && s.start > 0.05)
  const inner = a.silences.filter(s => s !== lead && s !== tail)
  const longest = inner.reduce<{ length: number; at: number } | null>((m, s) => (!m || s.end - s.start > m.length ? { length: s.end - s.start, at: s.start } : m), null)
  const lead_s = lead ? lead.end : 0
  const tail_s = tail ? a.duration_s - tail.start : 0
  // (Almost) all silence: cut nothing, flag the whole thing so the owner hears it before it is drawn.
  if (lead_s + tail_s >= a.duration_s - 1) return { lead_s: 0, tail_s: 0, fade: false, gap: { length: a.duration_s, at: 0 } }
  return { lead_s, tail_s, fade: tail_s < ABRUPT_TAIL_S, gap: longest }
}

export interface SongCheck {
  duration_s: number
  lufs: number | null
  true_peak_db: number | null
  trimmed: { lead_s: number; tail_s: number; faded: boolean } | null
  gap: { length: number; at: number } | null
}

/**
 * Check one saved song in place. With `trim` on, silence at either end is cut and an abrupt
 * ending gets a 2 s fade (re-encoded as AAC 256k m4a, written atomically over the original).
 */
export async function checkSong(file: string, opts: { trim: boolean }): Promise<SongCheck> {
  const first = await analyse(file)
  const plan = planTrim(first)
  const needs = opts.trim && /\.m4a$/i.test(file) && (plan.lead_s > 0.05 || plan.tail_s > 0.05 || plan.fade)
  if (!needs) {
    return { duration_s: first.duration_s, lufs: first.lufs, true_peak_db: first.true_peak_db, trimmed: null, gap: plan.gap }
  }
  const end = first.duration_s - plan.tail_s
  const length = Math.max(1, end - plan.lead_s)
  const filters = plan.fade ? ['-af', `afade=t=out:st=${Math.max(0, length - FADE_S).toFixed(3)}:d=${FADE_S}`] : []
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.trim-${process.pid}.m4a`)
  try {
    await runFfmpeg(['-y', '-ss', plan.lead_s.toFixed(3), '-i', file, '-t', length.toFixed(3), '-vn', '-map_metadata', '-1',
      ...filters, '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', '-f', 'ipod', tmp])
    await fs.rename(tmp, file)
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {})
  }
  const after = await analyse(file)
  return {
    duration_s: after.duration_s,
    lufs: after.lufs,
    true_peak_db: after.true_peak_db,
    trimmed: { lead_s: plan.lead_s, tail_s: plan.tail_s, faded: plan.fade },
    gap: plan.gap ? { length: plan.gap.length, at: Math.max(0, plan.gap.at - plan.lead_s) } : null,
  }
}
