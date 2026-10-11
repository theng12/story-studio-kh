/**
 * Outlines for living pictures (1.4.284).
 *
 * An outline says which part of ONE scene's still may move: white inside,
 * black outside, soft at the edge. It is either an image the owner uploads
 * (stored beside the episode's `scene_effects.json` in `living_masks/`) or a
 * few shapes in 0..1 coordinates. Florence-2 may later draw these outlines
 * automatically; it would write the same files.
 *
 * The render never fails over an outline: a missing or unreadable one makes
 * that effect draw nothing, and the job log says so (lib/scene-stage.ts).
 */

import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { existsSync } from 'fs'

import { OUTLINE_MASK_NAME, type RegionShape, type SceneRegion } from '../contracts/scene-effects.js'
import { runFfmpeg } from '../lib/ffmpeg-utils.js'
import { moveToTrashSync, trashRootFor } from '../lib/trash-move.js'
import { probeVideoStream } from '../lib/scene-clip-compat.js'

export const OUTLINE_MASK_DIR = 'living_masks'
const MIN_SIDE = 64
const MAX_SIDE = 8192
/** Sample size the checks run at: plenty to judge colour, coverage and edge softness. */
const SAMPLE_W = 192

export function outlineMaskPath(episodeDir: string, name: string): string {
  if (!OUTLINE_MASK_NAME.test(name)) throw new Error(`"${name}" is not an outline name (letters, digits, . _ - and .png).`)
  return path.join(episodeDir, OUTLINE_MASK_DIR, name)
}

export interface OutlineCheck {
  width: number
  height: number
  /** Share of the picture inside the outline (brighter than half), 0..1. */
  coverage: number
  /** Share of the picture on a soft edge (neither black nor white). */
  edge_share: number
  colour: boolean
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'story-outline-'))
  try { return await fn(dir) } finally { await fs.rm(dir, { recursive: true, force: true }) }
}

/** Decode any picture FFmpeg can read and measure it as an outline. Throws a plain sentence when it cannot be read. */
export async function checkOutlineImage(file: string): Promise<OutlineCheck> {
  const stream = await probeVideoStream(file)
  const width = Number(stream?.width), height = Number(stream?.height)
  if (!width || !height) throw new Error('The outline could not be read as an image.')
  const sampleH = Math.max(2, Math.round((SAMPLE_W * height) / width))
  const rgb = await withTempDir(async dir => {
    const out = path.join(dir, 'sample.rgb')
    await runFfmpeg(['-v', 'error', '-y', '-i', file, '-frames:v', '1', '-vf', `scale=${SAMPLE_W}:${sampleH}:flags=neighbor,format=rgb24`, '-f', 'rawvideo', out], { timeoutMs: 30_000 })
    return fs.readFile(out)
  })
  const pixels = Math.floor(rgb.length / 3)
  let inside = 0, edge = 0, tinted = 0
  for (let i = 0; i < pixels; i++) {
    const r = rgb[i * 3]!, g = rgb[i * 3 + 1]!, b = rgb[i * 3 + 2]!
    const luma = (r + g + b) / 3
    if (luma > 127) inside++
    if (luma > 24 && luma < 231) edge++
    if (Math.max(r, g, b) - Math.min(r, g, b) > 24) tinted++
  }
  return { width, height, coverage: inside / pixels, edge_share: edge / pixels, colour: tinted / pixels > 0.01 }
}

/** Problems that make an image unusable as an outline, as sentences. Empty = usable. */
export function outlineProblems(check: OutlineCheck, still?: { width: number; height: number } | null): string[] {
  const problems: string[] = []
  if (Math.min(check.width, check.height) < MIN_SIDE || Math.max(check.width, check.height) > MAX_SIDE) {
    problems.push(`The outline is ${check.width}x${check.height}; it must be between ${MIN_SIDE} and ${MAX_SIDE} pixels on each side.`)
  }
  if (check.colour) problems.push('The outline has colour in it. It must be black and white: white for the part that moves, black for the rest.')
  if (check.coverage < 0.002) problems.push('The outline is empty (all black), so nothing would move.')
  if (check.coverage > 0.97) problems.push('The outline covers the whole picture. Use a whole-scene effect instead.')
  if (still && Math.abs(check.width / check.height - still.width / still.height) > 0.02 * (still.width / still.height)) {
    problems.push(`The outline is shaped ${check.width}x${check.height} but the scene picture is ${still.width}x${still.height}; draw it over the scene picture so it lines up.`)
  }
  return problems
}

/**
 * Store an uploaded outline for a scene. Grey-scale only; a hard-edged outline
 * is feathered (a 3 px soften at its own size) so the moving part blends into
 * the still instead of showing a seam. Throws a sentence naming every problem.
 */
