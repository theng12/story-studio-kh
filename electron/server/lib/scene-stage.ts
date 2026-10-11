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
import { compileDepthStage, compileLivingRegion, compileSceneOverlay, overlayLoopShapes, regionMergeStatements, type DepthStageSpec } from './scene-effect-compiler.js'

export interface SceneStageItem {
  uid: string
  name: string
  document: SceneOverlayDocument
  /**
   * E4 — the found part's top and bottom (0..1 of the picture): an effect that follows it is laid
   * over that band instead of its own, so a shooting star crosses the real sky.
   */
  band?: [number, number]
}

/** E2 — a scene's depth move: its depth map (any size, white = near) and the numbers read from its analysis. */
export interface SceneStageDepth {
  name: string
  map: string
  spec: DepthStageSpec
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
  /** E2 — a 3D photo or rack focus, drawn last (it moves every pixel, outlined effects included). */
  depth?: SceneStageDepth | null
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
  if (!opts.items.length && !opts.depth) return []
  const probed = await probeVideoStream(opts.stillPath)
  const still = { width: Number(probed?.width), height: Number(probed?.height) }
  if (!still.width || !still.height) {
    opts.log(`Living picture skipped: the scene picture could not be measured (${path.basename(opts.stillPath)}).`)
    return []
  }
  const tag = path.basename(opts.outPath, path.extname(opts.outPath))
  const ready: Array<{ item: SceneStageItem; maskClip: string | null }> = []
  const temps: string[] = []
  for (const [i, item] of opts.items.entries()) {
    const region = item.document.region
    if (!region) {
      // E4 — an effect that follows a part of the picture keeps its own band where none was found.
      if (item.document.follow && item.document.kind !== 'living-region') { ready.push({ item, maskClip: null }); continue }
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
  let depthClip: string | null = null
  if (opts.depth) {
    const depthPng = path.join(opts.workDir, `${tag}_depth.png`)
    depthClip = path.join(opts.workDir, `${tag}_depth.mp4`)
    temps.push(depthPng, depthClip)
    try {
      // Widened round near things at the map's own size (about 4 px at 1080), then laid over the still.
      await runFfmpeg(['-v', 'error', '-y', '-i', opts.depth.map, '-frames:v', '1',
        '-vf', `format=gray,dilation,scale=${still.width}:${still.height}:flags=bicubic,format=rgb24`, depthPng], { timeoutMs: 60_000 })
      await opts.renderMaskClip(depthPng, depthClip)
    } catch (error: any) {
      opts.log(`${opts.depth.name} skipped: its depth map could not follow the camera (${String(error?.message || error).split('\n')[0]}).`)
      depthClip = null
    }
  }
  try {
    if (!ready.length && !depthClip) return []
    const args = ['-y', '-i', opts.clipPath]
    const maskInputs = new Map<number, string>()
    let nextInput = 1
    for (const [i, { maskClip }] of ready.entries()) {
      if (!maskClip) continue
      args.push('-i', maskClip)
      maskInputs.set(i, `[${nextInput++}:v]`)
    }
    const depthInput = depthClip ? `[${nextInput++}:v]` : ''
    if (depthClip) args.push('-i', depthClip)
    // On its scene's clip an overlay is on for the whole clip; its outline does the placing. E4 —
    // inside a found part, a banded effect spans that part's height instead of its own band.
    const drawnDoc = (item: SceneStageItem): SceneOverlayDocument => {
      const { region, follow: _follow, ...rest } = item.document
      // A loop fills the whole frame (one bake shared by every scene; the outline cuts it); a star or
      // a shimmer uses the found part's own rows.
      const band = item.band && region && 'region_top' in rest ? (rest.kind === 'atmosphere-loop' ? [0, 1] : item.band) : null
      const doc = band ? { ...rest, region_top: band[0], region_bottom: band[1] } : rest
      return { ...doc, timing: { start_sec: 0, end_sec: null, fade_in_sec: 0, fade_out_sec: 0 } } as SceneOverlayDocument
    }
    const loopInputs = new Map<string, string>()
    for (const { item } of ready) {
      if (item.document.kind === 'living-region') continue
      for (const shape of overlayLoopShapes(drawnDoc(item))) {
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
        const yuv = alloc(), drawnLabel = alloc()
        const compiled = compileSceneOverlay(
          drawnDoc(item),
          { input: yuv, output: drawnLabel, allocLabel: alloc, w, h, duration, fps, loopInput: shape => loopInputs.get(loopShapeKey(shape)) ?? null },
        )
        body = compiled ? [`${work}null${yuv}`, ...compiled, `${drawnLabel}format=yuv420p${effect}`] : null
      }
      if (!body) { opts.log(`${item.name} draws nothing at these settings; skipped.`); continue }
      const mask = maskInputs.get(i)
      statements.push(...(mask
        ? [`${base}split=2${keep}${work}`, ...body, ...regionMergeStatements(keep, effect, mask, next, alloc)]
        : [`${base}null${work}`, ...body, `${effect}null${next}`]))
      base = next
      drawn.push(mask || item.document.kind === 'living-region' ? item.name : `${item.name} (its own band: nothing to follow found)`)
    }
    if (depthClip && opts.depth) {
      const next = alloc()
      statements.push(...compileDepthStage(opts.depth.spec, { input: base, depth: depthInput, output: next, allocLabel: alloc, w, h, fps, duration }))
      base = next
      drawn.push(opts.depth.name)
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
