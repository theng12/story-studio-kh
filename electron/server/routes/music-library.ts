/**
 * Routes for the v1.4.37 music library — a channel's record collection.
 *
 *   GET    /api/projects/:slug/music-library                  — every track
 *   PATCH  /api/projects/:slug/music-library/tracks/:filename — title / enabled / tags
 *   DELETE /api/projects/:slug/music-library/tracks/:filename — remove from disk
 *   POST   /api/projects/:slug/music-library/generate         — top up (SPENDS CREDITS)
 *   POST   /api/projects/:slug/music-library/preview-mix      — what a mix would use (FREE)
 *   POST   /api/projects/:slug/music-library/render           — build the video (FREE)
 *
 * NOT the same thing as `/music-pool`, which stays exactly as it is for the
 * background bed that ducks under narration. Two pages, two jobs, per the
 * owner's ruling — merging the folders would put a narration bed into a mix.
 *
 * ONE ROUTE SPENDS MONEY and it is named for what it does. `preview-mix` and
 * `render` read the library and nothing else, which is what lets the page show
 * a full tracklist and a runtime before anything is committed to.
 */

import { Router } from 'express'
import * as pm from '../services/project-manager.js'
import * as jq from '../services/job-queue.js'
import * as im from '../services/idea-manager.js'
import * as lib from '../services/music-library.js'
import { DEFAULT_MIX_RULES, buildMusicMix, renderTracklist, type MixCandidate } from '../services/music-mix.js'
import { humanizeBackendError } from '../lib/humanize-backend-error.js'
import { withLock } from '../lib/atomic-store.js'
import {
  freshActionFingerprint,
  freshActionMatch,
  readManualGenerationRedoIntent,
  readOperationId,
  stampFreshGenerationAction,
} from '../lib/fresh-generation-action.js'
import { getApiKey } from '../services/app-secrets-store.js'
import { listMusicModels, type GenStudioMusicModel } from '../lib/genstudio-client.js'
import {
  readMusicLibraryItemsCheckpoint,
  type MusicLibraryItemReceipt as MusicItem,
} from '../generators/music-generate.js'
import { musicModelCanServe } from '../contracts/music-model-choice.js'
import type { Job, JobType } from '../models/types.js'

export const router = Router()

const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type MusicEvidence = NonNullable<Job['genstudio_jobs']>[number]
function musicItems(job: Readonly<Job>): MusicItem[] | null {
  try {
    return readMusicLibraryItemsCheckpoint(job)?.items || null
  } catch {
    return null
  }
}

function evidenceKey(entry: MusicEvidence): string | null {
  const values = [entry.request_key, entry.request?.idempotency_key]
    .filter((value): value is string => typeof value === 'string' && !!value)
  return values.length && new Set(values).size === 1 ? values[0]! : null
}

function unresolvedMusicEvidence(entry: MusicEvidence): boolean {
  if (entry.operation !== 'music.generation') return false
  if (entry.queue_state === 'not_created' || entry.queue_state === 'waiting_credits') return false
  if (entry.state === 'succeeded' || entry.state === 'cancelled') return false
  if (entry.state === 'failed' && entry.recovery_required !== true) return false
  return entry.dispatch_state === 'dispatched' || entry.state === 'running'
    || entry.state === 'accepted' || entry.state === 'reserved'
    || entry.state === 'reconciling' || entry.recovery_required === true
}

function itemHasCurrentUnknownEvidence(item: MusicItem, entries: readonly MusicEvidence[]): boolean {
  const matching = entries.filter(entry => evidenceKey(entry) === item.idempotency_key
    || (!!item.accepted_task_id && entry.id === item.accepted_task_id))
  return matching.length === 1
    && evidenceKey(matching[0]!) === item.idempotency_key
    && (!item.accepted_task_id || matching[0]!.id === item.accepted_task_id)
    && unresolvedMusicEvidence(matching[0]!)
}

function musicResourceIdentity(job: Readonly<Job>, item: MusicItem): string {
  return `music-library:${String(job.params?.brief_id || '')}:${item.item_key}`
}

