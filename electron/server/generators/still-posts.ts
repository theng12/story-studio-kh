/**
 * Still Posts job executors.
 *
 * Two bounded jobs, because writing and drawing fail for different reasons and a Retry of one must
 * never repeat the other:
 *
 *   `still_post_write`  — one writing request for the whole batch, then one post record per draft.
 *   `still_post_render` — one paid image per missing panel, then the burned-in finals for every
 *                         requested frame. A retry draws only what has no artwork yet.
 *
 * AGENTS §8 is why the render job ends by verifying the artifacts on disk rather than trusting its
 * own loop: a batch is done only when EVERY post has its art and a final in EVERY requested frame.
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { createHash } from 'node:crypto'
import { registry } from '../providers/registry.js'
import { getApiKey } from '../services/app-secrets-store.js'
import * as pm from '../services/project-manager.js'
import { requireJobCompletion } from '../services/job-completion.js'
import { resolveChosenChatModel } from '../services/genstudio-default-model.js'
import { publishedAspectRatios, isPublishedAspectRatio } from '../contracts/genstudio-image-defaults.js'
import { resolveConfiguredAspectRatio, resolveImageModelConfig } from '../services/image-model-resolver.js'
import { stageGenStudioImage } from '../lib/genstudio-artifacts.js'
import { buildGenStudioImageIdempotencyKey } from '../lib/genstudio-client.js'
import { resolveChannelReferences } from '../services/scene-reference-characters.js'
import { getEffectiveNicheFor } from '../services/niche-loader.js'
import * as jq from '../services/job-queue.js'
import { STILL_POST_BUILTIN_PRESETS, stillPostFormat, stillPostOption } from '../still-posts/catalog.js'
import {
  artFilenameFor,
  artModeOf,
  assertFontPoolCoversScript,
  commitFinals,
  createPostWithPoolFont,
  imagePromptFor,
  listBatchStates,
  listChannelCharacters,
  listPosts,
  brandingFor,
  lookForPost,
  renderPostFinals,
  nextPostId,
  panelsForOption,
  postDir,
  presetFontPools,
  referenceCacheDir,
  resolveRoster,
  stillPostsConfig,
  validatePostId,
  writePost,
} from '../services/still-posts.js'
import { shortBatchMessage, writeStillPosts } from '../services/still-post-writer.js'
import { channelHandle, channelLogoPath } from '../services/still-posts.js'
import { STILL_POST_LANGUAGE_SCRIPT, STILL_POST_LANGUAGE_LABELS } from '../contracts/still-posts.js'
import type { StillPostFontPools } from '../contracts/still-post-fonts.js'
import {
  isStillPostAspect,
  isStillPostsLanguage,
  STILL_POST_ASPECTS,
  type StillPost,
  type StillPostAspect,
  type StillPostFormat,
  type StillPostOption,
  type StillPostBranding,
  type StillPostsLanguage,
} from '../contracts/still-posts.js'
import type { Job, Niche } from '../models/types.js'

// ── Write ──────────────────────────────────────────────────────────────────

export interface StillPostWriteParams {
  batch_id: string
  brief: string
  count: number
  format_id: string
  option_id: string
  language: StillPostsLanguage
  aspects: StillPostAspect[]
  /** Draw a separate picture per ticked frame. Absent/false = one drawing, fitted to each size. */
  fresh_drawing_per_size?: boolean
  /**
   * The preset's lettering font pools. New posts are given a face from the pool for their own
   * script; an empty/absent pool leaves the format's face in place.
   */
  font_pools?: StillPostFontPools
  character_ids: string[]
  writing_model?: string | null
}

/** The channel's Still Posts voice, as its Formula declares it. Absent is refused, never invented. */
export function stillPostsVoice(niche: Niche | null): { writeSystemPromptRole: string; quoteGuidance: string } | null {
  const block = (niche as any)?.stillPostsFormat
  if (!block || typeof block !== 'object') return null
  return {
    writeSystemPromptRole: String(block.writeSystemPromptRole || '').trim(),
    quoteGuidance: String(block.quoteGuidance || '').trim(),
  }
}

