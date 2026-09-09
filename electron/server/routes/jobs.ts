import { Router } from 'express'
import fs from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import * as jq from '../services/job-queue.js'
import * as pm from '../services/project-manager.js'
import { JOB_TYPES, type Job, type JobType } from '../models/types.js'
import { episodeRecoveryStep, recoverEpisode } from '../services/episode-recovery.js'
import { inspectScenePromptIntegrity } from '../services/scene-prompt-integrity.js'
import { resolveEpisodePathsByCode, resolveScenePlanPath } from '../services/utils.js'
import { scenePromptPackOutputContract } from '../lib/story-output-contracts.js'

export const router = Router()

const APP_SLUG = '_app_'
const JOB_TYPE_SET = new Set<string>(JOB_TYPES)

type ResumePausedBody = { project_slug?: string; type?: JobType }
type HistoryClearQuery = { status?: jq.JobHistoryClearStatus }

function parseHistoryClearQuery(query: unknown): { value: HistoryClearQuery } | { error: string } {
  if (!query || typeof query !== 'object' || Array.isArray(query)) return { error: 'Invalid query.' }
  const status = (query as Record<string, unknown>).status
  if (status === undefined) return { value: {} }
  if (status === 'finished' || status === 'failed') return { value: { status } }
  return { error: 'status must be "finished" or "failed".' }
}

function parseResumePausedBody(
  body: unknown,
  allowedKeys: readonly (keyof ResumePausedBody)[],
): { value: ResumePausedBody } | { error: string } {
  const value = body === undefined ? {} : body
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'Request body must be an object.' }
  }
  const record = value as Record<string, unknown>
  if (Object.keys(record).some(key => !allowedKeys.includes(key as keyof ResumePausedBody))) {
    return { error: 'Request body contains unsupported fields.' }
  }
  if ('type' in record && (typeof record.type !== 'string' || !JOB_TYPE_SET.has(record.type))) {
    return { error: 'Unknown job type.' }
  }
  if ('project_slug' in record && typeof record.project_slug !== 'string') {
    return { error: 'project_slug must be a string.' }
  }
  return { value: record as ResumePausedBody }
}

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

async function findUniversalJob(jobId: string): Promise<Job | undefined> {
  return (await allJobsSnapshot()).jobs.find(job => job.job_id === jobId)
}

function sendJobControlError(res: import('express').Response, error: unknown): boolean {
  if (!(error instanceof jq.JobControlError)) return false
  res.status(error.status).json({
    code: error.code,
    control: error.control,
    detail: error.message,
  })
  return true
}

function sendTerminalOnlyConflict(res: import('express').Response, job: Job): void {
  res.status(409).json({
    code: job.control?.code,
    control: job.control,
    detail: 'Only finished jobs can be removed from history.',
  })
}

const SCENE_PROMPT_WRITER_FLAGS = [
  'force',
  'prompt_limit',
  'target_scene_count',
  'regenerate_prompt_scene_id',
  'reword_prompt',
  'replan_scene_id',
  'regenerate_motion_prompt_scene_id',
  'regenerate_empty_motion_prompts',
  'generate_motion_prompts',
  'motion_level',
  'planning_mode',
  'window_size',
  'cross_window_context',
  'skip_intro',
  'scene_prompt_recoveries',
] as const

export interface ScenePromptRecoveryDescriptor {
  idempotency_key: string
  scene_ids: string[]
}

function scenePromptIdsFromExactPreview(responseFormat: string | undefined): string[] | null {
  if (!responseFormat) return null
  let parsed: any
  try { parsed = JSON.parse(responseFormat) } catch { return null }
  const ids = parsed?.json_schema?.schema?.properties?.results?.items?.properties?.scene_id?.enum
  if (!Array.isArray(ids) || !ids.length || ids.some((id: unknown) => typeof id !== 'string' || !id.trim())) return null
  const unique = [...new Set(ids)]
  if (unique.length !== ids.length) return null
  const contract = scenePromptPackOutputContract(unique, 'visual')
  if (contract.mode !== 'json_object') return null
  const exact = {
    type: 'json_schema',
    json_schema: { name: 'story_scene_prompt_pack', strict: true, schema: contract.schema },
  }
  return isDeepStrictEqual(parsed, exact) ? unique : null
}

