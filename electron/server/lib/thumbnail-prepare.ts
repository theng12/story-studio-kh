/**
 * Thumbnail preparation for YouTube upload (v1.0.524).
 *
 * YouTube's thumbnails.set rejects images over 2 MB with HTTP 413. Our
 * composed/AI thumbnails routinely land at 2.2–2.5 MB, so uploads silently
 * lost their thumbnail (measured: 12 episodes failed 413). This shrinks an
 * over-limit image to a guaranteed-under-2 MB JPEG before sending, while
 * leaving already-small files byte-for-byte untouched (so a crisp 0.5 MB PNG
 * stays a PNG).
 *
 * Reuses the same `sharp` resize/encode pattern as lib/vision-client.ts.
 */

import { promises as fsp } from 'fs'
import sharp from 'sharp'

/** YouTube hard limit is 2 MB; stay comfortably under it. */
export const THUMB_MAX_BYTES = 2 * 1024 * 1024
/** YouTube recommends 1280×720; never send wider than this. */
export const THUMB_MAX_WIDTH = 1280
/** Quality ladder walked until the JPEG comes in under the byte cap. */
export const THUMB_QUALITY_LADDER = [85, 78, 70, 62, 54, 46, 40]

export interface ThumbnailEncodePlan {
  /** true → send the original bytes unchanged (already small + not too wide). */
  passthrough: boolean
  /** Resize target width when the source is wider than the cap; null = keep. */
  resizeWidth: number | null
  /** First JPEG quality to try when re-encoding. */
  startQuality: number
}

/**
 * Pure decision from cheap metadata — no I/O — so the sizing logic is unit-
 * testable without real image files.
 */
export function planThumbnailEncode(meta: { bytes: number; width?: number }): ThumbnailEncodePlan {
  const width = meta.width || 0
  const tooBig = meta.bytes > THUMB_MAX_BYTES
  const tooWide = width > THUMB_MAX_WIDTH
  if (!tooBig && !tooWide) {
    return { passthrough: true, resizeWidth: null, startQuality: THUMB_QUALITY_LADDER[0]! }
  }
  return {
    passthrough: false,
    resizeWidth: tooWide ? THUMB_MAX_WIDTH : null,
    startQuality: THUMB_QUALITY_LADDER[0]!,
  }
}

export interface PreparedThumbnail {
  buffer: Buffer
  contentType: 'image/jpeg' | 'image/png'
  bytes: number
  /** true when we had to resize/re-encode (i.e. NOT passthrough). */
  resized: boolean
}

/**
 * Produce upload-ready thumbnail bytes: passthrough when already ≤2 MB and
 * ≤1280 px wide; otherwise resize to ≤1280 px and step JPEG quality down the
 * ladder until under 2 MB, with a final 1080 px fallback. Always returns a
 * buffer under THUMB_MAX_BYTES for the re-encode path.
 */
export async function prepareThumbnail(filePath: string): Promise<PreparedThumbnail> {
  const img = sharp(filePath, { failOn: 'none' })
  const meta = await img.metadata()
  const bytes = meta.size ?? (await fsp.stat(filePath)).size
  const plan = planThumbnailEncode({ bytes, width: meta.width })

  if (plan.passthrough) {
    const raw = await fsp.readFile(filePath)
    const contentType: 'image/jpeg' | 'image/png' =
      (meta.format === 'png') ? 'image/png' : 'image/jpeg'
    return { buffer: raw, contentType, bytes: raw.length, resized: false }
  }

  const encodeAt = async (width: number | null): Promise<Buffer> => {
    let pipe = sharp(filePath, { failOn: 'none' })
    if (width) pipe = pipe.resize({ width, fit: 'inside', withoutEnlargement: true })
    for (const q of THUMB_QUALITY_LADDER) {
      const buf = await pipe.clone().jpeg({ quality: q }).toBuffer()
      if (buf.length <= THUMB_MAX_BYTES) return buf
    }
    // Nothing on the ladder fit at this width — return the smallest (q40).
    return pipe.clone().jpeg({ quality: THUMB_QUALITY_LADDER[THUMB_QUALITY_LADDER.length - 1]! }).toBuffer()
  }

  let out = await encodeAt(plan.resizeWidth ?? THUMB_MAX_WIDTH)
  if (out.length > THUMB_MAX_BYTES) {
    // Very dense image — drop to 1080 px wide and try the ladder once more.
    out = await encodeAt(1080)
  }
  return { buffer: out, contentType: 'image/jpeg', bytes: out.length, resized: true }
}
