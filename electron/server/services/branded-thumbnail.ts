/**
 * Branded typography — the composited thumbnail written beside the model's art.
 *
 * Runs inside the real thumbnail job (`generators/images.ts` `runThumb`), never as a separate route:
 * the model draws a text-free picture, this draws the channel's own headline in a bundled face plus
 * the episode's accent, and writes `{stem}_v{n}_branded.png` beside an unchanged model file.
 *
 * Order is the contract, because a crash between any two steps must never produce a branded picture
 * that claims something untrue:
 *   1. the SOURCE's sha256 (the exact art this was made from),
 *   2. the candidate (render → file, sidecar beside it, both durable),
 *   3. the episode's stored assignment last. A failed assignment write is `not_branded`, never a
 *      picture whose choice nobody can account for.
 *
 * OFF writes nothing at all, and every file this module writes is a NEW file — the model's art is
 * never touched.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

import type { BrandedAccent, BrandedTypography } from '../contracts/branded-typography.js'
import type { ThumbnailTextStyle } from '../contracts/thumbnail-text.js'
import { renderThumbnailText, type RenderBranding } from '../lib/thumbnail-text-render.js'
import type { ThumbnailTemplate, ThumbnailTextZone } from '../models/types.js'
import {
  accentPathFor,
  liveAccents,
  recordBrandedAssignment,
  resolveEpisodeAccent,
  type BrandedAssignment,
} from './branded-typography.js'

/** The infix that makes a branded picture impossible to mistake for model output. */
export const BRANDED_INFIX = '_branded'
export const BRANDED_SIDECAR_SUFFIX = '_branded.json'

/** YouTube's own thumbnail canvas — the size the renderer draws at. */
const CANVAS = { width: 1280, height: 720 } as const

export interface BrandedSidecar {
  schema: 1
  source_filename: string
  source_sha256: string
  accent_id: string | null
  member_id: string | null
  /** The title setting the words were drawn under. */
  style: { font_id: string; weight: number; source: 'approved-title' | 'separate-hook'; title: string }
  state: 'branded' | 'not_branded'
  reason?: string
  rendered_at: string
}

export function isBrandedFile(filename: string): boolean {
  return new RegExp(`\\${BRANDED_INFIX}\\.png$`, 'i').test(filename)
}

/** `…_v1.png` → `…_v1_branded.png`; the model art's own name is untouched. */
export function brandedFilenameFor(sourceFilename: string): string {
  return `${sourceFilename.replace(/\.[^.]+$/, '')}${BRANDED_INFIX}.png`
}

export function brandedSidecarPathFor(brandedPath: string): string {
  return `${brandedPath.replace(/\.png$/i, '')}.json`
}

/** The branded sibling of a model-art filename (`…_v1_branded.png`). */
export function brandedSiblingName(sourceFilename: string): string {
  return brandedFilenameFor(sourceFilename)
}

async function sha256OfFile(file: string): Promise<string> {
  return createHash('sha256').update(await fs.readFile(file)).digest('hex')
}

// ── the prompt the model receives ──────────────────────────────────────────

/**
 * The title-text directive, as the save step writes it (`image-prompts.ts`
 * `thumbnailPromptClauseTexts`). The stored prompt is untouched; only the copy the model receives
 * loses it, because on a branded thumbnail WE draw the words and the model must leave the space empty.
 */
const TITLE_DIRECTIVE = /\s*Render the exact (?:title|thumbnail hook) ".*?" inside the image as large, highly legible display text using .*?This is the finished thumbnail; do not use placeholder or gibberish lettering\./s
const TITLE_DESIGN_LINE = /\n?TITLE DESIGN: [^\n]*/g
const DRAWING_SENTENCE = /\s*Large [^.]+ text '[^']*' is placed [^.]*\./g

