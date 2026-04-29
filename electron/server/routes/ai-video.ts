/**
 * AI Video routes — Veo (GenAIPro) today, kie.ai + fal.ai pluggable later.
 * Separate from routes/video.ts (legacy FFmpeg assembler, currently disabled).
 *
 *   POST /projects/:slug/generate/video-prompts       → LLM-generated clip prompts (review)
 *   POST /projects/:slug/generate/video-prompts/save  → save prompts to .docx
 *   POST /projects/:slug/generate/video               → enqueue video generation job
 */

import { Router } from 'express'
import path from 'path'
import * as pm from '../services/project-manager.js'
import * as jq from '../services/job-queue.js'
import { callAi } from '../lib/ai-client.js'
import { resolveEpisodePaths, resolveSubfolderNames } from '../services/utils.js'
import { buildImagePromptsDocx } from '../lib/docx-builder.js'
import { resolveSubfolder, resolveEpisodeDir } from '../lib/folder-resolver.js'
import { getVideoStatus } from '../services/asset-status.js'
import { BUILT_IN_VIDEO_PROMPTS } from '../models/video-prompts-builtin.js'
import { humanizeBackendError, respondWithError } from '../lib/humanize-backend-error.js'

export const router = Router()

// ── Built-in video-prompt catalog (pain-point: quick-start library) ──────
router.get('/projects/:slug/video-prompts/catalog', async (_req, res) => {
  res.json({ prompts: BUILT_IN_VIDEO_PROMPTS })
})

// ── Status endpoint (for the per-episode integrity pill) ─────────────────
router.get('/projects/:slug/episodes/:code/video-status', async (req, res) => {
  try {
    if (!await pm.getProject(req.params.slug)) return res.status(404).json({ detail: 'Project not found' })
    const s = await getVideoStatus(req.params.slug, req.params.code)
    res.json(s)
  } catch (e: any) {
    res.status(400).json(humanizeBackendError(e, 'Could not compute video status'))
  }
})

// ── Generate video prompts via LLM (review-friendly: returns JSON) ──

router.post('/projects/:slug/generate/video-prompts', async (req, res) => {
  const { slug } = req.params
  const config = await pm.getConfig(slug)
  if (!config) return res.status(404).json({ detail: 'Project not found' })

  const { episode_id, title, model, count, style_hint, aspect_ratio } = req.body
  if (!episode_id) return res.status(400).json({ detail: 'episode_id is required' })

  // Pull story context from the narration file if available
  let storyContext = ''
  try {
    const paths = await resolveEpisodePaths(slug, episode_id, title || '')
    const mammoth = await import('mammoth')
    const r = await mammoth.default.extractRawText({ path: paths.narration_docx })
    storyContext = r.value.slice(0, 3000)
  } catch {
    storyContext = `Episode: ${episode_id}, Title: ${title || 'Unknown'}`
  }

  const nClips = Math.max(1, Math.min(60, count || 20))
  const ratioText = aspect_ratio === 'portrait'
    ? '9:16 vertical (mobile)'
    : '16:9 horizontal (landscape)'

  const sys = 'You write concise AI-video prompts tuned for camera motion, subject action, pacing, and mood. Output strict JSON.'
  const userPrompt = `Generate ${nClips} short AI-video-clip prompts for a story episode.

Episode: ${episode_id} — ${title || ''}
Aspect ratio: ${ratioText}
${style_hint ? `Style hint: ${style_hint}` : ''}

Story context (first 3k chars of narration):
${storyContext}

RULES for each prompt:
- One scene, one clear subject, one clear camera movement (dolly, pan, static, slow push, etc.).
- 1-2 sentences max; describe motion, light, mood. NOT a still-image description.
- Avoid rapid cuts, violence, or text-on-screen unless explicitly asked.
- Optimize for 5-8 second clips.

RETURN ONLY THIS JSON (no markdown):
{
  "scenes": [
    { "number": 1, "title": "Brief title", "prompt": "Full video prompt text..." }
  ]
}`

  try {
    const raw = await callAi(model || 'gpt-4o', sys, userPrompt, {
      anthropic_api_key: config.anthropic_api_key,
      openai_api_key: config.openai_api_key,
      kie_api_key: config.kie_api_key,
    }, false, { slug })
    let text = raw.trim()
    if (text.startsWith('```')) text = text.split('\n').filter(l => !l.trim().startsWith('```')).join('\n')
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    const parsed = JSON.parse(text.slice(start, end + 1))
    res.json({ scenes: parsed.scenes || [] })
  } catch (e: any) {
    respondWithError(res, e, 'Video prompt generation failed')
  }
})

// ── Save reviewed video prompts to .docx ──

