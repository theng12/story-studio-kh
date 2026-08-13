/**
 * Image-to-image reference uploads for /projects/:slug/images.
 *
 *   POST   /api/projects/:slug/episodes/:id/img2img-references/master
 *   POST   /api/projects/:slug/episodes/:id/img2img-references/scene/:n
 *     body: { filename, data_base64 }
 *     Saves the decoded PNG to <episode_dir>/img2img-references/.
 *     Mirrors the base64-in-JSON pattern characters.ts uses (no
 *     multipart parser dependency).
 *
 *   DELETE /api/projects/:slug/episodes/:id/img2img-references/master
 *   DELETE /api/projects/:slug/episodes/:id/img2img-references/scene/:n
 *
 *   GET    /api/projects/:slug/episodes/:id/img2img-references
 *     Returns: { master?: { url, size_bytes }, scenes: [{ number, url, size_bytes }] }
 *     Lets the UI re-render drop-zones with previews after navigation.
 *
 *   GET    /api/projects/:slug/episodes/:id/img2img-references/file/:filename
 *     Streams the raw PNG so the renderer can drop the URL into <img>.
 */

import path from 'path'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import { Router } from 'express'
import * as pm from '../services/project-manager.js'
import * as jq from '../services/job-queue.js'
import { resolveEpisodePaths } from '../services/utils.js'
import { resolveEpisodeDir } from '../lib/folder-resolver.js'
import type { JobType } from '../models/types.js'

export const router = Router()

/**
 * LOCAL storage bound only — 10 MB, img2img refs can be larger than character
 * portraits. It is NOT a statement about what any image model accepts.
 *
 * The pixel ceiling is a published, per-model figure
 * (`reference_image_max_dimension`) and is enforced where the selected model
 * is known: providers/image/genstudio.ts, before the reference is uploaded.
 * This route has no model in scope, so it must not pretend to be that check —
 * and a byte cap is not one anyway: a 9 MB 8000x8000 PNG passes here.
 */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MASTER_FILENAME = 'master.png'
const THUMBNAIL_FILENAME = 'thumbnail.png'
const STYLE_FILENAME = 'style.png'  // v1.0.229 — continuity style reference
const COMPOSITION_FILENAME = 'composition.png'  // v1.0.260 — explainer layout template

/**
 * Resolve the per-episode references directory.
 *
 * Two subtleties matter here:
 *
 *   1. We resolve the episode folder by code-prefix lookup
 *      (`resolveEpisodeDir`), not by computing it from the request's
 *      `title`. If the user renamed the idea title and title-sync
 *      didn't reach the disk, `resolveEpisodePaths` would point at a
 *      brand-new "EP0001 - <new title>" path that doesn't exist on
 *      disk — and `mkdir(recursive)` would happily create it as a
 *      sibling of the real folder, scattering refs across two
 *      locations. Looking up by the `${code} - ` prefix sidesteps
 *      that whole class of stale-title duplicates.
 *
 *   2. `create` defaults to false. The GET listing + GET file routes
 *      simply READ refs that may or may not exist; they should never
 *      have the side effect of leaving an empty `img2img-references/`
 *      folder behind just because the user opened the Image → Image
 *      tab to look. Only the POST upload paths flip create=true since
 *      they're about to write a file there.
 */
async function refsDir(
  slug: string,
  episodeId: string,
  title: string,
  opts: { create?: boolean } = {},
): Promise<string> {
  const paths = await resolveEpisodePaths(slug, episodeId, title || '')
  let episodeDir = paths.episode_dir.replace(/\/$/, '')
  const seasonDir = path.dirname(episodeDir)
  const actualDir = await resolveEpisodeDir(seasonDir, episodeId)
  if (actualDir) episodeDir = actualDir
  const dir = path.join(episodeDir, 'img2img-references')
  if (opts.create) await fs.mkdir(dir, { recursive: true })
  return dir
}

function sceneFilename(n: number): string {
  return `scene-${String(n).padStart(2, '0')}.png`
}

function fileUrl(slug: string, episodeId: string, filename: string): string {
  return `/api/projects/${slug}/episodes/${episodeId}/img2img-references/file/${encodeURIComponent(filename)}`
}

