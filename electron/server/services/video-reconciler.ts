/**
 * Video reconciler — recover missing AI-generated video clips from the
 * provider's stored task results, WITHOUT re-submitting (= zero credit cost).
 *
 * Mirrors `image-reconciler.ts`. Differs in that it dispatches per
 * provider because the two video backends use different recovery endpoints:
 *
 *   - kie-video     → GET /api/v1/{pollPath}?taskId={id}  where pollPath
 *                     varies per model family (`/veo/record-info`,
 *                     `/runway/record-info`, `/jobs/recordInfo`). The
 *                     manifest entry stores `poll_path` so the reconciler
 *                     doesn't have to re-derive it from the model id.
 *   - fal-video     → GET {response_url}  — fal hands back a direct
 *                     response URL at submit time and we cached it in
 *                     the manifest as `result_url`. Persists for the
 *                     queue's retention window.
 *
 * Per the user's preference: no silent regeneration. Files without a
 * stored task id come back as `no_manifest`; the user gets a clear note
 * and can click Generate for those specific items.
 */

import { stat } from 'fs/promises'
import path from 'path'
import { parseImagePromptsDocx } from '../lib/docx-parser.js'
import { downloadVideo } from '../lib/download-video.js'
import { readManifest, type TaskManifestEntry } from './task-manifest.js'
import { findFileCaseInsensitive } from './fs-case-insensitive.js'
import * as pm from '../services/project-manager.js'
import { resolveSubfolderNames } from '../services/utils.js'
import { resolveEpisodeSubfolderDir } from '../services/media-root.js'
import type { Job } from '../models/types.js'

const KIE_BASE_URL = 'https://api.kie.ai/api/v1'

export interface VideoReconcileOutcome {
  filename: string
  status: 'recovered' | 'skipped_ok' | 'no_manifest' | 'expired' | 'failed' | 'pending' | 'error'
  reason?: string
  task_id?: string
  provider?: string
}

export interface VideoReconcileResult {
  outcomes: VideoReconcileOutcome[]
  recovered: number
  skipped_ok: number
  needs_fresh_generation: number
  unrecoverable: number
  total_expected: number
}

interface ExpectedClip {
  filename: string
  fullPath: string
  stem: string
  variantIndex: number
}

async function fileNonEmpty(p: string): Promise<boolean> {
  // Case-insensitive to tolerate legacy or foreign-cased clip filenames
  // on case-sensitive filesystems (Linux, case-sensitive APFS).
  const actual = await findFileCaseInsensitive(path.dirname(p), path.basename(p))
  if (!actual) return false
  try {
    const s = await stat(actual)
    return s.size > 0
  } catch { return false }
}

// ── Per-provider single-shot fetchers ───────────────────────────────────

export interface FetchResult {
  urls: string[]
  status: 'success' | 'pending' | 'failed' | 'expired' | 'unknown'
  message?: string
}

