/**
 * REST endpoints for the Niche primitive.
 *
 *   GET    /api/niches                    → list every niche (built-in + user)
 *   GET    /api/niches/:id                → single niche
 *   POST   /api/niches                    → create user-custom (id from body)
 *   PUT    /api/niches/:id                → full-document replace (user-custom only)
 *   PATCH  /api/niches/:id/episode-shape  → merge chapters/length/pace/tone only
 *   DELETE /api/niches/:id                → delete user-custom (built-ins refused)
 *   PUT    /api/projects/:slug/niche      → set/unset { niche_id: string | null }
 *   GET    /api/projects/:slug/effective-niche → resolved niche after overrides
 *
 * Built-in niches are immutable. Existing same-id files in `.niches` remain
 * readable for compatibility, but editing one creates an explicit `user:`
 * fork; neither the bundled source nor the legacy file is overwritten.
 */

import { Router, type Request } from 'express'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import * as nl from '../services/niche-loader.js'
import * as tpl from '../services/topic-pack-loader.js'
import * as pm from '../services/project-manager.js'
import { writeJsonAtomic } from '../lib/atomic-store.js'
import { respondWithError } from '../lib/humanize-backend-error.js'
import { logLine } from '../services/logger.js'
import { EpisodeShapePatchSchema, NicheSchema, SetProjectNicheSchema, TopicPackSchema } from '../contracts/index.js'
import type { Niche, TopicPack } from '../models/types.js'
import { listVisualStyles } from '../services/visual-style-loader.js'
import { updateProjectContentSelections } from '../content-packs/project-pins.js'
import {
  forkLegacyContentForEdit,
  isUserForkId,
  saveUserForkDocument,
} from '../content-packs/user-forks.js'

export const router = Router()

function packOptionsFor(req: Request) {
  return req.app.locals.contentPackOptions || {}
}

function catalogMetadata(entry: { source: string; pack?: { pack_id: string; version: string } }) {
  return {
    source: entry.source,
    ...(entry.pack ? { pack_id: entry.pack.pack_id, version: entry.pack.version } : {}),
  }
}

// ── List ────────────────────────────────────────────────────────────────────

router.get('/niches', async (req, res) => {
  try {
    const niches = await nl.listNicheCatalogEntries(packOptionsFor(req))
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
      niches: niches.map(entry => ({
        ...entry.value,
        project_count: refCount[entry.value.id] || 0,
        catalog: catalogMetadata(entry),
      })),
    })
  } catch (e: any) {
    respondWithError(res, e, 'Failed to list niches')
  }
})

router.get('/topic-packs', async (req, res) => {
  try {
    const nicheId = typeof req.query.niche_id === 'string' ? req.query.niche_id : ''
    const packs = await tpl.listTopicPackCatalogEntries(packOptionsFor(req))
    res.json({
      topic_packs: nicheId
        ? packs.filter(entry => tpl.isCompatible(entry.value, nicheId))
          .map(entry => ({ ...entry.value, catalog: catalogMetadata(entry) }))
        : packs.map(entry => ({ ...entry.value, catalog: catalogMetadata(entry) })),
    })
  } catch (e: any) {
    respondWithError(res, e, 'Failed to list Topic Packs')
  }
})

router.get('/visual-styles', async (req, res) => {
  try {
    res.json({ visual_styles: await listVisualStyles(packOptionsFor(req)) })
  } catch (e: any) {
    // v1.4.68 — this is a LIBRARY LISTING, and it answers for itself.
    //
    // One unusable installed pack — uninstalled, recalled, or with tampered
    // bytes — now raises `ContentPackMissingError`, a customer-facing 409 that
    // names that pack. Correct where a customer asked for that exact version;
    // wrong here, where they asked for the library and one member of it
    // happens to be broken. Surfacing its 409 would tell them to go install a
    // pack when what actually happened is that a local install is damaged.
    //
    // So the route reports its own failure, and the body carries no pack,
    // path, or trust detail at all. The diagnosis is in the log line.
    logLine('warn', 'visual style listing failed', { error: e?.message ? String(e.message) : String(e) })
    res.status(500).json({ detail: 'Failed to list visual styles' })
  }
})