export function scenePromptAutoRepairRecoveries(job: Job, missingIds: readonly string[]): ScenePromptRecoveryDescriptor[] {
  const missing = new Set(missingIds)
  const recoveries: ScenePromptRecoveryDescriptor[] = []
  const newestFirst = [...(job.genstudio_jobs || [])].sort((left, right) => (
    right.updated_at.localeCompare(left.updated_at) || right.id.localeCompare(left.id)
  ))
  for (const entry of newestFirst) {
    if (entry.operation !== 'chat.response' || entry.state !== 'succeeded') continue
    const key = entry.request?.idempotency_key?.trim()
    const sceneIds = scenePromptIdsFromExactPreview(entry.request?.response_format)
    if (!key || !sceneIds) continue
    const relevant = sceneIds.filter(id => missing.has(id))
    if (!relevant.length) continue
    recoveries.push({ idempotency_key: key, scene_ids: sceneIds })
  }
  return recoveries
}

export function scenePromptAutoRepairParams(
  original: Record<string, unknown>,
  episodeId: string,
  recoveries: readonly ScenePromptRecoveryDescriptor[] = [],
): Record<string, unknown> {
  const params = structuredClone(original)
  for (const key of SCENE_PROMPT_WRITER_FLAGS) delete params[key]
  return {
    ...params,
    episode_id: episodeId,
    stage: 'visual',
    regenerate_empty_prompts: true,
    auto_repair_missing_prompts: true,
    ...(recoveries.length ? { scene_prompt_recoveries: structuredClone(recoveries) } : {}),
  }
}

