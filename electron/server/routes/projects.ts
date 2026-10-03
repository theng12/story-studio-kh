import { Router } from 'express'
import * as pm from '../services/project-manager.js'
import * as jq from '../services/job-queue.js'
import { validateBody } from '../lib/validate.js'
import { CreateProjectSchema, UpdateProjectSchema } from '../schemas/index.js'
// (Manifest read/poll surface removed with the legacy sync flow. The
// project-manager service still WRITES manifests on every mutation —
// see syncManifest() — for cross-machine project_id identity.)
import { auditProjectAssets } from '../services/asset-status.js'
import { auditAssets } from '../services/manifest-audit.js'
import { listFormats, getEffectiveFormatFor } from '../services/format-loader.js'
import { humanizeBackendError, respondWithError } from '../lib/humanize-backend-error.js'
import type { ProjectMeta } from '../models/types.js'
import type { JobType } from '../models/types.js'
import { createProjectWithContentSelections } from '../content-packs/project-pins.js'
import { getIdeas } from '../services/idea-manager.js'
import { readYouTubeProjectPublishingState } from '../services/youtube-project-publishing-store.js'
import { episodeStepJobStates } from '../contracts/episode-step-jobs.js'

export const router = Router()

const RETIRED_RESEARCH_POLICY = ['research', 'required'].join('_')

function withoutRetiredResearchPolicy(project: ProjectMeta): ProjectMeta {
  const current = { ...project } as Record<string, unknown>
  delete current[RETIRED_RESEARCH_POLICY]
  return current as unknown as ProjectMeta
}

router.get('/projects', async (_req, res) => {
  // v1.4.3 — a Library that was chosen and is not there right now is NOT an
  // empty project list. An unplugged drive, a renamed folder and "you have no
  // channels" would otherwise be the same screen, which is the exact failure
  // 1.4.2 fixed for a project's episodes folder: the app knows, so it must say.
  //
  // 409 rather than 500: nothing is broken, something is unavailable, and the
  // home page already renders this shape with a Try again button.
  const { describeLibrary } = await import('../services/library.js')
  const library = await describeLibrary()
  if (library.configured && !library.exists) {
    return res.status(409).json({
      code: 'LIBRARY_UNAVAILABLE',
      library_path: library.path,
      detail: `Your Library is not available. Story Studio looked for "${library.path}" and it is not there. `
        + 'If it lives on a drive that is not plugged in, reconnect it and try again — nothing has been lost. '
        + 'If you moved it, point Story Studio at the new place in Settings → Storage.',
    })
  }
  res.json(await pm.listProjects())
})

//
// Built-in + user-custom formats are merged by listFormats(); the picker UI
// uses /api/formats. Per-project effective format (base + project's overrides
// applied) lives at /api/projects/:slug/effective-format.

router.get('/formats', async (_req, res) => {
  try {
    const formats = await listFormats()
    res.json(formats)
  } catch (e: any) {
    respondWithError(res, e, 'Failed to list formats')
  }
})

router.get('/projects/:slug/effective-format', async (req, res) => {
  try {
    const project = await pm.getProject(req.params.slug)
    if (!project) return res.status(404).json({ detail: 'Project not found' })
    const episodeId = typeof req.query.episode_id === 'string' && req.query.episode_id.trim()
      ? req.query.episode_id.trim()
      : undefined
    if (episodeId) {
      const accepted = (await getIdeas(req.params.slug, 'accepted')).some(
        idea => (idea.episode_code || '').toUpperCase() === episodeId.toUpperCase(),
      )
      if (!accepted) return res.status(404).json({ detail: `No accepted episode matches '${episodeId}' in this project` })
    }
    res.json(await getEffectiveFormatFor(project, episodeId ? { episodeId } : undefined))
  } catch (e: any) {
    respondWithError(res, e, 'Failed to resolve effective format')
  }
})

