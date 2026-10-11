/**
 * Scene analysis (E2–E4, 1.4.288): each scene picture's depth map, main subject, points of interest
 * and outlines (sky, water, clouds, flames, ground, plants), from the fleet's vision models through
 * the Gateway, saved beside the episode in `scene-analysis/`.
 *
 *   - Once per picture: an entry is valid while the picture's SHA-256 matches. A replaced picture is
 *     "not analysed"; a different picked model re-analyses it in the background, and until then the
 *     saved result keeps being used (it still matches the picture).
 *   - Low network (owner): a 640 px JPEG (q80) goes up, never the full picture; every task in one
 *     request; the Gateway prefers the Mac that made the picture (`source_job_id`), then the caller's
 *     site. About 55–100 KB per picture both ways.
 *   - Per channel, off by default (`config.scene_analysis`: `depth`, `vision`), and only with a model
 *     picked app-wide (Settings → Connections → Scene analysis models).
 *   - The render only READS these files; it never calls the network. A missing or poor result is a
 *     fallback with a log line, never a failure.
 *
 * ponytail: a small in-process runner, not a Jobs-page job — results are files, so a restart loses
 * nothing but the queue (the next approval, render or "Analyse scenes" picks it up again). Make it a
 * job type if the owner wants it on the Jobs page.
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import { analyzeImage, VisionGatewayError, type VisionAnalyzeAnswer, type VisionTask } from '../lib/scene-vision-client.js'
import type { DepthStageSpec } from '../lib/scene-effect-compiler.js'
import type { FollowRegion, SceneMotionDocument } from '../contracts/scene-effects.js'
import { getAppSetting, setAppSetting } from './app-settings.js'
import { SCENE_ANALYSIS_DIR } from './outline-masks.js'
import { readManifest } from './task-manifest.js'

export { SCENE_ANALYSIS_DIR }
export const SCENE_ANALYSIS_SCHEMA = 1
/** Long side of the copy sent for analysis, and its JPEG quality (measured: ~25–45 MB per 450 scenes). */
export const ANALYSIS_LONG_SIDE = 640
export const ANALYSIS_JPEG_QUALITY = 80
/** Outlines the vision model is asked for (it outlines only what its own caption names). */
export const ASKED_REGIONS = ['sky', 'water', 'clouds', 'fire', 'ground', 'grass', 'tree', 'plant'] as const

// ── Settings ────────────────────────────────────────────────────────────────

export interface SceneAnalysisSwitches { depth: boolean; vision: boolean }
export interface SceneAnalysisModels { depth: string; vision: string }

/** A channel's switches; both off unless set. */
export function sceneAnalysisSwitches(config: unknown): SceneAnalysisSwitches {
  const raw = (config as any)?.scene_analysis
  return { depth: raw?.depth === true, vision: raw?.vision === true }
}

const MODELS_KEY = 'scene_analysis_models'

/** The app-wide picks (Q5). Empty = not picked: nothing is analysed, renders fall back. */
export async function getSceneAnalysisModels(): Promise<SceneAnalysisModels> {
  const raw = await getAppSetting(MODELS_KEY).catch(() => null)
  const text = (v: unknown) => typeof v === 'string' ? v.trim().slice(0, 200) : ''
  return { depth: text(raw?.depth), vision: text(raw?.vision) }
}

export async function setSceneAnalysisModels(value: unknown): Promise<SceneAnalysisModels> {
  const text = (v: unknown) => typeof v === 'string' ? v.trim().slice(0, 200) : ''
  const next = { depth: text((value as any)?.depth), vision: text((value as any)?.vision) }
  await setAppSetting(MODELS_KEY, next)
  return next
}

// ── The saved entry ─────────────────────────────────────────────────────────

export type Box = [number, number, number, number]
export interface SavedRegion { file: string; coverage: number; band: [number, number] }
export interface SceneAnalysisEntry {
  schema: typeof SCENE_ANALYSIS_SCHEMA
  scene_id: string
  image_sha256: string
  analysed_at: string
  models: { depth?: string; vision?: string }
  revisions?: Record<string, string>
  depth?: { file: string; w: number; h: number; p5: number; p50: number; p95: number; range: number; usable: boolean } | null
  subject?: { box: Box; score?: number; label?: string; source: 'grounding' | 'detect' | 'depth'; depth?: number } | null
  points?: Array<{ box: Box; label?: string }>
  regions?: Partial<Record<FollowRegion, SavedRegion | null>>
  caption?: string
  served_by?: VisionAnalyzeAnswer['served_by']
  network?: { request_bytes: number; response_bytes: number }
}

export function sceneAnalysisDir(episodeDir: string): string { return path.join(episodeDir, SCENE_ANALYSIS_DIR) }

function safeId(sceneId: string): string {
  const id = sceneId.replace(/[^A-Za-z0-9_-]/g, '')
  if (!id) throw new Error(`"${sceneId}" is not a scene id`)
  return id
}

const hashCache = new Map<string, { key: string; sha: string }>()
/** SHA-256 of a picture, remembered per path while its size and mtime hold. */
export async function pictureSha256(file: string): Promise<string> {
  const stat = await fs.stat(file)
  const key = `${stat.size}:${stat.mtimeMs}`
  const hit = hashCache.get(file)
  if (hit?.key === key) return hit.sha
  const sha = createHash('sha256').update(await fs.readFile(file)).digest('hex')
  hashCache.set(file, { key, sha })
  return sha
}

/** The saved entry, or null when there is none, it cannot be read, or the picture changed since. */
export async function readSceneAnalysis(episodeDir: string, sceneId: string, stillPath: string | null): Promise<SceneAnalysisEntry | null> {
  try {
    const entry = JSON.parse(await fs.readFile(path.join(sceneAnalysisDir(episodeDir), `${safeId(sceneId)}.json`), 'utf8')) as SceneAnalysisEntry
    if (entry?.schema !== SCENE_ANALYSIS_SCHEMA) return null
    if (stillPath && existsSync(stillPath) && entry.image_sha256 !== await pictureSha256(stillPath)) return null
    return entry
  } catch { return null }
}

// ── What the render reads ───────────────────────────────────────────────────

/** One scene's usable analysis, with absolute paths, as the render and the previews read it. */
export interface SceneVision {
  scene_id: string
  /** Absolute path of a usable depth map, else null (none, or too flat). */
  depthMap: string | null
  depth?: { p5: number; p50: number; p95: number; range: number }
  subject: { box: Box; source: string; depth?: number } | null
  points: Box[]
  /** Found outlines: the file name inside `scene-analysis/` and its band. */
  regions: Partial<Record<FollowRegion, { file: string; band: [number, number] }>>
  /** For the render fingerprint. */
  key: string
}