async function scenePromptAutoRepairMissing(job: Job): Promise<string[]> {
  if (job.type !== 'scene_plan_run') {
    throw Object.assign(new Error('Paid prompt auto-repair is available only for Scene Plan jobs.'), { status: 409, expose: true })
  }
  const params = (job.params || {}) as Record<string, unknown>
  const wasVisualPromptWork = params.stage === 'visual'
    || params.regenerate_empty_prompts === true
    || typeof params.regenerate_prompt_scene_id === 'string'
    || (params.stage == null && Array.isArray(params.pipeline_chain))
  if (
    !wasVisualPromptWork
    || params.stage === 'timeline'
    || params.stage === 'motion'
    || params.model === 'deterministic-timeline'
    || typeof params.replan_scene_id === 'string'
    || params.regenerate_empty_motion_prompts === true
    || typeof params.regenerate_motion_prompt_scene_id === 'string'
  ) {
    throw Object.assign(new Error('This Scene Plan job was not visual-prompt work. Use Retry for the original step.'), { status: 409, expose: true })
  }
  if (typeof params.model !== 'string' || !params.model.trim()) {
    throw Object.assign(new Error('The original Scene Plan job has no saved model. Use Retry to choose the current model.'), { status: 409, expose: true })
  }
  try {
    const paths = await resolveEpisodePathsByCode(job.project_slug, job.episode_id)
    const planPath = await resolveScenePlanPath(job.project_slug, job.episode_id, paths.episode_dir)
    const plan = JSON.parse(await fs.readFile(planPath, 'utf8')) as { scenes?: unknown }
    if (!Array.isArray(plan.scenes) || !plan.scenes.length) throw new Error('scene_plan.json has no scenes')
    const missing = inspectScenePromptIntegrity(plan.scenes as any).invalid_ids
    if (!missing.length) {
      throw Object.assign(new Error('Every visual prompt is already complete. No paid repair request was submitted.'), { status: 409, expose: true })
    }
    return missing
  } catch (error: any) {
    if (error?.status === 409) throw error
    throw Object.assign(
      new Error('No authoritative Scene Plan with repairable visual prompts was found. Use Retry for the original step.'),
      { status: 409, expose: true },
    )
  }
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

router.post('/jobs/all/resume-paused', async (req, res) => {
  const parsed = parseResumePausedBody(req.body, ['project_slug', 'type'])
  if ('error' in parsed) return res.status(400).json({ detail: parsed.error })
  const scopes = await allJobScopes()
  if (parsed.value.project_slug !== undefined && !scopes.includes(parsed.value.project_slug)) {
    return res.status(404).json({ detail: 'Project not found' })
  }
  const projectSlugs = parsed.value.project_slug === undefined ? scopes : [parsed.value.project_slug]
  await Promise.all(projectSlugs.map(scope => jq.getJobs(scope)))
  res.status(202).json(await jq.resumePausedJobs({ projectSlugs, type: parsed.value.type }))
})

router.post('/jobs/all/:jobId/retry', async (req, res) => {
  const existing = jq.getJob(req.params.jobId)
  if (!existing) return res.status(404).json({ detail: 'Job not found' })
  if (episodeRecoveryStep(existing.type)) {
    return res.status(202).json({ ok: true, plan: await recoverEpisode(existing.project_slug, existing.episode_id, true, [existing.job_id]) })
  }
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

router.post('/jobs/all/:jobId/cancel', async (req, res, next) => {
  const existing = await findUniversalJob(req.params.jobId)
  if (!existing) return res.status(404).json({ detail: 'Job not found' })
  try {
    const job = await jq.requestJobCancellation(existing.project_slug, req.params.jobId)
    res.json({ ok: true, job })
  } catch (error) {
    if (sendJobControlError(res, error)) return
    next(error)
  }
})

// v1.2.6 — the enabled half of the finished-job dismiss gate. Re-reads the
// current GenStudio state of the provider tasks this job recorded as
// unfinished, updates the stored evidence, and returns the re-classified job.
router.post('/jobs/all/:jobId/recheck-provider-status', async (req, res, next) => {
  const existing = await findUniversalJob(req.params.jobId)
  if (!existing) return res.status(404).json({ detail: 'Job not found' })
  try {
    res.json({ ok: true, job: await jq.recheckJobProviderStatus(existing.project_slug, req.params.jobId) })
  } catch (error) {
    next(error)
  }
})

// v1.2.8 — the owner override. Deliberately never refuses on provider
// evidence: it exists precisely for the jobs every evidence-gated control has
// already refused, and refusing it there too would reproduce the dead end.
router.post('/jobs/all/:jobId/abandon', async (req, res, next) => {
  const existing = await findUniversalJob(req.params.jobId)
  if (!existing) return res.status(404).json({ detail: 'Job not found' })
  try {
    res.json({ ok: true, job: await jq.forceAbandonJob(existing.project_slug, req.params.jobId) })
  } catch (error) {
    next(error)
  }
})

router.delete('/jobs/all/:jobId', async (req, res) => {
  const existing = await findUniversalJob(req.params.jobId)
  if (!existing) return res.status(404).json({ detail: 'Job not found' })
  if (!jq.removeTerminalJob(existing.project_slug, req.params.jobId)) return sendTerminalOnlyConflict(res, existing)
  res.json({ ok: true })
})

router.delete('/jobs/all', async (req, res) => {
  const parsed = parseHistoryClearQuery(req.query)
  if ('error' in parsed) return res.status(400).json({ detail: parsed.error })
  const scopes = await allJobScopes()
  const cleared = await Promise.all(scopes.map(scope => jq.clearFinished(scope, parsed.value.status)))
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
  const job = jq.getPublicJob(req.params.jobId)
  if (!job || job.project_slug !== APP_SLUG) {
    return res.status(404).json({ detail: 'Job not found' })
  }
  res.json(job)
})

router.delete('/jobs/app', async (req, res) => {
  const parsed = parseHistoryClearQuery(req.query)
  if ('error' in parsed) return res.status(400).json({ detail: parsed.error })
  const count = await jq.clearFinished(APP_SLUG, parsed.value.status)
  res.json({ ok: true, cleared: count })
})

router.post('/projects/:slug/jobs/resume-paused', async (req, res) => {
  const parsed = parseResumePausedBody(req.body, ['type'])
  if ('error' in parsed) return res.status(400).json({ detail: parsed.error })
  const projects = await pm.listProjects()
  if (!projects.some(project => project.slug === req.params.slug)) {
    return res.status(404).json({ detail: 'Project not found' })
  }
  await jq.getJobs(req.params.slug)
  res.status(202).json(await jq.resumePausedJobs({
    projectSlugs: [req.params.slug],
    type: parsed.value.type,
  }))
})

router.get('/projects/:slug/jobs/:jobId', (req, res) => {
  const job = jq.getPublicJob(req.params.jobId)
  if (!job || job.project_slug !== req.params.slug) {
    return res.status(404).json({ detail: 'Job not found' })
  }
  res.json(job)
})

/**
 * Requeue a failed/cancelled Scene Review job in place. The continuity
 * executor reads the saved model and render settings and audits disk/provider
 * evidence before deciding which images still need work. The request carries
 * no settings or scene identities, so the same job row remains authoritative.
 */
router.post('/projects/:slug/jobs/:jobId/finish-missing-images', async (req, res) => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length > 0) {
    return res.status(400).json({ detail: 'Request body must be an empty object. Scene IDs and settings come from the saved job.' })
  }
  try {
    const result = await jq.finishMissingImagesInPlace(String(req.params.slug), String(req.params.jobId))
    const job = jq.getPublicJob(result.job.job_id)
    if (!job) return res.status(409).json({ detail: 'This job changed after queuing. Refresh Jobs to check its current status.' })
    return res.status(202).json({ ok: true, job, ...(result.reused ? { reused: true } : {}) })
  } catch (error: any) {
    return res.status(Number(error?.status) || 409).json({ detail: error?.message || 'Could not queue missing images.' })
  }
})

// Queue-level Retry fallback. Specialized generator pages may still use their
// own healing endpoints, but every registered job type remains recoverable
// even when a newer executor has not yet been added to a frontend map.
router.post('/projects/:slug/jobs/recover-episode/:episodeId', async (req, res) => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)
    || Object.keys(req.body).some(key => key !== 'source_job_ids')
    || (req.body.source_job_ids !== undefined && (!Array.isArray(req.body.source_job_ids) || !req.body.source_job_ids.length
      || req.body.source_job_ids.some((id: unknown) => typeof id !== 'string' || !id.trim())))) {
    return res.status(400).json({ detail: 'Episode recovery accepts no overrides; saved job scope is authoritative.' })
  }
  try {
    res.status(202).json({ plan: await recoverEpisode(req.params.slug, req.params.episodeId, true, req.body.source_job_ids) })
  } catch (error) { res.status(409).json({ detail: error instanceof Error ? error.message : 'Episode recovery is unavailable.' }) }
})

