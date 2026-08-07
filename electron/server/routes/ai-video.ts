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
import { callAi, callAiWithRetry } from '../lib/ai-client.js'
import { resolveEpisodePaths, resolveSubfolderNames } from '../services/utils.js'
import { readArtifactRawText } from '../lib/episode-artifacts.js'
import { buildImagePromptsDocx } from '../lib/docx-builder.js'
import { resolveEpisodeDir } from '../lib/folder-resolver.js'
import { findEpisodeSubfolderDir, resolveEpisodeSubfolderDir } from '../services/media-root.js'
import { getVideoStatus } from '../services/asset-status.js'
import { BUILT_IN_VIDEO_PROMPTS } from '../models/video-prompts-builtin.js'
import { humanizeBackendError, respondWithError } from '../lib/humanize-backend-error.js'
import { getApiKey } from '../services/app-secrets-store.js'
import { listVideoModels as listGenStudioVideoModels } from '../lib/genstudio-client.js'
import { resolveGenStudioModelId, unavailableLegacyModelMessage } from '../services/genstudio-model-migration.js'
import { videoPromptsOutputContract } from '../lib/story-output-contracts.js'

export const router = Router()

/**
 * Keep the clip prompts that are safely usable, and say which scene numbers
 * came back uncovered.
 *
 * THIS IS THE PER-ITEM GUARANTEE for video prompts, and it has to be here
 * because there is nowhere else it can be. `number` is model-supplied and
 * load-bearing: `generators/ai-video.ts` pairs a prompt with its start image by
 * `sceneImages.find(s => s.number === p.number)` and names the output
 * `<EP>_VideoNN_v1.mp4`. Nothing between this route and that lookup checks the
 * number — the save route writes whatever heading it is given, and the parser
 * reads whatever heading it finds. So an out-of-range number pairs a prompt
 * with the wrong scene, and a duplicate number silently overwrites a clip.
 *
 * `videoPromptsOutputContract` used to stand in for this check by demanding
 * exactly `count` items — which never actually enforced uniqueness or coverage,
 * and did guarantee that one malformed row discarded every correct prompt in a
 * batch the account had already been charged for. The contract now accepts the
 * envelope; this function is what makes that safe.
 *
 *   - `number` must be an integer within 1..count, the same allowed set the
 *     request was built from. Anything else is dropped, never renumbered:
 *     inventing a slot for a row whose address we do not trust is exactly the
 *     silent-wrong-result this exists to prevent.
 *   - The first row to claim a number keeps it. A duplicate is dropped rather
 *     than allowed to overwrite an earlier clip.
 *   - A row with no usable prompt text is dropped.
 *
 * Returns the surviving rows in scene order plus the numbers left uncovered.
 * There is no bounded "re-request only the missing numbers" pass for this
 * stage, so `missing` is reported rather than repaired — the caller re-runs the
 * batch knowingly instead of discovering the gap at clip-generation time.
 */
