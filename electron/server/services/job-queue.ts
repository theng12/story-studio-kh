/**
 * Job queue with 3 parallel async workers (script, images, audio).
 * Uses async functions instead of worker threads for simplicity.
 * Each queue processes one job at a time (FIFO).
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { EventEmitter } from 'events'
import { AsyncLocalStorage } from 'async_hooks'
import type { ChildProcess } from 'child_process'
import { v4 as uuidv4 } from 'uuid'
import { PROJECTS_ROOT, getProjectDir } from './project-manager.js'
import { trackGeneration } from './session-tracker.js'
import { writeJsonAtomic, withLock } from '../lib/atomic-store.js'
import type { Job, JobStats, JobType } from '../models/types.js'
import { assertJobDidNotDeclareIncomplete } from './job-completion.js'

// ── Child-process tracking (for cancel → SIGTERM) ───────────────────────────
//
// AsyncLocalStorage lets long-running generators run inside a context that
// identifies their job. Spawn helpers (runFfmpeg, runFfmpegWithStderr) call
// `trackChild(proc)` to register the child against the current job without
// having to thread a jobId through every function signature. When the user
// cancels, `cancelJob` sends SIGTERM to every registered child so ffmpeg
// actually stops instead of continuing to burn CPU and disk.
//
// A 5-second SIGKILL fallback handles the rare ffmpeg invocation that
// ignores SIGTERM (e.g., stuck in a syscall).

const jobContext = new AsyncLocalStorage<{ jobId: string }>()
const childrenByJob = new Map<string, Set<ChildProcess>>()

/** Spawn helpers call this AFTER the child starts. Safe no-op if the call
 *  site isn't inside a job context (e.g., /debug/info probing ffmpeg). */
export function trackChild(proc: ChildProcess): void {
  const store = jobContext.getStore()
  if (!store) return
  let set = childrenByJob.get(store.jobId)
  if (!set) {
    set = new Set()
    childrenByJob.set(store.jobId, set)
  }
  set.add(proc)
  const drop = () => {
    const s = childrenByJob.get(store.jobId)
    if (s) {
      s.delete(proc)
      if (s.size === 0) childrenByJob.delete(store.jobId)
    }
  }
  proc.once('close', drop)
  proc.once('exit', drop)
  proc.once('error', drop)
}

function killChildrenFor(jobId: string): void {
  const set = childrenByJob.get(jobId)
  if (!set || set.size === 0) return
  for (const proc of set) {
    try { proc.kill('SIGTERM') } catch { /* already dead */ }
  }
  // Escalate to SIGKILL after 5s for any child that ignored SIGTERM.
  setTimeout(() => {
    const still = childrenByJob.get(jobId)
    if (!still) return
    for (const proc of still) {
      try { proc.kill('SIGKILL') } catch { /* already dead */ }
    }
  }, 5_000).unref()
}

/**
 * Shutdown helper: SIGTERM every tracked child across every job, then
 * SIGKILL fallback after `killAfterMs`. Returns the list of pids that
 * received SIGTERM so callers can log a summary.
 *
 * Used by the Electron `before-quit` handler. Without this, a clean quit
 * leaves FFmpeg children running until they finish on their own (orphaned
 * to launchd) — they keep writing to the project's output directory while
 * the next launch shows the corresponding job as "Interrupted by app
 * restart". The user sees a failed job and an unexpectedly busy CPU.
 */
export function killAllTrackedChildren(killAfterMs = 2_000): number[] {
  const pids: number[] = []
  for (const set of childrenByJob.values()) {
    for (const proc of set) {
      if (typeof proc.pid === 'number') pids.push(proc.pid)
      try { proc.kill('SIGTERM') } catch { /* already dead */ }
    }
  }
  // Snapshot the current child set so the SIGKILL pass operates on the
  // same processes — not on anything spawned during the drain window.
  const snapshot: ChildProcess[] = []
  for (const set of childrenByJob.values()) for (const p of set) snapshot.push(p)
  setTimeout(() => {
    for (const proc of snapshot) {
      try { proc.kill('SIGKILL') } catch { /* already dead */ }
    }
  }, killAfterMs).unref()
  return pids
}

/** Test-only: count tracked children across all jobs. */
export function _trackedChildCountForTesting(): number {
  let n = 0
  for (const set of childrenByJob.values()) n += set.size
  return n
}

// ── Event bus ───────────────────────────────────────────────────────────────
// Emits 'update' for every persisted job transition and 'cleared' when a
// project's finished jobs get cleared. Consumed by the SSE stream route in
// routes/jobs.ts so the renderer sees state changes the instant they happen
// instead of waiting up to 3 s for the old polling cadence.
//
// setMaxListeners: one listener per open SSE connection. The app is
// single-instance (see main.ts requestSingleInstanceLock) so 50 is orders
// of magnitude beyond anything realistic.
export const jobEvents = new EventEmitter()
jobEvents.setMaxListeners(50)

