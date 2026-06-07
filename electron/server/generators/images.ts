/**
 * Image generator — port of generate_images.py.
 * Generates scene and thumbnail images via kie.ai API.
 */

import { existsSync } from 'fs'
import path from 'path'
import { parseImagePromptsDocx, type ParsedPrompts } from '../lib/docx-parser.js'
import { downloadImage } from '../lib/kie-client.js'
import { SpeedTracker, throttle } from '../lib/speed-tracker.js'
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

// NOTE (v1.0.224): the old `enhanceThumbnailPrompt` + hardcoded gold/glowing
// `THUMB_TEXT_STYLES` were removed. They force-appended a sleep-story title
// instruction to EVERY thumbnail at render time, overriding the user's picks
// and ignoring the format. The thumbnail prompt now arrives from
// generators/image-prompts.ts already carrying the correct (format-aware)
// title-text directive — or, in composite mode, intentionally text-free for
// the thumbnail composer. So the render path uses `thumb.prompt` verbatim.

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
  let modelConfig: ImageModelConfig = config.image_models[modelName]
  if (!modelConfig) {
    // v1.0.205+ — Image Studio models are surfaced dynamically from the
    // modal's live catalog (id = `imagestudio:<repo>`), so they don't live
    // in the persisted per-project catalog. Synthesize a minimal config so
    // they generate like any registered local model. The provider resolves
    // the repo + endpoint (txt2img/img2img/edit) from the id + capabilities.
    const { repoForModelId } = await import('../lib/imagestudio-client.js')
    const repo = repoForModelId(modelName)
    if (repo) {
      modelConfig = {
        label: repo, credits_per_image: 0, prompt_char_cap: 1000,
        endpoint: '', poll: '', type: 'local', api_model: repo,
        provider: 'imagestudio', supports_reference_images: true,
      } as any
    }
  }
  if (!modelConfig) throw new Error(`Unknown image model: ${modelName}`)

  // Resolve provider (backward-compat: infer 'kie' if provider field missing)
  const providerId = (modelConfig as any).provider || 'kie'
  const imageProvider = registry.getImageProvider(providerId)
  if (!imageProvider) throw new Error(`No image provider registered for: ${providerId}`)

  // Build the per-call provider params shape from the model config.
  // The fallback used to carry only endpoint/poll/type/api_model — which
  // meant `supports_reference_images`, `api_model_i2i`, `refs_field`, and
  // `aspect_field` silently dropped to undefined before reaching the
  // kie-client + the reference-support log line below. GPT Image 2 + the
  // Nano Banana family then reported "does NOT support references" for
  // months despite the type/defaults declaring them ref-capable. Carry
  // every provider-relevant field through verbatim so the wiring stays
  // honest end-to-end.
  const providerParams = (modelConfig as any).provider_params || {
    endpoint: modelConfig.endpoint,
    poll: modelConfig.poll,
    type: modelConfig.type,
    api_model: modelConfig.api_model,
    api_model_i2i: (modelConfig as any).api_model_i2i,
    refs_field: (modelConfig as any).refs_field,
    aspect_field: (modelConfig as any).aspect_field,
    supports_reference_images: modelConfig.supports_reference_images === true,
  }
  const apiKey = await resolveApiKeyForProvider(project_slug, imageProvider.meta, {
    model: modelName,
    jobId: job.job_id,
  })
  // v1.0.151+ — Image Studio is a local Pinokio modal; the "apiKey"
  // slot carries its Tailscale base URL. An empty value means the user
  // hasn't set it yet — the provider falls back to the discovered
  // tailnet default, which works for the user who set up the modal
  // and fails-fast with a friendly error otherwise. Skip the
  // no-key throw so the provider gets to attempt the default.
  if (!apiKey && providerId !== 'imagestudio') {
    throw new Error(`No API key configured for ${imageProvider.meta.name}. Add one in Settings → API Keys.`)
  }

  // Preflight: refuse immediately if the provider balance is clearly zero.
  // Fast fail-fast — much better UX than discovering the empty balance
  // after the first provider submit returns "insufficient credits".
  // Local modals (imagestudio) have no balance — skip the check.
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
  // Phase 8b (2026-05-03) — characters can also carry persistent style
  // keywords ("cel-shaded", "photoreal", etc.) appended to any prompt
  // that mentions them. Separate set from `castWithRefs` because a
  // character can have keywords without uploading a reference image
  // (and vice versa). Both pools feed the same name-match function below.
  const castWithStyle = cast.filter(c => (c.references?.style_keywords?.length ?? 0) > 0)
  if (castWithRefs.length) {
    const supports = providerParams?.supports_reference_images === true
    const note = supports
      ? `model '${modelName}' will receive their references`
      : `model '${modelName}' does NOT support references — they'll be ignored (use Flux Kontext or Nano Banana for reference-driven gen)`
    job.output_lines.push(
      `Cast with reference images: ${castWithRefs.map(c => c.name).join(', ')} — ${note}`,
    )
  }
  if (castWithStyle.length) {
    job.output_lines.push(
      `Cast with style keywords: ${castWithStyle.map(c => `${c.name} (${(c.references!.style_keywords || []).join(', ')})`).join('; ')} — appended to prompts when these characters appear`,
    )
  }

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
  }

  function img2imgRefsDir(): string {
    return path.join(resolvedEpDir, 'img2img-references')
  }
  function masterRefPath(): string {
    return path.join(img2imgRefsDir(), 'master.png')
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
    // De-dup in case the same character image gets attached multiple ways.
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

  const aspectRatio = req.aspect_ratio || '16:9'
  const force = req.force || false
  const errors: string[] = []
  // Concurrency: project config → request override → default 5. Clamp 1..10.
  // v1.0.154+ — local Pinokio modals (imagestudio) can only run one
  // MLX inference at a time on Apple Silicon. Firing 5 simultaneous
  // submits just queues 4 of them server-side AND burns 4 local poll
  // loops that race the same per-job timeout. Clamp to 1 so:
  //   - the modal queue depth stays at 1
  //   - each next submit waits for the previous one's poll to finish
  //   - the per-job timeout only has to cover actual inference time
  //     (~5 min) rather than queue wait time
  //   - deep batches (100-200 scenes) drain serially without false
  //     failures on jobs queued behind a dozen others
  // Cloud providers (kie.ai) keep the default 5 — their queue scales
  // horizontally and the per-second-rate-limit concern is the real cap.
  const configConcurrency = Number((config as any).image_concurrency) || 0
  const reqConcurrency = Number((req as any).concurrency) || 0
  const isLocalProvider = providerId === 'imagestudio'
  const baseConcurrency = Math.max(1, Math.min(10, reqConcurrency || configConcurrency || 5))
  // v1.0.306 — a local modal is serial PER MAC (one MLX inference at a time),
  // but the user may run a POOL of Macs. The old code hard-clamped local
  // concurrency to 1, so a fleet of 12 Macs still rendered one-at-a-time on a
  // single box — the "stall" the user saw. Probe the endpoints and parallelise
  // across the HEALTHY ones: each Mac still runs serially, but different Macs
  // run concurrently, and the provider's least-busy dispatcher spreads the work.
  // A single endpoint stays at concurrency 1, exactly as before.
  let concurrency = baseConcurrency
  if (isLocalProvider) {
    const { parseEndpoints, healthyEndpoints } = await import('../lib/endpoint-pool.js')
    const { health: imgHealth } = await import('../lib/imagestudio-client.js')
    const eps = parseEndpoints(apiKey)
    if (eps.length <= 1) {
      concurrency = 1
    } else {
      const { healthy, offline } = await healthyEndpoints(eps, async (u) => (await imgHealth(u, 4000)).ok)
      concurrency = Math.max(1, Math.min(baseConcurrency, healthy.length))
      job.output_lines.push(
        `Local modal pool: ${healthy.length}/${eps.length} endpoint(s) reachable — ` +
        `generating with concurrency=${concurrency} (each Mac runs one inference at a time, in parallel).` +
        (offline.length ? ` Skipped ${offline.length} unreachable endpoint(s).` : ''),
      )
    }
  }
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
          await downloadImage(recovered.urls[i], path.join(bgDir, `${stem}_v${i + 1}.png`), makeChunkCb())
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
      // Multi-source reference resolution. text2img mode → only character
      // refs (Phase 8 default); img2img mode → master + per-scene + chars
      // + chain depending on the user's reference_sources toggles.
      const referenceImagePaths = resolveSceneReferenceImages(scene)
      const styleKeywords = resolveSceneStyleKeywords(scene.prompt)
      const finalPrompt = applyStyleKeywords(scene.prompt, styleKeywords)
      const result = await imageProvider!.generateImage({
        prompt: finalPrompt, apiKey, aspectRatio, modelId: modelName, providerParams,
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
        await downloadImage(urls[i], path.join(bgDir, `${stem}_v${i + 1}.png`), makeChunkCb())
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
          await downloadImage(recovered.urls[i], path.join(thumbDir, `${stem}_v${i + 1}.png`), makeChunkCb())
        }
        processed++
        job.output_lines.push(
          `Thumbnail ${thumb.number}/${totalToProcess}: ${thumb.title} — recovered ` +
          `${recovered.urls.length} variant(s) from existing task ${recovered.taskId.slice(0, 12)}… (no charge)`,
        )
        return
      }
    }
    try {
      // The thumbnail prompt already carries its (format-aware) title-text
      // directive from image-prompts.ts — render it verbatim. Character
      // name-matching and style keywords operate on the same prompt.
      // For thumbnails, multi-source img2img refs use the same resolver
      // — master + chars stack additively. Per-scene refs use the thumb
      // number bucket, chain mode reads thumb N-1's render. Most users
      // will only set master + chars for thumbnails since chain
      // continuity matters less for a 1-shot title card.
      const referenceImagePaths = resolveSceneReferenceImages({
        number: thumb.number, prompt: thumb.prompt,
      })
      const styleKeywords = resolveSceneStyleKeywords(thumb.prompt)
      const finalPrompt = applyStyleKeywords(thumb.prompt, styleKeywords)
      const result = await imageProvider!.generateImage({
        prompt: finalPrompt, apiKey, aspectRatio, modelId: modelName, providerParams,
        referenceImagePaths: referenceImagePaths.length ? referenceImagePaths : undefined,
        isCancelled: () => jq.isCancelled(job.job_id),
      })
      const urls = result.urls
      if (result.taskId) {
        await Promise.all(urls.map((_, i) => recordTask(thumbDir, `${stem}_v${i + 1}.png`, {
          provider: imageProvider!.meta.providerId || imageProvider!.meta.id,
          task_id: result.taskId!,
          submitted_at: new Date().toISOString(),
          input_hash: hashInput(thumb.prompt),
        })))
      }
      for (let i = 0; i < urls.length; i++) {
        await downloadImage(urls[i], path.join(thumbDir, `${stem}_v${i + 1}.png`), makeChunkCb())
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
        `Generating ${filteredScenes.length} scene image(s) with concurrency=${concurrency}` +
        (launchStaggerMs > 0 ? `, launch stagger ${launchStaggerMs}ms` : '') +
        '...',
      )
      await runPool(filteredScenes, runScene)
    }
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
