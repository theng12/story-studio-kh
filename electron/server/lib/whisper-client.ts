/**
 * OpenAI Whisper transcription — returns an SRT string straight from the
 * API. Whisper's hard upload cap is 25 MB. Sleep-story episodes typically
 * fit (1–2 hr at 128 kbps mono ≈ 7-15 MB), but listicle / explainer
 * formats with 100+ chapters produce 4-6 hr audio that overflows.
 *
 * v1.0.71+: when the input file exceeds the cap, we segment the audio
 * via FFmpeg into ~8-minute chunks (~7-8 MB each at 128 kbps), transcribe
 * each chunk separately, and stitch the SRT cues together with cumulative
 * timestamp offsets. Single-call path stays unchanged for files that
 * already fit so the common case has zero overhead.
 */

import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import os from 'os'
import OpenAI from 'openai'
import { runFfmpeg, getAudioDuration } from './ffmpeg-utils.js'

export interface TranscribeOptions {
  apiKey: string
  audioPath: string
  language?: string          // ISO-639-1 (e.g. 'en'); auto-detect when omitted
  model?: string             // 'whisper-1' (cheap) or 'gpt-4o-transcribe' (newer)
  onProgress?: (phase: string, pct: number) => void
  /**
   * Optional abort signal wired to the SDK's request options. When the user
   * cancels a `subtitles_transcribe` job the generator aborts this signal;
   * the OpenAI SDK unwinds the in-flight fetch and we stop paying for the
   * transcription immediately instead of waiting the 30-90 s it would take
   * to finish and return results the user no longer wants.
   */
  signal?: AbortSignal
}

/** Whisper's documented hard cap is 25 MB; we leave a 0.5 MB safety
 *  margin so a slightly-over file doesn't bounce off the API. */
const WHISPER_SIZE_LIMIT_BYTES = 24.5 * 1024 * 1024

/** Target chunk duration for the chunked path. 8 minutes at 128 kbps mono
 *  ≈ 7.7 MB per chunk — safely under the cap with headroom for slightly
 *  higher bitrates or stereo content. */
const CHUNK_DURATION_SECONDS = 8 * 60

export async function transcribeToSrt(opts: TranscribeOptions): Promise<string> {
  if (!opts.apiKey) throw new Error('No OpenAI API key configured')
  if (!fs.existsSync(opts.audioPath)) throw new Error(`Audio file not found: ${opts.audioPath}`)

  const stat = fs.statSync(opts.audioPath)
  if (stat.size > WHISPER_SIZE_LIMIT_BYTES) {
    return transcribeLargeAudio(opts, stat.size)
  }

  // Single-call path (unchanged): file fits under Whisper's cap.
  return transcribeSingleFile(opts.audioPath, opts)
}

// ── Single-file path ───────────────────────────────────────────────────────

async function transcribeSingleFile(filePath: string, opts: TranscribeOptions): Promise<string> {
  const client = new OpenAI({ apiKey: opts.apiKey })
  opts.onProgress?.('upload', 10)

  // The OpenAI SDK accepts a ReadStream directly for the `file` field, and
  // `signal` on the second `RequestOptions` argument for cancellation.
  const resp = await client.audio.transcriptions.create(
    {
      file: fs.createReadStream(filePath) as any,
      model: opts.model || 'whisper-1',
      response_format: 'srt',
      language: opts.language,
      temperature: 0,
    },
    opts.signal ? { signal: opts.signal } : undefined,
  )

  opts.onProgress?.('done', 100)

  // When response_format is 'srt', the SDK returns the raw SRT string.
  // (The TS types claim it returns an object — hence the cast.)
  const srt = typeof resp === 'string' ? resp : (resp as any).text || String(resp)
  if (!srt || !srt.trim()) throw new Error('Whisper returned empty transcript')
  return srt
}

// ── Chunked path (file > 25 MB) ────────────────────────────────────────────

/**
 * Transcribe an audio file too large for Whisper's 25 MB cap by segmenting
 * with FFmpeg, transcribing each segment, and stitching SRT cues with
 * cumulative timestamp offsets. Temp files land in a per-job directory
 * under the OS temp dir and are cleaned up at the end (or on error).
 */
