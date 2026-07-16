/**
 * kie.ai image generation client.
 * Port of generate_images.py submit_generation + poll_for_image_urls.
 * Supports all 4 payload format types: jobs, flux, 4o, gpt-image.
 */

import fs from 'fs/promises'
import { createWriteStream } from 'fs'
import path from 'path'
import { pipeline } from 'stream/promises'
import { Readable, Transform } from 'stream'
import { studioFetch } from './studio-auth.js'
import { getHubBackend, hubHeaders } from './studiohub-client.js'
import { sleepCancellable } from './http-retry.js'
import { redactSecrets } from './redact-secrets.js'
import type { ImageModelConfig } from '../models/types.js'

const KIE_BASE_URL = 'https://api.kie.ai/api/v1'
const KIE_FILE_UPLOAD_URL = 'https://kieai.redpandaai.co/api/file-stream-upload'
const POLL_INTERVAL = 6000 // ms
const MAX_WAIT = 360000 // 6 minutes
const MAX_CONSECUTIVE_FAILURES = 8

/**
 * Phase 8 — encode local reference images as base64 data URLs for inclusion
 * in the kie.ai payload. kie's Flux Kontext + nano-banana endpoints accept
 * data URLs directly (no separate hosting step required). We cap at 3
 * references per request to stay within typical payload limits.
 */
async function encodeReferenceImages(absolutePaths: string[]): Promise<string[]> {
  const encoded: string[] = []
  for (const p of absolutePaths.slice(0, 3)) {
    try {
      const buf = await fs.readFile(p)
      const ext = path.extname(p).toLowerCase().replace('.', '') || 'png'
      const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`
      encoded.push(`data:${mime};base64,${buf.toString('base64')}`)
    } catch (e: any) {
      console.warn(`[kie-client] reference image unreadable, skipping (${p}): ${e.message}`)
    }
  }
  return encoded
}

async function uploadReferenceImages(apiKey: string, absolutePaths: string[]): Promise<string[]> {
  const uploaded: string[] = []
  for (const p of absolutePaths.slice(0, 3)) {
    try {
      const buf = await fs.readFile(p)
      const ext = path.extname(p).toLowerCase() || '.png'
      const original = path.basename(p) || `reference${ext}`
      const safeName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${original.replace(/[^\w.-]+/g, '_')}`
      const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png'
      const form = new FormData()
      form.append('file', new Blob([buf as any], { type: mime }), safeName)
      form.append('uploadPath', 'images/story-studio')
      form.append('fileName', safeName)
      const resp = await fetch(KIE_FILE_UPLOAD_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal: AbortSignal.timeout(60000),
      })
      if (!resp.ok) {
        const text = await resp.text().catch(() => '')
        throw new Error(`HTTP ${resp.status}: ${redactSecrets(text, apiKey).slice(0, 200)}`)
      }
      const data = await resp.json() as any
      const url = data?.data?.downloadUrl || data?.data?.fileUrl || data?.data?.url
      if (typeof url !== 'string' || !url) throw new Error(`No uploaded file URL in response: ${JSON.stringify(data).slice(0, 200)}`)
      uploaded.push(url)
    } catch (e: any) {
      console.warn(`[kie-client] reference image upload failed, skipping (${p}): ${e.message}`)
    }
  }
  return uploaded
}