export async function generateStillPostsWrite(job: Job): Promise<void> {
  const params = job.params as StillPostWriteParams
  const slug = job.project_slug
  if (!params?.batch_id) throw new Error('batch_id is required')
  const requested = Math.max(1, Math.min(40, Math.round(Number(params.count) || 0)))
  if (!Number.isFinite(requested) || requested < 1) throw new Error('count must be at least 1')

  const format = stillPostFormat(String(params.format_id))
  if (!format) throw new Error(`Format "${params.format_id}" is not one of this build's Still Post formats.`)
  const option = stillPostOption(String(params.option_id))
  if (!option) throw new Error(`Option "${params.option_id}" is not one of this build's Still Post options.`)
  const language: StillPostsLanguage = isStillPostsLanguage(params.language) ? params.language : 'en'
  const aspects = (Array.isArray(params.aspects) ? params.aspects : []).filter(isStillPostAspect)
  if (!aspects.length) throw new Error('At least one export frame (1:1, 9:16 or 16:9) is required.')

  // The channel's lettering pool for this batch's script is checked BEFORE anything is written, so
  // a face that cannot draw the language refuses the batch instead of being substituted (§1/§6).
  const fontPools = presetFontPools(params.font_pools)
  const script = STILL_POST_LANGUAGE_SCRIPT[language]
  await assertFontPoolCoversScript(fontPools[script], script, STILL_POST_LANGUAGE_LABELS[language])

  // Characters are channel data. Every requested id must resolve to a character of THIS channel.
  const config = await pm.getConfig(slug)
  const characters = await listChannelCharacters(slug)
  const roster = resolveRoster(stillPostsConfig(config).character_ids, characters)
  const wanted = [...new Set((params.character_ids || []).filter(Boolean))]
  const foreign = wanted.filter(id => !roster.ids.includes(id))
  if (foreign.length) {
    throw new Error(
      'These characters are not in this channel\'s Still Posts cast, so they cannot be used: '
      + `${foreign.join(', ')}. Add them to the channel's Characters first. Nothing was written.`,
    )
  }

  const project = await pm.getProject(slug)
  if (!project) throw new Error(`Project '${slug}' not found`)
  const niche = await getEffectiveNicheFor(project).catch(() => null)
  const voice = stillPostsVoice(niche)
  if (!voice?.writeSystemPromptRole) {
    throw new Error(
      'This channel\'s Series Formula does not describe how Still Posts are written. '
      + 'Choose the Still Posts Formula on the channel, or add a written voice to this one.',
    )
  }

  // Partial batches survive a failure: the count is topped up, not restarted.
  const existing = (await listPosts(slug)).filter(post => post.batch_id === params.batch_id)
  const need = requested - existing.length
  if (need <= 0) {
    job.output_lines.push(`Batch ${params.batch_id} already holds ${existing.length} post(s); nothing was requested.`)
    job.progress = 100
    requireJobCompletion(job, {
      label: 'Still Post writing',
      expected: requested,
      completed: existing.length,
      retry_hint: 'Nothing to retry — every requested post already exists.',
    })
    return
  }

  const apiKey = await getApiKey('genstudio').catch(() => '')
  const model = await resolveChosenChatModel(apiKey, params.writing_model || null, 'the Still Posts page')
  job.output_lines.push(`Writing ${need} post${need === 1 ? '' : 's'} with ${model} in ${language}.`)

  const drafts = await writeStillPosts({
    brief: String(params.brief || '').trim(),
    count: need,
    format,
    option,
    language,
    voice: `${voice.writeSystemPromptRole}${voice.quoteGuidance ? `\n${voice.quoteGuidance}` : ''}`,
    writingModel: params.writing_model || null,
    requestIdentity: `still-posts:${slug}:${params.batch_id}:${need}:${language}:${format.id}:${option.id}`,
    where: 'the Still Posts page',
  })

  const created = await createPostsFromDrafts(slug, {
    batch_id: params.batch_id,
    format,
    option,
    language,
    aspects,
    art_mode: params.fresh_drawing_per_size === true ? 'per-size' : 'single',
    font_pools: fontPools,
    character_ids: wanted,
  }, drafts)

  job.progress = 100
  job.output_lines.push(`Wrote ${created.length} post(s): ${created.join(', ')}.`)
  if (created.length < need) {
    // The usable ones are kept — and the job still fails, loudly, naming the shortfall.
    throw new Error(shortBatchMessage(requested, existing.length + created.length))
  }
  requireJobCompletion(job, {
    label: 'Still Post writing',
    expected: requested,
    completed: existing.length + created.length,
    retry_hint: 'Retry writes only the posts that are missing; written posts are kept.',
  })
}

