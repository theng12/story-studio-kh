import fs from 'fs/promises'
import path from 'path'
import { getHubBackend, getOrUploadHubAsset, hubCatalog, hubPollBatch, hubSubmitJob } from './studiohub-client.js'
import { studioFetch } from './studio-auth.js'
import type { VideoGenerationRequest, VideoGenerationResult } from '../providers/types.js'
import type { VideoModelConfig } from '../models/types.js'

export const DEFAULT_VIDEOSTUDIO_BASE_URL = 'http://127.0.0.1:47872'
const CATALOG_TTL_MS = 30_000

export interface VideoStudioCatalogResult {
  source: 'hub' | 'direct' | 'unavailable'
  models: Record<string, VideoModelConfig>
  error?: string
}

let catalogCache: { expiresAt: number; value: VideoStudioCatalogResult } | null = null

function baseUrl(): string {
  return (process.env.VIDEOSTUDIO_BASE_URL || DEFAULT_VIDEOSTUDIO_BASE_URL).replace(/\/+$/, '')
}

export function isUsableImageToVideoModel(row: any): boolean {
  if (!row || !Array.isArray(row.capabilities) || !row.capabilities.includes('img2video')) return false
  if (row.is_cloud) return row.key_set !== false && row.paid_on !== false && row.status !== 'deprecated'
  return row.hub_cached === true || row.cache?.state === 'complete' || row.cache?.state === 'cached'
}

export function normalizeVideoStudioCatalog(rows: any[]): Record<string, VideoModelConfig> {
  const models: Record<string, VideoModelConfig> = {}
  for (const row of rows || []) {
    if (!isUsableImageToVideoModel(row) || typeof row.repo !== 'string' || !row.repo.trim()) continue
    const id = `videostudio:${row.repo}`
    models[id] = {
      label: `${row.label || row.repo} [Video Studio · ${row.is_cloud ? 'Cloud' : 'Local'}]`,
      credits_per_video: 0,
      provider: 'videostudio',
      modes: ['frames'],
      max_duration: Number(row.max_duration_s) || undefined,
      ...({
        provider_params: {
          repo: row.repo,
          is_cloud: row.is_cloud === true,
          provider: row.provider || null,
          video_defaults: row.video_defaults || {},
          price: row.price || null,
        },
      } as any),
    }
  }
  return models
}

async function directCatalog(): Promise<any[]> {
  const response = await studioFetch(`${baseUrl()}/api/catalog`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(6_000),
  })
  if (!response.ok) throw new Error(`Video Studio catalog failed (${response.status})`)
  const value = await response.json() as { models?: any[] }
  return Array.isArray(value.models) ? value.models : []
}

export async function getVideoStudioCatalog(force = false): Promise<VideoStudioCatalogResult> {
  if (!force && catalogCache && catalogCache.expiresAt > Date.now()) return catalogCache.value
  const hub = await getHubBackend()
  if (hub.mode === 'hub') {
    if (!hub.hubUrl) {
      const value = { source: 'unavailable' as const, models: {}, error: 'Studio Hub routing is selected, but no Studio Hub URL is configured' }
      catalogCache = { expiresAt: Date.now() + 5_000, value }
      return value
    }
    try {
      const models = normalizeVideoStudioCatalog(await hubCatalog(hub.hubUrl, hub.hubToken, 'video', force))
      const value: VideoStudioCatalogResult = Object.keys(models).length
        ? { source: 'hub', models }
        : { source: 'unavailable', models: {}, error: 'Studio Hub reported no ready image-to-video models' }
      catalogCache = { expiresAt: Date.now() + CATALOG_TTL_MS, value }
      return value
    } catch (error: any) {
      const value = { source: 'unavailable' as const, models: {}, error: error?.message || String(error) }
      catalogCache = { expiresAt: Date.now() + 5_000, value }
      return value
    }
  }
  try {
    const models = normalizeVideoStudioCatalog(await directCatalog())
    const value: VideoStudioCatalogResult = Object.keys(models).length
      ? { source: 'direct', models }
      : { source: 'unavailable', models: {}, error: 'Video Studio has no ready image-to-video models' }
    catalogCache = { expiresAt: Date.now() + CATALOG_TTL_MS, value }
    return value
  } catch (error: any) {
    const detail = error?.message || String(error)
    const value = { source: 'unavailable' as const, models: {}, error: detail }
    catalogCache = { expiresAt: Date.now() + 5_000, value }
    return value
  }
}

