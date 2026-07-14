/**
 * Sequential continuity renderer for the continuity-chain pipeline (v1.0.194+).
 *
 * Renders EVERY scene in scene_plan.json in order, one at a time, each one
 * img2img-anchored to references chosen on the Character Sheet page
 * (continuity.json):
 *   - scene 1 (establishing): the character sheet + anchor characters only.
 *   - scene N: the PREVIOUS scene's render (continuity) + the sheet + anchor
 *     characters, per the per-toggle reference_sources.
 *
 * This is ONE long serial job (the chain forces serial — scene N depends on
 * scene N-1's render). It's resumable: scenes whose image already exists on
 * disk are skipped (their render still seeds the next scene), so a crashed or
 * cancelled run continues where it left off. Re-rendering everything is opt-in
 * via `force`.
 *
 * Writes <episode_dir>/scene_images/<scene_id>.png + the scene's image_path
 * back into scene_plan.json (resetting approval), exactly like the per-scene
 * generator — so Scene Review + unified Video Assembly pick the images up unchanged.
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { registry } from '../providers/registry.js'
import { resolveApiKeyForProvider } from '../providers/registry.js'
import { downloadImage } from '../lib/kie-client.js'
import { parseEndpoints, parseEnabledEndpoints, healthyEndpoints, createDispatcher, runOnPool, isConnectionError, type Dispatcher } from '../lib/endpoint-pool.js'
import { getHubBackend } from '../lib/studiohub-client.js'
import { renderImageBatchViaHub } from '../providers/image/imagestudio.js'
import type { ImageGenerationRequest } from '../providers/types.js'
import { resolveEpisodePathsByCode, resolveScenePlanPath } from '../services/utils.js'
import * as pm from '../services/project-manager.js'
import * as jq from '../services/job-queue.js'
import { recordTask, hashInput } from '../services/task-manifest.js'
import { getCharacter, referenceImagePath } from '../services/character-manager.js'
import { SCENE_IMAGES_SUBFOLDER, resolveSceneImagesDir } from './scene-image.js'
import type { Job, ImageModelConfig, ScenePlan, ScenePlanEntry } from '../models/types.js'
import { assertScenePromptsRenderable } from '../services/scene-prompt-integrity.js'
import { assertSubtitleTimelineComplete } from '../services/scene-timeline-integrity.js'
import { requireJobCompletion } from '../services/job-completion.js'

interface ContinuityRenderParams {
  episode_id: string
  title?: string
  model: string
  aspect_ratio?: string
  /** Re-render scenes that already have an image on disk (default: false —
   *  skip them so a cancelled/crashed run resumes). */
  force?: boolean
  /** Re-render from this scene onward (its scene_index and all later scenes),
   *  re-chaining downstream after a single-scene re-roll. Earlier scenes are
   *  kept and their renders seed the chain. */
  from_scene_id?: string
  /** v1.0.232 — render ONLY this one scene (with the full reference stack:
   *  sheet + style + characters + the previous scene's render). The rest of
   *  the chain is left untouched. Powers the per-scene "Generate with refs". */
  single_scene_id?: string
  /** v1.0.344 — render an explicit SET of scenes in ONE parallel job (Scene
   *  Review's "Regenerate selected ⚡" / "all unapproved ⚡"). Forces independent
   *  mode and renders exactly these ids (existing images included), distributing
   *  them across the whole Mac pool instead of N serial single-scene jobs. */
  scene_ids?: string[]
  /** v1.0.241 — INDEPENDENT / PARALLEL mode. Render each scene against the
   *  static references only (character sheet + style + anchor characters) and
   *  DROP the previous-render reference, so scenes no longer depend on one
   *  another and can be rendered concurrently through a bounded pool. Much
   *  faster; trades frame-to-frame continuity for speed + parallelism. The
   *  sequential chain remains the default. */
  independent?: boolean
  /** Max concurrent provider calls in independent mode (clamped 1–8, default 3). */
  concurrency?: number | 'auto'
  /** v1.0.254 — PROMPT-ONLY (text-to-image): send NO reference images at all
   *  (no sheet / style / characters / prev-render), rendering each scene from
   *  its composed text prompt alone. Cheaper + faster (no img2img), and lets
   *  any text2img model render a continuity-chain episode. Consistency then
   *  rides entirely on the prompt (detail level + Style Bible + character
   *  text), so dial those in. */
  prompt_only?: boolean
  /** v1.0.261 — explicit output pixel size (local Image Studio models only).
   *  When set, overrides the aspect-ratio preset so the user can render at a
   *  smaller resolution — far less VAE/GPU memory (fewer OOM crashes) + faster.
   *  Cloud providers ignore these. */
  width?: number
  height?: number
  /** v1.0.381 — local Image Studio render scale as a PERCENT of the aspect
   *  preset (100 = full). Used by the Pipeline batch path, which carries the
   *  Scene Review preset's `render_scale` instead of explicit px. Resolved to
   *  width/height here when explicit px aren't supplied. Cloud providers ignore. */
  render_scale?: number
}

interface ContinuityCfg {
  anchor_character_ids: string[]
  use_episode_sheet: boolean
  references: { prev_render: boolean; sheet: boolean; characters: boolean; style: boolean; composition: boolean }
  denoise_strength: number
  /** v1.0.243 — render-time style text appended to every scene's prompt. */
  style_bible: string
  /** v1.0.243 — negative prompt forwarded where the provider supports it. */
  negative_prompt: string
}
function defaultCfg(): ContinuityCfg {
  return {
    anchor_character_ids: [],
    use_episode_sheet: false,
    references: { prev_render: true, sheet: true, characters: true, style: false, composition: false },
    denoise_strength: 0.5,
    style_bible: '',
    negative_prompt: '',
  }
}