/**
 * Write one post record per draft. Kept separate from the job so the count rule ("every usable draft
 * becomes a post, and a short batch still fails loudly") can be tested without a model call.
 *
 * The lettering face is assigned HERE, once per post, from the channel's pool for the batch's
 * script, and recorded on the record (`font_id`). That is what makes a post keep its face across a
 * retry, a re-render and a later pool edit. With no pool the record keeps the exact shape it had
 * before this feature.
 *
 * `opts.rng` is injected only so a weighted pool can be pinned in a test; production uses Math.random.
 */
export async function createPostsFromDrafts(
  slug: string,
  batch: {
    batch_id: string
    format: StillPostFormat
    option: StillPostOption
    language: StillPostsLanguage
    aspects: StillPostAspect[]
    /** Absent/`single` writes no field, so a batch written before this choice is byte-identical. */
    art_mode?: 'single' | 'per-size'
    /** The preset's pools. Empty/absent = every post uses the format's own face, as before. */
    font_pools?: StillPostFontPools
    character_ids: string[]
  },
  drafts: ReadonlyArray<{ panels: ReadonlyArray<{ text: string; scene_prompt: string }>; caption: string }>,
  opts: { rng?: () => number } = {},
): Promise<string[]> {
  const created: string[] = []
  // One scan of the channel decides the numbering; a per-draft scan would re-read every post file
  // once per post.
  const first = await nextPostId(slug)
  const startingNumber = Number(/^post-(\d+)$/.exec(first)?.[1] || '1')
  const script = STILL_POST_LANGUAGE_SCRIPT[batch.language]
  const pool = (batch.font_pools || {})[script]
  for (const [index, draft] of drafts.entries()) {
    const id = `post-${String(startingNumber + index).padStart(4, '0')}`
    const panels = panelsForOption(batch.option)
    const now = new Date().toISOString()
    const post: StillPost = {
      id,
      batch_id: batch.batch_id,
      created_at: now,
      updated_at: now,
      format_id: batch.format.id,
      option_id: batch.option.id,
      language: batch.language,
      character_ids: [...batch.character_ids],
      caption: draft.caption,
      panels: panels.map((panel, index) => ({
        ...panel,
        text: draft.panels[index]?.text ?? '',
        scene_prompt: draft.panels[index]?.scene_prompt ?? '',
        image: null,
      })),
      finals: [],
      aspects: [...batch.aspects],
      // Absent for the default, so a batch written with one drawing per post keeps the exact
      // record shape it has always had.
      ...(batch.art_mode === 'per-size' ? { art_mode: 'per-size' as const } : {}),
      published_at: null,
    }
    await createPostWithPoolFont(slug, script, pool, () => post, opts)
    created.push(id)
  }
  return created
}

// ── Render ─────────────────────────────────────────────────────────────────