export function visionFromEntry(episodeDir: string, entry: SceneAnalysisEntry): SceneVision {
  const dir = sceneAnalysisDir(episodeDir)
  const regions: SceneVision['regions'] = {}
  for (const [name, region] of Object.entries(entry.regions || {})) {
    if (region?.file && existsSync(path.join(dir, region.file))) regions[name as FollowRegion] = { file: region.file, band: region.band }
  }
  const depthMap = entry.depth?.usable && existsSync(path.join(dir, entry.depth.file)) ? path.join(dir, entry.depth.file) : null
  return {
    scene_id: entry.scene_id,
    depthMap,
    ...(entry.depth ? { depth: { p5: entry.depth.p5, p50: entry.depth.p50, p95: entry.depth.p95, range: entry.depth.range } } : {}),
    subject: entry.subject ? { box: entry.subject.box, source: entry.subject.source, ...(entry.subject.depth !== undefined ? { depth: entry.subject.depth } : {}) } : null,
    points: (entry.points || []).map(p => p.box),
    regions,
    key: `${entry.image_sha256}|${entry.analysed_at}`,
  }
}

/**
 * Turn a scene's motion into what this scene can draw. Pure: every decision about falling back
 * lives here, so the episode render and both previews agree.
 *
 *  - Zoom to subject: the camera aims at the subject (grounding → detection → nearest large thing
 *    by depth); the end zoom is held so the subject fits with a 15% margin. None → frame centre.
 *  - Guided tour: the subject plus up to two more points, left to right (top to bottom on a tall
 *    picture), closer than 10% merged. Fewer than two → zoom to subject. FFmpeg renders aim at the
 *    first point only (`ffmpeg: true`).
 *  - 3D photo / rack focus: need a usable depth map and an episode with transitions (Q9); otherwise
 *    the move's own camera (a Zoom in) or Blur → Focus.
 */
export function resolveVisionMotion(
  doc: SceneMotionDocument,
  vision: SceneVision | null | undefined,
  opts: { depthAllowed: boolean; ffmpeg?: boolean; blurFocus?: SceneMotionDocument | null },
): { document: SceneMotionDocument; depth: { name: string; map: string; spec: DepthStageSpec } | null; notes: string[] } {
  if (!doc.depth && !doc.rack && !doc.aim) return { document: doc, depth: null, notes: [] }
  const notes: string[] = []
  const { depth: depthField, rack, aim, ...camera } = doc
  let document: SceneMotionDocument = camera
  let depth: { name: string; map: string; spec: DepthStageSpec } | null = null

  if (aim) {
    const subject = vision?.subject ?? null
    if (!subject) {
      notes.push(aim.mode === 'tour' ? 'Guided tour has no subject (scene not analysed, or nothing found), rendered as Zoom in' : 'Zoom to subject found no subject (scene not analysed, or nothing found), rendered as Zoom in')
    } else {
      const [bx, by, bw, bh] = subject.box
      const centre: [number, number] = [Number((bx + bw / 2).toFixed(4)), Number((by + bh / 2).toFixed(4))]
      // The subject keeps a 15% margin at the end zoom.
      const fit = 1 / (1.15 * Math.max(bw, bh, 1e-3))
      const zoom = { ...camera.zoom }
      if (zoom.mode === 'ramp') {
        const cap = Math.max(100, Math.min(zoom.from_pct, zoom.to_pct, fit * 100))
        if (zoom.to_pct > zoom.from_pct) zoom.to_pct = Math.max(zoom.from_pct, Math.min(zoom.to_pct, Math.max(cap, fit * 100)))
        else zoom.from_pct = Math.max(zoom.to_pct, Math.min(zoom.from_pct, Math.max(cap, fit * 100)))
      }
      document = { ...camera, zoom, aim: { mode: 'subject', target: centre } }
      if (aim.mode === 'tour') {
        const path = tourPoints(subject.box, vision!.points)
        if (path.length < 2) notes.push('Guided tour found fewer than two places to visit, rendered as Zoom to subject')
        else if (opts.ffmpeg) notes.push('Guided tour is drawn by the native renderer only; this scene rendered as Zoom to subject')
        else document = { ...camera, zoom: camera.zoom, aim: { mode: 'tour', target: path[0]!, path } }
      }
    }
  }

  if (depthField || rack) {
    const name = depthField ? '3D photo' : 'Rack focus'
    const why = !opts.depthAllowed ? `${name} needs a transition between scenes (this episode cuts)`
      : !vision?.depthMap || !vision.depth ? `${name} needs a depth map (${vision ? 'too flat to use' : 'scene not analysed'})`
      : ''
    if (why) {
      if (rack && opts.blurFocus) { document = opts.blurFocus; notes.push(`${why}, rendered as Blur → Focus`) }
      else notes.push(`${why}, rendered as Zoom in`)
    } else {
      const d = vision!.depth!
      const focus = vision!.subject?.depth ?? d.p50
      depth = {
        name, map: vision!.depthMap!,
        spec: depthField
          ? { parallax: { pct: depthField.parallax_pct, direction: depthField.direction, focus, near: d.p95, far: d.p5 } }
          : { rack: { from: rack!.to === 'subject' ? d.p5 : focus, to: rack!.to === 'subject' ? focus : d.p5, sigma_px: rack!.max_sigma_px, range: d.range } },
      }
    }
  }
  return { document, depth, notes }
}

/** The tour's stops: the subject, then up to two more points, in reading order. */
export function tourPoints(subject: Box, points: readonly Box[]): Array<[number, number]> {
  const centre = (b: Box): [number, number] => [Number((b[0] + b[2] / 2).toFixed(4)), Number((b[1] + b[3] / 2).toFixed(4))]
  const stops: Array<[number, number]> = [centre(subject)]
  for (const box of points) {
    const area = box[2] * box[3]
    if (area < 0.01 || area > 0.6) continue
    const c = centre(box)
    if (stops.some(s => Math.hypot(s[0] - c[0], s[1] - c[1]) < 0.1)) continue
    stops.push(c)
    if (stops.length === 3) break
  }
  // Left to right, so the camera never doubles back.
  return stops.sort((a, b) => a[0] - b[0] || a[1] - b[1])
}

// ── Analysing one picture ───────────────────────────────────────────────────

