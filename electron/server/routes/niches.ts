/**
 * REST endpoints for the Niche primitive.
 *
 *   GET    /api/niches                    → list every niche (built-in + user)
 *   GET    /api/niches/:id                → single niche
 *   POST   /api/niches                    → create user-custom (id from body)
 *   PUT    /api/niches/:id                → full-document replace (user-custom only)
 *   DELETE /api/niches/:id                → delete user-custom (built-ins refused)
 *   PUT    /api/projects/:slug/niche      → set/unset { niche_id: string | null }
 *   GET    /api/projects/:slug/effective-niche → resolved niche after overrides
 *
 * Built-in niches are immutable (shipped with the app). User-custom niches
 * shadow built-ins with the same id at lookup time, so a custom file at
 * `${PROJECTS_ROOT}/.niches/plants.json` takes precedence over the bundled
 * plants.json. To "restore" a built-in, the user deletes their custom file.
 */

import { Router } from 'express'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import * as nl from '../services/niche-loader.js'
import * as tpl from '../services/topic-pack-loader.js'
import * as pm from '../services/project-manager.js'
import { writeJsonAtomic, withLock } from '../lib/atomic-store.js'
import { respondWithError } from '../lib/humanize-backend-error.js'
import { NicheSchema, SetProjectNicheSchema, TopicPackSchema } from '../contracts/index.js'
import type { Niche, ProjectMeta, TopicPack } from '../models/types.js'
import { listVisualStyles } from '../services/visual-style-loader.js'

export const router = Router()

// ── List ────────────────────────────────────────────────────────────────────

router.get('/niches', async (_req, res) => {
  try {
    const niches = await nl.listNiches()
    // For each niche, count how many projects reference it — used by the
    // niche browser to show "in use by N projects" badges and to gate
    // delete confirmation.
    const projects = await pm.listProjects()
    const refCount: Record<string, number> = {}
    for (const summary of projects) {
      try {
        const meta = await pm.getProject(summary.slug)
        if (meta?.niche_id) refCount[meta.niche_id] = (refCount[meta.niche_id] || 0) + 1
      } catch { /* skip unreadable */ }
    }
    res.json({
      niches: niches.map(n => ({ ...n, project_count: refCount[n.id] || 0 })),
    })
  } catch (e: any) {
    respondWithError(res, e, 'Failed to list niches')
  }
})

router.get('/topic-packs', async (req, res) => {
  try {
    const nicheId = typeof req.query.niche_id === 'string' ? req.query.niche_id : ''
    const packs = await tpl.listTopicPacks()
    res.json({
      topic_packs: nicheId
        ? packs.filter(pack => tpl.isCompatible(pack, nicheId))
        : packs,
    })
  } catch (e: any) {
    respondWithError(res, e, 'Failed to list Topic Packs')
  }
})

router.get('/visual-styles', async (_req, res) => {
  try {
    res.json({ visual_styles: await listVisualStyles() })
  } catch (e: any) {
    respondWithError(res, e, 'Failed to list visual styles')
  }
})

router.get('/topic-packs/:id', async (req, res) => {
  try {
    const pack = await tpl.loadTopicPack(req.params.id)
    if (!pack) return res.status(404).json({ detail: 'Topic Pack not found' })
    res.json(pack)
  } catch (e: any) {
    respondWithError(res, e, 'Failed to load Topic Pack')
  }
})

router.post('/topic-packs', async (req, res) => {
  try {
    const parsed = TopicPackSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ detail: parsed.error.issues.map(issue => issue.message).join('; ') })
    }
    if (await tpl.loadTopicPack(parsed.data.id)) {
      return res.status(409).json({ detail: `Topic Pack '${parsed.data.id}' already exists` })
    }
    await tpl.ensureTopicPacksDir()
    const pack: TopicPack = { ...parsed.data, builtin: false }
    await writeJsonAtomic(tpl.topicPackFilePath(pack.id), pack)
    tpl.invalidateTopicPackCache(pack.id)
    res.status(201).json(pack)
  } catch (e: any) {
    respondWithError(res, e, 'Failed to create Topic Pack')
  }
})

