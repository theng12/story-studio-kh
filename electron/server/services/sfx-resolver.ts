/**
 * SFX resolver — fills a proposed plan's cues with real clips from the SFX
 * pools (the v1.0.481 audio pools). This is step 1 of the resolution chain
 * (pool → Freesound → ElevenLabs); pool-only for now, the others slot in later.
 *
 * The matcher is pure (label vs. candidate tags/filename) so it's unit-testable;
 * the pool gathering + path resolution are thin impure adapters over
 * broll-pool-manager.
 *
 * Resolution sets source/clip/pool_id/status on each cue. A cue with no match
 * becomes status:'empty' (does not affect the render). Spots are no-repeat: the
 * same one-shot file isn't reused across spots within an episode.
 */
import path from 'path'
import { existsSync } from 'fs'
import * as bp from './broll-pool-manager.js'
import { isCueLive, type SfxPlan, type SfxBed, type SfxSpot } from './sfx-plan.js'
import type { MixCue } from '../lib/sfx-mixer.js'

export interface SfxCandidate {
  pool_id: string
  filename: string
  tags: string[]
}

const STOP = new Set(['a', 'an', 'the', 'of', 'in', 'on', 'at', 'to', 'and', 'or', 'with', 'sound', 'sfx', 'effect', 'fx', 'audio'])

/** lowercase → significant word tokens. Pure. */
export function tokenize(s: string): string[] {
  return (s || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(w => w.length >= 3 && !STOP.has(w))
}

/** Overlap score between a cue label and a candidate. Higher = better. Pure. */
export function scoreCandidate(label: string, cand: SfxCandidate): number {
  const want = new Set(tokenize(label))
  if (want.size === 0) return 0
  const have = new Set([...tokenize(cand.filename.replace(/\.[a-z0-9]+$/i, '')), ...cand.tags.flatMap(tokenize)])
  let score = 0
  for (const w of want) if (have.has(w)) score++
  // Bonus when the whole label appears as a tag (strong, intentional match).
  const labelKey = label.toLowerCase().trim()
  if (cand.tags.some(t => t.toLowerCase().trim() === labelKey)) score += 2
  return score
}

/** Pick the best-scoring candidate not in `exclude`. Pure. Returns null if none scores. */
export function pickBest(label: string, candidates: SfxCandidate[], exclude: Set<string>): SfxCandidate | null {
  let best: SfxCandidate | null = null
  let bestScore = 0
  for (const c of candidates) {
    const key = `${c.pool_id}/${c.filename}`
    if (exclude.has(key)) continue
    const s = scoreCandidate(label, c)
    if (s > bestScore) {
      bestScore = s
      best = c
    }
  }
  return best
}

/**
 * Resolve every unresolved/proposed cue against the candidate clips. Pure.
 * - Already-resolved cues (user-swapped/matched with a clip) are left untouched.
 * - Spots are no-repeat across the episode; beds may share a clip.
 */
export function resolvePlan(plan: SfxPlan, candidates: SfxCandidate[]): SfxPlan {
  const usedSpots = new Set<string>()
  // Seed exclusions with clips the user already pinned, so auto-resolve avoids them.
  for (const s of plan.spots) if (s.clip && s.pool_id) usedSpots.add(`${s.pool_id}/${s.clip}`)

  const resolveBed = (b: SfxBed): SfxBed => {
    if (b.clip && b.status === 'user-swapped') return b // respect manual pick
    const match = pickBest(b.label, candidates, new Set())
    if (!match) return { ...b, source: '', clip: '', pool_id: undefined, status: b.clip ? b.status : 'empty' }
    return { ...b, source: 'pool', pool_id: match.pool_id, clip: match.filename, status: 'matched' }
  }
  const resolveSpot = (s: SfxSpot): SfxSpot => {
    if (s.clip && s.status === 'user-swapped') {
      usedSpots.add(`${s.pool_id}/${s.clip}`)
      return s
    }
    const match = pickBest(s.label, candidates, usedSpots)
    if (!match) return { ...s, source: '', clip: '', pool_id: undefined, status: s.clip ? s.status : 'empty' }
    usedSpots.add(`${match.pool_id}/${match.filename}`)
    return { ...s, source: 'pool', pool_id: match.pool_id, clip: match.filename, status: 'matched' }
  }

  return { ...plan, beds: plan.beds.map(resolveBed), spots: plan.spots.map(resolveSpot) }
}

// ── Impure pool adapters ─────────────────────────────────────────────────────

/** Gather candidate clips from every ONLINE audio (SFX) pool on this machine. */
export async function gatherSfxCandidates(): Promise<SfxCandidate[]> {
  const pools = await bp.listPools()
  const out: SfxCandidate[] = []
  for (const pool of pools) {
    if (bp.poolMedia(pool) !== 'audio') continue
    if (!(await bp.isPoolOnline(pool.id))) continue
    const clips = await bp.listClips(pool.id, { includeMissing: false })
    for (const c of clips) out.push({ pool_id: pool.id, filename: c.filename, tags: c.tags || [] })
  }
  return out
}

/** Resolve a cue's (pool_id, filename) to an absolute file path on this machine. */
export async function resolveCuePath(pool_id: string | undefined, filename: string): Promise<string | null> {
  if (!pool_id || !filename) return null
  const pool = await bp.getPool(pool_id)
  if (!pool) return null
  const abs = path.join(pool.folder_path, filename)
  return existsSync(abs) ? abs : null
}

/**
 * Map a resolved plan to mixer cues with absolute paths (current machine).
 * Skips cues whose clip can't be located (offline SSD / missing file) so the
 * render degrades gracefully.
 */
export async function planToMixCues(plan: SfxPlan): Promise<MixCue[]> {
  const cues: MixCue[] = []
  for (const b of plan.beds) {
    if (!isCueLive(b)) continue
    const abs = await resolveCuePath(b.pool_id, b.clip)
    if (abs) cues.push({ kind: 'bed', path: abs, gain_db: b.gain_db, start_sec: b.start_sec, end_sec: b.end_sec })
  }
  for (const s of plan.spots) {
    if (!isCueLive(s)) continue
    const abs = await resolveCuePath(s.pool_id, s.clip)
    if (abs) cues.push({ kind: 'spot', path: abs, gain_db: s.gain_db, start_sec: s.at_sec })
  }
  return cues
}