/** A short subject phrase from a scene's visual prompt: the first sentence that is not about style, its first clause. */
export function subjectPhrase(visualPrompt: unknown): string {
  const text = typeof visualPrompt === 'string' ? visualPrompt.replace(/\s+/g, ' ').trim() : ''
  const style = /\b(pixel art|aesthetic|style|illustration|painting|painted|render|rendered|palette|watercolou?r|cinematic|retro|framing|lighting|composition|shot|photo|art)\b/i
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    const clause = sentence.split(/[,;:]/)[0]!.replace(/[.!?]+$/, '').trim()
      .replace(/^(?:an?|the)?\s*(?:wide|close-up|close up|medium|aerial|overhead)?\s*(?:view|shot|scene|picture|image)\s+of\s+/i, '')
    if (clause.length >= 3 && !style.test(clause)) return clause.slice(0, 80)
  }
  return ''
}

async function greyRaw(png: Buffer): Promise<{ data: Buffer; w: number; h: number }> {
  const { data, info } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true })
  return { data, w: info.width, h: info.height }
}

function encodeGrey(data: Uint8Array, w: number, h: number): Promise<Buffer> {
  return sharp(Buffer.from(data), { raw: { width: w, height: h, channels: 1 } }).png().toBuffer()
}

function percentile(values: Uint8Array, q: number): number {
  const counts = new Array(256).fill(0)
  for (const v of values) counts[v]++
  let seen = 0
  const target = q * values.length
  for (let v = 0; v < 256; v++) { seen += counts[v]; if (seen >= target) return v / 255 }
  return 1
}

/** Resample a grey map to another size (nearest; the maps are small and soft). */
function resample(src: { data: Uint8Array; w: number; h: number }, w: number, h: number): Uint8Array {
  if (src.w === w && src.h === h) return src.data
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const sy = Math.min(src.h - 1, Math.floor((y + 0.5) * src.h / h))
    for (let x = 0; x < w; x++) out[y * w + x] = src.data[sy * src.w + Math.min(src.w - 1, Math.floor((x + 0.5) * src.w / w))]!
  }
  return out
}

/** Rows (0..1) holding the middle 98% of a mask's pixels. */
function maskBand(data: Uint8Array, w: number, h: number): [number, number] {
  const rows: number[] = []
  for (let y = 0; y < h; y++) { let n = 0; for (let x = 0; x < w; x++) if (data[y * w + x]! > 127) n++; rows.push(n) }
  const total = rows.reduce((a, b) => a + b, 0) || 1
  let seen = 0, top = 0, bottom = h - 1
  for (let y = 0; y < h; y++) { seen += rows[y]!; if (seen >= total * 0.01) { top = y; break } }
  seen = 0
  for (let y = h - 1; y >= 0; y--) { seen += rows[y]!; if (seen >= total * 0.01) { bottom = y; break } }
  return [Number((top / h).toFixed(4)), Number(((bottom + 1) / h).toFixed(4))]
}

function coverageOf(data: Uint8Array): number {
  let n = 0
  for (const v of data) if (v > 127) n++
  return n / Math.max(1, data.length)
}

/** Box blur radius r, then a threshold: grows a mask by about r pixels. */
function grow(data: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const tmp = new Float32Array(w * h), out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    let acc = 0
    for (let x = -r; x < w + r; x++) {
      if (x + r < w && x + r >= 0) acc += data[y * w + x + r]! > 127 ? 1 : 0
      if (x - r - 1 >= 0 && x - r - 1 < w) acc -= data[y * w + x - r - 1]! > 127 ? 1 : 0
      if (x >= 0 && x < w) tmp[y * w + x] = acc
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0
    for (let y = -r; y < h + r; y++) {
      if (y + r < h && y + r >= 0) acc += tmp[(y + r) * w + x]!
      if (y - r - 1 >= 0 && y - r - 1 < h) acc -= tmp[(y - r - 1) * w + x]!
      if (y >= 0 && y < h) out[y * w + x] = acc > 0 ? 255 : 0
    }
  }
  return out
}

/** Quality rules (plan §2.4): a subject box under 2% or over 70% of the frame, or scoring under 0.35, is not trusted. */
function trustedBox(box: unknown, score?: number): Box | null {
  if (!Array.isArray(box) || box.length !== 4 || !box.every(v => Number.isFinite(Number(v)))) return null
  const b = box.map(Number) as Box
  const area = b[2] * b[3]
  if (area < 0.02 || area > 0.7) return null
  if (typeof score === 'number' && score < 0.35) return null
  return b
}

/** The nearest large thing by depth, weighted toward the middle: the subject when the vision model found none. */
export function depthSubject(depth: { data: Uint8Array; w: number; h: number }): Box | null {
  const { data, w, h } = depth
  const cut = percentile(data, 0.85) * 255
  let sx = 0, sy = 0, sw = 0
  const xs: number[] = [], ys: number[] = []
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (data[y * w + x]! < cut) continue
    const weight = Math.max(0.05, 1 - Math.hypot(x / w - 0.5, y / h - 0.5) * 1.4)
    sx += x * weight; sy += y * weight; sw += weight
    xs.push(x); ys.push(y)
  }
  if (!sw) return null
  const cx = sx / sw / w, cy = sy / sw / h
  xs.sort((a, b) => a - b); ys.sort((a, b) => a - b)
  const span = (list: number[], size: number) => (list[Math.floor(list.length * 0.9)]! - list[Math.floor(list.length * 0.1)]!) / size
  const bw = Math.min(0.6, Math.max(0.15, span(xs, w))), bh = Math.min(0.6, Math.max(0.15, span(ys, h)))
  return trustedBox([Math.max(0, Math.min(1 - bw, cx - bw / 2)), Math.max(0, Math.min(1 - bh, cy - bh / 2)), bw, bh])
}

function medianInBox(depth: { data: Uint8Array; w: number; h: number }, box: Box): number {
  const x0 = Math.floor(box[0] * depth.w), x1 = Math.ceil((box[0] + box[2]) * depth.w)
  const y0 = Math.floor(box[1] * depth.h), y1 = Math.ceil((box[1] + box[3]) * depth.h)
  const values: number[] = []
  for (let y = Math.max(0, y0); y < Math.min(depth.h, y1); y++) for (let x = Math.max(0, x0); x < Math.min(depth.w, x1); x++) values.push(depth.data[y * depth.w + x]!)
  if (!values.length) return 0.5
  values.sort((a, b) => a - b)
  return values[Math.floor(values.length / 2)]! / 255
}

type Grey = { data: Uint8Array; w: number; h: number }

