import { Router } from 'express'
import * as jq from '../services/job-queue.js'
import * as pm from '../services/project-manager.js'
import fs from 'fs/promises'
import path from 'path'
import { validateBody } from '../lib/validate.js'
import { EstimateCostSchema } from '../schemas/index.js'
import type { Job } from '../models/types.js'
import { getApiKey } from '../services/app-secrets-store.js'
import {
  listChatModels,
  listImageModels,
  listTranscriptionModels,
  listVideoModels,
  quoteTts,
} from '../lib/genstudio-client.js'
import { resolveGenStudioModelId } from '../services/genstudio-model-migration.js'
import { resolveEpisodePaths } from '../services/utils.js'
import { parseNarrationDocx, type NarrationSection } from '../lib/docx-parser.js'

export const router = Router()

const APP_SLUG = '_app_'

function summarizeJobs(jobsList: Job[]) {
  return {
    running: jobsList.filter(job => job.status === 'running').length,
    queued: jobsList.filter(job => job.status === 'queued').length,
    paused: jobsList.filter(job => job.status === 'paused').length,
    done: jobsList.filter(job => job.status === 'done').length,
    error: jobsList.filter(job => job.status === 'error').length,
    total: jobsList.length,
  }
}

async function allJobScopes(): Promise<string[]> {
  const projects = await pm.listProjects()
  return [...new Set([...projects.map(project => project.slug), APP_SLUG])]
}

async function allJobsSnapshot() {
  const scopes = await allJobScopes()
  const lists = await Promise.all(scopes.map(scope => jq.getJobs(scope)))
  const jobsList = lists.flat()
  return { jobs: jobsList, stats: summarizeJobs(jobsList) }
}

// ── Job stream (SSE) ────────────────────────────────────────────────────────
/**
 * GET /projects/:slug/jobs/stream
 *
 * Server-Sent Events feed of queue state changes scoped to a single project.
 * Replaces the old 3-second poll in `useJobs` — the client sees transitions
 * the instant the queue emits them.
 *
 * On connect we push one `snapshot` event carrying the current full list +
 * stats, then stream `update`/`cleared` events as they happen. A 15-second
 * keep-alive comment (`: ping`) keeps the socket from being reaped by
 * overly-aggressive proxies. Both `jobEvents` listeners and the keepalive
 * are torn down on `req.close` so we don't leak EventEmitter subscriptions
 * when the browser navigates away.
 */
router.get('/projects/:slug/jobs/stream', async (req, res) => {
  const { slug } = req.params

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    // Disable Nginx/Nitro proxy buffering so events flush immediately.
    'X-Accel-Buffering': 'no',
  })
  // Tell EventSource to retry after 5s on disconnect.
  res.write('retry: 5000\n\n')

  function send(eventName: string, payload: unknown) {
    res.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`)
  }

  // Initial snapshot so late-subscribing clients don't miss state that's
  // already in the queue.
  try {
    const snapshot = {
      jobs: await jq.getJobs(slug),
      stats: jq.getQueueStats(slug),
    }
    send('snapshot', snapshot)
  } catch (e) {
    // If the snapshot errors we still keep the connection open — incremental
    // updates will eventually populate the client's view.
    console.error('[jobs/stream] snapshot error:', e)
  }

  const onUpdate = (job: Job) => {
    if (job.project_slug !== slug) return
    send('update', job)
  }
  const onCleared = (event: jq.JobsClearedEvent) => {
    if (event.project_slug !== slug) return
    send('cleared', event)
  }
  jq.jobEvents.on('update', onUpdate)
  jq.jobEvents.on('cleared', onCleared)

  const keepalive = setInterval(() => {
    // SSE comment — ignored by the parser but keeps intermediaries alive.
    res.write(': ping\n\n')
  }, 15000)

  req.on('close', () => {
    clearInterval(keepalive)
    jq.jobEvents.off('update', onUpdate)
    jq.jobEvents.off('cleared', onCleared)
  })
})

router.get('/projects/:slug/jobs', async (req, res) => {
  const jobsList = await jq.getJobs(req.params.slug)
  const stats = jq.getQueueStats(req.params.slug)
  res.json({ jobs: jobsList, stats })
})

// ── Universal jobs ────────────────────────────────────────────────────────
// One control-centre view across every project plus app-level library work.
// The initial snapshot loads each durable jobs.json once; after that, SSE
// carries only incremental updates, so merely having many projects does not
// create a polling loop across their folders.
router.get('/jobs/all/stream', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.write('retry: 5000\n\n')
  function send(eventName: string, payload: unknown) {
    res.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`)
  }
  try {
    send('snapshot', await allJobsSnapshot())
  } catch (error) {
    console.error('[jobs/all/stream] snapshot error:', error)
  }
  const onUpdate = (job: Job) => send('update', job)
  const onCleared = (event: jq.JobsClearedEvent) => send('cleared', event)
  jq.jobEvents.on('update', onUpdate)
  jq.jobEvents.on('cleared', onCleared)
  const keepalive = setInterval(() => res.write(': ping\n\n'), 15000)
  req.on('close', () => {
    clearInterval(keepalive)
    jq.jobEvents.off('update', onUpdate)
    jq.jobEvents.off('cleared', onCleared)
  })
})

