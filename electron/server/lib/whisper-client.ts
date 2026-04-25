/**
 * OpenAI Whisper transcription — returns an SRT string straight from the
 * API. Streaming-friendly, no chunking needed: Whisper accepts files up
 * to 25 MB; a merged sleep-story track at 128 kbps mono usually fits.
 *
 * For bigger files we fall back to segmenting with FFmpeg before upload —
 * not implemented yet, because none of today's episodes hit the limit.
 */

import fs from 'fs'
import OpenAI from 'openai'

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

export async function transcribeToSrt(opts: TranscribeOptions): Promise<string> {
  if (!opts.apiKey) throw new Error('No OpenAI API key configured')
  if (!fs.existsSync(opts.audioPath)) throw new Error(`Audio file not found: ${opts.audioPath}`)

  const stat = fs.statSync(opts.audioPath)
  const sizeMb = stat.size / (1024 * 1024)
  if (sizeMb > 24.5) {
    throw new Error(
      `Audio file is ${sizeMb.toFixed(1)} MB — Whisper's hard cap is 25 MB. ` +
      `Lower the merged audio bitrate or chunk it first.`
    )
  }

  const client = new OpenAI({ apiKey: opts.apiKey })
  opts.onProgress?.('upload', 10)

  // The OpenAI SDK accepts a ReadStream directly for the `file` field, and
  // `signal` on the second `RequestOptions` argument for cancellation.
  const resp = await client.audio.transcriptions.create(
    {
      file: fs.createReadStream(opts.audioPath) as any,
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
