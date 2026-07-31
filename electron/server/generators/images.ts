/**
 * Image generator — port of generate_images.py.
 * Generates scene and thumbnail images through the GenStudio KH image API.
 */

import { existsSync } from 'fs'
import path from 'path'
import { parseImagePromptsDocx, type ParsedPrompts } from '../lib/docx-parser.js'
import { saveGenStudioImage } from '../lib/genstudio-artifacts.js'
import { SpeedTracker, throttle } from '../lib/speed-tracker.js'
import { registry } from '../providers/registry.js'
import { recordTask, recordTaskStrict, hashInput, type TaskManifestEntry } from '../services/task-manifest.js'
import { resolveSubfolderNames } from '../services/utils.js'
import * as pm from '../services/project-manager.js'
import * as jq from '../services/job-queue.js'
import * as cm from '../services/character-manager.js'
import { fileExistsWithContent, isCloudEvictedPlaceholder } from '../lib/http-retry.js'
import {
  isTerminalGenStudioImageTaskFailure,
  resolveImageRetryScope,
  terminalImageManifestEntry,
  tryRecoverImageFromManifestEntry,
  type ImageRecoveryOutcome,
} from '../lib/manifest-recovery.js'
import { GenStudioImageTerminalFailureError } from '../lib/genstudio-client.js'
import { readManifest, type Manifest } from '../services/task-manifest.js'
import { findReferencedCharacters } from '../lib/character-name-match.js'
import { resolveProjectArtStyle } from '../services/art-style-resolver.js'
import { resolveGenStudioLocalFanout } from '../lib/genstudio-runtime.js'
import { requireJobCompletion } from '../services/job-completion.js'
import type { Character } from '../models/types.js'
import type { GenerateImagesRequest, Job, ImageModelConfig } from '../models/types.js'
import { resolveConfiguredAspectRatio, resolveImageModelConfig } from '../services/image-model-resolver.js'
import { resolveImageProviderParams } from '../models/image-provider-params.js'
import { getApiKey } from '../services/app-secrets-store.js'
import fs from 'fs/promises'

// NOTE (v1.0.224): the old `enhanceThumbnailPrompt` + hardcoded gold/glowing
// `THUMB_TEXT_STYLES` were removed. They force-appended a sleep-story title
// instruction to EVERY thumbnail at render time, overriding the user's picks
// and ignoring the format. The thumbnail prompt now arrives from
// generators/image-prompts.ts already carrying the correct (format-aware)
// title-text directive. The render path uses `thumb.prompt` verbatim so the
// chosen image model produces the complete thumbnail, including its title.

export type ThumbnailReferenceStrength = 'loose' | 'balanced' | 'strong'

export function thumbnailReferenceGuidance(strength: ThumbnailReferenceStrength): string {
  return {
    loose:
      'Use the attached thumbnail only as loose inspiration for mood, palette, contrast, and visual energy. Create a clearly new composition for this episode. Do not copy its people, objects, words, logo, branding, or story details.',
    balanced:
      'Adapt the attached thumbnail’s composition, focal hierarchy, camera distance, color balance, lighting, contrast, and title-safe negative space to this episode. Replace all original people, objects, words, branding, and story details with the prompt content.',
    strong:
      'Closely follow the attached thumbnail’s structural layout, framing, subject scale, focal hierarchy, lighting pattern, contrast, and title-safe spacing, while fully replacing its people, objects, text, logo, branding, and narrative content with this episode.',
  }[strength]
}

export function thumbnailReferenceStrengthValue(strength: ThumbnailReferenceStrength): number {
  return { loose: 0.3, balanced: 0.6, strong: 0.85 }[strength]
}

/**
 * Search recursively for a file matching any of the candidate filenames.
 * Returns the first match found.
 */
// Find the highest-PRIORITY candidate present anywhere under `dir`. `candidates`
// is an ordered preference list (e.g. .md before legacy .docx). v1.0.436: the
// previous implementation returned whichever match it hit first in directory
// order, which broke the preference — when both `${code}_Scene_Prompts.md` (240
// scenes) and a stale `${code}_Scene_Prompts.docx` (12 scenes) sit in the same
// folder, readdir lists ".docx" before ".md" (alphabetical), so the stale Word
// file won and only 12 scenes generated. Now we collect ALL matches and return
// the one with the best (lowest) rank in `candidates`, so the .md always wins.
async function findFileRecursive(dir: string, candidates: string[]): Promise<string | null> {
  const ref: { path: string; rank: number } = { path: '', rank: Infinity }
  const walk = async (d: string): Promise<void> => {
    try {
      const entries = await fs.readdir(d, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = path.join(d, entry.name)
        if (entry.isFile()) {
          const rank = candidates.indexOf(entry.name)
          if (rank >= 0 && rank < ref.rank) { ref.path = fullPath; ref.rank = rank }
        } else if (entry.isDirectory()) {
          await walk(fullPath)
        }
      }
    } catch { /* skip inaccessible dirs */ }
  }
  await walk(dir)
  return ref.rank === Infinity ? null : ref.path
}

