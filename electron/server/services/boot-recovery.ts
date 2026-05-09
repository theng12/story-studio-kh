/**
 * Boot-time proactive recovery sweep.
 *
 * Why this exists
 * ---------------
 * After an unclean shutdown, jobs that were running get marked as `error`
 * with `"Interrupted by app restart"`. Their `.task-manifest.json`
 * sidecars still hold valid provider task_ids — those tasks may have
 * completed upstream by the time the user reopens the app. Without this
 * sweep, the user has to remember to click Repair & Retry on each
 * affected episode; if they don't get to it before the provider purges
 * the record (kie ~24h, fal/Veo varies), they pay to regenerate.
 *
 * What it does
 * ------------
 * Walks every project's accepted episodes, reads each asset subfolder's
 * `.task-manifest.json`, and for every entry whose local file is missing,
 * issues a SINGLE-SHOT provider fetch (no polling). If the upstream
 * status is `success`, downloads to disk for free. Otherwise (pending /
 * expired / failed) leaves it for Repair & Retry to handle on demand.
 *
 * Why single-shot instead of polling
 * ----------------------------------
 * Boot time is not the place to wait minutes per task. Pending tasks get
 * picked up naturally on the next user click via the longer-poll path
 * inside the generators (auto-recovery before fresh submit). The boot
 * sweep is opportunistic — recover what's already done, move on.
 *
 * Bounded by maxItems (default 50)
 * --------------------------------
 * One interrupted episode is roughly 30 scenes + 30 thumbs + 10 audio
 * chunks ≈ 70 entries. The cap prevents a 200-episode catalog with a
 * stale manifest from flooding the provider on first run after upgrade.
 *
 * Skip conditions (cost-safety)
 * -----------------------------
 *   - file already exists on disk
 *   - file is an iCloud-evicted placeholder (recoverable from iCloud)
 *   - manifest entry has no task_id
 *   - provider isn't recognised
 *   - api key missing for the entry's provider
 *   - budget exhausted
 *   - any per-entry failure → silent fall-through to next entry
 */

import path from 'path'
import { existsSync } from 'fs'
import fs from 'fs/promises'
import * as pm from './project-manager.js'
import * as im from './idea-manager.js'
import { resolveEpisodePaths } from './utils.js'
import {
  readManifest, type Manifest, type TaskManifestEntry,
} from './task-manifest.js'
import {
  fileExistsWithContent, isCloudEvictedPlaceholder,
} from '../lib/http-retry.js'
import {
  fetchImageUrlsByTaskId, downloadImage,
} from '../lib/kie-client.js'
import { getTaskById } from '../lib/genaipro-client.js'
import { downloadAudio } from '../lib/fal-client.js'
import {
  fetchKieVideo, fetchFalVideo,
} from './video-reconciler.js'
import { downloadVideo } from '../lib/download-video.js'
import type { ImageModelConfig } from '../models/types.js'

export interface RecoverySweepSummary {
  scannedManifests: number
  scannedEntries: number
  recovered: number
  pending: number      // upstream still working — will retry on user click
  expired: number      // provider record gone — must regenerate
  failed: number       // provider says failed — must regenerate
  bytesFreed: number
  budgetExhausted: boolean
}

export interface RecoverySweepOpts {
  /** Cap total entries the sweep will fetch (default 50). */
  maxItems?: number
  /** Logger — defaults to console.log. Pass a no-op for tests. */
  onLog?: (msg: string) => void
}

const ASSET_KIND = ['bg', 'thumb', 'audio', 'video'] as const
type AssetKind = typeof ASSET_KIND[number]

/**
 * Runs the proactive recovery sweep across all projects.
 * Returns a summary; errors are swallowed per-entry so a single bad
 * project / episode never blocks the rest.
 */
