/**
 * Image reconciler — recover missing scene/thumbnail images from the
 * provider's stored task results, WITHOUT re-submitting (= zero credit cost).
 *
 * Why this exists: the user's complaint that the Repair button burned
 * credits even when the images had already been generated once. Until
 * this service shipped, repair re-ran the full generation; now repair
 * looks up each missing file's stored task_id in the sidecar manifest
 * and downloads from the provider's existing result URL.
 *
 * Recovery strategy (one file at a time):
 *   1. Scan the prompts docx → list every {stem}_v1.png that SHOULD exist.
 *   2. Scan disk → which expected files are absent or zero-byte?
 *   3. For each missing file, look up `.task-manifest.json` for a
 *      previously-recorded provider task_id.
 *   4. If found, call the provider's "fetch by task id" endpoint to get
 *      the result URLs (no re-submit). Download to the expected path.
 *   5. Files with no manifest entry are reported as "needs fresh
 *      generation" — repair never silently regenerates anything.
 *
 * Per the user's preference: zero credit re-spend. Files that can't be
 * recovered (no manifest, expired task record, provider failure) are
 * reported back so the user can decide whether to regenerate them.
 *
 * Recovery boundary:
 *   - GenStudio image jobs reconnect through their durable GenStudio job id.
 *   - Legacy provider task ids remain audit evidence only and are never polled.
 */

import { stat } from 'fs/promises'
import path from 'path'
import { parseImagePromptsDocx } from '../lib/docx-parser.js'
import { downloadImage } from '../lib/kie-client.js'
import {
  findScenePromptsFile, findThumbPromptsFile, resolveImageDirs,
} from '../generators/images.js'
import { readManifest, type TaskManifestEntry } from './task-manifest.js'
import { findFileCaseInsensitive } from './fs-case-insensitive.js'
import type { Job } from '../models/types.js'
import { recoverImageWithGenStudio } from '../lib/genstudio-client.js'
import { getApiKey } from './app-secrets-store.js'

export interface ImageReconcileOutcome {
  filename: string
  /**
   *   recovered    → downloaded from a stored provider result. No credits charged.
   *   skipped_ok   → file already on disk, nothing to do.
   *   no_manifest  → file is missing AND no task id was ever recorded; user
   *                  must run a fresh generation for this item.
   *   expired      → manifest had a task id but the provider's record is gone.
   *   failed       → provider stored the task as failed. User must regenerate.
   *   pending      → task is still in flight upstream. Re-run repair shortly.
   *   error        → unexpected (network, parse, write); see `reason`.
   */
  status: 'recovered' | 'skipped_ok' | 'no_manifest' | 'expired' | 'failed' | 'pending' | 'error'
  reason?: string
  task_id?: string
  provider?: string
}

export interface ImageReconcileResult {
  scene_results: ImageReconcileOutcome[]
  thumb_results: ImageReconcileOutcome[]
  recovered: number
  skipped_ok: number
  needs_fresh_generation: number
  unrecoverable: number
  total_expected: number
}

interface ExpectedImage {
  filename: string                // e.g. TN0001_Scene01_v1.png
  fullPath: string
  stem: string                    // TN0001_Scene01
  variantIndex: number            // 1 for _v1 (we currently only generate _v1)
}

async function fileNonEmpty(p: string): Promise<boolean> {
  // Case-insensitive so a legacy `ep001_scene01_v1.png` still counts as
  // present when the reconciler expected `EP0001_Scene01_v1.png`.
  const actual = await findFileCaseInsensitive(path.dirname(p), path.basename(p))
  if (!actual) return false
  try {
    const s = await stat(actual)
    return s.size > 0
  } catch { return false }
}

function buildExpected(
  prompts: Array<{ number: number }>,
  dir: string,
  stemPrefix: string,
  episodeCode: string,
): ExpectedImage[] {
  // Generation always writes a _v1.png today; the manifest records the
  // same per-variant key, so the expected set IS one entry per prompt.
  // If the variant count grows (e.g. _v1, _v2 from a single submit),
  // extend this loop to enumerate by manifest entries too.
  return prompts.map(p => {
    const stem = `${episodeCode.toUpperCase()}_${stemPrefix}${p.number.toString().padStart(2, '0')}`
    const filename = `${stem}_v1.png`
    return { filename, fullPath: path.join(dir, filename), stem, variantIndex: 1 }
  })
}

