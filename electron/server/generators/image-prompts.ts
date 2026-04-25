/**
 * Image-prompts generator — batch job executor.
 *
 * Mirrors the synchronous POST /generate/image-prompts + POST
 * /generate/image-prompts/save flow in routes/scripts.ts, but collapses
 * the generate-then-save steps into a single job. Used by the Pipeline
 * batch runner so overnight chains can produce the Scene/Thumbnail
 * prompt docx files without waiting for user review.
 *
 * The interactive route in routes/scripts.ts is untouched — this is an
 * additive batch path.
 */

import path from 'path'
import * as pm from '../services/project-manager.js'
import * as jq from '../services/job-queue.js'
import * as cm from '../services/character-manager.js'
import { callAi } from '../lib/ai-client.js'
import { SUPPORTED_MODELS } from '../models/types.js'
import { resolveEpisodePaths, resolveSubfolderNames } from '../services/utils.js'
import { buildImagePromptsDocx } from '../lib/docx-builder.js'
import { resolveSubfolder, resolveEpisodeDir } from '../lib/folder-resolver.js'
import { trackGeneration } from '../services/session-tracker.js'
import { castImagePromptBlock } from '../lib/character-prompt-blocks.js'
import type { Job } from '../models/types.js'
import { resolveTextStyle, resolveFontStyle } from '../models/thumbnail-styles.js'

// Preset shape we expect in job.params (from the Image Prompts page's
// usePresets snapshot { form: {...} }, unwrapped by routes/pipeline.ts).
interface ImagePromptsParams {
  episode_id: string
  title?: string
  model?: string
  style_preset?: string
  style_tag?: string
  aspect_ratio?: string
  scenes_per_chapter?: number
  total_scenes?: number
  thumb_count?: number
  thumb_text_style?: string
  thumb_text_style_custom?: string
  thumb_text_position?: string
  thumb_font_style?: string
  thumb_font_style_custom?: string
  mode?: 'all' | 'scenes' | 'thumbnails'
  /**
   * Cast for this episode — passed through from a saved Image Prompts
   * preset (the form field added in image-prompts.vue). The batch
   * executor resolves these to Character records and folds the cast
   * block into the prompt so the LLM has the names + descriptions to
   * inline per scene. Empty / missing → today's "no cast" path.
   */
  character_ids?: string[]
}

function checkProvider(model: string, config: any): string | null {
  const provider = SUPPORTED_MODELS[model]
  if (provider === 'anthropic' && !config.anthropic_api_key) return 'No Anthropic key configured'
  if (provider === 'openai' && !config.openai_api_key) return 'No OpenAI key configured'
  if (provider === 'kie' && !config.kie_api_key) return 'No kie.ai key configured'
  return null
}

function aiCreds(config: any) {
  return {
    anthropic_api_key: config.anthropic_api_key,
    openai_api_key: config.openai_api_key,
    kie_api_key: config.kie_api_key,
  }
}

// Read up to 3000 chars of narration for grounding the LLM.
async function readStoryContext(slug: string, episode_id: string, title: string): Promise<string> {
  try {
    const paths = await resolveEpisodePaths(slug, episode_id, title || '')
    const mammoth = await import('mammoth')
    const result = await mammoth.default.extractRawText({ path: paths.narration_docx })
    return result.value.slice(0, 3000)
  } catch {
    return `Episode: ${episode_id}, Title: ${title || 'Unknown'}`
  }
}

