/**
 * Scripted B-Roll local bridge. It preserves local pool lookup and final
 * assembly for existing resolved plans. Provider search/download is disabled
 * until GenStudio exposes a typed, qualified asset-search route.
 */
import * as bp from './broll-pool-manager.js'
import type { FetchProvider, FetchResult } from './broll-fetchers/types.js'
import { isBeatLive, type BrollPlan } from './broll-plan.js'
import type { SelectionEntry } from '../lib/broll-selector.js'
import type { BrollSelectionSidecar } from './broll-selection-sidecar.js'

/** First online video pool (or the preferred id when it's a valid online video pool). */
export async function pickVideoPool(preferredId?: string): Promise<bp.BrollPool | null> {
  if (preferredId) {
    const p = await bp.getPool(preferredId)
    if (p && bp.poolMedia(p) === 'video' && (await bp.isPoolOnline(p.id))) return p
  }
  for (const p of await bp.listPools()) {
    if (bp.poolMedia(p) === 'video' && (await bp.isPoolOnline(p.id))) return p
  }
  return null
}

/** Which video providers have an API key configured. */
export async function configuredVideoProviders(): Promise<FetchProvider[]> {
  return []
}

/**
 * Download one search result into a pool (provenance recorded). Returns the
 * indexed filename. Reused by both batch resolve and single-beat swap. Skips the
 * download when a file with the deterministic name already exists.
 */
export async function downloadResultToPool(
  pool: bp.BrollPool,
  result: FetchResult,
  provider: FetchProvider,
  keywords: string[],
): Promise<string> {
  void pool
  void result
  void provider
  void keywords
  throw new Error('GENSTUDIO_CAPABILITY_UNAVAILABLE: Stock downloads require a qualified typed GenStudio KH asset-fetch route.')
}

/** Search candidates across configured providers for the swap picker (no download). */
export async function searchCandidates(queries: string[], limit = 12): Promise<Array<{ provider: FetchProvider; result: FetchResult }>> {
  void queries
  void limit
  return []
}

export interface ResolveBeatsResult {
  plan: BrollPlan
  downloaded: number
  matched: number
  /** Beats filled by the styled AI-gen fallback. */
  aigen: number
  pool_id?: string
  skipped_reason?: string
}

/**
 * Resolve every unresolved beat: search → pick (no-repeat) → download into the
 * target video pool → record on the beat. When `aiFallback` is set, beats that
 * stock couldn't fill get a styled AI-generated clip. Re-scans the pool once at
 * the end.
 */
export async function resolveBeats(
  plan: BrollPlan,
  opts: {
    poolId?: string
    aiFallback?: { slug: string; model: string; aspectRatio?: string; imageSteps?: number; seed?: number }
  } = {},
): Promise<ResolveBeatsResult> {
  const pool = await pickVideoPool(opts.poolId)
  return {
    plan,
    downloaded: 0,
    matched: plan.beats.filter(isBeatLive).length,
    aigen: 0,
    pool_id: pool?.id,
    skipped_reason: 'Automatic B-Roll search, download, and generation are disabled until GenStudio KH publishes a qualified typed asset-planning route. Existing local clips and assembled plans remain usable.',
  }
}

// ── Bridge: plan → existing broll-selection sidecar ─────────────────────────

/** Pure: build selection entries from live beats, resolving sha256 via a map. */
export function buildSelectionFromPlan(
  plan: BrollPlan,
  shaByName: Record<string, string>,
): { pool_id: string; selection: SelectionEntry[]; target_duration: number } | null {
  const live = plan.beats.filter(isBeatLive)
  if (!live.length) return null
  const pool_id = live.find(b => b.pool_id)?.pool_id || ''
  if (!pool_id) return null
  const selection: SelectionEntry[] = live
    .filter(b => b.pool_id === pool_id)
    .map(b => ({
      filename: b.clip,
      sha256: shaByName[b.clip] || '',
      target_duration: Math.max(0.5, b.end_sec - b.start_sec),
    }))
  const target_duration = live.reduce((acc, b) => Math.max(acc, b.end_sec), 0)
  return { pool_id, selection, target_duration }
}

/**
 * Build the BrollSelectionSidecar object for a resolved plan (impure: reads the
 * pool index for sha256s). Returns null when no beat is live. The caller saves
 * it via saveSelectionSidecar so the existing assembler picks it up.
 */
export async function planToSelectionSidecar(plan: BrollPlan, code: string): Promise<BrollSelectionSidecar | null> {
  const live = plan.beats.filter(isBeatLive)
  const pool_id = live.find(b => b.pool_id)?.pool_id
  if (!pool_id) return null
  const clips = await bp.listClips(pool_id, { includeMissing: false })
  const shaByName: Record<string, string> = {}
  for (const c of clips) shaByName[c.filename] = c.sha256
  const built = buildSelectionFromPlan(plan, shaByName)
  if (!built || !built.selection.length) return null
  return {
    schema_version: 1,
    episode_code: code.toUpperCase(),
    pool_id: built.pool_id,
    media: 'video',
    selection_mode: 'manual',
    pacing_mode: 'timed',
    // Mute stock-clip audio — narration (+ the SFX layer) own the sound bed.
    broll_volume: 0,
    selection: built.selection,
    target_duration: built.target_duration,
    generated_at: new Date().toISOString(),
    motion_mode: 'fixed',
    motion_default: 'static',
    transition_id: 'none',
    transition_duration: 0.5,
  }
}