router.get('/jobs/all', async (_req, res) => {
  res.json(await allJobsSnapshot())
})

router.post('/jobs/all/:jobId/retry', (req, res) => {
  const existing = jq.getJob(req.params.jobId)
  if (!existing) return res.status(404).json({ detail: 'Job not found' })
  const job = jq.retryTerminalJob(existing.project_slug, req.params.jobId)
  res.status(202).json({ ok: true, job })
})

router.post('/jobs/all/:jobId/pause', async (req, res) => {
  const job = await jq.pauseJob(req.params.jobId)
  if (!job) return res.status(409).json({ detail: 'Only queued, running, or paused jobs can be paused.' })
  res.json({ ok: true, job })
})

router.post('/jobs/all/:jobId/resume', async (req, res) => {
  const job = await jq.resumeJob(req.params.jobId)
  if (!job) return res.status(409).json({ detail: 'Only paused jobs can be resumed.' })
  res.status(202).json({ ok: true, job })
})

router.delete('/jobs/all/:jobId', (req, res) => {
  if (!jq.cancelJob(req.params.jobId)) {
    return res.status(400).json({ detail: 'Job not found or not cancellable' })
  }
  res.json({ ok: true })
})

router.delete('/jobs/all', async (_req, res) => {
  const scopes = await allJobScopes()
  const cleared = await Promise.all(scopes.map(scope => jq.clearFinished(scope)))
  res.json({ ok: true, cleared: cleared.reduce((total, count) => total + count, 0) })
})

// ── App-level jobs (broll_normalize, broll_autotag, etc.) ─────────────
//
// Per-project jobs filter by `project_slug` exact match in getJobs().
// App-level infrastructure jobs (B-Roll normalize / auto-tag, anything
// queued with project_slug='_app_') never showed up in any project's
// jobs panel — they were invisible to the user. v1.0.91+: separate
// endpoint + SSE stream surfaces them so the B-Roll Library page (and
// future app-level surfaces) can render their own jobs panel without
// polluting the per-project view.
router.get('/jobs/app', async (_req, res) => {
  const jobsList = await jq.getJobs(APP_SLUG)
  const stats = jq.getQueueStats(APP_SLUG)
  res.json({ jobs: jobsList, stats })
})

