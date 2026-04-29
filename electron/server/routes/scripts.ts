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
      modified_at: string | null
      audio_stale: boolean
    }> = []
    for (const num of numbers) {
      const filePath = chapterFilePath(paths.script_dir, episodeId, num)
      let title = `Chapter ${String(num).padStart(2, '0')}`
      let wordCount = 0
      let modifiedAt: string | null = null
      try {
        const stat = await fs.stat(filePath)
        modifiedAt = stat.mtime.toISOString()
        const sections = await parseNarrationDocx(filePath)
        const sec = sections[0]
        if (sec) {
          // Section label is "Chapter NN"; pull the FULL title (including
          // the descriptive part) from the docx if the parser preserved it.
          // `parseNarrationDocx` strips the title to label-only, so we
          // re-derive from the first heading line via mammoth raw extract.
          // Cheap: we already have the section.text for word count.
          wordCount = (sec.text || '').split(/\s+/).filter(Boolean).length
          // Try to recover the original chapter title from the docx HTML.
          try {
            const mammoth = await import('mammoth')
            const html = (await mammoth.default.convertToHtml({ path: filePath })).value
            const headingMatch = html.match(/<h2[^>]*>([^<]+)<\/h2>/i)
            if (headingMatch) {
              const m = headingMatch[1].match(/^\s*Chapter\s+\d+\s*[:\-–—]\s*(.+)$/i)
              if (m) title = m[1].trim()
              else title = headingMatch[1].trim()
            }
          } catch { /* fall back to default */ }
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
        modified_at: modifiedAt,
        audio_stale: audioStale,
      })
    }

    res.json({ chapters })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Could not list chapters'))
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
  const prompt = buildDescriptionPrompt(episode_id, title, storyContext, sections || [], max_chars || 5000)

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
    // Description
    const descPrompt = buildDescriptionPrompt(episode_id, title, storyContext, sections || [], max_chars || 5000)
    const descRaw = await callAi(model, '', descPrompt, aiCreds(config), false, { slug })
    const description = descRaw.trim()

    // Resolved once — used by both the LLM title path AND the tags
    // prompt below. Cheap (project.json read + format-defaults merge).
    const format = await getEffectiveFormat(slug)

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
      const titlePrompt = `Generate ${title_count || 5} SEO-optimized video title options ${format.metadata.purposeNote}.
Episode: ${episode_id} — ${title}
Story context:
${storyContext.slice(0, 1500)}

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

    const meta = {
      title: metadata_title || '',
      title_options: cleanTitleOptions,
      description: description || '',
      tags: Array.isArray(tags) ? tags : [],
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

router.get('/projects/:slug/episodes/:episodeId/metadata', async (req, res) => {
  const { slug, episodeId } = req.params
  const titleQuery = (req.query.title as string) || ''
  try {
    const dir = await getMetadataDir(slug, episodeId, titleQuery)
    if (!existsSync(dir)) return res.json({ versions: [] })

    const files = await fs.readdir(dir)
    const re = new RegExp(`^${episodeId}_Metadata(?:_v(\\d+))?\\.json$`)
    const versions: any[] = []

    for (const f of files) {
      const m = f.match(re)
      if (!m) continue
      const v = m[1] ? parseInt(m[1], 10) : 1
      try {
        const data = JSON.parse(await fs.readFile(pathMod.join(dir, f), 'utf-8'))
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
          savedAt: data.savedAt || null,
        })
      } catch {}
    }

    // Fallback: if no .json, parse .txt files
    if (!versions.length) {
      const txtRe = new RegExp(`^${episodeId}_Metadata(?:_v(\\d+))?\\.txt$`)
      for (const f of files) {
        const m = f.match(txtRe)
        if (!m) continue
        const v = m[1] ? parseInt(m[1], 10) : 1
        try {
          const parsed = parseMetadataTxt(await fs.readFile(pathMod.join(dir, f), 'utf-8'))
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