export interface StillPostRenderParams {
  batch_id?: string
  post_ids?: string[]
  image_model: string
  redraw?: boolean
  /**
   * The page's current drawing choice. `undefined` keeps each post's stored mode (the honest
   * answer for a retry whose caller did not restate it); `true`/`false` moves the post to that mode
   * and the job says so.
   */
  fresh_drawing_per_size?: boolean
  /** The page's active preset branding. Absent uses the built-in preset's placement. */
  branding?: StillPostBranding
  /** The preset's type-size multiplier. */
  text_scale?: number
}

/** The frames a post must have art for (and a final in). */
function framesOf(post: Pick<StillPost, 'aspects'>): StillPostAspect[] {
  return post.aspects.length ? [...post.aspects] : [...STILL_POST_ASPECTS]
}

/**
 * The mode this render produces for one post.
 *
 * An omitted request keeps the post's stored mode — a Retry that does not restate the choice must
 * never silently re-decide it. An explicit choice that differs is applied, and the caller announces
 * that the other mode's drawings are kept but not used for these frames.
 */
export function renderModeFor(post: Pick<StillPost, 'art_mode'>, requested: boolean | undefined): 'single' | 'per-size' {
  if (requested === undefined) return artModeOf(post)
  return requested ? 'per-size' : 'single'
}

/**
 * AGENTS §1/§8 — a per-size drawing is only requested at an aspect the SELECTED model publishes.
 *
 * Refused before any paid call, naming the frame and the model. Nothing is substituted: an
 * unpublished size is simply not available from this model, and drawing another one and framing it
 * would be the very guess this feature exists to remove.
 */
export function assertPerSizeAspectsPublished(
  posts: ReadonlyArray<Pick<StillPost, 'id' | 'aspects'>>,
  modes: ReadonlyMap<string, 'single' | 'per-size'>,
  modelLabel: string,
  model: Parameters<typeof isPublishedAspectRatio>[0],
): void {
  const published = publishedAspectRatios(model)
  for (const post of posts) {
    if (modes.get(post.id) !== 'per-size') continue
    for (const aspect of framesOf(post)) {
      if (!published.length) {
        throw new Error(
          `${modelLabel} publishes no aspect ratios, so a fresh drawing per size cannot be checked `
          + `against the live catalogue. Choose a model that publishes its sizes, or turn the fresh `
          + `drawing per size off. No image was requested.`,
        )
      }
      if (!isPublishedAspectRatio(model, aspect)) {
        throw new Error(
          `${modelLabel} does not publish ${aspect}, which ${post.id} asks for when every size gets `
          + `its own drawing. Story Studio will not substitute a different size. Untick ${aspect} for `
          + `this batch, or choose an image model that publishes it. No image was requested.`,
        )
      }
    }
  }
}

/** The aspect the paid picture is drawn at: the requested frame closest to square, else the model's own default. */
export function masterAspectFor(
  requested: readonly StillPostAspect[],
  published: readonly string[],
  fallback: string,
): string {
  const available = requested.filter(aspect => published.length === 0 || published.includes(aspect))
  const rank = (aspect: string): number => Math.abs(ratioOf(aspect) - 1)
  if (!available.length) return fallback
  return [...available].sort((a, b) => rank(a) - rank(b) || requested.indexOf(a) - requested.indexOf(b))[0]!
}

function ratioOf(aspect: string): number {
  const [width, height] = aspect.split(':').map(Number)
  return width && height ? width / height : 1
}

