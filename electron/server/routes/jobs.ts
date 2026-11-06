import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import * as jq from '../services/job-queue.js'
import * as pm from '../services/project-manager.js'
import { getSoftDeletedSlugSet } from '../services/soft-delete.js'
import { JOB_TYPES, type Job, type JobType } from '../models/types.js'
import { episodeRecoveryStep, readEpisodeRecoveryPlans, recoverEpisode } from '../services/episode-recovery.js'
import { isScopedChapterTranscription } from '../services/audio-workflow-readiness.js'
import { settleCompletedFailures } from '../services/stale-failures.js'
import { inspectScenePromptIntegrity } from '../services/scene-prompt-integrity.js'
import { resolveEpisodePathsByCode, resolveScenePlanPath } from '../services/utils.js'
import { scenePromptPackOutputContract } from '../lib/story-output-contracts.js'
import { stampFreshGenerationAction } from '../lib/fresh-generation-action.js'
import { evidenceHoldsUnknownOutcome } from '../lib/genstudio-client.js'

export const router = Router()

const APP_SLUG = '_app_'
const JOB_TYPE_SET = new Set<string>(JOB_TYPES)

type ResumePausedBody = { project_slug?: string; type?: JobType }
type HistoryClearQuery = { status?: jq.JobHistoryClearStatus }

type QueueMoveBody = { direction?: jq.QueuedJobMove }

function parseQueueMoveBody(body: unknown): { value: jq.QueuedJobMove } | { error: string } {
  const direction = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as QueueMoveBody).direction
    : undefined
  if (direction === 'up' || direction === 'down' || direction === 'top') return { value: direction }
  return { error: 'direction must be "up", "down", or "top".' }
}

function parseHistoryClearQuery(query: unknown): { value: HistoryClearQuery } | { error: string } {
  if (!query || typeof query !== 'object' || Array.isArray(query)) return { error: 'Invalid query.' }
  const status = (query as Record<string, unknown>).status
  if (status === undefined) return { value: {} }
  if (status === 'finished' || status === 'failed') return { value: { status } }
  return { error: 'status must be "finished" or "failed".' }
}

// ── Finished history (paged, searched, counted) ─────────────────────────────
//
// `GET /jobs/all/history` and `GET /projects/:slug/jobs/history` serve the
// finished rows the Jobs page used to hold entirely in memory. The matching
// rules are `contracts/jobs-history.ts`, the same module the page imports, so a
// server page and the client's own view of a row cannot disagree.

const HISTORY_STATUS_KEYS = new Set(['running', 'queued', 'paused', 'error', 'done', 'recovered', 'cancelled'])
const HISTORY_MAX_LIMIT = 500

/** One query value, first wins when it arrived repeated; blank counts as absent. */
function singleQueryValue(value: unknown): string | undefined {
  const first = Array.isArray(value) ? value[0] : value
  return typeof first === 'string' && first.trim() ? first.trim() : undefined
}

function queryFlag(value: unknown): boolean {
  const text = singleQueryValue(value)
  return text === '1' || text === 'true'
}

function parseHistoryQuery(
  query: unknown,
  scopeFromPath?: string,
): { value: { filter: jq.JobHistoryFilter; options: jq.JobHistoryOptions } } | { error: string } {
  if (!query || typeof query !== 'object' || Array.isArray(query)) return { error: 'Invalid query.' }
  const record = query as Record<string, unknown>
  const statuses = singleQueryValue(record.status)?.split(',').map(part => part.trim()).filter(Boolean)
  if (statuses?.some(status => !HISTORY_STATUS_KEYS.has(status))) {
    return { error: 'status must be one or more of running, queued, paused, error, done, recovered, cancelled.' }
  }
  const limitText = singleQueryValue(record.limit)
  let limit: number | undefined
  if (limitText !== undefined) {
    limit = Number(limitText)
    if (!Number.isInteger(limit) || limit < 1 || limit > HISTORY_MAX_LIMIT) {
      return { error: `limit must be a whole number between 1 and ${HISTORY_MAX_LIMIT}.` }
    }
  }
  const scope = scopeFromPath ?? singleQueryValue(record.project)
  const controls = singleQueryValue(record.controls)?.split(',').map(part => part.trim()).filter(Boolean)
  const cursor = singleQueryValue(record.cursor)
  // `episode` is the query string's name for the page's one search box; `q` is
  // the same search under the name the newer callers use.
  const q = singleQueryValue(record.q) ?? singleQueryValue(record.episode)
  return {
    value: {
      filter: {
        ...(scope ? { scope } : {}),
        ...(statuses?.length ? { statuses } : {}),
        ...(singleQueryValue(record.type) ? { type: singleQueryValue(record.type) } : {}),
        ...(singleQueryValue(record.batch) ? { batch: singleQueryValue(record.batch) } : {}),
        ...(q ? { q } : {}),
        ...(controls?.length ? { controls } : {}),
        ...(singleQueryValue(record.since) ? { since: singleQueryValue(record.since) } : {}),
        // `hidden=1` is the one way to read the rows the owner took off the
        // list. Absent means visible, which is what every job saved before
        // hiding shipped looks like (AGENTS.md §6: the two answers stay
        // distinct — a hidden row is never reported as "no rows").
        ...(queryFlag(record.hidden) ? { hidden: true } : {}),
      },
      options: {
        ...(limit !== undefined ? { limit } : {}),
        ...(cursor ? { cursor } : {}),
        idsOnly: queryFlag(record.ids),
        all: queryFlag(record.all),
        facets: queryFlag(record.facets),
      },
    },
  }
}