/** The Hub's own words for fire (it outlines "fire" only when its caption names one of them). */
const FIRE_WORDS = /\b(fire\w*|flames?|flaming|candles?|torch\w*|bonfires?|campfires?|blaze|embers?|hearth|lanterns?)\b/i

async function pictureAt(jpeg: Buffer, w: number, h: number): Promise<Uint8Array> {
  return sharp(jpeg).resize(w, h, { fit: 'fill' }).removeAlpha().raw().toBuffer()
}

function colourDistance(pic: Uint8Array, i: number, c: [number, number, number]): number {
  return Math.hypot(pic[i * 3]! - c[0], pic[i * 3 + 1]! - c[1], pic[i * 3 + 2]! - c[2])
}

/** The middle colour of a mask's pixels, channel by channel. */
function medianColour(pic: Uint8Array, mask: Uint8Array): [number, number, number] | null {
  const channels: number[][] = [[], [], []]
  for (let i = 0; i < mask.length; i++) if (mask[i]! > 127) for (let k = 0; k < 3; k++) channels[k]!.push(pic[i * 3 + k]!)
  if (!channels[0]!.length) return null
  return channels.map(c => { c.sort((a, b) => a - b); return c[Math.floor(c.length / 2)]! }) as [number, number, number]
}

/** Keep only a mask's pixels close to its own middle colour (a polygon that strayed onto the bank drops the bank). */
export function trimByColour(mask: Uint8Array, pic: Uint8Array, tolerance: number): Uint8Array {
  const c = medianColour(pic, mask)
  if (!c) return mask
  return mask.map((v, i) => v > 127 && colourDistance(pic, i, c) <= tolerance ? 255 : 0)
}

/** A mask's parts that touch its top rows, when any do (open sky); else the mask unchanged (sky through a window). */
export function joinedToTop(mask: Uint8Array, w: number, h: number): Uint8Array {
  const top = Math.max(1, Math.round(h * 0.03))
  const out = new Uint8Array(w * h)
  const queue: number[] = []
  for (let i = 0; i < w * top; i++) if (mask[i]! > 127) { out[i] = 255; queue.push(i) }
  if (!queue.length) return mask
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q]!, x = i % w
    for (const n of [i - w, i + w, x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1]) {
      if (n < 0 || n >= out.length || out[n] || mask[n]! <= 127) continue
      out[n] = 255
      queue.push(n)
    }
  }
  return out
}

/** The lowest open-sky row of each column, widened to the lowest within ±25% of the width (sky seen between trees). */
function horizonRows(sky: Grey, w: number, h: number): Int32Array {
  const lowest = new Int32Array(w).fill(-1)
  for (let x = 0; x < w; x++) for (let y = h - 1; y >= 0; y--) if (sky.data[y * w + x]! > 127) { lowest[x] = y + 1; break }
  const reach = Math.max(1, Math.round(w * 0.25))
  const out = new Int32Array(w)
  let fallback = 0
  for (let x = 0; x < w; x++) fallback = Math.max(fallback, lowest[x]!)
  for (let x = 0; x < w; x++) {
    let best = -1
    for (let k = Math.max(0, x - reach); k <= Math.min(w - 1, x + reach); k++) best = Math.max(best, lowest[k]!)
    out[x] = best < 0 ? fallback : best
  }
  return out
}

/**
 * Water as the vision model outlined it, made trustworthy: only pixels of the water's own colour,
 * nothing clearly nearer than the water beside it on the same row (reeds and grass standing in
 * front), nothing in the band just under the sky (hills), then grown along that colour and depth
 * to fill what the outline missed.
 */
export function refineWater(water: Uint8Array, pic: Uint8Array, depth: Uint8Array | null, skyEdge: Int32Array | null, w: number, h: number, top = 0): Grey {
  const c = medianColour(pic, water)
  if (!c) return { data: water, w, h }
  const tolerance = 70, nearer = 0.12 * 255, gap = Math.round(h * 0.15)
  const seed = trimByColour(water, pic, tolerance)
  // Each row's water depth (from the nearest row that has water).
  const rowDepth = new Float32Array(h).fill(NaN)
  if (depth) {
    for (let y = 0; y < h; y++) {
      const values: number[] = []
      for (let x = 0; x < w; x++) if (seed[y * w + x]! > 127) values.push(depth[y * w + x]!)
      if (values.length) { values.sort((a, b) => a - b); rowDepth[y] = values[Math.floor(values.length / 2)]! }
    }
    let last = NaN
    for (let y = 0; y < h; y++) { if (!Number.isNaN(rowDepth[y]!)) last = rowDepth[y]!; else rowDepth[y] = last }
    last = NaN
    for (let y = h - 1; y >= 0; y--) { if (!Number.isNaN(rowDepth[y]!)) last = rowDepth[y]!; else rowDepth[y] = last }
  }
  const ok = (i: number) => {
    const y = Math.floor(i / w), x = i % w
    // Land always lies between the sky and the water we can see: hills and distant trees at night
    // share the water's colour and distance, so water starts 15% of the height below the sky.
    if (y < top || (skyEdge && y < skyEdge[x]! + gap)) return false
    if (colourDistance(pic, i, c) > tolerance) return false
    return !depth || Number.isNaN(rowDepth[y]!) || depth[i]! <= rowDepth[y]! + nearer
  }
  const out = new Uint8Array(w * h)
  const queue: number[] = []
  for (let i = 0; i < seed.length; i++) if (seed[i]! > 127 && ok(i)) { out[i] = 255; queue.push(i) }
  const limit = Math.round(w * h * 0.6)
  let count = queue.length
  for (let q = 0; q < queue.length && count < limit; q++) {
    const i = queue[q]!, x = i % w
    for (const n of [i - w, i + w, x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1]) {
      if (n < 0 || n >= out.length || out[n]) continue
      if (ok(n)) { out[n] = 255; queue.push(n); count++ }
    }
  }
  return { data: out, w, h }
}

/** A soft light round a mask: three box blurs of radius r (close to a Gaussian), full inside the mask. */
export function softGlow(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  let a = Float32Array.from(mask, v => v > 127 ? 1 : 0)
  const blur = (src: Float32Array) => {
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h)
    for (let y = 0; y < h; y++) {
      let acc = 0
      for (let x = -r; x < w + r; x++) {
        if (x + r >= 0 && x + r < w) acc += src[y * w + x + r]!
        if (x - r - 1 >= 0 && x - r - 1 < w) acc -= src[y * w + x - r - 1]!
        if (x >= 0 && x < w) tmp[y * w + x] = acc / (2 * r + 1)
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0
      for (let y = -r; y < h + r; y++) {
        if (y + r >= 0 && y + r < h) acc += tmp[(y + r) * w + x]!
        if (y - r - 1 >= 0 && y - r - 1 < h) acc -= tmp[(y - r - 1) * w + x]!
        if (y >= 0 && y < h) out[y * w + x] = acc / (2 * r + 1)
      }
    }
    return out
  }
  for (let i = 0; i < 3; i++) a = blur(a)
  let max = 0
  for (const v of a) max = Math.max(max, v)
  // Brightest where the flame is; a quarter of the peak already counts as fully lit.
  return Uint8Array.from(a, (v, i) => mask[i]! > 127 ? 255 : Math.min(255, Math.round((v / Math.max(1e-6, max)) * 4 * 255)))
}

