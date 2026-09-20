/**
 * B-Roll indexer — turns a folder of MP4/MOV/WebM files into an indexed
 * sidecar + thumbnail cache. Pure I/O + ffmpeg, no HTTP layer.
 *
 * Scan flow (drop-in mode — user added files to the SSD via Finder):
 *   1. List video files in pool folder (non-recursive — flat pool).
 *   2. Load sidecar (or initialise empty).
 *   3. For each file:
 *      a. mtime + size unchanged from sidecar entry? skip (fast path).
 *      b. else: sha256 the file → if new, ffprobe + thumbnail; if
 *         same sha (renamed only), carry tags + normalized flag across
 *         to the new filename and drop the old entry.
 *   4. For sidecar entries whose file disappeared: mark missing=true
 *      (preserves tags so the next reconnect restores everything).
 *   5. Save sidecar.
 *
 * Streaming sha + 1MB chunks + ffprobe-only-on-content-change makes a
 * 200-clip 10GB rescan ~5-10s on M2 SSD after the first full index.
 */
import { existsSync } from 'fs'
import fs from 'fs/promises'
import path from 'path'
import { spawn } from 'child_process'
import { getFFmpegPath, getFFprobePath } from '../services/ffmpeg-manager.js'
import {
  type BrollClip,
  loadSidecarForScan,
  saveSidecarForScan,
  sha256File,
  thumbnailDir,
  thumbnailPath,
} from '../services/broll-pool-manager.js'

const VIDEO_EXTENSIONS = /\.(mp4|mov|webm|mkv|m4v)$/i
// v1.0.403 — Image Pool format: still images indexed the same way (sha + sidecar
// + thumbnail), but probed for dimensions only (no duration/fps/audio) and held
// for a configured number of seconds at assemble time.
const IMAGE_EXTENSIONS = /\.(jpe?g|png|webp|gif|bmp|tiff?|heic)$/i
// SFX / sound-effect pools: audio files indexed by sha + sidecar (tags travel on
// the SSD), probed for DURATION only — no thumbnail, no width/height/fps, no
// normalize pass. Shared across projects like the other pool media types.
const AUDIO_EXTENSIONS = /\.(mp3|wav|m4a|aac|flac|ogg|opus)$/i

// ── ffprobe (one shot per clip, only on content change) ────────────────

/**
 * ffprobe reports an unmeasurable field as the STRING `'N/A'`, not as absent.
 *
 * `'N/A'` is truthy, so `stream.duration || format.duration` stops there and
 * never reaches the fallback that actually has the value — and `Number('N/A')`
 * is `NaN`, which the callers then flatten to `0`. Both spell "I could not
 * measure this" as "the measurement is zero" (AGENTS.md §6).
 *
 * Returns `null` for anything that is not a real, finite number — absent,
 * `'N/A'`, empty, `NaN`, `Infinity` — so `??` reaches the next source and the
 * caller can tell "unknown" from "zero".
 */
export function parseFfprobeNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * The clip's duration in seconds, from the stream when it can be measured and
 * the container format otherwise.
 *
 * MEASURED case this exists for: `stream.duration` is `'N/A'` while
 * `format.duration` is real — the normal shape for some codecs. The old
 * expression compared the raw values with `||`, so the truthy `'N/A'` won, the
 * format was never consulted, and the clip was indexed as **0 seconds long**.
 */
export function probeDurationSeconds(stream: unknown, format: unknown): number {
  const fromStream = parseFfprobeNumber((stream as Record<string, unknown> | null)?.duration)
  const fromFormat = parseFfprobeNumber((format as Record<string, unknown> | null)?.duration)
  return fromStream ?? fromFormat ?? 0
}

interface ProbeResult {
  duration: number
  width: number
  height: number
  fps: number
}