function emitUpdate(job: Job): void {
  // Isolate listeners from each other — one bad handler shouldn't break the
  // queue's state machine. EventEmitter.emit is synchronous, so any throw
  // would propagate into the generator; swallow defensively.
  try { jobEvents.emit('update', safeJob(job)) } catch { /* noop */ }
  // Terminal states mean credits were just spent (or confirmed not spent).
  // Drop the provider balance cache so the next `getKieCredits` / etc. read
  // goes live — the UI should show real numbers immediately, not the pre-job
  // balance frozen for up to CREDIT_CACHE_TTL_MS.
  if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') {
    invalidateCreditCacheSoon()
  }
}

// Stream running jobs' output_lines to SSE subscribers on a ~700 ms tick.
// Without this, emitUpdate only fires on status transitions (queued→running
// and running→done/error/cancelled) plus the occasional account-attribution
// event, so the frontend sees `output_lines` frozen between those sparse
// triggers — visible as "live log goes dark during a 10-minute FFmpeg run"
// until the job completes and one terminal update ships the entire array.
//
// Deliberately naive: re-emit every running job every tick. With typically
// 1–2 concurrent running jobs, bandwidth is ~1–3 SSE frames/sec — trivial.
// `.unref()` so the tick doesn't hold the process alive at shutdown.
const LIVE_OUTPUT_FLUSH_MS = 700
setInterval(() => {
  for (const job of jobs.values()) {
    if (job.status === 'running') emitUpdate(job)
  }
}, LIVE_OUTPUT_FLUSH_MS).unref()

// Lazy import to avoid a circular import between utils.ts (which imports
// project-manager for PROJECTS_ROOT, which is also imported here) and this
// module. Resolved once on first call.
let _invalidateCache: (() => void) | null = null
function invalidateCreditCacheSoon(): void {
  if (_invalidateCache) return _invalidateCache()
  import('./utils.js').then(mod => {
    _invalidateCache = mod.invalidateCreditCache
    _invalidateCache()
  }).catch(() => { /* noop — cache invalidation is best-effort */ })
}

function emitCleared(projectSlug: string): void {
  try { jobEvents.emit('cleared', projectSlug) } catch { /* noop */ }
}

const MAX_PERSISTED = 100

// ── In-memory state ─────────────────────────────────────────────────────────

const jobs = new Map<string, Job>()
const cancelled = new Set<string>()
const loadedProjects = new Set<string>()

// Global pause flag. When set, pump() will not dequeue the next job.
// Used by the network-status composable to hold jobs during connectivity loss.
let queuePaused = false

// Simple async FIFO queues
type JobExecutor = (job: Job) => Promise<void>

interface QueueState {
  pending: Job[]
  running: boolean
  executor: JobExecutor | null
}

