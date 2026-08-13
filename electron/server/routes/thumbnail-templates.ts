/**
 * Routes for the v1.0.105+ thumbnail-template library.
 *
 *   GET  /api/thumbnail-templates                   — list all templates
 *   GET  /api/thumbnail-templates/:id               — single template detail
 *   GET  /api/thumbnail-templates/:id/preview.png   — on-demand preview render
 *
 * Per-project effective resolution lives at the existing
 *   GET  /api/projects/:slug/effective-thumbnail-template
 * which returns the same shape so the picker can show "currently active"
 * without a second roundtrip.
 *
 * The preview render composites the template's SVG overlay on top of a
 * synthetic placeholder portrait (radial gradient with a soft lit area)
 * so the user sees what each template's text layout looks like without
 * needing a real generated thumbnail handy.
 */

import { Router, type Request } from 'express'
import sharp from 'sharp'
import * as pm from '../services/project-manager.js'
import * as nl from '../services/niche-loader.js'
import * as tl from '../services/thumbnail-template-loader.js'
import { composeThumbnail } from '../lib/thumbnail-composer.js'
import { humanizeBackendError, respondWithError } from '../lib/humanize-backend-error.js'
import type { ThumbnailTemplate } from '../models/types.js'
import {
  forkLegacyContentForEdit,
  isUserForkId,
  readUserFork,
  saveUserForkDocument,
} from '../content-packs/user-forks.js'

export const router = Router()

function packOptionsFor(req: Request) {
  return req.app.locals.contentPackOptions || {}
}

// ── Listing + detail ──────────────────────────────────────────────────────

router.get('/thumbnail-templates', async (req, res) => {
  try {
    const list = await tl.listTemplates(packOptionsFor(req))
    res.json({ templates: list })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to list thumbnail templates'))
  }
})

router.get('/thumbnail-templates/:id', async (req, res) => {
  try {
    const t = await tl.loadTemplate(req.params.id, packOptionsFor(req))
    if (!t) return res.status(404).json({ detail: `Template "${req.params.id}" not found` })
    res.json(t)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to load template'))
  }
})

// ── Visual editor: explicit fork + save + delete ───────────────────────────
//
// Built-in templates in the app bundle stay pristine (the user might
// `git pull` and lose tweaks if we wrote back into the bundle dir).
// Editing legacy content creates an immutable-source `user:<uuid>` fork in
// the Content Pack runtime. The bundled or legacy source remains reachable
// for an explicit restore.
//
// User-library templates are edited in place via PUT.

import fs from 'fs/promises'
import path from 'path'

/**
 * POST /thumbnail-templates/:id/fork — copies a legacy template into a new
 * explicit user fork. Every intentional fork receives a distinct identity.
 */
router.post('/thumbnail-templates/:id/fork', async (req, res) => {
  try {
    const sourceId = req.params.id
    const projectSlug = typeof req.body?.project_slug === 'string'
      ? req.body.project_slug
      : (typeof req.query.project_slug === 'string' ? req.query.project_slug : undefined)
    const contentPackOptions = req.app.locals.contentPackOptions || {}
    const result = await forkLegacyContentForEdit({
      kind: 'thumbnail-recipe', legacyId: sourceId, projectSlug,
    }, contentPackOptions)
    const record = await readUserFork(result.fork_id, contentPackOptions)
    if (!record) throw new Error('Created user fork could not be read')
    res.status(201).json({ template: record.document, created: true })
  } catch (e: any) {
    respondWithError(res, e, 'Failed to fork template')
  }
})

/**
 * POST /thumbnail-templates  — create a brand-new user-library template
 * (v1.0.417). Lets the user build a template in-app instead of hand-dropping a
 * JSON file. The id is slugged from `name` (or an explicit `body.id`); on
 * collision with an existing built-in OR user template we suffix `-2`, `-3`, …
 * so a new template never silently overwrites another. Always lands in the
 * user library with `builtin: false`.
 */