router.put('/topic-packs/:id', async (req, res) => {
  try {
    const parsed = TopicPackSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ detail: parsed.error.issues.map(issue => issue.message).join('; ') })
    }
    if (parsed.data.id !== req.params.id) {
      return res.status(400).json({ detail: 'id in path and body must match' })
    }
    await tpl.ensureTopicPacksDir()
    const pack: TopicPack = { ...parsed.data, builtin: false }
    await withLock(tpl.topicPackFilePath(pack.id), async () => {
      await writeJsonAtomic(tpl.topicPackFilePath(pack.id), pack)
    })
    tpl.invalidateTopicPackCache(pack.id)
    res.json(pack)
  } catch (e: any) {
    respondWithError(res, e, 'Failed to update Topic Pack')
  }
})

router.delete('/topic-packs/:id', async (req, res) => {
  try {
    const filePath = tpl.topicPackFilePath(req.params.id)
    if (!existsSync(filePath)) {
      const existing = await tpl.loadTopicPack(req.params.id)
      return res.status(existing?.builtin ? 400 : 404).json({
        detail: existing?.builtin
          ? `Topic Pack '${req.params.id}' is built-in and cannot be deleted`
          : 'Topic Pack not found',
      })
    }
    const projects = await pm.listProjects()
    const inUse: string[] = []
    for (const summary of projects) {
      const project = await pm.getProject(summary.slug).catch(() => null)
      if (project?.topic_pack_ids?.includes(req.params.id)) inUse.push(summary.slug)
    }
    if (inUse.length) {
      return res.status(409).json({
        detail: `Topic Pack is in use by ${inUse.length} project(s). Reassign or clear them first.`,
        referencing_projects: inUse,
      })
    }
    await fs.unlink(filePath)
    tpl.invalidateTopicPackCache(req.params.id)
    res.json({ ok: true, id: req.params.id })
  } catch (e: any) {
    respondWithError(res, e, 'Failed to delete Topic Pack')
  }
})

// ── Read ────────────────────────────────────────────────────────────────────

router.get('/niches/:id', async (req, res) => {
  try {
    const niche = await nl.loadNiche(req.params.id)
    if (!niche) return res.status(404).json({ detail: 'Niche not found' })
    res.json(niche)
  } catch (e: any) {
    respondWithError(res, e, 'Failed to load niche')
  }
})

// ── Effective-niche resolver (for project-aware UI) ────────────────────────

router.get('/projects/:slug/effective-niche', async (req, res) => {
  try {
    const project = await pm.getProject(req.params.slug)
    if (!project) return res.status(404).json({ detail: 'Project not found' })
    const niche = await nl.getEffectiveNicheFor(project)
    // null is a legitimate answer ("project has no niche") — return it as
    // an explicit field rather than 404'ing, so the caller can distinguish
    // "project missing" from "project unniched".
    res.json({ niche })
  } catch (e: any) {
    respondWithError(res, e, 'Failed to resolve effective niche')
  }
})

// ── Create (user-custom) ───────────────────────────────────────────────────

router.post('/niches', async (req, res) => {
  try {
    const parsed = NicheSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ detail: parsed.error.issues.map(i => i.message).join('; ') })
    }
    const body = parsed.data as Niche
    // Refuse to create a user-custom niche with the same id as a built-in
    // we can read RIGHT NOW. Shadowing IS supported, but the UI surfaces
    // it as a different action ("override built-in") — POST is for
    // brand-new niches only. This guards against accidental overrides
    // from API clients.
    const existing = await nl.loadNiche(body.id)
    if (existing) {
      return res.status(409).json({ detail: `Niche '${body.id}' already exists (built-in or user-custom)` })
    }
    const filePath = nl.nicheFilePath(body.id)
    await nl.ensureNichesDir()
    // builtin must be false for user-created niches — the loader trusts
    // this field for the picker's badge. Force it here so the API client
    // can't lie.
    const toWrite: Niche = { ...body, builtin: false }
    await writeJsonAtomic(filePath, toWrite)
    nl.invalidateNicheCache(body.id)
    res.status(201).json(toWrite)
  } catch (e: any) {
    respondWithError(res, e, 'Failed to create niche')
  }
})

// ── Update (user-custom only) ──────────────────────────────────────────────