export async function submitGeneration(
  prompt: string, apiKey: string, aspectRatio: string,
  modelConfig: ImageModelConfig,
  opts: { referenceImagePaths?: string[] } = {},
): Promise<string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  }

  // Phase 8: only kie's reference-capable endpoints (Flux Kontext, nano-banana)
  // ingest input images. Caller is expected to gate the call behind
  // `supports_reference_images` so we don't pay payload overhead for models
  // that ignore the field. Empty array = no encoding work.
  const refsField = modelConfig.refs_field || 'image_urls'
  const needsUploadedUrls = refsField === 'input_urls' || (modelConfig as any).refs_upload === true
  const refs = (opts.referenceImagePaths && opts.referenceImagePaths.length)
    ? (needsUploadedUrls
        ? await uploadReferenceImages(apiKey, opts.referenceImagePaths)
        : await encodeReferenceImages(opts.referenceImagePaths))
    : []

  // Some kie.ai models swap their model slug between text-to-image and
  // image-to-image (GPT Image 2, original Nano Banana). When refs are
  // attached, prefer the i2i variant slug if the model config provides one.
  const activeModel = (refs.length && modelConfig.api_model_i2i)
    ? modelConfig.api_model_i2i
    : modelConfig.api_model

  // Per-model field names — kie.ai's catalog is inconsistent here. Each
  // model declares its own refs field (`image_urls`, `image_input`,
  // `input_urls`, `inputImages`) and aspect-ratio field (`aspect_ratio`
  // vs `image_size`). Defaults match the historical behaviour for models
  // that didn't bother to override.
  const aspectField = modelConfig.aspect_field || 'aspect_ratio'

  let payload: any

  switch (modelConfig.type) {
    case 'flux':
      // Flux Kontext field convention per kie.ai docs: `inputImage` (single)
      // or `inputImages` (array). We send the array form when we have refs;
      // models that don't honour it will still process the prompt-only path.
      payload = { prompt, aspectRatio, model: activeModel }
      if (refs.length) payload.inputImages = refs
      break
    case '4o':
      payload = { prompt, size: aspectRatio }
      // The /gpt4o-image/generate endpoint also accepts inputImages for
      // its image-edit variants; harmless on text-to-image models.
      if (refs.length) payload.inputImages = refs
      break
    case 'gpt-image': {
      // GPT Image 2 has its own aspect-ratio constraints — the t2i endpoint
      // accepts the full standard list, the i2i endpoint same. Keep the
      // value verbatim; kie.ai validates server-side.
      payload = { model: activeModel, input: { prompt, aspect_ratio: aspectRatio, quality: 'medium' } }
      if (refs.length) payload.input[refsField] = refs
      break
    }
    default: { // 'jobs' — standard endpoint (Nano Banana, Seedream, etc.)
      const inputParams = modelConfig.input_params || {}
      payload = { model: activeModel, input: { ...inputParams, prompt, [aspectField]: aspectRatio } }
      if (refs.length) payload.input[refsField] = refs
      break
    }
  }

  const resp = await fetch(`${KIE_BASE_URL}${modelConfig.endpoint}`, {
    method: 'POST', headers, body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000),
  })

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`API request failed (${resp.status}): ${redactSecrets(text, apiKey)}`)
  }

  const data = await resp.json() as any
  const taskId = data?.data?.taskId || data?.taskId || data?.data?.task_id || data?.task_id
  if (!taskId) throw new Error(`No task ID in response: ${redactSecrets(JSON.stringify(data), apiKey)}`)
  return String(taskId)
}

/**
 * Single-shot lookup of image URLs for a previously-submitted task.
 *
 * Unlike `pollForImageUrls`, this DOES NOT loop or wait. It hits
 * `/jobs/recordInfo?taskId=X` once and returns:
 *   - `{ urls }` if the task has finished and produced URLs
 *   - `{ urls: [], status: 'pending' }` if still in progress
 *   - `{ urls: [], status: 'failed' }` if the provider failed it
 *   - `{ urls: [], status: 'expired' }` if the task record is gone (404)
 *
 * Used by the image-reconciler to recover already-paid-for results
 * without re-submitting the prompt. Caller decides whether to retry,
 * skip, or fall back to regeneration based on `status`.
 */