export async function resolveVideoStudioModel(modelId: string): Promise<VideoModelConfig | undefined> {
  return (await getVideoStudioCatalog()).models[modelId]
}

async function submitDirect(request: VideoGenerationRequest, repo: string): Promise<VideoGenerationResult> {
  if (!request.startImagePath) throw new Error('Video Studio image-to-video requires the exact scene image.')
  const data = await fs.readFile(request.startImagePath)
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(data)]), path.basename(request.startImagePath))
  form.append('repo', repo)
  form.append('mode', 'img2video')
  form.append('prompt', request.prompt)
  form.append('aspect_ratio', request.aspectRatio === 'portrait' ? '9:16' : '16:9')
  const defaults = request.providerParams?.video_defaults || {}
  for (const key of ['duration', 'resolution', 'frames', 'fps', 'steps', 'guidance'] as const) {
    if (defaults[key] != null) form.append(key, String(defaults[key]))
  }
  const response = await studioFetch(`${baseUrl()}/api/generate/video2video`, {
    method: 'POST', body: form, signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok) throw new Error(`Video Studio submit failed (${response.status}): ${(await response.text()).slice(0, 400)}`)
  const submitted = await response.json() as { job?: { id?: string } }
  const jobId = submitted.job?.id
  if (!jobId) throw new Error('Video Studio submit returned no job id')
  for (;;) {
    if (request.isCancelled?.()) {
      await studioFetch(`${baseUrl()}/api/generate/jobs/${jobId}`, { method: 'DELETE' }).catch(() => {})
      throw new Error('Cancelled by user')
    }
    await new Promise(resolve => setTimeout(resolve, 2_000))
    const poll = await studioFetch(`${baseUrl()}/api/generate/jobs/${jobId}`, {
      signal: AbortSignal.timeout(15_000),
    })
    if (!poll.ok) throw new Error(`Video Studio poll failed (${poll.status})`)
    const value = await poll.json() as { job?: { state?: string; error?: string; output_url?: string } }
    const job = value.job || {}
    if (job.state === 'queued' || job.state === 'running') continue
    if (job.error || job.state === 'error' || job.state === 'cancelled') throw new Error(job.error || `Video Studio job ${job.state}`)
    const outputUrl = job.output_url || `/api/generate/jobs/${jobId}/video`
    return { videoUrls: [new URL(outputUrl, `${baseUrl()}/`).toString()], taskIds: [jobId] }
  }
}

export async function generateViaVideoStudio(request: VideoGenerationRequest): Promise<VideoGenerationResult> {
  if (request.mode !== 'frames' || !request.startImagePath) {
    throw new Error('Story Studio supports Video Studio image-to-video only; an exact scene image is required.')
  }
  const repo = request.providerParams?.repo
  if (!repo) throw new Error('Video Studio model is missing its live catalog repository id.')
  const hub = await getHubBackend()
  if (hub.mode === 'hub') {
    if (!hub.hubUrl) throw new Error('Studio Hub routing is selected, but no Hub URL is configured.')
    let submittedId = ''
    const assetId = await getOrUploadHubAsset(hub.hubUrl, hub.hubToken, request.startImagePath)
    const reference = assetId
      ? { asset_id: assetId }
      : { b64: (await fs.readFile(request.startImagePath)).toString('base64') }
    const defaults = request.providerParams?.video_defaults || {}
    const submitted = await hubSubmitJob(hub.hubUrl, hub.hubToken, {
      modality: 'video', model: repo, label: 'storystudio-motion', routing: 'pool',
      items: [{ prompt: request.prompt, params: {
        reference_images: [reference], ref_mode: 'img2video',
        aspect_ratio: request.aspectRatio === 'portrait' ? '9:16' : '16:9',
        ...defaults,
      } }],
    })
    submittedId = submitted.batch_id
    const status = await hubPollBatch(hub.hubUrl, hub.hubToken, submittedId, {
      isCancelled: request.isCancelled, timeoutMs: 60 * 60_000,
    })
    const item = status.items?.[0]
    if (!item || item.state !== 'done' || !item.artifact_url) {
      throw new Error(`Studio Hub video job ${submittedId} did not produce a clip: ${item?.error || item?.state || 'no result'}`)
    }
    return { videoUrls: [item.artifact_url], taskIds: [submittedId] }
  }
  return submitDirect(request, repo)
}