// Episode counts for the home channel card. Cheap on purpose: the idea list, one
// small publishing-state file and the in-memory job list - no episode folder is
// opened and nothing leaves this Mac.
//
//   episodes         accepted ideas
//   on_youtube       accepted episodes with a saved YouTube video link; null when
//                    that file cannot be read (unknown is not "none")
//   in_progress      distinct accepted episodes whose latest job for some step is
//                    queued or running
//   needs_attention  distinct accepted episodes whose latest attempt at some step
//                    failed (the Production Board's rule, episodeStepJobStates)
router.get('/projects/:slug/channel-counts', async (req, res) => {
  try {
    const slug = req.params.slug
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const codes = new Set<string>()
    let episodes = 0
    for (const idea of await getIdeas(slug, 'accepted')) {
      episodes++
      if (idea.episode_code) codes.add(idea.episode_code)
    }

    let onYouTube: number | null = null
    try {
      const links = (await readYouTubeProjectPublishingState(slug)).episode_video_links
      onYouTube = [...codes].filter(code => Object.hasOwn(links, code)).length
    } catch (e: any) {
      console.warn(`[channel-counts] ${slug}: publishing state unreadable: ${e?.message || e}`)
    }

    const inProgress = new Set<string>()
    const needsAttention = new Set<string>()
    for (const [key, state] of episodeStepJobStates(await jq.getJobs(slug))) {
      const code = key.slice(0, key.lastIndexOf(':'))
      if (!codes.has(code)) continue
      ;(state.state === 'active' ? inProgress : needsAttention).add(code)
    }
    res.json({
      episodes,
      on_youtube: onYouTube,
      in_progress: inProgress.size,
      needs_attention: needsAttention.size,
    })
  } catch (e: any) {
    respondWithError(res, e, 'Could not count episodes')
  }
})

// Project-wide asset audit: per-episode presence counts across audio,
// scenes, thumbnails, video clips, merged audio. Powers the Settings →
// Assets matrix.
//
// v1.2.8 — `?episode=EP0053` (repeatable) narrows the scan to named episodes,
// for the case where the user already knows which one is broken. Omitted, the
// behaviour is exactly as before: the whole project.
router.get('/projects/:slug/assets-audit', async (req, res) => {
  try {
    if (!await pm.getProject(req.params.slug)) return res.status(404).json({ detail: 'Project not found' })
    const requested = ([] as unknown[]).concat(req.query.episode ?? [])
      .filter((code): code is string => typeof code === 'string' && !!code.trim())
      .map(code => code.trim())
    const rows = await auditProjectAssets(req.params.slug, requested.length ? requested : undefined)
    res.json({ episodes: rows })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Audit failed'))
  }
})

// On-open asset integrity audit — returns per-episode × stage gaps so the
// project dashboard can surface a single banner when a synced/transferred
// project is missing files. Distinct from /assets-audit (which powers the
// bigger Assets matrix + Repair UI) because it differentiates "not started"
// from "started-but-missing" and returns exact filenames rather than just
// counts. Audit is cheap (directory listing only, no file reads) — safe to
// call on every dashboard mount.
router.get('/projects/:slug/assets-audit-detail', async (req, res) => {
  try {
    if (!await pm.getProject(req.params.slug)) return res.status(404).json({ detail: 'Project not found' })
    const report = await auditAssets(req.params.slug)
    res.json(report)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Audit failed'))
  }
})

