/**
 * Image generator — port of generate_images.py.
 * Generates scene and thumbnail images via kie.ai API.
 */

import { existsSync } from 'fs'
import path from 'path'
import { parseImagePromptsDocx, type ParsedPrompts } from '../lib/docx-parser.js'
import { downloadImage } from '../lib/kie-client.js'
import { registry, resolveApiKeyForProvider } from '../providers/registry.js'
import { recordTask, hashInput } from '../services/task-manifest.js'
import { resolveSubfolderNames, assertBalanceAvailable } from '../services/utils.js'
import * as pm from '../services/project-manager.js'
import * as jq from '../services/job-queue.js'
import { fileExistsWithContent } from '../lib/http-retry.js'
import type { GenerateImagesRequest, Job, ImageModelConfig } from '../models/types.js'
import fs from 'fs/promises'

const THUMB_TEXT_STYLES = [
  'ornate serif font, radiant gold, glowing with warm magical light',
  '3D metallic gold, dramatically lit, casting a rich soft glow',
  'flowing elegant script, golden shimmer, soft ethereal light',
  'bold sweeping letters, majestic golden hue, luminous atmosphere',
  'mystical glowing font, deep gold, warm magical radiance',
]

function enhanceThumbnailPrompt(prompt: string, episodeTitle: string, number: number): string {
  const style = THUMB_TEXT_STYLES[(number - 1) % THUMB_TEXT_STYLES.length]
  return `${prompt.trimEnd()} The episode title "${episodeTitle}" is displayed in ${style}, perfectly centered in the frame, large and legible against the background.`
}

/**
 * Search recursively for a file matching any of the candidate filenames.
 * Returns the first match found.
 */
async function findFileRecursive(dir: string, candidates: string[]): Promise<string | null> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isFile() && candidates.includes(entry.name)) return fullPath
      if (entry.isDirectory()) {
        const found = await findFileRecursive(fullPath, candidates)
        if (found) return found
      }
    }
  } catch { /* skip inaccessible dirs */ }
  return null
}

export async function findScenePromptsFile(slug: string, episodeId: string): Promise<string> {
  const code = episodeId.toUpperCase()
  const outputRoot = await pm.getProjectOutputRoot(slug)
  if (!outputRoot) throw new Error('Project directory not found')

  // Try new separate file first, then fall back to old combined file
  const candidates = [
    `${code}_Scene_Prompts.docx`,
    `${code}_Image_Prompts.docx`,
  ]
  const found = await findFileRecursive(outputRoot, candidates)
  if (found) return found
  throw new Error(`Could not find scene prompts for ${code}. Generate the prompts first.`)
}

export async function findThumbPromptsFile(slug: string, episodeId: string): Promise<string> {
  const code = episodeId.toUpperCase()
  const outputRoot = await pm.getProjectOutputRoot(slug)
  if (!outputRoot) throw new Error('Project directory not found')

  // Try new separate file first, then fall back to old combined file
  const candidates = [
    `${code}_Thumbnail_Prompts.docx`,
    `${code}_Image_Prompts.docx`,
  ]
  const found = await findFileRecursive(outputRoot, candidates)
  if (found) return found
  throw new Error(`Could not find thumbnail prompts for ${code}. Generate the prompts first.`)
}

