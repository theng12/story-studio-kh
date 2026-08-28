import { Router } from 'express'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import pathMod from 'path'
import * as pm from '../services/project-manager.js'
import * as jq from '../services/job-queue.js'
import * as cm from '../services/character-manager.js'
import { castImagePromptBlock } from '../lib/character-prompt-blocks.js'
import { callAi, callAiWithRetry, hasAnyTextProviderKey } from '../lib/ai-client.js'
import { resolveEpisodePaths } from '../services/utils.js'
import { resolveReadPath, readArtifactRawText, resolveArtifact, matchChapterFile } from '../lib/episode-artifacts.js'
import { buildImagePromptsDocx } from '../lib/docx-builder.js'
import { resolveSubfolder, resolveEpisodeDir } from '../lib/folder-resolver.js'
import { resolveSubfolderNames } from '../services/utils.js'
import { trackGeneration } from '../services/session-tracker.js'
import { formatMetadataTxt, parseMetadataTxt } from '../services/metadata-format.js'
import { validateBody } from '../lib/validate.js'
import { GenerateScriptOnlySchema, GenerateIntroductionOnlySchema, GenerateChapterOnlySchema } from '../schemas/index.js'
import { buildDescriptionPrompt } from '../lib/metadata-prompt.js'
import {
  metadataFormulaCatalogue,
  metadataFormulaPlan,
  resolveActiveMetadataFormula,
  withMetadataFormulaShape,
} from '../services/metadata-formula-catalogue.js'
import { stripInternalSectionLabels } from '../lib/metadata-label-leak.js'
import { applyEmojiPolicy, applyEmojiPolicyToAll, noEmojiDirective } from '../lib/emoji-policy.js'
import { appendSourcesToDescription, sourcesSectionEnabled } from '../lib/research-sources.js'
import { prependAvoidanceToPrompt, recordUsageForScope } from '../services/recency-tracker.js'
import { getEffectiveFormat } from '../services/format-loader.js'
import { resolveTextStyle, resolveFontStyle } from '../models/thumbnail-styles.js'
import { writeJsonAtomic, withLock } from '../lib/atomic-store.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'
import {
  finalizeYouTubeDescription,
  inspectYouTubeFinalizationStatus,
} from '../services/youtube-metadata-finalizer.js'
import { truncateChars } from '../lib/well-formed-text.js'

export const router = Router()

// Legacy `POST /generate/script` (the coupled chapters+intro flow) was
// removed in M1 — there's now exactly one way to generate the two halves
// across the entire system: `/generate/script-only` then optionally
// `/generate/introduction-only`. Pipeline batch chains them as separate
// steps. See plan file (M1) for the full rationale.

// Generate script only (chapters, no introduction)
router.post('/projects/:slug/generate/script-only', validateBody(GenerateScriptOnlySchema), async (req, res) => {
  const { slug } = req.params
  const project = await pm.getProject(slug)
  if (!project) return res.status(404).json({ detail: 'Project not found' })

  const config = await pm.getConfig(slug)
  if (!(await hasAnyTextProviderKey(config))) {
    return res.status(400).json({ detail: 'No AI API key configured. Add one in Settings.' })
  }

  if (jq.isDuplicate(slug, req.body.episode_id, 'script-only')) {
    return res.status(409).json({ detail: `Script generation already queued/running for ${req.body.episode_id}` })
  }

  const job = await jq.enqueue({
    project_slug: slug,
    type: 'script-only',
    episode_id: req.body.episode_id,
    title: req.body.title,
    params: req.body,
  })
  res.status(201).json(job)
})

// ── Outline-first chunked flow (v1.0.72+) ────────────────────────────────
//
// Step 1: POST /generate/outline-only — builds the outline, persists a
// sidecar with outline_approved_at: null. Frontend renders OutlineReviewPanel.
//
// Step 2: GET / PUT  /episodes/:id/outline — read & edit the outline.
// PUT with `approved: true` flips outline_approved_at, unlocking expansion.
//
// Step 3: POST /generate/expand-chapters — runs the multi-batch expansion
// via expandChapters(). Optional `chapters: number[]` filter expands a
// subset; absent = expand all pending. Refuses unless outline is approved.
//
// The legacy script-only path stays available; Phase 3 will retire it.
router.post('/projects/:slug/generate/outline-only', validateBody(GenerateScriptOnlySchema), async (req, res) => {
  const { slug } = req.params
  const project = await pm.getProject(slug)
  if (!project) return res.status(404).json({ detail: 'Project not found' })

  const config = await pm.getConfig(slug)
  if (!(await hasAnyTextProviderKey(config))) {
    return res.status(400).json({ detail: 'No AI API key configured. Add one in Settings.' })
  }

  if (jq.isDuplicate(slug, req.body.episode_id, 'outline_only')) {
    return res.status(409).json({ detail: `Outline build already queued/running for ${req.body.episode_id}` })
  }

  const job = await jq.enqueue({
    project_slug: slug,
    type: 'outline_only',
    episode_id: req.body.episode_id,
    title: req.body.title,
    params: req.body,
  })
  res.status(201).json(job)
})

router.post('/projects/:slug/generate/expand-chapters', async (req, res) => {
  const { slug } = req.params
  const project = await pm.getProject(slug)
  if (!project) return res.status(404).json({ detail: 'Project not found' })

  const config = await pm.getConfig(slug)
  if (!(await hasAnyTextProviderKey(config))) {
    return res.status(400).json({ detail: 'No AI API key configured. Add one in Settings.' })
  }

  const { episode_id, title } = req.body || {}
  if (typeof episode_id !== 'string' || !episode_id) {
    return res.status(400).json({ detail: 'episode_id is required' })
  }

  // Pre-flight: confirm a sidecar exists AND is approved (or auto_approve).
  // Without this check the executor would also throw, but surfacing the
  // condition early gives the frontend a clean 400 to react on (vs a
  // job-error toast after the fact).
  //
  // Probe via readSidecar (full sidecar) instead of a chapter-1 lookup —
  // a hand-edited outline could legitimately drop n=1 (e.g. user reorders
  // and then approves), and the prior chapter-1-only probe would 400 even
  // though the outline is well-formed. readSidecar also gives us
  // total_chapters for the chapters[] range check below.
  const { resolveEpisodePaths } = await import('../services/utils.js')
  const { readSidecar } = await import('../lib/chunked-narration.js')
  const paths = await resolveEpisodePaths(slug, episode_id, title || '')
  const sidecar = await readSidecar(paths.script_dir, episode_id)
  if (!sidecar && !req.body.auto_approve) {
    return res.status(400).json({
      detail: 'No outline found. Click Generate Outline first, then approve before expanding.',
    })
  }

  // Validate the optional filter list (`chapters_to_expand`) when present.
  // The OutlineReviewPanel sends an integer array of chapter numbers to
  // partially expand; the executor at episode.ts:1211 reads exactly that
  // field. Earlier versions of this route validated `chapters` (the
  // chapter-COUNT field from the script-form payload, an integer) as if
  // it were the filter array, which always 400'd when the frontend was
  // working as designed — fixed in v1.0.85 by matching the executor's
  // contract.
  //
  // Accept an array of integers in 1..total_chapters, deduped. Reject
  // non-arrays, NaN, out-of-range, and non-integer entries — the
  // executor would silently skip these which is confusing UX (user
  // gets a 201 + no work done). Empty array is allowed (means "expand
  // all pending"); we normalise it to `undefined` so the executor
  // takes the no-filter path.
  if (req.body.chapters_to_expand !== undefined) {
    if (!Array.isArray(req.body.chapters_to_expand)) {
      return res.status(400).json({ detail: '`chapters_to_expand` must be an array of chapter numbers.' })
    }
    if (sidecar) {
      const total = sidecar.total_chapters
      const seen = new Set<number>()
      const cleaned: number[] = []
      for (const raw of req.body.chapters_to_expand) {
        const n = Number(raw)
        if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > total) {
          return res.status(400).json({
            detail: `Invalid chapter number in \`chapters_to_expand\`: ${raw} (must be an integer 1..${total}).`,
          })
        }
        if (seen.has(n)) continue
        seen.add(n); cleaned.push(n)
      }
      // Replace the request body so the executor sees the cleaned set.
      // Empty after de-dup → drop the field entirely (= expand all pending).
      if (cleaned.length === 0) delete req.body.chapters_to_expand
      else req.body.chapters_to_expand = cleaned
    }
  }

  // v1.0.786 — the queue job carries the model expansion will ACTUALLY use,
  // which is the caller's current selection. This used to overwrite the body's
  // model with the outline snapshot's, so a stale recorded id reached the
  // executor even when a valid model was selected in the form, and the run
  // dead-ended on "not available — choose a published product". The snapshot
  // is still the fallback for a caller that names no model at all; the
  // executor logs the substitution either way. `job.params.model` stays a real
  // id so the queue's retry-eligibility check keeps working without extra I/O.
  const selectedModel = typeof req.body?.model === 'string' && req.body.model.trim()
    ? req.body.model.trim()
    : undefined
  const expansionModel = selectedModel || sidecar?.generation_params?.model
  const { terminal_retry_job_id: terminalRetryJobId, ...expansionRequest } = req.body
  const validatedParams = {
    ...expansionRequest,
    ...(expansionModel ? { model: expansionModel } : {}),
  }

  // Keep the paid-work boundary ahead of both normal enqueue and a terminal
  // replacement. enqueue() also defends this invariant atomically, but this
  // route must not begin terminal-retry handling while another expansion owns
  // the episode.
  if (jq.isDuplicate(slug, episode_id, 'expand_chapters')) {
    return res.status(409).json({ detail: `Chapter expansion already queued/running for ${episode_id}` })
  }

  // Full Script-page Resume sends a terminal source reference alongside its
  // current form fields. The queue chooses exact replay while any chat batch
  // is unresolved, and can mint a replacement scope only after all settle.
  // The body itself is never trusted to supply a provider identity.
  if (terminalRetryJobId !== undefined) {
    if (typeof terminalRetryJobId !== 'string' || !terminalRetryJobId) {
      return res.status(400).json({ detail: 'terminal_retry_job_id must be a job ID.' })
    }
    const job = jq.retryTerminalChapterExpansion(
      slug,
      terminalRetryJobId,
      episode_id,
      validatedParams,
    )
    return res.status(201).json(job)
  }

  if (jq.hasUnresolvedTerminalChapterExpansion(slug, episode_id)) {
    return res.status(409).json({
      detail: 'A terminal chapter expansion has unresolved GenStudio chat evidence. Resume that job before starting another expansion.',
    })
  }

  const job = await jq.enqueue({
    project_slug: slug,
    type: 'expand_chapters',
    episode_id,
    title: title || '',
    params: validatedParams,
  })
  res.status(201).json(job)
})

