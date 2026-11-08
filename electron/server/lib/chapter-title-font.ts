/**
 * Chapter title fonts — the ONE place a chapter-heading face is resolved,
 * verified, staged and laid out (1.4.384).
 *
 * The rules, each one the reason a caller exists:
 *
 *  - **No selection means no code runs here.** An absent presentation (or a
 *    presentation with no resolved face) returns null and the legacy chapter
 *    drawtext in `generators/video.ts` emits byte-identical output. Nothing
 *    assigns a face from any other channel setting.
 *  - **The face is a bundled manifest id, never a path or a family guess.**
 *    `thumbnail-fonts.ts` owns the catalogue; this module resolves the id to
 *    its file and refuses when the bytes on disk disagree with the manifest's
 *    SHA-256 — a swapped or truncated font is a loud failure, not a silently
 *    different face (AGENTS §6).
 *  - **Staging copies the verified bytes into the render's own temp dir**, so
 *    drawtext reads the exact file that was hashed — the same bytes a remote
 *    compiler's font closure must carry for this heading (byte identity is
 *    the manifest hash; see the remote-render-parity font-closure rule).
 *  - **Coverage is the font file's own cmap** (`font-coverage.ts`): a heading
 *    the chosen face cannot draw is refused by name, never substituted.
 *  - **Wrap and fit measure with the same Pango path the thumbnail renderer
 *    uses** (`configureFontconfig` + family/size), then hand drawtext whole
 *    lines — drawtext has no word wrap and no auto-fit, so both are decided
 *    here, once, before the filtergraph string is built.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import sharp from 'sharp'

import type { ChapterTitleAppearance, ChapterTitlePresentation } from '../models/types.js'
import { glyphCoverage } from './font-coverage.js'
import {
  configureFontconfig,
  fontFilePath,
  requireFont,
  sha256File,
  type FontManifestEntry,
} from './thumbnail-fonts.js'
import { wrapText } from './thumbnail-text-render.js'

/**
 * sharp's text renderer runs Pango at 72 dpi (its own default `dpi`, and what
 * `metadata().density` reports), so a point IS a pixel there — measured on this
 * build: asking for 100 draws a 72px cap / 53px x-height, i.e. a 100px em, which
 * is the same unit drawtext's `fontsize` takes. Scaling by 96/72 (the thumbnail
 * renderer's convention) would measure a third wider than drawtext draws.
 */
const PX_PER_FONT_UNIT = 1

export interface StagedChapterTitleFont {
  /** The verified copy drawtext reads — absolute path, staged into the render temp dir. */
  fontfile: string
  /** Manifest SHA-256; the staged bytes hash to this same value. */
  sha256: string
  /** The face name, for the job log and the preview's family. */
  family: string
  /** The manifest id that resolved. */
  fontId: string
}

/** The face a presentation names: the explicit pick first, the pool's resolution second. */
export function chapterTitleFontId(presentation: ChapterTitlePresentation | null | undefined): string | null {
  if (!presentation) return null
  const id = presentation.font_id?.trim() || presentation.resolved_font_id?.trim()
  return id || null
}

/**
 * Resolve the presentation's face to verified bytes staged in `destDir`.
 *
 * Returns null when nothing was selected — the caller then renders exactly
 * as it did before this feature existed. An id this build does not ship, or
 * bytes that disagree with the manifest, throws with a plain message.
 */
export async function stageChapterTitleFont(
  presentation: ChapterTitlePresentation | null | undefined,
  destDir: string,
): Promise<StagedChapterTitleFont | null> {
  const fontId = chapterTitleFontId(presentation)
  if (!fontId) return null
  const entry = await requireFont(fontId)
  const source = fontFilePath(entry)
  const sha256 = await sha256File(source)
  if (sha256 !== entry.sha256) {
    throw new Error(
      `Chapter title font "${entry.label}" failed its integrity check: the file at ${source} does not match `
      + `the manifest SHA-256. Story Studio did not render the chapter titles. Reinstall the app if this repeats.`,
    )
  }
  const fontfile = path.join(destDir, `chapter-title-font-${entry.id}${path.extname(entry.file) || '.ttf'}`)
  if (fontfile !== source) {
    await fs.copyFile(source, fontfile)
    // The manifest proved the SOURCE; drawtext reads the STAGED copy, so the
    // copy is the bytes that must hash to the manifest before anything draws.
    const stagedSha = await sha256File(fontfile)
    if (stagedSha !== sha256) {
      throw new Error(
        `Chapter title font "${entry.label}" did not stage cleanly: the copy at ${fontfile} does not match `
        + `the manifest SHA-256. Story Studio did not render the chapter titles. Try again, or reinstall the app if this repeats.`,
      )
    }
  }
  return { fontfile, sha256, family: entry.family, fontId: entry.id }
}

