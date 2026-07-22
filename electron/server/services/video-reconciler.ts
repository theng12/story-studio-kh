/**
 * Video repair evidence reconciler.
 *
 * Historical manifests may reference Kie or fal.ai task identifiers. Story
 * Studio preserves those identifiers for audit purposes but never contacts the
 * old providers directly. GenStudio-owned work must be resumed through the
 * original GenStudio job; unsupported legacy tasks fail clearly and are never
 * re-submitted.
 */

import { stat } from 'fs/promises'
import path from 'path'
import { readManifest, type TaskManifestEntry } from './task-manifest.js'
import { findFileCaseInsensitive } from './fs-case-insensitive.js'
import * as pm from '../services/project-manager.js'
import { resolveSubfolderNames } from '../services/utils.js'
import { resolveEpisodeSubfolderDir } from '../services/media-root.js'
import type { Job } from '../models/types.js'

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
}

export interface FetchResult {
  urls: string[]
  status: 'success' | 'pending' | 'failed' | 'expired' | 'unknown'
  message?: string
}

const LEGACY_RECOVERY_DISABLED =
  'Direct legacy provider recovery is retired. Story Studio did not contact the provider; the saved task identity remains as audit evidence.'

/**
 * Compatibility export for older recovery helpers. It is deliberately inert:
 * callers receive a terminal explanation without any Kie network request.
 */
export async function fetchKieVideo(
  _taskId: string,
  _pollPath: string,
  _apiKey: string,
): Promise<FetchResult> {
  void _taskId
  void _pollPath
  void _apiKey
  return { urls: [], status: 'unknown', message: LEGACY_RECOVERY_DISABLED }
}

/**
 * Compatibility export for older recovery helpers. It never follows a fal.ai
 * result URL, preventing restart/retry code from bypassing GenStudio.
 */
export async function fetchFalVideo(_resultUrl: string): Promise<FetchResult> {
  void _resultUrl
  return { urls: [], status: 'unknown', message: LEGACY_RECOVERY_DISABLED }
}

async function fileNonEmpty(filePath: string): Promise<boolean> {
  const actual = await findFileCaseInsensitive(path.dirname(filePath), path.basename(filePath))
  if (!actual) return false
  try {
    return (await stat(actual)).size > 0
  } catch {
    return false
  }
}

function inspectMissingClip(
  expected: ExpectedClip,
  entry: TaskManifestEntry | null,
): VideoReconcileOutcome {
  if (!entry) {
    return {
      filename: expected.filename,
      status: 'no_manifest',
      reason: 'No accepted task identity is recorded. Start a new generation through GenStudio.',
    }
  }

  const evidence = {
    filename: expected.filename,
    task_id: entry.task_id,
    provider: entry.provider,
  }
  if (entry.provider === 'genstudio' || entry.provider === 'genstudio-video') {
    return {
      ...evidence,
      status: 'error',
      reason: 'This GenStudio job is incomplete. Retry the original Story Studio job so it resumes through GenStudio; no provider fallback was attempted.',
    }
  }

  return {
    ...evidence,
    status: 'error',
    reason: `${LEGACY_RECOVERY_DISABLED} Start a new generation through GenStudio if the output is still required.`,
  }
}

async function findVideoDir(slug: string, episodeId: string): Promise<string> {
  const code = episodeId.toUpperCase()
  const outputRoot = await pm.getProjectOutputRoot(slug)
  if (!outputRoot) throw new Error('Project directory not found')
  const names = await resolveSubfolderNames(slug, code)
  const fs = await import('fs/promises')

  async function walk(directory: string, depth = 0): Promise<string | null> {
    if (depth > 4) return null
    try {
      const entries = await fs.readdir(directory, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.toUpperCase().startsWith(code)) {
          return path.join(directory, entry.name)
        }
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const found = await walk(path.join(directory, entry.name), depth + 1)
        if (found) return found
      }
    } catch {
      // Missing/inaccessible branches are not episode matches.
    }
    return null
  }

  const episodeDir = await walk(outputRoot)
  if (!episodeDir) throw new Error(`Episode directory not found for ${code}`)
  return resolveEpisodeSubfolderDir(slug, code, 'video', episodeDir, names.video, false)
}

export async function reconcileVideos(
  slug: string,
  episodeId: string,
  job: Job,
): Promise<VideoReconcileResult> {
  const result: VideoReconcileResult = {
    outcomes: [],
    recovered: 0,
    skipped_ok: 0,
    needs_fresh_generation: 0,
    unrecoverable: 0,
    total_expected: 0,
  }

  const videoDir = await findVideoDir(slug, episodeId)
  job.output_dir = videoDir
  const manifest = await readManifest(videoDir)
  const expectedFilenames = Object.keys(manifest.tasks)

  if (!expectedFilenames.length) {
    job.output_lines.push(`No task manifest at ${videoDir}. Start a new generation through GenStudio.`)
    return result
  }

  result.total_expected = expectedFilenames.length
  job.output_lines.push(
    `Inspecting ${expectedFilenames.length} saved video task(s) for ${episodeId}. `
    + 'Story Studio will not contact legacy providers directly.',
  )

  for (const filename of expectedFilenames) {
    const expected: ExpectedClip = { filename, fullPath: path.join(videoDir, filename) }
    if (await fileNonEmpty(expected.fullPath)) {
      result.outcomes.push({ filename, status: 'skipped_ok' })
      result.skipped_ok++
      continue
    }

    const outcome = inspectMissingClip(expected, manifest.tasks[filename] || null)
    result.outcomes.push(outcome)
    if (outcome.status === 'no_manifest') {
      result.needs_fresh_generation++
    } else {
      result.unrecoverable++
    }
    job.output_lines.push(`✗ ${filename} — ${outcome.reason}`)
  }

  job.output_lines.push(
    `Evidence inspection finished. ${result.skipped_ok} clip(s) already exist; `
    + `${result.needs_fresh_generation} require a new GenStudio generation; `
    + `${result.unrecoverable} retained task(s) require an explicit GenStudio retry.`,
  )
  return result
}