router.post('/projects/:slug/generate/video-prompts/save', async (req, res) => {
  const { slug } = req.params
  const { episode_id, title, prompts } = req.body
  if (!episode_id) return res.status(400).json({ detail: 'episode_id is required' })
  try {
    const paths = await resolveEpisodePaths(slug, episode_id, title || '')
    const names = await resolveSubfolderNames(slug, episode_id)

    let episodeDir = paths.episode_dir.replace(/\/$/, '')
    const seasonDir = path.dirname(episodeDir)
    const actualDir = await resolveEpisodeDir(seasonDir, episode_id)
    if (actualDir) episodeDir = actualDir

    const videoDir = await resolveSubfolder(episodeDir, names.video)
    let text = `# Video Prompts\n\n`
    for (const s of (prompts?.scenes || [])) {
      text += `## Scene ${s.number}: ${s.title}\n\n${s.prompt}\n\n`
    }
    const outPath = path.join(videoDir, `${episode_id}_Video_Prompts.docx`)
    await buildImagePromptsDocx(text, episode_id, title || '', outPath)

    res.json({ ok: true, path: outPath })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to save video prompts'))
  }
})

// ── Enqueue AI video generation job (text-to-video or image-to-video) ──

router.post('/projects/:slug/generate/video', async (req, res) => {
  const { slug } = req.params
  const project = await pm.getProject(slug)
  if (!project) return res.status(404).json({ detail: 'Project not found' })

  const config = await pm.getConfig(slug)
  if (!config) return res.status(404).json({ detail: 'Project config not found' })

  const episodeId = req.body.episode_id
  if (!episodeId) return res.status(400).json({ detail: 'episode_id is required' })

  // Look up the selected model → required API key
  const modelId: string = req.body.model || 'veo-v2'
  const videoModels: Record<string, any> = (config as any).video_models || {}
  const modelConfig = videoModels[modelId]
  if (!modelConfig) return res.status(400).json({ detail: `Unknown video model: ${modelId}` })

  const apiKeyField = modelConfig.provider === 'genaipro-veo' ? 'genaipro_api_key'
    : modelConfig.provider === 'kie' ? 'kie_api_key'
    : modelConfig.provider === 'fal' ? 'fal_api_key'
    : null
  if (!apiKeyField || !(config as any)[apiKeyField]) {
    return res.status(400).json({ detail: `No API key configured for ${modelConfig.provider}. Add one in Settings → API Keys.` })
  }

  if (jq.isDuplicate(slug, episodeId, 'video')) {
    return res.status(409).json({ detail: `Video generation already queued/running for ${episodeId}` })
  }

  const job = jq.enqueue({
    project_slug: slug,
    type: 'video',
    episode_id: episodeId,
    title: req.body.title || '',
    params: req.body,
  })
  res.status(201).json(job)
})

// ── Repair endpoint — recovers missing video clips from provider task records ──
//
// Mirrors POST /generate/images-repair. The reconciler reads the sidecar
// task-manifest, looks up each missing clip's stored task_id, and downloads
// from the provider's existing result URL. Zero credit cost. Clips with no
// manifest entry come back as `no_manifest` so the user can decide whether
// to click Generate for those.
router.post('/projects/:slug/generate/video-repair', async (req, res) => {
  const { slug } = req.params
  if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })

  const episodeId: string | undefined = req.body?.episode_id
  if (!episodeId) return res.status(400).json({ detail: 'episode_id is required' })

  if (jq.isDuplicate(slug, episodeId, 'video_repair' as any)) {
    return res.status(409).json({ detail: `Video repair already queued/running for ${episodeId}` })
  }

  const job = jq.enqueue({
    project_slug: slug,
    type: 'video_repair' as any,
    episode_id: episodeId,
    title: 'Video Repair (no credits)',
    params: { episode_id: episodeId },
  })
  res.status(201).json(job)
})

// ── List scene images for the image-to-video source picker ──

router.get('/projects/:slug/:episodeId/scene-images', async (req, res) => {
  const { slug, episodeId } = req.params
  const fs = await import('fs/promises')

  try {
    const outputRoot = await pm.getProjectOutputRoot(slug)
    if (!outputRoot) return res.status(404).json({ detail: 'Project not found' })
    const code = episodeId.toUpperCase()
    const names = await resolveSubfolderNames(slug, code)

    // Find episode dir
    async function walk(dir: string, depth: number): Promise<string | null> {
      if (depth > 4) return null
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const e of entries) {
        if (!e.isDirectory()) continue
        const clean = e.name.replace(/^✅\s*/, '')
        if (clean.startsWith(`${code} - `) || clean === code) return path.join(dir, e.name)
        const found = await walk(path.join(dir, e.name), depth + 1)
        if (found) return found
      }
      return null
    }
    const epDir = await walk(outputRoot, 0)
    if (!epDir) return res.json({ images: [] })

    // Find images subfolder
    let imagesDir: string | null = null
    const entries = await fs.readdir(epDir).catch(() => [] as string[])
    for (const entry of entries) {
      if (entry.replace(/^✅\s*/, '') === names.images) {
        imagesDir = path.join(epDir, entry)
        break
      }
    }
    if (!imagesDir) return res.json({ images: [] })

    const files = await fs.readdir(imagesDir).catch(() => [] as string[])
    const images = files
      .filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f))
      .map(filename => {
        const sceneMatch = filename.match(/Scene(\d+)/i)
        return {
          filename,
          scene_number: sceneMatch ? parseInt(sceneMatch[1]) : null,
          path: path.join(imagesDir!, filename),
        }
      })
      .sort((a, b) => (a.scene_number || 999) - (b.scene_number || 999))

    res.json({ images })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Could not list scene images'))
  }
})