/**
 * Flames: the bright, warm, saturated pixels inside the vision model's fire outline (grown 5% of the width),
 * or anywhere when its caption names fire but it drew no outline; grown 1% so the white-hot core
 * is included. Null when nothing like a flame is there.
 */
export function findFlames(fire: Uint8Array | null, pic: Uint8Array, w: number, h: number): Grey | null {
  const where = fire && coverageOf(fire) > 0 && coverageOf(fire) <= 0.85 ? grow(fire, w, h, Math.max(2, Math.round(w * 0.05))) : null
  const hot = new Uint8Array(w * h)
  let n = 0
  for (let i = 0; i < w * h; i++) {
    if (where && where[i]! <= 127) continue
    const r = pic[i * 3]!, g = pic[i * 3 + 1]!, b = pic[i * 3 + 2]!
    // Bright, warm and saturated: a flame, not a cream candle or a lit mug.
    if (r >= 200 && r - b >= 60 && 0.299 * r + 0.587 * g + 0.114 * b >= 160 && (r - Math.min(g, b)) / r >= 0.45) { hot[i] = 255; n++ }
  }
  if (!n) return null
  return { data: grow(hot, w, h, Math.max(1, Math.round(w * 0.01))), w, h }
}

/**
 * Write one answer as the scene's entry: depth checked for flatness, the subject chain, points,
 * outlines checked for coverage, the sky trimmed by depth (Florence Base's sky can run down an
 * alley), and the derived parts (glow round flames, plants, ground, the horizon strip).
 */