async function ffprobeClip(filePath: string): Promise<ProbeResult> {
  const ffprobe = await getFFprobePath()
  return new Promise((resolve, reject) => {
    const proc = spawn(ffprobe, [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,r_frame_rate,duration:format=duration',
      '-of', 'json',
      filePath,
    ])
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d) => stdout += String(d))
    proc.stderr.on('data', (d) => stderr += String(d))
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffprobe exited ${code}: ${stderr.slice(0, 200)}`))
      try {
        const parsed = JSON.parse(stdout)
        const stream = parsed.streams?.[0] || {}
        const fmt = parsed.format || {}
        // r_frame_rate is "30/1" or "60000/1001" — evaluate to a number.
        const fpsStr = String(stream.r_frame_rate || '0/1')
        const [num, den] = fpsStr.split('/').map((s: string) => parseFloat(s))
        const fps = den && num ? num / den : 0
        resolve({
          duration: probeDurationSeconds(stream, fmt),
          width: parseFfprobeNumber(stream.width) ?? 0,
          height: parseFfprobeNumber(stream.height) ?? 0,
          fps: Number.isFinite(fps) ? Math.round(fps * 100) / 100 : 0,
        })
      } catch (e: any) {
        reject(new Error(`Failed to parse ffprobe output: ${e?.message || e}`))
      }
    })
  })
}

// ── Thumbnail extraction (one JPG at midpoint, cached by content hash) ──

async function generateThumbnail(filePath: string, sha256: string, durationSec: number, isImage = false): Promise<void> {
  const ffmpeg = await getFFmpegPath()
  const outPath = thumbnailPath(sha256)
  if (existsSync(outPath)) return // already cached for this content hash

  await fs.mkdir(thumbnailDir(), { recursive: true })

  // Images are a single frame — no seek (a midpoint -ss past a 1-frame input
  // produces nothing). Videos seek to midpoint: some clips have a black
  // first second (fade-in) so frame 0 isn't always meaningful. -ss BEFORE
  // -i is the fast input-seek path; accurate enough for thumbnails.
  const seek = Math.max(0.5, Math.min(durationSec / 2, durationSec - 0.5))
  const args = [
    '-y',
    ...(isImage ? [] : ['-ss', String(seek)]),
    '-i', filePath,
    '-frames:v', '1',
    '-vf', 'scale=320:-2', // 320px wide, height auto-preserves aspect
    '-q:v', '4', // jpeg quality, 1=best 31=worst — 4 is visually sharp at 320px
    outPath,
  ]

  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, args)
    let stderr = ''
    proc.stderr.on('data', (d) => stderr += String(d))
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`Thumbnail ffmpeg exited ${code}: ${stderr.slice(0, 300)}`))
    })
  })
}

// ── Scan ────────────────────────────────────────────────────────────────

export interface ScanResult {
  added: string[]
  updated: string[]
  unchanged: string[]
  missing: string[]
  errors: Array<{ filename: string; error: string }>
}

/**
 * Re-scan a pool folder, updating the sidecar in place. Returns a summary
 * the route layer can surface as a toast. Idempotent — calling twice with
 * no changes returns added=updated=missing=[] and unchanged=<all clips>.
 *
 * Progress callback (optional) fires once per file processed so a
 * long-running scan can stream UI updates. Skip for tests / scripts.
 */
export async function scanPoolFolder(
  folderPath: string,
  onProgress?: (info: { filename: string; index: number; total: number; status: 'probed' | 'skipped' | 'error' }) => void,
  media: 'video' | 'image' | 'audio' = 'video',
): Promise<ScanResult> {
  if (!existsSync(folderPath)) {
    throw new Error(`Folder not found: ${folderPath}`)
  }
  const isImage = media === 'image'
  const isAudio = media === 'audio'
  const matchExt = isAudio ? AUDIO_EXTENSIONS : isImage ? IMAGE_EXTENSIONS : VIDEO_EXTENSIONS

  const sidecar = await loadSidecarForScan(folderPath)
  // Reset `missing` on every scan — anything that's still missing after
  // we walk the folder gets re-flagged below.
  for (const clip of Object.values(sidecar.clips)) clip.missing = false

  const entries = await fs.readdir(folderPath)
  const files = entries.filter(f => matchExt.test(f) && !f.startsWith('.'))

  const result: ScanResult = { added: [], updated: [], unchanged: [], missing: [], errors: [] }
  const seenFilenames = new Set<string>()

  for (let i = 0; i < files.length; i++) {
    const filename = files[i]!
    const filePath = path.join(folderPath, filename)
    seenFilenames.add(filename)

    try {
      const stat = await fs.stat(filePath)
      const existing = sidecar.clips[filename]

      // Fast path — mtime + size unchanged → no re-probe.
      if (existing && existing.size_bytes === stat.size && !existing.missing) {
        // Verify thumbnail still cached; regenerate if user wiped the
        // cache dir manually. (Audio pools have no thumbnails.)
        if (!isAudio && !existsSync(thumbnailPath(existing.sha256))) {
          await generateThumbnail(filePath, existing.sha256, existing.duration, isImage).catch(() => {})
        }
        result.unchanged.push(filename)
        onProgress?.({ filename, index: i, total: files.length, status: 'skipped' })
        continue
      }

      // Hash content. New clip OR an existing one whose bytes changed.
      const sha = await sha256File(filePath)

      // Renamed-only check: same sha appears under a different filename
      // in the sidecar. Carry tags + normalized flag over to the new
      // filename and drop the old entry. Saves a re-probe + preserves
      // user curation.
      const renameOrigin = Object.entries(sidecar.clips).find(
        ([fn, c]) => fn !== filename && c.sha256 === sha,
      )

      let clip: BrollClip
      if (renameOrigin) {
        const [oldName, oldClip] = renameOrigin
        clip = { ...oldClip, filename, size_bytes: stat.size, missing: false, indexed_at: new Date().toISOString() }
        delete sidecar.clips[oldName]
        result.updated.push(`${oldName} → ${filename}`)
      } else {
        // ffprobe returns width/height for images too; duration/fps are
        // meaningless for a still (the slideshow sets the on-screen seconds
        // at assemble time), so they land as 0 — that's expected.
        // ffprobe returns width/height for video/images; for audio the v:0
        // stream is absent so those land as 0 and duration comes from the
        // container (format.duration) — exactly what we want for an SFX clip.
        const probe = await ffprobeClip(filePath)
        clip = {
          filename,
          duration: isImage ? 0 : probe.duration,
          width: probe.width,
          height: probe.height,
          fps: (isImage || isAudio) ? 0 : probe.fps,
          size_bytes: stat.size,
          sha256: sha,
          normalized: (isImage || isAudio) ? true : false,  // images/audio need no normalize pass
          tags: existing?.tags || [],
          indexed_at: new Date().toISOString(),
        }
        if (existing) result.updated.push(filename)
        else result.added.push(filename)
      }

      // Generate the thumbnail (cheap — single ffmpeg frame). Failure is
      // non-fatal; the UI shows a placeholder. Audio pools have no thumbnail.
      if (!isAudio) await generateThumbnail(filePath, clip.sha256, clip.duration, isImage).catch(() => {})

      sidecar.clips[filename] = clip
      onProgress?.({ filename, index: i, total: files.length, status: 'probed' })
    } catch (e: any) {
      result.errors.push({ filename, error: e?.message || String(e) })
      onProgress?.({ filename, index: i, total: files.length, status: 'error' })
    }
  }

  // Anything in the sidecar that didn't appear on disk → missing.
  // Preserves the entry (tags, usage history) for when the SSD reconnects
  // or the user moves the file back.
  for (const [fn, clip] of Object.entries(sidecar.clips)) {
    if (!seenFilenames.has(fn)) {
      clip.missing = true
      result.missing.push(fn)
    }
  }

  await saveSidecarForScan(folderPath, sidecar)
  return result
}