// v1.0.131+ — IMPORTANT: /jobs/app/stream MUST be registered BEFORE
// /jobs/app/:jobId. Express dispatches routes in registration order;
// the wildcard `:jobId` would match a literal `stream` and the handler
// would look up a (nonexistent) job called "stream", returning 404 to
// every EventSource the frontend opens. That 404 then trips the SSE
// auto-retry loop (~every 5s) and the user sees a never-ending stream
// of `Failed to load resource: …jobs/app/stream:1 (Not Found)` console
// errors. Reordered + reserved-word guard so a future re-reorder fails
// cleanly instead of silently regressing.
router.get('/jobs/app/stream', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.write('retry: 5000\n\n')
  function send(eventName: string, payload: unknown) {
    res.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`)
  }
  try {
    send('snapshot', {
      jobs: await jq.getJobs(APP_SLUG),
      stats: jq.getQueueStats(APP_SLUG),
    })
  } catch (e) {
    console.error('[jobs/app/stream] snapshot error:', e)
  }
  const onUpdate = (job: Job) => {
    if (job.project_slug !== APP_SLUG) return
    send('update', job)
  }
  const onCleared = (event: jq.JobsClearedEvent) => {
    if (event.project_slug !== APP_SLUG) return
    send('cleared', event)
  }
  jq.jobEvents.on('update', onUpdate)
  jq.jobEvents.on('cleared', onCleared)
  const keepalive = setInterval(() => res.write(': ping\n\n'), 15000)
  req.on('close', () => {
    clearInterval(keepalive)
    jq.jobEvents.off('update', onUpdate)
    jq.jobEvents.off('cleared', onCleared)
  })
})

// /jobs/app/:jobId — must come AFTER /jobs/app/stream (see comment on the
// stream route). The reserved-word guard below makes a future re-reorder
// regression fail loudly instead of silently 404-looping the SSE again.
router.get('/jobs/app/:jobId', (req, res) => {
  if (req.params.jobId === 'stream') {
    // Should be unreachable — Express picks the literal '/jobs/app/stream'
    // route ahead of this wildcard. Surface a 500 with a clear diagnostic
    // if it ever DOES land here so the route-order regression is obvious.
    return res.status(500).json({
      detail: 'Route order regression: /jobs/app/stream is being shadowed by /jobs/app/:jobId. ' +
              'Re-check routes/jobs.ts — the stream handler must be registered first.',
    })
  }
  const job = jq.getJob(req.params.jobId)
  if (!job || job.project_slug !== APP_SLUG) {
    return res.status(404).json({ detail: 'Job not found' })
  }
  res.json(job)
})

router.delete('/jobs/app', async (_req, res) => {
  const count = await jq.clearFinished(APP_SLUG)
  res.json({ ok: true, cleared: count })
})

router.get('/projects/:slug/jobs/:jobId', (req, res) => {
  const job = jq.getJob(req.params.jobId)
  if (!job || job.project_slug !== req.params.slug) {
    return res.status(404).json({ detail: 'Job not found' })
  }
  res.json(job)
})

// Retained compatibility endpoint for older renderer builds. Direct Studio Hub
// repair is retired; the saved checkpoint stays on the historical job as audit
// evidence, and the user must retry through the GenStudio-owned job identity.
router.post('/projects/:slug/jobs/:jobId/repair-hub-image', (_req, res) => {
  res.status(410).json({
    code: 'GENSTUDIO_ONLY',
    detail: 'Direct Studio Hub repair is retired. Retry the original job through GenStudio; no Hub or provider request was attempted.',
  })
})

// Queue-level Retry fallback. Specialized generator pages may still use their
// own healing endpoints, but every registered job type remains recoverable
// even when a newer executor has not yet been added to a frontend map.
router.post('/projects/:slug/jobs/:jobId/retry', (req, res) => {
  const job = jq.retryTerminalJob(req.params.slug, req.params.jobId)
  res.status(202).json({ ok: true, job })
})

router.post('/projects/:slug/jobs/:jobId/pause', async (req, res) => {
  const existing = jq.getJob(req.params.jobId)
  if (!existing || existing.project_slug !== req.params.slug) return res.status(404).json({ detail: 'Job not found' })
  const job = await jq.pauseJob(req.params.jobId)
  if (!job) return res.status(409).json({ detail: 'Only queued, running, or paused jobs can be paused.' })
  res.json({ ok: true, job })
})

router.post('/projects/:slug/jobs/:jobId/resume', async (req, res) => {
  const existing = jq.getJob(req.params.jobId)
  if (!existing || existing.project_slug !== req.params.slug) return res.status(404).json({ detail: 'Job not found' })
  const job = await jq.resumeJob(req.params.jobId)
  if (!job) return res.status(409).json({ detail: 'Only paused jobs can be resumed.' })
  res.status(202).json({ ok: true, job })
})

router.delete('/projects/:slug/jobs/:jobId', (req, res) => {
  if (!jq.cancelJob(req.params.jobId)) {
    return res.status(400).json({ detail: 'Job not found or not cancellable' })
  }
  res.json({ ok: true })
})

// Clear all finished (done/error/cancelled) jobs
router.delete('/projects/:slug/jobs', async (req, res) => {
  const count = await jq.clearFinished(req.params.slug)
  res.json({ ok: true, cleared: count })
})

// ── GenStudio credit preflight ─────────────────────────────────────────────

interface CreditEstimate {
  estimated_credits: number | null
  price_version: string | null
  pricing_basis: string
  estimated_duration: string | null
  quote_status: 'estimated' | 'exact' | 'not_applicable' | 'unavailable'
}

const DURATION_PER_1K_WORDS = 60
const DURATION_PER_IMAGE = 15

function unavailableEstimate(detail: string): CreditEstimate {
  return {
    estimated_credits: null,
    price_version: null,
    pricing_basis: detail,
    estimated_duration: null,
    quote_status: 'unavailable',
  }
}

function estimatedCredits(input: number, output: number, minimum: number): number {
  return Math.max(
    Math.max(0, minimum),
    Math.ceil((Math.max(0, input) + Math.max(0, output)) / 1_000_000),
  )
}

function selectedNarrationSections(allSections: NarrationSection[], requestedValue: unknown): NarrationSection[] {
  const requested = typeof requestedValue === 'string' && requestedValue.trim()
    ? requestedValue.trim()
    : 'all'
  if (requested === 'all') return allSections

  const selected: NarrationSection[] = []
  for (const value of requested.split(',').map(item => item.trim()).filter(Boolean)) {
    if (['intro', 'introduction'].includes(value.toLowerCase())) {
      selected.push(...allSections.filter(section => section.label.toLowerCase() === 'introduction'))
      continue
    }
    const normalized = value.replace(/^0+/, '') || '0'
    selected.push(...allSections.filter(section => {
      const sectionNumber = section.slug.replace(/\D/g, '').replace(/^0+/, '') || '0'
      return sectionNumber === normalized || section.slug === value || section.label === value
    }))
  }
  return [...new Map(selected.map(section => [section.slug, section])).values()]
}

async function getNarrationText(
  slug: string,
  episodeId: string,
  title?: string,
  sections?: unknown,
): Promise<string> {
  const paths = await resolveEpisodePaths(slug, episodeId, title || '')
  const parsed = await parseNarrationDocx(paths.narration_docx)
  return selectedNarrationSections(parsed, sections).map(section => section.text).join('\n').trim()
}

router.post('/projects/:slug/estimate-cost', validateBody(EstimateCostSchema), async (req, res) => {
  const { slug } = req.params
  const { type, params } = req.body

  if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
  const apiKey = await getApiKey('genstudio').catch(() => '')
  if (!apiKey) return res.json(unavailableEstimate('Add the scoped GenStudio API key to load a live credit estimate.'))

  try {
    const llmTypes = new Set(['script', 'introduction', 'scene_prompts', 'thumb_prompts', 'metadata'])
    if (llmTypes.has(type)) {
      const modelId = resolveGenStudioModelId('chat', String(params?.model || ''))
      if (!modelId) return res.json(unavailableEstimate('Choose an available GenStudio LLM model to calculate credits.'))
      const model = (await listChatModels(apiKey)).find(entry => entry.id === modelId && entry.available)
      if (!model || !model.price_version) return res.json(unavailableEstimate('This GenStudio LLM model does not have a published price.'))
      const totalWords = params?.total_words || (params?.length ? params.length * 150 : 5000)
      const inputTokens = 3000
      const outputTokens = Math.min(model.max_output_tokens, Math.ceil(totalWords / 0.75))
      const credits = estimatedCredits(
        inputTokens * model.input_credits_per_million_tokens
          + outputTokens * model.output_credits_per_million_tokens,
        0,
        model.minimum_credits,
      )
      const durationSec = Math.ceil((totalWords / 1000) * DURATION_PER_1K_WORDS)
      return res.json({
        estimated_credits: credits,
        price_version: model.price_version,
        pricing_basis: `~${inputTokens.toLocaleString()} input + ~${outputTokens.toLocaleString()} output tokens · ${model.display_name}`,
        estimated_duration: formatDuration(durationSec),
        quote_status: 'estimated',
      } satisfies CreditEstimate)
    }

    if (type === 'scene_images' || type === 'thumb_images' || type === 'images') {
      const modelId = resolveGenStudioModelId('image', String(params?.model || ''))
      if (!modelId) return res.json(unavailableEstimate('Choose an available GenStudio image model to calculate credits.'))
      const model = (await listImageModels(apiKey)).find(entry => entry.id === modelId && entry.available)
      if (!model || model.credits_per_image === null || !model.price_version) {
        return res.json(unavailableEstimate('This GenStudio image model does not have a published price.'))
      }
      const wantThumbs = type === 'thumb_images'
      const wantBoth = type === 'images'
      let promptCount = params?.prompt_count || 0
      if (!promptCount && params?.episode_id) {
        if (wantBoth) {
          const scenes = await countPromptsFromFile(slug, params.episode_id, false)
          const thumbs = await countPromptsFromFile(slug, params.episode_id, true)
          promptCount = scenes + thumbs
        } else {
          promptCount = await countPromptsFromFile(slug, params.episode_id, wantThumbs)
        }
      }
      if (!promptCount) promptCount = wantBoth ? 9 : wantThumbs ? 3 : 6
      const durationSec = promptCount * DURATION_PER_IMAGE
      const kind = wantBoth ? 'image(s) (scenes + thumbnails)' : wantThumbs ? 'thumbnail(s)' : 'scene(s)'
      return res.json({
        estimated_credits: Math.max(promptCount * model.credits_per_image, model.minimum_credits ?? 0),
        price_version: model.price_version,
        pricing_basis: `${promptCount} ${kind} × ${model.credits_per_image} credits · ${model.display_name}`,
        estimated_duration: formatDuration(durationSec),
        quote_status: 'estimated',
      } satisfies CreditEstimate)
    }

    if (type === 'audio') {
      if (typeof params?.voice !== 'string' || !params.voice.trim() || !params?.episode_id) {
        return res.json(unavailableEstimate('Choose a GenStudio voice and episode to calculate an exact TTS quote.'))
      }
      const narration = await getNarrationText(slug, params.episode_id, params?.title, params?.sections)
      if (!narration) return res.json(unavailableEstimate('Generate the narration before requesting its TTS quote.'))
      const chunks = narration.match(/[\s\S]{1,15000}/g) || []
      const quotes = await Promise.all(chunks.map(text => quoteTts(apiKey, {
        voiceId: params.voice.trim(),
        text,
        speed: Number.isFinite(params?.speed) ? params.speed : 1,
      })))
      if (!quotes.length) return res.json(unavailableEstimate('Generate the narration before requesting its TTS quote.'))
      const quote = quotes[0]!
      if (quotes.some(entry => entry.price_version !== quote.price_version)) {
        return res.json(unavailableEstimate('GenStudio changed the TTS price during this estimate. Please review the new quote and try again.'))
      }
      const totalCredits = quotes.reduce((sum, entry) => sum + entry.credits, 0)
      const totalCharacters = quotes.reduce((sum, entry) => sum + entry.billable_characters, 0)
      const totalDurationMs = quotes.reduce((sum, entry) => sum + entry.estimated_duration_ms, 0)
      return res.json({
        estimated_credits: totalCredits,
        price_version: quote.price_version,
        pricing_basis: `${totalCharacters.toLocaleString()} characters across ${quotes.length} TTS segment${quotes.length === 1 ? '' : 's'} · selected voice at ${quote.speed}×`,
        estimated_duration: formatDuration(Math.ceil(totalDurationMs / 1_000)),
        quote_status: 'exact',
      } satisfies CreditEstimate)
    }

    if (type === 'transcription') {
      const modelId = resolveGenStudioModelId('transcription', String(params?.model || ''))
      const durationSeconds = Number(params?.duration_seconds)
      if (!modelId || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        return res.json(unavailableEstimate('Select a GenStudio transcription model and audio file to calculate credits.'))
      }
      const model = (await listTranscriptionModels(apiKey)).find(entry => entry.id === modelId && entry.available)
      if (!model || !model.price_version) return res.json(unavailableEstimate('This GenStudio transcription model does not have a published price.'))
      return res.json({
        estimated_credits: Math.max(Math.ceil((durationSeconds / 60) * model.credits_per_minute), model.minimum_credits),
        price_version: model.price_version,
        pricing_basis: `~${Math.ceil(durationSeconds)} seconds × ${model.credits_per_minute} credits/minute · ${model.display_name}`,
        estimated_duration: formatDuration(Math.ceil(durationSeconds)),
        quote_status: 'estimated',
      } satisfies CreditEstimate)
    }

    if (type === 'video') {
      const modelId = resolveGenStudioModelId('video', String(params?.model || ''))
      const duration = Number(params?.duration_seconds ?? params?.duration)
      const resolution = params?.resolution
      if (!modelId || (duration !== 5 && duration !== 10) || (resolution !== '720p' && resolution !== '1080p')) {
        return res.json(unavailableEstimate('Choose a GenStudio video model, duration, and resolution to calculate credits.'))
      }
      const model = (await listVideoModels(apiKey)).find(entry => entry.id === modelId && entry.available)
      const variant = model?.variants.find(entry => entry.duration_seconds === duration && entry.resolution === resolution)
      if (!model || !variant) return res.json(unavailableEstimate('This GenStudio video variant does not have a published price.'))
      const count = Math.max(1, Number(params?.count) || 1)
      return res.json({
        estimated_credits: Math.max(count * variant.credits_per_video, variant.minimum_credits),
        price_version: variant.price_version,
        pricing_basis: `${count} × ${duration}s ${resolution} video · ${model.display_name}`,
        estimated_duration: null,
        quote_status: 'estimated',
      } satisfies CreditEstimate)
    }
  } catch (e: any) {
    return res.json(unavailableEstimate(`Could not load the GenStudio credit estimate: ${e?.message || 'unknown error'}`))
  }

  res.json({
    estimated_credits: 0,
    price_version: null,
    pricing_basis: 'This action does not submit a GenStudio generation job.',
    estimated_duration: null,
    quote_status: 'not_applicable',
  } satisfies CreditEstimate)
})

// ── Helpers ────────────────────────────────────────────────────────────────

function formatDuration(seconds: number): string {
  if (seconds < 60) return `~${seconds}s`
  const mins = Math.ceil(seconds / 60)
  return mins === 1 ? '~1 min' : `~${mins} min`
}

async function countPromptsFromFile(slug: string, episodeId: string, isThumbnails: boolean): Promise<number> {
  const code = episodeId.toUpperCase()
  const outputRoot = await pm.getProjectOutputRoot(slug)
  if (!outputRoot) return 0

  // Accept .md (current) and legacy .docx, separate file or old combined.
  const stem = isThumbnails ? `${code}_Thumbnail_Prompts` : `${code}_Scene_Prompts`
  const names = new Set([
    `${stem}.md`, `${stem}.docx`,
    `${code}_Image_Prompts.md`, `${code}_Image_Prompts.docx`,
  ])

  // Search recursively for the file
  async function findFile(dir: string): Promise<string | null> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      for (const e of entries) {
        const fp = path.join(dir, e.name)
        if (e.isFile() && names.has(e.name)) return fp
        if (e.isDirectory()) {
          const found = await findFile(fp)
          if (found) return found
        }
      }
    } catch { /* skip */ }
    return null
  }

  const file = await findFile(outputRoot)
  if (!file) return 0

  try {
    const { parseImagePromptsDocx } = await import('../lib/docx-parser.js')
    const parsed = await parseImagePromptsDocx(file)
    return isThumbnails ? parsed.thumbnails.length : parsed.scenes.length
  } catch { return 0 }
}
