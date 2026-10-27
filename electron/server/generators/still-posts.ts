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
import { publishedAspectRatios } from '../contracts/genstudio-image-defaults.js'
import { resolveConfiguredAspectRatio, resolveImageModelConfig } from '../services/image-model-resolver.js'
import { stageGenStudioImage } from '../lib/genstudio-artifacts.js'
import { buildGenStudioImageIdempotencyKey } from '../lib/genstudio-client.js'
import { resolveChannelReferences } from '../services/scene-reference-characters.js'
import { getEffectiveNicheFor } from '../services/niche-loader.js'
import * as jq from '../services/job-queue.js'
import { STILL_POST_BUILTIN_PRESETS, stillPostFormat, stillPostOption } from '../still-posts/catalog.js'
import {
  commitFinals,
  imagePromptFor,
  listBatchStates,
  listChannelCharacters,
  listPosts,
  brandingFor,
  lookForPost,
  renderPostFinals,
  nextPostId,
  panelArtFilename,
  panelsForOption,
  postDir,
  referenceCacheDir,
  resolveRoster,
  stillPostsConfig,
  validatePostId,
  writePost,
} from '../services/still-posts.js'
import { shortBatchMessage, writeStillPosts } from '../services/still-post-writer.js'
import { channelHandle, channelLogoPath } from '../services/still-posts.js'
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
 */
export async function createPostsFromDrafts(
  slug: string,
  batch: {
    batch_id: string
    format: StillPostFormat
    option: StillPostOption
    language: StillPostsLanguage
    aspects: StillPostAspect[]
    character_ids: string[]
  },
  drafts: ReadonlyArray<{ panels: ReadonlyArray<{ text: string; scene_prompt: string }>; caption: string }>,
): Promise<string[]> {
  const created: string[] = []
  // One scan of the channel decides the numbering; a per-draft scan would re-read every post file
  // once per post.
  const first = await nextPostId(slug)
  const startingNumber = Number(/^post-(\d+)$/.exec(first)?.[1] || '1')
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
      published_at: null,
    }
    await writePost(slug, post)
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
  /** The page's active preset branding. Absent uses the built-in preset's placement. */
  branding?: StillPostBranding
  /** The preset's type-size multiplier. */
  text_scale?: number
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

      for (const [panelIndex, panel] of post.panels.entries()) {
        const artPath = path.join(dir, panelArtFilename(panelIndex))
        if (existsSync(artPath) && !params.redraw) {
          items.push({ label: `${post.id} panel ${panelIndex + 1}`, key: artPath, state: 'kept' })
          continue
        }

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
        const aspectRatio = resolveConfiguredAspectRatio(
          modelConfig,
          masterAspectFor(post.aspects, published, ''),
        )
        const requestIdentity = `${slug}:still-post:${post.id}:p${panelIndex}`
          + (references.digests.length ? `:ref:${references.digests.join('-')}` : '')
          + (panel.image?.generation_action ? `:fresh:${panel.image.generation_action.id}` : '')
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
        const withImage: StillPost = {
          ...post,
          panels: post.panels.map((entry, position) => position !== panelIndex ? entry : {
            ...entry,
            image: {
              filename: panelArtFilename(panelIndex),
              rendered_at: new Date().toISOString(),
              sha256: createHash('sha256').update(bytes).digest('hex'),
              model_id: imageModel,
              model_label: modelConfig.label,
              prompt,
              reference_character_ids: [...post.character_ids],
              reference_names: references.names,
            },
          }),
        }
        post.panels = withImage.panels
        await writePost(slug, withImage)
        items.push({ label: `${post.id} panel ${panelIndex + 1}`, key: `${artPath}:${sourceDigests}`, state: 'drawn' })
        job.output_lines.push(`${post.id} panel ${panelIndex + 1}: drew with ${modelConfig.label}.`)
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