/** The scopes a history read covers: one named project, or the whole fleet. */
async function historyScopes(named: string | undefined): Promise<string[] | null> {
  const scopes = await allJobScopes()
  if (!named) return scopes
  return scopes.includes(named) ? [named] : null
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
  // Hidden rows are off the list, so they are in no badge. They are still
  // readable through the history read's `hidden` filter — this is a count of
  // what is on the list, not of what exists.
  const visible = jobsList.filter(job => !jq.isJobHidden(job))
  return {
    running: visible.filter(job => job.status === 'running').length,
    queued: visible.filter(job => job.status === 'queued').length,
    paused: visible.filter(job => job.status === 'paused').length,
    done: visible.filter(job => job.status === 'done').length,
    error: visible.filter(job => job.status === 'error' && !jq.isRecoveredFailure(job)).length,
    total: visible.length,
  }
}

/** Keep event ordering stable while a stream builds its first durable snapshot. */
export function createBufferedJobStream(
  send: (eventName: string, payload: unknown) => void,
  snapshotErrorDetail = 'Could not load Jobs.',
) {
  const pending: Array<{ eventName: string, payload: unknown }> = []
  let snapshotSent = false
  const flush = () => {
    snapshotSent = true
    for (const event of pending.splice(0)) send(event.eventName, event.payload)
  }
  return {
    send(eventName: string, payload: unknown) {
      if (snapshotSent) send(eventName, payload)
      else pending.push({ eventName, payload })
    },
    sendSnapshot(payload: unknown) {
      send('snapshot', payload)
      flush()
    },
    sendSnapshotError() {
      send('snapshot-error', { detail: snapshotErrorDetail })
      flush()
    },
  }
}

export async function durableJobScopes(root: string, hidden: ReadonlySet<string>): Promise<string[]> {
  let entries: import('node:fs').Dirent[] = []
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch (error: any) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const scopes = await Promise.all(entries.map(async entry => {
    if (!entry.isDirectory() || entry.name.startsWith('.') || /\.bak-/.test(entry.name) || hidden.has(entry.name)) return null
    try {
      await fs.access(path.join(root, entry.name, 'jobs.json'))
      return entry.name
    } catch (error: any) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
  }))
  return scopes.filter((scope): scope is string => scope !== null)
}

async function allJobScopes(): Promise<string[]> {
  const hidden = await getSoftDeletedSlugSet()
  const [projects, durableScopes] = await Promise.all([
    pm.listProjects(),
    durableJobScopes(pm.projectsRoot(), hidden),
  ])
  return [...new Set([
    ...projects.filter(project => !hidden.has(project.slug)).map(project => project.slug),
    ...durableScopes,
    APP_SLUG,
  ])]
}

/**
 * What one read of the universal list costs.
 *
 * `active` is the view every live surface uses: the streams' snapshot and the
 * REST fallback. Only queued/running/paused rows are on the wire, so a page
 * that merely wants the queue and the badge no longer downloads a channel's
 * whole finished history — which was ~128 MB at production size and was paid
 * on EVERY page, because the dashboard layout opens this stream. The stats
 * still describe the whole scope, counted from the raw queue without cloning a
 * single job. The paged history is a separate read (`/jobs/all/history`).
 */