router.get('/projects/:slug/episodes/:episodeId/outline', async (req, res) => {
  const { slug, episodeId } = req.params
  try {
    const project = await pm.getProject(slug)
    if (!project) return res.status(404).json({ detail: 'Project not found' })
    const titleParam = (req.query.title as string) || ''
    const paths = await resolveEpisodePaths(slug, episodeId, titleParam)
    const { sidecarPath, readSidecar } = await import('../lib/chunked-narration.js')
    const sidecarFile = sidecarPath(paths.script_dir, episodeId)
    if (!existsSync(sidecarFile)) {
      return res.status(404).json({ detail: 'No outline sidecar for this episode (run outline-only first).' })
    }
    // readSidecar handles v1/v2 → v3 migration in-memory and is the single
    // source of truth for sidecar field semantics. Reading it directly here
    // (instead of re-implementing the migration with `??` fallbacks) avoids
    // the bug where `outline_approved_at: null` (an EXPLICIT draft state on
    // v3 sidecars) was being clobbered by `?? sidecar.outline_completed_at`,
    // which made the frontend think a draft outline was approved — hiding
    // the "✓ Mark approved" button while expand-chapters still rejected
    // with "Outline not approved yet", a dead-end state for the user.
    const sidecar = await readSidecar(paths.script_dir, episodeId)
    if (!sidecar) {
      return res.status(404).json({ detail: 'No outline sidecar for this episode (run outline-only first).' })
    }
    res.json({
      mode: sidecar.mode,
      total_chapters: sidecar.total_chapters,
      outline: sidecar.outline,
      outline_completed_at: sidecar.outline_completed_at,
      outline_approved_at: sidecar.outline_approved_at,
      outline_edited_at: sidecar.outline_edited_at,
      chapters_done: sidecar.chapters_done || [],
      // v3+: snapshot of the form fields used to build the outline. Frontend
      // shows this in OutlineReviewPanel as "Locked at outline build" so
      // the user understands which model + words + pattern + cast the
      // upcoming expand will run against. null on v1/v2 sidecars.
      generation_params: sidecar.generation_params,
    })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Could not load outline'))
  }
})

router.put('/projects/:slug/episodes/:episodeId/outline', async (req, res) => {
  const { slug, episodeId } = req.params
  try {
    const project = await pm.getProject(slug)
    if (!project) return res.status(404).json({ detail: 'Project not found' })
    const titleParam = (req.query.title as string) || ''
    const paths = await resolveEpisodePaths(slug, episodeId, titleParam)
    const { sidecarPath } = await import('../lib/chunked-narration.js')
    const sidecarFile = sidecarPath(paths.script_dir, episodeId)
    if (!existsSync(sidecarFile)) {
      return res.status(404).json({ detail: 'No outline to edit (run outline-only first).' })
    }

    const incoming = req.body?.outline
    const wantApproved = req.body?.approved === true
    if (!Array.isArray(incoming)) {
      return res.status(400).json({ detail: 'Body must include `outline: OutlineEntry[]`.' })
    }

    // Read existing sidecar so we preserve fields the client doesn't send
    // (chapters_done, params_hash, mode, total_chapters).
    const raw = await fs.readFile(sidecarFile, 'utf-8')
    const existing = JSON.parse(raw)
    const totalChapters = existing.total_chapters

    // Length must match total_chapters: the rest of the chunked machinery
    // (expandChapters' pending-set computation, the OutlineReviewPanel's row
    // ↔ chapter-on-disk pairing, chapters_done invariants) all assume
    // outline.length === total_chapters. A truncated edit would silently
    // strand later chapters.
    if (incoming.length !== totalChapters) {
      return res.status(400).json({
        detail: `Outline must have exactly ${totalChapters} entries (got ${incoming.length}).`,
      })
    }

    // Validate: every entry has a numeric n in 1..total_chapters, no dupes,
    // title is a non-empty string. Other fields are optional and pass-through.
    // Combined with the length check above, unique + in-range n means every
    // chapter number 1..total_chapters is covered exactly once.
    const seen = new Set<number>()
    for (const e of incoming) {
      const n = Number((e as any)?.n)
      if (!Number.isFinite(n) || n < 1 || n > totalChapters) {
        return res.status(400).json({ detail: `Outline entry has invalid n: ${(e as any)?.n}` })
      }
      if (seen.has(n)) {
        return res.status(400).json({ detail: `Duplicate chapter number in outline: ${n}` })
      }
      seen.add(n)
      if (typeof (e as any)?.title !== 'string' || !(e as any).title.trim()) {
        return res.status(400).json({ detail: `Outline entry ${n} is missing title.` })
      }
    }

    const nowIso = new Date().toISOString()
    // Approval-timestamp semantics: `approved: true` means "ensure this is
    // approved", not "stamp approved-at = now". A silent autosave fired
    // mid-edit on an already-approved outline used to bump the timestamp
    // forward on every keystroke (the UI then showed "Approved 0m ago"
    // forever). Preserve the original first-approval timestamp; only
    // populate when transitioning from unapproved → approved.
    const approvedAt = wantApproved
      ? (existing.outline_approved_at ?? nowIso)
      : (existing.outline_approved_at ?? null)
    const updated = {
      ...existing,
      outline: incoming,
      outline_edited_at: nowIso,
      outline_approved_at: approvedAt,
      last_updated: nowIso,
    }
    await writeJsonAtomic(sidecarFile, updated)
    res.json({
      ok: true,
      outline_edited_at: updated.outline_edited_at,
      outline_approved_at: updated.outline_approved_at,
    })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Could not save outline'))
  }
})

// ── Bring-your-own content (v1.0.269) ───────────────────────────────────
// Inject a user-supplied full script or outline into an existing episode so
// the rest of the pipeline (Audio → Subtitles → Scene Plan, or Expand Chapters)
// runs on it without going through format-shaped generation.

/** Parse a pasted plain-text outline (one chapter per line) into entries.
 *  Strips common leading markers and splits an optional synopsis after a
 *  dash/colon. */
function parseOutlineText(text: string): Array<{ title: string; synopsis?: string }> {
  return text.split('\n').map(l => l.trim()).filter(Boolean).map((line) => {
    const s = line
      .replace(/^#{1,6}\s*/, '')
      .replace(/^(?:chapter|part|section|topic|reason|lesson|bit|beat)\s+\d+\s*[:\-–—.]\s*/i, '')
      .replace(/^\d+\s*[.)\-–—:]\s*/, '')
      .replace(/^[-*•]\s*/, '')
      .trim()
    const m = s.match(/^(.+?)\s*(?:—|–|\s-\s|:)\s+(.+)$/)
    return m ? { title: m[1]!.trim(), synopsis: m[2]!.trim() } : { title: s }
  }).filter(o => o.title)
}

/**
 * Resolve the on-disk Script subfolder to write an imported/pasted script or
 * outline into, preferring the EXISTING episode folder over a freshly built
 * path.
 *
 * `resolveEpisodePaths` constructs the folder name from the *request* title, so
 * a pasted script whose title differs even slightly from the title the folder
 * was originally created with (a rename that never reached disk, copy-paste
 * drift, or a "✅ " done-marker prefix on the folder) would otherwise land in a
 * brand-new phantom folder right next to the real one — exactly the "it made a
 * new folder instead of using mine" bug, and a mess at bulk-import scale.
 *
 * Fix: match the real folder by `${code} - ` prefix (✅-tolerant) the same way
 * `image-prompts/save` does, then find/create the Script subfolder inside it.
 * Only when no folder matches the code do we fall back to creating the computed
 * path — a genuinely new episode. This converges every writer on one on-disk
 * folder per episode.
 */
