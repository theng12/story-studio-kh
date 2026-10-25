/**
 * Thumbnail text layer — routes.
 *
 * The owner generates thumbnail art with no text, then draws a real headline onto a COPY of the
 * chosen thumbnail. The original art is never changed.
 *
 *   GET  /api/thumbnail-text/fonts                                → ThumbnailFont[]
 *   GET  /api/thumbnail-text/presets/builtin                      → ThumbnailTextPreset[]
 *   POST /api/projects/:slug/episodes/:code/thumbnail-text/preview  → image/png | {image_base64, report}
 *   POST /api/projects/:slug/episodes/:code/thumbnail-text/apply    → ThumbnailTextVariant
 *   GET  /api/projects/:slug/episodes/:code/thumbnail-text/variants → ThumbnailTextVariant[]
 *   POST /api/projects/:slug/episodes/:code/thumbnail-text/suggestions → ThumbnailTextSuggestions
 *
 * **Preview response shape.** The frontend accepts either, so this route returns
 * `image/png` bytes with the report JSON in the `X-Thumbnail-Text-Report` response header — the
 * image is the point of the call, and a header makes it one round trip with no base64 inflation.
 * The report is sent on a REFUSAL too (as a 4xx JSON body) so the page can say what was wrong.
 *
 * The source is always a BARE filename resolved inside this episode's own thumbnail folder — the
 * same folder the picker, the pin and the uploader resolve (routes/images.ts). A path is refused,
 * so a request can only ever reach artwork this episode owns.
 */

import { Router } from 'express'
import fsp from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { z } from 'zod'
import * as pm from '../services/project-manager.js'
import { resolveEpisodePathsByCode, resolveEpisodeTitleByCode } from '../services/utils.js'
import { readArtifactRawText, resolveReadPath } from '../lib/episode-artifacts.js'
import { validateBody } from '../lib/validate.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'
import { writeSelectedThumbnail } from '../services/upload-overrides.js'
import { listThumbnailFonts, requireFont } from '../lib/thumbnail-fonts.js'
import { listBuiltinPresets } from '../lib/thumbnail-text-presets.js'
import { renderThumbnailText, ThumbnailTextRefusal } from '../lib/thumbnail-text-render.js'
import {
  buildSidecar,
  listVariants,
  nextVariantPath,
  sha256OfFile,
  sourceIdentity,
  writeSidecar,
} from '../services/thumbnail-text-variants.js'
import { suggestThumbnailHeadlines } from '../services/thumbnail-text-suggestions.js'
import { resolveStoryStudioVersion } from '../lib/app-version.js'
import type { ThumbnailTextStyle } from '../contracts/thumbnail-text.js'

export const router = Router()

/** Where the page is expected to choose a writing model, named in the refusal (AGENTS §1). */
const THUMBNAIL_MODEL_WHERE = 'the Thumbnail Prompts page'

/**
 * A bare image filename in this episode's thumbnail folder.
 *
 * Refusing anything with a separator or a `..` segment is what keeps a render request inside the
 * episode that owns it (the same rule `validateUploadThumbnailFilename` enforces for uploads).
 */
const bareFilename = z.string().trim().min(1).refine(value => path.basename(value) === value, {
  message: 'must be a filename in this episode\'s thumbnail folder, not a path',
}).refine(value => /\.(png|jpe?g)$/i.test(value), {
  message: 'must be a PNG or JPG filename',
})

const styleSchema = z.object({
  font_id: z.string().trim().min(1),
  weight: z.number().int().positive(),
  size: z.object({
    mode: z.enum(['fit', 'fixed']),
    px: z.number().positive().optional(),
    min_px: z.number().positive(),
    max_px: z.number().positive(),
  }),
  max_lines: z.number().int().positive().max(12),
  align: z.enum(['left', 'center', 'right']),
  line_height: z.number().positive().max(4),
  letter_spacing: z.number(),
  uppercase: z.boolean(),
  fill: z.object({
    type: z.enum(['solid', 'gradient']),
    color: z.string().trim().min(1),
    color2: z.string().trim().optional(),
    angle: z.number().optional(),
  }),
  opacity: z.number().min(0).max(1),
  outline: z.object({ enabled: z.boolean(), color: z.string(), width_px: z.number().min(0) }),
  shadow: z.object({
    enabled: z.boolean(), color: z.string(), opacity: z.number().min(0).max(1),
    dx: z.number(), dy: z.number(), blur_px: z.number().min(0),
  }),
  background: z.object({
    enabled: z.boolean(), color: z.string(), opacity: z.number().min(0).max(1),
    padding_px: z.number().min(0), radius_px: z.number().min(0),
  }),
  placement: z.object({
    anchor: z.enum(['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right']),
    x_pct: z.number().min(0).max(100),
    y_pct: z.number().min(0).max(100),
    width_pct: z.number().positive().max(100),
    height_pct: z.number().positive().max(100),
  }),
})