/** Refuse a heading the staged face cannot draw — named characters, never a substitution. */
export async function assertChapterTitleCovers(font: StagedChapterTitleFont, text: string, who: string): Promise<void> {
  const { missing } = await glyphCoverage(font.fontfile, text)
  if (missing.length) {
    throw new Error(
      `${who} cannot be drawn in ${font.family}: no glyph for ${missing.map(c => `"${c}"`).join(', ')}. `
      + 'Pick a font that covers this heading, or turn the chapter font off — Story Studio did not substitute a face.',
    )
  }
}

/** Filtergraph-safe option value for a path: quoted, with the only chars the parser eats escaped. */
export function escapeChapterFontfile(fontfile: string): string {
  return `'${fontfile.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

/** sharp reads text as Pango markup, so a heading's own `&`, `<`, `>` must stay literal. */
export function escapePangoMarkup(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Render one line and trim to its ink, so the size IS the drawn size (thumbnail path, same Pango). */
async function measureLine(text: string, family: string, px: number): Promise<number> {
  configureFontconfig()
  const rendered = await sharp({
    text: { text: escapePangoMarkup(text), font: `${family} Regular ${Math.max(1, Math.round(px * PX_PER_FONT_UNIT))}`, rgba: true },
  }).png().toBuffer()
  try {
    const trimmed = await sharp(rendered).trim({ threshold: 1 }).png().toBuffer()
    const metadata = await sharp(trimmed).metadata()
    return metadata.width ?? 0
  } catch {
    const metadata = await sharp(rendered).metadata()
    return metadata.width ?? 0
  }
}

export interface ChapterTitleLayout {
  fontSize: number
  /** One entry per drawtext line; a single line is `[text]`. */
  lines: string[]
}

/**
 * The lines (and possibly smaller size) one heading needs.
 *
 * `wrap` breaks at spaces / U+200B through the shared Khmer-safe `wrapText`,
 * so a Khmer cluster is never split, and it never drops the tail: the shared
 * helper's line cap is raised out of the way, because a heading that needs
 * nine lines has to KEEP nine. `automaticFit` bisects the size down until the
 * widest line fits `frameWidth * 0.92` and — when `frameHeight` is given — the
 * whole block fits `frameHeight * 0.85` (the bottom anchor's own budget), so
 * the measured block is what the caller positions. Both are opt-in; with
 * neither, the text and size pass through untouched and the caller's legacy
 * single drawtext stands.
 */
export async function layoutChapterTitle(options: {
  text: string
  fontSize: number
  frameWidth: number
  /** Frame height: fit also keeps the whole wrapped block on screen when given. */
  frameHeight?: number
  family: string
  wrap: boolean
  automaticFit: boolean
}): Promise<ChapterTitleLayout> {
  const { text, frameWidth, family } = options
  const maxWidth = Math.max(1, Math.round(frameWidth * 0.92))
  const maxHeight = typeof options.frameHeight === 'number' && Number.isFinite(options.frameHeight) && options.frameHeight > 0
    ? Math.max(1, Math.round(options.frameHeight * 0.85))
    : Number.POSITIVE_INFINITY
  let fontSize = Math.max(1, Math.round(options.fontSize))

  const widest = async (lines: string[], size: number): Promise<number> => {
    let max = 0
    for (const line of lines) max = Math.max(max, await measureLine(line, family, size))
    return max
  }

  const wrapped = async (size: number): Promise<string[]> => {
    if (!options.wrap) return [text]
    const result = await wrapText(text, Number.MAX_SAFE_INTEGER, maxWidth, line => measureLine(line, family, size))
    return result.lines.length ? result.lines : [text]
  }

  /** A candidate fits when its widest line fits the width AND the block fits the height. */
  const fits = async (size: number): Promise<boolean> => {
    const lines = await wrapped(size)
    if (await widest(lines, size) > maxWidth) return false
    return lines.length * Math.round(size * 1.18) <= maxHeight
  }

  if (options.automaticFit) {
    // Bisect down from the style's own size: the largest size whose block fits.
    // The floor scales with the style (8px once the style is big enough) and
    // never rises above it, so a small style can still shrink.
    let low = Math.max(1, Math.min(8, Math.floor(fontSize * 0.4)))
    let high = fontSize
    let best = low
    while (low <= high) {
      const mid = Math.floor((low + high) / 2)
      if (await fits(mid)) {
        best = mid
        low = mid + 1
      } else {
        high = mid - 1
      }
    }
    fontSize = best
  }

  const lines = await wrapped(fontSize)
  return { fontSize, lines }
}

/** The appearance a presentation carries, or null when it names nothing. */
export function chapterTitleAppearance(presentation: ChapterTitlePresentation | null | undefined): ChapterTitleAppearance | null {
  const appearance = presentation?.appearance
  if (!appearance) return null
  if (appearance.color === undefined && appearance.outline === undefined && appearance.wrap === undefined) return null
  return appearance
}

/** Re-exported for callers that already hold the entry (tests, staging proofs). */
export type { FontManifestEntry }
