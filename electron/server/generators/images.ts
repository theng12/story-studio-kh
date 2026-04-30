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
import * as cm from '../services/character-manager.js'
import { fileExistsWithContent, isCloudEvictedPlaceholder, sleepCancellable } from '../lib/http-retry.js'
import { tryRecoverImageFromManifest } from '../lib/manifest-recovery.js'
import { readManifest, type Manifest } from '../services/task-manifest.js'
import { findReferencedCharacters } from '../lib/character-name-match.js'
import type { Character } from '../models/types.js'
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

  // Phase 8 — load this episode's character cast once for reference-image
  // wiring. Auto-detect: scan each scene's prompt text for character names
  // and forward matching characters' reference images to the provider.
  // Models that don't declare supports_reference_images silently ignore
  // the field (text-only path, no overhead).
  const cast = await cm.listCharacters(project_slug, { episodeCode: episode_id })
    .catch(() => [] as Character[])
  const castWithRefs = cast.filter(c => c.references?.images?.length)
  if (castWithRefs.length) {
    const supports = providerParams?.supports_reference_images === true
    const note = supports
      ? `model '${modelName}' will receive their references`
      : `model '${modelName}' does NOT support references — they'll be ignored (use Flux Kontext or Nano Banana for reference-driven gen)`
    job.output_lines.push(
      `Cast with reference images: ${castWithRefs.map(c => c.name).join(', ')} — ${note}`,
    )
  }

  // Extract episode title from folder
  const dirName = path.basename(resolvedEpDir)
  const episodeTitle = dirName.includes(' - ') ? dirName.split(' - ').slice(1).join(' - ') : episode_id

  /**
   * Auto-detect which characters appear in a scene by scanning the prompt
   * text for their names (delegated to findReferencedCharacters for the
   * pure boundary-matching logic). Returns absolute paths of every
   * reference image attached to matching characters. Empty array when no
   * names appear — provider call goes through text-only.
   */
  function resolveSceneReferenceImages(promptText: string): string[] {
    const matched = findReferencedCharacters(promptText, castWithRefs)
    if (!matched.length) return []
    const out: string[] = []
    for (const c of matched) {
      // Linked-aware: characters live under the resolved project dir,
      // not unconditionally under PROJECTS_ROOT — otherwise iCloud-synced
      // projects would silently render scenes without their reference
      // images attached.
      const projDir = pm.getProjectDir(project_slug) || path.join(pm.PROJECTS_ROOT, project_slug)
      const charDir = path.join(projDir, 'characters', c.id)
      for (const filename of (c.references!.images || [])) {
        out.push(path.join(charDir, filename))
      }
    }
    return out
  }

  const aspectRatio = req.aspect_ratio || '16:9'
  const force = req.force || false
  const errors: string[] = []
  // Concurrency: project config → request override → default 5. Clamp 1..10.
  const configConcurrency = Number((config as any).image_concurrency) || 0
  const reqConcurrency = Number((req as any).concurrency) || 0
  const concurrency = Math.max(1, Math.min(10, reqConcurrency || configConcurrency || 5))
  // Launch stagger: delay each pool worker's FIRST task by `i * staggerMs` so
  // the initial-burst submit doesn't trip per-second 429s on Kie / fal.
  // After the spread the rolling pool runs at full concurrency. Default 0
  // (no stagger) — opt-in via Settings → Images → Launch stagger. Clamp 0..5000.
  const cfgImageStagger = Number((config as any).image_launch_stagger_ms) || 0
  const launchStaggerMs = Math.max(0, Math.min(5000, cfgImageStagger))

  // Read the per-folder task manifests once at the top so we can attempt
  // free recovery (existing-task poll) before issuing any fresh submit.
  // Best-effort — a missing/corrupt sidecar just means recovery isn't
  // available for those items, fresh generation still works.
  const sceneManifest: Manifest = await readManifest(bgDir).catch(
    () => ({ schema_version: 1 as const, tasks: {} }),
  )
  const thumbManifest: Manifest = await readManifest(thumbDir).catch(
    () => ({ schema_version: 1 as const, tasks: {} }),
  )

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
    // iCloud-evicted asset: file is recoverable for free by opening it in
    // Finder; re-billing the provider would be a waste. Skip this scene
    // and surface a clear hint. User downloads, re-runs, no charge.
    if (!force && await isCloudEvictedPlaceholder(v1Path)) {
      job.output_lines.push(
        `⚠ ${stem}_v1.png is iCloud-evicted (right-click in Finder → Download Now). ` +
        `Skipped to avoid re-billing for an asset you already paid for.`,
      )
      return
    }
    // Auto-recovery: before issuing a fresh (charged) submit, see if the
    // task-manifest sidecar has a stored task_id from a previous run. If
    // the provider still has the result (success / pending), download it
    // for free. Skip when --force regen was requested. Failures here
    // silently fall through to the fresh-submit path below.
    if (!force) {
      const recovered = await tryRecoverImageFromManifest(
        sceneManifest.tasks[`${stem}_v1.png`] || null,
        apiKey, modelConfig,
        () => jq.isCancelled(job.job_id),
      )
      if (recovered) {
        for (let i = 0; i < recovered.urls.length; i++) {
          await downloadImage(recovered.urls[i], path.join(bgDir, `${stem}_v${i + 1}.png`))
        }
        processed++
        job.output_lines.push(
          `Scene ${scene.number}/${totalToProcess}: ${scene.title} — recovered ` +
          `${recovered.urls.length} variant(s) from existing task ${recovered.taskId.slice(0, 12)}… (no charge)`,
        )
        return
      }
    }
    try {
      const referenceImagePaths = resolveSceneReferenceImages(scene.prompt)
      const result = await imageProvider!.generateImage({
        prompt: scene.prompt, apiKey, aspectRatio, modelId: modelName, providerParams,
        referenceImagePaths: referenceImagePaths.length ? referenceImagePaths : undefined,
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
    // iCloud-evicted (same handling as runScene).
    if (!force && await isCloudEvictedPlaceholder(v1Path)) {
      job.output_lines.push(
        `⚠ ${stem}_v1.png is iCloud-evicted (right-click in Finder → Download Now). ` +
        `Skipped to avoid re-billing.`,
      )
      return
    }
    // Auto-recovery (same as runScene above) — try to recover from a
    // previously-submitted task before charging for a fresh submit.
    if (!force) {
      const recovered = await tryRecoverImageFromManifest(
        thumbManifest.tasks[`${stem}_v1.png`] || null,
        apiKey, modelConfig,
        () => jq.isCancelled(job.job_id),
      )
      if (recovered) {
        for (let i = 0; i < recovered.urls.length; i++) {
          await downloadImage(recovered.urls[i], path.join(thumbDir, `${stem}_v${i + 1}.png`))
        }
        processed++
        job.output_lines.push(
          `Thumbnail ${thumb.number}/${totalToProcess}: ${thumb.title} — recovered ` +
          `${recovered.urls.length} variant(s) from existing task ${recovered.taskId.slice(0, 12)}… (no charge)`,
        )
        return
      }
    }
    const enhanced = enhanceThumbnailPrompt(thumb.prompt, episodeTitle, thumb.number)
    try {
      // Thumbnail prompts also reference characters — use the original
      // (un-enhanced) prompt for matching so the title overlay text doesn't
      // confuse the name detector.
      const referenceImagePaths = resolveSceneReferenceImages(thumb.prompt)
      const result = await imageProvider!.generateImage({
        prompt: enhanced, apiKey, aspectRatio, modelId: modelName, providerParams,
        referenceImagePaths: referenceImagePaths.length ? referenceImagePaths : undefined,
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
   *  interrupted but at least we won't start new ones.
   *
   *  When `launchStaggerMs > 0`, the i-th worker delays its FIRST task by
   *  `i * launchStaggerMs`. The sleep is broken into 200ms ticks so a
   *  user-cancel during the stagger window unwinds promptly. */
  async function runPool<T>(items: T[], worker: (item: T) => Promise<void>) {
    let cursor = 0
    const isCancelled = () => jq.isCancelled(job.job_id)
    async function next(workerIndex: number): Promise<void> {
      if (launchStaggerMs > 0 && workerIndex > 0) {
        try {
          await sleepCancellable(workerIndex * launchStaggerMs, isCancelled)
        } catch { return /* cancelled mid-stagger */ }
      }
      while (cursor < items.length) {
        if (isCancelled()) return
        const i = cursor++
        await worker(items[i]!)
      }
    }
    await Promise.all(Array.from(
      { length: Math.min(concurrency, items.length) },
      (_, i) => next(i),
    ))
  }

  // Scene images
  if (mode === 'all' || mode === 'scenes') {
    let filteredScenes = scenes
    if (req.scene_number) filteredScenes = filteredScenes.filter(s => s.number === req.scene_number)
    totalToProcess = filteredScenes.length
    processed = 0
    job.output_lines.push(
      `Generating ${filteredScenes.length} scene image(s) with concurrency=${concurrency}` +
      (launchStaggerMs > 0 ? `, launch stagger ${launchStaggerMs}ms` : '') +
      '...',
    )
    await runPool(filteredScenes, runScene)
  }

  // Thumbnail images
  if (mode === 'all' || mode === 'thumbs') {
    let thumbs = thumbnails
    if (req.thumb_number) thumbs = thumbs.filter(t => t.number === req.thumb_number)
    totalToProcess = thumbs.length
    processed = 0
    job.output_lines.push(
      `Generating ${thumbs.length} thumbnail(s) with concurrency=${concurrency}` +
      (launchStaggerMs > 0 ? `, launch stagger ${launchStaggerMs}ms` : '') +
      '...',
    )
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
