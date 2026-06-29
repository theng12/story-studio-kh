/**
 * Scripted B-Roll resolver — turns a plan's per-beat queries into real clips by
 * searching Pexels/Pixabay and downloading the picks into a video pool, then
 * bridges the resolved plan to the existing broll-selection sidecar so the
 * EXISTING assembler (generators/broll-assemble.ts) renders it unchanged.
 *
 * Reuses the v1.0.x fetch machinery (adapters + provenance + indexer) exactly as
 * manual B-Roll Fetch does. Best-effort per beat: a query that finds nothing
 * leaves the beat 'empty' rather than failing the whole resolve.
 */
import path from 'path'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import * as bp from './broll-pool-manager.js'
import { getAdapter, type FetchProvider, type FetchResult } from './broll-fetchers/index.js'
import { writeProvenance, recordFromResult, suggestFilename } from './broll-provenance.js'
import { scanPoolFolder } from '../lib/broll-indexer.js'
import { isBeatLive, type BrollPlan, type BrollSource } from './broll-plan.js'
import type { SelectionEntry } from '../lib/broll-selector.js'
import type { BrollSelectionSidecar } from './broll-selection-sidecar.js'

const VIDEO_PROVIDERS: FetchProvider[] = ['pexels', 'pixabay']

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
  const out: FetchProvider[] = []
  for (const p of VIDEO_PROVIDERS) {
    try { if (await getAdapter(p).isConfigured()) out.push(p) } catch { /* skip */ }
  }
  return out
}

/** Try each query across each provider; return the first result with files not already used. */
async function searchPick(
  queries: string[],
  providers: FetchProvider[],
  exclude: Set<string>,
): Promise<{ provider: FetchProvider; result: FetchResult } | null> {
  for (const q of queries) {
    if (!q.trim()) continue
    for (const provider of providers) {
      const results = await getAdapter(provider).search(q, { perPage: 8 }).catch(() => [] as FetchResult[])
      for (const r of results) {
        if (!r.files || !r.files.length) continue
        if (exclude.has(`${provider}#${r.source_id}`)) continue
        return { provider, result: r }
      }
    }
  }
  return null
}

export interface ResolveBeatsResult {
  plan: BrollPlan
  downloaded: number
  matched: number
  pool_id?: string
  skipped_reason?: string
}

/**
 * Resolve every unresolved beat: search → pick (no-repeat) → download into the
 * target video pool → record on the beat. Re-scans the pool once at the end.
 */
export async function resolveBeats(plan: BrollPlan, opts: { poolId?: string } = {}): Promise<ResolveBeatsResult> {
  const pool = await pickVideoPool(opts.poolId)
  if (!pool) {
    return { plan, downloaded: 0, matched: 0, skipped_reason: 'No online video B-Roll pool to download into. Register one in the Assets Library first.' }
  }
  const providers = await configuredVideoProviders()
  if (!providers.length) {
    return { plan, downloaded: 0, matched: 0, pool_id: pool.id, skipped_reason: 'No Pexels/Pixabay API key. Add one under App Settings → API Keys.' }
  }
  if (!existsSync(pool.folder_path)) {
    return { plan, downloaded: 0, matched: 0, pool_id: pool.id, skipped_reason: `Pool folder offline — plug in the SSD at ${pool.folder_path}.` }
  }

  const used = new Set<string>()
  // Respect clips the user already pinned this episode (avoid duplicates).
  for (const b of plan.beats) if (b.clip && b.status === 'user-swapped') used.add(`pinned:${b.clip}`)

  let downloaded = 0
  let matched = 0
  for (const beat of plan.beats) {
    if (beat.clip && beat.status === 'user-swapped') { matched++; continue }
    if (!beat.queries.length) { beat.source = ''; beat.clip = ''; beat.status = 'empty'; continue }

    const pick = await searchPick(beat.queries, providers, used)
    if (!pick) { beat.source = ''; beat.clip = ''; beat.pool_id = undefined; beat.status = 'empty'; continue }

    const filename = suggestFilename(pick.provider, pick.result.source_id, [beat.queries[0] || beat.line], 'mp4')
    const destPath = path.join(pool.folder_path, filename)
    try {
      if (!existsSync(destPath)) {
        await getAdapter(pick.provider).download(pick.result, destPath, { quality: 'hd' })
        const stat = await fs.stat(destPath).catch(() => null)
        if (!stat || stat.size === 0) { await fs.unlink(destPath).catch(() => {}); throw new Error('empty download') }
        const dl = pick.result.files.find(f => f.quality === 'hd') || pick.result.files[0]
        const rec = recordFromResult(pick.result, filename, dl?.width ?? pick.result.width, dl?.height ?? pick.result.height, beat.queries)
        await writeProvenance(pool.folder_path, rec)
        downloaded++
      }
      beat.source = pick.provider as BrollSource // VIDEO_PROVIDERS ⊂ BrollSource
      beat.pool_id = pool.id
      beat.clip = filename
      beat.in_point_sec = 0
      beat.status = 'matched'
      matched++
      used.add(`${pick.provider}#${pick.result.source_id}`)
    } catch {
      beat.source = ''; beat.clip = ''; beat.pool_id = undefined; beat.status = 'empty'
    }
  }

  // One scan so every new clip lands in the pool index (filename+sha+duration).
  try { await scanPoolFolder(pool.folder_path, undefined, 'video') } catch { /* index best-effort */ }
  return { plan, downloaded, matched, pool_id: pool.id }
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