export async function saveAnalysis(opts: {
  episodeDir: string
  sceneId: string
  imageSha256: string
  answer: VisionAnalyzeAnswer
  network: { request_bytes: number; response_bytes: number }
  previous?: SceneAnalysisEntry | null
  picked: { depth?: string; vision?: string }
  /** The copy that was analysed, for the outline colour checks. */
  picture?: Buffer
}): Promise<SceneAnalysisEntry> {
  const { answer } = opts
  const id = safeId(opts.sceneId)
  const dir = sceneAnalysisDir(opts.episodeDir)
  await fs.mkdir(dir, { recursive: true })
  const files = new Map<string, Buffer>()
  const prev = opts.previous && opts.previous.image_sha256 === opts.imageSha256 ? opts.previous : null

  let depth: SceneAnalysisEntry['depth'] = prev?.depth ?? null
  let depthRaw: { data: Uint8Array; w: number; h: number } | null = null
  if (answer.depth?.png_b64) {
    const png = Buffer.from(answer.depth.png_b64, 'base64')
    depthRaw = await greyRaw(png)
    const p5 = percentile(depthRaw.data, 0.05), p50 = percentile(depthRaw.data, 0.5), p95 = percentile(depthRaw.data, 0.95)
    depth = { file: `${id}.depth.png`, w: depthRaw.w, h: depthRaw.h, p5, p50, p95, range: Number((p95 - p5).toFixed(4)), usable: p95 - p5 >= 0.15 }
    files.set(depth.file, png)
  } else if (depth && existsSync(path.join(dir, depth.file))) {
    depthRaw = await greyRaw(await fs.readFile(path.join(dir, depth.file)))
  }

  const visionAnswered = answer.subject !== undefined || answer.points !== undefined || answer.segments !== undefined
  let subject: SceneAnalysisEntry['subject'] = visionAnswered ? null : prev?.subject ?? null
  const found = answer.subject ? trustedBox(answer.subject.box, answer.subject.score) : null
  if (found) subject = { box: found, score: answer.subject!.score, label: answer.subject!.label, source: answer.subject!.source === 'detect' ? 'detect' : 'grounding' }
  if (!subject || subject.source === 'depth') {
    const byDepth = depth?.usable && depthRaw ? depthSubject(depthRaw) : null
    subject = byDepth ? { box: byDepth, source: 'depth' } : subject?.source === 'depth' ? null : subject
  }
  if (subject && depthRaw && depth?.usable) subject = { ...subject, depth: Number(medianInBox(depthRaw, subject.box).toFixed(4)) }
  const points = visionAnswered
    ? (answer.points || []).flatMap(p => { const b = trustedBox(p.box) ?? null; return b ? [{ box: b, ...(p.label ? { label: p.label } : {}) }] : [] }).slice(0, 8)
    : prev?.points ?? []

  let regions: SceneAnalysisEntry['regions'] = answer.segments ? {} : prev?.regions
  if (answer.segments) {
    const raw: Partial<Record<string, { data: Uint8Array; w: number; h: number }>> = {}
    for (const [name, seg] of Object.entries(answer.segments)) if (seg?.png_b64) raw[name] = await greyRaw(Buffer.from(seg.png_b64, 'base64'))
    const found: NonNullable<SceneAnalysisEntry['regions']> = regions = {}
    // Every map comes back at the same size; the picture is read at that size for the colour checks.
    const size = Object.values(raw).find(Boolean) ?? (depthRaw ? { w: depthRaw.w, h: depthRaw.h } : null)
    const pic = size && opts.picture ? await pictureAt(opts.picture, size.w, size.h) : null
    const depthAt = size && depthRaw && depth?.usable ? resample(depthRaw, size.w, size.h) : null
    const keep = async (name: FollowRegion, mask: Grey | undefined | null, limits: [number, number] = [0.02, 0.85]) => {
      if (!mask) { found[name] = null; return }
      const coverage = coverageOf(mask.data)
      // Plan §2.4: under 2% or over 85% of the picture is not trusted (a flame may be tiny).
      if (coverage < limits[0] || coverage > limits[1]) { found[name] = null; return }
      const file = `${id}.${name}.png`
      files.set(file, await encodeGrey(mask.data, mask.w, mask.h))
      found[name] = { file, coverage: Number(coverage.toFixed(4)), band: maskBand(mask.data, mask.w, mask.h) }
    }
    const trimmed = (mask: Grey | undefined, tolerance: number): Grey | undefined =>
      mask && pic ? { ...mask, data: trimByColour(resample(mask, size!.w, size!.h), pic, tolerance), w: size!.w, h: size!.h } : mask
    // Sky: drop what depth says is nearer than the sky itself (rooftops, an alley).
    let sky = raw.sky
    if (sky && depthRaw && depth?.usable) {
      const d = resample(depthRaw, sky.w, sky.h)
      const inSkyList: number[] = []
      for (let i = 0; i < sky.data.length; i++) if (sky.data[i]! > 127) inSkyList.push(d[i]!)
      const inSky = Uint8Array.from(inSkyList)
      if (inSky.length) {
        const limit = percentile(inSky, 0.5) * 255 + 0.06 * 255
        sky = { ...sky, data: sky.data.map((v, i) => v > 127 && d[i]! > limit ? 0 : v) }
      }
    }
    // …then only the sky's own colours, and (open sky) only what joins the top of the picture:
    // Florence Base sometimes draws one big polygon over sky, trees and meadow together.
    if (sky && pic) {
      const data = trimByColour(resample(sky, size!.w, size!.h), pic, 80)
      sky = { data: joinedToTop(data, size!.w, size!.h), w: size!.w, h: size!.h }
    }
    await keep('sky', sky)
    // Where the open sky meets the land, per column (an indoor window's sky does not count).
    const skyEdge = found.sky && sky && found.sky.band[0] <= 0.05 ? horizonRows({ data: resample(sky, size!.w, size!.h), w: size!.w, h: size!.h }, size!.w, size!.h) : null
    // Water: its own colour, nothing nearer than the water round it (reeds), grown along that colour.
    // Water lies below the lowest open sky.
    const waterTop = found.sky && skyEdge ? Math.round(found.sky.band[1] * size!.h) : 0
    await keep('water', raw.water && pic ? refineWater(resample(raw.water, size!.w, size!.h), pic, depthAt, skyEdge, size!.w, size!.h, waterTop) : raw.water)
    await keep('clouds', trimmed(raw.clouds, 70))
    // Flames: Florence outlines "fire" loosely (a whole lit window); keep its bright, warm pixels.
    const fireNamed = !!raw.fire || FIRE_WORDS.test(answer.caption || '')
    const flames = fireNamed && pic ? findFlames(raw.fire ? resample(raw.fire, size!.w, size!.h) : null, pic, size!.w, size!.h) : null
    await keep('fire', flames, [0.0005, 0.25])
    await keep('ground', trimmed(raw.ground, 80))
    // Plants: trees, grass and plants together, kept to their own colours.
    const greens = (['tree', 'grass', 'plant'] as const).map(n => raw[n]).filter(Boolean) as Grey[]
    if (greens.length) {
      const { w, h } = size!
      const union = new Uint8Array(w * h)
      for (const g of greens) { const r = resample(g, w, h); for (let i = 0; i < union.length; i++) if (r[i]! > 127) union[i] = 255 }
      // Never over the found sky or water (Florence's polygons can cut straight across both).
      const notElsewhere = async (name: 'sky' | 'water') => found[name] ? (await greyRaw(files.get(found[name]!.file)!)).data : null
      const skyMask = await notElsewhere('sky'), waterMask = await notElsewhere('water')
      for (let i = 0; i < union.length; i++) if ((skyMask && skyMask[i]! > 127) || (waterMask && waterMask[i]! > 127)) union[i] = 0
      // …and green: a polygon round a whole room must not make its wooden walls "plants".
      if (pic) for (let i = 0; i < union.length; i++) if (union[i] && !(pic[i * 3 + 1]! >= pic[i * 3]! && pic[i * 3 + 1]! >= pic[i * 3 + 2]! * 0.9)) union[i] = 0
      await keep('plants', trimmed({ data: union, w, h }, 60))
    } else found.plants = null
    // Glow: the light a found flame throws, about 6% of the width round it.
    await keep('glow', found.fire && flames ? { ...flames, data: softGlow(flames.data, flames.w, flames.h, Math.max(4, Math.round(flames.w * 0.05))) } : undefined, [0.002, 0.6])
    // Horizon: a strip 14% of the height a little below where the open sky meets the land (the
    // foot of the hills and trees standing on the skyline, where mist lies).
    if (skyEdge) {
      const { w, h } = size!
      const strip = new Uint8Array(w * h), from = Math.round(h * 0.06), rows = Math.max(2, Math.round(h * 0.14))
      for (let x = 0; x < w; x++) for (let y = skyEdge[x]! + from; y < Math.min(h, skyEdge[x]! + from + rows); y++) strip[y * w + x] = 255
      await keep('horizon', { data: strip, w, h })
    } else found.horizon = null
  }

  const entry: SceneAnalysisEntry = {
    schema: SCENE_ANALYSIS_SCHEMA,
    scene_id: opts.sceneId,
    image_sha256: opts.imageSha256,
    analysed_at: new Date().toISOString(),
    models: {
      ...(prev?.models || {}),
      ...(answer.depth ? { depth: opts.picked.depth || answer.models?.depth } : {}),
      ...(visionAnswered ? { vision: opts.picked.vision || answer.models?.subject || answer.models?.segments } : {}),
    },
    ...(answer.revisions ? { revisions: { ...(prev?.revisions || {}), ...answer.revisions } } : prev?.revisions ? { revisions: prev.revisions } : {}),
    depth,
    subject,
    points,
    ...(regions ? { regions } : {}),
    ...(answer.caption ? { caption: answer.caption.slice(0, 600) } : prev?.caption ? { caption: prev.caption } : {}),
    ...(answer.served_by ? { served_by: answer.served_by } : {}),
    network: opts.network,
  }
  await withLock(path.join(dir, `${id}.json`), async () => {
    for (const [name, data] of files) {
      const tmp = path.join(dir, `.${name}.${process.pid}.tmp`)
      await fs.writeFile(tmp, data)
      await fs.rename(tmp, path.join(dir, name))
    }
    await writeJsonAtomic(path.join(dir, `${id}.json`), entry)
  })
  return entry
}