export async function proactiveRecoverySweep(
  opts: RecoverySweepOpts = {},
): Promise<RecoverySweepSummary> {
  const log = opts.onLog ?? ((msg: string) => console.log(msg))
  const maxItems = opts.maxItems ?? 50

  const summary: RecoverySweepSummary = {
    scannedManifests: 0,
    scannedEntries: 0,
    recovered: 0,
    pending: 0,
    expired: 0,
    failed: 0,
    bytesFreed: 0,
    budgetExhausted: false,
  }

  const projects = await pm.listProjects().catch(() => [])
  for (const project of projects) {
    if (summary.scannedEntries >= maxItems) {
      summary.budgetExhausted = true
      break
    }
    try {
      await sweepProject(project.slug, summary, maxItems, log)
    } catch (e: any) {
      log(`[boot-recovery] project '${project.slug}' sweep failed: ${e?.message || e}`)
    }
  }

  return summary
}

async function sweepProject(
  slug: string,
  summary: RecoverySweepSummary,
  maxItems: number,
  log: (msg: string) => void,
): Promise<void> {
  const config = await pm.getConfig(slug).catch(() => null) as any
  if (!config) return

  // Pull api keys + an arbitrary kie image-model config (the poll path
  // is the only model field we actually need at the fetcher level).
  const apiKeys = {
    kie: (config.kie_api_key as string) || '',
    genaipro: (config.genaipro_api_key as string) || '',
    fal: (config.fal_api_key as string) || '',
  }
  const imageModelConfig: ImageModelConfig = (() => {
    const m = config.image_models || {}
    const first = Object.values(m)[0] as ImageModelConfig | undefined
    return first || ({ poll: '/jobs/recordInfo' } as any)
  })()

  // Only accepted ideas have an episode_code → asset paths. Skip new /
  // dismissed ideas.
  const ideas = await im.getIdeas(slug).catch(() => [])
  const accepted = ideas.filter(i => !!i.episode_code)
  for (const idea of accepted) {
    if (summary.scannedEntries >= maxItems) {
      summary.budgetExhausted = true
      return
    }
    const code = idea.episode_code as string
    let paths
    try {
      paths = await resolveEpisodePaths(slug, code, idea.title || '')
    } catch {
      continue  // episode dir not yet scaffolded — nothing to recover
    }

    // Walk each asset subfolder. Each kind dispatches to its own
    // recovery function which handles the per-provider switch.
    for (const kind of ASSET_KIND) {
      const dir =
        kind === 'bg'    ? paths.bg_dir :
        kind === 'thumb' ? paths.thumb_dir :
        kind === 'audio' ? paths.audio_dir :
                           paths.video_dir
      if (!existsSync(dir)) continue

      let manifest: Manifest
      try {
        manifest = await readManifest(dir)
      } catch { continue }
      const entries = Object.entries(manifest.tasks)
      if (entries.length === 0) continue
      summary.scannedManifests++

      for (const [filename, entry] of entries) {
        if (summary.scannedEntries >= maxItems) {
          summary.budgetExhausted = true
          return
        }
        summary.scannedEntries++
        const filePath = path.join(dir, filename)
        // File already on disk → no work needed.
        if (await fileExistsWithContent(filePath)) continue
        // iCloud-evicted → recoverable for free from iCloud, not the
        // provider; skip silently so we don't waste an API call.
        if (await isCloudEvictedPlaceholder(filePath)) continue
        // No task_id → manifest entry has no anchor for recovery.
        if (!entry?.task_id) continue

        try {
          const result = await recoverOne(kind, entry, filePath, apiKeys, imageModelConfig)
          if (result.status === 'recovered') {
            summary.recovered++
            summary.bytesFreed += result.bytes ?? 0
            log(`[boot-recovery] recovered ${path.basename(filePath)} (${entry.provider}, task ${entry.task_id.slice(0, 12)}…)`)
          } else if (result.status === 'pending') summary.pending++
          else if (result.status === 'expired') summary.expired++
          else if (result.status === 'failed') summary.failed++
          // 'skipped' or unknown → no counter increment
        } catch (e: any) {
          // Per-entry failure → silent fall-through. Repair & Retry
          // remains available to the user on demand.
        }
      }
    }
  }
}

