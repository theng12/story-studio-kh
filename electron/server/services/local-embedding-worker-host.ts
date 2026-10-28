/**
 * The embedding worker host — the off-main-thread half of duplicate screening.
 *
 * Why a worker at all: loading the model costs ~1.4 GB of resident memory and
 * a WebGPU context, and a server that did that in its own process would hold
 * both for the life of the app even when the feature is idle for hours. A
 * worker can be torn down, and measured in this repo, `terminate()` returns the
 * process to 108 MB (from 1,095 MB) immediately.
 *
 * Three rules, all measured rather than assumed (owner, 2026-10-27):
 *
 * - **Bounded memory, one job at a time.** There is exactly one worker, and a
 *   second request waits for the first. Two concurrent model loads would double
 *   the resident set for no gain: this is background screening.
 * - **Idle means gone.** The worker shuts itself down after `IDLE_TIMEOUT_MS`
 *   with no work, so a Mac that screened one episode an hour ago is not still
 *   holding a model.
 * - **Never runs switched off.** Every entry point asks the caller's gate
 *   first; a disabled feature does not start a worker, and an absent model is
 *   reported as `not_checked` rather than downloaded or invented.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

import { localModelDir, localModelLooksInstalled, localRuntimeDir } from './local-model-store.js'

/** How long the worker stays warm after its last job. */
export const IDLE_TIMEOUT_MS = 90_000

export type EmbeddingTaskKind = 'image' | 'text'

export interface EmbeddingTask {
  kind: EmbeddingTaskKind
  /** Absolute path for `image`; the string itself for `text`. */
  input: string
}

export interface EmbeddingOutcome {
  /** The unit vector, or null when this item could not be encoded. */
  embedding: number[] | null
  /** Why it could not be encoded, when it could not — never a silent null. */
  error?: string
}

interface WorkerRequest {
  id: number
  tasks: EmbeddingTask[]
}

interface WorkerReply {
  id: number
  results?: EmbeddingOutcome[]
  /** A failure that stopped the whole batch (model load, runtime missing). */
  fatal?: string
}

/** Set by a test so no real model is needed. */
let encoderOverride: ((tasks: EmbeddingTask[]) => Promise<EmbeddingOutcome[]>) | null = null
export function _setEmbeddingEncoderForTesting(
  fn: ((tasks: EmbeddingTask[]) => Promise<EmbeddingOutcome[]>) | null,
): void {
  encoderOverride = fn
}

/** Set by a test to observe whether a worker was started at all. */
let workerStarts = 0
export function _workerStartsForTesting(): number {
  return workerStarts
}

let worker: Worker | null = null
let workerReady: Promise<Worker> | null = null
let idleTimer: NodeJS.Timeout | null = null
let nextRequestId = 1
/** One job at a time: every request chains onto this promise. */
let queue: Promise<unknown> = Promise.resolve()

/**
 * This module's own directory.
 *
 * `package.json` is `"type": "module"`, so there is no global `__dirname` —
 * every existing service derives one this way (see `ffmpeg-manager.ts`).
 */
const moduleDir = path.dirname(fileURLToPath(import.meta.url))

/** The worker script, compiled beside this one. */
function workerScriptPath(): string {
  // `moduleDir` is `electron/dist/server/services` in a built app and
  // `electron/server/services` under tsx; the worker is compiled next to us in
  // both cases.
  return path.join(moduleDir, 'local-embedding-worker.js')
}

function clearIdleTimer(): void {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
}

function scheduleIdleShutdown(): void {
  clearIdleTimer()
  // Idle means gone, and an idle worker must not be what keeps the app's event
  // loop alive, so both the timer and the worker are unref'd here — after the
  // job that needed them has finished.
  worker?.unref?.()
  idleTimer = setTimeout(() => {
    idleTimer = null
    void shutdownWorker()
  }, IDLE_TIMEOUT_MS)
  // Never keep the process alive just to wait for the shutdown.
  idleTimer.unref?.()
}

async function shutdownWorker(): Promise<void> {
  const current = worker
  worker = null
  workerReady = null
  if (!current) return
  try {
    await current.terminate()
  } catch { /* already gone */ }
}