async function allJobsSnapshot(view: 'full' | 'stream' | 'active' = 'full') {
  const scopes = await allJobScopes()
  const lists = await Promise.all(scopes.map(scope => view === 'active'
    ? jq.getActiveJobs(scope)
    : jq.getJobs(scope, { view })))
  const jobsList = lists.flat()
  if (view !== 'active') return { jobs: jobsList, stats: summarizeJobs(jobsList) }
  const counted = await Promise.all(scopes.map(scope => jq.countJobs(scope)))
  const stats = counted.reduce((total, scope) => ({
    running: total.running + scope.running,
    queued: total.queued + scope.queued,
    paused: total.paused + scope.paused,
    done: total.done + scope.done,
    error: total.error + scope.error,
    total: total.total + scope.total,
  }), { running: 0, queued: 0, paused: 0, done: 0, error: 0, total: 0 })
  return { jobs: jobsList, stats }
}

async function findUniversalJob(jobId: string): Promise<Job | undefined> {
  const scopes = await allJobScopes()
  return (await Promise.all(scopes.map(scope => jq.findJobs(scope, job => job.job_id === jobId)))).flat()[0]
}

/**
 * Which scope's saved history still holds a job the queue's store has dropped.
 *
 * The universal removal path is asked for one job id with no scope, so the
 * scopes are read one by one. The first scope whose saved jobs file still has
 * the row owns it.
 */
async function removalScopeFor(jobId: string): Promise<string | undefined> {
  const scopes = await allJobScopes()
  for (const scope of scopes) {
    if (await jq.savedJobExists(scope, jobId)) return scope
  }
  return undefined
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
    detail: 'Only finished jobs can be hidden from the list.',
  })
}

/**
 * A saved chat request key whose answer the Gateway holds or may still hold: its entry succeeded, or
 * is in flight / an unknown outcome. Not `failed` (settled) and not `not_created` (never reached it).
 */
function holdsEarlierChatAnswer(job: Job): boolean {
  // Story itself rejected the answer it got (metadata sets this): replaying its key would return that
  // same answer forever, so only a fresh request can fix it (NEW-14).
  if (job.result?.chat_answer_rejected === true) return false
  return (job.genstudio_jobs || []).some(entry => entry.operation === 'chat.response'
    && !!(entry.request?.idempotency_key?.trim() || entry.request_key?.trim())
    && entry.state !== 'not_created'
    && (entry.state !== 'failed' || evidenceHoldsUnknownOutcome(entry)))
}

/** Retry-only repair intent derived from durable job state, never a client form. */
function retryReplacementParams(job: Job): Record<string, any> | undefined {
  if (job.type === 'image_prompts') {
    // Prompt retries keep all saved identity/configuration and ask the generator
    // to fill only the thumbnail slots still absent from disk.
    return { ...job.params, fill_gaps: true }
  }
  const existingAction = job.params?.generation_action
  // A proven-rejected answer outranks the action's origin: the saved key would hand back the very
  // answer Story already refused, so a page/Pipeline-stamped action must be replaced too.
  const answerRejected = job.result?.chat_answer_rejected === true
  if (job.type === 'metadata' && (answerRejected || !existingAction || existingAction.origin === 'retry')) {
    // Evidence that the Gateway already holds this job's answer keeps the saved params, so the same
    // request identity gives the same key and the Gateway replays the first answer — no second charge
    // ("a retry first collects any earlier answer by its saved key"). Only a confirmed failure or a
    // request that never reached the Gateway, or no evidence at all, asks for a new answer below.
    if (holdsEarlierChatAnswer(job)) return undefined
    // A finalizer job with no saved action — the Pipeline and bare-route path —
    // derives its provider request identity from the prompt itself: a Retry would
    // re-ask with that same identity, the provider would replay the short answer,
    // and the audit would reject it again, so the terminal message "Retry to
    // generate the missing fields" would be false (NEW-14). A retry is the
    // customer deliberately asking for a new answer, exactly as the Finalizer page
    // does with `freshMetadataAction`, so mint one. An action this retry path
    // minted is marked `origin: 'retry'` and replaced on the next retry, or the
    // second retry would replay the first one's answer. An action the customer's
    // page stamped is kept untouched unless its answer was proven rejected above
    // (pinned by job-retry-route-contract).
    const minted = stampFreshGenerationAction(job.params ?? {}, randomUUID())
    return { ...job.params, ...minted, generation_action: { ...minted.generation_action, origin: 'retry' } }
  }
  return undefined
}