const queues: Record<JobType, QueueState> = {
  broll_select: { pending: [], running: false, executor: null },
  // Legacy `script` queue removed in M1 — chapters and intro now flow
  // through `script-only` and `introduction-only` independently. The
  // per-chapter refactor added `chapter-only` for targeted regens.
  'script-only': { pending: [], running: false, executor: null },
  'introduction-only': { pending: [], running: false, executor: null },
  'chapter-only': { pending: [], running: false, executor: null },
  // v1.0.72+ outline-first chunked flow. outline_only is a small LLM call
  // (one batch); expand_chapters is the heavier multi-batch expansion.
  // They share queue plumbing with the other script jobs.
  outline_only: { pending: [], running: false, executor: null },
  expand_chapters: { pending: [], running: false, executor: null },
  image_prompts: { pending: [], running: false, executor: null },
  images: { pending: [], running: false, executor: null },
  scene_images: { pending: [], running: false, executor: null },
  thumb_images: { pending: [], running: false, executor: null },
  // images_repair / video_repair are zero-cost recovery jobs — they share
  // the same queue plumbing as their generation siblings but never
  // submit a new provider job.
  images_repair: { pending: [], running: false, executor: null },
  audio: { pending: [], running: false, executor: null },
  audio_merge: { pending: [], running: false, executor: null },
  metadata: { pending: [], running: false, executor: null },
  video: { pending: [], running: false, executor: null },
  video_repair: { pending: [], running: false, executor: null },
  video_assembly: { pending: [], running: false, executor: null },
  subtitles_transcribe: { pending: [], running: false, executor: null },
  // Upload Center — YouTube video upload (resumable) + metadata PATCH.
  youtube_upload: { pending: [], running: false, executor: null },
  // Playlist-only update — adds an existing video to a playlist via
  // playlistItems.insert. Idempotent server-side (YouTube returns 200
  // for an already-present pair, generator treats that as success).
  // Cheap quota-wise (50 units) so it gets its own queue slot rather
  // than blocking behind the heavier upload queue.
  youtube_playlist_update: { pending: [], running: false, executor: null },
  // Backfill thumbnails onto already-uploaded videos (thumbnails.set only,
  // no re-upload). Quota-paced + resumable — own slot so it doesn't block
  // real uploads.
  youtube_thumbnail_refresh: { pending: [], running: false, executor: null },
  // v1.0.89+: B-Roll normalize job. Re-encodes one stock-footage clip to
  // 1080p at the pool's target fps (24 default, 30 optional) so Video
  // Assembly can concat-demux for speed instead of running a per-frame
  // filtergraph at render time. Auto-queued on import when the pool's
  // auto_normalize flag is on (default).
  broll_normalize: { pending: [], running: false, executor: null },
  // B-Roll assembly — concat selected clips + mix narration → final MP4.
  broll_assemble: { pending: [], running: false, executor: null },
  // Vision-LLM auto-tag — frames a clip's midpoint, asks GPT-4o-mini
  // for short tags, writes to the pool sidecar. Cheap (~$0.002/clip).
  broll_autotag: { pending: [], running: false, executor: null },
  // v1.0.122+: B-Roll fetch — downloads one clip from Pexels/Pixabay
  // into the target pool + writes a provenance sidecar. Does NOT
  // auto-chain a normalize job (user-controlled per v1.0.122 design).
  broll_fetch: { pending: [], running: false, executor: null },
  // v1.0.142+: Research phase for the timestamp-driven pipeline.
  // One-shot adapter call (Perplexity / LLM-only)
  // → writes research.json + research.md to the episode dir.
  research_run: { pending: [], running: false, executor: null },
  // v1.0.143+: Scene planner — LLM picks natural narrative beats
  // against the stitched SRT, emits scene_plan.json. 20-60s call.
  scene_plan_run: { pending: [], running: false, executor: null },
  // v1.0.144+: Per-scene image gen for the timestamp-driven pipeline.
  // One job per scene; bulk "Generate all missing" enqueues N of these.
  scene_image_generate: { pending: [], running: false, executor: null },
  // v1.0.535 — bulk scene-image render as ONE Studio Hub batch (fleet-wide).
  scene_images_batch: { pending: [], running: false, executor: null },
  // v1.0.470 — Phase 2: animate one scene's image into a clip (image-to-video).
  scene_clip_generate: { pending: [], running: false, executor: null },
  scene_clips_batch: { pending: [], running: false, executor: null },
  // v1.0.410+: generate stills into an Image Pool (grow the pool).
  image_pool_generate: { pending: [], running: false, executor: null },
  // v1.0.145+: Final ffmpeg render for the timestamp-driven pipeline.
  // Gated on every scene in scene_plan.json being approved.
  timestamp_video_assemble: { pending: [], running: false, executor: null },
  // v1.0.194+: continuity-chain sequential renderer. Renders every scene in
  // scene_plan.json in order, each img2img-anchored to the previous render +
  // the character sheet/characters. One long serial job (resumable).
  continuity_render: { pending: [], running: false, executor: null },
  // v1.0.260: Prompt Director — rewrites scene prompts into the explainer
  // composition (guide-at-side + framed subject) per the Visual Recipe.
  prompt_director: { pending: [], running: false, executor: null },
  // v1.0.260: generate the composition LAYOUT template image from a prompt.
  composition_generate: { pending: [], running: false, executor: null },
  // v1.0.386: Fish S2 expression "Tag all" — LLM markup over every section,
  // saved incrementally so it survives the operator leaving the page.
  expression_markup: { pending: [], running: false, executor: null },
}

/**
 * The set of JobTypes that have a real queue lane. `enqueue()` indexes
 * `queues[type]` directly, so enqueuing a type absent here throws a TypeError
 * (`Cannot read 'pending' of undefined`). Exposed so callers/tests can verify a
 * derived job type is enqueueable BEFORE it reaches the queue.
 */
export function knownJobTypes(): JobType[] {
  return Object.keys(queues) as JobType[]
}

/** Preventive audit hook: every declared job type must be wired at boot. */
export function unregisteredJobTypes(): JobType[] {
  return knownJobTypes().filter(type => queues[type].executor == null)
}