router.post('/projects/:slug/jobs/:jobId/retry', async (req, res) => {
  const existing = jq.getJob(req.params.jobId)
  if (existing?.project_slug === req.params.slug && episodeRecoveryStep(existing.type)) {
    return res.status(202).json({ ok: true, plan: await recoverEpisode(req.params.slug, existing.episode_id, true, [existing.job_id]) })
  }
  const job = jq.retryTerminalJob(req.params.slug, req.params.jobId)
  res.status(202).json({ ok: true, job })
})

router.post('/projects/:slug/jobs/:jobId/auto-repair-scene-prompts', async (req, res) => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length) {
    return res.status(400).json({ detail: 'Request body must be an empty object. Scene IDs and settings come from the saved job and Scene Plan.' })
  }
  const original = jq.getJob(req.params.jobId)
  if (!original || original.project_slug !== req.params.slug) {
    return res.status(404).json({ detail: 'Job not found' })
  }
  try {
    const missing = await scenePromptAutoRepairMissing(original)
    // The disk audit above is asynchronous. Re-read immediately before the
    // synchronous replacement boundary so a provider request that settled
    // while the file was inspected is recovered instead of replaced.
    const refreshed = jq.getJob(req.params.jobId)
    if (!refreshed || refreshed.project_slug !== req.params.slug) {
      return res.status(404).json({ detail: 'Job not found' })
    }
    if ((refreshed.genstudio_jobs || []).some(entry => (
      entry.operation === 'chat.response'
      && entry.failure_code === 'LANGUAGE_PROVIDER_SUBMISSION_UNCERTAIN'
    ))) {
      throw Object.assign(new Error('GenStudio could not prove whether an earlier prompt request was accepted. Story Studio kept that evidence and did not submit fresh paid work. Check GenStudio before trying again.'), { status: 409, expose: true })
    }
    const recoveries = scenePromptAutoRepairRecoveries(refreshed, missing)
    const job = jq.retryTerminalJob(
      req.params.slug,
      req.params.jobId,
      scenePromptAutoRepairParams((refreshed.params || {}) as Record<string, unknown>, refreshed.episode_id, recoveries),
    )
    res.status(202).json({ ok: true, job, missing_prompts: missing.length })
  } catch (error: any) {
    res.status(Number(error?.status) || 409).json({ detail: error?.message || 'Prompt auto-repair is unavailable.' })
  }
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