export async function resolveImageDirs(projectSlug: string, promptsPath: string, episodeId: string): Promise<{ bgDir: string; thumbDir: string; episodeDir: string }> {
  const code = episodeId.toUpperCase()

  // Walk up from prompts file to find the episode dir
  // The prompts file lives inside a subfolder (Scene Prompts / Thumbnail Prompts / Image Prompts / Script)
  let episodeDir = path.dirname(promptsPath)
  const parentName = path.basename(episodeDir).replace(/^✅\s*/, '').toLowerCase()
  if (parentName.includes('prompt') || parentName.includes('script')) {
    episodeDir = path.dirname(episodeDir)
  }

  // Read configured subfolder names from project config
  const names = await resolveSubfolderNames(projectSlug, code)
  const bgConfigName = names.images       // e.g. "TN0024 - 05 Scene Images"
  const thumbConfigName = names.thumbnails // e.g. "TN0024 - 06 Thumbnail Images"

  // Default to config-based paths
  let bgDir = path.join(episodeDir, bgConfigName)
  let thumbDir = path.join(episodeDir, thumbConfigName)

  // Scan for existing folders (handles ✅ prefix and old/new names)
  try {
    const entries = await fs.readdir(episodeDir)
    for (const entry of entries) {
      const clean = entry.replace(/^✅\s*/, '')
      // Match config name (with or without ✅)
      if (clean === bgConfigName) bgDir = path.join(episodeDir, entry)
      if (clean === thumbConfigName) thumbDir = path.join(episodeDir, entry)
      // Also match legacy names for backward compatibility
      const lc = clean.toLowerCase()
      if (lc === `${code.toLowerCase()} - background images` || lc === `${code.toLowerCase()} - scene images`) {
        if (!entries.some(e => e.replace(/^✅\s*/, '') === bgConfigName)) {
          bgDir = path.join(episodeDir, entry)
        }
      }
      if (lc === `${code.toLowerCase()} - thumbnails` || lc === `${code.toLowerCase()} - thumbnail images`) {
        if (!entries.some(e => e.replace(/^✅\s*/, '') === thumbConfigName)) {
          thumbDir = path.join(episodeDir, entry)
        }
      }
    }
  } catch { /* fall back to config defaults */ }

  return { bgDir, thumbDir, episodeDir }
}