export async function saveOutlineMask(opts: {
  episodeDir: string
  sceneId: string
  label?: string
  data: Buffer
  stillPath?: string | null
  /** The channel, so an outline replaced under the same name goes to Story's Trash, not over-written. */
  channel?: { slug: string; projectDir: string }
}): Promise<{ name: string; width: number; height: number; coverage: number; feathered_by_story: boolean }> {
  if (!opts.data.length) throw new Error('The outline upload was empty.')
  if (opts.data.length > 20 * 1024 * 1024) throw new Error('The outline is larger than 20 MB.')
  const slug = (opts.label || 'outline').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'outline'
  const name = `${opts.sceneId.replace(/[^A-Za-z0-9_-]/g, '')}-${slug}.png`.replace(/^-/, '')
  const target = outlineMaskPath(opts.episodeDir, name)
  return withTempDir(async dir => {
    const upload = path.join(dir, 'upload')
    await fs.writeFile(upload, opts.data)
    let check: OutlineCheck
    try { check = await checkOutlineImage(upload) } catch { throw new Error('The outline could not be read as an image (PNG or JPEG, white = the part that moves).') }
    let still: { width: number; height: number } | null = null
    if (opts.stillPath && existsSync(opts.stillPath)) {
      const probed = await probeVideoStream(opts.stillPath)
      if (probed?.width && probed?.height) still = { width: Number(probed.width), height: Number(probed.height) }
    }
    const problems = outlineProblems(check, still)
    if (problems.length) throw new Error(problems.join(' '))
    // Hard edges: under 0.3% of the picture is a soft grey edge.
    const feather = check.edge_share < 0.003
    await fs.mkdir(path.dirname(target), { recursive: true })
    const staged = path.join(dir, 'outline.png')
    await runFfmpeg(['-v', 'error', '-y', '-i', upload, '-frames:v', '1',
      '-vf', `format=gray${feather ? ',gblur=sigma=3' : ''}`, staged], { timeoutMs: 30_000 })
    if (opts.channel && existsSync(target)) {
      const { projectDir, slug } = opts.channel
      const rel = path.relative(projectDir, target)
      const keep = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : path.join('outlines', path.basename(opts.episodeDir), name)
      moveToTrashSync(target, path.join(trashRootFor(path.dirname(target), projectDir, slug), keep), 'outline')
    }
    await fs.rename(staged, target).catch(async () => { await fs.copyFile(staged, target) })
    return { name, width: check.width, height: check.height, coverage: Number(check.coverage.toFixed(4)), feathered_by_story: feather }
  })
}

// ── Drawing an outline at a still's size ────────────────────────────────────

function insideShape(shape: RegionShape, x: number, y: number): boolean {
  switch (shape.type) {
    case 'ellipse': {
      if (shape.rx <= 0 || shape.ry <= 0) return false
      const dx = (x - shape.cx) / shape.rx, dy = (y - shape.cy) / shape.ry
      return dx * dx + dy * dy <= 1
    }
    case 'rect':
      return x >= shape.x && x <= shape.x + shape.w && y >= shape.y && y <= shape.y + shape.h
    case 'polygon': {
      // Even-odd crossing test.
      let inside = false
      const p = shape.points
      for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
        const [xi, yi] = p[i]!, [xj, yj] = p[j]!
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
      }
      return inside
    }
  }
}

/** Shapes as an 8-bit grey raster (PGM body), white inside. */
export function rasterizeShapes(shapes: readonly RegionShape[], width: number, height: number): Buffer {
  const out = Buffer.alloc(width * height)
  for (let py = 0; py < height; py++) {
    const y = (py + 0.5) / height
    for (let px = 0; px < width; px++) {
      const x = (px + 0.5) / width
      if (shapes.some(shape => insideShape(shape, x, y))) out[py * width + px] = 255
    }
  }
  return out
}

/**
 * Write the outline as an RGB PNG exactly the still's size, feathered, ready
 * to be carried through the scene's camera move. Returns a reason instead of
 * throwing when the outline is missing or unreadable.
 */
export async function drawRegionMask(opts: {
  region: SceneRegion
  episodeDir: string | null
  still: { width: number; height: number }
  outPng: string
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { region, still } = opts
  const sigma = (region.feather_px * still.height) / 1080
  const soften = sigma > 0.05 ? `,gblur=sigma=${sigma.toFixed(2)}` : ''
  if (region.mask) {
    if (!opts.episodeDir) return { ok: false, reason: `outline "${region.mask}" needs an episode to be read from` }
    const file = outlineMaskPath(opts.episodeDir, region.mask)
    if (!existsSync(file)) return { ok: false, reason: `outline "${region.mask}" is missing from ${OUTLINE_MASK_DIR}/` }
    try {
      const problems = outlineProblems(await checkOutlineImage(file), still)
      if (problems.length) return { ok: false, reason: `outline "${region.mask}": ${problems.join(' ')}` }
      await runFfmpeg(['-v', 'error', '-y', '-i', file, '-frames:v', '1',
        '-vf', `scale=${still.width}:${still.height}:flags=bicubic,format=gray${soften},format=rgb24`, opts.outPng], { timeoutMs: 60_000 })
      return { ok: true }
    } catch (error: any) {
      return { ok: false, reason: `outline "${region.mask}" could not be read (${String(error?.message || error).split('\n')[0]})` }
    }
  }
  const shapes = region.shapes || []
  if (!shapes.length) return { ok: false, reason: 'no outline (no mask image and no shapes)' }
  const pgm = `${opts.outPng}.pgm`
  try {
    await fs.writeFile(pgm, Buffer.concat([Buffer.from(`P5\n${still.width} ${still.height}\n255\n`), rasterizeShapes(shapes, still.width, still.height)]))
    await runFfmpeg(['-v', 'error', '-y', '-i', pgm, '-frames:v', '1', '-vf', `format=gray${soften},format=rgb24`, opts.outPng], { timeoutMs: 60_000 })
    return { ok: true }
  } catch (error: any) {
    return { ok: false, reason: `outline shapes could not be drawn (${String(error?.message || error).split('\n')[0]})` }
  } finally {
    await fs.unlink(pgm).catch(() => {})
  }
}
