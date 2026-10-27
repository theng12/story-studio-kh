/**
 * The embedding worker — the thread that actually holds the model.
 *
 * Started by `local-embedding-worker-host.ts`, never directly. It answers
 * batches of `{kind, input}` with a unit vector or a reason, and does no
 * policy: thresholds, caching and the decision to run at all live on the main
 * thread, so this file has nothing to get wrong about what a score means.
 *
 * One per-item failure is reported per item (`embedding: null` plus a reason)
 * and does not stop the batch (§8: preserve what worked, say what did not). A
 * failure that makes the whole batch impossible — the model missing or the
 * runtime refusing to load — comes back as `fatal`, so the main thread can
 * record `not_checked` once instead of inventing a reason per picture.
 */
import fs from 'node:fs'
import path from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'

import { createEncoder, type Encoder } from './local-embedding-encoder.js'

interface EmbeddingTask { kind: 'image' | 'text'; input: string }
interface EmbeddingOutcome { embedding: number[] | null; error?: string }
interface WorkerRequest { id: number; tasks: EmbeddingTask[] }
interface WorkerReply { id: number; results?: EmbeddingOutcome[]; fatal?: string }

let encoder: Encoder | null = null
let encoderFailure: string | null = null

async function ensureEncoder(): Promise<Encoder> {
  if (encoder) return encoder
  if (encoderFailure) throw new Error(encoderFailure)
  try {
    const settings = workerData as { modelDir: string; runtimeDir: string }
    // The model files are verified on the main thread before this thread is
    // ever started; this is the cheap sanity check that they are still there.
    for (const required of ['config.json', 'processor_config.json', 'onnx/model_quantized.onnx', 'onnx/vision_encoder.onnx']) {
      if (!fs.existsSync(path.join(settings.modelDir, required))) {
        throw new Error(`The screening model is incomplete (${required} is missing).`)
      }
    }
    encoder = await createEncoder(settings)
    return encoder
  } catch (error: any) {
    encoderFailure = `The screening model could not be loaded (${error?.message || 'unknown error'}).`
    throw new Error(encoderFailure)
  }
}

async function handle(request: WorkerRequest): Promise<WorkerReply> {
  let active: Encoder
  try {
    active = await ensureEncoder()
  } catch (error: any) {
    return { id: request.id, fatal: error?.message || 'The screening model could not be loaded.' }
  }
  const results: EmbeddingOutcome[] = []
  for (const task of request.tasks) {
    try {
      const embedding = task.kind === 'image'
        ? await active.embedImage(task.input)
        : await active.embedText(task.input)
      results.push({ embedding })
    } catch (error: any) {
      // One bad picture (truncated, wrong format) must not cost the batch.
      results.push({ embedding: null, error: `Could not encode ${task.kind === 'image' ? path.basename(task.input) : 'that text'} (${error?.message || 'unknown error'}).` })
    }
  }
  return { id: request.id, results }
}

parentPort?.on('message', (request: WorkerRequest) => {
  void handle(request).then(reply => parentPort?.postMessage(reply))
})
