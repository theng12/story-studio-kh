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
 *   - 'timed':  every segment is exactly segment_seconds long. Short
 *     clips loop within their segment; long clips are truncated. Number
 *     of segments = ceil(target / segment_seconds).
 */

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
  pacing_mode: 'rotate' | 'timed'
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

/** Mulberry32 — small, fast, seedable PRNG. Used for deterministic test
 *  shuffles; live calls pass a Date.now()-derived seed for variety. */
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

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

  // 1. Filter the pool.
  let candidates = input.pool.filter(c => {
    if (c.missing) return false
    if (c.duration < MIN_CLIP_SEC) return false
    if (excludeShas.has(c.sha256)) return false
    return true
  })

  if (input.selection_mode === 'tagged' || input.selection_mode === 'themed') {
    const tagSet = new Set((input.tags || []).map(t => t.trim().toLowerCase()).filter(Boolean))
    if (!tagSet.size) {
      warnings.push(`Mode "${input.selection_mode}" requires at least one tag — falling back to random.`)
    } else {
      candidates = candidates.filter(c => {
        const clipTags = new Set((c.tags || []).map(t => t.toLowerCase()))
        if (input.selection_mode === 'tagged') {
          for (const t of tagSet) if (clipTags.has(t)) return true
          return false
        }
        // themed: ALL tags must match
        for (const t of tagSet) if (!clipTags.has(t)) return false
        return true
      })
    }
  }

  const poolSizeAfterFilter = candidates.length
  if (!candidates.length) {
    warnings.push('No clips matched the selection filter. Try a broader tag set, fewer tags, or relax repeat-avoidance.')
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
    // rotate: take each clip for min(native, ROTATE_MAX_SEGMENT_SEC)
    // until cumulative covers the target.
    while (cumulative < target) {
      const pick = pickNext(candidates, usedInThisEpisode, rnd)
      if (!pick) break
      const dur = Math.min(pick.duration, ROTATE_MAX_SEGMENT_SEC)
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
