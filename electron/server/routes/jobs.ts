import { Router } from 'express'
import * as jq from '../services/job-queue.js'
import * as pm from '../services/project-manager.js'
import type { Job } from '../models/types.js'

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

router.delete('/jobs/all/:jobId', async (req, res) => {
  const existing = await findUniversalJob(req.params.jobId)
  if (!existing) return res.status(404).json({ detail: 'Job not found' })
  if (!jq.removeTerminalJob(existing.project_slug, req.params.jobId)) return sendTerminalOnlyConflict(res, existing)
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

router.delete('/projects/:slug/jobs/:jobId', async (req, res) => {
  const existing = (await jq.getJobs(req.params.slug)).find(job => job.job_id === req.params.jobId)
  if (!existing || existing.project_slug !== req.params.slug) return res.status(404).json({ detail: 'Job not found' })
  if (!jq.removeTerminalJob(req.params.slug, req.params.jobId)) return sendTerminalOnlyConflict(res, existing)
  res.json({ ok: true })
})

// Clear all finished (done/error/cancelled) jobs
router.delete('/projects/:slug/jobs', async (req, res) => {
  const count = await jq.clearFinished(req.params.slug)
  res.json({ ok: true, cleared: count })
})
