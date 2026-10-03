/**
 * Optional light sharpening while a still is upscaled for the render (SPEC §5: the fleet's stills
 * are 1280x720; a 1080p render upscales them "with lanczos plus light sharpening").
 *
 * Done ONCE per distinct still, before any scene clip is made: lanczos up to the canvas (aspect
 * kept, never cropped here — the camera move frames it as before) and a light luma-only unsharp
 * mask. Per still this is a fraction of a second; doing it per frame in the final pass would also
 * sharpen grain and particles and cost every frame of the episode (measured in
 * `music-format/build/feat-music-finish/sharpen-bench.json`).
 *
 * 'off' (the default for every request that does not ask) changes nothing.
 */

import path from 'path'
import sharp from 'sharp'

export type UpscaleSharpen = 'off' | 'light'

/** 5x5 luma unsharp, amount 0.5; chroma untouched (sharpening colour edges only adds fringes). */
export const LIGHT_UNSHARP = 'unsharp=luma_msize_x=5:luma_msize_y=5:luma_amount=0.5:chroma_msize_x=5:chroma_msize_y=5:chroma_amount=0'

export function upscaleSharpenFilter(w: number, h: number): string {
  return `scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos,${LIGHT_UNSHARP}`
}

export function needsUpscale(size: { width?: number; height?: number }, w: number, h: number): boolean {
  const sw = Number(size.width) || 0
  const sh = Number(size.height) || 0
  if (!sw || !sh) return false
  // Smaller than the canvas on the side the cover-fit uses.
  return Math.max(w / sw, h / sh) > 1.001
}

const VIDEO = /\.(mp4|mov|webm|mkv|m4v)$/i

/**
 * Returns `scenes` with each smaller-than-canvas still replaced by a sharpened, upscaled copy in
 * `tempDir`. Videos, stills already at canvas size and unreadable files are left as they are.
 */
export async function sharpenUpscaledStills<T extends { image_path: string }>(
  scenes: readonly T[],
  w: number,
  h: number,
  tempDir: string,
  run: (args: string[]) => Promise<unknown>,
  log: (line: string) => void,
): Promise<T[]> {
  const done = new Map<string, string>()
  let count = 0
  const started = Date.now()
  const out: T[] = []
  for (const scene of scenes) {
    const source = scene.image_path
    if (!source || VIDEO.test(source)) { out.push(scene); continue }
    if (!done.has(source)) {
      const meta = await sharp(source).metadata().catch(() => null)
      if (!meta || !needsUpscale(meta, w, h)) {
        done.set(source, source)
      } else {
        const target = path.join(tempDir, `sharpened_${String(done.size).padStart(4, '0')}.png`)
        await run(['-hide_banner', '-nostdin', '-y', '-i', source, '-vf', upscaleSharpenFilter(w, h), '-frames:v', '1', '-update', '1', target])
        done.set(source, target)
        count++
      }
    }
    out.push({ ...scene, image_path: done.get(source)! })
  }
  if (count) log(`Upscale: ${count} still(s) upscaled to ${w}x${h} with light sharpening in ${((Date.now() - started) / 1000).toFixed(1)} s.`)
  return out
}