// ── POST master ──────────────────────────────────────────────────────────
router.post('/projects/:slug/episodes/:episodeId/img2img-references/master', async (req, res) => {
  const { slug, episodeId } = req.params
  const titleParam = (req.body?.title as string | undefined) || (req.query.title as string) || ''
  try {
    const project = await pm.getProject(slug)
    if (!project) return res.status(404).json({ detail: 'Project not found' })
    const buf = decodeUploadBuffer(req.body)
    if (!buf.ok) return res.status(buf.status).json({ detail: buf.detail })
    const dir = await refsDir(slug, episodeId, titleParam, { create: true })
    const target = path.join(dir, MASTER_FILENAME)
    await fs.writeFile(target, buf.data)
    res.json({
      ok: true,
      url: fileUrl(slug, episodeId, MASTER_FILENAME),
      size_bytes: buf.data.length,
    })
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'Failed to save master reference' })
  }
})

// ── POST thumbnail reference ─────────────────────────────────────────────
// Dedicated to Thumbnail Generator so its channel/reference cover never
// overwrites the Scene Generator's episode-wide master reference.
router.post('/projects/:slug/episodes/:episodeId/img2img-references/thumbnail', async (req, res) => {
  const { slug, episodeId } = req.params
  const titleParam = (req.body?.title as string | undefined) || (req.query.title as string) || ''
  try {
    const project = await pm.getProject(slug)
    if (!project) return res.status(404).json({ detail: 'Project not found' })
    const buf = decodeUploadBuffer(req.body)
    if (!buf.ok) return res.status(buf.status).json({ detail: buf.detail })
    const dir = await refsDir(slug, episodeId, titleParam, { create: true })
    await fs.writeFile(path.join(dir, THUMBNAIL_FILENAME), buf.data)
    res.json({
      ok: true,
      url: fileUrl(slug, episodeId, THUMBNAIL_FILENAME),
      size_bytes: buf.data.length,
    })
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'Failed to save thumbnail reference' })
  }
})

// ── POST style ───────────────────────────────────────────────────────────
// v1.0.229 — continuity-chain style reference (saved as style.png alongside
// the master sheet). Attached to every scene when references.style is on.
router.post('/projects/:slug/episodes/:episodeId/img2img-references/style', async (req, res) => {
  const { slug, episodeId } = req.params
  const titleParam = (req.body?.title as string | undefined) || (req.query.title as string) || ''
  try {
    const project = await pm.getProject(slug)
    if (!project) return res.status(404).json({ detail: 'Project not found' })
    const buf = decodeUploadBuffer(req.body)
    if (!buf.ok) return res.status(buf.status).json({ detail: buf.detail })
    const dir = await refsDir(slug, episodeId, titleParam, { create: true })
    await fs.writeFile(path.join(dir, STYLE_FILENAME), buf.data)
    res.json({ ok: true, url: fileUrl(slug, episodeId, STYLE_FILENAME), size_bytes: buf.data.length })
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'Failed to save style reference' })
  }
})

// ── POST composition template ────────────────────────────────────────────
// v1.0.260 — explainer composition template (saved as composition.png). The
// LAYOUT every scene is img2img-structured against when references.composition
// is on: subject framed as the centrepiece, guide character at the side.
router.post('/projects/:slug/episodes/:episodeId/img2img-references/composition', async (req, res) => {
  const { slug, episodeId } = req.params
  const titleParam = (req.body?.title as string | undefined) || (req.query.title as string) || ''
  try {
    const project = await pm.getProject(slug)
    if (!project) return res.status(404).json({ detail: 'Project not found' })
    const buf = decodeUploadBuffer(req.body)
    if (!buf.ok) return res.status(buf.status).json({ detail: buf.detail })
    const dir = await refsDir(slug, episodeId, titleParam, { create: true })
    await fs.writeFile(path.join(dir, COMPOSITION_FILENAME), buf.data)
    res.json({ ok: true, url: fileUrl(slug, episodeId, COMPOSITION_FILENAME), size_bytes: buf.data.length })
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'Failed to save composition template' })
  }
})