// ── Concurrency groups ──────────────────────────────────────────────────────
//
// Most job types run strictly one-at-a-time (their own group, limit 1):
// image/video/audio/ffmpeg/upload work would thrash the machine or trip
// provider rate limits if overlapped. The LLM *text* generators are the
// exception — they're cheap, I/O-bound, and the LM Studio dispatcher already
// spreads concurrent calls least-busy across the endpoint pool. Different
// episodes are independent (separate folders; enqueue dedup already forbids
// two jobs on the *same* episode+type), so several can safely run at once.
//
// They therefore share ONE budget: `llmConcurrency` jobs at a time across all
// of them COMBINED (not per-type). 1 = the old fully-serial behaviour.
const LLM_GROUP = 'llm'
const SUBTITLE_TRANSCRIBE_GROUP = 'subtitle_transcribe'
const LLM_TYPES: ReadonlySet<JobType> = new Set<JobType>([
  'outline_only', 'expand_chapters', 'metadata', 'image_prompts', 'scene_plan_run',
])
/** Which concurrency group a type belongs to: the shared LLM group, or its
 *  own singleton group (= the type name) so non-LLM types keep one slot. */
function groupOf(type: JobType): string {
  if (type === 'subtitles_transcribe') return SUBTITLE_TRANSCRIBE_GROUP
  return LLM_TYPES.has(type) ? LLM_GROUP : type
}
/** Active (running) job count for the shared LLM group. Non-LLM types track
 *  their single slot via `QueueState.running` (unchanged). */
const groupActive: Record<string, number> = {}
/** Cap for the shared LLM group. Set from app-settings (`script_concurrency`)
 *  at boot + whenever the user changes it in Settings → Performance. */
let llmConcurrency = 3
let subtitleTranscribeConcurrency = 1
export function setLlmConcurrency(n: number): void {
  llmConcurrency = Math.max(1, Math.min(50, Math.floor(Number(n)) || 1))
}
export function getLlmConcurrency(): number {
  return llmConcurrency
}
export function setSubtitleTranscribeConcurrency(n: number): void {
  subtitleTranscribeConcurrency = Math.max(1, Math.min(50, Math.floor(Number(n)) || 1))
  pump('subtitles_transcribe')
}
export function getSubtitleTranscribeConcurrency(): number {
  return subtitleTranscribeConcurrency
}
function groupLimit(group: string): number {
  if (group === LLM_GROUP) return llmConcurrency
  if (group === SUBTITLE_TRANSCRIBE_GROUP) return subtitleTranscribeConcurrency
  return 1
}

// ── Persistence ─────────────────────────────────────────────────────────────

function jobsPath(projectSlug: string): string {
  // Honour linked-project locations so iCloud-synced projects read +
  // write their jobs.json in the right place.
  const dir = getProjectDir(projectSlug) || path.join(PROJECTS_ROOT, projectSlug)
  return path.join(dir, 'jobs.json')
}

function safeJob(job: Job): Omit<Job, never> {
  // Return job without internal executor references
  return { ...job }
}

async function persistJob(job: Job): Promise<void> {
  const p = jobsPath(job.project_slug)
  // Lock + atomic write: concurrent generators can finish at the same time and
  // would otherwise race `read → splice → write` on this shared file.
  await withLock(p, async () => {
    let data: { jobs: any[] } = { jobs: [] }
    try {
      if (existsSync(p)) {
        data = JSON.parse(await fs.readFile(p, 'utf-8'))
        if (!Array.isArray(data.jobs)) data.jobs = []
      }
    } catch { /* corrupt or missing — start fresh */ }

    const idx = data.jobs.findIndex((j: any) => j.job_id === job.job_id)
    if (idx >= 0) {
      data.jobs[idx] = safeJob(job)
    } else {
      data.jobs.push(safeJob(job))
    }

    if (data.jobs.length > MAX_PERSISTED) {
      data.jobs = data.jobs.slice(-MAX_PERSISTED)
    }

    await writeJsonAtomic(p, data)
  })
}

// ── Lazy load persisted jobs on first access ────────────────────────────────

async function loadPersistedJobs(projectSlug: string): Promise<void> {
  if (loadedProjects.has(projectSlug)) return
  loadedProjects.add(projectSlug)
  const p = jobsPath(projectSlug)
  try {
    if (existsSync(p)) {
      const data = JSON.parse(await fs.readFile(p, 'utf-8'))
      for (const j of data.jobs || []) {
        if (!jobs.has(j.job_id)) {
          // Mark any previously-running/queued jobs as interrupted.
          // Persist the mutation so the on-disk record matches what the
          // in-memory map says — without this, jobs.json keeps reporting
          // the stale 'running'/'queued' status forever, and any
          // out-of-process tool inspecting the file (or a future restart
          // of this same process) sees a contradictory state.
          // See __tests__/job-queue-stale-running-persist.test.ts.
          let mutated = false
          if (j.status === 'running' || j.status === 'queued') {
            j.status = 'error'
            j.error = 'Interrupted by app restart'
            j.finished_at = j.finished_at || new Date().toISOString()
            mutated = true
          }
          jobs.set(j.job_id, j)
          if (mutated) {
            try { await persistJob(j) } catch (e: any) {
              // Best-effort — disk full / perms drift. The in-memory
              // mutation still applies for this process; next successful
              // persist (e.g. when the user clicks "clear" or a new job
              // runs) will heal the file via the queue's atomic-rewrite
              // path. Logging at warn level so the operator can spot it
              // if it becomes chronic.
              console.warn('[job-queue] failed to persist interrupted-job mutation', { job_id: j.job_id, error: e?.message })
            }
          }
        }
      }
    }
  } catch { /* ignore corrupt file */ }
}