function buildPrompt(args: {
  episode_id: string
  title: string
  storyContext: string
  /** Pre-rendered cast block from castImagePromptBlock(). Empty string when no cast. */
  castBlock: string
  sceneCount: number
  thumbs: number
  style_tag: string
  aspect_ratio: string
  thumb_font_style: string
  thumb_font_style_custom?: string
  thumb_text_style: string
  thumb_text_style_custom?: string
  thumb_text_position: string
}): string {
  const { episode_id, title, storyContext, castBlock, sceneCount, thumbs, style_tag, aspect_ratio } = args
  const fontPhrase = resolveFontStyle(args.thumb_font_style, args.thumb_font_style_custom)
  const textPhrase = resolveTextStyle(args.thumb_text_style, args.thumb_text_style_custom)
  const thumbTextInstruction = `The episode title "${title}" displayed in ${fontPhrase}, ${textPhrase}, positioned at the ${args.thumb_text_position || 'center'} of the frame, large and legible.`

  const ratioDescriptions: Record<string, string> = {
    '16:9': 'wide 16:9 landscape format with cinematic framing',
    '1:1': 'square 1:1 format with centered composition',
    '9:16': 'tall 9:16 portrait format with vertical composition',
    '4:3': 'classic 4:3 format',
    '3:4': 'portrait 3:4 format',
    '21:9': 'ultrawide 21:9 cinematic format',
  }
  const ratioInstruction = ratioDescriptions[aspect_ratio] || 'wide landscape format'

  const requirements: string[] = []
  if (sceneCount > 0) requirements.push(`Generate exactly ${sceneCount} scene prompts.`)
  if (thumbs > 0) requirements.push(`Generate exactly ${thumbs} thumbnail prompts.`)
  requirements.push(`Every prompt must end with this style tag: "${style_tag}"`)
  requirements.push(`Every prompt must specify composition for ${ratioInstruction}.`)
  requirements.push(`Every prompt must include inline character descriptions.`)

  return `Generate image prompts for a story episode.

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
}

export async function generateImagePrompts(job: Job): Promise<void> {
  const { project_slug, episode_id, params } = job
  const req = params as ImagePromptsParams

  const config = await pm.getConfig(project_slug)
  if (!config) throw new Error('Project config not found')

  const model = req.model || 'gpt-4o'
  const credErr = checkProvider(model, config)
  if (credErr) throw new Error(credErr)

  const title = req.title || episode_id
  const mode = req.mode || 'all'

  // Prefer scenes_per_chapter when present (matches UI semantics: that
  // field is the primary control, total_scenes is the "custom total"
  // escape hatch used only when scenes_per_chapter === 0). Falling through
  // to total_scenes first used to let a stale preset value shadow a
  // freshly-saved scenes_per_chapter=1.
  const spc = Number(req.scenes_per_chapter)
  const sceneCount = mode === 'thumbnails'
    ? 0
    : (Number.isFinite(spc) && spc > 0
      ? spc * 10
      : (req.total_scenes || (req.scenes_per_chapter || 1) * 10))
  const thumbs = mode === 'scenes' ? 0 : (req.thumb_count || 5)

  job.output_lines.push(`Reading narration for story context…`)
  const storyContext = await readStoryContext(project_slug, episode_id, title)

  // Resolve cast for this episode → cast block. Empty array (or missing
  // field on legacy presets) → empty string injected → today's behaviour
  // unchanged.
  const characters = Array.isArray(req.character_ids) && req.character_ids.length
    ? await cm.resolveCharacters(project_slug, req.character_ids)
    : []
  if (characters.length) {
    job.output_lines.push(`Cast: ${characters.map(c => c.name).join(', ')}`)
  }
  const castBlock = castImagePromptBlock(characters)

  const prompt = buildPrompt({
    episode_id,
    title,
    storyContext,
    castBlock,
    sceneCount,
    thumbs,
    style_tag: req.style_tag || '',
    aspect_ratio: req.aspect_ratio || '16:9',
    thumb_font_style: req.thumb_font_style || 'serif',
    thumb_font_style_custom: req.thumb_font_style_custom,
    thumb_text_style: req.thumb_text_style || 'gold',
    thumb_text_style_custom: req.thumb_text_style_custom,
    thumb_text_position: req.thumb_text_position || 'center',
  })

  job.output_lines.push(`Calling ${model} (mode=${mode}, scenes=${sceneCount}, thumbs=${thumbs})…`)
  const controller = new AbortController()
  const cancelWatcher = setInterval(() => {
    if (jq.isCancelled(job.job_id)) controller.abort()
  }, 500)
  let raw: string
  try {
    raw = await callAi(model, '', prompt, aiCreds(config), false,
      { slug: project_slug, jobId: job.job_id, signal: controller.signal })
  } finally {
    clearInterval(cancelWatcher)
  }

  // Parse JSON from response (strip markdown fences if present).
  let text = raw.trim()
  if (text.startsWith('```')) {
    text = text.split('\n').filter(l => !l.trim().startsWith('```')).join('\n')
  }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end < 0) throw new Error('LLM returned no JSON object')
  const parsed = JSON.parse(text.slice(start, end + 1))

  const scenes = Array.isArray(parsed.scenes) ? parsed.scenes : []
  const thumbnails = Array.isArray(parsed.thumbnails) ? parsed.thumbnails : []
  job.output_lines.push(`Parsed ${scenes.length} scene(s), ${thumbnails.length} thumbnail(s).`)

  // Resolve episode dir on disk (real folder, not the stale-title one).
  const paths = await resolveEpisodePaths(project_slug, episode_id, title)
  let episodeDir = paths.episode_dir.replace(/\/$/, '')
  const seasonDir = path.dirname(episodeDir)
  const actualDir = await resolveEpisodeDir(seasonDir, episode_id)
  if (actualDir) episodeDir = actualDir

  const names = await resolveSubfolderNames(project_slug, episode_id)

  // Save scenes
  if (scenes.length > 0) {
    const sceneDir = await resolveSubfolder(episodeDir, names.scene_prompts)
    if (!sceneDir) throw new Error(`Scene prompts folder not found: ${names.scene_prompts}`)
    let sceneText = `# Scene Prompts\n\n`
    for (const s of scenes) sceneText += `## Scene ${s.number}: ${s.title}\n\n${s.prompt}\n\n`
    const outPath = path.join(sceneDir, `${episode_id}_Scene_Prompts.docx`)
    await buildImagePromptsDocx(sceneText, episode_id, title, outPath)
    job.output_lines.push(`Saved scenes → ${path.basename(outPath)}`)
  }

  // Save thumbnails
  if (thumbnails.length > 0) {
    const thumbDir = await resolveSubfolder(episodeDir, names.thumb_prompts)
    if (!thumbDir) throw new Error(`Thumbnail prompts folder not found: ${names.thumb_prompts}`)
    let thumbText = `# Thumbnail Prompts\n\n`
    for (const t of thumbnails) thumbText += `## Thumbnail ${t.number}: ${t.title}\n\n${t.prompt}\n\n`
    const outPath = path.join(thumbDir, `${episode_id}_Thumbnail_Prompts.docx`)
    await buildImagePromptsDocx(thumbText, episode_id, title, outPath)
    job.output_lines.push(`Saved thumbnails → ${path.basename(outPath)}`)
  }

  await trackGeneration(project_slug, 'prompts').catch(() => {})
  job.output_lines.push(`Done.`)
}