/**
 * Job types that no longer have an executor. Their old rows still list; they just cannot run
 * again. `video` is the retired AI Video Generator's lane (deleted 2026-10-27) — its rows are
 * history, and its lane is gone, so a Retry would queue work nothing can ever run.
 */
const REMOVED_JOB_TYPES = new Set(['script-only', 'expression_markup', 'video'])

/** Retired jobs keep their terminal record; Retry must not replace it with the same known failure. */
function retryAdmissionError(job: Job): string | null {
  // Hidden rows are off the list, so nothing queues from them until the owner
  // puts the row back. The refusal is a real answer (AGENTS.md §6), not a
  // silent no-op: it names the one action that unblocks the row.
  if (jq.isJobHidden(job)) return 'This job is hidden from the list. Restore it first, then Retry.'
  const type = job.type as string
  if (REMOVED_JOB_TYPES.has(type)) return 'This kind of job was removed from Story Studio, so it cannot be retried.'
  if (job.params?.jobs_replace_failed_items && !jq.canRetryManualFailedItemExactly(job)) {
    return 'This manual replacement has a confirmed provider failure. Use Replace failed items to make another deliberate attempt.'
  }
  if (type === 'image_prompts' && job.params?.mode && job.params.mode !== 'thumbnails') {
    return 'Legacy Scene Prompts are retired. Generate visual prompts in Scene Plan.'
  }
  // v1.4.41 retired the scene-image lane. The older combined `images` lane
  // still means thumbnails when mode is absent or `thumbs`, and can safely
  // migrate at Retry into the current thumbnail executor.
  if (type === 'images' && job.params?.mode !== undefined && job.params.mode !== 'thumbs') {
    return 'Legacy Scene Images are retired. Render planned scenes in Scene Review.'
  }
  return null
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
  let closed = false

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
    if (closed) return
    res.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`)
  }
  const stream = createBufferedJobStream(send, 'Could not load project Jobs.')
  const onUpdate = (job: Job) => {
    if (job.project_slug !== slug) return
    stream.send('update', job)
  }
  const onCleared = (event: jq.JobsClearedEvent) => {
    if (event.project_slug !== slug) return
    stream.send('cleared', event)
  }
  jq.jobEvents.on('update', onUpdate)
  jq.jobEvents.on('cleared', onCleared)

  const keepalive = setInterval(() => {
    // SSE comment — ignored by the parser but keeps intermediaries alive.
    res.write(': ping\n\n')
  }, 15000)

  req.on('close', () => {
    closed = true
    clearInterval(keepalive)
    jq.jobEvents.off('update', onUpdate)
    jq.jobEvents.off('cleared', onCleared)
  })
  try {
    stream.sendSnapshot({
      // Active rows only: the snapshot is what every page pays for on connect,
      // and the finished half is a paged read (`/projects/:slug/jobs/history`).
      jobs: await jq.getActiveJobs(slug),
      stats: jq.getQueueStats(slug),
    })
  } catch (error) {
    console.error('[jobs/stream] snapshot error:', error)
    stream.sendSnapshotError()
  }
})

// `?view=stream` is the streams' slim view (no Gateway evidence / scene lists); the REST
// fallbacks poll with it, so a closed stream does not pull the full history every 15 s.
// `?view=active` is the live half only — what the streams' snapshot and every
// badge actually need. `full` (the default) is unchanged for automation callers.
type JobsListView = 'full' | 'stream' | 'active'
const listView = (query: unknown): JobsListView => {
  const view = (query as { view?: unknown })?.view
  return view === 'stream' || view === 'active' ? view : 'full'
}

router.get('/projects/:slug/jobs', async (req, res) => {
  const view = listView(req.query)
  const jobsList = view === 'active'
    ? await jq.getActiveJobs(req.params.slug)
    : await jq.getJobs(req.params.slug, { view })
  const stats = jq.getQueueStats(req.params.slug)
  res.json({ jobs: jobsList, stats })
})

// Must be registered BEFORE `/projects/:slug/jobs/:jobId`, or Express serves
// this path to the job lookup and every history read answers 404 for a job
// called "history" (the same trap `/jobs/app/stream` documents below).
router.get('/projects/:slug/jobs/history', async (req, res) => {
  const parsed = parseHistoryQuery(req.query, req.params.slug)
  if ('error' in parsed) return res.status(400).json({ detail: parsed.error })
  const scopes = await historyScopes(req.params.slug)
  if (!scopes) return res.status(404).json({ detail: 'Project not found' })
  res.json(await jq.queryJobHistory(scopes, parsed.value.filter, parsed.value.options))
})

// ── Universal jobs ────────────────────────────────────────────────────────
// One control-centre view across every project plus app-level library work.
// The initial snapshot loads each durable jobs.json once; after that, SSE
// carries only incremental updates, so merely having many projects does not
// create a polling loop across their folders.
router.get('/jobs/all/stream', async (req, res) => {
  let closed = false
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.write('retry: 5000\n\n')
  function send(eventName: string, payload: unknown) {
    if (closed) return
    res.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`)
  }
  const stream = createBufferedJobStream(send, 'Could not load All Jobs.')
  // Subscribe before the snapshot read, then release buffered changes after
  // it. Without this, a job changing while its durable scope hydrates can be
  // absent from both the snapshot and the live stream.
  const onUpdate = (job: Job) => stream.send('update', job)
  const onCleared = (event: jq.JobsClearedEvent) => stream.send('cleared', event)
  jq.jobEvents.on('update', onUpdate)
  jq.jobEvents.on('cleared', onCleared)
  const keepalive = setInterval(() => res.write(': ping\n\n'), 15000)
  req.on('close', () => {
    closed = true
    clearInterval(keepalive)
    jq.jobEvents.off('update', onUpdate)
    jq.jobEvents.off('cleared', onCleared)
  })
  try {
    stream.sendSnapshot(await allJobsSnapshot('active'))
  } catch (error) {
    console.error('[jobs/all/stream] snapshot error:', error)
    stream.sendSnapshotError()
  }
})