router.get('/topic-packs/:id', async (req, res) => {
  try {
    const pack = await tpl.loadTopicPack(req.params.id, packOptionsFor(req))
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
    if (await tpl.loadTopicPack(parsed.data.id, packOptionsFor(req))) {
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
    const requestedId = req.params.id
    const validationBody = isUserForkId(requestedId) ? { ...req.body, id: 'user-fork' } : req.body
    const parsed = TopicPackSchema.safeParse(validationBody)
    if (!parsed.success) {
      return res.status(400).json({ detail: parsed.error.issues.map(issue => issue.message).join('; ') })
    }
    if (!isUserForkId(requestedId) && parsed.data.id !== requestedId) {
      return res.status(400).json({ detail: 'id in path and body must match' })
    }
    const contentPackOptions = req.app.locals.contentPackOptions || {}
    const projectSlug = typeof req.query.project_slug === 'string' ? req.query.project_slug : undefined
    const forkId = isUserForkId(requestedId)
      ? requestedId
      : (await forkLegacyContentForEdit({ kind: 'topic-pack', legacyId: requestedId, projectSlug }, contentPackOptions)).fork_id
    const pack: TopicPack = { ...parsed.data, id: forkId, builtin: false }
    await saveUserForkDocument(forkId, pack, contentPackOptions)
    res.json(pack)
  } catch (e: any) {
    respondWithError(res, e, 'Failed to update Topic Pack')
  }
})

router.delete('/topic-packs/:id', async (req, res) => {
  try {
    const filePath = tpl.topicPackFilePath(req.params.id)
    if (!existsSync(filePath)) {
      const existing = await tpl.loadTopicPack(req.params.id, packOptionsFor(req))
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
    const niche = await nl.loadNiche(req.params.id, packOptionsFor(req))
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
    const existing = await nl.loadNiche(body.id, packOptionsFor(req))
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

// ── Update (explicit user fork) ────────────────────────────────────────────

router.put('/niches/:id', async (req, res) => {
  try {
    const requestedId = req.params.id
    const validationBody = isUserForkId(requestedId) ? { ...req.body, id: 'user-fork' } : req.body
    const parsed = NicheSchema.safeParse(validationBody)
    if (!parsed.success) {
      return res.status(400).json({ detail: parsed.error.issues.map(i => i.message).join('; ') })
    }
    if (!isUserForkId(requestedId) && parsed.data.id !== requestedId) {
      return res.status(400).json({ detail: 'id in path and body must match' })
    }
    const contentPackOptions = req.app.locals.contentPackOptions || {}
    const projectSlug = typeof req.query.project_slug === 'string' ? req.query.project_slug : undefined
    const forkId = isUserForkId(requestedId)
      ? requestedId
      : (await forkLegacyContentForEdit({ kind: 'series-formula', legacyId: requestedId, projectSlug }, contentPackOptions)).fork_id
    const toWrite: Niche = { ...parsed.data, id: forkId, builtin: false }
    await saveUserForkDocument(forkId, toWrite, contentPackOptions)
    res.json(toWrite)
  } catch (e: any) {
    respondWithError(res, e, 'Failed to update niche')
  }
})

// ── Episode shape (chapters, length, pace, title tone) ─────────────────────

/**
 * Change how long a Formula's episodes run, how many chapters they carry, how
 * fast they are read, and how their titles are pitched.
 *
 * A MERGE, not a replace, and that is the whole point. `PUT /niches/:id` runs
 * the document through `NicheSchema`, which is `.strict()` and lists roughly a
 * third of a real Formula — no `scriptStructure`, no `narratorStyles`, no
 * `titleShapeRules`, no `pacingArc`. A built-in cannot round-trip that route:
 * it is refused for carrying keys the schema does not know, and if it were
 * accepted, every key the schema does not know would be dropped from the fork.
 * Editing "Sleep Stories" would have silently deleted its ten narrator voices.
 *
 * Here the stored document is loaded, the patched keys are written onto it, and
 * everything else is carried across untouched. Nothing can be lost by omission
 * because nothing is rebuilt.
 *
 * `project_slug` is not optional in practice. `forkLegacyContentForEdit` only
 * repoints the project at the new fork when it is given one — without it the
 * edit lands in a fork nothing reads, and the owner sees a saved change that
 * does nothing. The UI always sends it; the route refuses a built-in without
 * it rather than writing an orphan.
 */
router.patch('/niches/:id/episode-shape', async (req, res) => {
  try {
    const requestedId = req.params.id
    const parsed = EpisodeShapePatchSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ detail: parsed.error.issues.map(i => i.message).join('; ') })
    }
    const projectSlug = typeof req.query.project_slug === 'string' && req.query.project_slug
      ? req.query.project_slug
      : undefined
    const contentPackOptions = packOptionsFor(req)

    if (!isUserForkId(requestedId) && !projectSlug) {
      return res.status(400).json({
        detail: 'Editing a built-in Formula needs the project it is being edited for, '
          + 'so the new copy can be pointed at that project. Without it the change would be saved somewhere nothing reads.',
      })
    }

    const forkId = isUserForkId(requestedId)
      ? requestedId
      : (await forkLegacyContentForEdit(
          { kind: 'series-formula', legacyId: requestedId, projectSlug },
          contentPackOptions,
        )).fork_id

    const current = await nl.loadNiche(forkId, contentPackOptions)
    if (!current) return res.status(404).json({ detail: 'Formula not found' })

    const patch = parsed.data
    const next: Niche = {
      ...current,
      id: forkId,
      builtin: false,
      // Presets are derived rather than asked for: three points on the range he
      // already set is what the duration picker wants, and one fewer field is
      // one fewer way to write a preset that sits outside its own range.
      scriptStructure: {
        ...(current.scriptStructure || {}),
        defaultChapterCount: patch.defaultChapterCount,
        chapterCountRange: [patch.chapterCountRange[0], patch.chapterCountRange[1]],
        defaultLengthMinutes: patch.defaultLengthMinutes,
        lengthMinutesRange: [patch.lengthMinutesRange[0], patch.lengthMinutesRange[1]],
        durationPresets: Array.from(new Set([
          patch.lengthMinutesRange[0], patch.defaultLengthMinutes, patch.lengthMinutesRange[1],
        ])).sort((a, b) => a - b),
        defaultWordsPerMinute: patch.defaultWordsPerMinute,
        chaptersIndependent: patch.chaptersIndependent,
      },
    }
    // An empty box means "say nothing here", which is not the same as saying
    // the empty string — the Format's own tone should take over.
    if (patch.metadataTitleStyleHint.trim()) next.metadataTitleStyleHint = patch.metadataTitleStyleHint.trim()
    else delete (next as { metadataTitleStyleHint?: string }).metadataTitleStyleHint

    await saveUserForkDocument(forkId, next, contentPackOptions)
    nl.invalidateNicheCache(forkId)
    res.json({ id: forkId, forked_from: isUserForkId(requestedId) ? null : requestedId, niche: next })
  } catch (e: any) {
    respondWithError(res, e, 'Failed to update the episode shape')
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
      const builtin = await nl.loadNiche(id, packOptionsFor(req))
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
      const options = packOptionsFor(req)
      const niche = await nl.loadNiche(niche_id, options)
      if (!niche) return res.status(404).json({ detail: `Niche '${niche_id}' not found` })
      for (const packId of topic_pack_ids || []) {
        const pack = await tpl.loadTopicPack(packId, options)
        if (!pack) return res.status(404).json({ detail: `Topic Pack '${packId}' not found` })
        if (!tpl.isCompatible(pack, niche_id)) {
          return res.status(400).json({ detail: `Topic Pack '${packId}' is not compatible with Series Formula '${niche_id}'` })
        }
      }
    }
    const updated = await updateProjectContentSelections(req.params.slug, {
      replace_kinds: ['series-formula', 'topic-pack'],
      selections: niche_id
        ? [
            { id: niche_id, kind: 'series-formula' as const },
            ...(topic_pack_ids || []).map(id => ({ id, kind: 'topic-pack' as const })),
          ]
        : [],
      update(data) {
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
      },
    }, packOptionsFor(req))
    const finalNicheId = updated.niche_id ?? null
    res.json({
      ok: true,
      slug: req.params.slug,
      niche_id: finalNicheId,
      topic_pack_ids: updated.topic_pack_ids || [],
      content_pack_versions: updated.content_pack_versions || {},
    })
  } catch (e: any) {
    respondWithError(res, e, 'Failed to update project niche')
  }
})