// ── Queue processing ────────────────────────────────────────────────────────

/**
 * Launch as many pending jobs of `type` as its concurrency group allows.
 * Non-LLM types keep a single slot (`q.running`, unchanged); LLM types share
 * the `llmConcurrency` budget across the whole group. Synchronous: the whole
 * budget is consumed before any launched job yields, so no double-launch race.
 */
function pump(type: JobType): void {
  if (queuePaused) return  // network is down; jobs wait
  const q = queues[type]
  const group = groupOf(type)
  if (group === LLM_GROUP || group === SUBTITLE_TRANSCRIBE_GROUP) {
    while (q.pending.length > 0 && (groupActive[group] || 0) < groupLimit(group)) {
      const job = q.pending.shift()!
      groupActive[group] = (groupActive[group] || 0) + 1
      runJob(type, job).catch(e => console.error(`[job-queue] Error processing ${type}:`, e))
    }
  } else {
    if (q.running || q.pending.length === 0) return
    q.running = true
    const job = q.pending.shift()!
    runJob(type, job).catch(e => console.error(`[job-queue] Error processing ${type}:`, e))
  }
}

/** A freed LLM slot can be taken by ANY text generator, not just the one that
 *  finished — so re-pump every type in the group. */
function pumpGroup(group: string): void {
  if (group === LLM_GROUP) for (const t of LLM_TYPES) pump(t)
  else if (group === SUBTITLE_TRANSCRIBE_GROUP) pump('subtitles_transcribe')
}

/** Release the slot a finished job held, then pull in the next work. */
function releaseSlot(type: JobType): void {
  const group = groupOf(type)
  if (group === LLM_GROUP || group === SUBTITLE_TRANSCRIBE_GROUP) {
    groupActive[group] = Math.max(0, (groupActive[group] || 0) - 1)
    pumpGroup(group)
  } else {
    queues[type].running = false
    pump(type)
  }
}

/**
 * Persist a chain handoff failure as its own terminal job. Without this record
 * the completed parent looked successful and batch aggregation had no evidence
 * that every downstream step was silently abandoned.
 */
async function recordChainHandoffFailure(
  parent: Job,
  nextStep: { type?: unknown; title?: unknown; params?: unknown },
  rest: unknown[],
  cause: unknown,
): Promise<Job> {
  const now = new Date().toISOString()
  const type = String(nextStep?.type || 'unknown') as JobType
  const message = cause instanceof Error ? cause.message : String(cause)
  const batchId = parent.params?.pipeline_batch_id
  const failed: Job = {
    job_id: uuidv4().slice(0, 8),
    project_slug: parent.project_slug,
    type,
    episode_id: parent.episode_id,
    title: typeof nextStep?.title === 'string'
      ? nextStep.title
      : `[batch] ${type} — ${parent.episode_id}`,
    status: 'error',
    created_at: now,
    started_at: now,
    finished_at: now,
    error: `Pipeline handoff failed before this step started: ${message}`,
    output_lines: [
      `Previous step: ${parent.type} (${parent.job_id})`,
      `Could not start ${type}: ${message}`,
      'No provider call was made for this step. Use the batch Retry action to run only unfinished work.',
    ],
    params: {
      ...((nextStep?.params && typeof nextStep.params === 'object') ? nextStep.params : {}),
      episode_id: parent.episode_id,
      pipeline_chain: rest,
      ...(batchId ? { pipeline_batch_id: batchId } : {}),
      pipeline_handoff_failed: true,
      pipeline_parent_job_id: parent.job_id,
    },
  }
  jobs.set(failed.job_id, failed)
  await persistJob(failed)
  emitUpdate(failed)
  return failed
}

/**
 * Full lifecycle for one job: mark running → run executor → persist final
 * status → chain the next pipeline step → release the slot. Fire-and-forget
 * from pump(); the `finally` guarantees the slot is released even on error so
 * the queue never deadlocks.
 */