router.post('/thumbnail-templates', async (req, res) => {
  try {
    const body = req.body || {}
    if (!body || typeof body !== 'object') return res.status(400).json({ detail: 'Body must be a JSON object' })
    if (typeof body.name !== 'string' || !body.name.trim()) {
      return res.status(400).json({ detail: 'name is required' })
    }
    const slugify = (s: string) => s.toLowerCase().trim()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'template'
    const baseId = (typeof body.id === 'string' && body.id.trim()) ? slugify(body.id) : slugify(body.name)
    // Find a free id (don't clobber a built-in or an existing user template).
    let id = baseId
    for (let n = 2; await tl.loadTemplate(id, packOptionsFor(req)); n++) id = `${baseId}-${n}`

    const created: ThumbnailTemplate = {
      ...body,
      id,
      builtin: false,
      schemaVersion: 1,
      name: body.name.trim(),
      description: typeof body.description === 'string' ? body.description : '',
    }
    await tl.ensureTemplatesDir()
    const filePath = tl.templateFilePath(id)
    await fs.writeFile(filePath, JSON.stringify(created, null, 2) + '\n')
    tl.invalidateTemplateCache(id)
    res.status(201).json({ template: created, created: true })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to create template'))
  }
})

/**
 * PUT /thumbnail-templates/:id — save an existing user fork, or create a
 * new explicit fork when the requested id still names legacy content.
 */
router.put('/thumbnail-templates/:id', async (req, res) => {
  try {
    const id = req.params.id
    const existing = await tl.loadTemplate(id, packOptionsFor(req))
    if (!existing) return res.status(404).json({ detail: `Template "${id}" not found` })
    const body = req.body || {}
    if (!body || typeof body !== 'object') return res.status(400).json({ detail: 'Body must be a JSON object' })
    // Preserve id + builtin flag from disk regardless of what the
    // body claims — the caller shouldn't be changing those.
    const contentPackOptions = req.app.locals.contentPackOptions || {}
    const projectSlug = typeof req.query.project_slug === 'string' ? req.query.project_slug : undefined
    const forkId = isUserForkId(id)
      ? id
      : (await forkLegacyContentForEdit({ kind: 'thumbnail-recipe', legacyId: id, projectSlug }, contentPackOptions)).fork_id
    const merged: ThumbnailTemplate = {
      ...body,
      id: forkId,
      builtin: false,
      schemaVersion: 1,
    }
    // Spot-check required fields so we don't write a malformed JSON
    // that would later throw at loadTemplate.
    if (typeof merged.name !== 'string' || !merged.name) {
      return res.status(400).json({ detail: 'name is required' })
    }
    if (typeof merged.description !== 'string') {
      return res.status(400).json({ detail: 'description is required' })
    }
    await saveUserForkDocument(forkId, merged, contentPackOptions)
    res.json({ template: merged })
  } catch (e: any) {
    respondWithError(res, e, 'Failed to save template')
  }
})

/**
 * DELETE /thumbnail-templates/:id  — removes a user-library template.
 * Refuses to delete built-ins (they live in the app bundle and would
 * just regenerate on next launch).
 */
router.delete('/thumbnail-templates/:id', async (req, res) => {
  try {
    const id = req.params.id
    const existing = await tl.loadTemplate(id, packOptionsFor(req))
    if (!existing) return res.status(404).json({ detail: `Template "${id}" not found` })
    if (existing.builtin) {
      return res.status(403).json({ detail: `"${id}" is a built-in template and cannot be deleted.` })
    }
    const filePath = tl.templateFilePath(id)
    await fs.unlink(filePath)
    tl.invalidateTemplateCache(id)
    res.json({ ok: true, removed: id })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to delete template'))
  }
})

// ── Per-project effective template ─────────────────────────────────────────
//
// Resolves the same chain the compose endpoint uses (project override →
// niche default → legacy inline). Returns `null` when no template
// applies — the gallery picker then shows "no default; pick one".

router.get('/projects/:slug/effective-thumbnail-template', async (req, res) => {
  try {
    const project = await pm.getProject(req.params.slug)
    if (!project) return res.status(404).json({ detail: 'Project not found' })
    const options = packOptionsFor(req)
    const niche = await nl.getEffectiveNicheFor(project, undefined, options)
    const t = await tl.getEffectiveTemplateFor(project, niche, undefined, options)
    res.json({ template: t })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to resolve effective template'))
  }
})

// ── Preview render ─────────────────────────────────────────────────────────
//
// Generates a synthetic placeholder portrait + the template's SVG overlay
// so the user can browse the gallery and see how each template's text
// shape looks before composing for real. Cached per process: the
// placeholder portrait is generated once, then composeThumbnail() is
// called per request with the template's textZones and "EPISODE TITLE
// GOES HERE" placeholder text.

