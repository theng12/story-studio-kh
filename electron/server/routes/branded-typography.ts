/**
 * Branded typography — the channel's own switch, accent pool and previews.
 *
 *   GET    /api/projects/:slug/branded-typography                 → settings + the live accents
 *   PUT    /api/projects/:slug/branded-typography                 → save the setting (N is clamped)
 *   POST   /api/projects/:slug/branded-typography/accents         → add/replace a picked PNG {path,label,replace_id?}
 *   POST   /api/projects/:slug/branded-typography/accents/:id/retire → retire (move to Trash)
 *   GET    /api/projects/:slug/episodes/:code/branded-typography  → the accent this episode drew
 *   POST   /api/projects/:slug/episodes/:code/branded-typography/preview → image/png of the resolved candidate
 *
 * A file is picked with the app's ONE picker (`/api/system/pick-file`); this route receives the
 * resulting path and validates it itself. Nothing here deletes: a retired accent moves to Trash.
 */
import { Router } from 'express'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

import { BrandedTypographySchema } from '../contracts/branded-typography.js'
import { validateBody } from '../lib/validate.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'
import { renderThumbnailText } from '../lib/thumbnail-text-render.js'
import * as pm from '../services/project-manager.js'
import { resolveEpisodePathsByCode, resolveEpisodeTitleByCode } from '../services/utils.js'
import {
  accentPathFor,
  addBrandedAccent,
  brandedTypographyView,
  liveAccents,
  readBrandedAssignments,
  retireBrandedAccent,
  resolveEpisodeAccent,
  saveBrandedTypography,
} from '../services/branded-typography.js'
import { accentLayerFor, titleStyleFor, brandedSiblingName } from '../services/branded-thumbnail.js'
import { resolveThumbnailShell } from '../services/thumbnail-shell.js'

export const router = Router()

function fail(res: any, error: any, fallback: string): void {
  const status = typeof error?.statusCode === 'number' ? error.statusCode : 400
  res.status(status).json({ detail: humanizeBackendError(error, fallback) })
}

router.get('/projects/:slug/branded-typography', async (req, res) => {
  try {
    if (!await pm.getProject(req.params.slug)) return res.status(404).json({ detail: 'Project not found' })
    res.json(await brandedTypographyView(req.params.slug))
  } catch (error: any) { fail(res, error, 'Could not read this channel’s branded typography.') }
})

router.put('/projects/:slug/branded-typography', validateBody(BrandedTypographySchema), async (req, res) => {
  try {
    if (!await pm.getProject(req.params.slug)) return res.status(404).json({ detail: 'Project not found' })
    const saved = await saveBrandedTypography(req.params.slug, req.body)
    res.json({ ok: true, ...saved })
  } catch (error: any) { fail(res, error, 'Could not save this channel’s branded typography.') }
})

router.post('/projects/:slug/branded-typography/accents', async (req, res) => {
  try {
    if (!await pm.getProject(req.params.slug)) return res.status(404).json({ detail: 'Project not found' })
    const picked = String(req.body?.path || '')
    const label = typeof req.body?.label === 'string' ? req.body.label : ''
    const replaceId = typeof req.body?.replace_id === 'string' && req.body.replace_id.trim()
      ? req.body.replace_id.trim()
      : null
    // The picker may hand back any file; only a readable image inside a real file is accepted.
    if (!picked) return res.status(400).json({ detail: 'Choose a PNG file for the accent.' })
    const stat = await fs.stat(picked).catch(() => null)
    if (!stat?.isFile()) return res.status(400).json({ detail: 'That accent is not a file Story Studio can read.' })
    const saved = await addBrandedAccent(req.params.slug, picked, label, replaceId)
    res.json({ ok: true, ...saved, ...(await brandedTypographyView(req.params.slug)) })
  } catch (error: any) { fail(res, error, 'Could not add that accent.') }
})

router.get('/projects/:slug/branded-typography/accents/:id/file', async (req, res) => {
  try {
    if (!await pm.getProject(req.params.slug)) return res.status(404).json({ detail: 'Project not found' })
    const projectDir = pm.getProjectDir(req.params.slug)!
    const view = await brandedTypographyView(req.params.slug)
    const accent = view.settings.accents.find(entry => entry.id === String(req.params.id))
    if (!accent) return res.status(404).json({ detail: 'That accent is not in this channel’s list.' })
    const file = accentPathFor(projectDir, accent)
    if (!existsSync(file)) return res.status(404).json({ detail: 'That accent’s file is no longer on disk. Replace or retire it.' })
    res.setHeader('Cache-Control', 'private, max-age=3600')
    res.type('png').send(await fs.readFile(file))
  } catch (error: any) { fail(res, error, 'Could not read that accent.') }
})