export function normalizeVideoPromptScenes(
  raw: unknown,
  count: number,
): { scenes: Array<{ number: number; title: string; prompt: string }>; missing: number[] } {
  const rows = Array.isArray(raw) ? raw : []
  const byNumber = new Map<number, { number: number; title: string; prompt: string }>()
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const number = Number((row as any).number)
    if (!Number.isInteger(number) || number < 1 || number > count) continue
    if (byNumber.has(number)) continue
    const prompt = typeof (row as any).prompt === 'string' ? (row as any).prompt.trim() : ''
    if (!prompt) continue
    const title = typeof (row as any).title === 'string' ? (row as any).title.trim() : ''
    byNumber.set(number, { number, title: title || `Scene ${number}`, prompt })
  }
  const scenes = [...byNumber.values()].sort((a, b) => a.number - b.number)
  const missing: number[] = []
  for (let number = 1; number <= count; number++) if (!byNumber.has(number)) missing.push(number)
  return { scenes, missing }
}

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
  if (typeof model !== 'string' || !model.trim()) {
    return res.status(409).json({
      detail: 'Choose an available GenStudio KH language product. Story Studio did not choose a hidden fallback, and no generation request or credit charge was made.',
    })
  }

  // Pull story context from the narration file if available
  let storyContext = ''
  try {
    const paths = await resolveEpisodePaths(slug, episode_id, title || '')
    storyContext = (await readArtifactRawText(paths.narration_docx)).slice(0, 3000)
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
    const raw = await callAiWithRetry(model, sys, userPrompt, {
      anthropic_api_key: config.anthropic_api_key,
      openai_api_key: config.openai_api_key,
      kie_api_key: config.kie_api_key,
    }, false, {
      // Standard: a structured pack of scene video prompts.
      outputBudget: 'standard',
      slug,
      outputContract: videoPromptsOutputContract(nClips),
    })
    let text = raw.trim()
    if (text.startsWith('```')) text = text.split('\n').filter(l => !l.trim().startsWith('```')).join('\n')
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) {
      throw new Error(
        'GenStudio completed the request, but the video-prompt response contained no JSON object '
        + `(${text.length} character(s) returned). The result was rejected locally.`,
      )
    }
    let parsed: any
    try {
      parsed = JSON.parse(text.slice(start, end + 1))
    } catch (error: any) {
      throw new Error(
        `GenStudio completed the request, but the video-prompt response was not valid JSON — ${error?.message || error}. The result was rejected locally.`,
      )
    }
    // The contract accepts the envelope; per-scene correctness is enforced here.
    const { scenes, missing } = normalizeVideoPromptScenes(parsed?.scenes, nClips)
    if (!scenes.length) {
      throw new Error(
        `GenStudio completed the request, but none of the ${Array.isArray(parsed?.scenes) ? parsed.scenes.length : 0} returned `
        + `entr${Array.isArray(parsed?.scenes) && parsed.scenes.length === 1 ? 'y' : 'ies'} carried a usable prompt with a scene number in 1-${nClips}. `
        + 'The result was rejected locally.',
      )
    }
    res.json({
      scenes,
      requested: nClips,
      // Stated, not inferred. There is no bounded repair pass for this stage,
      // so a gap here means re-running the batch — which the caller should be
      // told about rather than discover when a clip has no prompt.
      missing,
    })
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

    const videoDir = await resolveEpisodeSubfolderDir(slug, episode_id, 'video', episodeDir, names.video)
    let text = `# Video Prompts\n\n`
    for (const s of (prompts?.scenes || [])) {
      text += `## Scene ${s.number}: ${s.title}\n\n${s.prompt}\n\n`
    }
    const outPath = path.join(videoDir, `${episode_id}_Video_Prompts.md`)
    await buildImagePromptsDocx(text, episode_id, title || '', outPath)

    res.json({ ok: true, path: outPath })
  } catch (e: any) {
    res.status(500).json(humanizeBackendError(e, 'Failed to save video prompts'))
  }
})

// ── Enqueue image-to-video generation job ─────────────────────────────

router.post('/projects/:slug/generate/video', async (req, res) => {
  const { slug } = req.params
  const project = await pm.getProject(slug)
  if (!project) return res.status(404).json({ detail: 'Project not found' })

  const config = await pm.getConfig(slug)
  if (!config) return res.status(404).json({ detail: 'Project config not found' })

  const episodeId = req.body.episode_id
  if (!episodeId) return res.status(400).json({ detail: 'episode_id is required' })

  const selectedModelId: string = req.body.model || ''
  const modelId = resolveGenStudioModelId('video', selectedModelId)
  if (!modelId) return res.status(409).json({ detail: unavailableLegacyModelMessage('video', selectedModelId || '(none)') })
  if (req.body.mode && req.body.mode !== 'frames') {
    return res.status(400).json({ detail: 'Text-to-video has been retired. Choose an image-to-video model and generate the scene image first.' })
  }
  const apiKey = await getApiKey('genstudio').catch(() => '')
  if (!apiKey) return res.status(400).json({ detail: 'Add the scoped GenStudio API key in Settings → This Mac.' })
  try {
    const catalog = await listGenStudioVideoModels(apiKey)
    const entry = catalog.find(item => item.id === modelId)
    if (!entry?.available || !entry.modes.includes('image-to-video')) {
      return res.status(409).json({
        detail: `Saved video model "${selectedModelId}" is not currently available in the GenStudio catalog. Select an available image-to-video model.`,
      })
    }
  } catch (error: any) {
    return res.status(502).json(humanizeBackendError(error, 'Could not verify the GenStudio video catalog'))
  }

  if (jq.isDuplicate(slug, episodeId, 'video')) {
    return res.status(409).json({ detail: `Video generation already queued/running for ${episodeId}` })
  }

  const job = jq.enqueue({
    project_slug: slug,
    type: 'video',
    episode_id: episodeId,
    title: req.body.title || '',
    params: { ...req.body, model: `genstudio-video:${modelId}`, mode: 'frames', provider: 'genstudio' },
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

    // Find images subfolder (media-aware; honours ✅ prefix).
    const imagesDir = await findEpisodeSubfolderDir(slug, code, 'images', epDir, names.images)
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
