/**
 * B-Roll selector — pure algorithm: given a pool, a target narration
 * duration, and selection preferences, return an ordered list of clip
 * filenames + per-segment target durations that cover the narration.
 *
 * Separated from the HTTP / disk layers so the algorithm is testable in
 * isolation and reusable from CLI tools / batch runs.
 *
 * Repeat-avoidance is layered:
 *   - Within-episode: never include the same clip twice in one sequence
 *     UNLESS the candidate pool is too small to cover the target duration.
 *     In that case we relax and allow loop-back (deterministic — no
 *     consecutive same-clip pairs).
 *   - Cross-episode: callers pass a list of recently-used clip shas;
 *     those are excluded from the candidate pool entirely (the lookback
 *     length is the caller's decision).
 *
 * Pacing modes:
 *   - 'rotate': each clip plays for its full native duration (subject to
 *     a per-clip cap to avoid one giant clip dominating the video).
 *     Total cumulative duration >= target_duration.
 *   - 'natural': each clip plays for its complete native duration with no
 *     pacing cap. Intended for Video Assembly's "full clip length" mode.
 *   - 'timed':  every segment is exactly segment_seconds long. Short
 *     clips loop within their segment; long clips are truncated. Number
 *     of segments = ceil(target / segment_seconds).
 */

import { mulberry32 } from './seeded-random.js'

export interface PoolClip {
  filename: string
  duration: number
  sha256: string
  tags: string[]
  normalized: boolean
  missing?: boolean
}

export interface SelectionInput {
  pool: PoolClip[]
  /** Narration duration in seconds. Sequence will cover at least this long. */
  target_duration: number
  selection_mode: 'random' | 'tagged' | 'themed' | 'manual'
  /** Tags filter — required when mode is tagged or themed. */
  tags?: string[]
  pacing_mode: 'rotate' | 'natural' | 'timed'
  /** Segment length when pacing=timed. Ignored when pacing=rotate. */
  segment_seconds?: number
  /** Clip shas to exclude (cross-episode repeat avoidance). */
  exclude_shas?: string[]
  /** Random seed for deterministic test reproduction. Live calls omit. */
  seed?: number
}

export interface SelectionEntry {
  filename: string
  sha256: string
  /** How long this clip should play in the final video. For pacing=rotate
   *  it's the clip's native duration (or a per-clip cap, whichever is
   *  smaller). For pacing=timed it's segment_seconds. */
  target_duration: number
}

export interface SelectionResult {
  selection: SelectionEntry[]
  /** Diagnostic info surfaced to the UI when the candidate pool was
   *  too small to satisfy preferences. */
  warnings: string[]
  pool_size_after_filter: number
}

// ── Helpers ────────────────────────────────────────────────────────────

/** The shared seeded PRNG — see `lib/seeded-random.ts` for why there is one copy. */
function shuffleInPlace<T>(arr: T[], rnd: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j]!, arr[i]!]
  }
}

// Per-clip cap when pacing=rotate. Without a cap, one 60-second nature
// shot would dominate a 5-minute prayer video and the rotation feel
// disappears. 15 seconds keeps the cut cadence visible without forcing
// short clips to loop unnecessarily.
const ROTATE_MAX_SEGMENT_SEC = 15
// Minimum useful clip duration. Anything shorter is too brief to be a
// meaningful B-Roll segment — filter out at scan time to avoid them
// being picked.
const MIN_CLIP_SEC = 1

// ── Main selector ─────────────────────────────────────────────────────