// Universal repair — fans out the existing per-modality repair endpoints
// for every episode with missing assets. "Repair" here means: ask the
// provider for jobs it already completed (and billed) but whose output
// never landed on disk. Zero credit cost; safe to run anytime. For images
// without a stored task id the repair job reports them as
// "needs_fresh_generation" in its log so the user can decide.
//
// Scope can be narrowed via body: `{ episode_codes?, modalities? }`.
// Default is audio and images. Audio repair is synchronous while image repair
// enqueues background jobs — the response shape reflects both paths.
router.post('/projects/:slug/assets/repair-all', async (req, res) => {
  try {
    const slug = req.params.slug
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })

    // An explicit scope must never degrade into the library-wide repair. A
    // stale Jobs row or malformed client payload is an unknown target, not
    // permission to inspect or queue every episode in the project.
    const hasExplicitEpisodeScope = Object.prototype.hasOwnProperty.call(req.body || {}, 'episode_codes')
    let requestedCodes: string[] | undefined
    if (hasExplicitEpisodeScope) {
      if (!Array.isArray(req.body.episode_codes)) {
        return res.status(400).json({ detail: 'episode_codes must be a non-empty array of episode codes.' })
      }
      const invalid = req.body.episode_codes.some((code: unknown) =>
        typeof code !== 'string' || !code.trim(),
      )
      if (invalid || req.body.episode_codes.length === 0) {
        return res.status(400).json({ detail: 'episode_codes must be a non-empty array of episode codes.' })
      }
      requestedCodes = [...new Set<string>((req.body.episode_codes as string[]).map(code => code.trim()))]
    }
    const requestedModalities: Array<'audio' | 'images'> = Array.isArray(req.body?.modalities)
      ? req.body.modalities.filter((m: any) => m === 'audio' || m === 'images')
      : ['audio', 'images']

    // v1.2.8 — fixed in passing: this endpoint has always ACCEPTED
    // `episode_codes`, but audited the whole project anyway and then discarded
    // the rows it did not want. The narrowing was real in its results and
    // imaginary in its cost. The filter now reaches the audit itself.
    const rows = await auditProjectAssets(slug, requestedCodes)
    // A failed check is unknown, not proof that this episode has no gaps.
    if (hasExplicitEpisodeScope) {
      const failedChecks = rows.flatMap(row => Object.entries(row.errors || {})
        .filter(([modality]) => modality === 'audio' || modality === 'images')
        .map(([modality]) => `${row.episode_id} ${modality}`))
      if (failedChecks.length) return res.status(409).json({
        detail: `Could not check ${failedChecks.join(', ')}. No recovery was queued; try again.`,
      })
    }
    const enqueued: Array<{ episode_id: string; type: JobType; job_id: string }> = []
    const skipped: Array<{ episode_id: string; modality: string; reason: string }> = []
    const audio_queued: string[] = []

    for (const row of rows) {
      // Images repair — covers scenes + thumbnails together (the endpoint
      // reconciles both sides in a single job).
      if (requestedModalities.includes('images')
          && (row.scenes.missing > 0 || row.thumbnails.missing > 0)) {
        if (jq.isDuplicate(slug, row.episode_id, 'images_repair')) {
          skipped.push({ episode_id: row.episode_id, modality: 'images', reason: 'already queued/running' })
        } else {
          const job = await jq.enqueue({
            project_slug: slug,
            type: 'images_repair',
            episode_id: row.episode_id,
            title: 'Image Repair (no credits)',
            params: { episode_id: row.episode_id },
          })
          enqueued.push({ episode_id: row.episode_id, type: 'images_repair', job_id: job.job_id })
        }
      }

      // Audio repair runs inline via GenAIPro history lookup — it's not
      // a background job. Surface the list to the client so it can kick
      // them off one by one (keeps this endpoint fast and idempotent).
      if (requestedModalities.includes('audio') && row.audio.missing > 0) {
        audio_queued.push(row.episode_id)
      }
    }

    res.json({
      // Distinguishes a valid scoped episode with no gaps from a code that is
      // not accepted in this project. Jobs must never turn the latter into an
      // unscoped retry.
      audited_episode_codes: rows.map(row => row.episode_id),
      enqueued,
      skipped,
      // Client-side: POST each one of these to
      // /projects/:slug/episodes/:code/audio-repair sequentially.
      audio_repair_candidates: audio_queued,
      total_repair_jobs: enqueued.length,
    })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Repair-all failed'))
  }
})

router.post('/projects', validateBody(CreateProjectSchema), async (req, res) => {
  try {
    const project = await createProjectWithContentSelections(req.body)
    res.status(201).json(project)
  } catch (e: any) {
    res.status(400).json(humanizeBackendError(e, 'Project creation failed'))
  }
})

// (Removed: POST /projects/import/inspect and POST /projects/import, and the
// whole services/import-project.ts they fronted. Their only purpose was to
// register a project whose episodes lived at an arbitrary external path and
// then write that path into `output_root` — the capability this change
// deletes. Nothing in the app ever called them: the Library is a folder you
// copy into, not a path you register.)

router.get('/projects/:slug', async (req, res) => {
  const project = await pm.getProject(req.params.slug)
  if (!project) return res.status(404).json({ detail: 'Project not found' })
  // v1.4.2 — the project page needs the same reachability fact the home page
  // gets from `listProjects`, computed by the same function so the two cannot
  // disagree. Before this, a project whose episode folder did not resolve
  // rendered completely clean here and every episode silently vanished: the
  // app had already worked out that the folder was missing and threw the
  // answer away. Same shape as the silent lead-in zero — knowing and not
  // saying is its own defect.
  const dir = pm.getProjectDir(req.params.slug)
  const resolved = dir ? pm.resolveOutputRoot(dir) : null
  res.json({
    ...withoutRetiredResearchPolicy(project),
    ...(resolved ? { output_root_resolved: resolved.path, output_root_exists: resolved.exists } : {}),
  })
})