/** v1.0.233 — live render-status sidecar. The renderer writes the current
 *  scene + the exact reference images it's feeding into the model before each
 *  render; Scene Review reads it to show a "Now rendering" preview panel. */
export const RENDER_STATUS_FILENAME = '.render_status.json'

// v1.0.341 — how often the parallel renderer re-probes the local Image Studio
// pool to absorb Macs that came online (or recovered) mid-render. Picked to be
// responsive without hammering the health endpoints.
const POOL_REPROBE_MS = 20_000

export async function runContinuityRenderJob(job: Job): Promise<void> {
  const params = job.params as ContinuityRenderParams
  const { episode_id, model } = params
  if (!episode_id) throw new Error('episode_id is required')
  if (!model) throw new Error('model is required')

  const paths = await resolveEpisodePathsByCode(job.project_slug, episode_id)
  const planPath = await resolveScenePlanPath(job.project_slug, episode_id, paths.episode_dir)
  if (!existsSync(planPath)) {
    throw new Error(`No scene_plan.json at ${planPath}. Run Scene Plan first.`)
  }
  const plan = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
  await assertSubtitleTimelineComplete(paths.subtitles_dir, episode_id)
  const requestedIds = params.scene_ids?.length
    ? params.scene_ids
    : (params.single_scene_id ? [params.single_scene_id] : undefined)
  assertScenePromptsRenderable(plan.scenes, requestedIds)
  const scenes = [...plan.scenes].sort((a, b) => a.scene_index - b.scene_index)
  if (!scenes.length) throw new Error('scene_plan.json has no scenes.')

  // Continuity config (anchors, reference toggles, denoise). Defaults when the
  // Character Sheet hasn't been saved yet.
  let cfg = defaultCfg()
  const continuityPath = path.join(paths.episode_dir, 'continuity.json')
  if (existsSync(continuityPath)) {
    try {
      const raw = JSON.parse(await fs.readFile(continuityPath, 'utf-8'))
      cfg = {
        anchor_character_ids: Array.isArray(raw?.anchor_character_ids) ? raw.anchor_character_ids : [],
        use_episode_sheet: !!raw?.use_episode_sheet,
        references: {
          prev_render: raw?.references?.prev_render !== false,
          sheet: raw?.references?.sheet !== false,
          characters: raw?.references?.characters !== false,
          style: raw?.references?.style === true,
          composition: raw?.references?.composition === true,
        },
        denoise_strength: Number.isFinite(Number(raw?.denoise_strength)) ? Number(raw.denoise_strength) : 0.5,
        style_bible: typeof raw?.style_bible === 'string' ? raw.style_bible.trim() : '',
        negative_prompt: typeof raw?.negative_prompt === 'string' ? raw.negative_prompt.trim() : '',
      }
    } catch { /* keep defaults */ }
  }

  // Resolve model + provider (mirrors the per-scene generator).
  const config = await pm.getConfig(job.project_slug)
  if (!config) throw new Error('Project config not found')
  let modelConfig: ImageModelConfig | undefined = config.image_models?.[model]
  if (!modelConfig) {
    // v1.0.258 — local Image Studio models come from the modal's LIVE catalog
    // (id = `imagestudio:<repo>`) and aren't persisted in config.image_models,
    // so the lookup misses. Synthesize a minimal config (mirrors images.ts) so
    // continuity render works with local models too. The provider resolves the
    // repo + txt2img/img2img/edit endpoint from the id + capabilities.
    const { repoForModelId } = await import('../lib/imagestudio-client.js')
    const repo = repoForModelId(model)
    if (repo) {
      modelConfig = {
        label: repo, credits_per_image: 0, prompt_char_cap: 1000,
        endpoint: '', poll: '', type: 'local', api_model: repo,
        provider: 'imagestudio', supports_reference_images: true,
      } as any
    }
  }
  if (!modelConfig) throw new Error(`Unknown image model: ${model}`)
  const providerId = (modelConfig as any).provider || 'kie'
  const imageProvider = registry.getImageProvider(providerId)
  if (!imageProvider) throw new Error(`No image provider registered for: ${providerId}`)

  // v1.0.232 — forward the FULL provider-params set (mirrors generators/images.ts).
  // The previous shape dropped api_model_i2i / refs_field / supports_reference_images,
  // so the kie provider never switched to the image-to-image endpoint — every
  // continuity scene rendered text-to-image and SILENTLY IGNORED the references
  // (character sheet, style, previous render). That's why kie.ai history showed
  // gpt-image-2-text-to-image instead of -image-to-image.
  const providerParams = (modelConfig as any).provider_params || {
    endpoint: modelConfig.endpoint,
    poll: modelConfig.poll,
    type: modelConfig.type,
    api_model: modelConfig.api_model,
    api_model_i2i: (modelConfig as any).api_model_i2i,
    refs_field: (modelConfig as any).refs_field,
    refs_upload: (modelConfig as any).refs_upload === true,
    aspect_field: (modelConfig as any).aspect_field,
    supports_reference_images: modelConfig.supports_reference_images === true,
  }
  // Forward the denoise/strength for providers that read it (best-effort —
  // most current providers don't expose an explicit img2img strength, so the
  // continuity itself comes from the reference images, not this value).
  ;(providerParams as any).denoise_strength = cfg.denoise_strength
  // v1.0.243 — forward the negative prompt. Providers that support it (local
  // ImageStudio) read providerParams.negative_prompt; cloud providers ignore it.
  if (cfg.negative_prompt) (providerParams as any).negative_prompt = cfg.negative_prompt

  const apiKey = await resolveApiKeyForProvider(job.project_slug, imageProvider.meta, { model, jobId: job.job_id })
  if (!apiKey && providerId !== 'imagestudio') {
    throw new Error(`No API key configured for ${imageProvider.meta.name}. Add one in Settings → This Mac → API Keys.`)
  }

  // v1.0.255 — health-checked multi-endpoint pool for local Image Studio (run
  // images across several Macs). Build a least-busy dispatcher over the ONLINE
  // endpoints; an offline Mac is skipped, one that drops mid-batch fails over.
  // Cloud providers keep their single real key (no pool).
  let dispatcher: Dispatcher | null = null
  if (providerId === 'imagestudio') {
    // v1.0.437 — only build the pool over USER-ENABLED endpoints (drops Macs
    // switched off in Settings); enabled-but-offline ones still rejoin via the
    // re-probe below when they come online.
    const eps = parseEnabledEndpoints(apiKey)
    if (eps.length > 1) {
      const { health: imgHealth } = await import('../lib/imagestudio-client.js')
      const { healthy, offline } = await healthyEndpoints(eps, async (u) => (await imgHealth(u)).ok)
      // v1.0.341 — build the pool over ALL configured endpoints (not just the
      // online-at-start snapshot) and pre-mark the offline ones DOWN. The 30s
      // self-healing TTL + the periodic re-probe below then bring a Mac that
      // boots (or recovers) mid-render back into rotation — instead of it
      // sitting idle for the whole job because it missed the start probe.
      dispatcher = createDispatcher(eps)
      for (const u of offline) dispatcher.markDown(u)
      job.output_lines.push(
        `Image Studio pool: ${healthy.length}/${eps.length} online` +
        (offline.length ? ` (offline: ${offline.join(', ')} — will auto-join within ~${Math.round(POOL_REPROBE_MS / 1000)}s of coming online)` : '') +
        ` — distributing least-busy; machines that come online mid-render are picked up automatically.`,
      )
    }
  }

  // v1.0.254 — prompt-only (text2img): drop ALL reference images.
  const promptOnly = params.prompt_only === true
  if (promptOnly) job.output_lines.push('Prompt-only mode — no reference images sent (text-to-image).')
  if ((providerParams as any).supports_reference_images !== true) {
    job.output_lines.push(
      `⚠ Model "${model}" doesn't declare reference-image support — scenes will render prompt-only and won't visually chain. Pick a reference-capable model (e.g. Flux Kontext, Nano Banana) for true continuity.`,
    )
  }

  // v1.0.233 — each reference carries a frontend-resolvable URL + label so the
  // Scene Review "Now rendering" panel can show exactly what's being fed in.
  const slug = job.project_slug
  const sheetUrl = `/api/projects/${slug}/episodes/${episode_id}/img2img-references/file/master.png`
  const styleUrl = `/api/projects/${slug}/episodes/${episode_id}/img2img-references/file/style.png`
  const compositionUrl = `/api/projects/${slug}/episodes/${episode_id}/img2img-references/file/composition.png`
  const charRefUrl = (id: string, fn: string) =>
    `/api/projects/${slug}/characters/${id}/reference-image/${encodeURIComponent(fn)}`
  const sceneImgUrl = (sceneId: string) =>
    `/api/projects/${slug}/scene-review/${episode_id}/image/${sceneId}`

  // Pre-resolve the static references (sheet + style + characters) once.
  const sheetPath = path.join(paths.episode_dir, 'img2img-references', 'master.png')
  const useSheet = cfg.references.sheet && cfg.use_episode_sheet && existsSync(sheetPath)
  // v1.0.229 — optional style reference: the look/palette every scene matches.
  const stylePath = path.join(paths.episode_dir, 'img2img-references', 'style.png')
  const useStyle = cfg.references.style && existsSync(stylePath)
  // v1.0.260 — optional composition template: the explainer LAYOUT (subject
  // framed centrepiece + guide character at the side) every scene is structured
  // against. Pushed FIRST in the reference stack so it dominates the layout.
  const compositionPath = path.join(paths.episode_dir, 'img2img-references', 'composition.png')
  const useComposition = cfg.references.composition && existsSync(compositionPath)

  const characterRefs: Array<{ abs: string; url: string; label: string }> = []
  // v1.0.243 — anchor character TEXT descriptors, gathered alongside the image
  // references. Reinforces identity in the prompt (helps text-weighted models
  // and the no-reference text2img fallback), not just via the image.
  const characterDescs: Array<{ name: string; description: string }> = []
  if (cfg.references.characters) {
    for (const id of cfg.anchor_character_ids) {
      try {
        const ch = await getCharacter(job.project_slug, id)
        const name = (ch as any)?.name || id
        const desc = typeof (ch as any)?.description === 'string' ? (ch as any).description.trim() : ''
        if (desc) characterDescs.push({ name, description: desc })
        for (const fn of ch?.references?.images || []) {
          const abs = referenceImagePath(job.project_slug, id, fn)
          if (existsSync(abs)) characterRefs.push({ abs, url: charRefUrl(id, fn), label: `Character: ${name}` })
        }
      } catch { /* skip a missing/corrupt character */ }
    }
  }
  const characterRefPaths = characterRefs.map(c => c.abs)

  // v1.0.243 — compose the final render prompt: [scene action/setting from the
  // planner] + [anchor character descriptors] + [Style Bible]. Sections are
  // omitted when empty, so a project with none of the extras renders exactly
  // the bare visual_prompt as before.
  const charText = characterDescs.length
    ? characterDescs.map(c => `${c.name}: ${c.description}`).join('; ')
    : ''
  const styleBible = cfg.style_bible?.trim() || ''
  // v1.0.336 — non-character scenes (event / map / artifact / environment) drop
  // the guide's descriptor text so the prompt describes ONLY the subject. Plans
  // with no scene_type behave as before (the guide everywhere).
  const isCharacterScene = (s: ScenePlanEntry): boolean => !s.scene_type || s.scene_type === 'character'
  const NONCHARACTER_NEGATIVE = 'person, people, child, boy, kid, human figure, character, portrait'
  const composePrompt = (visualPrompt: string, includeCharacter = true): string => {
    const parts = [visualPrompt.trim()]
    if (includeCharacter && charText) parts.push(`Character details — ${charText}.`)
    if (styleBible) parts.push(`Style: ${styleBible}`)
    return parts.join('\n\n')
  }
  if (charText || styleBible || cfg.negative_prompt) {
    job.output_lines.push(
      `Prompt layer: ${[charText && 'character text', styleBible && 'style bible', cfg.negative_prompt && 'negative prompt'].filter(Boolean).join(' + ')}.`,
    )
  }

  // v1.0.457 — unified scene-image location (named "NN Scene Images" folder),
  // shared with the Scene Generator + media-root-aware.
  const outDir = await resolveSceneImagesDir(job.project_slug, episode_id.toUpperCase(), paths.episode_dir)
  await fs.mkdir(outDir, { recursive: true })

  // v1.0.457 — resume/skip-existing must also see the LEGACY flat scene_images/
  // folder, so an episode that hasn't been consolidated yet isn't needlessly
  // re-rendered from scratch (it already has its images, just in the old place).
  const legacySceneDir = path.join(paths.episode_dir, SCENE_IMAGES_SUBFOLDER)
  const hasRenderedImage = (id: string): boolean =>
    existsSync(path.join(outDir, `${id}.png`)) || existsSync(path.join(legacySceneDir, `${id}.png`))

  const aspectRatio = params.aspect_ratio || '16:9'
  // v1.0.261 — explicit render size (local Image Studio only). When provided,
  // the imagestudio provider renders at this resolution instead of the aspect
  // preset; cloud providers ignore it. Smaller = far less GPU memory + faster.
  let renderWidth = typeof params.width === 'number' && params.width > 0 ? params.width : undefined
  let renderHeight = typeof params.height === 'number' && params.height > 0 ? params.height : undefined
  // v1.0.381 — when explicit px weren't supplied but a render_scale PERCENT was
  // (the Pipeline batch carries the preset's scale, not pixels), derive the size
  // from the aspect preset × scale — but only for local Image Studio, since
  // cloud providers render from the aspect ratio and ignore px. Matches the
  // Scene Review page's size picker exactly (shared dimsForAspectScale).
  if ((renderWidth === undefined || renderHeight === undefined) && providerId === 'imagestudio'
      && typeof params.render_scale === 'number' && params.render_scale > 0) {
    const { dimsForAspectScale } = await import('../providers/image/imagestudio.js')
    const dims = dimsForAspectScale(aspectRatio, params.render_scale)
    renderWidth = dims.width
    renderHeight = dims.height
  }
  if (renderWidth && renderHeight) {
    job.output_lines.push(`Render size: ${renderWidth}×${renderHeight} (local models; cloud uses ${aspectRatio}).`)
  }
  const force = params.force === true
  // v1.0.344 — an explicit scene selection always renders in parallel.
  const sceneIdSet = Array.isArray(params.scene_ids) && params.scene_ids.length
    ? new Set(params.scene_ids)
    : null
  // v1.0.241 — independent / parallel mode: drop the prev-render reference so
  // scenes are mutually independent and can render concurrently.
  const independent = params.independent === true || sceneIdSet !== null
  // v1.0.256 — 'auto' concurrency matches the number of ONLINE endpoints (one
  // worker per Mac); falls back to 1 for a single local modal, 3 for cloud.
  // v1.0.391 — ceiling raised 8→50 for large local Image Studio pools.
  const concurrency = params.concurrency === 'auto'
    ? Math.max(1, Math.min(50, dispatcher ? dispatcher.liveCount() : (providerId === 'imagestudio' ? 1 : 3)))
    : Math.max(1, Math.min(50, Math.floor(Number(params.concurrency) || 3)))
  if (params.concurrency === 'auto') {
    job.output_lines.push(`Auto concurrency → ×${concurrency} (matched to online server${concurrency === 1 ? '' : 's'}).`)
  }
  // Re-render from a given scene onward (a single-scene re-roll re-chains the
  // downstream scenes that referenced the old render). 0 = not a from-render.
  let fromIndex = 0
  if (params.from_scene_id) {
    const fromScene = scenes.find(s => s.id === params.from_scene_id)
    if (fromScene) fromIndex = fromScene.scene_index
  }
  // v1.0.232 — render exactly ONE scene (with the full reference stack). Earlier
  // scenes' existing renders still seed prev_render as the loop passes them.
  let singleIndex = 0
  if (params.single_scene_id) {
    const one = scenes.find(s => s.id === params.single_scene_id)
    if (one) singleIndex = one.scene_index
    else throw new Error(`single_scene_id ${params.single_scene_id} not found in scene_plan.json`)
  }
  const mode = singleIndex > 0 ? `single scene ${singleIndex}` : force ? 'force re-render' : fromIndex > 0 ? `from scene ${fromIndex}` : 'resume (skip existing)'

  let rendered = 0
  let skipped = 0
  const failedSceneIds: string[] = []

  // Live status sidecar — written before each render, cleared when the job ends.
  // Serialise writes through a tiny promise chain so concurrent workers in
  // independent mode never interleave partial JSON on disk.
  const statusPath = path.join(paths.episode_dir, RENDER_STATUS_FILENAME)
  let statusChain: Promise<void> = Promise.resolve()
  const writeStatus = (s: Record<string, unknown>): Promise<void> => {
    statusChain = statusChain.then(async () => {
      try { await fs.writeFile(statusPath, JSON.stringify(s, null, 2), 'utf-8') } catch { /* best-effort */ }
    })
    return statusChain
  }

  // Persist a rendered image_path back to scene_plan.json. Serialised through a
  // promise chain (re-reading fresh each time) so concurrent independent-mode
  // workers can't clobber each other's writes to the shared plan file.
  let planChain: Promise<void> = Promise.resolve()
  const persistImagePath = (sceneId: string, outPath: string, renderedPrompt: string): Promise<void> => {
    planChain = planChain.then(async () => {
      try {
        const fresh = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
        const target = fresh.scenes.find(s => s.id === sceneId)
        if (target) {
          target.image_path = outPath
          // v1.0.359 — stamp the prompt this image was rendered from so Scene
          // Review can flag the image as stale if visual_prompt later changes.
          target.rendered_prompt = renderedPrompt
          target.image_version = new Date().toISOString()
          target.motion_choice = 'pending'
          target.approved = false   // user re-approves after a render
          await fs.writeFile(planPath, JSON.stringify(fresh, null, 2), 'utf-8')
        }
      } catch { /* best-effort — the PNG on disk is what Scene Review reads */ }
    })
    return planChain
  }

  // v1.0.336 — per-scene reference stack. Character scenes get the full anchor
  // stack (composition + sheet + character refs + optional prev-render + style).
  // Non-character scenes DROP the character-bearing refs (sheet / characters /
  // prev-render) so the guide isn't img2img'd into them — they keep composition
  // + style and add a "no people" negative. `prevCharRender` is the previous
  // CHARACTER scene's render (null in parallel mode); only character scenes use
  // it, so the guide's continuity survives the non-character cutaways between.
  const buildSceneRefs = (
    scene: ScenePlanEntry,
    prevCharRender: { path: string; id: string; index: number } | null,
  ): {
    refPaths: string[]
    descs: Array<{ kind: string; label: string; url: string }>
    params: typeof providerParams
    includeCharacter: boolean
  } => {
    const isChar = isCharacterScene(scene)
    const refs: string[] = []
    const descs: Array<{ kind: string; label: string; url: string }> = []
    if (useComposition) { refs.push(compositionPath); descs.push({ kind: 'composition', label: 'Composition template', url: compositionUrl }) }
    if (isChar) {
      if (useSheet) { refs.push(sheetPath); descs.push({ kind: 'sheet', label: 'Character sheet', url: sheetUrl }) }
      if (cfg.references.characters) {
        for (const c of characterRefs) { refs.push(c.abs); descs.push({ kind: 'character', label: c.label, url: c.url }) }
      }
      if (cfg.references.prev_render && prevCharRender && existsSync(prevCharRender.path)) {
        refs.push(prevCharRender.path)
        descs.push({ kind: 'prev', label: `Previous render (scene ${prevCharRender.index})`, url: sceneImgUrl(prevCharRender.id) })
      }
    }
    if (useStyle) { refs.push(stylePath); descs.push({ kind: 'style', label: 'Style reference', url: styleUrl }) }
    const refPaths = promptOnly ? [] : Array.from(new Set(refs))
    const params = isChar
      ? providerParams
      : { ...providerParams, negative_prompt: [(providerParams as any).negative_prompt, NONCHARACTER_NEGATIVE].filter(Boolean).join(', ') }
    return { refPaths, descs, params, includeCharacter: isChar }
  }

  // ── INDEPENDENT / PARALLEL mode ─────────────────────────────────────
  // Each scene renders against the static references only (sheet + style +
  // characters); NO previous-render reference, so scenes don't chain and a
  // bounded pool can run several at once. Far faster than the serial chain.
  if (independent) {
    // The shared reference stack — identical for every scene (no prev_render).
    const sharedRefs: string[] = []
    const sharedRefDescs: Array<{ kind: string; label: string; url: string }> = []
    if (useComposition) { sharedRefs.push(compositionPath); sharedRefDescs.push({ kind: 'composition', label: 'Composition template', url: compositionUrl }) }
    if (useSheet) { sharedRefs.push(sheetPath); sharedRefDescs.push({ kind: 'sheet', label: 'Character sheet', url: sheetUrl }) }
    if (cfg.references.characters) {
      for (const c of characterRefs) { sharedRefs.push(c.abs); sharedRefDescs.push({ kind: 'character', label: c.label, url: c.url }) }
    }
    if (useStyle) { sharedRefs.push(stylePath); sharedRefDescs.push({ kind: 'style', label: 'Style reference', url: styleUrl }) }
    // v1.0.254 — prompt-only drops every reference image (pure text2img).
    const sharedRefPaths = promptOnly ? [] : Array.from(new Set(sharedRefs))
    const endpoint = (sharedRefPaths.length && (providerParams as any).supports_reference_images === true)
      ? 'image-to-image' : 'text-to-image'

    // Which scenes to render: explicit selection → exactly those; single → that
    // one; force → all; from → index≥; resume → missing.
    const toRender = scenes.filter(scene => {
      if (!scene.visual_prompt?.trim()) return false
      if (sceneIdSet) return sceneIdSet.has(scene.id)   // selection re-renders the chosen scenes
      return singleIndex > 0
        ? scene.scene_index === singleIndex
        : force
          ? true
          : fromIndex > 0
            ? scene.scene_index >= fromIndex
            : !hasRenderedImage(scene.id)
    })
    skipped = scenes.length - toRender.length

    job.output_lines.push(
      `Independent render (parallel ×${concurrency}) — ${imageProvider.meta.name} / ${model} · ` +
      `${toRender.length}/${scenes.length} scene(s) · refs: ` +
      `${[useComposition && 'composition', useSheet && 'sheet', cfg.references.characters && characterRefPaths.length ? 'chars' : '', useStyle && 'style'].filter(Boolean).join('+') || 'none'}` +
      ` · ${mode} · NO prev-render (scenes independent)`,
    )

    const inFlight = new Set<number>()
    let done = 0
    const pushStatus = () => writeStatus({
      active: true,
      mode: 'independent',
      provider: imageProvider.meta.name,
      model,
      endpoint,
      concurrency,
      total: scenes.length,
      to_render: toRender.length,
      rendered_so_far: done,
      in_flight: [...inFlight].sort((a, b) => a - b),
      references: sharedRefDescs,
      updated_at: new Date().toISOString(),
    })

    // Studio Hub batch-per-story (§6b): in Hub mode, submit ALL scenes as ONE
    // batch so the Hub work-steals them across the WHOLE fleet. The per-scene
    // worker pool below is bounded by the direct endpoint list, which under-uses
    // the fleet in Hub mode; a shared reference uploads once (one asset_id).
    // Results stream back per scene as they finish (poll-based, no webhook). On
    // a connection error, fall back to the per-scene pool.
    let renderedViaBatch = false
    const hubBackend = await getHubBackend()
    if (hubBackend.mode === 'hub' && hubBackend.hubUrl && providerId === 'imagestudio' && toRender.length) {
      try {
        const batchReqs = toRender.map((scene) => {
          const sref = buildSceneRefs(scene, null)
          return {
            scene, sref,
            req: {
              prompt: composePrompt(scene.visual_prompt, sref.includeCharacter),
              aspectRatio, modelId: model, providerParams: sref.params,
              width: renderWidth, height: renderHeight,
              referenceImagePaths: sref.refPaths.length ? sref.refPaths : undefined,
            } as ImageGenerationRequest,
          }
        })
        for (const b of batchReqs) inFlight.add(b.scene.scene_index)
        await pushStatus()
        job.output_lines.push(`Studio Hub batch — submitting ${batchReqs.length} scene(s) as ONE render; the Hub distributes them across the fleet.`)
        await renderImageBatchViaHub(batchReqs.map((b) => b.req), {
          label: `storystudio:${slug}/${episode_id.toUpperCase()}`,
          isCancelled: () => jq.isCancelled(job.job_id),
          onItemDone: async (index, result) => {
            const b = batchReqs[index]
            if (!b) return
            const outPath = path.join(outDir, `${b.scene.id}.png`)
            try {
              if (result.error || !result.url) {
                failedSceneIds.push(b.scene.id)
                job.output_lines.push(`Scene ${b.scene.scene_index} failed: ${result.error || 'no image'}`)
              } else {
                if (result.taskId) {
                  await recordTask(outDir, `${b.scene.id}.png`, {
                    provider: imageProvider.meta.providerId || imageProvider.meta.id,
                    task_id: result.taskId,
                    submitted_at: new Date().toISOString(),
                    input_hash: hashInput(b.req.prompt),
                  })
                }
                await downloadImage(result.url, outPath)
                await persistImagePath(b.scene.id, outPath, b.scene.visual_prompt)
                rendered++
                job.output_lines.push(`Scene ${b.scene.scene_index}/${scenes.length} (${b.scene.id}) ✓`)
              }
            } finally {
              inFlight.delete(b.scene.scene_index)
              done++
              job.progress = Math.round((done / Math.max(1, toRender.length)) * 100)
              await pushStatus()
            }
          },
        })
        renderedViaBatch = true
      } catch (e: any) {
        if (!isConnectionError(e)) throw e
        inFlight.clear()
        done = 0
        failedSceneIds.length = 0
        job.output_lines.push(`Studio Hub batch unreachable (${e?.message || e}) — falling back to per-scene rendering.`)
        await pushStatus()
      }
    }

    if (renderedViaBatch) {
      await writeStatus({ active: false, updated_at: new Date().toISOString() })
    } else try {
      let idx = 0
      let active = 0
      let finishAll!: () => void
      const allWorkersDone = new Promise<void>((res) => { finishAll = res })
      // Resolve once all work is claimed (or the job is cancelled) AND every
      // worker has drained — so a cancelled run can't hang waiting on workers.
      const maybeFinish = () => {
        if ((idx >= toRender.length || jq.isCancelled(job.job_id)) && active === 0) finishAll()
      }
      const worker = async (): Promise<void> => {
        active++
        try {
        while (idx < toRender.length) {
          if (jq.isCancelled(job.job_id)) return
          const scene = toRender[idx++]!
          const outPath = path.join(outDir, `${scene.id}.png`)
          // Per-scene refs — character scenes get the anchor stack, non-character
          // scenes drop it (no prev-render in parallel mode either way).
          const sref = buildSceneRefs(scene, null)
          inFlight.add(scene.scene_index)
          await pushStatus()
          try {
            const result = await runOnPool(dispatcher, apiKey, (ep) => imageProvider.generateImage({
              prompt: composePrompt(scene.visual_prompt, sref.includeCharacter),
              apiKey: ep,
              aspectRatio,
              modelId: model,
              providerParams: sref.params,
              width: renderWidth,
              height: renderHeight,
              referenceImagePaths: sref.refPaths.length ? sref.refPaths : undefined,
              isCancelled: () => jq.isCancelled(job.job_id),
            }))
            if (!result.urls.length) throw new Error('provider returned no image')
            if (result.taskId) {
              await recordTask(outDir, `${scene.id}.png`, {
                provider: imageProvider.meta.providerId || imageProvider.meta.id,
                task_id: result.taskId,
                submitted_at: new Date().toISOString(),
                input_hash: hashInput(composePrompt(scene.visual_prompt, sref.includeCharacter)),
              })
            }
            await downloadImage(result.urls[0]!, outPath)
            await persistImagePath(scene.id, outPath, scene.visual_prompt)
            rendered++
            job.output_lines.push(`Scene ${scene.scene_index}/${scenes.length} (${scene.id}) ✓ — ${sref.refPaths.length} ref(s)${sref.includeCharacter ? '' : ' · no-character'}`)
          } catch (e: any) {
            // Independent scenes don't block each other — log + keep going.
            failedSceneIds.push(scene.id)
            job.output_lines.push(`Scene ${scene.scene_index} failed: ${e?.message || e}`)
          } finally {
            inFlight.delete(scene.scene_index)
            done++
            job.progress = Math.round((done / Math.max(1, toRender.length)) * 100)
            await pushStatus()
          }
        }
        } finally { active--; maybeFinish() }
      }

      // v1.0.341 — growable worker pool. Start at the live count; a periodic
      // re-probe brings recovered/booted Macs back into rotation (markUp) and
      // scales the pool UP to the live count — never beyond it, so we keep the
      // "one inference per Mac" guarantee. 'auto' may grow to the full
      // configured pool; an explicit concurrency is a hard cap. No idle Macs.
      const maxWorkers = params.concurrency === 'auto'
        ? Math.max(1, Math.min(50, dispatcher ? dispatcher.size : concurrency))
        : concurrency
      const liveNow = () => (dispatcher ? Math.max(1, dispatcher.liveCount()) : maxWorkers)
      const ensureWorkers = () => {
        if (idx >= toRender.length || jq.isCancelled(job.job_id)) return
        const want = Math.min(maxWorkers, liveNow(), toRender.length - idx + active)
        while (active < want) void worker()
      }
      ensureWorkers()
      maybeFinish()  // nothing to render → resolve immediately

      let poolScaler: ReturnType<typeof setInterval> | null = null
      if (dispatcher && providerId === 'imagestudio') {
        poolScaler = setInterval(() => {
          if (idx >= toRender.length || jq.isCancelled(job.job_id)) return
          void (async () => {
            try {
              const { health: imgHealth } = await import('../lib/imagestudio-client.js')
              // v1.0.437 — enabled-aware re-probe: only contact still-enabled
              // endpoints, and force any Mac switched off mid-render DOWN so it
              // stops receiving work even though it's still reachable.
              const probeEps = parseEnabledEndpoints(apiKey)
              const enabledSet = new Set(probeEps)
              const { healthy, offline } = await healthyEndpoints(probeEps, async (u) => (await imgHealth(u)).ok)
              const before = dispatcher!.liveCount()
              for (const u of healthy) dispatcher!.markUp(u)
              for (const u of offline) dispatcher!.markDown(u)
              for (const u of parseEndpoints(apiKey)) if (!enabledSet.has(u)) dispatcher!.markDown(u)
              const after = dispatcher!.liveCount()
              if (after !== before) {
                job.output_lines.push(`Pool now ${after}/${probeEps.length} Macs online (enabled + reachable) — adjusting workers.`)
              }
              ensureWorkers()
            } catch { /* transient probe failure — keep the current workers */ }
          })()
        }, POOL_REPROBE_MS)
      }

      try { await allWorkersDone } finally { if (poolScaler) clearInterval(poolScaler) }
    } finally {
      await writeStatus({ active: false, updated_at: new Date().toISOString() })
    }

    job.output_dir = outDir
    job.progress = 100
    requireJobCompletion(job, {
      label: 'Continuity scene rendering', expected: toRender.length,
      completed: toRender.length - new Set(failedSceneIds).size,
      missing: [...new Set(failedSceneIds)],
      retry_hint: 'Successful images were saved; Retry resumes with only missing scenes.',
    })
    job.output_lines.push(`Done (parallel) — ${toRender.length}/${toRender.length} target scene(s) verified; ${skipped} skipped.`)
    return
  }

  job.output_lines.push(
    `Continuity render — ${imageProvider.meta.name} / ${model} · ${scenes.length} scene(s) · refs: ` +
    `${[useComposition && 'composition', cfg.references.prev_render && 'prev', useSheet && 'sheet', cfg.references.characters && characterRefPaths.length ? 'chars' : '', useStyle && 'style'].filter(Boolean).join('+') || 'none'}` +
    ` · ${mode}`,
  )

  // Tracks the previous CHARACTER scene's render so the guide chains across the
  // non-character cutaways between his appearances. Non-character scenes never
  // set or consume it.
  let prevCharRender: { path: string; id: string; index: number } | null = null

  try {
  for (let i = 0; i < scenes.length; i++) {
    if (jq.isCancelled(job.job_id)) throw new Error('Cancelled by user')
    const scene = scenes[i]!
    const outPath = path.join(outDir, `${scene.id}.png`)

    // Decide whether THIS scene renders:
    //   - single       → only the one requested scene (re-roll, refs included)
    //   - force        → every scene
    //   - from-render  → this scene's index and all later ones
    //   - resume       → only scenes that don't have an image yet
    const renderThis = singleIndex > 0
      ? scene.scene_index === singleIndex
      : force
        ? true
        : fromIndex > 0
          ? scene.scene_index >= fromIndex
          : !hasRenderedImage(scene.id)

    if (!renderThis) {
      // Skipped — but an existing CHARACTER render still seeds the guide chain.
      if (existsSync(outPath) && isCharacterScene(scene)) { prevCharRender = { path: outPath, id: scene.id, index: scene.scene_index } }
      skipped++
      job.progress = Math.round(((i + 1) / scenes.length) * 100)
      continue
    }
    if (!scene.visual_prompt?.trim()) {
      job.output_lines.push(`Scene ${scene.scene_index}: no visual_prompt — skipped.`)
      skipped++
      continue
    }

    // Per-scene references (character vs non-character) + the live-panel
    // descriptor list. Character scenes chain off the previous character render.
    const { refPaths: referenceImagePaths, descs: refDescs, params: sceneParams, includeCharacter } = buildSceneRefs(scene, prevCharRender)

    job.output_lines.push(
      `Scene ${scene.scene_index}/${scenes.length} (${scene.id}) — ${referenceImagePaths.length} ref(s)` +
      `${includeCharacter ? (prevCharRender ? '' : ' · establishing') : ' · no-character'}`,
    )

    // Publish the live status BEFORE the (slow) API call so the panel shows
    // exactly which images are feeding into which endpoint right now.
    // v1.0.237 — base the label on whether references are actually attached to
    // a ref-capable model, not on the kie-specific `api_model_i2i` (the OpenAI
    // and OpenRouter providers do image-to-image via /edits / image_url blocks
    // and have no api_model_i2i, so they were mislabelled "text-to-image").
    const endpoint = (referenceImagePaths.length && (providerParams as any).supports_reference_images === true)
      ? 'image-to-image' : 'text-to-image'
    await writeStatus({
      active: true,
      provider: imageProvider.meta.name,
      model,
      endpoint,
      scene_id: scene.id,
      scene_index: scene.scene_index,
      total: scenes.length,
      rendered_so_far: rendered,
      prompt: composePrompt(scene.visual_prompt, includeCharacter),
      references: refDescs,
      updated_at: new Date().toISOString(),
    })

    const result = await runOnPool(dispatcher, apiKey, (ep) => imageProvider.generateImage({
      prompt: composePrompt(scene.visual_prompt, includeCharacter),
      apiKey: ep,
      aspectRatio,
      modelId: model,
      providerParams: sceneParams,
      width: renderWidth,
      height: renderHeight,
      referenceImagePaths: referenceImagePaths.length ? referenceImagePaths : undefined,
      isCancelled: () => jq.isCancelled(job.job_id),
    }))
    if (!result.urls.length) {
      throw new Error(`${imageProvider.meta.name} returned no image for scene ${scene.scene_index} (${scene.id}).`)
    }
    if (result.taskId) {
      await recordTask(outDir, `${scene.id}.png`, {
        provider: imageProvider.meta.providerId || imageProvider.meta.id,
        task_id: result.taskId,
        submitted_at: new Date().toISOString(),
        input_hash: hashInput(composePrompt(scene.visual_prompt, includeCharacter)),
      })
    }
    await downloadImage(result.urls[0]!, outPath)

    // Persist image_path back to scene_plan.json (re-read to avoid clobbering
    // any concurrent edit). Reset approval — the user re-approves after render.
    try {
      const fresh = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
      const target = fresh.scenes.find(s => s.id === scene.id)
      if (target) {
        target.image_path = outPath
        target.rendered_prompt = scene.visual_prompt   // v1.0.359 — stale-detection stamp
        target.image_version = new Date().toISOString()
        target.motion_choice = 'pending'
        target.approved = false
        await fs.writeFile(planPath, JSON.stringify(fresh, null, 2), 'utf-8')
      }
    } catch { /* best-effort — the file on disk is what Scene Review reads */ }

    // Only character scenes seed the guide-continuity chain; cutaways don't,
    // so the next character scene anchors off the last character render.
    if (includeCharacter) prevCharRender = { path: outPath, id: scene.id, index: scene.scene_index }
    rendered++
    job.progress = Math.round(((i + 1) / scenes.length) * 100)
  }
  } finally {
    // Clear the live panel whenever the render stops (done / error / cancel).
    await writeStatus({ active: false, updated_at: new Date().toISOString() })
  }

  job.output_dir = outDir
  job.progress = 100
  job.output_lines.push(`Done — rendered ${rendered}, skipped ${skipped} (already had images).`)
}