export async function findScenePromptsFile(slug: string, episodeId: string): Promise<string> {
  const code = episodeId.toUpperCase()
  const outputRoot = await pm.getProjectOutputRoot(slug)
  if (!outputRoot) throw new Error('Project directory not found')

  // Prefer .md (current), then legacy .docx; new separate file before old combined.
  const candidates = [
    `${code}_Scene_Prompts.md`,
    `${code}_Scene_Prompts.docx`,
    `${code}_Image_Prompts.md`,
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

  // Prefer .md (current), then legacy .docx; new separate file before old combined.
  const candidates = [
    `${code}_Thumbnail_Prompts.md`,
    `${code}_Thumbnail_Prompts.docx`,
    `${code}_Image_Prompts.md`,
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

  // Level B (opt-in): if the project routes heavy media to an external root,
  // redirect the image/thumbnail dirs there. Non-split projects keep the
  // iCloud dirs resolved above (incl. the legacy-name fallbacks).
  const { mediaEpisodeBaseForCode } = await import('../services/media-root.js')
  const mediaBase = await mediaEpisodeBaseForCode(projectSlug, code)
  if (mediaBase) {
    const { resolveSubfolder } = await import('../lib/folder-resolver.js')
    bgDir = await resolveSubfolder(mediaBase, bgConfigName)
    thumbDir = await resolveSubfolder(mediaBase, thumbConfigName)
  }

  return { bgDir, thumbDir, episodeDir }
}

export async function generateImages(job: Job): Promise<void> {
  const { project_slug, episode_id, params } = job
  const req = params as GenerateImagesRequest

  // Phase-wide download metrics: aggregate bytes received across every
  // image we pull from the CDN. Many CDNs omit Content-Length so we skip
  // bytes_total — UI renders an indeterminate bar with a live speed.
  const tracker = new SpeedTracker()
  let cumulativeBytes = 0
  const writeProgress = throttle(() => {
    const { speedBps } = tracker.update(cumulativeBytes)
    job.bytes_done = cumulativeBytes
    job.speed_bps = speedBps
  }, 250)
  /** Returns a fresh per-asset onProgress callback that adds chunk deltas
   *  into the cumulative phase counter. Each downloadImage call gets its
   *  own closure so per-asset `received` resets to 0 cleanly. */
  const makeChunkCb = () => {
    let lastReceived = 0
    return (received: number, _total?: number) => {
      const delta = received - lastReceived
      if (delta > 0) {
        cumulativeBytes += delta
        lastReceived = received
        writeProgress()
      }
    }
  }

  const config = await pm.getConfig(project_slug)
  if (!config) throw new Error('Project config not found')
  const modelName = req.model || 'grok-imagine'
  // The key is resolved first because the model's capabilities now come from
  // the live GenStudio catalogue rather than a synthesised constant.
  const apiKey = await getApiKey('genstudio').catch(() => '')
  if (!apiKey) throw new Error('Add the GenStudio API key in Settings before generating images.')
  const modelConfig = await resolveImageModelConfig(config, modelName, apiKey)
  if (!modelConfig) throw new Error(`Unknown image model: ${modelName}`)
  const resolvedModelConfig: ImageModelConfig = modelConfig

  if (modelConfig.provider !== 'genstudio-image') {
    throw new Error(`Image model "${modelName}" is not routed through GenStudio KH.`)
  }
  const imageProvider = registry.getImageProvider('genstudio-image')
  if (!imageProvider) throw new Error('GenStudio KH image provider is unavailable.')

  // Full generation and both preview surfaces share the same tier resolver.
  // This ensures the selected resolution affects the provider payload as well
  // as the credit estimate.
  const providerParams = resolveImageProviderParams(modelConfig, req.tier)

  // Find the prompt file for the requested independent pool.
  const mode = req.mode
  if (mode !== 'scenes' && mode !== 'thumbs') {
    throw new Error('Image generation mode must be "scenes" or "thumbs"; merged all-mode generation is no longer supported.')
  }
  let scenePromptsPath: string | null = null
  let thumbPromptsPath: string | null = null

  if (mode === 'scenes') {
    scenePromptsPath = await findScenePromptsFile(project_slug, episode_id)
    job.output_lines.push(`Found scene prompts: ${path.basename(scenePromptsPath)}`)
  }
  if (mode === 'thumbs') {
    thumbPromptsPath = await findThumbPromptsFile(project_slug, episode_id)
    job.output_lines.push(`Found thumbnail prompts: ${path.basename(thumbPromptsPath)}`)
  }

  // Use whichever file we found to resolve image dirs
  const refPath = scenePromptsPath || thumbPromptsPath!
  const { bgDir, thumbDir, episodeDir: resolvedEpDir } = await resolveImageDirs(project_slug, refPath, episode_id)
  await fs.mkdir(bgDir, { recursive: true })
  await fs.mkdir(thumbDir, { recursive: true })

  // Reference-guided thumbnails use the durable project-owned original saved
  // by Thumbnail Prompts. The GenStudio provider uploads this file privately
  // immediately before dispatch; no local path ever crosses that boundary.
  const savedThumbnailReference = mode === 'thumbs'
    ? ((req as any).thumbnail_reference_asset || (config as any).thumbnail_reference_asset || null)
    : null
  const savedThumbnailReferencePath = savedThumbnailReference?.id && typeof savedThumbnailReference?.filename === 'string'
    ? path.join(pm.getProjectDir(project_slug) || path.join(pm.PROJECTS_ROOT, project_slug), 'thumbnail-reference-assets', savedThumbnailReference.filename)
    : ''
  const hasSavedThumbnailReference = !!savedThumbnailReferencePath && existsSync(savedThumbnailReferencePath)
  if (mode === 'thumbs' && savedThumbnailReference?.id && !hasSavedThumbnailReference) {
    throw new Error('The saved thumbnail reference is unavailable locally. Re-upload it in Thumbnail Prompts before generating.')
  }

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
  if (mode === 'scenes' && scenes.length === 0) throw new Error('The scene prompt file contains no usable scene prompts.')
  if (mode === 'thumbs' && thumbnails.length === 0) throw new Error('The thumbnail prompt file contains no usable thumbnail prompts.')

  // Phase 8 — load this episode's character cast once for reference-image
  // wiring. Auto-detect: scan each scene's prompt text for character names
  // and forward matching characters' reference images to the provider.
  // Models that don't declare supports_reference_images silently ignore
  // the field (text-only path, no overhead).
  const cast = await cm.listCharacters(project_slug, { episodeCode: episode_id })
    .catch(() => [] as Character[])
  const castWithRefs = cast.filter(c => c.references?.images?.length)
  // Phase 8b (2026-05-03) — characters can also carry persistent style
  // keywords ("cel-shaded", "photoreal", etc.) appended to any prompt
  // that mentions them. Separate set from `castWithRefs` because a
  // character can have keywords without uploading a reference image
  // (and vice versa). Both pools feed the same name-match function below.
  const castWithStyle = cast.filter(c => (c.references?.style_keywords?.length ?? 0) > 0)
  // What this model actually does with references, read from the catalogue
  // entry the resolver just carried through. The old text told every user
  // their model ignored references because the flag was a hardcoded `false`.
  const supportsReferences = modelConfig.supports_reference_images === true
  const maxReferences = modelConfig.max_reference_images ?? (supportsReferences ? 1 : 0)
  const minReferences = modelConfig.min_reference_images ?? 0
  if (minReferences > 0) {
    job.output_lines.push(
      `Model '${modelName}' publishes a ${minReferences}-reference minimum — renders without references will be refused before submission.`,
    )
  }
  if (castWithRefs.length) {
    const note = supportsReferences
      ? `model '${modelName}' will receive their references (up to ${maxReferences} per render as published by GenStudio)`
      : `model '${modelName}' publishes no reference-image support — they'll be ignored; pick a reference-capable model for reference-driven gen`
    job.output_lines.push(
      `Cast with reference images: ${castWithRefs.map(c => c.name).join(', ')} — ${note}`,
    )
  }
  if (castWithStyle.length) {
    job.output_lines.push(
      `Cast with style keywords: ${castWithStyle.map(c => `${c.name} (${(c.references!.style_keywords || []).join(', ')})`).join('; ')} — appended to prompts when these characters appear`,
    )
  }

  // v1.0.518 — art-style reference image. The project's active art style
  // (services/art-style-resolver.ts) can carry a rendered preview image; we
  // feed it as an img2img style reference so renders match the picked look.
  // Resolved once here; attached per-scene as the fifth reference source
  // below. Empty for text-only styles.
  const artStyle = await resolveProjectArtStyle(project_slug).catch(() => null)
  const artStyleRefPaths = (artStyle?.referenceImagePaths || []).filter(p => existsSync(p))

  /**
   * Auto-detect which characters appear in a scene by scanning the prompt
   * text for their names (delegated to findReferencedCharacters for the
   * pure boundary-matching logic). Returns absolute paths of every
   * reference image attached to matching characters. Empty array when no
   * names appear — provider call goes through text-only.
   */
  function resolveCharacterReferenceImages(promptText: string): string[] {
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

  // ── Image-to-image multi-source reference resolution ───────────────────
  //
  // When req.image_mode === 'img2img', the user has opted in to driving
  // image generation with reference images instead of text-only prompts.
  // Reference paths come from up to four configurable sources, all of
  // which stack additively (they're independent toggles in the UI):
  //
  //   1. Master ref:  one image at <episode_dir>/img2img-references/master.png
  //                   sent as a reference for every scene.
  //   2. Per-scene:   <episode_dir>/img2img-references/scene-NN.png — one
  //                   image per scene, overrides nothing else (stacks).
  //   3. Characters:  the same Phase 8 auto-detection that text2img uses
  //                   (always on in img2img mode by default; can be toggled
  //                   off via reference_sources.characters: false).
  //   4. Chain mode:  scene N's previously-rendered output (bgDir/{stem}_v1.png)
  //                   becomes a reference for scene N+1. Forces serial
  //                   execution since scene N+1 depends on scene N's render.
  //
  // The combined list is passed to imageProvider.generateImage's
  // referenceImagePaths; the provider silently ignores it for models that
  // don't declare supports_reference_images, so misconfigured (text-only)
  // models running in img2img mode just produce text2img output (the UI
  // already filters the model dropdown to img2img-capable models, but
  // we're defensive here in case the request comes from elsewhere).
  const imageMode = (req as any).image_mode === 'img2img' ? 'img2img' : 'text2img'
  const refSourcesRaw = (req as any).reference_sources || {}
  const refSources = {
    master: imageMode === 'img2img' && !!refSourcesRaw.master,
    per_scene: imageMode === 'img2img' && !!refSourcesRaw.per_scene,
    // Characters defaults to ON in img2img mode (matches the default the UI
    // toggles when the user enters img2img mode). text2img path is
    // unchanged — character refs are auto-attached as today.
    characters: imageMode === 'img2img' ? refSourcesRaw.characters !== false : true,
    chain: imageMode === 'img2img' && !!refSourcesRaw.chain,
    thumbnail: imageMode === 'img2img' && !!refSourcesRaw.thumbnail,
    // v1.0.518 — the project's art-style reference image (5th source).
    // Defaults ON in img2img mode when the active art style has a preview
    // image; can be toggled off via reference_sources.art_style: false.
    art_style: imageMode === 'img2img' && artStyleRefPaths.length > 0 && refSourcesRaw.art_style !== false,
  }
  if (imageMode === 'img2img' && refSources.art_style) {
    job.output_lines.push(
      `Art-style reference image attached (${artStyle?.name || artStyle?.source || 'active style'})` +
      (supportsReferences ? '' : ` — but model '${modelName}' publishes no reference support; style still applies via the prompt text`),
    )
  }
  const referenceStrength: ThumbnailReferenceStrength = (req.reference_strength === 'loose' || req.reference_strength === 'strong')
    ? req.reference_strength
    : 'balanced'

  function img2imgRefsDir(): string {
    return path.join(resolvedEpDir, 'img2img-references')
  }
  function masterRefPath(): string {
    return path.join(img2imgRefsDir(), 'master.png')
  }
  function thumbnailRefPath(): string {
    return path.join(img2imgRefsDir(), 'thumbnail.png')
  }
  function perSceneRefPath(n: number): string {
    return path.join(img2imgRefsDir(), `scene-${String(n).padStart(2, '0')}.png`)
  }
  function previousSceneRenderPath(n: number): string | null {
    if (n <= 1) return null
    const stem = `${episode_id.toUpperCase()}_Scene${(n - 1).toString().padStart(2, '0')}`
    return path.join(bgDir, `${stem}_v1.png`)
  }

  /** Resolve every reference image path for a scene given the configured
   *  sources. Stacks additively; missing files are silently skipped. */
  function resolveSceneReferenceImages(scene: { number: number; prompt: string }): string[] {
    const out: string[] = []
    if (refSources.master && existsSync(masterRefPath())) out.push(masterRefPath())
    if (refSources.per_scene && existsSync(perSceneRefPath(scene.number))) {
      out.push(perSceneRefPath(scene.number))
    }
    if (refSources.characters) out.push(...resolveCharacterReferenceImages(scene.prompt))
    if (refSources.chain) {
      const prev = previousSceneRenderPath(scene.number)
      if (prev && existsSync(prev)) out.push(prev)
    }
    // v1.0.518 — the project art-style reference image (already existence-
    // filtered) reinforces every scene/thumbnail render.
    if (refSources.art_style) out.push(...artStyleRefPaths)
    // De-dup in case the same image gets attached multiple ways.
    return Array.from(new Set(out))
  }

  /**
   * Phase 8b — collect every style keyword from characters whose names
   * appear in the prompt. De-duped + lowercase-trimmed so "Cel-shaded"
   * vs "cel-shaded" doesn't end up in the prompt twice. Returns [] when
   * no characters match or no characters have keywords. The caller
   * appends these to the prompt sent to the provider so the visual
   * style stays consistent across episodes when a character recurs.
   */
  function resolveSceneStyleKeywords(promptText: string): string[] {
    const matched = findReferencedCharacters(promptText, castWithStyle)
    if (!matched.length) return []
    const seen = new Set<string>()
    const out: string[] = []
    for (const c of matched) {
      for (const kw of (c.references!.style_keywords || [])) {
        const norm = kw.trim()
        if (!norm) continue
        const key = norm.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        out.push(norm)
      }
    }
    return out
  }

  /**
   * Append matched-character style keywords to a prompt. Keywords land
   * after the user's prompt as a `, kw1, kw2, kw3` clause — image-gen
   * models read trailing comma-separated keywords as style modifiers,
   * which is the format every kie.ai / fal model in our catalog expects.
   * Returns the original prompt unchanged when no keywords matched.
   */
  function applyStyleKeywords(promptText: string, keywords: string[]): string {
    if (!keywords.length) return promptText
    const trimmed = promptText.replace(/[\s,]+$/, '')
    return `${trimmed}, ${keywords.join(', ')}`
  }

  // Defaults from the model's published `default_aspect_ratio` and refuses a
  // ratio it does not publish, before any scene is submitted.
  const aspectRatio = resolveConfiguredAspectRatio(resolvedModelConfig, req.aspect_ratio)
  // v1.0.308 — explicit render dimensions for LOCAL models (Image Studio). The
  // Scene/Thumbnail Generator's Size control sends a downscaled width/height to
  // cut a local model's GPU/VAE memory + render time at lower resolution. The
  // imagestudio provider rounds these to /16 and uses them in place of the
  // aspect preset; cloud providers don't receive them (the UI omits them) and
  // fall back to the aspect string. Mirrors generators/scene-image.ts.
  const renderWidth = typeof req.width === 'number' && req.width > 0 ? req.width : undefined
  const renderHeight = typeof req.height === 'number' && req.height > 0 ? req.height : undefined
  const force = req.force || false
  const errors: string[] = []
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

  const providerId = (): string => imageProvider!.meta.providerId || imageProvider!.meta.id

  interface DurableImageAttempt {
    recovery: ImageRecoveryOutcome
    /** Token folded into the idempotency identity for a fresh submission. */
    scope: string
    inputHash: string
    submittedAt: string
    notes: string[]
  }

  /**
   * Decide, for ONE image asset, whether a saved GenStudio job can still be
   * reclaimed and — when it cannot — under which request identity a single
   * fresh job should be submitted.
   *
   * The identity is derived only from persisted values, so a lost submit
   * response replays the same idempotency key (GenStudio hands back the same
   * job) instead of paying for a second render.
   */
  async function prepareImageAttempt(
    dir: string,
    manifest: Manifest,
    filename: string,
    prompt: string,
  ): Promise<DurableImageAttempt> {
    const baseScope = force ? `force:${job.job_id}` : 'default'
    const entry = manifest.tasks[filename] || null
    let scope = resolveImageRetryScope(entry, baseScope).scope
    let inputHash = hashInput(`${scope}\n${prompt}`)
    const notes: string[] = []
    // A pre-scope manifest entry stays reclaimable on its task id alone, which
    // is exactly how this generator behaved before retry scopes existed. What
    // is new is that a job we already know settled is never reopened.
    const reclaimable = !force
      && entry
      && (entry.request_scope ? entry.input_hash === inputHash : true)
      && !isTerminalGenStudioImageTaskFailure(entry)
      ? entry
      : null
    const recovery = await tryRecoverImageFromManifestEntry(
      reclaimable,
      apiKey,
      resolvedModelConfig,
      () => jq.isCancelled(job.job_id),
    )
    let carried: TaskManifestEntry | null = entry
    if (recovery.kind === 'terminal-failed' || recovery.kind === 'artifact-unavailable') {
      // Persist the settled outcome first so the promoted retry scope stays
      // reproducible if this run dies before the fresh submission lands.
      carried = terminalImageManifestEntry(entry!, recovery)
      await recordTask(dir, filename, carried)
      scope = resolveImageRetryScope(carried, baseScope).scope
      inputHash = hashInput(`${scope}\n${prompt}`)
      notes.push(
        `saved GenStudio task ${recovery.taskId.slice(0, 12)}… is terminal ` +
        `(${recovery.kind === 'artifact-unavailable' ? 'artifact expired' : 'failed'}); ` +
        'submitting one fresh job under a new retry identity.',
      )
    }
    const submittedAt = carried?.request_scope === scope && carried.submitted_at
      ? carried.submitted_at
      : new Date().toISOString()
    return { recovery, scope, inputHash, submittedAt, notes }
  }

  async function recordImageState(
    dir: string,
    filename: string,
    attempt: DurableImageAttempt,
    state: string,
    taskId: string,
    idempotencyKey: string,
    strict = false,
  ): Promise<void> {
    const payload: TaskManifestEntry = {
      provider: providerId(),
      task_id: taskId,
      submitted_at: attempt.submittedAt,
      input_hash: attempt.inputHash,
      request_scope: attempt.scope,
      ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
      operation: 'image',
      last_state: state,
    }
    if (strict) await recordTaskStrict(dir, filename, payload)
    else await recordTask(dir, filename, payload)
  }

  function uncertainRecoveryError(recovery: ImageRecoveryOutcome & { kind: 'uncertain' }): Error {
    // Never let an unconfirmed outcome become a duplicate paid submission.
    return new Error(
      `Could not confirm GenStudio task ${recovery.taskId.slice(0, 12)}… (${recovery.reason}). ` +
      'No duplicate image was submitted; Retry reconnects to the same job.',
    )
  }

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
    // task-manifest sidecar has a stored task_id from a previous run. If the
    // provider still has the result (succeeded / still running), reclaim it for
    // free. A job GenStudio already settled as failed is NOT reclaimed — it can
    // only ever return the same failure — and an unconfirmed outcome fails this
    // one scene instead of turning into a duplicate paid submission. Everything
    // is inside the try so no single scene can abort the whole batch.
    const filename = `${stem}_v1.png`
    let attempt: DurableImageAttempt | null = null
    let acceptedTaskId = ''
    let acceptedKey = ''
    try {
      // Multi-source reference resolution. text2img mode → only character
      // refs (Phase 8 default); img2img mode → master + per-scene + chars
      // + chain depending on the user's reference_sources toggles.
      const styleKeywords = resolveSceneStyleKeywords(scene.prompt)
      const finalPrompt = applyStyleKeywords(scene.prompt, styleKeywords)
      // Every reference the user configured for this scene, forwarded only
      // when GenStudio publishes reference support for the selected model.
      // Before v1.0.788 this list was computed and then thrown away, so an
      // img2img scene run was silently billed as a text2img render.
      const sceneReferences = supportsReferences
        ? resolveSceneReferenceImages(scene).slice(0, Math.max(maxReferences, 0))
        : []
      if (sceneReferences.length) {
        job.output_lines.push(
          `Scene ${scene.number}: attaching ${sceneReferences.length} reference image(s) — ` +
          sceneReferences.map(p => path.basename(p)).join(', '),
        )
      } else if (!supportsReferences && imageMode === 'img2img') {
        job.output_lines.push(
          `Scene ${scene.number}: model '${modelName}' publishes no reference support — rendering from the prompt text only.`,
        )
      }
      attempt = await prepareImageAttempt(bgDir, sceneManifest, filename, finalPrompt)
      if (attempt.recovery.kind === 'uncertain') throw uncertainRecoveryError(attempt.recovery)
      for (const note of attempt.notes) job.output_lines.push(`Scene ${scene.number}: ${note}`)
      if (attempt.recovery.kind === 'recovered') {
        const recovered = attempt.recovery
        for (let i = 0; i < recovered.urls.length; i++) {
          await saveGenStudioImage(recovered.urls[i], path.join(bgDir, `${stem}_v${i + 1}.png`), makeChunkCb())
        }
        await recordImageState(bgDir, filename, attempt, 'succeeded', recovered.taskId, '')
        processed++
        job.output_lines.push(
          `Scene ${scene.number}/${totalToProcess}: ${scene.title} — recovered ` +
          `${recovered.urls.length} variant(s) from existing task ${recovered.taskId.slice(0, 12)}… (no charge)`,
        )
        return
      }
      // Persist the request identity BEFORE the charged POST so a lost response
      // replays the same idempotency key instead of creating a second job.
      await recordImageState(bgDir, filename, attempt, 'prepared', '', '', true)
      const result = await imageProvider!.generateImage({
        prompt: finalPrompt, apiKey, aspectRatio, modelId: resolvedModelConfig.api_model || modelName, providerParams,
        width: renderWidth, height: renderHeight,
        seed: req.seed,
        ...(sceneReferences.length ? { referenceImagePaths: sceneReferences } : {}),
        idempotencyIdentity: `${project_slug}:${episode_id}:scene:${scene.number}:image:${attempt.scope}`,
        isCancelled: () => jq.isCancelled(job.job_id),
        onJobAccepted: async (taskId, idempotencyKey) => {
          acceptedTaskId = taskId
          acceptedKey = idempotencyKey
          await recordImageState(bgDir, filename, attempt!, 'accepted', taskId, idempotencyKey, true)
        },
      })
      const urls = result.urls
      if (!urls.length) throw new Error(`${imageProvider!.meta.name} returned no image URL`)
      // Record the provider task id BEFORE downloading. Reasoning: even if
      // a download fails halfway, the manifest still points at the
      // (already-charged) provider job, so the Repair button can recover
      // the rest without billing the user a second time. Same record per
      // variant — the reconciler picks the right URL by parsing the _vN
      // suffix at recovery time.
      if (result.taskId) {
        await Promise.all(urls.map((_, i) => recordImageState(
          bgDir, `${stem}_v${i + 1}.png`, attempt!, 'succeeded', result.taskId!, acceptedKey,
        )))
      }
      for (let i = 0; i < urls.length; i++) {
        await saveGenStudioImage(urls[i], path.join(bgDir, `${stem}_v${i + 1}.png`), makeChunkCb())
      }
      processed++
      job.output_lines.push(`Scene ${scene.number}/${totalToProcess}: ${scene.title} — saved ${urls.length} variant(s)`)
    } catch (e: any) {
      // Remember a settled provider failure so the next Retry mints a fresh
      // identity instead of replaying this dead job forever.
      if (e instanceof GenStudioImageTerminalFailureError && attempt) {
        await recordImageState(bgDir, filename, attempt, 'failed', e.jobId || acceptedTaskId, acceptedKey)
      }
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
    // Auto-recovery (same as runScene above) — reclaim a previously-submitted
    // task before charging for a fresh submit, but never reopen a job GenStudio
    // already settled, and never treat an unconfirmed outcome as "nothing was
    // submitted". Inside the try so one thumbnail cannot abort the batch.
    const filename = `${stem}_v1.png`
    let attempt: DurableImageAttempt | null = null
    let acceptedTaskId = ''
    let acceptedKey = ''
    try {
      // The thumbnail prompt already carries its (format-aware) title-text
      // directive from image-prompts.ts — render it verbatim. Character
      // name-matching and style keywords operate on the same prompt.
      // For thumbnails, multi-source img2img refs use the same resolver
      // — master + chars stack additively. Per-scene refs use the thumb
      // number bucket, chain mode reads thumb N-1's render. Most users
      // will only set master + chars for thumbnails since chain
      // continuity matters less for a 1-shot title card.
      const styleKeywords = resolveSceneStyleKeywords(thumb.prompt)
      // v1.0.416 — optional render-time guidance from the generator tab,
      // appended before style keywords so it influences the image without
      // editing the stored prompt.
      const extra = (req.extra_details || '').trim()
      const hasThumbnailReference = hasSavedThumbnailReference || (refSources.thumbnail && existsSync(thumbnailRefPath()))
      const referenceGuidance = hasSavedThumbnailReference
        ? `Reference-guided generation: use the supplied reference only for broad composition, hierarchy, framing, and visual rhythm. Create a new original image for this episode. Do not reproduce logos, identifying text, branded elements, characters, or a near-identical copy of the reference. ${String(savedThumbnailReference?.reframing_prompt || '').trim()}`
        : hasThumbnailReference ? thumbnailReferenceGuidance(referenceStrength) : ''
      const renderGuidance = [extra, referenceGuidance].filter(Boolean).join('\n\n')
      const promptWithExtra = renderGuidance ? `${thumb.prompt}\n\n${renderGuidance}` : thumb.prompt
      const finalPrompt = applyStyleKeywords(promptWithExtra, styleKeywords)
      const strengthValue = thumbnailReferenceStrengthValue(referenceStrength)
      const thumbProviderParams = hasThumbnailReference
        ? { ...providerParams, image_strength: strengthValue }
        : providerParams
      attempt = await prepareImageAttempt(thumbDir, thumbManifest, filename, finalPrompt)
      if (attempt.recovery.kind === 'uncertain') throw uncertainRecoveryError(attempt.recovery)
      for (const note of attempt.notes) job.output_lines.push(`Thumbnail ${thumb.number}: ${note}`)
      if (attempt.recovery.kind === 'recovered') {
        const recovered = attempt.recovery
        for (let i = 0; i < recovered.urls.length; i++) {
          await saveGenStudioImage(recovered.urls[i], path.join(thumbDir, `${stem}_v${i + 1}.png`), makeChunkCb())
        }
        await recordImageState(thumbDir, filename, attempt, 'succeeded', recovered.taskId, '')
        processed++
        job.output_lines.push(
          `Thumbnail ${thumb.number}/${totalToProcess}: ${thumb.title} — recovered ` +
          `${recovered.urls.length} variant(s) from existing task ${recovered.taskId.slice(0, 12)}… (no charge)`,
        )
        return
      }
      await recordImageState(thumbDir, filename, attempt, 'prepared', '', '', true)
      const result = await imageProvider!.generateImage({
        prompt: finalPrompt, apiKey, aspectRatio, modelId: resolvedModelConfig.api_model || modelName, providerParams: thumbProviderParams,
        width: renderWidth, height: renderHeight,
        seed: req.seed,
        ...(hasSavedThumbnailReference ? { referenceImagePaths: [savedThumbnailReferencePath] } : {}),
        idempotencyIdentity: `${project_slug}:${episode_id}:thumbnail:${thumb.number}:image:${attempt.scope}`,
        isCancelled: () => jq.isCancelled(job.job_id),
        onJobAccepted: async (taskId, idempotencyKey) => {
          acceptedTaskId = taskId
          acceptedKey = idempotencyKey
          await recordImageState(thumbDir, filename, attempt!, 'accepted', taskId, idempotencyKey, true)
        },
      })
      const urls = result.urls
      if (!urls.length) throw new Error(`${imageProvider!.meta.name} returned no image URL`)
      if (result.taskId) {
        await Promise.all(urls.map((_, i) => recordImageState(
          thumbDir, `${stem}_v${i + 1}.png`, attempt!, 'succeeded', result.taskId!, acceptedKey,
        )))
      }
      for (let i = 0; i < urls.length; i++) {
        await saveGenStudioImage(urls[i], path.join(thumbDir, `${stem}_v${i + 1}.png`), makeChunkCb())
      }
      processed++
      job.output_lines.push(`Thumbnail ${thumb.number}/${totalToProcess}: ${thumb.title} — saved ${urls.length} variant(s)`)
    } catch (e: any) {
      if (e instanceof GenStudioImageTerminalFailureError && attempt) {
        await recordImageState(thumbDir, filename, attempt, 'failed', e.jobId || acceptedTaskId, acceptedKey)
      }
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
   */
  async function runPool<T>(items: T[], worker: (item: T) => Promise<void>) {
    const isCancelled = () => jq.isCancelled(job.job_id)
    let cursor = 0
    let active = 0
    let launched = 0
    let settled = false
    // Stage independent Story assets promptly. The shared GenStudio admission
    // pool applies the account's live paid concurrency; GenStudio owns its
    // durable queue, rate limits, relaxed capacity, and provider execution.
    const maxWorkers = resolveGenStudioLocalFanout(items.length)

    let resolveAll!: () => void
    const allWorkersDone = new Promise<void>(resolve => { resolveAll = resolve })
    const maybeFinish = () => {
      if (!settled && (isCancelled() || (cursor >= items.length && active === 0))) {
        settled = true
        resolveAll()
      }
    }

    async function next(): Promise<void> {
      while (cursor < items.length) {
        if (isCancelled()) return
        const i = cursor++
        await worker(items[i]!)
      }
    }

    const spawnWorker = () => {
      launched++
      active++
      void next().finally(() => {
        active--
        ensureWorkers()
        maybeFinish()
      })
    }

    const ensureWorkers = () => {
      if (cursor >= items.length || isCancelled()) return
      const want = Math.min(maxWorkers, items.length - cursor + active)
      while (active < want) spawnWorker()
    }

    ensureWorkers()
    maybeFinish()

    await allWorkersDone
  }

  // Scene images
  if (mode === 'scenes') {
    let filteredScenes = scenes
    if (req.scene_number) filteredScenes = filteredScenes.filter(s => s.number === req.scene_number)
    totalToProcess = filteredScenes.length
    processed = 0
    // Chain mode forces serial execution because scene N+1 reads scene
    // N's rendered output as one of its references. Pool would fire
    // them in parallel and the chain reference would be missing on
    // every scene whose prior scene hadn't finished yet. Sort by
    // chapter number to make the chain dependency well-defined.
    const useChain = imageMode === 'img2img' && refSources.chain
    if (useChain) {
      filteredScenes = [...filteredScenes].sort((a, b) => a.number - b.number)
      job.output_lines.push(
        `Generating ${filteredScenes.length} scene image(s) SERIALLY (chain mode — each scene's render seeds the next)…`,
      )
      for (const scene of filteredScenes) {
        if (jq.isCancelled(job.job_id)) break
        await runScene(scene)
      }
    } else {
      job.output_lines.push(
        `Staging ${filteredScenes.length} scene image request(s); GenStudio account admission is authoritative...`,
      )
      await runPool(filteredScenes, runScene)
    }
  }

  // Thumbnail images
  if (mode === 'thumbs') {
    let thumbs = thumbnails
    if (req.thumb_number) thumbs = thumbs.filter(t => t.number === req.thumb_number)
    totalToProcess = thumbs.length
    processed = 0
    job.output_lines.push(
      `Staging ${thumbs.length} thumbnail request(s); GenStudio account admission is authoritative...`,
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
  const expectedItems = mode === 'scenes'
    ? (req.scene_number ? scenes.filter(scene => scene.number === req.scene_number) : scenes)
      .map(scene => ({ label: `Scene ${scene.number}`, path: path.join(bgDir, `${episode_id.toUpperCase()}_Scene${scene.number.toString().padStart(2, '0')}_v1.png`) }))
    : (req.thumb_number ? thumbnails.filter(thumb => thumb.number === req.thumb_number) : thumbnails)
      .map(thumb => ({ label: `Thumbnail ${thumb.number}`, path: path.join(thumbDir, `${episode_id.toUpperCase()}_Thumb${thumb.number.toString().padStart(2, '0')}_v1.png`) }))
  const outputReady = await Promise.all(expectedItems.map(item => fileExistsWithContent(item.path)))
  const missing = expectedItems.filter((_, index) => !outputReady[index]).map(item => item.label)
  requireJobCompletion(job, {
    label: mode === 'scenes' ? 'Scene image generation' : 'Thumbnail generation',
    expected: expectedItems.length,
    completed: expectedItems.length - missing.length,
    missing,
    retry_hint: 'Existing images were kept. Retry generates or recovers only the missing files.',
  })
  job.output_lines.push('All images generated successfully')
  // When the user ran mixed mode (all), reveal the parent episode dir so
  // they can see both scene + thumbnail folders side-by-side. Otherwise
  // drop them straight into the specific folder that just got populated.
  job.output_dir = mode === 'scenes' ? bgDir : mode === 'thumbs' ? thumbDir : resolvedEpDir
}
