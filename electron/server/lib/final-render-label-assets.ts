import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'

import sharp from 'sharp'

import type { ContextualCue } from '../models/types.js'
import { labelCueForRender, labelOverlayGeometry } from './contextual-cue-filters.js'
import {
  findLabelDesign,
  renderLabelDesign,
  renderLeaderLine,
  renderLabelWipe,
  writeLabelRevealFrames,
} from './label-design-render.js'

/**
 * Prepares the image-backed (`label:`) contextual cues of one composition for
 * the frozen late-label stage (`studio.render.late-label.v3`, freeze revision 1
 * in `_orchestra/remote-render-parity-20261104`).
 *
 * The heavy work is the SAME one the local render does in
 * `generators/video.ts` §6c: `renderLabelDesign` fits the cue's own words into
 * the design's text box, `renderLeaderLine` draws the pointing line, and
 * `writeLabelRevealFrames`/`renderLabelWipe` produce the short entrance. The
 * PNGs written here are the bytes staging copies into the private intent, so
 * the remote render shows exactly what a local render of the same cue shows.
 * Fonts never cross the wire; the four legacy drawtext templates stay local
 * because raster glyphs cannot be byte-identical to FFmpeg drawtext.
 */

export type LateLabelMotion = 'none' | 'pop' | 'slide' | 'float' | 'pulse' | 'wipe' | 'line-draw'

export interface PreparedLabelAssetFile {
  /** Scratch file staging copies into the intent; never a node path on the wire. */
  path: string
  width: number
  height: number
  /** sha256 over the exact written bytes — the exporter names assets without re-reading. */
  sha256: string
  size_bytes: number
}

export interface PreparedLabelRevealFrames {
  frames: Array<{ path: string; progress: number; sha256: string; size_bytes: number }>
  width: number
  height: number
}

export interface PreparedLateLabel {
  /** Packet identity only, derived from the reviewed cue id (lowercase, sanitized). */
  cue_id: string
  motion: LateLabelMotion
  /** COMPOSED clock — the offset is applied here; the reviewed window is never mutated. */
  start_sec: number
  end_sec: number
  x_px: number
  y_px: number
  label: PreparedLabelAssetFile | null
  reveal: PreparedLabelRevealFrames | null
  line: PreparedLabelAssetFile | null
  line_reveal: PreparedLabelRevealFrames | null
}

export interface PreparedLateLabelAssets {
  labels: PreparedLateLabel[]
  /** Cue ids using one of the four legacy drawtext templates — they stay local. */
  drawtext_cue_ids: string[]
  /** Cue ids carrying a template this build does not know — they stay local. */
  unknown_cue_ids: string[]
}

const LEGACY_DRAWTEXT_TEMPLATES = new Set(['documentary-label', 'map-pin', 'archival-caption', 'chapter-plate'])

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function pngHeader(png: Buffer): { width: number; height: number; bit_depth: number; color_type: number; interlace: number } | null {
  if (png.length < 33 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) return null
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
    bit_depth: png[24] as number,
    color_type: png[25] as number,
    interlace: png[28] as number,
  }
}

function hasApngChunks(png: Buffer): boolean {
  let offset = 8
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset)
    if (length > png.length) return false // malformed: let the re-encode below clean it
    if (png.toString('latin1', offset + 4, offset + 8) === 'acTL') return true
    offset += 12 + length
  }
  return false
}

/**
 * The contract allows exactly plain 8-bit RGBA PNGs (colour type 6, no
 * interlace, no APNG). `renderLabelDesign` and the reveal canvases already
 * produce that; a source asset that arrives otherwise is re-encoded with a
 * forced alpha channel rather than hoping the receiver accepts a variant the
 * frozen schema refuses.
 */
async function plainRgbaPng(png: Buffer, what: string): Promise<Buffer> {
  const header = pngHeader(png)
  if (header && header.bit_depth === 8 && header.color_type === 6 && header.interlace === 0 && !hasApngChunks(png)) return png
  const fixed = await sharp(png).ensureAlpha().png().toBuffer()
  const repaired = pngHeader(fixed)
  if (!repaired || repaired.bit_depth !== 8 || repaired.color_type !== 6 || repaired.interlace !== 0 || hasApngChunks(fixed)) {
    throw new Error(`Late-label ${what} could not be encoded as a plain 8-bit RGBA PNG.`)
  }
  return fixed
}

function assertDimensions(png: Buffer, expected: { width: number; height: number }, what: string): void {
  const header = pngHeader(png)
  if (!header || header.width !== expected.width || header.height !== expected.height) {
    throw new Error(`Late-label ${what} is ${header ? `${header.width}x${header.height}` : 'not a readable PNG'} `
      + `but the composition needs ${expected.width}x${expected.height}.`)
  }
}

/** Write one asset file and hash the exact written bytes. */
async function writeAsset(file: string, png: Buffer, expected: { width: number; height: number }, what: string): Promise<PreparedLabelAssetFile> {
  assertDimensions(png, expected, what)
  await fs.writeFile(file, png)
  return {
    path: file,
    width: expected.width,
    height: expected.height,
    sha256: createHash('sha256').update(png).digest('hex'),
    size_bytes: png.length,
  }
}

/** Facts for a file an existing helper already wrote (reveal frames). */
async function writeAssetFacts(file: string, bytes: Buffer, expected: { width: number; height: number }, what: string): Promise<{ sha256: string; size_bytes: number }> {
  assertDimensions(bytes, expected, what)
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size_bytes: bytes.length,
  }
}
/** The wire's cue_id: lowercase, sanitized, unique inside one recipe. */
export function packetCueId(rawId: string, used: Set<string>): string {
  let base = rawId.toLowerCase().replace(/[^a-z0-9_-]/g, '-')
  if (!/^[a-z]/.test(base)) base = `cue-${base}`
  base = base.slice(0, 63) || 'cue'
  let id = base
  for (let n = 2; used.has(id); n++) id = `${base.slice(0, 59)}-${n}`
  used.add(id)
  return id
}