router.put('/projects/:slug', validateBody(UpdateProjectSchema), async (req, res) => {
  // v1.4.249 — "heavy media on another drive" is retired for projects that do
  // not use it: one that has media_root may change or clear it, one without it
  // cannot start. Nothing on disk is moved either way.
  if (String(req.body.media_root ?? '').trim()) {
    const current = await pm.getProject(req.params.slug) as { media_root?: unknown } | null
    if (current && !String(current.media_root ?? '').trim()) {
      return res.status(400).json({ detail: 'Heavy media on another drive is retired: it can only be changed or cleared on a project that already uses it.' })
    }
  }
  const project = await pm.updateProject(req.params.slug, req.body)
  if (!project) return res.status(404).json({ detail: 'Project not found' })
  res.json(withoutRetiredResearchPolicy(project))
})

router.delete('/projects/:slug', async (req, res) => {
  // NON-DESTRUCTIVE delete: unregister the project but leave every
  // byte on disk. The response includes the orphan path + project
  // name so the dialog can say "files are still at <path>" and offer
  // an Open-in-Finder button. Hard delete is a separate, explicit
  // step via /soft-deleted-projects/:slug DELETE.
  try {
    const result = await pm.deleteProject(req.params.slug)
    if (!result.ok) return res.status(404).json({ detail: 'Project not found' })
    res.json(result)
  } catch (e: any) {
    const status = typeof e?.statusCode === 'number' ? e.statusCode : 500
    res.status(status).json(humanizeBackendError(e, 'Project cannot be removed while its jobs are still settling'))
  }
})

// ── Per-episode asset importer (Part 7 of mark-done plan) ──────────────────
//
// Lets the user point at files on disk that the project doesn't know about
// and have them copied/moved into the canonical asset folders with the
// canonical filenames. Pre-Story-Studio episodes typically have files like
// `1.mp3`, `final.png`, `cover.jpg` — this route handles the mapping +
// renaming so the existing detection logic picks them up.
//
// Body shape mirrors asset-importer.ts ImportItem discriminated union:
//   {
//     mode: 'copy' | 'move',
//     items: [
//       { type: 'audio',  source_path, section_slug },
//       { type: 'scene',  source_path, scene_number },
//       { type: 'thumb',  source_path, thumb_number },
//       { type: 'video',  source_path, scene_number },
//       { type: 'final',  source_path },
//       { type: 'merged', source_path },
//       { type: 'other',  source_path, dest_subpath },
//     ]
//   }

const VALID_ITEM_TYPES = new Set(['audio', 'scene', 'thumb', 'video', 'final', 'merged', 'other'])

function validateImportItems(raw: any): { ok: true; items: any[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: 'items must be an array' }
  const out: any[] = []
  for (let i = 0; i < raw.length; i++) {
    const it = raw[i]
    if (!it || typeof it !== 'object') return { ok: false, error: `items[${i}] must be an object` }
    const t = it.type
    if (typeof t !== 'string' || !VALID_ITEM_TYPES.has(t)) {
      return { ok: false, error: `items[${i}].type invalid: ${t}` }
    }
    if (typeof it.source_path !== 'string' || !it.source_path) {
      return { ok: false, error: `items[${i}].source_path required (string)` }
    }
    // Per-type field validation. Throws an ergonomic 400 instead of
    // letting the importer crash on missing fields downstream.
    switch (t) {
      case 'audio':
        if (typeof it.section_slug !== 'string' || !it.section_slug) {
          return { ok: false, error: `items[${i}].section_slug required for audio` }
        }
        break
      case 'scene':
      case 'video':
        if (typeof it.scene_number !== 'number' || !Number.isInteger(it.scene_number) || it.scene_number < 1) {
          return { ok: false, error: `items[${i}].scene_number must be a positive integer` }
        }
        break
      case 'thumb':
        if (typeof it.thumb_number !== 'number' || !Number.isInteger(it.thumb_number) || it.thumb_number < 1) {
          return { ok: false, error: `items[${i}].thumb_number must be a positive integer` }
        }
        break
      case 'other':
        if (typeof it.dest_subpath !== 'string' || !it.dest_subpath) {
          return { ok: false, error: `items[${i}].dest_subpath required for "other" type` }
        }
        break
    }
    out.push(it)
  }
  return { ok: true, items: out }
}