export function selectBroll(input: SelectionInput): SelectionResult {
  const warnings: string[] = []
  const excludeShas = new Set(input.exclude_shas || [])

  // Build the candidate pool. Filters are layered:
  //   1. drop missing files
  //   2. drop sub-MIN clips (too short to be useful)
  //   3. drop clips in the cross-episode exclude window
  //   4. drop clips that don't match the tag filter (tagged/themed)
  // If the cross-episode exclude wipes out everything, we auto-relax
  // and try again without it — better to repeat a clip than refuse to
  // render. The warning surfaces the relaxation so the user knows why.
  const tagSet = new Set((input.tags || []).map(t => t.trim().toLowerCase()).filter(Boolean))
  const isTagMode = input.selection_mode === 'tagged' || input.selection_mode === 'themed'
  if (isTagMode && !tagSet.size) {
    warnings.push(`Mode "${input.selection_mode}" requires at least one tag — falling back to a random sample of the whole pool.`)
  }

  function applyFilters(opts: { withExcludes: boolean; withTags: boolean }): PoolClip[] {
    return input.pool.filter(c => {
      if (c.missing) return false
      if (c.duration < MIN_CLIP_SEC) return false
      if (opts.withExcludes && excludeShas.has(c.sha256)) return false
      if (opts.withTags && isTagMode && tagSet.size) {
        const clipTags = new Set((c.tags || []).map(t => t.toLowerCase()))
        if (input.selection_mode === 'tagged') {
          let any = false
          for (const t of tagSet) if (clipTags.has(t)) { any = true; break }
          if (!any) return false
        } else {
          for (const t of tagSet) if (!clipTags.has(t)) return false
        }
      }
      return true
    })
  }

  let candidates = applyFilters({ withExcludes: true, withTags: true })

  // Auto-relax 1: cross-episode exclude wiped everything. Drop it.
  if (!candidates.length && excludeShas.size) {
    const withoutExcludes = applyFilters({ withExcludes: false, withTags: true })
    if (withoutExcludes.length) {
      warnings.push(
        `Cross-episode repeat avoidance eliminated every candidate (${excludeShas.size} clip(s) used in the last uploads). ` +
        `Relaxing the lookback for this episode — consider adding more clips, lowering broll_lookback, or both.`,
      )
      candidates = withoutExcludes
    }
  }

  const poolSizeAfterFilter = candidates.length
  if (!candidates.length) {
    warnings.push(
      isTagMode && tagSet.size
        ? 'No clips matched the tag filter. Try fewer tags, broader tags, or switch to random mode.'
        : 'The pool is empty or every clip is marked missing. Drop more files into the pool folder + re-scan.',
    )
    return { selection: [], warnings, pool_size_after_filter: 0 }
  }

  // 2. Shuffle for variety. Manual mode skips shuffling (caller chose order).
  const rnd = mulberry32(input.seed ?? Date.now())
  if (input.selection_mode !== 'manual') shuffleInPlace(candidates, rnd)

  // 3. Build the sequence.
  const target = Math.max(1, input.target_duration)
  const selection: SelectionEntry[] = []
  let cumulative = 0
  const usedInThisEpisode = new Set<string>()

  if (input.pacing_mode === 'timed') {
    const seg = Math.max(1, Math.round(input.segment_seconds || 8))
    const segmentCount = Math.ceil(target / seg)
    for (let i = 0; i < segmentCount; i++) {
      const pick = pickNext(candidates, usedInThisEpisode, rnd)
      if (!pick) break
      selection.push({ filename: pick.filename, sha256: pick.sha256, target_duration: seg })
      usedInThisEpisode.add(pick.sha256)
    }
    cumulative = selection.length * seg
  } else {
    // rotate caps long clips to maintain cadence; natural uses the complete
    // source duration so Video Assembly can avoid selecting surplus clips.
    while (cumulative < target) {
      const pick = pickNext(candidates, usedInThisEpisode, rnd)
      if (!pick) break
      const dur = input.pacing_mode === 'natural'
        ? pick.duration
        : Math.min(pick.duration, ROTATE_MAX_SEGMENT_SEC)
      selection.push({ filename: pick.filename, sha256: pick.sha256, target_duration: dur })
      usedInThisEpisode.add(pick.sha256)
      cumulative += dur
    }
  }

  if (cumulative < target) {
    warnings.push(
      `Pool too small to fill ${Math.round(target)}s of narration without repeating clips. ` +
      `Got ${Math.round(cumulative)}s from ${selection.length} unique clip(s). ` +
      `Add more clips to the pool, broaden the tag filter, or reduce broll_lookback.`,
    )
  }

  return { selection, warnings, pool_size_after_filter: poolSizeAfterFilter }
}

/**
 * Pick the next clip from `candidates`, preferring ones not yet used in
 * this episode. When everything's been used (small pool case), pick any
 * candidate that ISN'T the most recent pick (avoids consecutive duplicates).
 */
function pickNext(
  candidates: PoolClip[],
  used: Set<string>,
  rnd: () => number,
): PoolClip | null {
  if (!candidates.length) return null
  // Prefer never-used.
  const fresh = candidates.filter(c => !used.has(c.sha256))
  if (fresh.length) {
    return fresh[Math.floor(rnd() * fresh.length)] || null
  }
  // Loop-back: pool exhausted. Pick any.
  return candidates[Math.floor(rnd() * candidates.length)] || null
}