/** The stored prompt with its text-drawing instruction removed. Prose and style wording stay. */
export function stripTitleTextDirective(prompt: string): string {
  return String(prompt || '')
    .replace(TITLE_DIRECTIVE, '')
    .replace(TITLE_DESIGN_LINE, '')
    .replace(DRAWING_SENTENCE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** The words the prompt itself asked the model to draw, when there were any. */
export function promptHookText(prompt: string): string | null {
  const match = String(prompt || '').match(/Render the exact (?:title|thumbnail hook) "([^"]+)"/)
  return match ? match[1]!.trim() || null : null
}

// ── the title's look ───────────────────────────────────────────────────────

/** A neutral starting layout for a channel with no template: one bottom band, large left type. */
const DEFAULT_ZONE: ThumbnailTextZone = {
  name: 'title', x: 'left', y: 'bottom', xOffset: 96, yOffset: 84,
  maxWidth: 1400, fontFamily: '', fontSize: 96, fontWeight: 'black',
  fill: '#FFFFFF', lineHeight: 1.1, textAnchor: 'start',
  shadow: { dx: 0, dy: 4, blur: 10, color: '#000000' },
}

function titleZoneOf(template: ThumbnailTemplate | null): { zone: ThumbnailTextZone; canvas: { width: number; height: number } } {
  const canvas = (template?.canvas && template.canvas.width > 0 && template.canvas.height > 0)
    ? template.canvas
    : { width: 1920, height: 1080 }
  const zones = template?.textZones || []
  const zone = zones.find(z => z.name === 'title') || zones[0] || DEFAULT_ZONE
  return { zone, canvas }
}

/**
 * The template's title zone as the renderer's placement box, with the face and weight the channel
 * chose for branded typography. The layout is the channel's own (it is what the model was told to
 * leave room for); the face is `settings.title` because that is what the owner picked.
 */
export function titleStyleFor(template: ThumbnailTemplate | null, settings: BrandedTypography): ThumbnailTextStyle {
  const { zone, canvas } = titleZoneOf(template)
  const scale = CANVAS.width / canvas.width
  const zoneX = zone.textAnchor === 'end' ? 'right' : zone.textAnchor === 'middle' ? 'center' : zone.x
  // The renderer's nine anchors: middle rows are bare 'left'/'center'/'right', the others are joined.
  const anchorName = (zone.y === 'middle'
    ? (zoneX === 'left' ? 'left' : zoneX === 'right' ? 'right' : 'center')
    : `${zone.y}-${zoneX}`) as ThumbnailTextStyle['placement']['anchor']
  const xPct = zoneX === 'left'
    ? ((zone.xOffset || 0) / canvas.width) * 100
    : zoneX === 'right'
      ? 100 - ((zone.xOffset || 0) / canvas.width) * 100
      : 50 + ((zone.xOffset || 0) / canvas.width) * 100
  const yPct = zone.y === 'top'
    ? ((zone.yOffset || 0) / canvas.height) * 100
    : zone.y === 'bottom'
      ? 100 - ((zone.yOffset || 0) / canvas.height) * 100
      : 50 + ((zone.yOffset || 0) / canvas.height) * 100
  const widthPct = Math.min(100, Math.max(5, ((zone.maxWidth || canvas.width * 0.7) / canvas.width) * 100))
  const lines = zone.defaultText ? Math.min(3, zone.defaultText.split('\n').length) : 2
  const maxPx = Math.max(20, Math.round((zone.fontSize || 96) * scale))
  const heightPct = Math.min(80, Math.max(8, ((maxPx * (zone.lineHeight || 1.1) * lines) / CANVAS.height) * 100))
  return {
    font_id: settings.title.font_id,
    weight: settings.title.weight,
    size: { mode: 'fit', min_px: Math.max(18, Math.round(maxPx * 0.38)), max_px: maxPx },
    max_lines: Math.max(1, Math.min(4, lines + 1)),
    align: zoneX === 'right' ? 'right' : zoneX === 'center' ? 'center' : 'left',
    line_height: Math.max(0.9, Math.min(2, zone.lineHeight || 1.1)),
    letter_spacing: Math.round((zone.letterSpacing || 0) * scale),
    uppercase: zone.uppercase === true,
    fill: { type: 'solid', color: typeof zone.fill === 'string' && zone.fill ? zone.fill : '#FFFFFF' },
    opacity: 1,
    outline: { enabled: false, color: '#000000', width_px: 0 },
    shadow: {
      enabled: true,
      color: typeof zone.shadow?.color === 'string' ? zone.shadow.color : '#000000',
      opacity: 0.65,
      dx: Math.round((zone.shadow?.dx || 0) * scale),
      dy: Math.round((zone.shadow?.dy || 4) * scale),
      blur_px: Math.max(2, Math.round((zone.shadow?.blur || 10) * scale)),
    },
    background: { enabled: false, color: '#000000', opacity: 0.5, padding_px: 20, radius_px: 12 },
    placement: {
      anchor: anchorName,
      x_pct: Math.max(0, Math.min(100, xPct)),
      y_pct: Math.max(0, Math.min(100, yPct)),
      width_pct: widthPct,
      height_pct: heightPct,
    },
  }
}

/** The accent layer in the renderer's own shape. `width_pct` is the accent's share of the canvas. */
export function accentLayerFor(accent: BrandedAccent, settings: BrandedTypography, projectDir: string): NonNullable<RenderBranding['accent']> {
  return {
    enabled: true,
    path: accentPathFor(projectDir, accent),
    // Accents vary in size; a badge is typically 12–22% of the width. Bounded by the contract.
    width_pct: Math.max(4, Math.min(40, Math.round((accent.width / 1920) * 100 * 10) / 10 || 12)),
    opacity: 1,
    anchor: settings.placement.anchor,
    margin_pct: 3,
  }
}

function brandingWithAccent(settings: BrandedTypography, accent: BrandedAccent, projectDir: string): RenderBranding {
  return {
    handle: { enabled: false, text: '', font_id: settings.title.font_id, weight: 400, size_px: 20, color: '#FFFFFF', opacity: 1 },
    logo: { enabled: false, path: null, width_pct: 10, opacity: 1 },
    position: settings.placement.anchor,
    margin_pct: 3,
    accent: accentLayerFor(accent, settings, projectDir),
  }
}

export interface BrandThumbInput {
  slug: string
  projectDir: string
  episodeCode: string
  /** The model's saved art for this variant. Never written to. */
  sourcePath: string
  /** The text-free caption we ask the model for (the prompt's own hook). */
  caption: string
  memberId: string | null
  settings: BrandedTypography
  template: ThumbnailTemplate | null
}

export interface BrandThumbResult {
  state: 'branded' | 'not_branded'
  filename: string | null
  reason: string | null
}

/**
 * Draw the branded picture for one saved variant.
 *
 * Returns `not_branded` with a plain reason — and writes only the sidecar — whenever the picture
 * cannot honestly be made (no accent, no words, a headline that cannot fit). The job keeps its art;
 * an upload then refuses with that same reason rather than sending something nobody composed.
 */
export async function brandThumbVariant(input: BrandThumbInput): Promise<BrandThumbResult> {
  const sourceSha = await sha256OfFile(input.sourcePath)
  const sourceFilename = path.basename(input.sourcePath)
  const brandedPath = path.join(path.dirname(input.sourcePath), brandedFilenameFor(sourceFilename))
  const sidecarPath = brandedSidecarPathFor(brandedPath)
  const writeSidecar = async (sidecar: BrandedSidecar) => {
    await fs.writeFile(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`, { mode: 0o644 })
  }
  const notBranded = async (reason: string): Promise<BrandThumbResult> => {
    await writeSidecar({
      schema: 1,
      source_filename: sourceFilename,
      source_sha256: sourceSha,
      accent_id: null,
      member_id: input.memberId,
      style: { font_id: input.settings.title.font_id, weight: input.settings.title.weight, source: input.settings.title.source, title: '' },
      state: 'not_branded',
      reason,
      rendered_at: new Date().toISOString(),
    })
    return { state: 'not_branded', filename: brandedFilenameFor(sourceFilename), reason }
  }

  const accents = liveAccents(input.settings)
  if (!accents.length) return notBranded('This channel has no accepted accent yet, so no branded picture was made.')
  const { pick } = await resolveEpisodeAccent(input.slug, input.projectDir, input.episodeCode, input.settings, input.memberId)
  if (!pick) return notBranded('No accent could be chosen for this episode.')

  const caption = String(input.caption || '').trim()
  if (!caption) return notBranded('There are no words to draw on this thumbnail.')

  let png: Buffer
  try {
    const rendered = await renderThumbnailText({
      sourceBytes: await fs.readFile(input.sourcePath),
      text: caption,
      style: titleStyleFor(input.template, input.settings),
      canvas: CANVAS,
      branding: brandingWithAccent(input.settings, pick.accent, input.projectDir),
    })
    png = rendered.png
  } catch (error: any) {
    return notBranded(`The headline could not be drawn: ${error?.message || error}`)
  }

  // Candidate first: a temp file renamed into place, so a half-written picture is never served.
  const temporary = `${brandedPath}.partial-${process.pid}-${Date.now()}`
  try {
    await fs.writeFile(temporary, png, { flag: 'wx' })
    await fs.rename(temporary, brandedPath)
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {})
    return notBranded(`The branded picture could not be saved: ${(error as Error)?.message || error}`)
  }
  await writeSidecar({
    schema: 1,
    source_filename: sourceFilename,
    source_sha256: sourceSha,
    accent_id: pick.accent.id,
    member_id: input.memberId,
    style: { font_id: input.settings.title.font_id, weight: input.settings.title.weight, source: input.settings.title.source, title: caption },
    state: 'branded',
    rendered_at: new Date().toISOString(),
  })

  // The assignment is pinned LAST. If it cannot be recorded, the picture is not offered: the sidecar
  // says not_branded and the reason, and upload refuses it.
  const assignment: BrandedAssignment = {
    accent_id: pick.accent.id,
    member_id: input.memberId,
    source: pick.source,
    at: new Date().toISOString(),
  }
  try {
    await recordBrandedAssignment(input.projectDir, input.episodeCode, assignment)
  } catch (error: any) {
    return notBranded(`The picture was drawn, but its accent choice could not be recorded (${error?.message || error}), so it is not offered.`)
  }
  return { state: 'branded', filename: brandedFilenameFor(sourceFilename), reason: null }
}

// ── the upload's view of a branded file ────────────────────────────────────

/**
 * Is this branded file usable for an upload right now?
 *
 * Faithful means: its sidecar says branded, names a live accent, and the source art's sha256 and the
 * picture's own bytes still match what was recorded. A source that changed since (a re-render) makes
 * it stale — the words would sit in the old picture while the upload claims the new one.
 */
export async function brandedStaleness(
  brandedPath: string,
  dir: string,
): Promise<{ stale: boolean; reason: string | null }> {
  if (!existsSync(brandedPath)) {
    return { stale: true, reason: 'The branded thumbnail is not on disk. Re-make the thumbnail with branded typography on.' }
  }
  let sidecar: BrandedSidecar
  try {
    sidecar = JSON.parse(await fs.readFile(brandedSidecarPathFor(brandedPath), 'utf8')) as BrandedSidecar
  } catch {
    return { stale: true, reason: 'The branded thumbnail has no readable record of how it was made, so it was not offered.' }
  }
  if (sidecar.state !== 'branded') {
    return {
      stale: true,
      reason: `This episode's thumbnail was not branded: ${sidecar.reason || 'no reason was recorded'}. `
        + 'Turn branded typography off, or re-make the thumbnail.',
    }
  }
  const sourcePath = path.join(dir, sidecar.source_filename)
  if (!existsSync(sourcePath)) {
    return { stale: true, reason: `The art this branded thumbnail was made from (${sidecar.source_filename}) is gone. Re-make the thumbnail.` }
  }
  const sourceSha = await sha256OfFile(sourcePath)
  if (sourceSha !== sidecar.source_sha256) {
    return {
      stale: true,
      reason: `The thumbnails were re-made after this branded picture (${sidecar.source_filename} changed), so it no longer matches. `
        + 'Use the newest branded thumbnail, or re-make it.',
    }
  }
  return { stale: false, reason: null }
}