export interface FetchByTaskIdResult {
  urls: string[]
  status: 'success' | 'pending' | 'failed' | 'expired' | 'unknown'
  message?: string
}
export async function fetchImageUrlsByTaskId(
  taskId: string, apiKey: string, modelConfig: ImageModelConfig,
): Promise<FetchByTaskIdResult> {
  const headers = { Authorization: `Bearer ${apiKey}` }
  const pollEndpoint = modelConfig.poll || '/jobs/recordInfo'
  const resp = await fetch(
    `${KIE_BASE_URL}${pollEndpoint}?taskId=${encodeURIComponent(taskId)}`,
    { headers, signal: AbortSignal.timeout(30000) },
  )

  if (resp.status === 404) {
    return { urls: [], status: 'expired', message: 'Task record not found (likely purged by provider)' }
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    return { urls: [], status: 'unknown', message: `HTTP ${resp.status}: ${text.slice(0, 200)}` }
  }

  const data = await resp.json() as any
  const taskData = data.data || data

  // Reuse the same status detection as pollForImageUrls — successFlag (kie's
  // newer numeric flag) takes priority, fall back to string state/status.
  let status: string
  const successFlag = taskData.successFlag
  if (successFlag !== undefined && successFlag !== null) {
    status = successFlag === 1 ? 'success' : successFlag >= 2 ? 'failed' : 'pending'
  } else {
    status = String(taskData.state || taskData.status || '').toLowerCase()
  }

  if (['success', 'completed', 'finished', 'succeed'].includes(status)) {
    let urls: string[] = []
    const responseObj = taskData.response
    if (typeof responseObj === 'object' && responseObj) {
      const rUrls = responseObj.resultUrls || responseObj.imageUrls || []
      if (rUrls.length) urls = rUrls.filter((u: any) => typeof u === 'string' && u)
      if (!urls.length) {
        const single = responseObj.resultImageUrl || responseObj.imageUrl
        if (single) urls = [single]
      }
    }
    if (!urls.length && taskData.resultJson) {
      try {
        const rj = typeof taskData.resultJson === 'string' ? JSON.parse(taskData.resultJson) : taskData.resultJson
        const rUrls = rj.resultUrls || rj.imageUrls || []
        urls = rUrls.filter((u: any) => typeof u === 'string' && u)
      } catch { /* ignore */ }
    }
    if (!urls.length) {
      for (const key of ['imageUrls', 'images', 'resultUrls', 'outputUrls']) {
        const val = taskData[key]
        if (Array.isArray(val) && val.length) {
          urls = val.map((u: any) => typeof u === 'string' ? u : u?.url || '').filter(Boolean)
          break
        }
      }
    }
    if (!urls.length) {
      const single = taskData.imageUrl || taskData.resultUrl || taskData.outputUrl
      if (single) urls = [single]
    }
    return urls.length
      ? { urls, status: 'success' }
      : { urls: [], status: 'unknown', message: 'Task succeeded but no URLs in response' }
  }
  if (['failed', 'error', 'fail'].includes(status)) {
    return { urls: [], status: 'failed', message: taskData.failReason || taskData.errorMessage || taskData.error || taskData.failMsg || taskData.msg || 'Provider reported failure (often an OpenAI content-policy block on gpt-image models — no reason returned)' }
  }
  return { urls: [], status: 'pending', message: `Task status: ${status || 'unknown'}` }
}