async function runJob(type: JobType, job: Job): Promise<void> {
  const q = queues[type]
  try {
    if (cancelled.has(job.job_id)) {
      job.status = 'cancelled'
      job.finished_at = new Date().toISOString()
      jobs.set(job.job_id, job)
      await persistJob(job)
      emitUpdate(job)
      return
    }

    // Mark running
    job.status = 'running'
    job.started_at = new Date().toISOString()
    jobs.set(job.job_id, job)
    await persistJob(job)
    emitUpdate(job)

    try {
      if (!q.executor) throw new Error(`No executor registered for job type: ${type}`)
      // Run the executor inside a per-job AsyncLocalStorage context so any
      // child processes spawned deep in the call tree register against this
      // job id via `trackChild(proc)`. Without this, a cancelled FFmpeg
      // assembly would keep running until it finished or hit an error.
      await jobContext.run({ jobId: job.job_id }, () => q.executor!(job))
      assertJobDidNotDeclareIncomplete(job)
      if (cancelled.has(job.job_id)) {
        // Job was cancelled while running — don't override status
        // (cancelJob may have already set status from another call context)
        job.status = 'cancelled'
      } else if (job.status === 'running') {
        job.status = 'done'
        // Track generation for session stats
        const typeMap: Record<string, 'script' | 'image' | 'audio'> = { 'script-only': 'script', 'introduction-only': 'script', 'chapter-only': 'script', images: 'image', scene_images: 'image', thumb_images: 'image', audio: 'audio', audio_merge: 'audio', video: 'image' }
        const trackType = typeMap[job.type]
        if (trackType) {
          trackGeneration(job.project_slug, trackType).catch(() => {})
        }

        // Pipeline batch auto-chain: if this job was queued as part of a
        // batch run (see routes/pipeline.ts), enqueue the next step for the
        // same episode. Chain naturally stops on failure/cancellation because
        // we only get here when status === 'running' → 'done' transitions.
        const chain = job.params?.pipeline_chain
        if (Array.isArray(chain) && chain.length > 0) {
          const [nextStep, ...rest] = chain
          if (nextStep && typeof nextStep.type === 'string') {
            try {
              const batchId = job.params.pipeline_batch_id
              enqueue({
                project_slug: job.project_slug,
                type: nextStep.type as JobType,
                episode_id: job.episode_id,
                title: nextStep.title || `[batch] ${nextStep.type} — ${job.episode_id}`,
                params: {
                  ...(nextStep.params || {}),
                  episode_id: job.episode_id,
                  pipeline_chain: rest,
                  ...(batchId ? { pipeline_batch_id: batchId } : {}),
                },
              })
              job.output_lines.push(`→ Chained next step: ${nextStep.type}`)
            } catch (e: any) {
              const failed = await recordChainHandoffFailure(job, nextStep, rest, e)
              job.output_lines.push(`Chain-next failed: ${e.message} (recorded as failed job ${failed.job_id})`)
            }
          }
        }
      }
    } catch (e: any) {
      // If the job was cancelled mid-flight the executor typically rejects
      // with an FFmpeg-exited error or a "Cancelled by user" from a cancel
      // probe — either way, the user's intent is "cancelled", not "error".
      if (cancelled.has(job.job_id)) {
        job.status = 'cancelled'
      } else {
        job.status = 'error'
        job.error = e.message
        job.output_lines.push(`Error: ${e.message}`)
      }
    }

    job.finished_at = new Date().toISOString()
    jobs.set(job.job_id, job)
    await persistJob(job)
    emitUpdate(job)
  } finally {
    releaseSlot(type)
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

export function registerExecutor(type: JobType, executor: JobExecutor): void {
  queues[type].executor = executor
}

export function setQueuePaused(paused: boolean): void {
  const wasPaused = queuePaused
  queuePaused = paused
  if (wasPaused && !paused) {
    // Resuming — kick every type's queue so any pending jobs pick up. pump()
    // is a no-op when the type's slot/group budget is already full.
    for (const type of Object.keys(queues) as JobType[]) {
      pump(type)
    }
  }
}

export function isQueuePaused(): boolean {
  return queuePaused
}

/**
 * Is there already a queued/running job of this kind for the same project +
 * episode? Optional `paramsMatch` predicate narrows the dedupe to a subset of
 * jobs whose params satisfy the predicate — used by `chapter-only` to dedupe
 * per (episode, chapter) instead of per (episode, type), so the user can
 * queue multiple chapter regens in a row without each one rejecting the next.
 */
export function isDuplicate(
  projectSlug: string,
  episodeId: string,
  jobType: string,
  paramsMatch?: (params: any) => boolean,
): boolean {
  for (const job of jobs.values()) {
    if (job.project_slug === projectSlug && job.episode_id === episodeId
        && job.type === jobType && (job.status === 'queued' || job.status === 'running')) {
      if (paramsMatch && !paramsMatch(job.params || {})) continue
      return true
    }
  }
  return false
}

/** True if the given job has been cancelled. Generators should poll this at
 *  safe points inside long-running loops so a user-cancelled job stops
 *  burning provider calls instead of running to completion. */
export function isCancelled(jobId: string): boolean {
  return cancelled.has(jobId)
}

/** Thrown by `enqueue` when the same (project, episode, type) is already
 *  queued or running. Carries HTTP status + expose flag so the global error
 *  handler in app.ts returns a 409 to the client with a useful detail. */
export class DuplicateJobError extends Error {
  status = 409
  expose = true
  constructor(type: JobType, episodeId: string) {
    super(`${type} generation already queued/running for ${episodeId}`)
    this.name = 'DuplicateJobError'
  }
}

/**
 * Sync OR async dispatch — single call site that picks between running
 * an executor inline (returning when it completes) and enqueueing it.
 *
 * Why this exists: today image-prompts and metadata generation run
 * synchronously inside their HTTP route handlers, while everything else
 * goes through the queue. Future work (M5 in the system audit) will
 * migrate them to the queue so they show up in the Jobs tab and become
 * retryable. This adapter is the seam: when the migration happens, the
 * call site changes from `{ sync: true }` to `{ sync: false }` and
 * everything else stays the same. No executor rewrite required.
 *
 * Sync semantics:
 *   - Synthesises a Job, runs the registered executor against it, awaits.
 *   - The job is NOT persisted to disk and does NOT appear in /jobs —
 *     it's a one-shot foreground call. This matches today's synchronous
 *     endpoints' UX: the request is in flight, then it returns.
 *   - Cancellation, deduplication, and SSE updates do NOT apply.
 *   - Throws if the executor throws (route handlers should let Express
 *     translate to a 500 just like they do today).
 *
 * Async semantics: identical to `enqueue` — returns the queued job.
 */
export async function enqueueOrRun(opts: {
  project_slug: string
  type: JobType
  episode_id: string
  title?: string
  params?: Record<string, any>
  sync?: boolean
}): Promise<Job> {
  if (!opts.sync) return enqueue(opts)

  const executor = queues[opts.type]?.executor
  if (!executor) throw new Error(`enqueueOrRun(sync): no executor registered for ${opts.type}`)

  const jobId = uuidv4().slice(0, 8)
  const job: Job = {
    job_id: jobId,
    project_slug: opts.project_slug,
    type: opts.type,
    episode_id: opts.episode_id,
    title: opts.title || '',
    status: 'running',
    created_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    finished_at: null,
    error: null,
    output_lines: [],
    params: opts.params || {},
  }
  try {
    await executor(job)
    assertJobDidNotDeclareIncomplete(job)
    job.status = 'done'
    job.finished_at = new Date().toISOString()
  } catch (e: any) {
    job.status = 'error'
    job.error = e?.message || String(e)
    job.finished_at = new Date().toISOString()
    throw e
  }
  return safeJob(job)
}

export function enqueue(opts: {
  project_slug: string
  type: JobType
  episode_id: string
  title?: string
  params?: Record<string, any>
  /** Narrow the duplicate check to jobs whose params satisfy this predicate.
   *  When omitted, dedupe is per (project, episode, type) — the historical
   *  behaviour. chapter-only passes a predicate that compares
   *  `params.chapter_number` so two regens for different chapters can both
   *  enqueue (run back-to-back) without rejecting each other. */
  dedupeParams?: (params: any) => boolean
}): Job {
  if (!queues[opts.type]) {
    throw new Error(`No queue lane registered for job type: ${opts.type}`)
  }
  // Atomic dedupe: the check and the insert happen in the same synchronous
  // tick. Callers MUST NOT gate on isDuplicate() separately — two routes
  // racing the check could both pass and both enqueue. This is the single
  // serialisation point for queue insertion.
  if (isDuplicate(opts.project_slug, opts.episode_id, opts.type, opts.dedupeParams)) {
    throw new DuplicateJobError(opts.type, opts.episode_id)
  }

  const jobId = uuidv4().slice(0, 8)
  const job: Job = {
    job_id: jobId,
    project_slug: opts.project_slug,
    type: opts.type,
    episode_id: opts.episode_id,
    title: opts.title || '',
    status: 'queued',
    created_at: new Date().toISOString(),
    started_at: null,
    finished_at: null,
    error: null,
    output_lines: [],
    params: opts.params || {},
  }

  jobs.set(jobId, job)
  queues[opts.type].pending.push(job)
  persistJob(job).catch(e => console.error('[job-queue] Failed to persist:', e))
  // Emit synchronously so SSE subscribers see the new queued job before the
  // route handler replies — otherwise the renderer's optimistic UI and the
  // backend event race on which reaches the user first.
  emitUpdate(job)

  // Kick off processing
  pump(opts.type)

  return safeJob(job)
}

export async function getJobs(projectSlug: string): Promise<Job[]> {
  await loadPersistedJobs(projectSlug)
  const projectJobs: Job[] = []
  for (const job of jobs.values()) {
    if (job.project_slug === projectSlug) {
      const j = safeJob(job)
      if (j.status === 'queued') {
        const q = queues[job.type]
        j.queue_position = q ? q.pending.findIndex(p => p.job_id === j.job_id) + 1 : 0
      }
      projectJobs.push(j)
    }
  }

  const order: Record<string, number> = { running: 0, queued: 1, done: 2, cancelled: 3, error: 3 }
  projectJobs.sort((a, b) => (order[a.status] ?? 4) - (order[b.status] ?? 4))
  return projectJobs
}

export function getJob(jobId: string): Job | null {
  const job = jobs.get(jobId)
  return job ? safeJob(job) : null
}

/**
 * Record which account served a provider for a running job. Called from the
 * secrets-aware resolver (providers/registry.ts) when `ctx.jobId` is set.
 * Merges into the job's `accounts_used` map — same provider overwrites with
 * the latest label snapshot, different providers accumulate — then fires
 * `jobEvents.emit('update', …)` so the Jobs-page SSE stream picks up the
 * attribution live.
 *
 * Silent no-op when the jobId is unknown (the job finished or was never
 * queued) — attribution is bookkeeping, it must never fail a generation.
 */
export function recordAccountUsed(
  jobId: string,
  providerId: string,
  account: { id: string; label: string },
): void {
  const job = jobs.get(jobId)
  if (!job) return
  if (!job.accounts_used) job.accounts_used = {}
  job.accounts_used[providerId] = { id: account.id, label: account.label }
  emitUpdate(job)
}

export function cancelJob(jobId: string): boolean {
  const job = jobs.get(jobId)
  if (!job) return false

  // If queued, cancel it
  if (job.status === 'queued') {
    cancelled.add(jobId)
    job.status = 'cancelled'
    job.finished_at = new Date().toISOString()
    persistJob(job).catch(() => {})
    emitUpdate(job)
    return true
  }

  // If running, mark as cancelled, kill any spawned child processes
  // (FFmpeg for video assembly, audio merge, etc.), and let the
  // generators' AbortController watchers tear down in-flight provider
  // HTTP calls. Each generator installs a 500 ms watcher that polls
  // `isCancelled(jobId)` and aborts the current fetch/stream — so a
  // cancelled image batch stops polling kie.ai, a cancelled TTS batch
  // stops the ElevenLabs stream, and so on. Short submit requests that
  // don't carry a signal may still complete; that's fine — the batch
  // stops starting new work immediately.
  if (job.status === 'running') {
    cancelled.add(jobId)
    job.status = 'cancelled'
    job.finished_at = new Date().toISOString()
    job.output_lines.push('Cancelled by user')
    killChildrenFor(jobId)
    persistJob(job).catch(() => {})
    emitUpdate(job)
    return true
  }

  // If done/error/cancelled, remove from memory
  if (['done', 'error', 'cancelled'].includes(job.status)) {
    jobs.delete(jobId)
    // Synthesise a final "gone" event so subscribers can drop the row even
    // though we're deleting it entirely (not transitioning its status).
    emitCleared(job.project_slug)
    return true
  }

  return false
}

export async function clearFinished(projectSlug: string): Promise<number> {
  await loadPersistedJobs(projectSlug)
  let count = 0
  for (const [id, job] of jobs.entries()) {
    if (job.project_slug === projectSlug && ['done', 'error', 'cancelled'].includes(job.status)) {
      jobs.delete(id)
      count++
    }
  }
  // Persist cleaned list atomically — serialise against any in-flight persistJob.
  const p = jobsPath(projectSlug)
  await withLock(p, async () => {
    const remaining = Array.from(jobs.values())
      .filter(j => j.project_slug === projectSlug)
      .map(j => safeJob(j))
    await writeJsonAtomic(p, { jobs: remaining })
  }).catch(() => {})
  if (count > 0) emitCleared(projectSlug)
  return count
}

export function getQueueStats(projectSlug?: string): JobStats {
  let jobList = Array.from(jobs.values())
  if (projectSlug) jobList = jobList.filter(j => j.project_slug === projectSlug)
  return {
    running: jobList.filter(j => j.status === 'running').length,
    queued: jobList.filter(j => j.status === 'queued').length,
    done: jobList.filter(j => j.status === 'done').length,
    error: jobList.filter(j => j.status === 'error').length,
    total: jobList.length,
  }
}