async function transcribeLargeAudio(opts: TranscribeOptions, sizeBytes: number): Promise<string> {
  const sizeMb = sizeBytes / (1024 * 1024)
  opts.onProgress?.('chunking', 5)

  // Probe duration so we can compute chunk count up front (informative log).
  const duration = await getAudioDuration(opts.audioPath)
  const expectedChunkCount = duration ? Math.ceil(duration / CHUNK_DURATION_SECONDS) : undefined

  // Working dir — unique per call. Cleaned in finally below.
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sskh-whisper-chunk-'))
  const inExt = path.extname(opts.audioPath).toLowerCase() || '.mp3'
  const segPattern = path.join(workDir, `chunk_%05d${inExt}`)

  try {
    // Segment with `-c copy` first for speed (no re-encode). If the input
    // codec doesn't support clean segmenting at arbitrary boundaries
    // (rare for mp3/aac but common for some WAV variants), fall back to
    // re-encoding to mp3 96k mono — small enough to fit comfortably.
    try {
      await runFfmpeg([
        '-y',
        '-i', opts.audioPath,
        '-f', 'segment',
        '-segment_time', String(CHUNK_DURATION_SECONDS),
        '-reset_timestamps', '1',
        '-c', 'copy',
        segPattern,
      ], { timeoutMs: 5 * 60_000 })
    } catch (e: any) {
      // Re-encode fallback. Slower (a few seconds per minute of audio)
      // but always works. mp3 96k mono produces ~5.7 MB per 8-minute
      // segment — well under the cap.
      const fallbackPattern = path.join(workDir, `chunk_%05d.mp3`)
      await runFfmpeg([
        '-y',
        '-i', opts.audioPath,
        '-f', 'segment',
        '-segment_time', String(CHUNK_DURATION_SECONDS),
        '-reset_timestamps', '1',
        '-vn',
        '-ac', '1',
        '-b:a', '96k',
        '-codec:a', 'libmp3lame',
        fallbackPattern,
      ], { timeoutMs: 15 * 60_000 })
    }

    // Discover the chunk files we just produced.
    const entries = await fsp.readdir(workDir)
    const chunks = entries
      .filter(n => /^chunk_\d+\.(mp3|m4a|aac|wav|flac|ogg|opus)$/i.test(n))
      .sort()
    if (!chunks.length) {
      throw new Error('Audio segmentation produced no chunks — check FFmpeg installation.')
    }
    const chunkCount = expectedChunkCount && Math.abs(expectedChunkCount - chunks.length) <= 1
      ? expectedChunkCount
      : chunks.length

    opts.onProgress?.('chunking', 15)
    // Diagnostic: surface what we did so the job log explains the path.
    console.log(`[whisper] file ${sizeMb.toFixed(1)} MB exceeds 25 MB cap — segmented into ${chunks.length} chunk(s) of ~${CHUNK_DURATION_SECONDS / 60} min each.`)

    // Transcribe each chunk SEQUENTIALLY. Parallelising would hit the
    // OpenAI rate limit (~3 RPS for whisper-1 on tier 1) and tangle
    // error reporting; sequential is safe and the typical 4-hour file
    // finishes in 5-10 min total.
    const srtBlocks: string[] = []
    let cueNumberOffset = 0
    let timeOffsetSeconds = 0

    for (let i = 0; i < chunks.length; i++) {
      if (opts.signal?.aborted) throw new Error('Cancelled by user')
      const chunkPath = path.join(workDir, chunks[i]!)
      opts.onProgress?.('transcribing', 15 + Math.round((i / chunks.length) * 80))

      const chunkSrt = await transcribeSingleFile(chunkPath, opts)
      const { srt: shifted, cueCount, lastEndSeconds } =
        shiftSrtTimestamps(chunkSrt, timeOffsetSeconds, cueNumberOffset)

      srtBlocks.push(shifted)
      cueNumberOffset += cueCount

      // Probe the actual chunk duration for the next offset. ffmpeg's
      // segment_time is a SUGGESTION (it splits at the next keyframe);
      // using the actual duration keeps cues aligned to within ~100 ms.
      const actualDuration = await getAudioDuration(chunkPath)
      timeOffsetSeconds += actualDuration ?? CHUNK_DURATION_SECONDS

      // Sanity: if Whisper reports cues that extend beyond the chunk's
      // measured duration, trust the longer of the two so we don't drop
      // ahead of a slightly-mistimed chunk.
      if (lastEndSeconds && lastEndSeconds > timeOffsetSeconds) {
        timeOffsetSeconds = lastEndSeconds
      }
    }

    opts.onProgress?.('done', 100)
    const stitched = srtBlocks.join('\n\n').trim() + '\n'
    if (!stitched.trim()) throw new Error('Whisper returned empty transcript across all chunks')
    return stitched
  } finally {
    // Best-effort cleanup. On error we leave a stale temp dir behind for
    // post-mortem debugging; the OS clears it eventually.
    try { await fsp.rm(workDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

// ── SRT timestamp shifting ─────────────────────────────────────────────────

/**
 * Add `offsetSeconds` to every cue timestamp in an SRT block, and add
 * `cueNumberOffset` to every cue's leading sequence number. Returns the
 * shifted SRT, the count of cues shifted, and the end-time of the last
 * cue (in seconds — used by the caller to validate offset progression).
 *
 * SRT shape (one cue):
 *   1
 *   00:00:01,000 --> 00:00:04,250
 *   The cue text.
 *
 * We're permissive — extra blank lines, BOM bytes, mixed line endings
 * all pass through unaffected. Exported separately for unit testing.
 */
export function shiftSrtTimestamps(
  srt: string, offsetSeconds: number, cueNumberOffset: number,
): { srt: string; cueCount: number; lastEndSeconds: number } {
  // Whisper occasionally emits a UTF-8 BOM at the head of the SRT — strip
  // it so our timestamp regex matches on the very first cue.
  const cleaned = srt.replace(/^﻿/, '').replace(/\r\n/g, '\n').trim()
  if (!cleaned) return { srt: '', cueCount: 0, lastEndSeconds: 0 }

  const lines = cleaned.split('\n')
  const out: string[] = []
  let cueCount = 0
  let lastEndSeconds = 0

  for (const line of lines) {
    // Cue index line: a bare integer at the start of a cue.
    const numMatch = line.match(/^\s*(\d+)\s*$/)
    if (numMatch) {
      const original = parseInt(numMatch[1]!, 10)
      cueCount++
      out.push(String(original + cueNumberOffset))
      continue
    }
    // Timecode line: "HH:MM:SS,mmm --> HH:MM:SS,mmm".
    const timeMatch = line.match(/^(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})(.*)$/)
    if (timeMatch) {
      const startSec = toSeconds(timeMatch[1]!, timeMatch[2]!, timeMatch[3]!, timeMatch[4]!) + offsetSeconds
      const endSec = toSeconds(timeMatch[5]!, timeMatch[6]!, timeMatch[7]!, timeMatch[8]!) + offsetSeconds
      lastEndSeconds = endSec
      out.push(`${formatTime(startSec)} --> ${formatTime(endSec)}${timeMatch[9] || ''}`)
      continue
    }
    out.push(line)
  }
  return { srt: out.join('\n'), cueCount, lastEndSeconds }
}

function toSeconds(h: string, m: string, s: string, ms: string): number {
  return parseInt(h, 10) * 3600 + parseInt(m, 10) * 60 + parseInt(s, 10) + parseInt(ms, 10) / 1000
}

function formatTime(seconds: number): string {
  const total = Math.max(0, seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = Math.floor(total % 60)
  const ms = Math.round((total - Math.floor(total)) * 1000)
  return `${pad2(h)}:${pad2(m)}:${pad2(s)},${pad3(ms)}`
}

function pad2(n: number): string { return n < 10 ? '0' + n : String(n) }
function pad3(n: number): string { return n < 10 ? '00' + n : n < 100 ? '0' + n : String(n) }
