/**
 * Is there any sound under a subtitle gap?
 *
 * Dreamlands, 2026-10-03: every long subtitle gap turned out to be the
 * narration, not the transcription — the voice model rendered a sentence as
 * silence, a slow DC drift, or humming (see the Hub's `tts_quality.py`).
 * Re-transcribing can never fix that. This tells the two cases apart cheaply so
 * the Subtitles page can say which one it is:
 *
 *   'silent' — nothing above the noise floor: the narration is missing here.
 *   'sound'  — something is audible: clear speech the subtitles missed, or
 *              humming/mumbling instead of the script. Only a listen tells.
 *
 * Same measure as the Hub's gate (slow drift removed with a 50 ms moving
 * average, a 20 ms frame is voiced above -40 dBFS), plus a 60 Hz high-pass:
 * Story's chapters are MP3, and encoding a near-clipping DC drift leaves
 * low-frequency artefacts the Hub's WAV never had. Measured on copies of the
 * Dreamlands EP0001 gaps: silence / DC / noise floor 0-1 % voiced, babble 21-100 %,
 * ordinary narration 56-67 %.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { getFFmpegPath } from './ffmpeg-manager.js'
import { audioFilesForSection } from './subtitle-completion.js'
import type { SubtitleCueGap } from './scene-timeline-integrity.js'

const RATE = 16_000
const FRAME = RATE / 50
const DC_WINDOW = RATE / 20
const VOICED_DBFS = -40
/** Real narration is voiced over half the time; a dropped sentence about 1 %. */
export const SILENT_VOICED_SHARE = 0.1

export type GapAudio = 'silent' | 'sound'

/** Share of 20 ms frames that are voiced once slow drift is removed. */
export function voicedShare(samples: Int16Array): number {
  const n = samples.length
  if (n < FRAME) return 0
  const prefix = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i]! + samples[i]!
  const half = DC_WINDOW >> 1
  const threshold = 32768 * 10 ** (VOICED_DBFS / 20)
  let voiced = 0
  let frames = 0
  for (let start = 0; start + FRAME <= n; start += FRAME) {
    let energy = 0
    for (let i = start; i < start + FRAME; i++) {
      const lo = Math.max(0, i - half)
      const hi = Math.min(n, i + half)
      const residual = samples[i]! - (prefix[hi]! - prefix[lo]!) / (hi - lo)
      energy += residual * residual
    }
    frames++
    if (Math.sqrt(energy / FRAME) > threshold) voiced++
  }
  return voiced / frames
}

export function classifyGapAudio(share: number): GapAudio {
  return share < SILENT_VOICED_SHARE ? 'silent' : 'sound'
}

/** Decode [start, end) of the chapter (its parts played back to back) as 16 kHz mono. */
async function decodeSpan(files: string[], startSec: number, endSec: number): Promise<Int16Array> {
  const ffmpeg = await getFFmpegPath()
  const inputs = files.flatMap(file => ['-i', file])
  const joined = files.length > 1 ? `${files.map((_, i) => `[${i}:a]`).join('')}concat=n=${files.length}:v=0:a=1,` : ''
  const filter = `${files.length > 1 ? '' : '[0:a]'}${joined}atrim=start=${startSec.toFixed(3)}:end=${endSec.toFixed(3)},highpass=f=60`
  const args = ['-v', 'error', ...inputs, '-filter_complex', filter, '-ac', '1', '-ar', String(RATE), '-f', 's16le', 'pipe:1']
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    child.stdout.on('data', chunk => chunks.push(chunk))
    child.on('error', reject)
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`ffmpeg exited ${code}`))
      const bytes = Buffer.concat(chunks)
      resolve(new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length >> 1))
    })
  })
}

// ponytail: unbounded only in theory — keyed by file identity + span, a handful of gaps per episode.
const cache = new Map<string, GapAudio | null>()

/** 'silent' / 'sound' for one gap, or null when the audio can't be read. Never throws. */
export async function inspectGapAudio(files: string[], startSec: number, endSec: number): Promise<GapAudio | null> {
  if (!files.length || !(endSec > startSec)) return null
  try {
    const stats = await Promise.all(files.map(file => fs.stat(file)))
    const key = `${files.map((file, i) => `${file}@${stats[i]!.size}:${stats[i]!.mtimeMs}`).join('|')}#${startSec}-${endSec}`
    if (!cache.has(key)) {
      if (cache.size > 500) cache.clear()
      const samples = await decodeSpan(files, startSec, endSec)
      cache.set(key, samples.length >= FRAME ? classifyGapAudio(voicedShare(samples)) : null)
    }
    return cache.get(key) ?? null
  } catch {
    return null
  }
}

/**
 * Mark each single-chapter gap `audio: 'silent' | 'sound'` from that chapter's
 * active audio (audio_chapters.json). Gaps it can't measure are left as they are.
 */
export async function annotateGapAudio(
  gaps: SubtitleCueGap[] | undefined,
  episodeDir: string,
  audioDir: string,
  episodeCode: string,
): Promise<void> {
  if (!gaps?.length) return
  let sections: Array<{ slug?: unknown; source_file?: unknown; source_files?: unknown }>
  try {
    const sidecar = JSON.parse(await fs.readFile(path.join(episodeDir, 'audio_chapters.json'), 'utf8'))
    sections = Array.isArray(sidecar?.sections) ? sidecar.sections : []
  } catch {
    return
  }
  for (const gap of gaps.slice(0, 20)) {
    if (gap.section_slugs.length !== 1 || gap.section_local_start_sec === undefined || gap.section_local_end_sec === undefined) continue
    const want = gap.section_slugs[0]!.toLowerCase().replace(/[^a-z0-9]/g, '')
    const section = sections.find(row => typeof row.slug === 'string' && row.slug.toLowerCase().replace(/[^a-z0-9]/g, '') === want)
    if (!section) continue
    const audio = await inspectGapAudio(
      audioFilesForSection(section, audioDir, episodeCode.toUpperCase()),
      Math.max(0, gap.section_local_start_sec),
      gap.section_local_end_sec,
    )
    if (audio) gap.audio = audio
  }
}