async function startWorker(): Promise<Worker> {
  if (workerReady) return workerReady
  workerStarts += 1
  const created = new Worker(workerScriptPath(), {
    workerData: { modelDir: localModelDir(), runtimeDir: localRuntimeDir() },
    // The model is the memory; a bigger heap here buys nothing.
    resourceLimits: { maxOldGenerationSizeMb: 512 },
  })
  // Deliberately NOT unref'd here. A pending job is the only reason this worker
  // exists, and an unref'd worker lets Node exit under a job it is still working
  // on (measured: a batch of images silently never resolved). It is unref'd
  // again the moment it goes idle, in `scheduleIdleShutdown`, so an idle worker
  // still cannot hold the process open.
  created.ref?.()
  const ready = new Promise<Worker>((resolve, reject) => {
    const onError = (error: Error) => { reject(error) }
    created.once('error', onError)
    created.once('online', () => {
      created.off('error', onError)
      resolve(created)
    })
  })
  worker = created
  workerReady = ready
  try {
    return await ready
  } catch (error) {
    await shutdownWorker()
    throw error
  }
}

/** Send one batch to the worker and wait for its reply. */
function runInWorker(target: Worker, request: WorkerRequest): Promise<WorkerReply> {
  return new Promise<WorkerReply>((resolve, reject) => {
    const onMessage = (reply: WorkerReply) => {
      if (reply?.id !== request.id) return
      cleanup()
      resolve(reply)
    }
    const onError = (error: Error) => { cleanup(); reject(error) }
    const onExit = (code: number) => {
      cleanup()
      reject(new Error(`The embedding worker exited early (code ${code}).`))
    }
    function cleanup(): void {
      target.off('message', onMessage)
      target.off('error', onError)
      target.off('exit', onExit)
    }
    target.on('message', onMessage)
    target.on('error', onError)
    target.on('exit', onExit)
    target.postMessage(request)
  })
}

/**
 * Encode a batch, off the main thread.
 *
 * Returns one outcome per task, in order. A batch that cannot run at all (the
 * model is not downloaded, the runtime is missing, the worker died) resolves to
 * outcomes carrying the reason — callers turn that into `not_checked`. It never
 * throws for an ordinary absence, because absence is not an error here.
 */
export async function embedBatch(tasks: EmbeddingTask[]): Promise<EmbeddingOutcome[]> {
  if (!tasks.length) return []
  const unavailable = (reason: string): EmbeddingOutcome[] =>
    tasks.map(() => ({ embedding: null, error: reason }))

  if (!(await localModelLooksInstalled())) {
    return unavailable('The screening model has not been downloaded, so nothing was checked.')
  }

  // EVERY batch goes through the queue, including a stubbed one, so "one job at
  // a time" is a property of this function rather than of the branch a caller
  // happened to take. The stub path used to return early and sit outside the
  // queue entirely.
  const run = queue.then(async () => {
    clearIdleTimer()
    if (encoderOverride) {
      try {
        return await encoderOverride(tasks)
      } finally {
        scheduleIdleShutdown()
      }
    }
    let target: Worker
    try {
      target = await startWorker()
    } catch (error: any) {
      return unavailable(`The embedding worker could not start (${error?.message || 'unknown error'}), so nothing was checked.`)
    }
    const request: WorkerRequest = { id: nextRequestId++, tasks }
    try {
      const reply = await runInWorker(target, request)
      if (reply.fatal) return unavailable(reply.fatal)
      const results = reply.results || []
      // A short reply is a broken worker, not a pass: pad it with reasons.
      while (results.length < tasks.length) {
        results.push({ embedding: null, error: 'The embedding worker returned no answer for this item.' })
      }
      return results
    } catch (error: any) {
      // A worker that threw or died is discarded so the next call gets a clean one.
      await shutdownWorker()
      return unavailable(`The embedding worker stopped (${error?.message || 'unknown error'}), so nothing was checked.`)
    } finally {
      scheduleIdleShutdown()
    }
  })
  queue = run.catch(() => undefined)
  return run
}

/** Stop the worker now. Used by tests and by the Remove button. */
export async function stopEmbeddingWorker(): Promise<void> {
  clearIdleTimer()
  await shutdownWorker()
}