router.post('/projects/:slug/episodes/:code/import-assets', async (req, res) => {
  try {
    const { slug, code } = req.params
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })

    const mode = req.body?.mode === 'move' ? 'move' : 'copy'
    const validated = validateImportItems(req.body?.items)
    if (!validated.ok) return res.status(400).json({ detail: validated.error })

    const { importAssets } = await import('../services/asset-importer.js')
    const result = await importAssets(slug, code, validated.items as any, { mode })
    // v1.0.337 — imported files land with canonical names that the status
    // detection DOES recognise, but the episode-status cache only re-checks
    // when watched-folder mtimes change — and on iCloud those mtime reads
    // can be flaky right after a write. Drop this episode's cache entry so
    // the very next status read recomputes and the imported step flips to
    // done immediately instead of staying "pending" until a manual refresh.
    try {
      const { episodeStatusCache } = await import('../services/episode-status-cache.js')
      episodeStatusCache.invalidate(slug, code)
    } catch { /* cache invalidation is best-effort; import already succeeded */ }
    res.json(result)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Asset import failed'))
  }
})

// ── Storage audit + cleanup (per-project) ──────────────────────────────────
//
// Surfaces per-episode local size + cleanup actions. Wired to the
// Storage sub-tab in Project Settings. The 5-10 GB-per-episode pain
// point: sleep stories produce huge final videos, and once they're on
// YouTube the local copy is operationally redundant. These endpoints
// let the user free space safely (sidecar guard) + optionally relocate
// finals to a non-cloud-synced external root (Phase C).

router.get('/projects/:slug/storage-audit', async (req, res) => {
  try {
    if (!await pm.getProject(req.params.slug)) return res.status(404).json({ detail: 'Project not found' })
    const { auditProjectStorage } = await import('../services/storage-audit.js')
    const result = await auditProjectStorage(req.params.slug)
    res.json(result)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Storage audit failed'))
  }
})

router.post('/projects/:slug/storage/cleanup-final/:code', async (req, res) => {
  try {
    if (!await pm.getProject(req.params.slug)) return res.status(404).json({ detail: 'Project not found' })
    const force = req.body?.force === true
    const { cleanupFinalVideoForEpisode } = await import('../services/storage-audit.js')
    const result = await cleanupFinalVideoForEpisode(req.params.slug, req.params.code, { force })
    res.json(result)
  } catch (e: any) {
    // 412 = "not uploaded, force not set" — UI shows a distinct
    // confirmation prompt rather than a generic error toast.
    const status = e?.statusCode === 412 ? 412 : 500
    res.status(status).json(humanizeBackendError(e, 'Cleanup failed'))
  }
})

router.post('/projects/:slug/storage/bulk-cleanup-final', async (req, res) => {
  try {
    if (!await pm.getProject(req.params.slug)) return res.status(404).json({ detail: 'Project not found' })
    const force = req.body?.force === true
    const allUploaded = req.body?.all_uploaded === true
    const codes = Array.isArray(req.body?.episode_codes) ? req.body.episode_codes : undefined
    if (!allUploaded && (!codes || !codes.length)) {
      return res.status(400).json({ detail: 'Pass episode_codes (array) or all_uploaded=true' })
    }
    const { bulkCleanupFinalVideos } = await import('../services/storage-audit.js')
    const result = await bulkCleanupFinalVideos(req.params.slug, {
      episode_codes: codes,
      all_uploaded: allUploaded,
      force,
    })
    res.json(result)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Bulk cleanup failed'))
  }
})

// Free up space → "Clear preview cache": moves `<project>/.cache/thumbs` to the project's `_trash`
// (lib/trash-move.ts, never a delete). The review grids rebuild it automatically.
router.post('/projects/:slug/storage/clear-preview-cache', async (req, res) => {
  try {
    if (!await pm.getProject(req.params.slug)) return res.status(404).json({ detail: 'Project not found' })
    const projectDir = pm.getProjectDir(req.params.slug)
    if (!projectDir) return res.status(404).json({ detail: 'Project not found' })
    const { clearThumbCache } = await import('../lib/thumbnail-cache.js')
    res.json(await clearThumbCache(projectDir, req.params.slug))
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Clearing the preview cache failed'))
  }
})