function manualClientFingerprint(body: Record<string, unknown>, sourceJobId: string, sourceItemKey: string): string {
  const value: Record<string, unknown> = {
    model: String(body.model || '').trim(),
    instrumental: body.instrumental !== false,
    source_item_key: sourceItemKey,
    manual_redo: { intent: 'replace_unresolved', source_job_id: sourceJobId },
    manual_music_payment: structuredClone(body.manual_music_payment),
  }
  const requestedSeconds = Number(body.duration_seconds)
  if (value.instrumental && Number.isFinite(requestedSeconds) && requestedSeconds > 0) {
    value.duration_seconds = Math.max(10, Math.min(1800, Math.round(requestedSeconds)))
  }
  return freshActionFingerprint(value)
}

function priceClass(model: GenStudioMusicModel): 'free' | 'paid' | 'unknown' {
  const published = model as GenStudioMusicModel & { chargeable?: boolean }
  if (published.chargeable === true || model.credits_per_request > 0 || model.minimum_credits > 0
    || (typeof model.standard_credits === 'number' && model.standard_credits > 0)
    || (typeof model.sale_credits === 'number' && model.sale_credits > 0)
    || Object.values(model.price_usd || {}).some(value => value > 0)
    || (model.price_variants || []).some(value => typeof value.usd === 'number' && value.usd > 0)) return 'paid'
  if (published.chargeable === false) return 'free'
  if (model.price_source === 'local' && model.credits_per_request === 0 && model.minimum_credits === 0
    && (model.standard_credits === null || model.standard_credits === 0)
    && (model.sale_credits === null || model.sale_credits === 0)
    && !Object.values(model.price_usd || {}).some(value => value !== 0)
    && !(model.price_variants || []).some(value => typeof value.usd !== 'number' || value.usd !== 0)) return 'free'
  return 'unknown'
}

function manualMusicTextLimitError(model: GenStudioMusicModel, item: MusicItem): string | null {
  const titleCharacters = item.request.title.length
  const promptCharacters = item.request.prompt.length
  const lyricsCharacters = item.request.lyrics?.length || 0
  const hasLyrics = lyricsCharacters > 0
  const promptMaximum = !hasLyrics && Number.isInteger(model.max_prompt_without_lyrics_characters)
    ? model.max_prompt_without_lyrics_characters as number
    : model.max_prompt_characters
  const refusal = (field: string, actual: number, limit: number): string =>
    `${model.display_name} accepts up to ${limit.toLocaleString()} ${field} characters; `
    + `this saved item has ${actual.toLocaleString()}. Nothing was queued, and the earlier evidence was kept.`
  const minimumRefusal = (field: string, actual: number, limit: number): string =>
    `${model.display_name} requires at least ${limit.toLocaleString()} ${field} characters; `
    + `this saved item has ${actual.toLocaleString()}. Nothing was queued, and the earlier evidence was kept.`
  const promptMinimum = Number.isInteger(model.min_prompt_characters) && model.min_prompt_characters! >= 0
    ? model.min_prompt_characters as number
    : null
  const lyricsMinimum = Number.isInteger(model.min_lyrics_characters) && model.min_lyrics_characters! >= 0
    ? model.min_lyrics_characters as number
    : null
  if (titleCharacters > model.max_title_characters) {
    return refusal('title', titleCharacters, model.max_title_characters)
  }
  if (promptMinimum !== null && promptCharacters < promptMinimum) {
    return minimumRefusal(hasLyrics ? 'prompt' : 'prompt without lyrics', promptCharacters, promptMinimum)
  }
  if (promptCharacters > promptMaximum) {
    return refusal(hasLyrics ? 'prompt' : 'prompt without lyrics', promptCharacters, promptMaximum)
  }
  if (hasLyrics && lyricsMinimum !== null && lyricsCharacters < lyricsMinimum) {
    return minimumRefusal('lyrics', lyricsCharacters, lyricsMinimum)
  }
  if (hasLyrics && lyricsCharacters > model.max_lyrics_characters) {
    return refusal('lyrics', lyricsCharacters, model.max_lyrics_characters)
  }
  return null
}