export async function generateStillPostsRender(job: Job): Promise<void> {
  const params = job.params as StillPostRenderParams
  const slug = job.project_slug
  const imageModel = String(params?.image_model || '').trim()
  if (!imageModel) {
    throw new Error('Choose an image model before drawing a batch. No image was requested.')
  }

  const config = await pm.getConfig(slug)
  if (!config) throw new Error('Project config not found')
  const apiKey = await getApiKey('genstudio')
  if (!apiKey) throw new Error('Add the Gateway API Key in Settings before generating images.')
  const modelConfig = await resolveImageModelConfig(config, imageModel, apiKey)
  if (!modelConfig) throw new Error(`Unknown image model: ${imageModel}`)
  if (modelConfig.provider !== 'genstudio-image') {
    throw new Error(`Image model "${imageModel}" is not routed through the Gateway.`)
  }
  const provider = registry.getImageProvider('genstudio-image')
  if (!provider) throw new Error('Image generation through the Gateway is not available right now.')
  const providerParams = (modelConfig as any).provider_params || {
    endpoint: modelConfig.endpoint,
    poll: modelConfig.poll,
    type: modelConfig.type,
    api_model: modelConfig.api_model,
    aspect_field: (modelConfig as any).aspect_field,
  }

  const posts = await selectPosts(slug, params)
  if (!posts.length) throw new Error('There are no posts to draw yet. Write a batch first.')

  const published = publishedAspectRatios(modelConfig)
  // The mode each post is drawn in for THIS run, resolved before any paid call so an unpublished
  // size refuses the whole batch in preflight rather than failing post by post.
  const modes = new Map(posts.map(post => [post.id, renderModeFor(post, params.fresh_drawing_per_size)]))
  assertPerSizeAspectsPublished(posts, modes, modelConfig.label, modelConfig)
  const stillConfig = stillPostsConfig(config)
  const handle = channelHandle(config, stillConfig)
  const logo = channelLogoPath(config, stillConfig)
  // The page's active preset decides where the mark sits; its absence falls back to the built-in
  // preset rather than inventing a placement here.
  const presetBranding = params.branding ?? STILL_POST_BUILTIN_PRESETS[0]!.data.branding
  const textScale = Number(params.text_scale) > 0 ? Number(params.text_scale) : 1

  const failures: Array<{ post: string; message: string }> = []
  const items: Array<{ label: string, key: string, state: string }> = []
  let completed = 0
  const total = posts.length

  for (const [index, post] of posts.entries()) {
    if (jq.isCancelled(job.job_id)) throw new Error('Cancelled by user')
    job.item_progress = {
      total,
      completed,
      failed: failures.length,
      concurrency: 1,
      active: [{ label: post.id, key: post.id, state: 'running', attempt: 1, max_attempts: 1 }],
    }
    job.progress = Math.round((index / total) * 90)
    await jq.checkpointJobState(job).catch(() => {})

    try {
      const format = stillPostFormat(post.format_id)
      if (!format) throw new Error(`Format "${post.format_id}" is not one of this build's Still Post formats.`)
      const branding = brandingFor(presetBranding, {
        handle,
        logoPath: logo,
        language: post.language,
        format,
      })
      const look = lookForPost(post, branding, textScale)
      const dir = postDir(slug, post.id)
      await fs.mkdir(dir, { recursive: true })

      // The cast is channel data and can change after a batch was written (§4): a character the
      // owner has since removed from the cast is refused by name rather than quietly attached.
      const cast = resolveRoster(stillConfig.character_ids, await listChannelCharacters(slug)).ids
      const stale = post.character_ids.filter(id => !cast.includes(id))
      if (stale.length) {
        throw new Error(
          `${post.id} uses ${stale.join(', ')}, which ${stale.length === 1 ? 'is' : 'are'} no longer in this `
          + 'channel\'s Still Posts cast. Choose characters for this post, or add them back to the channel. '
          + 'No image was requested.',
        )
      }

      const mode = modes.get(post.id) ?? artModeOf(post)
      if (mode !== artModeOf(post)) {
        // A mode change is stated, never silent: the other mode's pictures stay on disk but this
        // run does not present them as the frames it is making.
        job.output_lines.push(mode === 'per-size'
          ? `${post.id}: switching from one fitted drawing to a fresh drawing per size. `
            + 'Its earlier drawing is kept but not used for these frames.'
          : `${post.id}: switching from a fresh drawing per size to one fitted drawing. `
            + 'The per-size drawings are kept but not used for these frames.')
        post.art_mode = mode
        await writePost(slug, post)
      }

      for (const [panelIndex, panel] of post.panels.entries()) {
        // A single post draws once per panel and fits every frame; a per-size post draws once per
        // panel PER FRAME. `artAspects` is the frame each drawing is requested at.
        const artAspects: string[] = mode === 'per-size'
          ? framesOf(post)
          : [masterAspectFor(post.aspects, published, '')]
        const needed = artAspects.filter(aspect =>
          params.redraw === true || !existsSync(path.join(dir, artFilenameFor(panelIndex, mode, aspect as StillPostAspect))))
        for (const aspect of artAspects.filter(entry => !needed.includes(entry))) {
          items.push({
            label: mode === 'per-size' ? `${post.id} panel ${panelIndex + 1} ${aspect}` : `${post.id} panel ${panelIndex + 1}`,
            key: path.join(dir, artFilenameFor(panelIndex, mode, aspect as StillPostAspect)),
            state: 'kept',
          })
        }
        if (!needed.length) continue

        const references = await resolveChannelReferences({
          slug,
          characterIds: post.character_ids,
          modelName: modelConfig.label,
          supportsReferences: modelConfig.supports_reference_images === true,
          maxReferences: modelConfig.max_reference_images,
          maxDimension: modelConfig.reference_image_max_dimension,
          cacheDir: referenceCacheDir(slug),
          postLabel: post.id,
        })
        if (!references.paths.length && (modelConfig.min_reference_images ?? 0) > 0) {
          throw new Error(
            `${post.id} has no characters, but ${modelConfig.label} needs at least `
            + `${modelConfig.min_reference_images} reference image(s). Add a character to this post, or use a `
            + 'model that draws from text alone. No image was requested.',
          )
        }

        const prompt = imagePromptFor(look, panelIndex, panel.scene_prompt)

        for (const aspect of needed) {
          const artPath = path.join(dir, artFilenameFor(panelIndex, mode, aspect as StillPostAspect))
          const previous = mode === 'per-size' && isStillPostAspect(aspect)
            ? panel.images?.[aspect]
            : panel.image
          // The aspect sent is the frame's own, checked against the live catalogue in preflight.
          // Single mode keeps exactly the request it has always made.
          const aspectRatio = mode === 'per-size'
            ? resolveConfiguredAspectRatio(modelConfig, aspect)
            : resolveConfiguredAspectRatio(modelConfig, masterAspectFor(post.aspects, published, ''))
          const requestIdentity = `${slug}:still-post:${post.id}:p${panelIndex}`
            + (mode === 'per-size' ? `:${aspect}` : '')
            + (references.digests.length ? `:ref:${references.digests.join('-')}` : '')
            + (previous?.generation_action ? `:fresh:${previous.generation_action.id}` : '')
          const idempotencyKey = buildGenStudioImageIdempotencyKey({
            prompt,
            modelId: modelConfig.api_model || imageModel,
            aspectRatio,
            requestIdentity,
          })

          const result = await provider.generateImage({
            prompt,
            apiKey,
            aspectRatio,
            modelId: modelConfig.api_model || imageModel,
            providerParams,
            ...(references.paths.length ? { referenceImagePaths: references.paths } : {}),
            idempotencyIdentity: requestIdentity,
            idempotencyKey,
            priority: 'background',
            isCancelled: () => jq.isCancelled(job.job_id),
          })
          if (!result.urls.length) throw new Error(`${provider.meta.name} returned no image for ${post.id}`)

          const stagingPath = await stageGenStudioImage(result.urls[0]!, artPath)
          await fs.rename(stagingPath, artPath)
          const bytes = await fs.readFile(artPath)
          if (bytes.length < 512) throw new Error(`The downloaded image for ${post.id} is empty.`)

          const sourceDigests = references.digests.join('-')
          const drawn = {
            filename: artFilenameFor(panelIndex, mode, aspect as StillPostAspect),
            rendered_at: new Date().toISOString(),
            sha256: createHash('sha256').update(bytes).digest('hex'),
            model_id: imageModel,
            model_label: modelConfig.label,
            prompt,
            reference_character_ids: [...post.character_ids],
            reference_names: references.names,
            mode,
            ...(isStillPostAspect(aspect) ? { aspect } : {}),
          }
          const withImage: StillPost = {
            ...post,
            panels: post.panels.map((entry, position) => {
              if (position !== panelIndex) return entry
              if (mode !== 'per-size' || !isStillPostAspect(aspect)) return { ...entry, image: drawn }
              return { ...entry, images: { ...(entry.images || {}), [aspect]: drawn } }
            }),
          }
          post.panels = withImage.panels
          await writePost(slug, withImage)
          items.push({
            label: mode === 'per-size' ? `${post.id} panel ${panelIndex + 1} ${aspect}` : `${post.id} panel ${panelIndex + 1}`,
            key: `${artPath}:${sourceDigests}`,
            state: 'drawn',
          })
          job.output_lines.push(mode === 'per-size'
            ? `${post.id} panel ${panelIndex + 1} (${aspect}): drew with ${modelConfig.label}.`
            : `${post.id} panel ${panelIndex + 1}: drew with ${modelConfig.label}.`)
        }
      }

      // Every frame this post asked for, rendered from the art that now exists.
      const current = (await listPosts(slug)).find(entry => entry.id === post.id) || post
      const rendered = await renderPostFinals(slug, current, look, current.aspects.length ? current.aspects : STILL_POST_ASPECTS)
      await commitFinals(slug, current, rendered)
      completed += 1
    } catch (error: any) {
      failures.push({ post: post.id, message: error?.message || String(error) })
      job.output_lines.push(`✗ ${post.id}: ${error?.message || error}`)
    }
  }

  job.progress = 95
  // §8 — the verdict comes from the files, not from the loop above having finished.
  const states = await listBatchStates(slug, await listPosts(slug))
  const relevant = states.filter(state => posts.some(post => post.batch_id === state.batch_id))
  const incomplete = relevant.filter(state => !state.complete)
  const missing = incomplete.flatMap(state => state.missing)

  job.result = { ...(job.result || {}), batch_complete: incomplete.length === 0, missing }
  if (missing.length || failures.length) {
    throw new Error(
      `${failures.length} post(s) could not be drawn and ${missing.length} artifact(s) are still missing. `
      + `${missing.slice(0, 8).join(' ')}${missing.length > 8 ? ' …' : ''} `
      + 'The finished work is kept. Retry draws only what is missing; it does not repeat completed posts.',
    )
  }

  job.progress = 100
  job.output_lines.push(`Drew and lettered ${posts.length} post(s).`)
  requireJobCompletion(job, {
    label: 'Still Post drawing',
    expected: posts.length,
    completed,
    retry_hint: 'Retry draws only the posts whose artwork or finals are missing.',
  })
}

/** Which posts this render covers. Ids are validated; an unknown id is refused by name. */
export async function selectPosts(slug: string, params: StillPostRenderParams): Promise<StillPost[]> {
  const all = await listPosts(slug)
  if (Array.isArray(params.post_ids) && params.post_ids.length) {
    const ids = params.post_ids.map(id => validatePostId(id))
    const chosen = ids.map(id => all.find(post => post.id === id) ?? null)
    const missing = ids.filter((id, index) => !chosen[index])
    if (missing.length) throw new Error(`No such post(s) in this channel: ${missing.join(', ')}.`)
    return chosen as StillPost[]
  }
  if (params.batch_id) return all.filter(post => post.batch_id === params.batch_id)
  return all
}