async function resolveScriptDirForImport(slug: string, episodeId: string, title: string): Promise<string> {
  const paths = await resolveEpisodePaths(slug, episodeId, title)
  const computedEpisodeDir = paths.episode_dir.replace(/\/$/, '')
  const seasonDir = pathMod.dirname(computedEpisodeDir)
  const actualDir = await resolveEpisodeDir(seasonDir, episodeId)
  if (!actualDir) {
    console.warn(
      `[script-import] episode ${slug}/${episodeId}: no existing folder under ${seasonDir} ` +
      `matches "${episodeId} - " prefix — creating "${pathMod.basename(computedEpisodeDir)}". ` +
      `(Expected when importing a script for an episode whose folder was never generated.)`,
    )
    await fs.mkdir(paths.script_dir, { recursive: true })
    return paths.script_dir
  }
  if (actualDir !== computedEpisodeDir) {
    console.log(
      `[script-import] episode ${slug}/${episodeId}: request title yielded ` +
      `"${pathMod.basename(computedEpisodeDir)}" but on-disk folder is ` +
      `"${pathMod.basename(actualDir)}". Writing into the existing folder.`,
    )
  }
  // Find/create the Script subfolder inside the real episode dir (✅-tolerant,
  // never duplicates a "✅ "-marked subfolder).
  return resolveSubfolder(actualDir, pathMod.basename(paths.script_dir), true)
}

// POST import-script — paste a finished script; written as per-chapter files +
// the unified narration so Audio/Subtitles/Scene Plan run on it directly.
router.post('/projects/:slug/episodes/:episodeId/import-script', async (req, res) => {
  const { slug, episodeId } = req.params
  try {
    const project = await pm.getProject(slug)
    if (!project) return res.status(404).json({ detail: 'Project not found' })
    const text = typeof req.body?.text === 'string' ? req.body.text : ''
    const title = typeof req.body?.title === 'string' ? req.body.title : ''
    if (!text.trim()) return res.status(400).json({ detail: 'Paste your script in `text`.' })

    const scriptDir = await resolveScriptDirForImport(slug, episodeId, title)

    const { splitNarrationIntoChapters, writeChapterFiles, assembleUnifiedNarration } =
      await import('../lib/narration-assembly.js')
    let parts = splitNarrationIntoChapters(text)
    if (!parts.chapters.length) {
      // No `## Chapter N:` headings → import the whole thing as one chapter.
      parts = { chapters: [{ number: 1, title: title || 'Script', text: text.trim() }], ...(parts.intro ? { intro: parts.intro } : {}) }
    }

    // Clear prior script artifacts for this episode so a re-import is clean.
    const entries = await fs.readdir(scriptDir).catch(() => [] as string[])
    for (const f of entries) {
      if (
        new RegExp(`^${episodeId}_Chapter_\\d+\\.(md|docx)$`).test(f) ||
        new RegExp(`^${episodeId}_Introduction\\.(md|docx)$`).test(f) ||
        new RegExp(`^${episodeId}_Script_Narration\\.(md|docx)$`).test(f) ||
        f === `${episodeId}_Script_Narration.intro.json` ||
        f === `${episodeId}_chunked-progress.json`
      ) {
        await fs.rm(pathMod.join(scriptDir, f), { force: true }).catch(() => {})
      }
    }

    await writeChapterFiles(scriptDir, episodeId, title || episodeId, parts)
    const asm = await assembleUnifiedNarration(scriptDir, episodeId, title || episodeId)
    if (asm.introduction_present) {
      await writeJsonAtomic(pathMod.join(scriptDir, `${episodeId}_Script_Narration.intro.json`), { imported_at: new Date().toISOString() })
    }

    const { episodeStatusCache } = await import('../services/episode-status-cache.js')
    episodeStatusCache.invalidate(slug, episodeId)
    res.json({ ok: true, chapters: asm.chapter_numbers.length, introduction: asm.introduction_present })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to import script'))
  }
})

// POST import-outline — paste an outline (structured or one chapter per line);
// written as an APPROVED sidecar so "Expand Chapters" runs on it.
router.post('/projects/:slug/episodes/:episodeId/import-outline', async (req, res) => {
  const { slug, episodeId } = req.params
  try {
    const project = await pm.getProject(slug)
    if (!project) return res.status(404).json({ detail: 'Project not found' })
    const title = typeof req.body?.title === 'string' ? req.body.title : ''
    let outline: Array<{ title: string; synopsis?: string }> = []
    if (Array.isArray(req.body?.outline)) {
      outline = req.body.outline
        .map((o: any) => ({ title: String(o?.title || '').trim(), synopsis: o?.synopsis ? String(o.synopsis).trim() : undefined }))
        .filter((o: any) => o.title)
    } else if (typeof req.body?.text === 'string') {
      outline = parseOutlineText(req.body.text)
    }
    if (!outline.length) return res.status(400).json({ detail: 'Provide `outline[]` or `text` (one chapter per line).' })

    const scriptDir = await resolveScriptDirForImport(slug, episodeId, title)
    const fmt = await getEffectiveFormat(slug).catch(() => null as any)
    const mode = fmt?.id === 'listicle' ? 'listicle' : 'narrative'
    const { writeImportedOutline } = await import('../lib/chunked-narration.js')
    const sidecar = await writeImportedOutline(scriptDir, episodeId, outline, { mode })

    const { episodeStatusCache } = await import('../services/episode-status-cache.js')
    episodeStatusCache.invalidate(slug, episodeId)
    res.json({ ok: true, chapters: sidecar.total_chapters })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to import outline'))
  }
})

// Regenerate ONE chapter (per-chapter refactor). Requires existing
// chapter source files OR a legacy unified narration we can migrate
// from on first use. Other chapters on disk are preserved; the unified
// narration_docx is re-assembled afterward so audio / subtitles / video
// all see the new content.
router.post('/projects/:slug/generate/chapter-only', validateBody(GenerateChapterOnlySchema), async (req, res) => {
  const { slug } = req.params
  const project = await pm.getProject(slug)
  if (!project) return res.status(404).json({ detail: 'Project not found' })

  const config = await pm.getConfig(slug)
  if (!(await hasAnyTextProviderKey(config))) {
    return res.status(400).json({ detail: 'No AI API key configured. Add one in Settings.' })
  }

  // Dedupe per (episode, chapter) — two clicks on the SAME chapter's
  // regenerate button shouldn't enqueue twice, but the user can queue
  // multiple DIFFERENT chapters in a row (they run back-to-back). The
  // narrowed predicate compares params.chapter_number so two clicks on
  // ch.5 dedupe while ch.5 + ch.7 both enqueue.
  const requestedChapter = Number(req.body.chapter_number)
  const sameChapter = (params: any) => Number(params?.chapter_number) === requestedChapter
  if (jq.isDuplicate(slug, req.body.episode_id, 'chapter-only', sameChapter)) {
    return res.status(409).json({
      detail: `Chapter ${requestedChapter} regen is already queued for ${req.body.episode_id}`,
    })
  }

  const job = await jq.enqueue({
    project_slug: slug,
    type: 'chapter-only',
    episode_id: req.body.episode_id,
    title: req.body.title,
    params: req.body,
    dedupeParams: sameChapter,
  })
  res.status(201).json(job)
})

// Generate introduction only (requires script to exist)
router.post('/projects/:slug/generate/introduction-only', validateBody(GenerateIntroductionOnlySchema), async (req, res) => {
  const { slug } = req.params
  const project = await pm.getProject(slug)
  if (!project) return res.status(404).json({ detail: 'Project not found' })

  const config = await pm.getConfig(slug)
  if (!(await hasAnyTextProviderKey(config))) {
    return res.status(400).json({ detail: 'No AI API key configured. Add one in Settings.' })
  }

  if (jq.isDuplicate(slug, req.body.episode_id, 'introduction-only')) {
    return res.status(409).json({ detail: `Introduction generation already queued/running for ${req.body.episode_id}` })
  }

  // The caller names an episode; the server works out the rest.
  //
  // Nothing about HOW the opening is written travels with the request. Its
  // recipe — beats, wording, length, host, and now the model — is read from
  // the channel, so the Introduction page's button, the Script page's chained
  // run and an unattended batch all write from identical instructions. A batch
  // and a button producing different openings is exactly the defect this
  // shape exists to make impossible.
  //
  // The title is still resolved here rather than asked for, because the app
  // already knows an accepted episode's title and a caller that supplied one
  // could supply a different one.
  let title = typeof req.body.title === 'string' ? req.body.title.trim() : ''
  if (!title) {
    try {
      const { getIdeas } = await import('../services/idea-manager.js')
      const wanted = String(req.body.episode_id).toUpperCase()
      const idea = (await getIdeas(slug)).find(i => (i.episode_code || '').toUpperCase() === wanted)
      title = idea?.title || ''
    } catch { /* an unnamed episode still resolves by code below */ }
  }

  // Three sources, in this order, and the order is the whole design:
  //
  //   1. The channel's own choice, made on the Introduction page. An explicit
  //      saved answer, so it wins — including over the model the Script page
  //      sends along with a chained opening, which is not a deliberate
  //      override but a leftover from when the opening had no setting.
  //   2. A model named in this request.
  //   3. The Script Generator's saved model — the behaviour every channel had
  //      before the picker existed, and what a blank choice still means.
  //
  // And if none of those answer: refuse. Never substitute a catalogue default.
  // An invented model is indistinguishable to the reader from one he chose,
  // and it would write the opening on a different product from its own
  // chapters — the defect fixed in v1.4.68.
  const { getSegmentModel } = await import('../services/channel-segments.js')
  const { INTRODUCTION_SEGMENT_ID } = await import('../lib/episode-segments.js')
  let model = await getSegmentModel(slug, INTRODUCTION_SEGMENT_ID)
  if (!model) model = typeof req.body.model === 'string' ? req.body.model.trim() : ''
  if (!model) {
    const { resolveScriptSideChatModel } = await import('./pipeline.js')
    model = resolveScriptSideChatModel(config as Record<string, unknown>) || ''
    if (!model) {
      return res.status(400).json({
        detail: 'This channel\'s opening follows the Script Generator\'s language model, and no saved '
          + 'script preset carries one. Either choose a model for the opening on the Introduction page, '
          + 'or open Script Generator, choose a model under Main settings and save the script preset. '
          + 'No model was substituted.',
      })
    }
  }

  const job = await jq.enqueue({
    project_slug: slug,
    type: 'introduction-only',
    episode_id: req.body.episode_id,
    title,
    params: { ...req.body, title, model },
  })
  res.status(201).json(job)
})