export async function fetchKieVideo(taskId: string, pollPath: string, apiKey: string): Promise<FetchResult> {
  const path = pollPath || '/jobs/recordInfo'
  const resp = await fetch(`${KIE_BASE_URL}${path}?taskId=${encodeURIComponent(taskId)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(30000),
  })
  if (resp.status === 404) return { urls: [], status: 'expired', message: 'Task record not found' }
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    return { urls: [], status: 'unknown', message: `HTTP ${resp.status}: ${text.slice(0, 200)}` }
  }
  const data = await resp.json() as any
  const taskData = data.data || data
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
      const rUrls = responseObj.resultUrls || responseObj.videoUrls || []
      if (rUrls.length) urls = rUrls.filter((u: any) => typeof u === 'string' && u)
      if (!urls.length) {
        const single = responseObj.resultVideoUrl || responseObj.videoUrl
        if (single) urls = [single]
      }
    }
    if (!urls.length && taskData.resultJson) {
      try {
        const rj = typeof taskData.resultJson === 'string' ? JSON.parse(taskData.resultJson) : taskData.resultJson
        const rUrls = rj.resultUrls || rj.videoUrls || []
        urls = rUrls.filter((u: any) => typeof u === 'string' && u)
      } catch { /* ignore */ }
    }
    return urls.length
      ? { urls, status: 'success' }
      : { urls: [], status: 'unknown', message: 'Task succeeded but no URLs in response' }
  }
  if (['failed', 'error', 'fail'].includes(status)) {
    return { urls: [], status: 'failed', message: taskData.errorMessage || taskData.error || 'Provider reported failure' }
  }
  return { urls: [], status: 'pending', message: `Status: ${status || 'unknown'}` }
}

export async function fetchFalVideo(resultUrl: string): Promise<FetchResult> {
  if (!resultUrl) return { urls: [], status: 'unknown', message: 'No result_url stored' }
  const resp = await fetch(resultUrl, { signal: AbortSignal.timeout(30000) })
  if (resp.status === 404 || resp.status === 410) return { urls: [], status: 'expired', message: 'fal queue result expired' }
  if (!resp.ok) return { urls: [], status: 'unknown', message: `HTTP ${resp.status}` }
  const data = await resp.json() as any
  // fal video models return { video: { url } } or { videos: [{ url }] }
  if (data?.video?.url) return { urls: [data.video.url], status: 'success' }
  if (Array.isArray(data?.videos) && data.videos.length) {
    return { urls: data.videos.map((v: any) => v?.url).filter(Boolean), status: 'success' }
  }
  return { urls: [], status: 'unknown', message: 'fal response shape not recognised' }
}

async function recoverOne(
  expected: ExpectedClip,
  entry: TaskManifestEntry | null,
  config: any,
): Promise<VideoReconcileOutcome> {
  if (!entry) {
    return {
      filename: expected.filename,
      status: 'no_manifest',
      reason: 'No task id recorded for this clip. Run a fresh generation to enable recovery next time.',
    }
  }

  let lookup: FetchResult
  switch (entry.provider) {
    case 'kie-video':
    case 'kie': {
      const apiKey = config.kie_api_key || ''
      if (!apiKey) return { filename: expected.filename, status: 'error', reason: 'No kie.ai API key configured', task_id: entry.task_id, provider: entry.provider }
      lookup = await fetchKieVideo(entry.task_id, entry.poll_path || '', apiKey)
      break
    }
    case 'fal-video':
    case 'fal': {
      lookup = await fetchFalVideo(entry.result_url || '')
      break
    }
    default:
      return {
        filename: expected.filename,
        status: 'error',
        reason: `Recovery for provider "${entry.provider}" is not implemented yet.`,
        task_id: entry.task_id,
        provider: entry.provider,
      }
  }

  switch (lookup.status) {
    case 'success': {
      const idx = Math.max(0, expected.variantIndex - 1)
      const url = lookup.urls[idx] || lookup.urls[0]
      if (!url) {
        return { filename: expected.filename, status: 'error', reason: `Provider returned ${lookup.urls.length} URL(s) but none matched variant ${expected.variantIndex}`, task_id: entry.task_id, provider: entry.provider }
      }
      try {
        await downloadVideo(url, expected.fullPath)
        return { filename: expected.filename, status: 'recovered', task_id: entry.task_id, provider: entry.provider }
      } catch (e: any) {
        return { filename: expected.filename, status: 'error', reason: `Download failed: ${e.message}`, task_id: entry.task_id, provider: entry.provider }
      }
    }
    case 'expired':
      return { filename: expected.filename, status: 'expired', reason: lookup.message, task_id: entry.task_id, provider: entry.provider }
    case 'failed':
      return { filename: expected.filename, status: 'failed', reason: lookup.message, task_id: entry.task_id, provider: entry.provider }
    case 'pending':
      return { filename: expected.filename, status: 'pending', reason: lookup.message, task_id: entry.task_id, provider: entry.provider }
    default:
      return { filename: expected.filename, status: 'error', reason: lookup.message, task_id: entry.task_id, provider: entry.provider }
  }
}

async function findVideoDir(slug: string, episodeId: string): Promise<string> {
  const code = episodeId.toUpperCase()
  const outputRoot = await pm.getProjectOutputRoot(slug)
  if (!outputRoot) throw new Error('Project directory not found')
  const names = await resolveSubfolderNames(slug, code)
  // Find the episode dir by code prefix (mirrors ai-video.ts's findEpisodeDir).
  const fs = await import('fs/promises')
  async function walk(dir: string, depth = 0): Promise<string | null> {
    if (depth > 4) return null
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      for (const e of entries) {
        if (!e.isDirectory()) continue
        if (e.name.toUpperCase().startsWith(code)) return path.join(dir, e.name)
      }
      for (const e of entries) {
        if (!e.isDirectory()) continue
        const found = await walk(path.join(dir, e.name), depth + 1)
        if (found) return found
      }
    } catch { /* ignore */ }
    return null
  }
  const epDir = await walk(outputRoot)
  if (!epDir) throw new Error(`Episode directory not found for ${code}`)
  return await resolveEpisodeSubfolderDir(slug, code, 'video', epDir, names.video, false)
}

export async function reconcileVideos(
  slug: string, episodeId: string, job: Job,
): Promise<VideoReconcileResult> {
  const result: VideoReconcileResult = {
    outcomes: [], recovered: 0, skipped_ok: 0,
    needs_fresh_generation: 0, unrecoverable: 0, total_expected: 0,
  }

  const config = await pm.getConfig(slug)
  if (!config) throw new Error('Project config missing')

  const videoDir = await findVideoDir(slug, episodeId)
  // Stamp output_dir up-front so even the "no manifest" early-return
  // case still gets the Open in Finder button pointing at the right
  // folder — the user can drop fresh clips there manually.
  job.output_dir = videoDir

  // Build the expected set from the manifest entries themselves: we're
  // recovering files we previously submitted, not re-deriving from a
  // prompts docx. (For fresh generation we do parse the docx; for
  // recovery the manifest IS the source of truth.) This also avoids the
  // issue where the prompts docx may have been updated after generation.
  const manifest = await readManifest(videoDir)
  const expectedFilenames = Object.keys(manifest.tasks)

  if (expectedFilenames.length === 0) {
    job.output_lines.push(`No task manifest at ${videoDir}. Run a fresh generation first to enable repair.`)
    return result
  }

  result.total_expected = expectedFilenames.length
  job.output_lines.push(`Repairing videos for ${episodeId} — ${expectedFilenames.length} clip(s) tracked in manifest...`)

  for (const filename of expectedFilenames) {
    const fullPath = path.join(videoDir, filename)
    // Variant index from the _vN suffix.
    const variantMatch = filename.match(/_v(\d+)\.mp4$/i)
    const variantIndex = variantMatch ? parseInt(variantMatch[1]!, 10) : 1
    const stem = filename.replace(/_v\d+\.mp4$/i, '')
    const expected: ExpectedClip = { filename, fullPath, stem, variantIndex }

    if (await fileNonEmpty(fullPath)) {
      result.outcomes.push({ filename, status: 'skipped_ok' })
      result.skipped_ok++
      continue
    }

    const entry = manifest.tasks[filename] || null
    const outcome = await recoverOne(expected, entry, config)
    result.outcomes.push(outcome)
    if (outcome.status === 'recovered') {
      result.recovered++
      job.output_lines.push(`✓ Recovered ${filename}`)
    } else if (outcome.status === 'no_manifest') {
      result.needs_fresh_generation++
      job.output_lines.push(`! ${filename} — no task id; needs fresh generation`)
    } else {
      result.unrecoverable++
      job.output_lines.push(`✗ ${filename} — ${outcome.status}: ${outcome.reason || ''}`)
    }
  }

  job.output_lines.push(
    `Done. Recovered ${result.recovered}; ` +
    `${result.needs_fresh_generation} need fresh generation; ` +
    `${result.unrecoverable} unrecoverable; ` +
    `${result.skipped_ok} already on disk.`,
  )
  return result
}