/**
 * Recover one file given its manifest entry. Pure function (no side
 * effects beyond the actual download write). Returns the outcome for the
 * caller to log + aggregate.
 */
async function recoverOne(
  expected: ExpectedImage,
  entry: TaskManifestEntry | null,
  genstudioApiKey: string,
): Promise<ImageReconcileOutcome> {
  if (!entry) {
    return {
      filename: expected.filename,
      status: 'no_manifest',
      reason: 'No task id recorded for this file. Run a fresh generation to enable recovery next time.',
    }
  }

  if (entry.provider === 'genstudio-image' || entry.provider === 'genstudio') {
    if (!genstudioApiKey) {
      return {
        filename: expected.filename,
        status: 'error',
        reason: 'The saved GenStudio API key is unavailable.',
        task_id: entry.task_id,
        provider: entry.provider,
      }
    }
    try {
      const recovered = await recoverImageWithGenStudio(genstudioApiKey, entry.task_id)
      await downloadImage(recovered.url, expected.fullPath)
      return {
        filename: expected.filename,
        status: 'recovered',
        task_id: entry.task_id,
        provider: entry.provider,
      }
    } catch (error: any) {
      return {
        filename: expected.filename,
        status: 'error',
        reason: error?.message || 'GenStudio image recovery failed.',
        task_id: entry.task_id,
        provider: entry.provider,
      }
    }
  }

  return {
    filename: expected.filename,
    status: 'error',
    reason: `Legacy ${entry.provider} task evidence was preserved, but Story Studio no longer contacts that provider. ` +
      'Use a deliberate GenStudio Retry for a new image.',
    task_id: entry.task_id,
    provider: entry.provider,
  }
}

/**
 * Inspect status only — no recovery. Useful for the frontend to render
 * "X recoverable / Y need fresh generation" before the user clicks Repair.
 */
export async function getImagesReconcileStatus(
  slug: string, episodeId: string,
): Promise<{
  scene: ImageRepairPoolStatus
  thumb: ImageRepairPoolStatus
}> {
  const empty = (): ImageRepairPoolStatus => ({
    expected: 0, present: 0, missing: 0, with_manifest: 0, without_manifest: 0, missing_items: [],
  })
  const sceneFile = await findScenePromptsFile(slug, episodeId).catch(() => '')
  const thumbFile = await findThumbPromptsFile(slug, episodeId).catch(() => '')
  if (!sceneFile && !thumbFile) {
    return {
      scene: empty(),
      thumb: empty(),
    }
  }
  const promptsFile = sceneFile || thumbFile
  const { bgDir, thumbDir } = await resolveImageDirs(slug, promptsFile, episodeId)

  const summarize = async (
    promptsPath: string, dir: string, stemPrefix: string,
  ) => {
    if (!promptsPath) return empty()
    const parsed = await parseImagePromptsDocx(promptsPath)
    // parseImagePromptsDocx returns { scenes, thumbnails, ... }
    const list = stemPrefix === 'Scene' ? parsed.scenes : parsed.thumbnails
    const expected = buildExpected(list, dir, stemPrefix, episodeId)
    const manifest = await readManifest(dir)
    let present = 0, missing = 0, withManifest = 0, withoutManifest = 0
    const missingItems: ImageRepairMissingItem[] = []
    for (const e of expected) {
      if (await fileNonEmpty(e.fullPath)) { present++; continue }
      missing++
      const entry = manifest.tasks[e.filename]
      if (entry) withManifest++
      else withoutManifest++
      missingItems.push({
        filename: e.filename,
        recoverable: !!entry,
        ...(entry ? { task_id: entry.task_id, provider: entry.provider } : {}),
      })
    }
    return {
      expected: expected.length,
      present,
      missing,
      with_manifest: withManifest,
      without_manifest: withoutManifest,
      missing_items: missingItems,
    }
  }

  return {
    scene: await summarize(sceneFile, bgDir, 'Scene'),
    thumb: await summarize(thumbFile, thumbDir, 'Thumb'),
  }
}