let _placeholderPortraitCache: Buffer | null = null

/**
 * Generate a generic "where the portrait goes" placeholder. Radial
 * gradient from a warm lit center to dark edges — gives the template's
 * dim gradient something visually meaningful to push against. Caching:
 * once per process; the placeholder never changes.
 */
async function getPlaceholderPortrait(canvasW: number, canvasH: number): Promise<Buffer> {
  if (_placeholderPortraitCache) {
    // Cache is at 1920×1080; resize if a non-standard canvas is requested.
    return await sharp(_placeholderPortraitCache)
      .resize(canvasW, canvasH, { fit: 'cover' })
      .toBuffer()
  }
  // SVG with a radial gradient + a soft warmer ellipse where a head
  // would typically sit. Pure SVG so we don't need a shipped image asset.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
    <defs>
      <radialGradient id="bg" cx="50%" cy="60%" r="75%">
        <stop offset="0%" stop-color="#3a3a52" stop-opacity="1"/>
        <stop offset="60%" stop-color="#1c1c2a" stop-opacity="1"/>
        <stop offset="100%" stop-color="#0a0a14" stop-opacity="1"/>
      </radialGradient>
      <radialGradient id="lit" cx="35%" cy="50%" r="22%">
        <stop offset="0%" stop-color="#8b7a5e" stop-opacity="0.7"/>
        <stop offset="100%" stop-color="#8b7a5e" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="1920" height="1080" fill="url(#bg)"/>
    <ellipse cx="672" cy="540" rx="380" ry="450" fill="url(#lit)"/>
    <text x="672" y="560" text-anchor="middle"
          font-family="'Helvetica Neue', Arial, sans-serif"
          font-size="34" fill="#ffffff" fill-opacity="0.32"
          letter-spacing="6">PLACEHOLDER PORTRAIT</text>
  </svg>`
  const generated = await sharp(Buffer.from(svg, 'utf8'))
    .resize(1920, 1080)
    .png()
    .toBuffer()
  _placeholderPortraitCache = generated
  if (canvasW === 1920 && canvasH === 1080) return generated
  return await sharp(generated)
    .resize(canvasW, canvasH, { fit: 'cover' })
    .toBuffer()
}

router.get('/thumbnail-templates/:id/preview.png', async (req, res) => {
  try {
    const t = await tl.loadTemplate(req.params.id, packOptionsFor(req))
    if (!t) return res.status(404).json({ detail: `Template "${req.params.id}" not found` })

    const canvas = t.canvas || { width: 1920, height: 1080 }
    const placeholder = await getPlaceholderPortrait(canvas.width, canvas.height)

    // Use composeThumbnail with the placeholder as source. The compose
    // endpoint always reads from a path on disk, so we write the
    // placeholder to a tmp file. (sharp can pipe Buffer→Buffer
    // directly, but composeThumbnail's API is path-based to mirror the
    // real compose flow — keep the surfaces aligned.)
    const tmpPath = await writeTemp(placeholder, `.tpl-preview-${t.id}.png`)

    const out = await composeThumbnail({
      sourcePath: tmpPath,
      template: t,
      // Placeholder text so the user sees a realistic layout. Use the
      // template's defaultText for subtitle/brand etc; only override
      // the title with a generic example so the user knows where the
      // episode title will land.
      textByZone: { title: 'EPISODE TITLE GOES HERE' },
      context: { episode_title: 'EPISODE TITLE GOES HERE', niche_name: 'PREVIEW' },
    })

    res.setHeader('Content-Type', 'image/png')
    // Encourage in-memory caching for the session — cheaper than a
    // round-trip every time the gallery card scrolls in/out of view.
    res.setHeader('Cache-Control', 'public, max-age=300')
    res.send(out)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to render template preview'))
  }
})

// ── Tmp file helper ─────────────────────────────────────────────────────────

async function writeTemp(buf: Buffer, suffix: string): Promise<string> {
  const os = await import('os')
  const fsp = await import('fs/promises')
  const path = await import('path')
  const dir = os.tmpdir()
  const file = path.join(dir, `sskh-${Date.now()}${suffix}`)
  await fsp.writeFile(file, buf)
  return file
}
