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
 * generator — so Scene Review + Timestamp Assemble pick the images up unchanged.
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { registry } from '../providers/registry.js'
import { resolveApiKeyForProvider } from '../providers/registry.js'
import { downloadImage } from '../lib/kie-client.js'
import { parseEndpoints, healthyEndpoints, createDispatcher, runOnPool, type Dispatcher } from '../lib/endpoint-pool.js'
import { resolveEpisodePathsByCode } from '../services/utils.js'
import * as pm from '../services/project-manager.js'
import * as jq from '../services/job-queue.js'
import { getCharacter, referenceImagePath } from '../services/character-manager.js'
import { SCENE_PLAN_FILENAME } from './scene-plan.js'
import { SCENE_IMAGES_SUBFOLDER } from './scene-image.js'
import type { Job, ImageModelConfig, ScenePlan } from '../models/types.js'

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
  /** v1.0.241 — INDEPENDENT / PARALLEL mode. Render each scene against the
   *  static references only (character sheet + style + anchor characters) and
   *  DROP the previous-render reference, so scenes no longer depend on one
   *  another and can be rendered concurrently through a bounded pool. Much
   *  faster; trades frame-to-frame continuity for speed + parallelism. The
   *  sequential chain remains the default. */
  independent?: boolean
  /** Max concurrent provider calls in independent mode (clamped 1–8, default 3). */
  concurrency?: number
  /** v1.0.254 — PROMPT-ONLY (text-to-image): send NO reference images at all
   *  (no sheet / style / characters / prev-render), rendering each scene from
   *  its composed text prompt alone. Cheaper + faster (no img2img), and lets
   *  any text2img model render a continuity-chain episode. Consistency then
   *  rides entirely on the prompt (detail level + Style Bible + character
   *  text), so dial those in. */
  prompt_only?: boolean
}

interface ContinuityCfg {
  anchor_character_ids: string[]
  use_episode_sheet: boolean
  references: { prev_render: boolean; sheet: boolean; characters: boolean; style: boolean }
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
    references: { prev_render: true, sheet: true, characters: true, style: false },
    denoise_strength: 0.5,
    style_bible: '',
    negative_prompt: '',
  }
}

/** v1.0.233 — live render-status sidecar. The renderer writes the current
 *  scene + the exact reference images it's feeding into the model before each
 *  render; Scene Review reads it to show a "Now rendering" preview panel. */
export const RENDER_STATUS_FILENAME = '.render_status.json'