export async function pollForImageUrls(
  taskId: string, apiKey: string, modelConfig: ImageModelConfig,
  opts: { isCancelled?: () => boolean } = {},
): Promise<string[]> {
  const headers = { Authorization: `Bearer ${apiKey}` }
  const pollEndpoint = modelConfig.poll || '/jobs/recordInfo'
  const deadline = Date.now() + MAX_WAIT
  let consecutiveFailures = 0
  const isCancelled = opts.isCancelled

  while (Date.now() < deadline) {
    // Probe before each iteration so a user-cancelled batch stops burning
    // 6-minute poll loops per in-flight image instead of running to MAX_WAIT.
    if (isCancelled?.()) throw new Error('Cancelled by user')
    try {
      const resp = await fetch(
        `${KIE_BASE_URL}${pollEndpoint}?taskId=${taskId}`,
        { headers, signal: AbortSignal.timeout(30000) },
      )
      if (!resp.ok) {
        // Escalate after a run of non-2xx so a sustained 429 / 502 surfaces
        // as "rate-limited" / "upstream failing" instead of the old silent
        // "timed out after 6 minutes". Retry-After is respected when sent.
        consecutiveFailures++
        if (consecutiveFailures > MAX_CONSECUTIVE_FAILURES) {
          const text = await resp.text().catch(() => '')
          throw new Error(`kie.ai poll: ${resp.status} ${resp.statusText} — ${redactSecrets(text, apiKey).slice(0, 200)}`)
        }
        const retryAfter = Number(resp.headers.get('Retry-After'))
        const wait = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 60_000)
          : Math.min(POLL_INTERVAL * Math.pow(2, Math.min(consecutiveFailures, 4)), 60_000)
        await sleepCancellable(wait, isCancelled)
        continue
      }
      consecutiveFailures = 0
      const data = await resp.json() as any
      const taskData = data.data || data

      // Determine status
      let status: string
      const successFlag = taskData.successFlag
      if (successFlag !== undefined && successFlag !== null) {
        status = successFlag === 1 ? 'success' : successFlag >= 2 ? 'failed' : 'pending'
      } else {
        status = String(taskData.state || taskData.status || '').toLowerCase()
      }

      if (['success', 'completed', 'finished', 'succeed'].includes(status)) {
        let urls: string[] = []

        // Check "response" object (Flux, 4o, newer models)
        const responseObj = taskData.response
        if (typeof responseObj === 'object' && responseObj) {
          const rUrls = responseObj.resultUrls || responseObj.imageUrls || []
          if (rUrls.length) urls = rUrls.filter((u: any) => typeof u === 'string' && u)
          if (!urls.length) {
            const single = responseObj.resultImageUrl || responseObj.imageUrl
            if (single) urls = [single]
          }
        }

        // Grok returns resultJson as JSON string
        if (!urls.length && taskData.resultJson) {
          try {
            const rj = typeof taskData.resultJson === 'string' ? JSON.parse(taskData.resultJson) : taskData.resultJson
            const rUrls = rj.resultUrls || rj.imageUrls || []
            urls = rUrls.filter((u: any) => typeof u === 'string' && u)
          } catch { /* ignore */ }
        }

        // Fallback fields
        if (!urls.length) {
          for (const key of ['imageUrls', 'images', 'resultUrls', 'outputUrls']) {
            const val = taskData[key]
            if (Array.isArray(val) && val.length) {
              urls = val.map((u: any) => typeof u === 'string' ? u : u?.url || '').filter(Boolean)
              break
            }
          }
        }

        if (!urls.length) {
          const single = taskData.imageUrl || taskData.resultUrl || taskData.outputUrl
          if (single) urls = [single]
        }

        if (urls.length) return urls
        throw new Error(`Task succeeded but no image URLs found: ${redactSecrets(JSON.stringify(taskData), apiKey).slice(0, 500)}`)
      }

      if (['failed', 'error', 'fail'].includes(status)) {
        // v1.0.88+: surface real diagnostic info instead of "Unknown".
        // kie.ai's task response uses different fields per model — Flux
        // uses `failReason`, GPT-Image uses `error`, Seedream often
        // returns `errorMessage` / `msg` / nested `response.error`. Walk
        // the common fields first; if all empty, dump a redacted JSON
        // snippet so the next "Unknown" failure still tells the user
        // what kie.ai actually returned (model not enabled, quota out,
        // safety filter, etc.).
        const candidates = [
          taskData.failReason,
          taskData.error,
          taskData.errorMessage,
          taskData.failMsg,
          taskData.msg,
          taskData.message,
          taskData.errMsg,
          taskData.response?.error,
          taskData.response?.failReason,
          taskData.response?.errorMessage,
          (typeof taskData.resultJson === 'string'
            ? (() => { try { return JSON.parse(taskData.resultJson)?.error } catch { return null } })()
            : null),
        ]
        const reason = candidates.find(v => typeof v === 'string' && v.trim())
        if (reason) {
          throw new Error(`Image generation failed: ${reason}`)
        }
        // No structured field carried a reason. OpenAI's GPT-Image / DALL·E
        // models (via kie) fail exactly this way on a content-policy block — kie
        // relays `state:fail` without the moderation reason. When the model is
        // one of those, give an actionable hint instead of a bare raw dump.
        const snippet = redactSecrets(JSON.stringify(taskData), apiKey).slice(0, 400)
        const modelStr = String(taskData.model || (modelConfig as any).api_model || modelConfig.label || '').toLowerCase()
        if (/gpt-?image|gpt-?4o|dall/.test(modelStr)) {
          throw new Error(
            `Image generation blocked — ${taskData.model || 'the OpenAI image model'} returned no reason, which almost always means OpenAI's content policy rejected the prompt (graphic violence, gore, open wounds, injury, etc.). ` +
            `Soften the prompt, or switch this step to a less-restrictive image model (e.g. Flux, Seedream, or nano-banana). Raw: ${snippet}`,
          )
        }
        throw new Error(`Image generation failed (kie.ai reported a failed task with no error message). Raw response: ${snippet}`)
      }

      await sleepCancellable(POLL_INTERVAL, isCancelled)
    } catch (e: any) {
      // Terminal conditions must propagate; the outer catch-then-retry loop
      // is for transient network errors only. Message-based sniffing is
      // fragile but preserves the existing contract. A user-cancel error
      // raised inside sleepCancellable is also terminal — don't retry.
      const msg = String(e?.message || '')
      if (msg === 'Cancelled by user'
          || msg.includes('generation failed')
          || msg.includes('no image URLs')
          || msg.startsWith('kie.ai poll:')) throw e
      // Network-level failure: count against the consecutive-failure budget.
      if (++consecutiveFailures > MAX_CONSECUTIVE_FAILURES) {
        throw new Error(`kie.ai poll: ${consecutiveFailures} consecutive fetch errors (${msg})`)
      }
      await sleepCancellable(POLL_INTERVAL, isCancelled)
    }
  }

  throw new Error(`Task ${taskId} did not complete within ${MAX_WAIT / 1000} seconds`)
}