// ── Get script content for preview ──

router.get('/projects/:slug/episodes/:episodeId/script-content', async (req, res) => {
  const { slug, episodeId } = req.params
  const titleQuery = (req.query.title as string) || ''
  try {
    const paths = await resolveEpisodePaths(slug, episodeId, titleQuery)
    const result: any = { script: null, introduction: null }

    const narrationPath = resolveReadPath(paths.narration_docx)
    if (existsSync(narrationPath)) {
      // Single source of truth: introduction (when present) lives INSIDE
      // the narration file as an "Introduction" section, not in a sibling
      // file. We split here so each preview panel gets only its slice
      // while the underlying file stays unified for the audio /
      // subtitles / video pipelines.
      const { parseNarrationDocx } = await import('../lib/docx-parser.js')
      const sections = await parseNarrationDocx(narrationPath)
      const stat = await fs.stat(narrationPath)

      const introSection = sections.find(s => s.slug === 'Introduction')
      const chapterSections = sections.filter(s => s.slug !== 'Introduction')
      // Re-emit chapters as headed text so the preview reads like the
      // original docx layout instead of a flat blob.
      const chapterContent = chapterSections.length
        ? chapterSections.map(s => `${s.label}\n\n${s.text}`).join('\n\n')
        : ''
      result.script = {
        content: chapterContent,
        modifiedAt: stat.mtime.toISOString(),
        wordCount: chapterContent.split(/\s+/).filter(Boolean).length,
      }
      if (introSection) {
        result.introduction = {
          content: introSection.text,
          modifiedAt: stat.mtime.toISOString(),
          wordCount: introSection.text.split(/\s+/).filter(Boolean).length,
        }
      }
    }

    res.json(result)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Could not load script content'))
  }
})

// ── Per-chapter listing for the scripts.vue Chapters panel ──
//
// One row per chapter source file on disk. Triggers eager-migration if
// the episode has only the legacy unified narration (no per-chapter
// files yet) so the new UI works against pre-refactor projects without
// the user having to do anything.
//
// `audio_stale` compares chapter source mtime against the corresponding
// audio chunk file's mtime. Read-only — no auto-deletion. The selector
// surfaces it as a "⚠ stale" pill so the user can choose to regenerate
// audio when ready.
router.get('/projects/:slug/episodes/:episodeId/chapter-list', async (req, res) => {
  const { slug, episodeId } = req.params
  const titleQuery = (req.query.title as string) || ''
  try {
    const paths = await resolveEpisodePaths(slug, episodeId, titleQuery)

    const { ensureChapterFilesMigrated } =
      await import('../lib/narration-assembly.js')
    await ensureChapterFilesMigrated(paths.script_dir, episodeId, titleQuery)

    let entries: string[] = []
    try { entries = await fs.readdir(paths.script_dir) } catch { /* missing dir */ }

    // v1.0.249 — enumerate BOTH new `.md` and legacy `.docx` chapter files
    // (matchChapterFile accepts either). The old regex was `.docx`-only, so
    // new-format episodes showed "No chapters yet". De-dupe in case a partially
    // migrated dir has both extensions for the same chapter number.
    const numbers = Array.from(new Set(
      entries
        .map(n => matchChapterFile(n, episodeId))
        .filter((x): x is number => x !== null),
    )).sort((a, b) => a - b)

    // Audio chunk presence is per-section. The reconciler builds chunk
    // filenames as `{CODE}_Chapter_NN.mp3` (single chunk) or
    // `{CODE}_Chapter_NN_part{N}.mp3` (multi). We compare the chapter
    // source mtime against ANY matching audio chunk on disk — if every
    // chunk is older than the source, the audio is stale.
    let audioEntries: string[] = []
    try {
      const audioDir = paths.audio_dir
      if (existsSync(audioDir)) audioEntries = await fs.readdir(audioDir)
    } catch { /* no audio dir yet */ }

    const { parseNarrationDocx } = await import('../lib/docx-parser.js')

    const chapters: Array<{
      number: number
      title: string
      present: boolean
      word_count: number
      character_count: number
      modified_at: string | null
      audio_stale: boolean
    }> = []
    for (const num of numbers) {
      // Prefer the new `.md`, fall back to legacy `.docx`.
      const filePath = resolveArtifact(paths.script_dir, `${episodeId}_Chapter_${String(num).padStart(2, '0')}`)
      let title = `Chapter ${String(num).padStart(2, '0')}`
      let wordCount = 0
      let characterCount = 0
      let modifiedAt: string | null = null
      try {
        if (!filePath) throw new Error('chapter file not found')
        const stat = await fs.stat(filePath)
        modifiedAt = stat.mtime.toISOString()
        // Single mammoth parse per chapter — parseNarrationDocx now exposes
        // the descriptive title (the part AFTER "Chapter NN:") on the section
        // it returns. Previously we paid a second mammoth.convertToHtml call
        // per chapter just to recover the heading; for a 50-chapter listicle
        // that doubled the parse cost on every /chapter-list refresh, and
        // the route is hit on every job-completion tick during active work.
        const sections = await parseNarrationDocx(filePath)
        const sec = sections[0]
        if (sec) {
          const body = sec.text || ''
          wordCount = body.split(/\s+/).filter(Boolean).length
          // Character count over the body (whitespace included). Useful
          // for content-volume comparisons against TTS billing meters,
          // which charge per-character not per-word.
          characterCount = body.length
          if (sec.title) title = sec.title
        }
      } catch { /* unreadable file → present:false below */ }

      // Stale check: chapter source newer than ALL existing audio
      // chunks for this section means audio is out of date.
      const slug = `Chapter_${String(num).padStart(2, '0')}`
      const chunkRe = new RegExp(`^${episodeId}_${slug}(?:_part\\d+)?\\.mp3$`)
      let audioStale = false
      if (modifiedAt && audioEntries.length) {
        const matchingChunks = audioEntries.filter(n => chunkRe.test(n))
        if (matchingChunks.length) {
          const sourceMs = new Date(modifiedAt).getTime()
          let anyFresher = false
          for (const c of matchingChunks) {
            try {
              const cs = await fs.stat(pathMod.join(paths.audio_dir, c))
              if (cs.mtimeMs >= sourceMs) { anyFresher = true; break }
            } catch { /* skip */ }
          }
          audioStale = !anyFresher
        }
      }

      chapters.push({
        number: num,
        title,
        present: !!modifiedAt,
        word_count: wordCount,
        character_count: characterCount,
        modified_at: modifiedAt,
        audio_stale: audioStale,
      })
    }

    res.json({ chapters })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Could not list chapters'))
  }
})

// Per-chapter content read — drives the inline preview rows in
// ChapterListPanel. Returns the chapter's heading title + plain-text body
// + word_count + modified_at, lazy-loaded one chapter at a time so opening
// the panel doesn't pay for parsing N docx files up front.
//
// Read-only by design (per the user's choice in plan review). If we ever
// want inline editing, add a sibling PUT that round-trips the body back
// through buildNarrationDocx + assembleUnifiedNarration.
router.get('/projects/:slug/episodes/:episodeId/chapters/:chapterNumber/content', async (req, res) => {
  const { slug, episodeId, chapterNumber } = req.params
  const titleQuery = (req.query.title as string) || ''
  const n = Number(chapterNumber)
  if (!Number.isFinite(n) || n < 1) {
    return res.status(400).json({ detail: `Invalid chapter number: ${chapterNumber}` })
  }
  try {
    const paths = await resolveEpisodePaths(slug, episodeId, titleQuery)
    // v1.0.249 — resolve the chapter file in either format: new `.md` first,
    // legacy `.docx` fallback. Previously this only looked for `.md`, so the
    // inline preview 404'd on whichever format the episode didn't have.
    const filePath = resolveArtifact(paths.script_dir, `${episodeId}_Chapter_${String(n).padStart(2, '0')}`)
    if (!filePath) {
      return res.status(404).json({
        detail: `Chapter ${n} is not on disk yet. Expand it from the outline panel first.`,
      })
    }

    const stat = await fs.stat(filePath)
    const modifiedAt = stat.mtime.toISOString()

    // Single mammoth parse: parseNarrationDocx exposes the descriptive
    // title on the section now, so we don't need a second convertToHtml
    // round-trip just to recover the heading. The section label
    // ("Chapter NN") gets stripped for the body — the user wants the
    // narrative prose, not the header line.
    const { parseNarrationDocx } = await import('../lib/docx-parser.js')
    const sections = await parseNarrationDocx(filePath)
    const body = (sections[0]?.text || '').trim()
    const wordCount = body.split(/\s+/).filter(Boolean).length
    let title = `Chapter ${String(n).padStart(2, '0')}`
    if (sections[0]?.title) title = sections[0].title
    // Character count drives per-chapter TTS billing previews — TTS
    // providers charge per-character, not per-word, so this is the
    // closer-to-truth volume signal for cost estimation.
    const characterCount = body.length

    res.json({
      number: n,
      title,
      content: body,
      word_count: wordCount,
      character_count: characterCount,
      modified_at: modifiedAt,
    })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, `Could not load chapter ${n}`))
  }
})