// ── Chunked-progress sidecar cleanup (v1.0.71+) ────────────────────────────
//
// `chunked-narration.ts` writes a `{episode}_chunked-progress.json` next to
// each episode's per-chapter docx files. The sidecar is the source of
// truth for resume / cancel / crash recovery during a chunked run, but
// once `narration_full.docx` is assembled with the right chapter count it
// has no purpose — keeping it around indefinitely just clutters the
// script folder. We don't auto-wipe (per user feedback): instead we
// expose this endpoint so the user can clean up manually after they
// confirm the run produced the expected output.
//
// GET returns a list of episodes whose sidecar is eligible for cleanup
// (chapters_done covers total_chapters AND narration_full.docx exists).
// POST runs the deletion against the supplied list of episode codes
// (or all eligible ones when `all_eligible: true`). Both are scoped per-
// project — bulk + per-episode follows the same shape as the final-video
// cleanup endpoints above.

router.get('/projects/:slug/storage/chunked-sidecars', async (req, res) => {
  try {
    if (!await pm.getProject(req.params.slug)) return res.status(404).json({ detail: 'Project not found' })
    const { listChunkedSidecars } = await import('../services/chunked-sidecar-cleanup.js')
    const result = await listChunkedSidecars(req.params.slug)
    res.json(result)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to list chunked sidecars'))
  }
})

router.post('/projects/:slug/storage/cleanup-chunked-sidecars', async (req, res) => {
  try {
    if (!await pm.getProject(req.params.slug)) return res.status(404).json({ detail: 'Project not found' })
    const allEligible = req.body?.all_eligible === true
    const codes = Array.isArray(req.body?.episode_codes) ? req.body.episode_codes : undefined
    if (!allEligible && (!codes || !codes.length)) {
      return res.status(400).json({ detail: 'Pass episode_codes (array) or all_eligible=true' })
    }
    const { cleanupChunkedSidecars } = await import('../services/chunked-sidecar-cleanup.js')
    const result = await cleanupChunkedSidecars(req.params.slug, {
      episode_codes: codes,
      all_eligible: allEligible,
    })
    res.json(result)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Sidecar cleanup failed'))
  }
})

// Where finished videos go: `<Library>/Exports`, or the folder chosen through
// `PUT /library/exports` (v1.4.249). Read-only here; kept so callers can ask
// whether the folder is reachable.

router.get('/app-settings/external-final-video-root', async (_req, res) => {
  try {
    const { getExternalFinalVideoRoot, externalRootIsReachable } = await import('../services/external-video-store.js')
    const value = await getExternalFinalVideoRoot()
    const reach = await externalRootIsReachable()
    const { getCustomExportsRoot } = await import('../services/library.js')
    const custom = !!(await getCustomExportsRoot())
    res.json({ value, reachable: reach.ok, reason: reach.reason || '', derived: !custom, custom })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to read the exports folder'))
  }
})

// v1.4.5 — `POST /storage/migrate-finals-to-external` is gone. It moved
// finished videos with an unverified copy-then-delete across volumes, which is
// the one operation this app must never get wrong. See the note where
// `migrateFinalsToExternal` used to live in services/storage-audit.ts; the
// archive sweep (routes/library.ts) does the job with verification.

// Level B — move existing HEAVY media (images/thumbnails/audio/merged/video)
// to the project's configured media_root. `{ dry_run: true }` previews only.
router.post('/projects/:slug/storage/migrate-media-to-external', async (req, res) => {
  try {
    if (!await pm.getProject(req.params.slug)) return res.status(404).json({ detail: 'Project not found' })
    const dryRun = req.body?.dry_run === true
    const { migrateMediaToExternal } = await import('../services/storage-audit.js')
    const result = await migrateMediaToExternal(req.params.slug, { dryRun })
    res.json(result)
  } catch (e: any) {
    const status = /not configured|can't be resolved|not found/i.test(e?.message || '') ? 400 : 500
    res.status(status).json(humanizeBackendError(e, 'Media migration failed'))
  }
})