const renderRequestSchema = z.object({
  source_filename: bareFilename,
  text: z.string().min(1).max(400),
  style: styleSchema,
})

const applyRequestSchema = renderRequestSchema.extend({
  pin: z.boolean().optional(),
})

/** Resolve the episode's own thumbnail folder and title, by code (drift-tolerant). */
async function episodeFolder(slug: string, code: string): Promise<{
  title: string
  thumbDir: string
  exists: boolean
}> {
  const title = await resolveEpisodeTitleByCode(slug, code)
  const paths = await resolveEpisodePathsByCode(slug, code)
  return { title, thumbDir: paths.thumb_dir, exists: existsSync(paths.episode_dir) }
}

/** Refuse a source that is not this episode's own file, without echoing a filesystem path back. */
function resolveSource(thumbDir: string, filename: string): string {
  const candidate = path.join(thumbDir, filename)
  // Belt and braces: `bareFilename` already refused separators, and this proves the resolved path
  // is still inside the folder rather than a sibling reached by a crafted name.
  const resolved = path.resolve(candidate)
  if (path.dirname(resolved) !== path.resolve(thumbDir)) {
    throw new ThumbnailTextRefusal('The artwork must be a thumbnail in this episode\'s own folder.')
  }
  if (!existsSync(resolved)) {
    throw new ThumbnailTextRefusal(
      `${filename} is not in this episode's thumbnail folder. Pick the artwork again.`,
    )
  }
  return resolved
}

/** Preview and apply share their resolve+render prologue. */
async function renderForEpisode(slug: string, code: string, body: { source_filename: string, text: string, style: ThumbnailTextStyle }) {
  const folder = await episodeFolder(slug, code)
  if (!folder.exists) {
    throw new ThumbnailTextRefusal(`Episode ${code} has no folder on disk yet, so there is no artwork to draw on.`)
  }
  const sourcePath = resolveSource(folder.thumbDir, body.source_filename)
  const sourceBytes = await fsp.readFile(sourcePath)
  const { png, report } = await renderThumbnailText({
    sourceBytes,
    text: body.text,
    style: body.style,
  })
  return { folder, sourcePath, png, report }
}

/** Answer a refusal in the shape the endpoint promises. */
function refuse(res: any, error: unknown, humanize: string) {
  const message = error instanceof Error ? error.message : String(error)
  // A refusal carries what the renderer learned before it stopped (why it did not fit, which
  // characters are missing) so the page can explain the refusal instead of a bare sentence.
  const report = error instanceof ThumbnailTextRefusal ? error.report : undefined
  return res.status(400).json({ detail: message || humanize, ...(report ? { report } : {}) })
}

// ── Catalogue (global) ─────────────────────────────────────────────────────

router.get('/thumbnail-text/fonts', async (_req, res) => {
  try {
    res.json(await listThumbnailFonts())
  } catch (error: any) {
    res.status(500).json({ detail: `The bundled fonts could not be listed: ${error?.message || error}` })
  }
})

router.get('/thumbnail-text/presets/builtin', async (_req, res) => {
  try {
    res.json(await listBuiltinPresets())
  } catch (error: any) {
    res.status(500).json({ detail: `The built-in looks could not be listed: ${error?.message || error}` })
  }
})

// ── Preview ────────────────────────────────────────────────────────────────

