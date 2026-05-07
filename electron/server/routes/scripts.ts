import { Router } from 'express'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import pathMod from 'path'
import * as pm from '../services/project-manager.js'
import * as jq from '../services/job-queue.js'
import * as cm from '../services/character-manager.js'
import { castImagePromptBlock } from '../lib/character-prompt-blocks.js'
import { callAi } from '../lib/ai-client.js'
import { SUPPORTED_MODELS } from '../models/types.js'
import { resolveEpisodePaths } from '../services/utils.js'
import { buildImagePromptsDocx } from '../lib/docx-builder.js'
import { resolveSubfolder, resolveEpisodeDir } from '../lib/folder-resolver.js'
import { resolveSubfolderNames } from '../services/utils.js'
import { trackGeneration } from '../services/session-tracker.js'
import { formatMetadataTxt, parseMetadataTxt } from '../services/folder-migration.js'
import { validateBody } from '../lib/validate.js'
import { GenerateScriptOnlySchema, GenerateIntroductionOnlySchema, GenerateChapterOnlySchema } from '../schemas/index.js'
import { buildDescriptionPrompt } from '../lib/metadata-prompt.js'
import { getEffectiveFormat } from '../services/format-loader.js'
import { resolveTextStyle, resolveFontStyle } from '../models/thumbnail-styles.js'
import { writeJsonAtomic, withLock } from '../lib/atomic-store.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'

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
  if (!config?.anthropic_api_key && !config?.openai_api_key) {
    return res.status(400).json({ detail: 'No AI API key configured. Add one in Settings.' })
  }

  if (jq.isDuplicate(slug, req.body.episode_id, 'script-only')) {
    return res.status(409).json({ detail: `Script generation already queued/running for ${req.body.episode_id}` })
  }

  const job = jq.enqueue({
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
  if (!config?.anthropic_api_key && !config?.openai_api_key) {
    return res.status(400).json({ detail: 'No AI API key configured. Add one in Settings.' })
  }

  if (jq.isDuplicate(slug, req.body.episode_id, 'outline_only')) {
    return res.status(409).json({ detail: `Outline build already queued/running for ${req.body.episode_id}` })
  }

  const job = jq.enqueue({
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
  if (!config?.anthropic_api_key && !config?.openai_api_key) {
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

  // Validate the optional `chapters` filter when present. Accept an array
  // of integers in 1..total_chapters, deduped. Reject non-arrays, NaN,
  // out-of-range, and non-integer entries — the executor would silently
  // skip these which is confusing UX (user gets a 201 + no work done).
  // Empty array is allowed (means "expand all pending"); we normalise it
  // to `undefined` so the executor takes the no-filter path.
  if (req.body.chapters !== undefined) {
    if (!Array.isArray(req.body.chapters)) {
      return res.status(400).json({ detail: '`chapters` must be an array of chapter numbers.' })
    }
    if (sidecar) {
      const total = sidecar.total_chapters
      const seen = new Set<number>()
      const cleaned: number[] = []
      for (const raw of req.body.chapters) {
        const n = Number(raw)
        if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > total) {
          return res.status(400).json({
            detail: `Invalid chapter number in \`chapters\`: ${raw} (must be an integer 1..${total}).`,
          })
        }
        if (seen.has(n)) continue
        seen.add(n); cleaned.push(n)
      }
      // Replace the request body so the executor sees the cleaned set.
      // Empty after de-dup → drop the field entirely (= expand all pending).
      if (cleaned.length === 0) delete req.body.chapters
      else req.body.chapters = cleaned
    }
  }

  if (jq.isDuplicate(slug, episode_id, 'expand_chapters')) {
    return res.status(409).json({ detail: `Chapter expansion already queued/running for ${episode_id}` })
  }

  const job = jq.enqueue({
    project_slug: slug,
    type: 'expand_chapters',
    episode_id,
    title: title || '',
    params: req.body,
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
    // readSidecar handles the v1 → v2 auto-upgrade in one place — this
    // route used to re-implement the migration inline (an `outline_approved_at
    // ?? outline_completed_at` fallback) which would silently drift if
    // the schema ever evolves to v3. Now both readers go through the
    // same helper.
    const { readSidecar } = await import('../lib/chunked-narration.js')
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
      schema_version: 2,
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
  if (!config?.anthropic_api_key && !config?.openai_api_key) {
    return res.status(400).json({ detail: 'No AI API key configured. Add one in Settings.' })
  }

  // Dedupe per (episode, chapter) — two clicks on the regenerate button
  // shouldn't enqueue the same chapter twice. The base isDuplicate check
  // is per (episode, type) which would block ALL chapter regens for the
  // episode; we approximate per-chapter dedupe by inspecting params on
  // the active queue. For MVP we keep the broader dedupe (one chapter
  // regen per episode at a time) — simpler and matches the user's
  // expected one-click flow.
  if (jq.isDuplicate(slug, req.body.episode_id, 'chapter-only')) {
    return res.status(409).json({ detail: `A chapter regen is already queued for ${req.body.episode_id}` })
  }

  const job = jq.enqueue({
    project_slug: slug,
    type: 'chapter-only',
    episode_id: req.body.episode_id,
    title: req.body.title,
    params: req.body,
  })
  res.status(201).json(job)
})

// Generate introduction only (requires script to exist)
router.post('/projects/:slug/generate/introduction-only', validateBody(GenerateIntroductionOnlySchema), async (req, res) => {
  const { slug } = req.params
  const project = await pm.getProject(slug)
  if (!project) return res.status(404).json({ detail: 'Project not found' })

  const config = await pm.getConfig(slug)
  if (!config?.anthropic_api_key && !config?.openai_api_key) {
    return res.status(400).json({ detail: 'No AI API key configured. Add one in Settings.' })
  }

  if (jq.isDuplicate(slug, req.body.episode_id, 'introduction-only')) {
    return res.status(409).json({ detail: `Introduction generation already queued/running for ${req.body.episode_id}` })
  }

  const job = jq.enqueue({
    project_slug: slug,
    type: 'introduction-only',
    episode_id: req.body.episode_id,
    title: req.body.title,
    params: req.body,
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

    if (existsSync(paths.narration_docx)) {
      // Single source of truth: introduction (when present) lives INSIDE
      // the narration docx as an "Introduction" section, not in a sibling
      // file. We split here so each preview panel gets only its slice
      // while the underlying file stays unified for the audio /
      // subtitles / video pipelines.
      const { parseNarrationDocx } = await import('../lib/docx-parser.js')
      const sections = await parseNarrationDocx(paths.narration_docx)
      const stat = await fs.stat(paths.narration_docx)

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

    const { ensureChapterFilesMigrated, chapterFilePath } =
      await import('../lib/narration-assembly.js')
    await ensureChapterFilesMigrated(paths.script_dir, episodeId, titleQuery)

    let entries: string[] = []
    try { entries = await fs.readdir(paths.script_dir) } catch { /* missing dir */ }

    const chapterRe = new RegExp(`^${episodeId}_Chapter_(\\d+)\\.docx$`)
    const numbers = entries
      .map(n => n.match(chapterRe))
      .filter((m): m is RegExpMatchArray => !!m)
      .map(m => parseInt(m[1], 10))
      .sort((a, b) => a - b)

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
      const filePath = chapterFilePath(paths.script_dir, episodeId, num)
      let title = `Chapter ${String(num).padStart(2, '0')}`
      let wordCount = 0
      let characterCount = 0
      let modifiedAt: string | null = null
      try {
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
    const { chapterFilePath } = await import('../lib/narration-assembly.js')
    const filePath = chapterFilePath(paths.script_dir, episodeId, n)
    if (!existsSync(filePath)) {
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

// ── Generate image prompts with style/ratio controls (returns prompts for review) ──
//
// Synchronous LLM call in the request handler. Per M5 (system audit):
// when this needs to be moved into the queue (so it appears in /jobs and
// becomes retryable), refactor through `enqueueOrRun(..., { sync: true })`
// from services/job-queue.ts — the seam is already there.

router.post('/projects/:slug/generate/image-prompts', async (req, res) => {
  const { slug } = req.params
  const config = await pm.getConfig(slug)
  if (!config) return res.status(404).json({ detail: 'Config not found' })

  const {
    episode_id, model, style_tag, aspect_ratio, title,
    scenes_per_chapter, total_scenes, thumb_count,
    thumb_text_style, thumb_text_style_custom,
    thumb_text_position,
    thumb_font_style, thumb_font_style_custom,
    character_ids,
  } = req.body

  const provider = SUPPORTED_MODELS[model]
  if (provider === 'anthropic' && !config.anthropic_api_key) return res.status(400).json({ detail: 'No Anthropic key' })
  if (provider === 'openai' && !config.openai_api_key) return res.status(400).json({ detail: 'No OpenAI key' })
  if (provider === 'kie' && !config.kie_api_key) return res.status(400).json({ detail: 'No kie.ai key' })

  // Read narration for story context
  const standards = await pm.getStandards(slug) || ''
  let storyContext = ''
  try {
    const paths = await resolveEpisodePaths(slug, episode_id, title || '')
    const narrationPath = paths.narration_docx
    const mammoth = await import('mammoth')
    const result = await mammoth.default.extractRawText({ path: narrationPath })
    storyContext = result.value.slice(0, 3000)
  } catch {
    storyContext = `Episode: ${episode_id}, Title: ${title || 'Unknown'}`
  }

  // Resolve cast → character-reference block. Empty array (or missing
  // field on legacy requests) → empty string injected → today's behaviour
  // unchanged. When non-empty, the LLM is told each character's name +
  // description verbatim, so the requirement at REQUIREMENTS line 6
  // ("inline character descriptions") actually has data backing it.
  const characters = Array.isArray(character_ids) && character_ids.length
    ? await cm.resolveCharacters(slug, character_ids)
    : []
  const castBlock = castImagePromptBlock(characters)

  const mode = req.body.mode || 'all' // 'all', 'scenes', 'thumbnails'
  let sceneCount = 0
  let thumbs = 0

  if (mode === 'thumbnails') {
    sceneCount = 0
    thumbs = thumb_count || 5
  } else if (mode === 'scenes') {
    sceneCount = total_scenes || (scenes_per_chapter || 3) * 10
    thumbs = 0
  } else {
    sceneCount = total_scenes || (scenes_per_chapter || 3) * 10
    thumbs = thumb_count || 5
  }

  // Build thumbnail text instruction via the shared resolver so frontend
  // + sync route + batch generator all see the same expanded catalog.
  const fontPhrase = resolveFontStyle(thumb_font_style, thumb_font_style_custom)
  const textPhrase = resolveTextStyle(thumb_text_style, thumb_text_style_custom)
  const thumbTextInstruction = `The episode title "${title}" displayed in ${fontPhrase}, ${textPhrase}, positioned at the ${thumb_text_position || 'center'} of the frame, large and legible.`

  const ratioDescriptions: Record<string, string> = {
    '16:9': 'wide 16:9 landscape format with cinematic framing',
    '1:1': 'square 1:1 format with centered composition',
    '9:16': 'tall 9:16 portrait format with vertical composition',
    '4:3': 'classic 4:3 format',
    '3:4': 'portrait 3:4 format',
    '21:9': 'ultrawide 21:9 cinematic format',
  }
  const ratioInstruction = ratioDescriptions[aspect_ratio] || 'wide landscape format'

  // Build requirements based on mode
  const requirements: string[] = []
  if (sceneCount > 0) requirements.push(`Generate exactly ${sceneCount} scene prompts.`)
  if (thumbs > 0) requirements.push(`Generate exactly ${thumbs} thumbnail prompts.`)
  requirements.push(`Every prompt must end with this style tag: "${style_tag}"`)
  requirements.push(`Every prompt must specify composition for ${ratioInstruction}.`)
  requirements.push(`Every prompt must include inline character descriptions.`)

  const prompt = `Generate image prompts for a story episode.

Episode: ${episode_id} — ${title}

Story context:
${storyContext}
${castBlock}
REQUIREMENTS:
${requirements.map((r, i) => `${i + 1}. ${r}`).join('\n')}
${sceneCount === 0 ? '\nDo NOT generate any scene prompts. Only generate thumbnail prompts.' : ''}
${thumbs === 0 ? '\nDo NOT generate any thumbnail prompts. Only generate scene prompts.' : ''}

FORMAT — return ONLY a JSON object:
{
  "scenes": [{"number": 1, "title": "Brief Title", "prompt": "Full prompt text..."}],
  "thumbnails": [{"number": 1, "title": "Brief Title", "prompt": "Full prompt text..."}]
}

THUMBNAIL RULE: Every thumbnail must include: '${thumbTextInstruction}'

No markdown, no commentary, just valid JSON.`

  try {
    const raw = await callAi(model, '', prompt, {
      anthropic_api_key: config.anthropic_api_key,
      openai_api_key: config.openai_api_key,
      kie_api_key: config.kie_api_key,
    }, false, { slug })

    // Parse JSON from response
    let text = raw.trim()
    if (text.startsWith('```')) {
      text = text.split('\n').filter(l => !l.trim().startsWith('```')).join('\n')
    }
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    const parsed = JSON.parse(text.slice(start, end + 1))

    await trackGeneration(slug, 'prompts')

    res.json({
      scenes: parsed.scenes || [],
      thumbnails: parsed.thumbnails || [],
      style_tag,
      aspect_ratio,
    })
  } catch (e: any) {
    // Honour explicit statusCode (400 validation, 402 quota, …) and
    // surface the raw error via humanizeBackendError so users see
    // actionable detail (provider quota, missing key, etc.) rather
    // than a flat "Generation failed: <terse>".
    const status = typeof e?.statusCode === 'number' ? e.statusCode : 500
    res.status(status).json(humanizeBackendError(e, 'Generation failed'))
  }
})

// ── Save reviewed prompts to .docx ──

router.post('/projects/:slug/generate/image-prompts/save', async (req, res) => {
  const { slug } = req.params
  const { episode_id, title, prompts } = req.body
  try {
    const paths = await resolveEpisodePaths(slug, episode_id, title || '')

    const pathMod = await import('path')
    const names = await resolveSubfolderNames(slug, episode_id)
    let episodeDir = paths.episode_dir.replace(/\/$/, '')

    // Resolve the actual episode dir on disk
    const seasonDir = pathMod.dirname(episodeDir)
    const actualDir = await resolveEpisodeDir(seasonDir, episode_id)
    if (actualDir) episodeDir = actualDir

    // Save scene prompts to Scene Prompts folder
    if ((prompts.scenes || []).length > 0) {
      const sceneDir = await resolveSubfolder(episodeDir, names.scene_prompts)
      let sceneText = `# Scene Prompts\n\n`
      for (const s of prompts.scenes) sceneText += `## Scene ${s.number}: ${s.title}\n\n${s.prompt}\n\n`
      await buildImagePromptsDocx(sceneText, episode_id, title, pathMod.join(sceneDir, `${episode_id}_Scene_Prompts.docx`))
    }

    // Save thumbnail prompts to Thumbnail Prompts folder
    if ((prompts.thumbnails || []).length > 0) {
      const thumbDir = await resolveSubfolder(episodeDir, names.thumb_prompts)
      let thumbText = `# Thumbnail Prompts\n\n`
      for (const t of prompts.thumbnails) thumbText += `## Thumbnail ${t.number}: ${t.title}\n\n${t.prompt}\n\n`
      await buildImagePromptsDocx(thumbText, episode_id, title, pathMod.join(thumbDir, `${episode_id}_Thumbnail_Prompts.docx`))
    }

    res.json({ ok: true, path: paths.scene_prompts_docx })
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
    const mammoth = await import('mammoth')
    const result = await mammoth.default.extractRawText({ path: paths.narration_docx })
    return result.value.slice(0, maxChars)
  } catch {
    return `Episode: ${episode_id}, Title: ${title}`
  }
}

function checkProvider(model: string, config: any): string | null {
  const provider = SUPPORTED_MODELS[model]
  if (provider === 'anthropic' && !config.anthropic_api_key) return 'No Anthropic key'
  if (provider === 'openai' && !config.openai_api_key) return 'No OpenAI key'
  if (provider === 'kie' && !config.kie_api_key) return 'No kie.ai key'
  return null
}

function aiCreds(config: any) {
  return {
    anthropic_api_key: config.anthropic_api_key,
    openai_api_key: config.openai_api_key,
    kie_api_key: config.kie_api_key,
  }
}

// `buildDescriptionPrompt` is imported above from lib/metadata-prompt.ts
// — that's the single source of truth for the section→prompt mapping.
// generators/metadata.ts also imports it.

// ── 1) Description ────────────────────────────────────────────────────────
// All four metadata generators below (description / seo-titles / tags / all)
// run their LLM calls synchronously in the request handler and return the
// generated content for in-page review before save. Per M5 (system audit):
// when these grow long enough to need observability, migrate to the queue
// via `enqueueOrRun(..., { sync: true })` — the seam is in services/job-queue.ts.

router.post('/projects/:slug/generate/metadata/description', async (req, res) => {
  const { slug } = req.params
  const config = await pm.getConfig(slug)
  if (!config) return res.status(404).json({ detail: 'Config not found' })

  const { episode_id, title, model, sections, max_chars } = req.body
  const credErr = checkProvider(model, config)
  if (credErr) return res.status(400).json({ detail: credErr })

  const storyContext = await readStoryContext(slug, episode_id, title)
  // Format passed through so the hashtags section can lean on
  // format.youtubeDescriptionStructure.defaultHashtags rather than
  // hardcoding #SleepStory examples.
  const format = await getEffectiveFormat(slug)
  const prompt = buildDescriptionPrompt(episode_id, title, storyContext, sections || [], max_chars || 5000, format)

  try {
    const raw = await callAi(model, '', prompt, aiCreds(config), false, { slug })
    await trackGeneration(slug, 'description')
    res.json({ description: raw.trim() })
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
    title_mode, title_suffix, manual_title,
  } = req.body
  const credErr = checkProvider(model, config)
  if (credErr) return res.status(400).json({ detail: credErr })

  // Fixed-title modes — no LLM call. Returns one title (count is ignored
  // because the user chose the wording explicitly; nothing to compare).
  if (title_mode === 'use_idea_title' || title_mode === 'manual') {
    const base = title_mode === 'manual'
      ? String(manual_title || '').trim()
      : String(title || '').trim()
    if (!base) {
      return res.status(400).json({ detail: title_mode === 'manual' ? 'manual_title is required' : 'idea title is empty' })
    }
    const finalTitle = base + (title_suffix ? String(title_suffix) : '')
    return res.json({ titles: [finalTitle] })
  }

  const storyContext = include_script_context !== false
    ? await readStoryContext(slug, episode_id, title, 1500)
    : ''

  const platformNote = platform_preset && platform_preset !== 'custom'
    ? `Optimized for ${platform_preset} (max ${max_length} characters).`
    : `Maximum ${max_length} characters per title.`

  const format = await getEffectiveFormat(slug)
  const hookRules = format.metadata.titleHookRules.map(r => `- ${r}`).join('\n')

  const prompt = `Generate ${count || 5} SEO-optimized YouTube/TikTok/Facebook video title options ${format.metadata.purposeNote}.

Episode code: ${episode_id}
Working title: ${title}
${storyContext ? `\nStory context:\n${storyContext}\n` : ''}

Requirements:
- ${platformNote}
- Tone: ${format.metadata.titleStyleHint}.
${hookRules}
- Each on its own line. No numbering, no quotes, no commentary.

Output exactly ${count || 5} title options, one per line.`

  try {
    const raw = await callAi(model, '', prompt, aiCreds(config), false, { slug })
    await trackGeneration(slug, 'description')
    const titles = raw
      .split('\n')
      .map(l => l.trim().replace(/^[\-\d\.\)]+\s*/, '').replace(/^["']|["']$/g, '').trim())
      .filter(Boolean)
      .slice(0, count || 5)
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

  const { episode_id, title, description, model, count } = req.body
  const credErr = checkProvider(model, config)
  if (credErr) return res.status(400).json({ detail: credErr })

  const storyContext = await readStoryContext(slug, episode_id, title, 1500)

  const format = await getEffectiveFormat(slug)
  const broadKeywordsLine = format.metadata.broadKeywords.join(', ')
  const tagRules = format.metadata.tagsHookRules.map(r => `- ${r}`).join('\n')

  const prompt = `Generate ${count || 15} YouTube tags ${format.metadata.tagsContext}.

Episode: ${episode_id} — ${title}
${description ? `\nDescription excerpt:\n${description.slice(0, 500)}\n` : ''}
Story context:
${storyContext}

Requirements:
- Broad keyword pool to draw from: ${broadKeywordsLine}.
${tagRules}
- One per line, no numbering, no commentary.

Output exactly ${count || 15} tags, one per line.`

  try {
    const raw = await callAi(model, '', prompt, aiCreds(config), false, { slug })
    await trackGeneration(slug, 'description')
    const tags = raw
      .split('\n')
      .map(l => l.trim().replace(/^[\-\d\.\)]+\s*/, '').replace(/^#/, '').replace(/^["']|["']$/g, '').trim())
      .filter(Boolean)
      .slice(0, count || 15)
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
    title_mode, title_suffix, manual_title,
    tag_count,
  } = req.body
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

    // Description (hashtags section uses format.youtubeDescriptionStructure
    // when no explicit defaults are set on the section config).
    const descPrompt = buildDescriptionPrompt(episode_id, title, storyContext, sections || [], max_chars || 5000, format)
    const descRaw = await callAi(model, '', descPrompt, aiCreds(config), false, { slug })
    const description = descRaw.trim()

    // Titles — fixed modes return a single title without an LLM call.
    let titles: string[]
    if (title_mode === 'use_idea_title' || title_mode === 'manual') {
      const base = title_mode === 'manual'
        ? String(manual_title || '').trim()
        : String(title || '').trim()
      titles = [base + (title_suffix ? String(title_suffix) : '')]
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
        const { formatTopPerformersBlock } = await import('../lib/brand-prompt.js')
        const top = await getTopPerformersForSlug(slug, 5)
        topBlock = formatTopPerformersBlock(top)
      } catch { /* analytics is best-effort */ }
      const titlePrompt = `Generate ${title_count || 5} SEO-optimized video title options ${format.metadata.purposeNote}.
Episode: ${episode_id} — ${title}
Story context:
${storyContext.slice(0, 1500)}
${topBlock}
Requirements:
- ${platformNote}
- Tone: ${format.metadata.titleStyleHint}.
- One per line. No numbering, quotes, or commentary.`
      const titleRaw = await callAi(model, '', titlePrompt, aiCreds(config), false, { slug })
      titles = titleRaw.split('\n').map(l => l.trim().replace(/^[\-\d\.\)]+\s*/, '').replace(/^["']|["']$/g, '').trim()).filter(Boolean).slice(0, title_count || 5)
    }

    // Tags
    const tagPrompt = `Generate ${tag_count || 15} YouTube tags ${format.metadata.tagsContext}.
Episode: ${episode_id} — ${title}
Description excerpt:
${description.slice(0, 500)}

Requirements:
- 1-4 words per tag, no "#" prefix.
- Broad keywords to draw from: ${format.metadata.broadKeywords.join(', ')}.
- One per line, no numbering or commentary.`
    const tagRaw = await callAi(model, '', tagPrompt, aiCreds(config), false, { slug })
    const tags = tagRaw.split('\n').map(l => l.trim().replace(/^[\-\d\.\)]+\s*/, '').replace(/^#/, '').replace(/^["']|["']$/g, '').trim()).filter(Boolean).slice(0, tag_count || 15)

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

    // Brand-aware post-processing on the user-edited fields, mirroring the
    // batch generator's behaviour: interpolate {channel_name}, then scan
    // for banned-word matches and persist them on the saved metadata so
    // the page can render a warning chip after Save without re-scanning
    // client-side.
    let resolvedTitle = metadata_title || ''
    let resolvedDescription = description || ''
    let resolvedTitleOptions = cleanTitleOptions
    let resolvedTags = Array.isArray(tags) ? tags : []
    let bandWarnings: string[] = []
    try {
      const { getEffectiveBrand } = await import('../services/brand-loader.js')
      const { interpolateBrandPlaceholders, findBannedWords } = await import('../lib/brand-prompt.js')
      const project = await pm.getProject(slug)
      const brand = await getEffectiveBrand(slug)
      const interp = (s: string) => interpolateBrandPlaceholders(s, brand, project)
      resolvedTitle = interp(resolvedTitle)
      resolvedDescription = interp(resolvedDescription)
      resolvedTitleOptions = resolvedTitleOptions.map(interp)
      resolvedTags = resolvedTags.map((t: any) => interp(typeof t === 'string' ? t : String(t ?? '')))
      const haystack = [resolvedTitleOptions.join('\n'), resolvedDescription, resolvedTags.join(' ')].join('\n')
      bandWarnings = findBannedWords(haystack, brand)
    } catch { /* brand layer must never break the save */ }

    const meta = {
      title: resolvedTitle,
      title_options: resolvedTitleOptions,
      description: resolvedDescription,
      tags: resolvedTags,
      brand_warnings: bandWarnings,
      savedAt: new Date().toISOString(),
      version: writeVersion,
    }

    const { json, txt } = metadataFilenames(episode_id, writeVersion)
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
 * v1 uses the audio file labels (e.g. "Chapter 01") for titles. Users
 * who want richer titles can edit the inserted block manually.
 */
router.get('/projects/:slug/episodes/:episodeId/chapter-timestamps', async (req, res) => {
  try {
    const { slug, episodeId } = req.params
    const { scanEpisodeAssets } = await import('../generators/video.js')
    const { chaptersFromDurations, formatChapterTimestamps } = await import('../lib/subtitle-builder.js')
    const assets = await scanEpisodeAssets(slug, episodeId)
    const items = assets.audio_sections
      .filter(s => typeof s.duration === 'number' && s.duration > 0)
      .map(s => ({ title: s.label, duration_sec: s.duration as number }))
    if (items.length < 3) {
      // YouTube's auto-detection requires 3+ chapters with the first at
      // 0:00. Below that threshold the block would render broken; tell
      // the caller and let it surface a friendly empty state.
      return res.json({ formatted: '', chapters: [], reason: 'fewer-than-3-chapters' })
    }
    const chapters = chaptersFromDurations(items, 0)
    const formatted = formatChapterTimestamps(chapters)
    res.json({
      formatted,
      chapters: chapters.map(c => ({ title: c.title, start_sec: c.start_sec })),
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
          description: data.description || '',
          tags: Array.isArray(data.tags) ? data.tags : [],
          // Brand banned-word matches at last save. Absent on older
          // metadata files saved before the brand layer landed.
          brand_warnings: Array.isArray(data.brand_warnings) ? data.brand_warnings : [],
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
          versions.push({ version: v, ...parsed, savedAt: null })
        } catch {}
      }
    }

    versions.sort((a, b) => a.version - b.version)
    res.json({ versions })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to list metadata versions'))
  }
})

// M4: `POST /generate/image-prompts-only` removed. Zero frontend callers
// (verified by grep across the frontend tree). The image-prompts page
// uses `/generate/image-prompts` with `mode: 'scenes' | 'thumbnails' | 'all'`
// for granular generation. Pipeline batch uses `image_prompts` step.

// ── Legacy narration normaliser (Part 3 of mark-done plan) ─────────────────
//
// Re-structures a pre-Story-Studio narration docx into the canonical
// per-chapter format. Idempotent — running it on already-canonical input
// returns { skipped: true } without touching the file.
//
// Body:
//   { source_path: string, model: string }
// Response:
//   { ok, skipped, chapters_written, introduction_written, backup_at, unified_narration_at }
router.post('/projects/:slug/episodes/:code/normalize-script', async (req, res) => {
  try {
    const { slug, code } = req.params
    const { source_path, model } = req.body || {}
    if (typeof source_path !== 'string' || !source_path) {
      return res.status(400).json({ detail: 'source_path required' })
    }
    if (typeof model !== 'string' || !model) {
      return res.status(400).json({ detail: 'model required' })
    }

    const config = await pm.getConfig(slug)
    if (!config?.anthropic_api_key && !config?.openai_api_key) {
      return res.status(400).json({ detail: 'Project missing API keys (anthropic or openai required)' })
    }
    const apiKeys = {
      anthropic_api_key: (config as any).anthropic_api_key || '',
      openai_api_key: (config as any).openai_api_key || '',
      kie_api_key: (config as any).kie_api_key || '',
    }

    const { normalizeNarrationDocx } = await import('../services/docx-normalizer.js')
    const { episodeStatusCache } = await import('../services/episode-status-cache.js')
    const result = await normalizeNarrationDocx(slug, code, source_path, { model, apiKeys })
    // Invalidate the episode-status cache — the script + introduction
    // booleans flip as a result of the new chapter files landing.
    if (!result.skipped) episodeStatusCache.invalidate(slug, code)
    res.json({ ok: true, ...result })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Narration normalisation failed'))
  }
})