// ── Generate image prompts with style/ratio controls ──────────────────────
//
// v1.0.87+: this route used to run the LLM call synchronously in the
// request handler and return the parsed prompts. That meant:
//   - The job never appeared in the Jobs panel, so users couldn't see
//     progress, partial output, or errors mid-flight (a 250-scene job
//     can take 1–3 minutes; the old route just hung the request).
//   - The chunked-batch path lived only in the executor, so the route's
//     single LLM call hit output-token caps at 50+ scenes and silently
//     produced 5 instead of 250.
//
// Now the route enqueues an `image_prompts` job and returns `{ job }`.
// The executor in `generators/image-prompts.ts` is the single source of
// truth for thumbnail prompts: it writes the document to disk and reports
// progress + errors via the standard Jobs SSE stream. The frontend
// watches the returned job_id via useJobs and refreshes the
// PromptReviewPanel when the job lands in `done`.
//
// The legacy sync return shape (`{ scenes, thumbnails, style_tag,
// aspect_ratio }`) is gone. Callers that depended on it (the inline
// "Current" tab in image-prompts.vue) now read prompts from disk via
// `GET /projects/:slug/episodes/:episodeId/image-prompts` once the job
// completes — same endpoint PromptReviewPanel already uses.
router.post('/projects/:slug/generate/image-prompts', async (req, res) => {
  const { slug } = req.params
  const config = await pm.getConfig(slug)
  if (!config) return res.status(404).json({ detail: 'Config not found' })

  const { episode_id, model, title } = req.body
  if (typeof episode_id !== 'string' || !episode_id) {
    return res.status(400).json({ detail: 'episode_id is required' })
  }
  if (req.body?.mode && req.body.mode !== 'thumbnails') {
    return res.status(410).json({ detail: 'Legacy Scene Prompts generation is retired. Generate visual prompts in Scene Plan.' })
  }

  if (jq.isDuplicate(slug, episode_id, 'image_prompts')) {
    return res.status(409).json({
      detail: `Image-prompts generation already queued/running for ${episode_id}`,
    })
  }

  const job = await jq.enqueue({
    project_slug: slug,
    type: 'image_prompts',
    episode_id,
    title: title || '',
    // The executor reads params straight off this object — see
    // ImagePromptsParams in generators/image-prompts.ts. Pass the body
    // through verbatim so any field the form sends (style_tag, aspect_
    // ratio, thumb_*, mode, character_ids) flows untouched.
    params: { ...req.body, mode: req.body.mode || 'thumbnails' },
  })

  res.status(201).json(job)
})

// ── Save reviewed prompts to .docx ──

router.post('/projects/:slug/generate/image-prompts/save', async (req, res) => {
  const { slug } = req.params
  const { episode_id, title, prompts } = req.body
  try {
    if (Array.isArray(prompts?.scenes) && prompts.scenes.length > 0) {
      return res.status(410).json({ detail: 'Legacy Scene Prompts are retired. Save planned visual prompts through Scene Plan.' })
    }
    const paths = await resolveEpisodePaths(slug, episode_id, title || '')

    const pathMod = await import('path')
    const names = await resolveSubfolderNames(slug, episode_id)
    const computedEpisodeDir = paths.episode_dir.replace(/\/$/, '')
    let episodeDir = computedEpisodeDir

    // Resolve the actual episode dir on disk. resolveEpisodeDir matches by
    // `${code} - ` prefix, so a folder created with an older title (or
    // before a title rename that didn't reach the disk) is still found.
    // Returns null only when the season dir doesn't exist OR no folder
    // matches the prefix — both warrant a log line because saving image
    // prompts before any script-generated folder exists is unusual (the
    // user must have a script on disk to be reviewing prompts).
    const seasonDir = pathMod.dirname(episodeDir)
    const actualDir = await resolveEpisodeDir(seasonDir, episode_id)
    if (actualDir) {
      episodeDir = actualDir
      if (actualDir !== computedEpisodeDir) {
        console.log(
          `[image-prompts/save] episode ${slug}/${episode_id}: ` +
          `request title yielded "${pathMod.basename(computedEpisodeDir)}" but on-disk folder ` +
          `is "${pathMod.basename(actualDir)}". Using on-disk folder. ` +
          `(Title-sync may not have renamed; harmless if intentional.)`,
        )
      }
    } else {
      console.warn(
        `[image-prompts/save] episode ${slug}/${episode_id}: ` +
        `no existing episode folder under ${seasonDir} matches "${episode_id} - " prefix. ` +
        `Will create "${pathMod.basename(computedEpisodeDir)}". This usually means the script ` +
        `was never generated for this episode — check whether you're saving prompts to the ` +
        `right episode.`,
      )
    }

    // Save thumbnail prompts to Thumbnail Prompts folder. Same caveat as
    // scenes — log when the subfolder is freshly created.
    if ((prompts.thumbnails || []).length > 0) {
      const expectedThumbDir = pathMod.join(episodeDir, names.thumb_prompts)
      const thumbSubfolderExisted = existsSync(expectedThumbDir)
      const thumbDir = await resolveSubfolder(episodeDir, names.thumb_prompts)
      if (!thumbSubfolderExisted) {
        let nearby: string[] = []
        try {
          const entries = await fs.readdir(episodeDir, { withFileTypes: true })
          nearby = entries
            .filter(e => e.isDirectory() && /thumb/i.test(e.name) && e.name !== names.thumb_prompts)
            .map(e => e.name)
        } catch { /* episode dir might be brand new */ }
        console.warn(
          `[image-prompts/save] created NEW thumbnail-prompts folder "${names.thumb_prompts}" in ${episodeDir}. ` +
          (nearby.length ? `Possible orphan(s) with similar name: ${nearby.join(', ')}.` : 'No similar siblings.'),
        )
      }
      let thumbText = `# Thumbnail Prompts\n\n`
      for (const t of prompts.thumbnails) thumbText += `## Thumbnail ${t.number}: ${t.title}\n\n${t.prompt}\n\n`
      await buildImagePromptsDocx(thumbText, episode_id, title, pathMod.join(thumbDir, `${episode_id}_Thumbnail_Prompts.md`))
    }

    res.json({ ok: true, path: paths.thumb_prompts_docx })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to write image prompts'))
  }
})

// ══════════════════════════════════════════════════════════════════════════
// METADATA GENERATOR — title (SEO) + description + tags
// ══════════════════════════════════════════════════════════════════════════

async function readStoryContext(slug: string, episode_id: string, title: string, maxChars = 2000): Promise<string> {
  try {
    const paths = await resolveEpisodePaths(slug, episode_id, title || '')
    const raw = await readArtifactRawText(paths.narration_docx)
    return raw.slice(0, maxChars)
  } catch {
    return `Episode: ${episode_id}, Title: ${title}`
  }
}

function checkProvider(_model: string, _config: any): string | null { return null }

function aiCreds(_config: any) { return {} }

// `buildDescriptionPrompt` is imported above from lib/metadata-prompt.ts
// — that's the single source of truth for the section→prompt mapping.
// generators/metadata.ts also imports it.

// The old page generated title, description, and tags independently before
// narration timing existed. Keep an explicit machine-readable tombstone for
// older clients instead of silently allowing that workflow to bypass the
// one-pass YouTube Finalizer.
router.post([
  '/projects/:slug/generate/metadata/description',
  '/projects/:slug/generate/metadata/seo-titles',
  '/projects/:slug/generate/metadata/tags',
  '/projects/:slug/generate/metadata/all',
], (_req, res) => {
  res.status(410).json({
    code: 'LEGACY_METADATA_ROUTE_RETIRED',
    detail: 'This early metadata route is retired. Run Audio Assembly, then use YouTube Finalizer once the final timing is available.',
  })
})

// ── 1) Description ────────────────────────────────────────────────────────
// All four metadata generators below (description / seo-titles / tags / all)
// run their LLM calls synchronously in the request handler and return the
// generated content for in-page review before save. Per M5 (system audit):
// when these grow long enough to need observability, migrate to the queue
// via `enqueueOrRun(..., { sync: true })` — the seam is in services/job-queue.ts.

/**
 * The metadata formulas this channel can pick from, and which one it is on.
 *
 * Five ship with the app and a Content Pack adds more; the picker treats them
 * identically because they are identical — the same document kind, validated by
 * the same schema. `channel_default_id` is empty for a channel that has never
 * picked one, which is every channel that existed before formulas did.
 */
router.get('/projects/:slug/metadata/formulas', async (req, res) => {
  const { slug } = req.params
  const config = await pm.getConfig(slug)
  if (!config) return res.status(404).json({ detail: 'Config not found' })
  try {
    const rows = await metadataFormulaCatalogue()
    res.json({
      channel_default_id: typeof config.metadata_formula_id === 'string' ? config.metadata_formula_id : '',
      formulas: rows.map(row => ({
        id: row.id,
        name: row.name,
        description: row.description,
        architecture: row.architecture,
        source: row.source,
        pack_id: row.packId,
        section_count: row.document.description_plan.sections.length,
        description_max_chars: row.document.description_plan.max_chars,
        title_count: row.document.title_plan.count,
        tag_count: row.document.tag_plan.count,
        /** Header text where a section shows one, so the picker can preview the shape. */
        outline: row.document.description_plan.sections.map(section => ({
          id: section.id,
          header: section.header.render ? section.header.text ?? '' : '',
        })),
      })),
    })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Could not load metadata formulas'))
  }
})