// ── POST per-scene ───────────────────────────────────────────────────────
router.post('/projects/:slug/episodes/:episodeId/img2img-references/scene/:n', async (req, res) => {
  const { slug, episodeId } = req.params
  const n = Number(req.params.n)
  if (!Number.isFinite(n) || n < 1 || n > 999) {
    return res.status(400).json({ detail: 'invalid scene number' })
  }
  const titleParam = (req.body?.title as string | undefined) || (req.query.title as string) || ''
  try {
    const project = await pm.getProject(slug)
    if (!project) return res.status(404).json({ detail: 'Project not found' })
    const buf = decodeUploadBuffer(req.body)
    if (!buf.ok) return res.status(buf.status).json({ detail: buf.detail })
    const dir = await refsDir(slug, episodeId, titleParam, { create: true })
    const filename = sceneFilename(n)
    await fs.writeFile(path.join(dir, filename), buf.data)
    res.json({
      ok: true,
      number: n,
      url: fileUrl(slug, episodeId, filename),
      size_bytes: buf.data.length,
    })
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'Failed to save scene reference' })
  }
})

// ── DELETE master ────────────────────────────────────────────────────────
router.delete('/projects/:slug/episodes/:episodeId/img2img-references/master', async (req, res) => {
  const { slug, episodeId } = req.params
  const titleParam = (req.query.title as string) || ''
  try {
    const dir = await refsDir(slug, episodeId, titleParam)
    const target = path.join(dir, MASTER_FILENAME)
    if (existsSync(target)) await fs.rm(target)
    res.json({ ok: true })
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'Failed to delete master reference' })
  }
})

router.delete('/projects/:slug/episodes/:episodeId/img2img-references/thumbnail', async (req, res) => {
  const { slug, episodeId } = req.params
  const titleParam = (req.query.title as string) || ''
  try {
    const dir = await refsDir(slug, episodeId, titleParam)
    const target = path.join(dir, THUMBNAIL_FILENAME)
    if (existsSync(target)) await fs.rm(target)
    res.json({ ok: true })
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'Failed to delete thumbnail reference' })
  }
})

// ── DELETE style ─────────────────────────────────────────────────────────
router.delete('/projects/:slug/episodes/:episodeId/img2img-references/style', async (req, res) => {
  const { slug, episodeId } = req.params
  const titleParam = (req.query.title as string) || ''
  try {
    const dir = await refsDir(slug, episodeId, titleParam)
    const target = path.join(dir, STYLE_FILENAME)
    if (existsSync(target)) await fs.rm(target)
    res.json({ ok: true })
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'Failed to delete style reference' })
  }
})

// ── POST composition template — GENERATE from prompt ─────────────────────
// v1.0.260 — render the layout template with an image model instead of
// uploading one. Enqueues a job that saves the result to composition.png.
router.post('/projects/:slug/episodes/:episodeId/img2img-references/composition/generate', async (req, res) => {
  const { slug, episodeId } = req.params
  if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : ''
  const model = typeof req.body?.model === 'string' ? req.body.model.trim() : ''
  const aspectRatio = typeof req.body?.aspect_ratio === 'string' ? req.body.aspect_ratio.trim() : '16:9'
  const title = typeof req.body?.title === 'string' ? req.body.title : ''
  if (!prompt) return res.status(400).json({ detail: 'prompt is required' })
  if (!model) return res.status(400).json({ detail: 'model is required' })

  if (jq.isDuplicate(slug, episodeId, 'composition_generate' as JobType)) {
    return res.status(409).json({ detail: `A composition template is already being generated for ${episodeId}` })
  }
  const job = await jq.enqueue({
    project_slug: slug,
    type: 'composition_generate' as JobType,
    episode_id: episodeId,
    title: `Composition template — ${episodeId}`,
    params: { episode_id: episodeId, title, prompt, model, aspect_ratio: aspectRatio },
  })
  res.status(201).json(job)
})

// ── DELETE composition template ──────────────────────────────────────────
router.delete('/projects/:slug/episodes/:episodeId/img2img-references/composition', async (req, res) => {
  const { slug, episodeId } = req.params
  const titleParam = (req.query.title as string) || ''
  try {
    const dir = await refsDir(slug, episodeId, titleParam)
    const target = path.join(dir, COMPOSITION_FILENAME)
    if (existsSync(target)) await fs.rm(target)
    res.json({ ok: true })
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'Failed to delete composition template' })
  }
})

// ── DELETE per-scene ─────────────────────────────────────────────────────
router.delete('/projects/:slug/episodes/:episodeId/img2img-references/scene/:n', async (req, res) => {
  const { slug, episodeId } = req.params
  const n = Number(req.params.n)
  if (!Number.isFinite(n) || n < 1 || n > 999) {
    return res.status(400).json({ detail: 'invalid scene number' })
  }
  const titleParam = (req.query.title as string) || ''
  try {
    const dir = await refsDir(slug, episodeId, titleParam)
    const target = path.join(dir, sceneFilename(n))
    if (existsSync(target)) await fs.rm(target)
    res.json({ ok: true })
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'Failed to delete scene reference' })
  }
})