export async function downloadImage(
  url: string,
  savePath: string,
  onProgress?: (bytesReceived: number, totalBytes?: number) => void,
): Promise<void> {
  await fs.mkdir(path.dirname(savePath), { recursive: true })
  const tempPath = `${savePath}.partial-${process.pid}-${Date.now()}`

  // v1.0.234 — some providers (OpenAI's Images API) return the bytes inline as
  // base64 rather than a fetchable URL. Node's fetch can't open `data:` URLs,
  // so decode + write them directly here. Lets any provider hand back a
  // `data:image/...;base64,...` "url" and have the normal pipeline persist it.
  if (url.startsWith('data:')) {
    const comma = url.indexOf(',')
    const b64 = comma >= 0 ? url.slice(comma + 1) : ''
    const buf = Buffer.from(b64, 'base64')
    if (!buf.length) throw new Error('Download failed: empty data: URL')
    await fs.writeFile(tempPath, buf, { flag: 'wx' })
    await fs.rename(tempPath, savePath)
    try { onProgress?.(buf.length, buf.length) } catch { /* ignore UI plumbing */ }
    return
  }

  const isStudioArtifact = /\/api\/generate\/jobs\/[^/]+\/image(?:\?|$)/.test(url)
  const isHubArtifact = /\/api\/hub\/jobs\/[^/]+\/items\/\d+\/artifact(?:\?|$)/.test(url)
  let resp: Response
  if (isHubArtifact) {
    const hub = await getHubBackend()
    resp = await fetch(url, {
      headers: hubHeaders(hub.hubToken),
      signal: AbortSignal.timeout(120000),
    })
  } else {
    resp = await (isStudioArtifact ? studioFetch : fetch)(url, { signal: AbortSignal.timeout(120000) })
  }
  if (!resp.ok || !resp.body) throw new Error(`Download failed: ${resp.status}`)
  const cl = resp.headers.get('content-length')
  const total = cl ? Number(cl) || undefined : undefined
  let received = 0
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length
      try { onProgress?.(received, total) } catch { /* never let UI plumbing kill a download */ }
      cb(null, chunk)
    },
  })
  const writeStream = createWriteStream(tempPath, { flags: 'wx' })
  // Clean up a partial/truncated file on stream error so the generator's
  // `existsSync` skip guard doesn't mistake it for a valid cache hit next run.
  try {
    await pipeline(Readable.fromWeb(resp.body as any), counter, writeStream)
  } catch (e) {
    await fs.rm(tempPath, { force: true }).catch(() => {})
    throw e
  }
  // Providers occasionally return 200 with a 0-byte body; treat that as a
  // failure here rather than letting the half-file propagate downstream.
  const stat = await fs.stat(tempPath)
  if (stat.size === 0) {
    await fs.rm(tempPath, { force: true }).catch(() => {})
    throw new Error('Image download wrote 0 bytes')
  }
  await fs.rename(tempPath, savePath)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