router.post(
  '/projects/:slug/episodes/:code/thumbnail-text/preview',
  validateBody(renderRequestSchema),
  async (req, res) => {
    try {
      const { png, report } = await renderForEpisode(req.params.slug, req.params.code, req.body)
      res.setHeader('Content-Type', 'image/png')
      res.setHeader('Content-Length', String(png.length))
      res.setHeader('Cache-Control', 'no-store')
      // The report travels in a header so the image is one round trip. ASCII-safe: the header
      // carries only counts and flags, and `missing_characters` is empty on any success.
      res.setHeader('X-Thumbnail-Text-Report', JSON.stringify({
        ...report,
        missing_characters: report.missing_characters.map(character => `U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`),
      }))
      res.end(png)
    } catch (error: any) {
      refuse(res, error, 'Could not draw the headline')
    }
  },
)

// ── Apply ──────────────────────────────────────────────────────────────────

router.post(
  '/projects/:slug/episodes/:code/thumbnail-text/apply',
  validateBody(applyRequestSchema),
  async (req, res) => {
    try {
      const slug = req.params.slug
      const code = req.params.code
      const { folder, sourcePath, png, report } = await renderForEpisode(slug, code, req.body)

      // Refuse rather than save something the customer would have to discover is wrong.
      if (!report.glyphs_complete) {
        throw new ThumbnailTextRefusal(
          `Nothing was written: the chosen font cannot draw ${report.missing_characters.join(', ')}. `
          + 'Choose a font that covers this headline, or change the headline.',
          report,
        )
      }
      if (report.overflow) {
        throw new ThumbnailTextRefusal(
          'Nothing was written: the headline does not fit the placement box. '
          + 'Lower the size, raise "max lines", shorten the headline, or widen the box.',
          report,
        )
      }

      const { filename, fullPath } = await nextVariantPath(folder.thumbDir, req.body.source_filename)
      const identity = await sourceIdentity(sourcePath)
      const font = await requireFont(req.body.style.font_id)
      const version = await resolveStoryStudioVersion().catch(() => 'unknown')

      await fsp.writeFile(fullPath, png)
      await writeSidecar(fullPath, buildSidecar({
        sourceFilename: req.body.source_filename,
        sourceSha256: identity.sha256,
        sourceBytes: identity.bytes,
        text: req.body.text,
        style: req.body.style,
        fontSha256: font.sha256,
        appVersion: version,
      }))

      if (req.body.pin === true) {
        await writeSelectedThumbnail(slug, code, folder.title, 'youtube', filename)
      }

      // The Production Board's row for this episode reads the thumbnail folder, so the new file
      // must be visible without a relaunch.
      try {
        const { episodeStatusCache } = await import('../services/episode-status-cache.js')
        episodeStatusCache.invalidate(slug, code)
      } catch { /* cache is best-effort */ }

      res.status(201).json({
        filename,
        source_filename: req.body.source_filename,
        text: req.body.text,
        stale: false,
        stale_reason: null,
      })
    } catch (error: any) {
      refuse(res, error, 'Could not apply the headline')
    }
  },
)

// ── Variants ───────────────────────────────────────────────────────────────

router.get('/projects/:slug/episodes/:code/thumbnail-text/variants', async (req, res) => {
  try {
    const folder = await episodeFolder(req.params.slug, req.params.code)
    if (!folder.exists) return res.json([])
    res.json(await listVariants(folder.thumbDir))
  } catch (error: any) {
    res.status(500).json(humanizeBackendError(error, 'Could not list the text variants'))
  }
})

// ── Suggestions ────────────────────────────────────────────────────────────

router.post('/projects/:slug/episodes/:code/thumbnail-text/suggestions', async (req, res) => {
  try {
    const slug = req.params.slug
    const code = req.params.code
    const config = await pm.getConfig(slug)
    if (!config) return res.status(404).json({ detail: 'Project not found' })

    const title = await resolveEpisodeTitleByCode(slug, code)
    const paths = await resolveEpisodePathsByCode(slug, code)
    // The narration is the episode's own story text; the script directory is where it lives.
    const script = await readArtifactRawText(resolveReadPath(paths.narration_docx)).catch(() => '')

    const result = await suggestThumbnailHeadlines({
      config,
      source: { title, script, channelLanguage: (config as any).content_language ?? null },
      where: THUMBNAIL_MODEL_WHERE,
    })
    res.json(result)
  } catch (error: any) {
    // A model-less preset, or an unusable chosen model, is a plain 400 with its own sentence.
    res.status(400).json({ detail: error?.message || 'Could not suggest headlines' })
  }
})

void sha256OfFile