// ── GET listing ──────────────────────────────────────────────────────────
router.get('/projects/:slug/episodes/:episodeId/img2img-references', async (req, res) => {
  const { slug, episodeId } = req.params
  const titleParam = (req.query.title as string) || ''
  try {
    const dir = await refsDir(slug, episodeId, titleParam)
    let entries: string[] = []
    try { entries = await fs.readdir(dir) } catch { entries = [] }
    const out: {
      master?: { url: string; size_bytes: number }
      thumbnail?: { url: string; size_bytes: number }
      style?: { url: string; size_bytes: number }
      composition?: { url: string; size_bytes: number }
      scenes: { number: number; url: string; size_bytes: number }[]
    } = { scenes: [] }
    for (const name of entries) {
      const abs = path.join(dir, name)
      let size = 0
      try { size = (await fs.stat(abs)).size } catch { /* skip */ }
      if (name === MASTER_FILENAME) {
        out.master = { url: fileUrl(slug, episodeId, name), size_bytes: size }
      } else if (name === THUMBNAIL_FILENAME) {
        out.thumbnail = { url: fileUrl(slug, episodeId, name), size_bytes: size }
      } else if (name === STYLE_FILENAME) {
        out.style = { url: fileUrl(slug, episodeId, name), size_bytes: size }
      } else if (name === COMPOSITION_FILENAME) {
        out.composition = { url: fileUrl(slug, episodeId, name), size_bytes: size }
      } else {
        const m = name.match(/^scene-(\d+)\.png$/)
        if (m) {
          out.scenes.push({
            number: parseInt(m[1]!, 10),
            url: fileUrl(slug, episodeId, name),
            size_bytes: size,
          })
        }
      }
    }
    out.scenes.sort((a, b) => a.number - b.number)
    res.json(out)
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'Failed to list references' })
  }
})

// ── GET single file (raw PNG) ────────────────────────────────────────────
router.get('/projects/:slug/episodes/:episodeId/img2img-references/file/:filename', async (req, res) => {
  const { slug, episodeId, filename } = req.params
  // Restrict to known filename shapes to block path traversal.
  // v1.0.237 — include style.png (was missing, so the style-reference preview
  // 400'd and showed a broken image even though the file exists + renders).
  if (filename !== MASTER_FILENAME && filename !== THUMBNAIL_FILENAME && filename !== STYLE_FILENAME && filename !== COMPOSITION_FILENAME && !/^scene-\d+\.png$/.test(filename)) {
    return res.status(400).json({ detail: 'Invalid reference filename' })
  }
  const titleParam = (req.query.title as string) || ''
  try {
    const dir = await refsDir(slug, episodeId, titleParam)
    const abs = path.join(dir, filename)
    if (!existsSync(abs)) return res.status(404).json({ detail: 'Reference not found' })
    res.setHeader('Cache-Control', 'private, max-age=60')
    res.setHeader('Content-Type', 'image/png')
    res.sendFile(path.resolve(abs))
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'Failed to load reference' })
  }
})

// ── Helpers ──────────────────────────────────────────────────────────────

export function decodeUploadBuffer(body: any):
  | { ok: true; data: Buffer }
  | { ok: false; status: number; detail: string }
{
  if (!body || typeof body !== 'object') {
    return { ok: false, status: 400, detail: 'JSON body required' }
  }
  const data_base64 = typeof body.data_base64 === 'string' ? body.data_base64 : ''
  if (!data_base64) return { ok: false, status: 400, detail: 'data_base64 is required' }
  let buf: Buffer
  try { buf = Buffer.from(data_base64, 'base64') }
  catch { return { ok: false, status: 400, detail: 'invalid base64 payload' } }
  if (buf.length === 0) return { ok: false, status: 400, detail: 'decoded image is empty' }
  if (buf.length > MAX_IMAGE_BYTES) {
    return {
      ok: false, status: 413,
      detail: `Image too large (${buf.length} bytes, max ${MAX_IMAGE_BYTES})`,
    }
  }
  return { ok: true, data: buf }
}
