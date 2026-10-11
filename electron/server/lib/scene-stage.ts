/**
 * The scene stage (1.4.284): effects drawn on ONE scene's clip, inside an
 * outline of that scene's still — living pictures (a flame that flickers,
 * water that ripples) and overlays clipped to a region (snow only in the
 * window, stars only in the sky).
 *
 * Why per clip and not on the composed timeline: the outline belongs to the
 * still, and the still is moved by the camera. The outline is carried through
 * the SAME camera move by the same renderer (Metal helper or FFmpeg) as a
 * second clip, so it stays on the window while the camera pushes in. Every
 * pixel outside the outline is the scene clip's own pixel.
 *
 * Never fails a render over an effect: an outline that is missing or cannot be
 * read, or a merge that FFmpeg refuses, leaves the clip as it was and says so
 * in the job log.
 */

import fs from 'fs/promises'
import path from 'path'

import { isSceneStageOverlay, type SceneOverlayDocument } from '../contracts/scene-effects.js'
import { loopShapeKey } from '../contracts/effect-loops.js'
import { drawRegionMask } from '../services/outline-masks.js'
import { bakeEffectLoop } from './effect-loop-baker.js'
import { runFfmpeg } from './ffmpeg-utils.js'
import { probeVideoStream } from './scene-clip-compat.js'
import { compileLivingRegion, compileSceneOverlay, overlayLoopShapes, regionMergeStatements } from './scene-effect-compiler.js'

export interface SceneStageItem {
  uid: string
  name: string
  document: SceneOverlayDocument
}

/** Effects of one scene's stack that belong to the scene stage. */
export function sceneStageItems<T extends { document: SceneOverlayDocument }>(entries: readonly T[]): T[] {
  return entries.filter(entry => isSceneStageOverlay(entry.document))
}

/** The clip encode every FFmpeg scene clip uses, so a staged clip concats and xfades like any other. */
export function sceneClipEncodeArgs(crf: number, fps: number, duration: number): string[] {
  return [
    '-c:v', 'libx264', '-crf', String(crf), '-preset', 'ultrafast', '-r', String(fps),
    '-fps_mode', 'cfr', '-pix_fmt', 'yuv420p',
    '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-t', String(duration), '-an',
  ]
}

/**
 * Draw the stage effects onto `clipPath`, writing `outPath`. Returns the names
 * of the effects drawn; an empty list means `outPath` was not written.
 *
 * `renderMaskClip` carries a still-sized outline PNG through the scene's own
 * camera move, `w`x`h`, `duration` long — the caller knows which renderer drew
 * the scene.
 */
export async function applySceneStage(opts: {
  clipPath: string
  outPath: string
  stillPath: string
  items: readonly SceneStageItem[]
  episodeDir: string | null
  w: number
  h: number
  fps: number
  duration: number
  workDir: string
  encodeArgs: string[]
  renderMaskClip: (maskPng: string, outPath: string) => Promise<void>
  log: (line: string) => void
  /** Test seam. */
  run?: typeof runFfmpeg
}): Promise<string[]> {
  const { w, h, fps, duration } = opts
  if (!opts.items.length) return []
  const probed = await probeVideoStream(opts.stillPath)
  const still = { width: Number(probed?.width), height: Number(probed?.height) }
  if (!still.width || !still.height) {
    opts.log(`Living picture skipped: the scene picture could not be measured (${path.basename(opts.stillPath)}).`)
    return []
  }
  const tag = path.basename(opts.outPath, path.extname(opts.outPath))
  const ready: Array<{ item: SceneStageItem; maskClip: string }> = []
  const temps: string[] = []
  for (const [i, item] of opts.items.entries()) {
    const region = item.document.region
    if (!region) {
      opts.log(`${item.name} skipped: it has no outline. Upload one for this scene (Effects Library) or give it shapes.`)
      continue
    }
    const maskPng = path.join(opts.workDir, `${tag}_outline${i}.png`)
    const maskClip = path.join(opts.workDir, `${tag}_outline${i}.mp4`)
    temps.push(maskPng, maskClip)
    const drawn = await drawRegionMask({ region, episodeDir: opts.episodeDir, still, outPng: maskPng })
    if (!drawn.ok) { opts.log(`${item.name} skipped: ${drawn.reason}.`); continue }
    try {
      await opts.renderMaskClip(maskPng, maskClip)
    } catch (error: any) {
      opts.log(`${item.name} skipped: its outline could not follow the camera (${String(error?.message || error).split('\n')[0]}).`)
      continue
    }
    ready.push({ item, maskClip })
  }
  try {
    if (!ready.length) return []
    const args = ['-y', '-i', opts.clipPath]
    for (const { maskClip } of ready) args.push('-i', maskClip)
    let nextInput = 1 + ready.length
    const loopInputs = new Map<string, string>()
    for (const { item } of ready) {
      for (const shape of overlayLoopShapes(item.document)) {
        const id = loopShapeKey(shape)
        if (loopInputs.has(id)) continue
        args.push('-stream_loop', '-1', '-i', (await bakeEffectLoop(shape, w, h, fps)).path)
        loopInputs.set(id, `[${nextInput++}:v]`)
      }
    }
    let n = 0
    const alloc = () => `[st${n++}]`
    let base = alloc()
    const statements = [`[0:v]setsar=1,format=yuv420p${base}`]
    const drawn: string[] = []
    for (const [i, { item }] of ready.entries()) {
      const keep = alloc(), work = alloc(), effect = alloc(), next = alloc()
      let body: string[] | null
      if (item.document.kind === 'living-region') {
        const moved = alloc()
        body = [...compileLivingRegion(item.document, { input: work, output: moved, allocLabel: alloc, w, h, fps, duration }), `${moved}format=yuv420p${effect}`]
      } else {
        // On its scene's clip the overlay is on for the whole clip; its outline does the placing.
        const { region: _region, ...doc } = item.document
        const yuv = alloc(), drawnLabel = alloc()
        const compiled = compileSceneOverlay(
          { ...doc, timing: { start_sec: 0, end_sec: null, fade_in_sec: 0, fade_out_sec: 0 } } as SceneOverlayDocument,
          { input: yuv, output: drawnLabel, allocLabel: alloc, w, h, duration, fps, loopInput: shape => loopInputs.get(loopShapeKey(shape)) ?? null },
        )
        body = compiled ? [`${work}null${yuv}`, ...compiled, `${drawnLabel}format=yuv420p${effect}`] : null
      }
      if (!body) { opts.log(`${item.name} draws nothing at these settings; skipped.`); continue }
      statements.push(`${base}split=2${keep}${work}`, ...body, ...regionMergeStatements(keep, effect, `[${1 + i}:v]`, next, alloc))
      base = next
      drawn.push(item.name)
    }
    if (!drawn.length) return []
    statements.push(`${base}setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv[vout]`)
    args.push('-filter_complex', statements.join(';'), '-map', '[vout]', ...opts.encodeArgs, opts.outPath)
    try {
      await (opts.run ?? runFfmpeg)(args, { timeoutMs: 15 * 60_000 })
    } catch (error: any) {
      await fs.unlink(opts.outPath).catch(() => {})
      opts.log(`Living picture skipped: FFmpeg could not draw it (${String(error?.message || error).split('\n').slice(-1)[0]}).`)
      return []
    }
    return drawn
  } finally {
    for (const file of temps) await fs.unlink(file).catch(() => {})
  }
}