export async function runContinuityRenderJob(job: Job): Promise<void> {
  const params = job.params as ContinuityRenderParams
  const { episode_id, model } = params
  if (!episode_id) throw new Error('episode_id is required')
  if (!model) throw new Error('model is required')

  const paths = await resolveEpisodePathsByCode(job.project_slug, episode_id)
  const planPath = path.join(paths.episode_dir, SCENE_PLAN_FILENAME)
  if (!existsSync(planPath)) {
    throw new Error(`No scene_plan.json at ${planPath}. Run Scene Plan first.`)
  }
  const plan = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
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
  const modelConfig: ImageModelConfig | undefined = config.image_models?.[model]
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
    const eps = parseEndpoints(apiKey)
    if (eps.length > 1) {
      const { health: imgHealth } = await import('../lib/imagestudio-client.js')
      const { healthy, offline } = await healthyEndpoints(eps, async (u) => (await imgHealth(u)).ok)
      const usable = healthy.length ? healthy : eps
      dispatcher = createDispatcher(usable)
      job.output_lines.push(
        `Image Studio pool: ${healthy.length}/${eps.length} online` +
        (offline.length ? ` (offline: ${offline.join(', ')})` : '') +
        ` — distributing least-busy across ${usable.length} endpoint(s).`,
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
  const composePrompt = (visualPrompt: string): string => {
    const parts = [visualPrompt.trim()]
    if (charText) parts.push(`Character details — ${charText}.`)
    if (styleBible) parts.push(`Style: ${styleBible}`)
    return parts.join('\n\n')
  }
  if (charText || styleBible || cfg.negative_prompt) {
    job.output_lines.push(
      `Prompt layer: ${[charText && 'character text', styleBible && 'style bible', cfg.negative_prompt && 'negative prompt'].filter(Boolean).join(' + ')}.`,
    )
  }

  const outDir = path.join(paths.episode_dir, SCENE_IMAGES_SUBFOLDER)
  await fs.mkdir(outDir, { recursive: true })

  const aspectRatio = params.aspect_ratio || '16:9'
  const force = params.force === true
  // v1.0.241 — independent / parallel mode: drop the prev-render reference so
  // scenes are mutually independent and can render concurrently.
  const independent = params.independent === true
  const concurrency = Math.max(1, Math.min(8, Math.floor(Number(params.concurrency) || 3)))
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
  const persistImagePath = (sceneId: string, outPath: string): Promise<void> => {
    planChain = planChain.then(async () => {
      try {
        const fresh = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
        const target = fresh.scenes.find(s => s.id === sceneId)
        if (target) {
          target.image_path = outPath
          target.approved = false   // user re-approves after a render
          await fs.writeFile(planPath, JSON.stringify(fresh, null, 2), 'utf-8')
        }
      } catch { /* best-effort — the PNG on disk is what Scene Review reads */ }
    })
    return planChain
  }

  // ── INDEPENDENT / PARALLEL mode ─────────────────────────────────────
  // Each scene renders against the static references only (sheet + style +
  // characters); NO previous-render reference, so scenes don't chain and a
  // bounded pool can run several at once. Far faster than the serial chain.
  if (independent) {
    // The shared reference stack — identical for every scene (no prev_render).
    const sharedRefs: string[] = []
    const sharedRefDescs: Array<{ kind: string; label: string; url: string }> = []
    if (useSheet) { sharedRefs.push(sheetPath); sharedRefDescs.push({ kind: 'sheet', label: 'Character sheet', url: sheetUrl }) }
    if (cfg.references.characters) {
      for (const c of characterRefs) { sharedRefs.push(c.abs); sharedRefDescs.push({ kind: 'character', label: c.label, url: c.url }) }
    }
    if (useStyle) { sharedRefs.push(stylePath); sharedRefDescs.push({ kind: 'style', label: 'Style reference', url: styleUrl }) }
    // v1.0.254 — prompt-only drops every reference image (pure text2img).
    const sharedRefPaths = promptOnly ? [] : Array.from(new Set(sharedRefs))
    const endpoint = (sharedRefPaths.length && (providerParams as any).supports_reference_images === true)
      ? 'image-to-image' : 'text-to-image'

    // Which scenes to render: single → that one; force → all; from → index≥; resume → missing.
    const toRender = scenes.filter(scene => {
      if (!scene.visual_prompt?.trim()) return false
      const outPath = path.join(outDir, `${scene.id}.png`)
      return singleIndex > 0
        ? scene.scene_index === singleIndex
        : force
          ? true
          : fromIndex > 0
            ? scene.scene_index >= fromIndex
            : !existsSync(outPath)
    })
    skipped = scenes.length - toRender.length

    job.output_lines.push(
      `Independent render (parallel ×${concurrency}) — ${imageProvider.meta.name} / ${model} · ` +
      `${toRender.length}/${scenes.length} scene(s) · refs: ` +
      `${[useSheet && 'sheet', cfg.references.characters && characterRefPaths.length ? 'chars' : '', useStyle && 'style'].filter(Boolean).join('+') || 'none'}` +
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

    try {
      let idx = 0
      const worker = async (): Promise<void> => {
        while (idx < toRender.length) {
          if (jq.isCancelled(job.job_id)) return
          const scene = toRender[idx++]!
          const outPath = path.join(outDir, `${scene.id}.png`)
          inFlight.add(scene.scene_index)
          await pushStatus()
          try {
            const result = await runOnPool(dispatcher, apiKey, (ep) => imageProvider.generateImage({
              prompt: composePrompt(scene.visual_prompt),
              apiKey: ep,
              aspectRatio,
              modelId: model,
              providerParams,
              referenceImagePaths: sharedRefPaths.length ? sharedRefPaths : undefined,
              isCancelled: () => jq.isCancelled(job.job_id),
            }))
            if (!result.urls.length) throw new Error('provider returned no image')
            await downloadImage(result.urls[0]!, outPath)
            await persistImagePath(scene.id, outPath)
            rendered++
            job.output_lines.push(`Scene ${scene.scene_index}/${scenes.length} (${scene.id}) ✓ — ${sharedRefPaths.length} ref(s)`)
          } catch (e: any) {
            // Independent scenes don't block each other — log + keep going.
            job.output_lines.push(`Scene ${scene.scene_index} failed: ${e?.message || e}`)
          } finally {
            inFlight.delete(scene.scene_index)
            done++
            job.progress = Math.round((done / Math.max(1, toRender.length)) * 100)
            await pushStatus()
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(concurrency, toRender.length || 1) }, () => worker()))
    } finally {
      await writeStatus({ active: false, updated_at: new Date().toISOString() })
    }

    job.output_dir = outDir
    job.progress = 100
    job.output_lines.push(`Done (parallel) — rendered ${rendered}, skipped ${skipped} (already had images / no prompt).`)
    return
  }

  job.output_lines.push(
    `Continuity render — ${imageProvider.meta.name} / ${model} · ${scenes.length} scene(s) · refs: ` +
    `${[cfg.references.prev_render && 'prev', useSheet && 'sheet', cfg.references.characters && characterRefPaths.length ? 'chars' : '', useStyle && 'style'].filter(Boolean).join('+') || 'none'}` +
    ` · ${mode}`,
  )

  let prevRenderPath: string | null = null
  let prevSceneId: string | null = null
  let prevIndex = 0

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
          : !existsSync(outPath)

    if (!renderThis) {
      // Skipped — but an existing render still seeds the chain for the next.
      if (existsSync(outPath)) { prevRenderPath = outPath; prevSceneId = scene.id; prevIndex = scene.scene_index }
      skipped++
      job.progress = Math.round(((i + 1) / scenes.length) * 100)
      continue
    }
    if (!scene.visual_prompt?.trim()) {
      job.output_lines.push(`Scene ${scene.scene_index}: no visual_prompt — skipped.`)
      skipped++
      continue
    }

    // Stack references for THIS scene per the toggles — and a parallel
    // descriptor list (kind + label + frontend URL) for the live panel.
    const refs: string[] = []
    const refDescs: Array<{ kind: string; label: string; url: string }> = []
    if (useSheet) { refs.push(sheetPath); refDescs.push({ kind: 'sheet', label: 'Character sheet', url: sheetUrl }) }
    if (cfg.references.characters) {
      for (const c of characterRefs) { refs.push(c.abs); refDescs.push({ kind: 'character', label: c.label, url: c.url }) }
    }
    if (cfg.references.prev_render && prevRenderPath && prevSceneId && existsSync(prevRenderPath)) {
      refs.push(prevRenderPath)
      refDescs.push({ kind: 'prev', label: `Previous render (scene ${prevIndex})`, url: sceneImgUrl(prevSceneId) })
    }
    if (useStyle) { refs.push(stylePath); refDescs.push({ kind: 'style', label: 'Style reference', url: styleUrl }) }
    // v1.0.254 — prompt-only drops every reference image (pure text2img).
    const referenceImagePaths = promptOnly ? [] : Array.from(new Set(refs))

    job.output_lines.push(
      `Scene ${scene.scene_index}/${scenes.length} (${scene.id}) — ${referenceImagePaths.length} ref(s)` +
      `${prevRenderPath ? '' : ' · establishing'}`,
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
      prompt: composePrompt(scene.visual_prompt),
      references: refDescs,
      updated_at: new Date().toISOString(),
    })

    const result = await runOnPool(dispatcher, apiKey, (ep) => imageProvider.generateImage({
      prompt: composePrompt(scene.visual_prompt),
      apiKey: ep,
      aspectRatio,
      modelId: model,
      providerParams,
      referenceImagePaths: referenceImagePaths.length ? referenceImagePaths : undefined,
      isCancelled: () => jq.isCancelled(job.job_id),
    }))
    if (!result.urls.length) {
      throw new Error(`${imageProvider.meta.name} returned no image for scene ${scene.scene_index} (${scene.id}).`)
    }
    await downloadImage(result.urls[0]!, outPath)

    // Persist image_path back to scene_plan.json (re-read to avoid clobbering
    // any concurrent edit). Reset approval — the user re-approves after render.
    try {
      const fresh = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
      const target = fresh.scenes.find(s => s.id === scene.id)
      if (target) {
        target.image_path = outPath
        target.approved = false
        await fs.writeFile(planPath, JSON.stringify(fresh, null, 2), 'utf-8')
      }
    } catch { /* best-effort — the file on disk is what Scene Review reads */ }

    prevRenderPath = outPath
    prevSceneId = scene.id
    prevIndex = scene.scene_index
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