router.put('/niches/:id', async (req, res) => {
  try {
    const parsed = NicheSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ detail: parsed.error.issues.map(i => i.message).join('; ') })
    }
    const body = parsed.data as Niche
    if (body.id !== req.params.id) {
      return res.status(400).json({ detail: 'id in path and body must match' })
    }
    const filePath = nl.nicheFilePath(body.id)
    // PUT can either:
    //   1. Update an existing user-custom niche (file exists)
    //   2. Create a user-custom override of a built-in (file doesn't exist yet)
    // Case 2 is intentional — the niche browser's "Customize this built-in"
    // action issues a PUT with the built-in's content + the user's edits.
    const isOverride = !existsSync(filePath)
    if (isOverride) {
      await nl.ensureNichesDir()
    }
    const toWrite: Niche = { ...body, builtin: false }
    await withLock(filePath, async () => {
      await writeJsonAtomic(filePath, toWrite)
    })
    nl.invalidateNicheCache(body.id)
    res.json(toWrite)
  } catch (e: any) {
    respondWithError(res, e, 'Failed to update niche')
  }
})

// ── Delete (user-custom only) ──────────────────────────────────────────────

router.delete('/niches/:id', async (req, res) => {
  try {
    const id = req.params.id
    const filePath = nl.nicheFilePath(id)
    if (!existsSync(filePath)) {
      // Built-in or unknown — either way, nothing to delete on disk. Distinguish
      // via the loader so the error message guides the user correctly.
      const builtin = await nl.loadNiche(id)
      if (builtin && builtin.builtin) {
        return res.status(400).json({
          detail: `Niche '${id}' is built-in and cannot be deleted. To customize, save your own version with the same id.`,
        })
      }
      return res.status(404).json({ detail: 'Niche not found' })
    }

    // Refuse if any project still references this niche. Collect referencing
    // slugs so the UI can offer a reassign prompt without a second round-trip.
    const projects = await pm.listProjects()
    const referencingSlugs: string[] = []
    for (const summary of projects) {
      try {
        const meta = await pm.getProject(summary.slug)
        if (meta?.niche_id === id) referencingSlugs.push(summary.slug)
      } catch { /* skip unreadable */ }
    }
    if (referencingSlugs.length > 0) {
      return res.status(409).json({
        detail: `Niche is in use by ${referencingSlugs.length} project(s). Reassign or clear them first.`,
        referencing_projects: referencingSlugs,
      })
    }

    await fs.unlink(filePath)
    nl.invalidateNicheCache(id)
    res.json({ ok: true, id })
  } catch (e: any) {
    respondWithError(res, e, 'Failed to delete niche')
  }
})

// ── Project association setter ─────────────────────────────────────────────

router.put('/projects/:slug/niche', async (req, res) => {
  try {
    const parsed = SetProjectNicheSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ detail: parsed.error.issues.map(i => i.message).join('; ') })
    }
    const { niche_id, topic_pack_ids } = parsed.data
    if (niche_id) {
      const niche = await nl.loadNiche(niche_id)
      if (!niche) return res.status(404).json({ detail: `Niche '${niche_id}' not found` })
      for (const packId of topic_pack_ids || []) {
        const pack = await tpl.loadTopicPack(packId)
        if (!pack) return res.status(404).json({ detail: `Topic Pack '${packId}' not found` })
        if (!tpl.isCompatible(pack, niche_id)) {
          return res.status(400).json({ detail: `Topic Pack '${packId}' is not compatible with Series Formula '${niche_id}'` })
        }
      }
    }
    const projectDir = pm.getProjectDir(req.params.slug)
    if (!projectDir) return res.status(404).json({ detail: 'Project not found' })
    const metaPath = path.join(projectDir, 'project.json')
    if (!existsSync(metaPath)) return res.status(404).json({ detail: 'Project not found' })
    let updated: ProjectMeta | null = null
    await withLock(metaPath, async () => {
      const raw = await fs.readFile(metaPath, 'utf-8')
      const data = JSON.parse(raw) as ProjectMeta
      if (niche_id === null || niche_id === '') {
        delete (data as any).niche_id
        delete (data as any).niche_overrides
        delete (data as any).topic_pack_ids
      } else {
        data.niche_id = niche_id
        if (topic_pack_ids === undefined) delete (data as any).topic_pack_ids
        else if (topic_pack_ids.length) data.topic_pack_ids = [...new Set(topic_pack_ids)]
        else data.topic_pack_ids = []
      }
      await writeJsonAtomic(metaPath, data)
      updated = data
    })
    const finalNicheId = (updated as ProjectMeta | null)?.niche_id ?? null
    res.json({
      ok: true,
      slug: req.params.slug,
      niche_id: finalNicheId,
      topic_pack_ids: (updated as ProjectMeta | null)?.topic_pack_ids || [],
    })
  } catch (e: any) {
    respondWithError(res, e, 'Failed to update project niche')
  }
})