router.post('/projects/:slug/generate/metadata/description', async (req, res) => {
  const { slug } = req.params
  const config = await pm.getConfig(slug)
  if (!config) return res.status(404).json({ detail: 'Config not found' })

  const { episode_id, title, model, sections, max_chars, metadata_formula_id } = req.body
  const credErr = checkProvider(model, config)
  if (credErr) return res.status(400).json({ detail: credErr })

  const storyContext = await readStoryContext(slug, episode_id, title)
  // Format passed through so the hashtags section can lean on
  // format.youtubeDescriptionStructure.defaultHashtags rather than
  // hardcoding #SleepStory examples.
  // v1.0.102+ — char limit ALSO format-driven. Previously hardcoded 5000
  // (sleep-story default); now reads format.metadata.defaultMaxChars so
  // each format can pick its own (prayer / mindfulness narration is
  // typically much shorter than a 60-min sleep story).
  const format = await getEffectiveFormat(slug)
  // 2026-08-27 — the metadata formula seam, the same one the queued generator
  // uses, so a channel that picked a formula gets the same architecture from
  // every path into metadata. Null when nothing picked one, and every line
  // below then resolves exactly as it did before formulas existed.
  const formulaEntry = await resolveActiveMetadataFormula({ requestedId: metadata_formula_id, config })
  const formula = formulaEntry ? metadataFormulaPlan(formulaEntry) : null
  // An explicit section list from the page still wins; the formula supplies
  // the architecture when the caller has none of its own.
  const effectiveSections = (Array.isArray(sections) && sections.length) ? sections : (formula?.sections ?? [])
  const promptFormat = formula ? withMetadataFormulaShape(format, formula, formulaEntry!.architecture) : format
  const effectiveMaxChars = max_chars || formula?.descriptionMaxChars || format?.metadata?.defaultMaxChars || 5000
  // v1.0.108+ — multi-scope recency. When the niche's rule covers the
  // 'metadata' scope (e.g. prayer's scripture refs), prepend the
  // avoidance instruction. No-op otherwise.
  const prompt = await prependAvoidanceToPrompt(
    slug,
    'metadata',
    buildDescriptionPrompt(episode_id, title, storyContext, effectiveSections, effectiveMaxChars, promptFormat),
  ) + await noEmojiDirective()

  try {
    // Standard: a full YouTube description. Titles/tags below stay short-form.
    const raw = await callAiWithRetry(model, '', prompt, aiCreds(config), false, {
      slug, outputBudget: 'standard',
    })
    await trackGeneration(slug, 'description')
    // Scan the freshly-generated description for any tracked items
    // and append to the recency log. Fail-soft analytics-style write.
    await recordUsageForScope(slug, episode_id, 'metadata', raw).catch(() => null)
    // v1.0.197 — append the kept research sources (deterministic, real URLs);
    // v1.0.198 — gated on the description's Sources section being present + on.
    const withSources = await appendSourcesToDescription(
      slug, episode_id, stripInternalSectionLabels(raw.trim()), format, effectiveMaxChars, sourcesSectionEnabled(sections),
    )
    res.json({ description: withSources.description })
  } catch (e: any) {
    // Honour explicit statusCode (400 validation, 402 quota, …) and
    // surface the raw error via humanizeBackendError so users see
    // actionable detail (provider quota, missing key, etc.) rather
    // than a flat "Generation failed: <terse>".
    const status = typeof e?.statusCode === 'number' ? e.statusCode : 500
    res.status(status).json(humanizeBackendError(e, 'Generation failed'))
  }
})

// ── 2) SEO Video Titles ───────────────────────────────────────────────────

