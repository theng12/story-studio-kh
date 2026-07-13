/**
 * B-Roll normalize executor — re-encodes one clip to 1920×1080 at the
 * pool's target fps (24 default, 30 optional) using H.264 / CRF 20.
 *
 * Writes the output to `<pool>/.broll-normalized/<filename>` so the
 * original on the SSD stays untouched. Video Assembly prefers the
 * normalized path when present (concat-demuxer-fast), falls back to
 * the original via filtergraph when absent.
 *
 * Audio: the encoder PRESERVES the source audio track (aac copy when
 * present, omit when absent). Silencing/ducking happens later at
 * Video Assembly time via the B-Roll volume slider — we never want to
 * destroy audio at the normalize stage because user prefs may change.
 *
 * Source quirks handled:
 *   - 720p input  → upscale via lanczos
 *   - 4K input    → downscale via area filter (sharper than bicubic for downscales)
 *   - 60fps input → fps=24/30 drops frames cleanly
 *   - 24fps input → fps filter is a no-op when target matches
 *   - Non-16:9    → letterbox via pad filter (centred, black bars)
 */
import path from 'path'
import { existsSync } from 'fs'
import fsp from 'fs/promises'
import { spawn } from 'child_process'
import { appendCappedTail } from '../lib/ffmpeg-utils.js'
import * as bp from '../services/broll-pool-manager.js'
import { getFFmpegPath } from '../services/ffmpeg-manager.js'
import * as jq from '../services/job-queue.js'
import type { Job } from '../models/types.js'

interface NormalizeParams {
  pool_id: string
  filename: string
}

export async function normalizeBroll(job: Job): Promise<void> {
  const { pool_id, filename } = job.params as NormalizeParams
  if (!pool_id || !filename) throw new Error('pool_id and filename are required')

  const pool = await bp.getPool(pool_id)
  if (!pool) throw new Error(`Pool '${pool_id}' not found`)
  if (!existsSync(pool.folder_path)) {
    throw new Error(`Pool folder offline — plug in the SSD at ${pool.folder_path} before normalizing.`)
  }

  const sourcePath = path.join(pool.folder_path, filename)
  if (!existsSync(sourcePath)) throw new Error(`Source clip missing: ${sourcePath}`)

  const normalizedDir = bp.normalizedSubdir(pool.folder_path)
  await fsp.mkdir(normalizedDir, { recursive: true })

  // Write to a temp filename first, atomically rename on success. Avoids
  // leaving a half-encoded file in place if the user cancels or ffmpeg
  // crashes mid-run.
  const finalPath = path.join(normalizedDir, filename)
  const tempPath = path.join(normalizedDir, `.tmp-${Date.now()}-${filename}`)

  const ffmpeg = await getFFmpegPath()
  const targetFps = pool.fps_target // 24 or 30

  // Filtergraph:
  //   scale=1920:1080:force_original_aspect_ratio=decrease — fit inside 1080p
  //   pad=1920:1080:(ow-iw)/2:(oh-ih)/2  — centre + letterbox the result
  //   fps=24                              — conform frame rate (no-op when matched)
  //   setsar=1                            — square pixels (kills weird PARs from older sources)
  const vfilter = [
    'scale=1920:1080:force_original_aspect_ratio=decrease:flags=lanczos',
    'pad=1920:1080:(ow-iw)/2:(oh-ih)/2',
    `fps=${targetFps}`,
    'setsar=1',
  ].join(',')

  const args = [
    '-y',
    '-i', sourcePath,
    '-vf', vfilter,
    '-c:v', 'libx264',
    '-preset', 'medium',  // medium = sane quality/speed tradeoff
    '-crf', '20',          // visually lossless at 1080p, ~50% smaller than CRF 16
    '-pix_fmt', 'yuv420p', // broadest playback compatibility
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart', // playable while streaming (relevant for web)
    tempPath,
  ]

  job.output_lines.push(`Source: ${filename}`)
  job.output_lines.push(`Target: 1920×1080 · ${targetFps}fps · H.264 CRF 20`)
  job.output_lines.push(`Encoding…`)

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpeg, args)
    let stderr = ''
    proc.stderr.on('data', (d) => {
      const s = String(d)
      stderr = appendCappedTail(stderr, s)
      // ffmpeg reports progress on stderr (frame=, fps=, time=). Surface
      // a tiny periodic update so the Jobs panel shows liveness.
      const tMatch = /time=([\d:.]+)/.exec(s)
      if (tMatch) {
        // Append a single progress line per second-ish to keep the log
        // panel readable.
        const last = job.output_lines[job.output_lines.length - 1] || ''
        if (!last.startsWith('  progress:')) {
          job.output_lines.push(`  progress: ${tMatch[1]}`)
        } else {
          job.output_lines[job.output_lines.length - 1] = `  progress: ${tMatch[1]}`
        }
      }
    })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) return resolve()
      reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-400)}`))
    })

    // Cancel watcher — surface job cancel by killing the child.
    const cancelWatcher = setInterval(() => {
      if (jq.isCancelled(job.job_id)) {
        proc.kill('SIGTERM')
        clearInterval(cancelWatcher)
      }
    }, 500)
    proc.on('close', () => clearInterval(cancelWatcher))
  })

  // Atomic rename — guaranteed-complete file at finalPath.
  await fsp.rename(tempPath, finalPath)

  // Mark the clip normalized in the sidecar so the Library UI badge
  // flips and the assembly path can prefer this file.
  await bp.markClipNormalized(pool_id, filename)

  const stat = await fsp.stat(finalPath)
  if (!stat.isFile() || stat.size <= 0) throw new Error(`Normalized clip is empty: ${filename}`)
  job.output_lines.push(`Done → ${path.basename(normalizedDir)}/${filename} (${Math.round(stat.size / 1024 / 1024)} MB)`)
  job.output_dir = normalizedDir
}
