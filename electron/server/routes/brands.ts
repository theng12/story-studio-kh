/**
 * REST endpoints for the Brand primitive.
 *
 *   GET    /api/brands                     → list every brand on disk
 *   GET    /api/brands/:id                 → single brand
 *   POST   /api/brands                     → create (id from body, slug-validated)
 *   PUT    /api/brands/:id                 → full-document replace
 *   DELETE /api/brands/:id                 → refuses if any project references it
 *   PUT    /api/projects/:slug/brand       → set/unset { brand_id: string | null }
 */

import { Router } from 'express'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import * as bl from '../services/brand-loader.js'
import * as pm from '../services/project-manager.js'
import { writeJsonAtomic, withLock } from '../lib/atomic-store.js'
import { respondWithError } from '../lib/humanize-backend-error.js'
import { BrandSchema, SetProjectBrandSchema } from '../contracts/index.js'
import type { Brand, ProjectMeta } from '../models/types.js'

export const router = Router()

// ── List ────────────────────────────────────────────────────────────────────

router.get('/brands', async (_req, res) => {
  try {
    const brands = await bl.listBrands()
    // For each brand, count how many projects reference it. The list
    // page uses these counts as quick stats and to inform the delete
    // confirmation dialog.
    const projects = await pm.listProjects()
    const refCount: Record<string, number> = {}
    for (const summary of projects) {
      try {
        const meta = await pm.getProject(summary.slug)
        if (meta?.brand_id) refCount[meta.brand_id] = (refCount[meta.brand_id] || 0) + 1
      } catch { /* skip unreadable */ }
    }
    res.json({
      brands: brands.map(b => ({ ...b, project_count: refCount[b.id] || 0 })),
    })
  } catch (e: any) {
    respondWithError(res, e, 'Failed to list brands')
  }
})

// ── Read ────────────────────────────────────────────────────────────────────

router.get('/brands/:id', async (req, res) => {
  try {
    const brand = await bl.loadBrand(req.params.id)
    if (!brand) return res.status(404).json({ detail: 'Brand not found' })
    res.json(brand)
  } catch (e: any) {
    respondWithError(res, e, 'Failed to load brand')
  }
})

// ── Create ──────────────────────────────────────────────────────────────────

router.post('/brands', async (req, res) => {
  try {
    const parsed = BrandSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ detail: parsed.error.issues.map(i => i.message).join('; ') })
    }
    const body = parsed.data as Brand
    const filePath = bl.brandFilePath(body.id)
    if (existsSync(filePath)) {
      return res.status(409).json({ detail: `Brand '${body.id}' already exists` })
    }
    await bl.ensureBrandsDir()
    await writeJsonAtomic(filePath, body)
    bl.invalidateBrandCache(body.id)
    res.status(201).json(body)
  } catch (e: any) {
    respondWithError(res, e, 'Failed to create brand')
  }
})

// ── Update ──────────────────────────────────────────────────────────────────

router.put('/brands/:id', async (req, res) => {
  try {
    const parsed = BrandSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ detail: parsed.error.issues.map(i => i.message).join('; ') })
    }
    const body = parsed.data as Brand
    if (body.id !== req.params.id) {
      return res.status(400).json({ detail: 'id in path and body must match' })
    }
    const filePath = bl.brandFilePath(body.id)
    if (!existsSync(filePath)) return res.status(404).json({ detail: 'Brand not found' })
    await withLock(filePath, async () => {
      await writeJsonAtomic(filePath, body)
    })
    bl.invalidateBrandCache(body.id)
    res.json(body)
  } catch (e: any) {
    respondWithError(res, e, 'Failed to update brand')
  }
})

// ── Delete ──────────────────────────────────────────────────────────────────

router.delete('/brands/:id', async (req, res) => {
  try {
    const id = req.params.id
    const filePath = bl.brandFilePath(id)
    if (!existsSync(filePath)) return res.status(404).json({ detail: 'Brand not found' })

    // Refuse if any project still references this brand. Collect the
    // referencing slugs into the error body so the UI can prompt for
    // reassignment without a second round-trip.
    const projects = await pm.listProjects()
    const referencingSlugs: string[] = []
    for (const summary of projects) {
      try {
        const meta = await pm.getProject(summary.slug)
        if (meta?.brand_id === id) referencingSlugs.push(summary.slug)
      } catch { /* skip unreadable */ }
    }
    if (referencingSlugs.length > 0) {
      return res.status(409).json({
        detail: `Brand is in use by ${referencingSlugs.length} project(s). Reassign or clear them first.`,
        referencing_projects: referencingSlugs,
      })
    }

    await fs.unlink(filePath)
    bl.invalidateBrandCache(id)
    res.json({ ok: true, id })
  } catch (e: any) {
    respondWithError(res, e, 'Failed to delete brand')
  }
})

// ── Project association setter ──────────────────────────────────────────────

router.put('/projects/:slug/brand', async (req, res) => {
  try {
    const parsed = SetProjectBrandSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ detail: parsed.error.issues.map(i => i.message).join('; ') })
    }
    const { brand_id } = parsed.data
    // Validate the brand exists when setting (null is "clear association").
    if (brand_id) {
      const brand = await bl.loadBrand(brand_id)
      if (!brand) return res.status(404).json({ detail: `Brand '${brand_id}' not found` })
    }
    // updateProject only knows the keys explicitly listed on UpdateProjectRequest.
    // We bypass via direct file mutation so brand_id flows through unchanged.
    const projectDir = pm.getProjectDir(req.params.slug)
    if (!projectDir) return res.status(404).json({ detail: 'Project not found' })
    const path = await import('path')
    const metaPath = path.join(projectDir, 'project.json')
    if (!existsSync(metaPath)) return res.status(404).json({ detail: 'Project not found' })
    let updated: ProjectMeta | null = null
    await withLock(metaPath, async () => {
      const raw = await fs.readFile(metaPath, 'utf-8')
      const data = JSON.parse(raw) as ProjectMeta
      if (brand_id === null || brand_id === '') {
        delete (data as any).brand_id
      } else {
        data.brand_id = brand_id
      }
      await writeJsonAtomic(metaPath, data)
      updated = data
    })
    const finalBrandId = (updated as ProjectMeta | null)?.brand_id ?? null
    res.json({ ok: true, slug: req.params.slug, brand_id: finalBrandId })
  } catch (e: any) {
    respondWithError(res, e, 'Failed to update project brand')
  }
})