router.get('/jobs/all', async (req, res) => {
  res.json(await allJobsSnapshot(listView(req.query)))
})

// The finished half, paged and searched. Registered before `/jobs/all/:jobId`
// would be — this route family is all POST/DELETE today, and the reserved word
// must stay reserved if a GET is ever added.
router.get('/jobs/all/history', async (req, res) => {
  const parsed = parseHistoryQuery(req.query)
  if ('error' in parsed) return res.status(400).json({ detail: parsed.error })
  const scopes = await historyScopes(parsed.value.filter.scope)
  if (!scopes) return res.status(404).json({ detail: 'Project not found' })
  res.json(await jq.queryJobHistory(scopes, parsed.value.filter, parsed.value.options))
})

router.post('/jobs/all/resume-paused', async (req, res) => {
  const parsed = parseResumePausedBody(req.body, ['project_slug', 'type'])
  if ('error' in parsed) return res.status(400).json({ detail: parsed.error })
  const scopes = await allJobScopes()
  if (parsed.value.project_slug !== undefined && !scopes.includes(parsed.value.project_slug)) {
    return res.status(404).json({ detail: 'Project not found' })
  }
  const projectSlugs = parsed.value.project_slug === undefined ? scopes : [parsed.value.project_slug]
  await Promise.all(projectSlugs.map(scope => jq.findJobs(scope, () => false)))
  res.status(202).json(await jq.resumePausedJobs({ projectSlugs, type: parsed.value.type }))
})

router.post('/jobs/all/:jobId/retry', async (req, res) => {
  const existing = jq.getJob(req.params.jobId)
  if (!existing) return res.status(404).json({ detail: 'Job not found' })
  const admissionError = retryAdmissionError(existing)
  if (admissionError) return res.status(409).json({ detail: admissionError })
  if (episodeRecoveryStep(existing.type) && !(existing.type === 'subtitles_transcribe' && isScopedChapterTranscription(existing.params))) {
    return res.status(202).json({ ok: true, plan: await recoverEpisode(existing.project_slug, existing.episode_id, true, [existing.job_id], [], true) })
  }
  const job = jq.retryTerminalJob(existing.project_slug, req.params.jobId, retryReplacementParams(existing))
  res.status(202).json({ ok: true, job })
})