function acceptedManualMusicReplay(
  job: Readonly<Job>, operationId: string, clientFingerprint: string,
  sourceJobId: string, sourceItemKey: string, modelId: string,
): boolean {
  const redo = job.params?.manual_redo
  const action = job.params?.generation_action
  const binding = action?.manual_redo_binding
  return job.type === 'music_generate' && job.episode_id === ''
    && action?.id === operationId && action?.kind === 'fresh'
    && typeof job.params?.generation_action_fingerprint === 'string'
    && redo?.version === 1 && redo?.intent === 'replace_unresolved' && redo?.lane === 'music-library'
    && redo?.source_job_id === sourceJobId && redo?.source_item_key === sourceItemKey
    && redo?.selected_model_id === modelId && redo?.client_request_fingerprint === clientFingerprint
    && binding?.version === 1 && binding?.source_type === 'music_generate'
    && binding?.operation === 'music.generation' && binding?.resource_kind === 'custom'
    && binding?.resource_identity === redo?.resource_identity
    && binding?.destination_type === 'music_generate' && binding?.destination_episode_id === ''
}

async function requireProject(slug: string): Promise<boolean> {
  return !!(await pm.getProject(slug))
}

router.get('/projects/:slug/music-library', async (req, res) => {
  try {
    if (!await requireProject(req.params.slug)) return res.status(404).json({ detail: 'Project not found' })
    res.json(await lib.listLibrary(req.params.slug))
  } catch (e: any) {
    res.status(e?.statusCode || 500).json(humanizeBackendError(e, 'Could not read the music library'))
  }
})