router.post('/projects/:slug/jobs/:jobId/cancel', async (req, res, next) => {
  const existing = (await jq.getJobs(req.params.slug)).find(job => job.job_id === req.params.jobId)
  if (!existing || existing.project_slug !== req.params.slug) return res.status(404).json({ detail: 'Job not found' })
  try {
    const job = await jq.requestJobCancellation(req.params.slug, req.params.jobId)
    res.json({ ok: true, job })
  } catch (error) {
    if (sendJobControlError(res, error)) return
    next(error)
  }
})

// v1.2.6 — see the /jobs/all sibling above.
router.post('/projects/:slug/jobs/:jobId/recheck-provider-status', async (req, res, next) => {
  const existing = (await jq.getJobs(req.params.slug)).find(job => job.job_id === req.params.jobId)
  if (!existing || existing.project_slug !== req.params.slug) return res.status(404).json({ detail: 'Job not found' })
  try {
    res.json({ ok: true, job: await jq.recheckJobProviderStatus(req.params.slug, req.params.jobId) })
  } catch (error) {
    next(error)
  }
})

// v1.2.8 — see the /jobs/all sibling above.
router.post('/projects/:slug/jobs/:jobId/abandon', async (req, res, next) => {
  const existing = (await jq.getJobs(req.params.slug)).find(job => job.job_id === req.params.jobId)
  if (!existing || existing.project_slug !== req.params.slug) return res.status(404).json({ detail: 'Job not found' })
  try {
    res.json({ ok: true, job: await jq.forceAbandonJob(req.params.slug, req.params.jobId) })
  } catch (error) {
    next(error)
  }
})

router.delete('/projects/:slug/jobs/:jobId', async (req, res) => {
  const existing = (await jq.getJobs(req.params.slug)).find(job => job.job_id === req.params.jobId)
  if (!existing || existing.project_slug !== req.params.slug) return res.status(404).json({ detail: 'Job not found' })
  if (!jq.removeTerminalJob(req.params.slug, req.params.jobId)) return sendTerminalOnlyConflict(res, existing)
  res.json({ ok: true })
})

// Clear all finished (done/error/cancelled) jobs
router.delete('/projects/:slug/jobs', async (req, res) => {
  const parsed = parseHistoryClearQuery(req.query)
  if ('error' in parsed) return res.status(400).json({ detail: parsed.error })
  const count = await jq.clearFinished(req.params.slug, parsed.value.status)
  res.json({ ok: true, cleared: count })
})