router.post('/jobs/all/:jobId/replace-failed-items', async (req, res) => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length) {
    return res.status(400).json({ detail: 'Request body must be an empty object. Failed-item scope comes from the saved job and Gateway evidence.' })
  }
  const existing = await findUniversalJob(req.params.jobId)
  if (!existing) {
    const child = (await allJobsSnapshot()).jobs.find(job => (
      job.params?.jobs_replace_failed_items?.source_job_id === req.params.jobId
    ))
    if (child) return res.status(202).json({ ok: true, job: child })
    return res.status(404).json({ detail: 'Job not found' })
  }
  try {
    return res.status(202).json({ ok: true, job: await jq.replaceFailedItems(existing.project_slug, req.params.jobId) })
  } catch (error: any) {
    return res.status(Number(error?.status) || 409).json({ detail: error?.message || 'Failed items could not be replaced.' })
  }
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

router.post('/jobs/all/:jobId/move', async (req, res) => {
  const parsed = parseQueueMoveBody(req.body)
  if ('error' in parsed) return res.status(400).json({ detail: parsed.error })
  const existing = jq.getJob(req.params.jobId)
  if (!existing) return res.status(404).json({ detail: 'Job not found' })
  const moved = await jq.moveQueuedJob(existing.project_slug, existing.job_id, parsed.value)
  if (!moved) return res.status(409).json({ detail: 'Only queued jobs waiting in their own queue can be moved.' })
  res.json({ ok: true, ...moved })
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

// v2026-11-02 — the owner's rule: nothing deleted for good. This used to be
// `DELETE`, and deleting took the record with it — the error details, the log
// and Retry/Recover went permanently. It is now a HIDE: the record, its
// evidence and its controls all stay exactly as they were, and `.../unhide`
// puts the row back. There is no route that deletes a terminal job any more.
router.post('/jobs/all/:jobId/hide', async (req, res) => {
  const existing = await findUniversalJob(req.params.jobId)
  if (!existing) {
    // The row may only exist in the scope's saved history; hide it there too.
    const scope = await removalScopeFor(req.params.jobId)
    if (!scope || !await jq.hideTerminalJob(scope, req.params.jobId)) {
      return res.status(404).json({ detail: 'Job not found' })
    }
    return res.json({ ok: true })
  }
  if (!await jq.hideTerminalJob(existing.project_slug, req.params.jobId)) return sendTerminalOnlyConflict(res, existing)
  res.json({ ok: true, job: jq.getPublicJob(req.params.jobId) })
})

router.post('/jobs/all/:jobId/unhide', async (req, res) => {
  const existing = await findUniversalJob(req.params.jobId)
  if (!existing) {
    const scope = await removalScopeFor(req.params.jobId)
    if (!scope || !await jq.unhideTerminalJob(scope, req.params.jobId)) {
      return res.status(404).json({ detail: 'Job not found' })
    }
    return res.json({ ok: true })
  }
  if (!await jq.unhideTerminalJob(existing.project_slug, req.params.jobId)) return sendTerminalOnlyConflict(res, existing)
  res.json({ ok: true, job: jq.getPublicJob(req.params.jobId) })
})

// Bulk: the Jobs toolbar's "Hide Finished / Hide Failed From List". The count
// it returns is the number of rows that left the list, which is the number on
// the button — nothing is deleted, so nothing is lost by pressing it twice.
router.post('/jobs/all/hide', async (req, res) => {
  const parsed = parseHistoryClearQuery(req.query)
  if ('error' in parsed) return res.status(400).json({ detail: parsed.error })
  const scopes = await allJobScopes()
  const hidden = await Promise.all(scopes.map(scope => jq.hideFinished(scope, parsed.value.status)))
  res.json({ ok: true, hidden: hidden.reduce((total, count) => total + count, 0) })
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
  let closed = false
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.write('retry: 5000\n\n')
  function send(eventName: string, payload: unknown) {
    if (closed) return
    res.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`)
  }
  // Same shape as the project and universal streams: events that arrive while
  // the first durable snapshot is still being read are buffered behind it, and
  // a snapshot that cannot be read is reported as `snapshot-error`. This route
  // used to hand-roll `send` and only `console.error` the failure, so the app
  // Jobs view showed an incomplete list with no stale warning while updates
  // could also overtake the snapshot.
  const stream = createBufferedJobStream(send, 'Could not load Jobs.')
  const onUpdate = (job: Job) => {
    if (job.project_slug !== APP_SLUG) return
    stream.send('update', job)
  }
  const onCleared = (event: jq.JobsClearedEvent) => {
    if (event.project_slug !== APP_SLUG) return
    stream.send('cleared', event)
  }
  jq.jobEvents.on('update', onUpdate)
  jq.jobEvents.on('cleared', onCleared)
  const keepalive = setInterval(() => res.write(': ping\n\n'), 15000)
  req.on('close', () => {
    closed = true
    clearInterval(keepalive)
    jq.jobEvents.off('update', onUpdate)
    jq.jobEvents.off('cleared', onCleared)
  })
  try {
    stream.sendSnapshot({
      jobs: await jq.getJobs(APP_SLUG, { view: 'stream' }),
      stats: jq.getQueueStats(APP_SLUG),
    })
  } catch (error) {
    console.error('[jobs/app/stream] snapshot error:', error)
    stream.sendSnapshotError()
  }
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

// See the `/jobs/all` sibling above: hide, never delete.
router.post('/jobs/app/hide', async (req, res) => {
  const parsed = parseHistoryClearQuery(req.query)
  if ('error' in parsed) return res.status(400).json({ detail: parsed.error })
  const count = await jq.hideFinished(APP_SLUG, parsed.value.status)
  res.json({ ok: true, hidden: count })
})

router.post('/projects/:slug/jobs/resume-paused', async (req, res) => {
  const parsed = parseResumePausedBody(req.body, ['type'])
  if ('error' in parsed) return res.status(400).json({ detail: parsed.error })
  const projects = await pm.listProjects()
  if (!projects.some(project => project.slug === req.params.slug)) {
    return res.status(404).json({ detail: 'Project not found' })
  }
  await jq.findJobs(req.params.slug, () => false)
  res.status(202).json(await jq.resumePausedJobs({
    projectSlugs: [req.params.slug],
    type: parsed.value.type,
  }))
})

// "Check on running jobs": settle failed rows whose files were all made later.
// Reads disk only — never starts work, never deletes history.
router.post('/projects/:slug/jobs/settle-completed', async (req, res) => {
  if (!await pm.getProject(req.params.slug)) return res.status(404).json({ detail: 'Project not found' })
  res.json({ ok: true, resolved: await settleCompletedFailures(req.params.slug) })
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

router.post('/projects/:slug/jobs/:jobId/replace-failed-items', async (req, res) => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length) {
    return res.status(400).json({ detail: 'Request body must be an empty object. Failed-item scope comes from the saved job and Gateway evidence.' })
  }
  try {
    return res.status(202).json({ ok: true, job: await jq.replaceFailedItems(String(req.params.slug), String(req.params.jobId)) })
  } catch (error: any) {
    return res.status(Number(error?.status) || 409).json({ detail: error?.message || 'Failed items could not be replaced.' })
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
    res.status(202).json({ plan: await recoverEpisode(req.params.slug, req.params.episodeId, true, req.body.source_job_ids, [], true) })
  } catch (error) { res.status(409).json({ detail: error instanceof Error ? error.message : 'Episode recovery is unavailable.' }) }
})

// Read-only: the saved recovery plan(s) for an episode. Unlike `recoverEpisode`, it never creates or changes one.
router.get('/projects/:slug/episodes/:code/recovery-plan', async (req, res) => {
  if (!await pm.getProject(req.params.slug)) return res.status(404).json({ detail: 'Project not found' })
  try {
    const plans = await readEpisodeRecoveryPlans(req.params.slug, req.params.code)
    if (!plans) return res.status(404).json({ detail: `No recovery plan is saved for ${req.params.code}.` })
    res.json(plans)
  } catch (error) { res.status(500).json({ detail: error instanceof Error ? error.message : 'The recovery plan could not be read.' }) }
})

router.post('/projects/:slug/jobs/:jobId/retry', async (req, res) => {
  const existing = jq.getJob(req.params.jobId)
  if (existing?.project_slug === req.params.slug) {
    const admissionError = retryAdmissionError(existing)
    if (admissionError) return res.status(409).json({ detail: admissionError })
  }
  if (existing?.project_slug === req.params.slug && episodeRecoveryStep(existing.type)
    && !(existing.type === 'subtitles_transcribe' && isScopedChapterTranscription(existing.params))) {
    // Recovery refuses, in plain words, saved states it must not guess (for
    // example a plan whose original Pipeline run is gone). That refusal is a
    // deliberate answer for the page, not an unhandled server fault — the same
    // contract `/jobs/recover-episode` already keeps.
    try {
      return res.status(202).json({ ok: true, plan: await recoverEpisode(req.params.slug, existing.episode_id, true, [existing.job_id], [], true) })
    } catch (error) {
      return res.status(409).json({ detail: error instanceof Error ? error.message : 'Episode recovery is unavailable.' })
    }
  }
  const retryParams = existing?.project_slug === req.params.slug ? retryReplacementParams(existing) : undefined
  const job = jq.retryTerminalJob(req.params.slug, req.params.jobId, retryParams)
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
      && evidenceHoldsUnknownOutcome(entry)
    ))) {
      throw Object.assign(new Error('The Gateway could not prove whether an earlier prompt request was accepted. Story Studio kept that evidence and did not submit fresh paid work. Check the Gateway before trying again.'), { status: 409, expose: true })
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

router.post('/projects/:slug/jobs/:jobId/move', async (req, res) => {
  const parsed = parseQueueMoveBody(req.body)
  if ('error' in parsed) return res.status(400).json({ detail: parsed.error })
  const existing = jq.getJob(req.params.jobId)
  if (!existing || existing.project_slug !== req.params.slug) return res.status(404).json({ detail: 'Job not found' })
  const moved = await jq.moveQueuedJob(req.params.slug, req.params.jobId, parsed.value)
  if (!moved) return res.status(409).json({ detail: 'Only queued jobs waiting in their own queue can be moved.' })
  res.json({ ok: true, ...moved })
})

router.post('/projects/:slug/jobs/:jobId/cancel', async (req, res, next) => {
  const existing = (await jq.findJobs(req.params.slug, job => job.job_id === req.params.jobId))[0]
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
  const existing = (await jq.findJobs(req.params.slug, job => job.job_id === req.params.jobId))[0]
  if (!existing || existing.project_slug !== req.params.slug) return res.status(404).json({ detail: 'Job not found' })
  try {
    res.json({ ok: true, job: await jq.recheckJobProviderStatus(req.params.slug, req.params.jobId) })
  } catch (error) {
    next(error)
  }
})

// v1.2.8 — see the /jobs/all sibling above.
router.post('/projects/:slug/jobs/:jobId/abandon', async (req, res, next) => {
  const existing = (await jq.findJobs(req.params.slug, job => job.job_id === req.params.jobId))[0]
  if (!existing || existing.project_slug !== req.params.slug) return res.status(404).json({ detail: 'Job not found' })
  try {
    res.json({ ok: true, job: await jq.forceAbandonJob(req.params.slug, req.params.jobId) })
  } catch (error) {
    next(error)
  }
})

// Hide, never delete — see the `/jobs/all` sibling for why.
router.post('/projects/:slug/jobs/:jobId/hide', async (req, res) => {
  const existing = (await jq.findJobs(req.params.slug, job => job.job_id === req.params.jobId))[0]
  if (!existing || existing.project_slug !== req.params.slug) {
    if (!await jq.hideTerminalJob(req.params.slug, req.params.jobId)) {
      return res.status(404).json({ detail: 'Job not found' })
    }
    return res.json({ ok: true })
  }
  if (!await jq.hideTerminalJob(req.params.slug, req.params.jobId)) return sendTerminalOnlyConflict(res, existing)
  res.json({ ok: true, job: jq.getPublicJob(req.params.jobId) })
})

router.post('/projects/:slug/jobs/:jobId/unhide', async (req, res) => {
  const existing = (await jq.findJobs(req.params.slug, job => job.job_id === req.params.jobId))[0]
  if (!existing || existing.project_slug !== req.params.slug) {
    if (!await jq.unhideTerminalJob(req.params.slug, req.params.jobId)) {
      return res.status(404).json({ detail: 'Job not found' })
    }
    return res.json({ ok: true })
  }
  if (!await jq.unhideTerminalJob(req.params.slug, req.params.jobId)) return sendTerminalOnlyConflict(res, existing)
  res.json({ ok: true, job: jq.getPublicJob(req.params.jobId) })
})

// Bulk: take a whole finished/failed subset off the list, keeping every record.
router.post('/projects/:slug/jobs/hide', async (req, res) => {
  const parsed = parseHistoryClearQuery(req.query)
  if ('error' in parsed) return res.status(400).json({ detail: parsed.error })
  const count = await jq.hideFinished(req.params.slug, parsed.value.status)
  res.json({ ok: true, hidden: count })
})