export interface PrepareLateLabelInput {
  cues: readonly ContextualCue[]
  frame_w: number
  frame_h: number
  fps: number
  /** sceneTimelineOffsetSec — moves the reviewed window onto the composed clock. */
  offset_sec: number
  /** The run's existing scratch root (the merged master's directory). */
  dir: string
  log?: (message: string) => void
}

/**
 * Classifies first and renders second: a composition with any legacy drawtext
 * or unknown cue does no image work at all, because the whole render stays
 * local (`contextual_cues_drawtext` / `contextual_cues_unknown_template`) and
 * the local path must be the thing that reports a missing design by name.
 */
export async function prepareFinalRenderLabelAssets(input: PrepareLateLabelInput): Promise<PreparedLateLabelAssets> {
  const drawtext_cue_ids: string[] = []
  const unknown_cue_ids: string[] = []
  const labelCues: Array<{ cue: ContextualCue }> = []
  for (const cue of input.cues) {
    if (cue.template.startsWith('label:')) labelCues.push({ cue })
    else if (LEGACY_DRAWTEXT_TEMPLATES.has(cue.template)) drawtext_cue_ids.push(cue.id)
    else unknown_cue_ids.push(cue.id)
  }
  if (drawtext_cue_ids.length > 0 || unknown_cue_ids.length > 0) {
    return { labels: [], drawtext_cue_ids, unknown_cue_ids }
  }

  await fs.mkdir(input.dir, { recursive: true })
  const used = new Set<string>()
  const labels: PreparedLateLabel[] = []
  for (const { cue } of labelCues) {
    const design = await findLabelDesign(cue.template)
    if (!design) {
      throw new Error(`Label design ${cue.template} is not installed on this Mac. Pick a different design for this label, or restore the pack it came from.`)
    }
    const rendered = await renderLabelDesign({
      design, title: cue.title, subtitle: cue.subtitle, frame_w: input.frame_w, frame_h: input.frame_h,
    })
    const png = await plainRgbaPng(rendered.png, `label ${cue.id}`)
    const renderCue = labelCueForRender(cue, !!design.pointing, input.log ?? (() => undefined))
    const geometry = labelOverlayGeometry(renderCue, rendered, input.frame_w, input.frame_h, input.offset_sec)
    const pointing = !!design.pointing && cue.target_x_pct != null && cue.target_y_pct != null
    // One unique packet identity per cue, minted before any write: the raw id's
    // sanitised form (a_b and a-b) collides, and scratch paths plus the wire's
    // cue_id must all share this exact identity.
    const safeId = packetCueId(cue.id, used)

    const label = renderCue.motion === 'wipe'
      ? null
      : await writeAsset(path.join(input.dir, `label-${safeId}.png`), png,
        { width: rendered.width, height: rendered.height }, `label ${cue.id}`)

    const reveal = renderCue.motion === 'wipe'
      ? await (async () => {
        const files: string[] = []
        await writeLabelRevealFrames(path.join(input.dir, `label-${safeId}-wipe`), input.fps, files,
          progress => renderLabelWipe(png, rendered.width, rendered.height, progress))
        const frames = []
        for (const [index, framePath] of files.entries()) {
          const bytes = await fs.readFile(framePath)
          frames.push({
            path: framePath,
            progress: index / (files.length - 1),
            ...(await writeAssetFacts(framePath, bytes, { width: rendered.width, height: rendered.height }, `reveal frame ${cue.id}`)),
          })
        }
        return { frames, width: rendered.width, height: rendered.height }
      })()
      : null

    const lineInput = {
      frame_w: input.frame_w,
      frame_h: input.frame_h,
      from: { x: geometry.anchor.x / input.frame_w, y: geometry.anchor.y / input.frame_h },
      to: { x: (cue.target_x_pct as number) / 100, y: (cue.target_y_pct as number) / 100 },
    }
    const canvas = { width: input.frame_w, height: input.frame_h }
    const line = pointing && renderCue.motion !== 'line-draw'
      ? await writeAsset(path.join(input.dir, `label-line-${safeId}.png`),
        await plainRgbaPng(await renderLeaderLine(lineInput), `leader line ${cue.id}`), canvas, `leader line ${cue.id}`)
      : null

    const line_reveal = renderCue.motion === 'line-draw'
      ? await (async () => {
        const files: string[] = []
        await writeLabelRevealFrames(path.join(input.dir, `label-line-${safeId}`), input.fps, files,
          async progress => plainRgbaPng(await renderLeaderLine({ ...lineInput, progress }), `leader line ${cue.id}`))
        const frames = []
        for (const [index, framePath] of files.entries()) {
          const bytes = await fs.readFile(framePath)
          frames.push({
            path: framePath,
            progress: index / (files.length - 1),
            ...(await writeAssetFacts(framePath, bytes, canvas, `leader reveal frame ${cue.id}`)),
          })
        }
        return { frames, ...canvas }
      })()
      : null

    labels.push({
      cue_id: safeId,
      motion: (renderCue.motion ?? 'none') as LateLabelMotion,
      start_sec: renderCue.start_sec + input.offset_sec,
      end_sec: renderCue.end_sec + input.offset_sec,
      x_px: geometry.x,
      y_px: geometry.y,
      label,
      reveal,
      line,
      line_reveal,
    })
  }
  return { labels, drawtext_cue_ids, unknown_cue_ids }
}