router.get('/projects/:slug/music-library/manual-redo-sources', async (req, res) => {
  try {
    const slug = req.params.slug
    if (!await requireProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const jobs = await jq.findJobs(slug, () => true)
    const sources = jobs.flatMap(job => {
      if (job.type !== 'music_generate' || job.episode_id !== '') return []
      const items = musicItems(job)
      if (!items) return []
      return items.map(item => {
        let eligible = true
        let reason = 'Unresolved Gateway music request'
        if (job.params?.song_pool === true) {
          eligible = false
          reason = 'This item belongs to the Song Pool, not the Music Library.'
        } else if (job.status !== 'error' && job.status !== 'cancelled') {
          eligible = false
          reason = 'The source Music Library job has not stopped.'
        } else if (!itemHasCurrentUnknownEvidence(item, job.genstudio_jobs || [])) {
          eligible = false
          reason = 'No exact unresolved Gateway music evidence remains for this item.'
        }
        return {
          source_job_id: job.job_id,
          source_item_key: item.item_key,
          label: item.plan.title,
          eligible,
          reason,
        }
      })
    })
    res.json({ sources })
  } catch (e: any) {
    res.status(e?.statusCode || 500).json(humanizeBackendError(e, 'Could not read Music Library replacement sources'))
  }
})

router.patch('/projects/:slug/music-library/tracks/:filename', async (req, res) => {
  try {
    if (!await requireProject(req.params.slug)) return res.status(404).json({ detail: 'Project not found' })
    const patch: Record<string, unknown> = {}
    if (typeof req.body?.title === 'string') patch.title = req.body.title.trim().slice(0, 200)
    if (typeof req.body?.enabled === 'boolean') patch.enabled = req.body.enabled
    if (Array.isArray(req.body?.tags)) patch.tags = req.body.tags.map(String).slice(0, 12)
    await lib.upsertTrackMeta(req.params.slug, req.params.filename, patch)
    res.json(await lib.listLibrary(req.params.slug))
  } catch (e: any) {
    res.status(e?.statusCode || 500).json(humanizeBackendError(e, 'Could not update the track'))
  }
})

router.delete('/projects/:slug/music-library/tracks/:filename', async (req, res) => {
  try {
    if (!await requireProject(req.params.slug)) return res.status(404).json({ detail: 'Project not found' })
    await lib.removeTrack(req.params.slug, req.params.filename)
    res.json(await lib.listLibrary(req.params.slug))
  } catch (e: any) {
    res.status(e?.statusCode || 500).json(humanizeBackendError(e, 'Could not remove the track'))
  }
})

/**
 * Top up the library. THE ONLY ROUTE HERE THAT SPENDS CREDITS.
 *
 * `count` is how many TRACKS to plan. Each request returns every variation the
 * model produces — measured at two for the published Suno route — so the number
 * of tracks that arrive is usually higher than the number of requests paid for,
 * and every one of them is kept.
 */
router.post('/projects/:slug/music-library/generate', async (req, res) => {
  try {
    const slug = req.params.slug
    if (!await requireProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    let manualRedo
    try {
      manualRedo = readManualGenerationRedoIntent(req.body)
    } catch (error) {
      return res.status(400).json({ detail: error instanceof Error ? error.message : 'Invalid manual replacement.' })
    }
    if (manualRedo) {
      let operationId: string
      try {
        operationId = readOperationId(req.body, true)!
      } catch (error) {
        return res.status(400).json({ detail: error instanceof Error ? error.message : 'Invalid operation_id.' })
      }
      const sourceItemKey = typeof req.body?.source_item_key === 'string' ? req.body.source_item_key.trim() : ''
      const modelId = typeof req.body?.model === 'string' ? req.body.model.trim() : ''
      if (!sourceItemKey || !modelId) return res.status(400).json({ detail: 'Choose one unresolved item and one music model.' })
      const payment = req.body?.manual_music_payment
      if (!payment || typeof payment !== 'object' || Array.isArray(payment)
        || Object.keys(payment).some(key => !['version', 'model_id', 'price_version', 'confirmed_paid_music'].includes(key))
        || payment.version !== 1 || payment.model_id !== modelId
        || typeof payment.price_version !== 'string' || typeof payment.confirmed_paid_music !== 'boolean') {
        return res.status(409).json({ detail: 'Confirm the current published music price for this exact model.' })
      }
      const instrumental = req.body?.instrumental !== false
      const requestedSeconds = Number(req.body?.duration_seconds)
      const durationSeconds = instrumental && Number.isFinite(requestedSeconds) && requestedSeconds > 0
        ? Math.max(10, Math.min(1800, Math.round(requestedSeconds)))
        : undefined
      const clientFingerprint = manualClientFingerprint(req.body, manualRedo.source_job_id, sourceItemKey)

      return withLock(`fresh-music-library:${slug}:${operationId}`, async () => {
        const previous = (await jq.findJobs(slug, freshActionMatch(operationId)))[0]
        if (previous) {
          if (!acceptedManualMusicReplay(previous, operationId, clientFingerprint,
            manualRedo.source_job_id, sourceItemKey, modelId)) {
            return res.status(409).json({ detail: 'This operation_id already belongs to a different Music Library action.' })
          }
          return res.status(200).json({ ...previous, reused: true })
        }

        const source = (await jq.findJobs(slug, job => job.job_id === manualRedo.source_job_id))[0]
        const item = source && musicItems(source)?.find(candidate => candidate.item_key === sourceItemKey)
        if (!source || !item || source.type !== 'music_generate' || source.episode_id !== ''
          || source.params?.song_pool === true) {
          return res.status(409).json({ detail: 'The selected item is not a durable Music Library source.' })
        }

        const apiKey = await getApiKey('genstudio').catch(() => '')
        const catalog = apiKey ? await listMusicModels(apiKey) : []
        const model = catalog.find(candidate => candidate.id === modelId)
        if (!model || model.coming_soon || model.locked) {
          return res.status(409).json({ detail: 'The selected music model is not currently available.' })
        }
        if (!musicModelCanServe(model, {
          instrumental,
          hasLyrics: !!item.plan.lyrics?.trim(),
        })) {
          return res.status(409).json({
            detail: 'The selected music model cannot make this saved item with its current lyrics and instrumental choice.',
          })
        }
        const limitError = manualMusicTextLimitError(model, item)
        if (limitError) return res.status(409).json({ detail: limitError })
        if (!model.price_version || payment.price_version !== model.price_version) {
          return res.status(409).json({ detail: 'The published music price changed. Review it and confirm again.' })
        }
        const charge = priceClass(model)
        if (charge === 'unknown') {
          return res.status(409).json({ detail: 'This model has no clear published free or paid price. No music was queued.' })
        }
        if (charge === 'paid' && payment.confirmed_paid_music !== true) {
          return res.status(409).json({ detail: 'Confirm this separate paid music request before it is queued.' })
        }

        const resourceIdentity = musicResourceIdentity(source, item)
        const params = stampFreshGenerationAction({
          brief: item.plan.prompt,
          count: 1,
          model: modelId,
          planner_model: '',
          instrumental,
          ...(durationSeconds ? { duration_seconds: durationSeconds } : {}),
          brief_id: operationId,
          music_library_manual_item: {
            version: 1 as const,
            source_job_id: source.job_id,
            source_item_key: item.item_key,
            plan: structuredClone(item.plan),
          },
          manual_redo: {
            version: 1 as const,
            intent: manualRedo.intent,
            source_job_id: source.job_id,
            source_item_key: item.item_key,
            source_brief_id: String(source.params?.brief_id || ''),
            lane: 'music-library',
            selected_model_id: modelId,
            client_request_fingerprint: clientFingerprint,
            resource_identity: resourceIdentity,
            requested_at: new Date().toISOString(),
            payment: {
              version: 1 as const,
              model_id: model.id,
              price_version: model.price_version,
              charge_class: charge,
              credits_per_request: model.credits_per_request,
              minimum_credits: model.minimum_credits,
              price_source: model.price_source,
              price_usd: structuredClone(model.price_usd),
              price_variants: structuredClone(model.price_variants),
            },
          },
        }, operationId)
        try {
          const job = await jq.enqueueManualGenerationRedo({
            project_slug: slug,
            type: 'music_generate',
            episode_id: '',
            title: `Music Library separate attempt — ${item.plan.title}`,
            params,
          }, {
            sourceJobId: source.job_id,
            sourceType: 'music_generate',
            operation: 'music.generation',
            resource: {
              kind: 'custom',
              identity: resourceIdentity,
              matches: candidate => candidate.params?.song_pool !== true
                && musicItems(candidate)?.some(candidateItem => candidateItem.item_key === item.item_key
                  && candidateItem.idempotency_key === item.idempotency_key
                  && candidateItem.request_identity === item.request_identity) === true,
            },
            sourceLabel: 'Music Library generation item',
            evidenceLabel: 'Gateway music request',
            hasCurrentEvidence: (candidate, entries) => {
              const current = musicItems(candidate)?.find(candidateItem => candidateItem.item_key === item.item_key)
              return !!current && current.idempotency_key === item.idempotency_key
                && current.request_identity === item.request_identity
                && itemHasCurrentUnknownEvidence(current, entries)
            },
          })
          return res.status(201).json(job)
        } catch (error: any) {
          return res.status(error?.status || error?.statusCode || 409).json({
            detail: error?.message || 'The separate Music Library attempt was refused.',
          })
        }
      })
    }
    const brief = String(req.body?.brief || '').trim()
    if (!brief) return res.status(400).json({ detail: 'Describe the sound you want.' })
    const count = Math.max(1, Math.min(100, Math.round(Number(req.body?.count) || 1)))
    const operationId = typeof req.body?.operation_id === 'string' ? req.body.operation_id.trim() : ''
    if (!OPERATION_ID.test(operationId)) return res.status(400).json({ detail: 'operation_id must be a UUID for a music top-up.' })
    const model = String(req.body?.model || '')
    const plannerModel = String(req.body?.planner_model || '')
    const instrumental = req.body?.instrumental !== false
    // Track length for an instrumental model (seconds). A singing model's length follows its lyrics,
    // so a value sent with vocals is simply ignored. Bounded here; the model's own bounds are applied
    // (and explained in the job log) when the job runs.
    const requestedSeconds = Number(req.body?.duration_seconds)
    const durationSeconds = instrumental && Number.isFinite(requestedSeconds) && requestedSeconds > 0
      ? Math.max(10, Math.min(1800, Math.round(requestedSeconds)))
      : undefined
    const sameActionRequest = (candidate: any) => candidate.type === 'music_generate'
      && candidate.params?.generation_action?.id === operationId
      && candidate.params?.brief === brief
      && candidate.params?.count === count
      && candidate.params?.model === model
      && candidate.params?.planner_model === plannerModel
      && candidate.params?.instrumental === instrumental
      && candidate.params?.duration_seconds === durationSeconds
    const actionJobs = await jq.findJobs(slug, job =>
      job.type === 'music_generate'
      && job.params?.generation_action?.id === operationId,
    )
    if (actionJobs.length) {
      const existing = actionJobs[0]!
      if (!sameActionRequest(existing)) return res.status(409).json({ detail: 'operation_id already belongs to a different music top-up.' })
      return res.status(201).json({ ...existing, reused: true })
    }
    let job: Awaited<ReturnType<typeof jq.enqueue>>
    try {
      job = await jq.enqueue({
        project_slug: slug,
        type: 'music_generate' as JobType,
        episode_id: '',
        title: `Music library top-up (${count} track${count === 1 ? '' : 's'})`,
        params: {
          brief,
          count,
          model,
          planner_model: plannerModel,
          instrumental,
          ...(durationSeconds ? { duration_seconds: durationSeconds } : {}),
          generation_action: { id: operationId, kind: 'fresh' },
          brief_id: operationId,
        },
      })
    } catch (error) {
      if (error instanceof jq.DuplicateJobError) {
        const replay = (await jq.findJobs(slug, candidate =>
          candidate.type === 'music_generate'
          && candidate.params?.generation_action?.id === operationId,
        ))[0]
        if (replay && sameActionRequest(replay)) return res.status(201).json({ ...replay, reused: true })
        if (replay) return res.status(409).json({ detail: 'operation_id already belongs to a different music top-up.' })
        return res.status(409).json({ detail: 'A music top-up is already queued or running.' })
      }
      throw error
    }
    res.status(201).json(job)
  } catch (e: any) {
    res.status(e?.statusCode || 500).json(humanizeBackendError(e, 'Could not start the music top-up'))
  }
})

/**
 * What a mix WOULD use. Reads the library; buys nothing; changes nothing.
 *
 * This exists so the page can show the whole tracklist, the real runtime, and
 * any shortfall BEFORE the owner commits — the same reasoning as showing a
 * cost before a purchase rather than after it.
 */
router.post('/projects/:slug/music-library/preview-mix', async (req, res) => {
  try {
    const slug = req.params.slug
    if (!await requireProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const targetSeconds = Math.max(60, Math.round(Number(req.body?.target_seconds) || 3600))
    const seed = String(req.body?.episode_id || 'preview')
    const state = await lib.listLibrary(slug)
    const candidates: MixCandidate[] = state.tracks.map(track => ({
      filename: track.filename,
      title: track.title,
      duration_sec: track.duration_sec || 0,
      enabled: track.enabled,
      ...(track.sibling_group ? { sibling_group: track.sibling_group } : {}),
      times_used: track.times_used,
    }))
    const plan = buildMusicMix(candidates, targetSeconds, seed, {
      ...DEFAULT_MIX_RULES,
      siblingGapTracks: Number.isInteger(req.body?.sibling_gap_tracks)
        ? req.body.sibling_gap_tracks
        : DEFAULT_MIX_RULES.siblingGapTracks,
    })
    res.json({ ...plan, tracklist: renderTracklist(plan) })
  } catch (e: any) {
    res.status(e?.statusCode || 500).json(humanizeBackendError(e, 'Could not plan the mix'))
  }
})

/** Build the video. Reads the library; buys nothing. */
router.post('/projects/:slug/music-library/render', async (req, res) => {
  try {
    const slug = req.params.slug
    if (!await requireProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const episodeId = String(req.body?.episode_id || '').trim()
    if (!episodeId) return res.status(400).json({ detail: 'Type the episode code this video is for.' })
    // A typo here used to create a stray "<code> - " folder and render into it.
    if (!(await im.getIdeas(slug, 'accepted')).some(idea => idea.episode_code === episodeId)) {
      return res.status(400).json({ detail: `There is no episode ${episodeId} in this project. Check the code (for example EP0001) and try again.` })
    }
    const backgroundPath = String(req.body?.background_path || '').trim()
    if (!backgroundPath) return res.status(400).json({ detail: 'Choose a background for this video.' })
    if (jq.isDuplicate(slug, episodeId, 'music_video' as JobType)) {
      return res.status(409).json({ detail: `A music video is already queued for ${episodeId}` })
    }
    const job = await jq.enqueue({
      project_slug: slug,
      type: 'music_video' as JobType,
      episode_id: episodeId,
      title: `Music video — ${episodeId} (no credits)`,
      params: {
        episode_id: episodeId,
        target_seconds: Math.max(60, Math.round(Number(req.body?.target_seconds) || 3600)),
        background_path: backgroundPath,
        sibling_gap_tracks: Number.isInteger(req.body?.sibling_gap_tracks)
          ? req.body.sibling_gap_tracks
          : DEFAULT_MIX_RULES.siblingGapTracks,
        crossfade_sec: Number(req.body?.crossfade_sec) || 0,
        description_footer: String(req.body?.description_footer || ''),
      },
    })
    res.status(201).json(job)
  } catch (e: any) {
    res.status(e?.statusCode || 500).json(humanizeBackendError(e, 'Could not start the music video'))
  }
})