/** The 640 px JPEG sent for analysis (never the full picture). */
export async function analysisCopy(stillPath: string): Promise<Buffer> {
  return sharp(stillPath).rotate().resize({ width: ANALYSIS_LONG_SIDE, height: ANALYSIS_LONG_SIDE, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#000000' }).jpeg({ quality: ANALYSIS_JPEG_QUALITY }).toBuffer()
}

/** The Gateway job that made this picture, from its folder's task manifest, so that Mac analyses it. */
async function sourceJobId(stillPath: string): Promise<string | undefined> {
  const manifest = await readManifest(path.dirname(stillPath)).catch(() => null)
  const id = manifest?.tasks?.[path.basename(stillPath)]?.task_id
  return typeof id === 'string' && id ? id : undefined
}

/** What one scene still needs, given the switches and picks. Empty = nothing to do. */
export function tasksNeeded(entry: SceneAnalysisEntry | null, switches: SceneAnalysisSwitches, models: SceneAnalysisModels): VisionTask[] {
  const tasks: VisionTask[] = []
  if (switches.depth && models.depth && entry?.models.depth !== models.depth) tasks.push('depth')
  if (switches.vision && models.vision && entry?.models.vision !== models.vision) tasks.push('subject', 'points', 'segments')
  return tasks
}

export async function analyseScene(opts: {
  episodeDir: string
  sceneId: string
  stillPath: string
  tasks: VisionTask[]
  models: SceneAnalysisModels
  visualPrompt?: string
}): Promise<SceneAnalysisEntry> {
  const sha = await pictureSha256(opts.stillPath)
  const previous = await readSceneAnalysis(opts.episodeDir, opts.sceneId, null)
  const jpeg = await analysisCopy(opts.stillPath)
  const vision = opts.tasks.some(t => t !== 'depth')
  const phrase = vision ? subjectPhrase(opts.visualPrompt) : ''
  const source = await sourceJobId(opts.stillPath)
  const model = [...(opts.tasks.includes('depth') ? [opts.models.depth] : []), ...(vision ? [opts.models.vision] : [])].filter(Boolean)
  const { answer, requestBytes, responseBytes } = await analyzeImage({
    tasks: opts.tasks,
    image: { b64: jpeg.toString('base64'), mime: 'image/jpeg' },
    ...(model.length ? { model } : {}),
    ...(phrase ? { text: phrase } : {}),
    ...(opts.tasks.includes('segments') ? { regions: [...ASKED_REGIONS] } : {}),
    ...(source ? { source_job_id: source } : {}),
    priority: 'background',
  })
  return saveAnalysis({
    episodeDir: opts.episodeDir, sceneId: opts.sceneId, imageSha256: sha, answer,
    network: { request_bytes: requestBytes, response_bytes: responseBytes },
    previous, picked: { depth: opts.models.depth, vision: opts.models.vision }, picture: jpeg,
  })
}

// ── The background runner ───────────────────────────────────────────────────

export interface SceneAnalysisStatus {
  state: 'idle' | 'queued' | 'running' | 'done' | 'partial' | 'off'
  total: number
  done: number
  failed: number
  left: number
  message: string
  network_bytes: number
  started_at?: string
  finished_at?: string
}

export interface SceneToAnalyse { scene_id: string; still: string | null; visual_prompt?: string }

export interface AnalysisRunRequest {
  key: string
  episodeDir: string
  /** Read fresh when the run starts, so a switch or a pick changed meanwhile counts. */
  context: () => Promise<{ switches: SceneAnalysisSwitches; models: SceneAnalysisModels; scenes: SceneToAnalyse[] }>
  only?: string[]
  log?: (line: string) => void
}

const statuses = new Map<string, SceneAnalysisStatus>()
const pending = new Map<string, AnalysisRunRequest>()
let draining: Promise<void> | null = null
/** Test seams. */
export const runnerHooks: { analyse: typeof analyseScene; sleep: (ms: number) => Promise<void> } = {
  analyse: analyseScene,
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
}

export function sceneAnalysisStatus(key: string): SceneAnalysisStatus {
  return statuses.get(key) ?? { state: 'idle', total: 0, done: 0, failed: 0, left: 0, message: '', network_bytes: 0 }
}

/** Queue a run (merged with one already waiting for the same episode). Returns at once. */
export function queueSceneAnalysis(request: AnalysisRunRequest): SceneAnalysisStatus {
  const waiting = pending.get(request.key)
  const only = waiting && request.only && waiting.only ? [...new Set([...waiting.only, ...request.only])] : undefined
  pending.set(request.key, { ...request, ...(only ? { only } : waiting && !waiting.only ? { only: undefined } : {}) })
  const current = statuses.get(request.key)
  if (current?.state !== 'running') statuses.set(request.key, { ...sceneAnalysisStatus(request.key), state: 'queued', message: 'Waiting to start.' })
  if (!draining) draining = drain().finally(() => { draining = null })
  return sceneAnalysisStatus(request.key)
}

/** Test seam: wait for the queue to empty. */
export async function _sceneAnalysisIdle(): Promise<void> { while (draining) await draining }

async function drain(): Promise<void> {
  while (pending.size) {
    const [key, request] = pending.entries().next().value as [string, AnalysisRunRequest]
    pending.delete(key)
    try { await runOne(request) } catch (error: any) {
      statuses.set(key, { ...sceneAnalysisStatus(key), state: 'partial', message: `Scene analysis stopped: ${error?.message || error}`, finished_at: new Date().toISOString() })
    }
  }
}

const IN_FLIGHT = 2
const RETRIES_503 = 3

async function runOne(request: AnalysisRunRequest): Promise<void> {
  const { key } = request
  const log = request.log ?? (() => {})
  const { switches, models, scenes } = await request.context()
  const wanted = scenes.filter(s => !request.only || request.only.includes(s.scene_id))
  const off = !switches.depth && !switches.vision ? 'Scene analysis is off for this channel.'
    : !(switches.depth && models.depth) && !(switches.vision && models.vision) ? 'No scene-analysis model is picked (Settings → Connections).'
    : ''
  if (off) { statuses.set(key, { ...sceneAnalysisStatus(key), state: 'off', total: 0, done: 0, failed: 0, left: 0, message: off }); return }
  const work: Array<{ scene: SceneToAnalyse; tasks: VisionTask[] }> = []
  for (const scene of wanted) {
    if (!scene.still || !existsSync(scene.still)) continue
    const entry = await readSceneAnalysis(request.episodeDir, scene.scene_id, scene.still)
    const tasks = tasksNeeded(entry, switches, models)
    if (tasks.length) work.push({ scene, tasks })
  }
  const status: SceneAnalysisStatus = {
    state: 'running', total: work.length, done: 0, failed: 0, left: work.length, network_bytes: 0,
    message: work.length ? `Analysing ${work.length} scene picture(s)…` : 'Every scene picture is already analysed.',
    started_at: new Date().toISOString(),
  }
  statuses.set(key, status)
  let next = 0
  let stopped = ''
  let failuresInRow = 0
  const worker = async () => {
    while (!stopped && next < work.length) {
      const { scene, tasks } = work[next++]!
      for (let attempt = 0; ; attempt++) {
        try {
          const entry = await runnerHooks.analyse({ episodeDir: request.episodeDir, sceneId: scene.scene_id, stillPath: scene.still!, tasks, models, visualPrompt: scene.visual_prompt })
          status.done++
          status.network_bytes += (entry.network?.request_bytes || 0) + (entry.network?.response_bytes || 0)
          failuresInRow = 0
          break
        } catch (error: any) {
          if (error instanceof VisionGatewayError && error.status === 503 && attempt < RETRIES_503) {
            await runnerHooks.sleep((error.retryAfterSec ?? 30) * 1000)
            continue
          }
          if (error instanceof VisionGatewayError && error.status === 503) stopped = `no Mac can analyse right now (${error.message})`
          status.failed++
          log(`Scene analysis: ${scene.scene_id} failed: ${error?.message || error}`)
          if (++failuresInRow >= 3 && !stopped) stopped = `three pictures in a row failed (last: ${error?.message || error})`
          break
        }
      }
      status.left = work.length - status.done - status.failed
    }
  }
  await Promise.all(Array.from({ length: Math.min(IN_FLIGHT, work.length) }, worker))
  status.left = work.length - status.done - status.failed
  status.finished_at = new Date().toISOString()
  status.state = stopped || status.failed ? 'partial' : 'done'
  status.message = stopped
    ? `Stopped with ${status.left} scene(s) left: ${stopped}. Renders use a plain Zoom in for those.`
    : status.failed ? `${status.done} analysed, ${status.failed} failed; those render with a plain Zoom in.`
    : work.length ? `${status.done} scene picture(s) analysed (${(status.network_bytes / 1e6).toFixed(1)} MB over the network).` : status.message
  log(`Scene analysis: ${status.message}`)
}

// ── Episodes ────────────────────────────────────────────────────────────────

/** The episode's Scene Plan scenes with their pictures, for the runner and the status answer. */
export async function episodeScenesToAnalyse(slug: string, code: string): Promise<{ episodeDir: string; scenes: SceneToAnalyse[] }> {
  const { resolveEpisodePathsByCodeWithSidecar, resolveScenePlanPath } = await import('./utils.js')
  const { SCENE_PLAN_FILENAME } = await import('../generators/scene-plan.js')
  const { resolveSceneImageReadPath } = await import('../generators/scene-image.js')
  const paths = await resolveEpisodePathsByCodeWithSidecar(slug, code, SCENE_PLAN_FILENAME)
  const planPath = await resolveScenePlanPath(slug, code, paths.episode_dir)
  let plan: any = null
  try { plan = JSON.parse(await fs.readFile(planPath, 'utf8')) } catch { plan = null }
  const scenes: SceneToAnalyse[] = []
  for (const scene of Array.isArray(plan?.scenes) ? plan.scenes : []) {
    if (typeof scene?.id !== 'string') continue
    const still = await resolveSceneImageReadPath(slug, code.toUpperCase(), paths.episode_dir, scene.id, scene.image_path).catch(() => null)
    scenes.push({ scene_id: scene.id, still: still && !/\.(mp4|mov|webm|mkv|m4v)$/i.test(still) ? still : null, visual_prompt: typeof scene.visual_prompt === 'string' ? scene.visual_prompt : '' })
  }
  return { episodeDir: paths.episode_dir, scenes }
}

export function episodeAnalysisKey(slug: string, code: string): string { return `${slug}/${code.toUpperCase()}` }

/**
 * Queue an episode's analysis in the background (Scene Review approval, a Pipeline auto-approval,
 * the Effects Library's "Analyse scenes", a model change). Quietly nothing when the channel has it
 * off or no model is picked: the run itself checks, with fresh settings.
 */
export async function queueEpisodeAnalysis(slug: string, code: string, only?: string[]): Promise<SceneAnalysisStatus> {
  const pm = await import('./project-manager.js')
  const { episodeDir } = await episodeScenesToAnalyse(slug, code)
  const { logLine } = await import('./logger.js')
  return queueSceneAnalysis({
    key: episodeAnalysisKey(slug, code),
    episodeDir,
    ...(only?.length ? { only } : {}),
    context: async () => ({
      switches: sceneAnalysisSwitches(await pm.getConfig(slug).catch(() => null)),
      models: await getSceneAnalysisModels(),
      scenes: (await episodeScenesToAnalyse(slug, code)).scenes,
    }),
    log: line => logLine('info', `[scene-analysis] ${slug} ${code.toUpperCase()}: ${line}`),
  })
}

/** Fire-and-forget form for hooks: never throws, never delays the caller. */
export function queueEpisodeAnalysisSoon(slug: string, code: string, only?: string[]): void {
  void (async () => {
    try {
      const pm = await import('./project-manager.js')
      const switches = sceneAnalysisSwitches(await pm.getConfig(slug).catch(() => null))
      if (!switches.depth && !switches.vision) return
      await queueEpisodeAnalysis(slug, code, only)
    } catch { /* the button or the next approval picks it up */ }
  })()
}

/**
 * Q6: a changed pick re-analyses in the background; saved results keep being used until then.
 * ponytail: only episodes whose analysis was written in the last 14 days (the ones in production);
 * older ones re-analyse when someone presses "Analyse scenes".
 */
export async function reanalyseAfterModelChange(): Promise<number> {
  const pm = await import('./project-manager.js')
  let queued = 0
  for (const project of await pm.listProjects().catch(() => [] as any[])) {
    const slug = (project as any).slug
    if (!slug) continue
    const switches = sceneAnalysisSwitches(await pm.getConfig(slug).catch(() => null))
    if (!switches.depth && !switches.vision) continue
    const root = pm.getProjectDir(slug)
    if (!root) continue
    for (const season of await fs.readdir(path.join(root, 'episodes')).catch(() => [] as string[])) {
      for (const episode of await fs.readdir(path.join(root, 'episodes', season)).catch(() => [] as string[])) {
        const dir = path.join(root, 'episodes', season, episode, SCENE_ANALYSIS_DIR)
        const stat = await fs.stat(dir).catch(() => null)
        const code = episode.split(' ')[0]
        if (!stat?.isDirectory() || !code || Date.now() - stat.mtimeMs > 14 * 86400_000) continue
        queueEpisodeAnalysisSoon(slug, code)
        queued++
      }
    }
  }
  return queued
}
