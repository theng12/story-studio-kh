/**
 * Compatibility wrapper for historical SFX auto-fetch calls. Resolution is
 * local-pool-only until GenStudio exposes a typed, qualified SFX fetch route.
 */
import * as bp from './broll-pool-manager.js'
import { gatherSfxCandidates, resolvePlan } from './sfx-resolver.js'
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
  return false
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
  void label
  void pool
  return null
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
 * Resolve a plan against local SFX pools. Historical auto-fetch flags are
 * accepted for compatibility but never cause an external request.
 */
export async function resolveWithFetch(
  plan: SfxPlan,
  opts: { autoFetch?: boolean; fetchPoolId?: string } = {},
): Promise<ResolveWithFetchResult> {
  const candidates = await gatherSfxCandidates()
  const resolved = resolvePlan(plan, candidates)
  return {
    plan: resolved,
    candidate_count: candidates.length,
    fetched: [],
    fetch_skipped_reason: opts.autoFetch
      ? 'External SFX auto-fetch is disabled until GenStudio KH publishes a qualified typed SFX route.'
      : undefined,
  }
}