interface RecoverResult {
  status: 'recovered' | 'pending' | 'expired' | 'failed' | 'skipped'
  bytes?: number
}

/**
 * Single-shot recovery dispatch by asset kind + provider. Returns
 * 'skipped' for unsupported provider combinations (no api key, unknown
 * provider) so the sweep can move on without inflating any counter.
 */
async function recoverOne(
  kind: AssetKind,
  entry: TaskManifestEntry,
  destPath: string,
  apiKeys: { kie: string; genaipro: string; fal: string },
  imageModelConfig: ImageModelConfig,
): Promise<RecoverResult> {
  // ── Images (scene + thumbnail share the kie code path) ────────────────
  if (kind === 'bg' || kind === 'thumb') {
    if (entry.provider !== 'kie' && entry.provider !== 'kie-image') {
      return { status: 'skipped' }
    }
    if (!apiKeys.kie) return { status: 'skipped' }
    const r = await fetchImageUrlsByTaskId(entry.task_id, apiKeys.kie, imageModelConfig)
    if (r.status === 'success' && r.urls.length) {
      // Variant index from filename suffix (e.g. _v3 → urls[2]).
      const v = parseVariantIndex(destPath)
      const url = r.urls[v - 1] || r.urls[0]
      if (!url) return { status: 'failed' }
      await downloadImage(url, destPath)
      const stat = await fs.stat(destPath).catch(() => null)
      return { status: 'recovered', bytes: stat?.size ?? 0 }
    }
    return { status: r.status === 'success' ? 'failed' : (r.status as any) }
  }

  // ── Audio (genaipro only — direct ElevenLabs has no task_id) ──────────
  if (kind === 'audio') {
    if (entry.provider !== 'genaipro') return { status: 'skipped' }
    if (!apiKeys.genaipro) return { status: 'skipped' }
    const t = await getTaskById(apiKeys.genaipro, entry.task_id)
    if (!t) return { status: 'expired' }   // task aged out of provider history
    if (t.status === 'completed' && t.result) {
      await downloadAudio(t.result, destPath)
      const stat = await fs.stat(destPath).catch(() => null)
      return { status: 'recovered', bytes: stat?.size ?? 0 }
    }
    if (t.status === 'failed' || t.status === 'error') return { status: 'failed' }
    return { status: 'pending' }
  }

  // ── Video (kie / fal) ─────────────────────────────────────────────────
  if (kind === 'video') {
    let lookup
    switch (entry.provider) {
      case 'kie-video':
      case 'kie':
        if (!apiKeys.kie) return { status: 'skipped' }
        lookup = await fetchKieVideo(entry.task_id, entry.poll_path || '', apiKeys.kie)
        break
      case 'fal-video':
      case 'fal':
        lookup = await fetchFalVideo(entry.result_url || '')
        break
      default:
        return { status: 'skipped' }
    }
    if (lookup.status === 'success' && lookup.urls.length) {
      const v = parseVariantIndex(destPath)
      const url = lookup.urls[v - 1] || lookup.urls[0]
      if (!url) return { status: 'failed' }
      await downloadVideo(url, destPath)
      const stat = await fs.stat(destPath).catch(() => null)
      return { status: 'recovered', bytes: stat?.size ?? 0 }
    }
    if (lookup.status === 'pending') return { status: 'pending' }
    if (lookup.status === 'expired') return { status: 'expired' }
    return { status: 'failed' }
  }

  return { status: 'skipped' }
}

/**
 * Pull the variant index from a filename like `DK0001_Scene01_v3.png`
 * → 3. Defaults to 1 when the suffix is absent or unparseable so a
 * single-variant entry maps to urls[0].
 */
function parseVariantIndex(filePath: string): number {
  const m = path.basename(filePath).match(/_v(\d+)\.[a-z0-9]+$/i)
  if (!m) return 1
  const n = parseInt(m[1]!, 10)
  return Number.isFinite(n) && n >= 1 ? n : 1
}