router.post('/projects/:slug/branded-typography/accents/:id/retire', async (req, res) => {
  try {
    if (!await pm.getProject(req.params.slug)) return res.status(404).json({ detail: 'Project not found' })
    const retired = await retireBrandedAccent(req.params.slug, String(req.params.id))
    res.json({ ok: true, retired, ...(await brandedTypographyView(req.params.slug)) })
  } catch (error: any) { fail(res, error, 'Could not retire that accent.') }
})

router.get('/projects/:slug/episodes/:code/branded-typography', async (req, res) => {
  try {
    if (!await pm.getProject(req.params.slug)) return res.status(404).json({ detail: 'Project not found' })
    const code = String(req.params.code).toUpperCase()
    const view = await brandedTypographyView(req.params.slug)
    if (!view.configured || !view.settings.enabled) {
      return res.json({ enabled: false, accent: null, source: null, eligible: 0, assignments: {}, clamp_reason: view.clamp_reason })
    }
    const projectDir = pm.getProjectDir(req.params.slug)!
    const resolved = await resolveEpisodeAccent(req.params.slug, projectDir, code, view.settings, null)
    const assignments = await readBrandedAssignments(projectDir)
    const stored = assignments[code]
    res.json({
      enabled: true,
      accent: resolved.pick?.accent || null,
      source: resolved.pick?.source || null,
      eligible: resolved.pick?.eligible ?? 0,
      projected: !stored,
      stored: stored || null,
      clamp_reason: resolved.reason,
    })
  } catch (error: any) { fail(res, error, 'Could not read this episode’s accent.') }
})

/**
 * A preview of the exact candidate this episode would pin: the newest saved art, the title the
 * channel chose, and the accent the pool resolves. Refusals come back as a plain sentence.
 */
router.post('/projects/:slug/episodes/:code/branded-typography/preview', async (req, res) => {
  try {
    if (!await pm.getProject(req.params.slug)) return res.status(404).json({ detail: 'Project not found' })
    const slug = String(req.params.slug)
    const code = String(req.params.code).toUpperCase()
    const view = await brandedTypographyView(slug)
    if (!view.configured || !view.settings.enabled) {
      return res.status(400).json({ detail: 'Branded typography is off for this channel. Turn it on first.' })
    }
    if (!liveAccents(view.settings).length) {
      return res.status(400).json({ detail: 'Add an accent first — there is nothing to draw without one.' })
    }
    const projectDir = pm.getProjectDir(slug)!
    const title = await resolveEpisodeTitleByCode(slug, code).catch(() => '')
    const paths = await resolveEpisodePathsByCode(slug, code)
    const arts = (await fs.readdir(paths.thumb_dir).catch(() => [] as string[]))
      .filter(name => /_v\d+\.png$/i.test(name) && !/_branded\.png$/i.test(name))
      .sort()
    const source = arts.at(-1)
    if (!source) return res.status(400).json({ detail: `There is no saved thumbnail art for ${code} yet. Make the thumbnails first.` })
    const resolved = await resolveEpisodeAccent(slug, projectDir, code, view.settings, null)
    if (!resolved.pick) return res.status(400).json({ detail: resolved.reason || 'No accent could be chosen.' })
    const config = await pm.getConfig(slug)
    const shell = await resolveThumbnailShell(slug, { episode_id: code }, (config || {}) as any)
    // The preview draws the approved title. `separate-hook` reads the prompt's own hook at render
    // time; a preview of it before a prompt exists would be a guess, so it is not invented here.
    const caption = title
    if (!caption.trim()) return res.status(400).json({ detail: `Give ${code} a title first — there are no words to draw.` })
    const rendered = await renderThumbnailText({
      sourceBytes: await fs.readFile(path.join(paths.thumb_dir, source)),
      text: caption,
      style: titleStyleFor(shell.template, view.settings),
      branding: {
        handle: { enabled: false, text: '', font_id: view.settings.title.font_id, weight: 400, size_px: 20, color: '#FFFFFF', opacity: 1 },
        logo: { enabled: false, path: null, width_pct: 10, opacity: 1 },
        position: view.settings.placement.anchor,
        margin_pct: 3,
        accent: accentLayerFor(resolved.pick.accent, view.settings, projectDir),
      },
    })
    res.setHeader('X-Branded-Preview', JSON.stringify({
      source, accent_id: resolved.pick.accent.id, source_kind: resolved.pick.source,
      projected: !(await readBrandedAssignments(projectDir))[code], filename: brandedSiblingName(source),
      clamp_reason: resolved.reason, font_px: rendered.report.font_px,
    }))
    res.type('png').send(rendered.png)
  } catch (error: any) { fail(res, error, 'Could not draw the branded preview.') }
})