router.post('/projects/:slug/generate/metadata/seo-titles', async (req, res) => {
  const { slug } = req.params
  const config = await pm.getConfig(slug)
  if (!config) return res.status(404).json({ detail: 'Config not found' })

  const {
    episode_id, title, model, count, max_length, platform_preset, include_script_context,
    title_mode, title_prefix, title_suffix, manual_title,
    metadata_formula_id,
  } = req.body
  const credErr = checkProvider(model, config)
  if (credErr) return res.status(400).json({ detail: credErr })

  // v1.0.90+: every produced title can be wrapped with a channel-level
  // prefix + suffix. Saves the user from re-typing channel boilerplate
  // ('Morning Prayer: ', ' | Daily Prayer Channel') every episode.
  const wrap = (s: string): string =>
    `${title_prefix ? String(title_prefix) : ''}${s}${title_suffix ? String(title_suffix) : ''}`

  // Fixed-title modes — no LLM call. Returns one title (count is ignored
  // because the user chose the wording explicitly; nothing to compare).
  if (title_mode === 'use_idea_title' || title_mode === 'manual') {
    const base = title_mode === 'manual'
      ? String(manual_title || '').trim()
      : String(title || '').trim()
    if (!base) {
      return res.status(400).json({ detail: title_mode === 'manual' ? 'manual_title is required' : 'idea title is empty' })
    }
    return res.json({ titles: [wrap(base)] })
  }

  const storyContext = include_script_context !== false
    ? await readStoryContext(slug, episode_id, title, 1500)
    : ''

  const platformNote = platform_preset && platform_preset !== 'custom'
    ? `Optimized for ${platform_preset} (max ${max_length} characters).`
    : `Maximum ${max_length} characters per title.`

  const format = await getEffectiveFormat(slug)
  // 2026-08-27 — the metadata formula seam, the same one the queued generator
  // uses, so a channel that picked a formula gets the same architecture from
  // every path into metadata. Null when nothing picked one, and every line
  // below then resolves exactly as it did before formulas existed.
  const formulaEntry = await resolveActiveMetadataFormula({ requestedId: metadata_formula_id, config })
  const formula = formulaEntry ? metadataFormulaPlan(formulaEntry) : null
  const hookRules = format.metadata.titleHookRules.map(r => `- ${r}`).join('\n')

  const prompt = `Generate ${count || formula?.titleCount || 5} SEO-optimized YouTube/TikTok/Facebook video title options ${format.metadata.purposeNote}.

Episode code: ${episode_id}
Working title: ${title}
${storyContext ? `\nStory context:\n${storyContext}\n` : ''}

Requirements:
- ${platformNote}
- Tone: ${formula?.titleGuidance || format.metadata.titleStyleHint}.
${hookRules}
- Each on its own line. No numbering, no quotes, no commentary.

Output exactly ${count || 5} title options, one per line.${await noEmojiDirective()}`

  try {
    const raw = await callAiWithRetry(model, '', prompt, aiCreds(config), false, { slug })
    await trackGeneration(slug, 'description')
    const rawTitles = raw
      .split('\n')
      .map(l => l.trim().replace(/^[\-\d\.\)]+\s*/, '').replace(/^["']|["']$/g, '').trim())
      .filter(Boolean)
      .slice(0, count || 5)
    // Wrap LLM titles with channel prefix/suffix so paraphrase mode
    // benefits from the same channel-consistency lock as fixed modes.
    const clean = await applyEmojiPolicyToAll(rawTitles, [prompt])
    const titles = (title_prefix || title_suffix) ? clean.map(wrap) : clean
    res.json({ titles })
  } catch (e: any) {
    // Honour explicit statusCode (400 validation, 402 quota, …) and
    // surface the raw error via humanizeBackendError so users see
    // actionable detail (provider quota, missing key, etc.) rather
    // than a flat "Generation failed: <terse>".
    const status = typeof e?.statusCode === 'number' ? e.statusCode : 500
    res.status(status).json(humanizeBackendError(e, 'Generation failed'))
  }
})

// ── 3) Tags ───────────────────────────────────────────────────────────────

router.post('/projects/:slug/generate/metadata/tags', async (req, res) => {
  const { slug } = req.params
  const config = await pm.getConfig(slug)
  if (!config) return res.status(404).json({ detail: 'Config not found' })

  const { episode_id, title, description, model, count, metadata_formula_id } = req.body
  const credErr = checkProvider(model, config)
  if (credErr) return res.status(400).json({ detail: credErr })

  const storyContext = await readStoryContext(slug, episode_id, title, 1500)

  const format = await getEffectiveFormat(slug)
  // 2026-08-27 — the metadata formula seam, the same one the queued generator
  // uses, so a channel that picked a formula gets the same architecture from
  // every path into metadata. Null when nothing picked one, and every line
  // below then resolves exactly as it did before formulas existed.
  const formulaEntry = await resolveActiveMetadataFormula({ requestedId: metadata_formula_id, config })
  const formula = formulaEntry ? metadataFormulaPlan(formulaEntry) : null
  const broadKeywordsLine = format.metadata.broadKeywords.join(', ')
  const tagRules = format.metadata.tagsHookRules.map(r => `- ${r}`).join('\n')

  const prompt = `Generate ${count || formula?.tagCount || 15} YouTube tags ${formula?.tagGuidance || format.metadata.tagsContext}.

Episode: ${episode_id} — ${title}
${description ? `\nDescription excerpt:\n${truncateChars(description, 500)}\n` : ''}
Story context:
${storyContext}

Requirements:
- Broad keyword pool to draw from: ${broadKeywordsLine}.
${tagRules}
- One per line, no numbering, no commentary.

Output exactly ${count || 15} tags, one per line.${await noEmojiDirective()}`

  try {
    const raw = await callAiWithRetry(model, '', prompt, aiCreds(config), false, { slug })
    await trackGeneration(slug, 'description')
    const tags = await applyEmojiPolicyToAll(
      raw
        .split('\n')
        .map(l => l.trim().replace(/^[\-\d\.\)]+\s*/, '').replace(/^#/, '').replace(/^["']|["']$/g, '').trim())
        .filter(Boolean)
        .slice(0, count || 15),
      [prompt],
    )
    res.json({ tags })
  } catch (e: any) {
    // Honour explicit statusCode (400 validation, 402 quota, …) and
    // surface the raw error via humanizeBackendError so users see
    // actionable detail (provider quota, missing key, etc.) rather
    // than a flat "Generation failed: <terse>".
    const status = typeof e?.statusCode === 'number' ? e.statusCode : 500
    res.status(status).json(humanizeBackendError(e, 'Generation failed'))
  }
})

// ── 4) Combined "Generate All" ────────────────────────────────────────────

router.post('/projects/:slug/generate/metadata/all', async (req, res) => {
  const { slug } = req.params
  const config = await pm.getConfig(slug)
  if (!config) return res.status(404).json({ detail: 'Config not found' })

  const {
    episode_id, title, model, sections, max_chars,
    title_count, title_max_length, title_platform_preset,
    title_mode, title_prefix, title_suffix, manual_title,
    tag_count, metadata_formula_id,
  } = req.body
  // Channel prefix/suffix wrapper — v1.0.90+. Applies to fixed AND
  // paraphrase modes so the channel boilerplate ('Morning Prayer: ',
  // ' | Daily Prayer') stays consistent across every generation path.
  const wrapAllTitle = (s: string): string =>
    `${title_prefix ? String(title_prefix) : ''}${s}${title_suffix ? String(title_suffix) : ''}`
  const credErr = checkProvider(model, config)
  if (credErr) return res.status(400).json({ detail: credErr })

  // Validate fixed-title modes up-front so we don't half-do the batch
  // (description + tags) and then 400 on a missing manual title.
  if ((title_mode === 'use_idea_title' || title_mode === 'manual')) {
    const base = title_mode === 'manual'
      ? String(manual_title || '').trim()
      : String(title || '').trim()
    if (!base) {
      return res.status(400).json({ detail: title_mode === 'manual' ? 'manual_title is required' : 'idea title is empty' })
    }
  }

  const storyContext = await readStoryContext(slug, episode_id, title)

  try {
    // Resolved once — used by description hashtags, the LLM title path,
    // and the tags prompt below. Cheap (project.json read + format-
    // defaults merge).
    const format = await getEffectiveFormat(slug)
    // 2026-08-27 — the metadata formula seam, the same one the queued generator
    // uses, so a channel that picked a formula gets the same architecture from
    // every path into metadata. Null when nothing picked one, and every line
    // below then resolves exactly as it did before formulas existed.
    const formulaEntry = await resolveActiveMetadataFormula({ requestedId: metadata_formula_id, config })
    const formula = formulaEntry ? metadataFormulaPlan(formulaEntry) : null
    // An explicit section list from the page still wins; the formula supplies
    // the architecture when the caller has none of its own.
    const effectiveSections = (Array.isArray(sections) && sections.length) ? sections : (formula?.sections ?? [])
    const promptFormat = formula ? withMetadataFormulaShape(format, formula, formulaEntry!.architecture) : format

    // Description (hashtags section uses format.youtubeDescriptionStructure
    // when no explicit defaults are set on the section config).
    // v1.0.102+ — char limit format-driven; same logic as the per-route
    // description endpoint above.
    const effectiveMaxChars = max_chars || formula?.descriptionMaxChars || format?.metadata?.defaultMaxChars || 5000
    // v1.0.108+ — metadata-scope recency on the /metadata/all batch route.
    const descPrompt = await prependAvoidanceToPrompt(
      slug,
      'metadata',
      buildDescriptionPrompt(episode_id, title, storyContext, effectiveSections, effectiveMaxChars, promptFormat),
    ) + await noEmojiDirective()
    const descRaw = await callAiWithRetry(model, '', descPrompt, aiCreds(config), false, {
      slug, outputBudget: 'standard',
    })
    const description = stripInternalSectionLabels(await applyEmojiPolicy(descRaw.trim(), [descPrompt]))
    await recordUsageForScope(slug, episode_id, 'metadata', descRaw).catch(() => null)

    // Titles — fixed modes return a single title without an LLM call.
    let titles: string[]
    if (title_mode === 'use_idea_title' || title_mode === 'manual') {
      const base = title_mode === 'manual'
        ? String(manual_title || '').trim()
        : String(title || '').trim()
      titles = [wrapAllTitle(base)]
    } else {
      const platformNote = title_platform_preset && title_platform_preset !== 'custom'
        ? `Optimized for ${title_platform_preset} (max ${title_max_length} characters).`
        : `Maximum ${title_max_length} characters per title.`
      // Same "what worked" inspiration injection as the batch metadata
      // generator. Best-effort — empty string when analytics is
      // unavailable.
      let topBlock = ''
      try {
        const { getTopPerformersForSlug } = await import('../lib/youtube-analytics.js')
        const { formatTopPerformersBlock } = await import('../lib/top-performers.js')
        const top = await getTopPerformersForSlug(slug, 5)
        topBlock = formatTopPerformersBlock(top)
      } catch { /* analytics is best-effort */ }
      const titlePrompt = `Generate ${title_count || formula?.titleCount || 5} SEO-optimized video title options ${format.metadata.purposeNote}.
Episode: ${episode_id} — ${title}
Story context:
${truncateChars(storyContext, 1500)}
${topBlock}
Requirements:
- ${platformNote}
- Tone: ${formula?.titleGuidance || format.metadata.titleStyleHint}.
- One per line. No numbering, quotes, or commentary.${await noEmojiDirective()}`
      const titlePromptWithAvoidance = await prependAvoidanceToPrompt(slug, 'titles', titlePrompt)
      const titleRaw = await callAiWithRetry(model, '', titlePromptWithAvoidance, aiCreds(config), false, { slug })
      const rawTitles = titleRaw.split('\n').map(l => l.trim().replace(/^[\-\d\.\)]+\s*/, '').replace(/^["']|["']$/g, '').trim()).filter(Boolean).slice(0, title_count || formula?.titleCount || 5)
      const cleanTitles = await applyEmojiPolicyToAll(rawTitles, [titlePromptWithAvoidance])
      titles = (title_prefix || title_suffix) ? cleanTitles.map(wrapAllTitle) : cleanTitles
      await recordUsageForScope(slug, episode_id, 'titles', titleRaw).catch(() => null)
    }

    // Tags
    const tagPrompt = `Generate ${tag_count || formula?.tagCount || 15} YouTube tags ${formula?.tagGuidance || format.metadata.tagsContext}.
Episode: ${episode_id} — ${title}
Description excerpt:
${truncateChars(description, 500)}

Requirements:
- 1-4 words per tag, no "#" prefix.
- Broad keywords to draw from: ${format.metadata.broadKeywords.join(', ')}.
- One per line, no numbering or commentary.${await noEmojiDirective()}`
    const tagRaw = await callAiWithRetry(model, '', tagPrompt, aiCreds(config), false, { slug })
    const tags = await applyEmojiPolicyToAll(
      tagRaw.split('\n').map(l => l.trim().replace(/^[\-\d\.\)]+\s*/, '').replace(/^#/, '').replace(/^["']|["']$/g, '').trim()).filter(Boolean).slice(0, tag_count || formula?.tagCount || 15),
      [tagPrompt],
    )

    await trackGeneration(slug, 'description')
    res.json({ titles, description, tags })
  } catch (e: any) {
    // Honour explicit statusCode (400 validation, 402 quota, …) and
    // surface the raw error via humanizeBackendError so users see
    // actionable detail (provider quota, missing key, etc.) rather
    // than a flat "Generation failed: <terse>".
    const status = typeof e?.statusCode === 'number' ? e.statusCode : 500
    res.status(status).json(humanizeBackendError(e, 'Generation failed'))
  }
})

// ── 4b) Queued "Generate All" — same work as /metadata/all but goes through
//        the job queue so users can navigate away mid-run and come back to
//        find it done. Mirrors the script/audio/video page pattern:
//          POST  → 201 { job_id, ... }
//          poll  → /jobs/:id until status === 'done'
//          GET   /episodes/:id/metadata → load latest version from disk
//
// The synchronous /metadata/all stays for back-compat (the pipeline batch
// runner uses it via the executor directly; per-section regenerate buttons
// also still hit their narrower endpoints). New page wiring should prefer
// this queue endpoint so the EpisodeSelector confirm-on-switch dialog
// fires uniformly.

router.post('/projects/:slug/generate/metadata', async (req, res) => {
  const { slug } = req.params
  const config = await pm.getConfig(slug)
  if (!config) return res.status(404).json({ detail: 'Config not found' })

  const { episode_id, title, model } = req.body
  if (!episode_id || typeof episode_id !== 'string') {
    return res.status(400).json({ detail: 'episode_id is required' })
  }
  if (!title || typeof title !== 'string') {
    return res.status(400).json({ detail: 'title is required' })
  }
  if (!model || typeof model !== 'string') {
    return res.status(400).json({ detail: 'model is required' })
  }
  const credErr = checkProvider(model, config)
  if (credErr) return res.status(400).json({ detail: credErr })

  const readiness = await inspectYouTubeFinalizationStatus(slug, episode_id)
  if (!readiness.audio_assembly_ready) {
    return res.status(409).json({
      code: 'YOUTUBE_FINALIZER_AUDIO_REQUIRED',
      detail: 'Run Audio Assembly before YouTube Finalizer so chapter timestamps use the complete measured narration timeline.',
      warnings: readiness.warnings,
    })
  }

  if (jq.isDuplicate(slug, episode_id, 'metadata')) {
    return res.status(409).json({ detail: `YouTube finalization already queued/running for ${episode_id}` })
  }

  const job = await jq.enqueue({
    project_slug: slug,
    type: 'metadata',
    episode_id,
    title: `YouTube Finalizer — ${episode_id}`,
    params: req.body,
  })
  res.status(201).json(job)
})

// ── 5) Save / Load metadata ───────────────────────────────────────────────

async function getMetadataDir(slug: string, episode_id: string, title: string): Promise<string> {
  const paths = await resolveEpisodePaths(slug, episode_id, title || '')
  let episodeDir = paths.episode_dir.replace(/\/$/, '')
  const seasonDir = pathMod.dirname(episodeDir)
  const actualDir = await resolveEpisodeDir(seasonDir, episode_id)
  if (actualDir) episodeDir = actualDir
  const names = await resolveSubfolderNames(slug, episode_id)
  return await resolveSubfolder(episodeDir, names.metadata)
}

function nextVersion(files: string[], code: string): number {
  let max = 0
  const re = new RegExp(`^${code}_Metadata(?:_v(\\d+))?\\.json$`)
  for (const f of files) {
    const m = f.match(re)
    if (m) {
      const v = m[1] ? parseInt(m[1], 10) : 1
      if (v > max) max = v
    }
  }
  return max + 1
}

function metadataFilenames(code: string, version: number): { json: string; txt: string } {
  const suffix = version <= 1 ? '' : `_v${version}`
  return {
    json: `${code}_Metadata${suffix}.json`,
    txt: `${code}_Metadata${suffix}.txt`,
  }
}

router.post('/projects/:slug/generate/metadata/save', async (req, res) => {
  const { slug } = req.params
  const { episode_id, title, metadata_title, title_options, description, tags, save_mode, version } = req.body
  try {
    const dir = await getMetadataDir(slug, episode_id, title)
    const files = await fs.readdir(dir).catch(() => [])

    let writeVersion: number
    if (save_mode === 'new') {
      writeVersion = nextVersion(files, episode_id)
    } else {
      writeVersion = version || 1
    }

    // Preserve AI-generated title alternatives across saves so a user who
    // overwrites v1 from the metadata page doesn't accidentally wipe the
    // 4 alternates the pipeline saved alongside the picked title. The page
    // round-trips them in the body (loaded → kept → saved); fall back to a
    // single-entry list if the client didn't send them.
    const cleanTitleOptions: string[] = Array.isArray(title_options)
      ? title_options.filter((t: unknown): t is string => typeof t === 'string' && t.trim() !== '')
      : (metadata_title ? [String(metadata_title)] : [])

    // Manual edits keep the finalizer audit that was recorded by the queued
    // generator. The managed chapter/source text is already inside
    // `description`; preserving this sidecar prevents autosave from erasing
    // the warning/readiness information.
    const { json } = metadataFilenames(episode_id, writeVersion)
    const priorPath = pathMod.join(dir, json)
    let priorFinalization: unknown
    try {
      priorFinalization = JSON.parse(await fs.readFile(priorPath, 'utf-8'))?.youtube_finalization
    } catch { /* first save / new version */ }

    const meta = {
      title: metadata_title || '',
      title_options: cleanTitleOptions,
      description: description || '',
      tags: Array.isArray(tags) ? tags : [],
      ...(priorFinalization ? { youtube_finalization: priorFinalization } : {}),
      savedAt: new Date().toISOString(),
      version: writeVersion,
    }

    const { txt } = metadataFilenames(episode_id, writeVersion)
    const jsonPath = pathMod.join(dir, json)
    // Lock on the JSON path so concurrent Save clicks (e.g. two browser tabs)
    // can't interleave and leave the .txt sidecar out of sync with the .json.
    await withLock(jsonPath, async () => {
      await writeJsonAtomic(jsonPath, meta)
      await fs.writeFile(pathMod.join(dir, txt), formatMetadataTxt(meta))
    })

    res.json({ ok: true, version: writeVersion, json, txt })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to save metadata'))
  }
})

/**
 * Derive YouTube-format chapter timestamps from the episode's chapter
 * audio durations. Returns a string ready to drop into the metadata
 * description (the "0:00 Intro / 4:32 Chapter 1 / …" block YouTube
 * auto-renders as clickable chapter markers).
 *
 * Kept for older clients. It now uses the same measured Audio Assembly
 * timeline, approved outline titles, lead-in offset, and warning contract as
 * the automatic YouTube Finalizer.
 */
router.get('/projects/:slug/episodes/:episodeId/youtube-finalization-status', async (req, res) => {
  try {
    const status = await inspectYouTubeFinalizationStatus(req.params.slug, req.params.episodeId)
    res.json(status)
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to inspect YouTube finalization readiness'))
  }
})

router.get('/projects/:slug/episodes/:episodeId/chapter-timestamps', async (req, res) => {
  try {
    const { slug, episodeId } = req.params
    // Back-compatible endpoint for old clients. It now shares the exact same
    // measured timing + approved-title logic as the automatic finalizer.
    const result = await finalizeYouTubeDescription({
      slug,
      episodeId,
      description: '',
      includeSources: false,
    })
    const chapterBlock = result.description.match(/CHAPTERS\n([\s\S]*?)\n<!-- youtube:chapters:end -->/)?.[1] || ''
    res.json({
      formatted: chapterBlock,
      chapters: result.chapters,
      warnings: result.warnings,
      reason: result.chapters.length < 3 ? 'fewer-than-3-chapters' : undefined,
    })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to derive chapter timestamps'))
  }
})

router.get('/projects/:slug/episodes/:episodeId/metadata', async (req, res) => {
  const { slug, episodeId } = req.params
  const titleQuery = (req.query.title as string) || ''
  try {
    const dir = await getMetadataDir(slug, episodeId, titleQuery)
    if (!existsSync(dir)) return res.json({ versions: [] })

    const files = await fs.readdir(dir)
    const re = new RegExp(`^${episodeId}_Metadata(?:_v(\\d+))?\\.json$`)
    const versions: any[] = []

    // Pre-fetch each matching file's contents in parallel — disk I/O is
    // the bottleneck here and reads are independent. Parsing stays
    // sequential (cheap, and per-file errors are still skipped).
    const jsonMatches = files.map(f => ({ f, m: f.match(re) })).filter(x => x.m) as Array<{ f: string; m: RegExpMatchArray }>
    const jsonContents = await Promise.all(
      jsonMatches.map(({ f }) => fs.readFile(pathMod.join(dir, f), 'utf-8').catch(() => null)),
    )
    for (let i = 0; i < jsonMatches.length; i++) {
      const { m } = jsonMatches[i]
      const text = jsonContents[i]
      if (!text) continue
      const v = m[1] ? parseInt(m[1], 10) : 1
      try {
        const data = JSON.parse(text)
        versions.push({
          version: v,
          title: data.title || '',
          // Pipeline runs save all AI-generated alternatives so the user can
          // later pick a different one without re-generating. May be absent
          // on metadata files saved by older builds — fall back to a single
          // entry derived from the active title.
          title_options: Array.isArray(data.title_options) && data.title_options.length
            ? data.title_options
            : (data.title ? [data.title] : []),
          // v1.4.75 — a package saved before the prompt fix can carry an
          // internal section name the model printed as a heading (`HOOK:`,
          // `SUBSCRIBE / LIKE CTA`). Cleaned on the way to the Metadata page
          // so what he reads, copies and re-saves is what a viewer would see.
          // The file on disk is left alone until he saves.
          description: stripInternalSectionLabels(data.description || ''),
          tags: Array.isArray(data.tags) ? data.tags : [],
          youtube_finalization: data.youtube_finalization || null,
          savedAt: data.savedAt || null,
        })
      } catch {}
    }

    // Fallback: if no .json, parse .txt files
    if (!versions.length) {
      const txtRe = new RegExp(`^${episodeId}_Metadata(?:_v(\\d+))?\\.txt$`)
      const txtMatches = files.map(f => ({ f, m: f.match(txtRe) })).filter(x => x.m) as Array<{ f: string; m: RegExpMatchArray }>
      const txtContents = await Promise.all(
        txtMatches.map(({ f }) => fs.readFile(pathMod.join(dir, f), 'utf-8').catch(() => null)),
      )
      for (let i = 0; i < txtMatches.length; i++) {
        const { m } = txtMatches[i]
        const text = txtContents[i]
        if (!text) continue
        const v = m[1] ? parseInt(m[1], 10) : 1
        try {
          const parsed = parseMetadataTxt(text)
          versions.push({
            version: v,
            ...parsed,
            description: stripInternalSectionLabels(parsed.description || ''),
            savedAt: null,
          })
        } catch {}
      }
    }

    versions.sort((a, b) => a.version - b.version)
    res.json({ versions })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to list metadata versions'))
  }
})

// `POST /generate/image-prompts-only` is retired. Thumbnail Prompts uses the
// thumbnail-only `/generate/image-prompts` contract; Scene Plan owns all
// scene visual prompts.
