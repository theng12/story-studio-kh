/**
 * SFX auto-fetch — fills a plan's unmatched cues by downloading sound effects
 * from Freesound INTO an SFX pool, so the pool grows with each video. This is
 * what bootstraps the library: early videos fetch a lot, later videos mostly
 * hit clips already in the pool (instant + free) and only reach out for novel
 * sounds.
 *
 * Reuses the v1.0.481 fetch machinery (Freesound adapter + provenance + indexer)
 * exactly as the manual B-Roll Fetch flow does. Best-effort throughout — a
 * network hiccup or missing key degrades to "cue stays empty", never an error.
 */
import { existsSync } from 'fs'
import fs from 'fs/promises'
import path from 'path'
import * as bp from './broll-pool-manager.js'
import { getAdapter } from './broll-fetchers/index.js'
import { writeProvenance, recordFromResult, hasFetchedClip, suggestFilename } from './broll-provenance.js'
import { scanPoolFolder } from '../lib/broll-indexer.js'
import { gatherSfxCandidates, resolvePlan } from './sfx-resolver.js'
import { tokenize } from './sfx-resolver.js'
import type { SfxPlan, SfxBed, SfxSpot } from './sfx-plan.js'

/** Pick the SFX (audio) pool to download into: the preferred id if it's a valid
 *  online audio pool, else the first online audio pool. */
export async function pickFetchTargetPool(preferredId?: string): Promise<bp.BrollPool | null> {
  if (preferredId) {
    const p = await bp.getPool(preferredId)
    if (p && bp.poolMedia(p) === 'audio' && (await bp.isPoolOnline(p.id))) return p
  }
  for (const p of await bp.listPools()) {
    if (bp.poolMedia(p) === 'audio' && (await bp.isPoolOnline(p.id))) return p
  }
  return null
}

export async function isFreesoundConfigured(): Promise<boolean> {
  try { return await getAdapter('freesound').isConfigured() } catch { return false }
}

/** Distinct, non-empty labels of cues that have no clip yet. Pure. */
export function distinctEmptyLabels(plan: SfxPlan): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const c of [...plan.beds, ...plan.spots] as Array<SfxBed | SfxSpot>) {
    if (c.clip) continue
    const label = (c.label || '').trim()
    if (!label) continue
    const key = label.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(label)
  }
  return out
}

/**
 * Search Freesound for `label` and download the best preview into `pool`
 * (provenance + re-scan + tag), so it becomes a pool candidate. Returns the
 * indexed filename, or null when nothing was downloaded (already present, no
 * result, or not configured). Throws only on truly unexpected errors — callers
 * wrap in try/catch.
 */
export async function autoFetchForLabel(label: string, pool: bp.BrollPool): Promise<string | null> {
  const adapter = getAdapter('freesound')
  if (!(await adapter.isConfigured())) return null
  if (!existsSync(pool.folder_path)) return null

  const results = await adapter.search(label, { perPage: 8 }).catch(() => [])
  const pick = results.find(r => r.files && r.files.length > 0)
  if (!pick) return null

  // Already in this pool (any filename) — the existing clip is already a
  // candidate; let the re-resolve pass match it instead of duplicating.
  if (await hasFetchedClip(pool.folder_path, 'freesound', pick.source_id)) return null

  const filename = suggestFilename('freesound', pick.source_id, [label], 'mp3')
  const destPath = path.join(pool.folder_path, filename)
  if (existsSync(destPath)) return null

  await adapter.download(pick, destPath, { quality: 'hd' })
  const stat = await fs.stat(destPath).catch(() => null)
  if (!stat || stat.size === 0) {
    await fs.unlink(destPath).catch(() => {})
    return null
  }

  const sidecar = recordFromResult(pick, filename, pick.width || 0, pick.height || 0, [label])
  await writeProvenance(pool.folder_path, sidecar)
  await scanPoolFolder(pool.folder_path, undefined, 'audio')

  // Tag with the provider tags (+ the label tokens) so the matcher finds it.
  const tags = Array.from(new Set([...(pick.tags || []), ...tokenize(label)]))
  if (tags.length) await bp.setClipTags(pool.id, filename, tags).catch(() => {})
  return filename
}

export interface ResolveWithFetchResult {
  plan: SfxPlan
  candidate_count: number
  /** Labels for which a NEW clip was downloaded this pass. */
  fetched: string[]
  /** Set when auto-fetch was requested but couldn't run. */
  fetch_skipped_reason?: string
}

/**
 * Resolve a plan against the SFX pools, then (when `autoFetch`) download
 * Freesound clips for any still-empty cue and re-resolve. Sequential fetch
 * (the indexer mutates the pool) — slow on the first videos, fast once the pool
 * is seeded.
 */
export async function resolveWithFetch(
  plan: SfxPlan,
  opts: { autoFetch?: boolean; fetchPoolId?: string } = {},
): Promise<ResolveWithFetchResult> {
  let candidates = await gatherSfxCandidates()
  let resolved = resolvePlan(plan, candidates)
  const fetched: string[] = []

  if (!opts.autoFetch) {
    return { plan: resolved, candidate_count: candidates.length, fetched }
  }

  const pool = await pickFetchTargetPool(opts.fetchPoolId)
  if (!pool) {
    return { plan: resolved, candidate_count: candidates.length, fetched, fetch_skipped_reason: 'No online SFX (audio) pool to download into. Register one in the Assets Library first.' }
  }
  if (!(await isFreesoundConfigured())) {
    return { plan: resolved, candidate_count: candidates.length, fetched, fetch_skipped_reason: 'No Freesound API key. Add one under App Settings → API Keys.' }
  }

  const labels = distinctEmptyLabels(resolved)
  for (const label of labels) {
    try {
      const got = await autoFetchForLabel(label, pool)
      if (got) fetched.push(label)
    } catch { /* best-effort: leave the cue empty */ }
  }

  if (labels.length) {
    candidates = await gatherSfxCandidates()
    resolved = resolvePlan(resolved, candidates)
  }
  return { plan: resolved, candidate_count: candidates.length, fetched }
}