export async function generateImages(job: Job): Promise<void> {
  const { project_slug, episode_id, params } = job
  const req = params as GenerateImagesRequest

  const config = await pm.getConfig(project_slug)
  if (!config) throw new Error('Project config not found')
  const modelName = req.model || 'grok-imagine'
  const modelConfig: ImageModelConfig = config.image_models[modelName]
  if (!modelConfig) throw new Error(`Unknown image model: ${modelName}`)

  // Resolve provider (backward-compat: infer 'kie' if provider field missing)
  const providerId = (modelConfig as any).provider || 'kie'
  const imageProvider = registry.getImageProvider(providerId)
  if (!imageProvider) throw new Error(`No image provider registered for: ${providerId}`)

  const providerParams = (modelConfig as any).provider_params || {
    endpoint: modelConfig.endpoint,
    poll: modelConfig.poll,
    type: modelConfig.type,
    api_model: modelConfig.api_model,
  }
  const apiKey = await resolveApiKeyForProvider(project_slug, imageProvider.meta, {
    model: modelName,
    jobId: job.job_id,
  })
  if (!apiKey) throw new Error(`No API key configured for ${imageProvider.meta.name}. Add one in Settings → API Keys.`)

  // Preflight: refuse immediately if the provider balance is clearly zero.
  // Fast fail-fast — much better UX than discovering the empty balance
  // after the first provider submit returns "insufficient credits".
  if (providerId === 'kie') await assertBalanceAvailable('kie', apiKey)

  // Find scene and thumbnail prompt files (separate or combined)
  const mode = req.mode || 'all'
  let scenePromptsPath: string | null = null
  let thumbPromptsPath: string | null = null

  if (mode === 'all' || mode === 'scenes') {
    scenePromptsPath = await findScenePromptsFile(project_slug, episode_id)
    job.output_lines.push(`Found scene prompts: ${path.basename(scenePromptsPath)}`)
  }
  if (mode === 'all' || mode === 'thumbs') {
    thumbPromptsPath = await findThumbPromptsFile(project_slug, episode_id)
    job.output_lines.push(`Found thumbnail prompts: ${path.basename(thumbPromptsPath)}`)
  }

  // Use whichever file we found to resolve image dirs
  const refPath = scenePromptsPath || thumbPromptsPath!
  const { bgDir, thumbDir, episodeDir: resolvedEpDir } = await resolveImageDirs(project_slug, refPath, episode_id)
  await fs.mkdir(bgDir, { recursive: true })
  await fs.mkdir(thumbDir, { recursive: true })

  // Parse prompts from separate or combined files
  let scenes: ParsedPrompts['scenes'] = []
  let thumbnails: ParsedPrompts['thumbnails'] = []

  if (scenePromptsPath) {
    const parsed = await parseImagePromptsDocx(scenePromptsPath)
    scenes = parsed.scenes
    // If the file is a combined file, also grab thumbnails from it
    if (!thumbPromptsPath || thumbPromptsPath === scenePromptsPath) {
      thumbnails = parsed.thumbnails
    }
  }
  if (thumbPromptsPath && thumbPromptsPath !== scenePromptsPath) {
    const parsed = await parseImagePromptsDocx(thumbPromptsPath)
    thumbnails = parsed.thumbnails
    // If no scenes were found yet (mode=thumbs), the scenes stay empty
    if (!scenePromptsPath) scenes = parsed.scenes
  }

  job.output_lines.push(`Parsed: ${scenes.length} scenes, ${thumbnails.length} thumbnails`)

  // Extract episode title from folder
  const dirName = path.basename(resolvedEpDir)
  const episodeTitle = dirName.includes(' - ') ? dirName.split(' - ').slice(1).join(' - ') : episode_id

  const aspectRatio = req.aspect_ratio || '16:9'
  const force = req.force || false
  const errors: string[] = []
  // Concurrency: project config → request override → default 5. Clamp 1..10.
  const configConcurrency = Number((config as any).image_concurrency) || 0
  const reqConcurrency = Number((req as any).concurrency) || 0
  const concurrency = Math.max(1, Math.min(10, reqConcurrency || configConcurrency || 5))

  let processed = 0
  let totalToProcess = 0

  async function runScene(scene: { number: number; title: string; prompt: string }) {
    const stem = `${episode_id.toUpperCase()}_Scene${scene.number.toString().padStart(2, '0')}`
    const v1Path = path.join(bgDir, `${stem}_v1.png`)
    // Only treat the cache as a hit if the file exists AND is non-empty — a
    // zero-byte file from a prior aborted download is NOT a valid skip.
    if (await fileExistsWithContent(v1Path) && !req.scene_number && !force) {
      job.output_lines.push(`Skipping ${stem} (exists)`)
      return
    }
    try {
      const result = await imageProvider!.generateImage({
        prompt: scene.prompt, apiKey, aspectRatio, modelId: modelName, providerParams,
        isCancelled: () => jq.isCancelled(job.job_id),
      })
      const urls = result.urls
      // Record the provider task id BEFORE downloading. Reasoning: even if
      // a download fails halfway, the manifest still points at the
      // (already-charged) provider job, so the Repair button can recover
      // the rest without billing the user a second time. Same record per
      // variant — the reconciler picks the right URL by parsing the _vN
      // suffix at recovery time.
      if (result.taskId) {
        await Promise.all(urls.map((_, i) => recordTask(bgDir, `${stem}_v${i + 1}.png`, {
          provider: imageProvider!.meta.providerId || imageProvider!.meta.id,
          task_id: result.taskId!,
          submitted_at: new Date().toISOString(),
          input_hash: hashInput(scene.prompt),
        })))
      }
      for (let i = 0; i < urls.length; i++) {
        await downloadImage(urls[i], path.join(bgDir, `${stem}_v${i + 1}.png`))
      }
      processed++
      job.output_lines.push(`Scene ${scene.number}/${totalToProcess}: ${scene.title} — saved ${urls.length} variant(s)`)
    } catch (e: any) {
      processed++
      job.output_lines.push(`Scene ${scene.number}/${totalToProcess}: FAILED — ${e.message}`)
      errors.push(`Scene ${scene.number}: ${e.message}`)
    }
  }

  async function runThumb(thumb: { number: number; title: string; prompt: string }) {
    const stem = `${episode_id.toUpperCase()}_Thumb${thumb.number.toString().padStart(2, '0')}`
    const v1Path = path.join(thumbDir, `${stem}_v1.png`)
    if (await fileExistsWithContent(v1Path) && !req.thumb_number && !force) {
      job.output_lines.push(`Skipping ${stem} (exists)`)
      return
    }
    const enhanced = enhanceThumbnailPrompt(thumb.prompt, episodeTitle, thumb.number)
    try {
      const result = await imageProvider!.generateImage({
        prompt: enhanced, apiKey, aspectRatio, modelId: modelName, providerParams,
        isCancelled: () => jq.isCancelled(job.job_id),
      })
      const urls = result.urls
      if (result.taskId) {
        await Promise.all(urls.map((_, i) => recordTask(thumbDir, `${stem}_v${i + 1}.png`, {
          provider: imageProvider!.meta.providerId || imageProvider!.meta.id,
          task_id: result.taskId!,
          submitted_at: new Date().toISOString(),
          input_hash: hashInput(enhanced),
        })))
      }
      for (let i = 0; i < urls.length; i++) {
        await downloadImage(urls[i], path.join(thumbDir, `${stem}_v${i + 1}.png`))
      }
      processed++
      job.output_lines.push(`Thumbnail ${thumb.number}/${totalToProcess}: ${thumb.title} — saved ${urls.length} variant(s)`)
    } catch (e: any) {
      processed++
      job.output_lines.push(`Thumbnail ${thumb.number}/${totalToProcess}: FAILED — ${e.message}`)
      errors.push(`Thumbnail ${thumb.number}: ${e.message}`)
    }
  }

  /** Run tasks with a concurrency cap (simple pool). Stops picking up new
   *  items as soon as the job is cancelled so the user isn't billed for
   *  work they already aborted — in-flight provider calls can't be
   *  interrupted but at least we won't start new ones. */
  async function runPool<T>(items: T[], worker: (item: T) => Promise<void>) {
    let cursor = 0
    async function next(): Promise<void> {
      while (cursor < items.length) {
        if (jq.isCancelled(job.job_id)) return
        const i = cursor++
        await worker(items[i]!)
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => next()))
  }

  // Scene images
  if (mode === 'all' || mode === 'scenes') {
    let filteredScenes = scenes
    if (req.scene_number) filteredScenes = filteredScenes.filter(s => s.number === req.scene_number)
    totalToProcess = filteredScenes.length
    processed = 0
    job.output_lines.push(`Generating ${filteredScenes.length} scene image(s) with concurrency=${concurrency}...`)
    await runPool(filteredScenes, runScene)
  }

  // Thumbnail images
  if (mode === 'all' || mode === 'thumbs') {
    let thumbs = thumbnails
    if (req.thumb_number) thumbs = thumbs.filter(t => t.number === req.thumb_number)
    totalToProcess = thumbs.length
    processed = 0
    job.output_lines.push(`Generating ${thumbs.length} thumbnail(s) with concurrency=${concurrency}...`)
    await runPool(thumbs, runThumb)
  }

  // Partial-failure semantics: if ANY item failed, the job must not be
  // stamped "done" — otherwise the UI shows a green success toast while
  // the output folder is half-empty. We surface it via throw (job → error)
  // so the queue runner in job-queue.ts flips job.status to 'error' with
  // the collected reasons. A cancelled job is also a terminal state — let
  // the queue's cancel check handle that at job-queue.ts:141.
  if (errors.length) {
    job.output_lines.push(`Completed with ${errors.length} error(s)`)
    const preview = errors.slice(0, 3).join('; ')
    const suffix = errors.length > 3 ? `; +${errors.length - 3} more` : ''
    throw new Error(`${errors.length} item(s) failed: ${preview}${suffix}`)
  }
  job.output_lines.push('All images generated successfully')
  // When the user ran mixed mode (all), reveal the parent episode dir so
  // they can see both scene + thumbnail folders side-by-side. Otherwise
  // drop them straight into the specific folder that just got populated.
  job.output_dir = mode === 'scenes' ? bgDir : mode === 'thumbs' ? thumbDir : resolvedEpDir
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