export interface ImageRepairMissingItem {
  filename: string
  recoverable: boolean
  task_id?: string
  provider?: string
}

export interface ImageRepairPoolStatus {
  expected: number
  present: number
  missing: number
  with_manifest: number
  without_manifest: number
  missing_items: ImageRepairMissingItem[]
}

/**
 * Run the recovery pass and return per-file outcomes. The caller (job
 * executor) is responsible for emitting per-step log lines via
 * `job.output_lines.push(...)` and persisting the result.
 */
export async function reconcileImages(
  slug: string, episodeId: string, job: Job,
  // v1.0.306 — scope the repair to one pool. The Thumbnail Generator and Scene
  // Generator are separate pages; each should repair only its own pool, not
  // both. Default 'all' preserves the old behaviour for any caller that omits it.
  pool: 'scenes' | 'thumbnails' | 'all' = 'all',
): Promise<ImageReconcileResult> {
  const result: ImageReconcileResult = {
    scene_results: [], thumb_results: [],
    recovered: 0, skipped_ok: 0, needs_fresh_generation: 0, unrecoverable: 0,
    total_expected: 0,
  }

  const genstudioApiKey = await getApiKey('genstudio')

  const sceneFile = await findScenePromptsFile(slug, episodeId).catch(() => '')
  const thumbFile = await findThumbPromptsFile(slug, episodeId).catch(() => '')
  if (!sceneFile && !thumbFile) {
    job.output_lines.push('No scene or thumbnail prompts found for this episode — nothing to repair.')
    return result
  }
  const { bgDir, thumbDir } = await resolveImageDirs(slug, sceneFile || thumbFile, episodeId)

  async function processSet(
    promptsPath: string, dir: string, stemPrefix: 'Scene' | 'Thumb',
    out: ImageReconcileOutcome[],
  ) {
    if (!promptsPath) return
    const parsed = await parseImagePromptsDocx(promptsPath)
    const list = stemPrefix === 'Scene' ? parsed.scenes : parsed.thumbnails
    const expected = buildExpected(list, dir, stemPrefix, episodeId)
    result.total_expected += expected.length
    const manifest = await readManifest(dir)

    for (const e of expected) {
      if (await fileNonEmpty(e.fullPath)) {
        out.push({ filename: e.filename, status: 'skipped_ok' })
        result.skipped_ok++
        continue
      }
      const entry = manifest.tasks[e.filename] || null
      const outcome = await recoverOne(e, entry, genstudioApiKey)
      out.push(outcome)
      if (outcome.status === 'recovered') {
        result.recovered++
        job.output_lines.push(`✓ Recovered ${e.filename}`)
      } else if (outcome.status === 'no_manifest') {
        result.needs_fresh_generation++
        job.output_lines.push(`! ${e.filename} — no task id recorded; needs a fresh generation`)
      } else {
        result.unrecoverable++
        job.output_lines.push(`✗ ${e.filename} — ${outcome.status}: ${outcome.reason || ''}`)
      }
    }
  }

  const poolLabel = pool === 'scenes' ? 'scene images' : pool === 'thumbnails' ? 'thumbnails' : 'images'
  job.output_lines.push(`Repairing ${poolLabel} for ${episodeId}...`)
  if (pool === 'scenes' || pool === 'all') await processSet(sceneFile, bgDir, 'Scene', result.scene_results)
  if (pool === 'thumbnails' || pool === 'all') await processSet(thumbFile, thumbDir, 'Thumb', result.thumb_results)
  // Reveal the parent of bgDir/thumbDir (i.e. the episode dir) so the
  // user lands somewhere they can see both folders. Falls back to bgDir
  // if there's no thumb work.
  job.output_dir = path.dirname(bgDir)

  job.output_lines.push(
    `Repair pass finished. Recovered ${result.recovered}; ` +
    `${result.needs_fresh_generation} need fresh generation; ` +
    `${result.unrecoverable} unrecoverable; ` +
    `${result.skipped_ok} already on disk.`,
  )
  return result
}
