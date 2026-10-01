/**
 * Make a list of audio files safe for FFmpeg's concat DEMUXER.
 *
 * The demuxer joins files without decoding, so it reads every file with the
 * codec and sample rate of the FIRST one. Given an MP3 and an M4A (a music
 * library that holds old MP3 takes next to the AAC `.m4a` ones saved since
 * 1.4.244), or two files at different sample rates, it does not fail: it logs
 * decoder errors, drops the files it cannot read and exits 0. Measured: an MP3 +
 * 2 M4A list of 3 x 3 s came out 3.0 s long, so a "two-hour" mix quietly lost
 * tracks and its tracklist timestamps no longer matched the audio.
 *
 * A list whose files all share codec, sample rate and channel count goes through
 * untouched (the common case costs only the probes). A mixed list is re-encoded,
 * file by file, to one AAC format first.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { getFFprobePath } from '../services/ffmpeg-manager.js'
import { PROBE_TIMEOUT_MS, runFfmpeg } from './ffmpeg-utils.js'

/** `codec:sampleRate:channels` of the first audio stream, or null when it cannot be probed. */
export async function probeAudioSignature(file: string): Promise<string | null> {
  const ffprobe = await getFFprobePath()
  return new Promise(resolve => {
    const proc = spawn(ffprobe, [
      '-v', 'error', '-select_streams', 'a:0',
      '-show_entries', 'stream=codec_name,sample_rate,channels',
      '-of', 'csv=p=0', file,
    ], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    proc.stdout.on('data', (chunk: Buffer) => { out += chunk.toString() })
    const timer = setTimeout(() => proc.kill('SIGKILL'), PROBE_TIMEOUT_MS)
    proc.on('error', () => { clearTimeout(timer); resolve(null) })
    proc.on('close', code => {
      clearTimeout(timer)
      const line = out.trim().split('\n')[0]?.trim()
      resolve(code === 0 && line ? line : null)
    })
  })
}

/**
 * What must match for the demuxer to read two files as one stream. MP3 only needs the codec to match:
 * its frames carry their own sample rate and channel layout and the join is clean (measured: 24 kHz
 * mono + 44.1 kHz stereo MP3 = the exact sum), so an all-MP3 list is never re-encoded for that. AAC
 * (and anything else) also needs the same rate and channel count.
 */
function concatKey(signature: string | null): string | null {
  if (!signature) return null
  return signature.startsWith('mp3,') ? 'mp3' : signature
}

/**
 * Returns the files to put in the concat list, in the same order. Anything that
 * had to be re-encoded is written into `workDir` (the caller owns that folder
 * and removes it); the originals are never touched.
 */
export async function homogenizeForConcat(
  files: readonly string[],
  workDir: string,
): Promise<{ files: string[]; reencoded: number }> {
  if (files.length < 2) return { files: [...files], reencoded: 0 }
  const signatures: Array<string | null> = []
  for (let i = 0; i < files.length; i += 4) {
    signatures.push(...await Promise.all(files.slice(i, i + 4).map(probeAudioSignature)))
  }
  const keys = signatures.map(concatKey)
  if (keys.every(key => key !== null && key === keys[0])) {
    return { files: [...files], reencoded: 0 }
  }
  await fs.mkdir(workDir, { recursive: true })
  const out: string[] = []
  for (const [index, file] of files.entries()) {
    const target = path.join(workDir, `concat-${String(index).padStart(4, '0')}.m4a`)
    await runFfmpeg(['-y', '-i', file, '-vn', '-map_metadata', '-1', '-ar', '44100', '-ac', '2',
      '-c:a', 'aac', '-b:a', '256k', '-f', 'ipod', target])
    out.push(target)
  }
  return { files: out, reencoded: out.length }
}
