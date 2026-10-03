/**
 * Choose which tracks fill one music video, and in what order (v1.4.37).
 *
 * PURE ON PURPOSE. Nothing here reads disk, calls a provider, or spends a
 * credit. Building a video buys NOTHING — the owner tops up the library
 * deliberately and then assembles for free, and a chain that quietly purchased
 * during assembly is the exact shape of the v1.0.114 bug that cost him real
 * duplicate charges. Keeping the decision pure is how that stays true: a
 * function with no API client in scope cannot spend money by accident.
 *
 * THE THREE RULES, and why each exists:
 *
 * 1. **No track twice in one video.** An hour that repeats is an hour a
 *    listener notices.
 * 2. **Siblings never adjacent.** Suno returns two songs per charge, and
 *    because both come from ONE instruction they sound like cousins — same
 *    mood, same instruments, similar tempo. Back to back they read as a single
 *    song looping, which sounds cheap. The gap is a setting, not a constant.
 * 3. **A shortfall is reported, never hidden.** If the library cannot fill the
 *    runtime, this says by how much rather than silently handing back a shorter
 *    video. The caller then offers to generate the difference — an offer, never
 *    an automatic purchase.
 */

/** The subset of a library track the builder needs. Keeps this file pure. */
export interface MixCandidate {
  filename: string
  title: string
  duration_sec: number
  enabled: boolean
  sibling_group?: string
  /** How many rendered mixes have already used it, for rotation fairness. */
  times_used?: number
}

export interface MixRules {
  /** Minimum tracks between two siblings. Owner-settable; never hardcoded. */
  siblingGapTracks: number
  /**
   * Overshoot rather than cut a track in half.
   *
   * A target rarely lands on a track boundary. Truncating the last song mid-bar
   * is audibly wrong, so the mix runs slightly LONG instead — which also costs
   * nothing, because runtime is free once the library exists.
   */
  overshoot: boolean
}

export const DEFAULT_MIX_RULES: MixRules = { siblingGapTracks: 5, overshoot: true }

export interface MixEntry {
  filename: string
  title: string
  /** Seconds from the start of the video where this track begins. */
  start_sec: number
  duration_sec: number
}

export interface MixPlan {
  entries: MixEntry[]
  total_sec: number
  /** Seconds still needed to reach the target. 0 when the target was met. */
  shortfall_sec: number
  /** Tracks that could not be placed without breaking the sibling rule. */
  blocked_by_sibling_rule: number
  notes: string[]
}

/**
 * Deterministic shuffle from a seed.
 *
 * Seeded rather than random so the same library and the same episode produce
 * the same running order every time. A rebuild after a crash must not silently
 * reorder a video whose tracklist is already in a published description.
 */
export function seededOrder<T>(items: T[], seed: string): T[] {
  let h = 2166136261
  for (const ch of seed) {
    h ^= ch.charCodeAt(0)
    h = Math.imul(h, 16777619) >>> 0
  }
  const keyed = items.map((item, i) => {
    h ^= i + 0x9e3779b9
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0
    return { item, key: h }
  })
  return keyed.sort((a, b) => a.key - b.key).map(k => k.item)
}

/**
 * Fill `targetSec` from the library.
 *
 * Selection order favours tracks used least, so a library rotates instead of
 * leaning on whatever happens to sort first. Within an equal use count the
 * seeded shuffle decides, which keeps successive videos from opening with the
 * same song.
 */
export function buildMusicMix(
  candidates: readonly MixCandidate[],
  targetSec: number,
  seed: string,
  rules: MixRules = DEFAULT_MIX_RULES,
): MixPlan {
  const notes: string[] = []
  const gap = Math.max(0, Math.floor(rules.siblingGapTracks))
  const usable = candidates.filter(c => c.enabled && c.duration_sec > 0)
  const skipped = candidates.length - usable.length
  if (skipped > 0) {
    notes.push(`${skipped} track(s) skipped: disabled, or no measured duration yet.`)
  }

  // Least-used first, then seeded. Rotation is what stops a big library
  // behaving like a small one.
  const pool = seededOrder(usable, seed)
    .sort((a, b) => (a.times_used || 0) - (b.times_used || 0))

  const entries: MixEntry[] = []
  const used = new Set<string>()
  let total = 0
  let blocked = 0

  const siblingTooClose = (candidate: MixCandidate): boolean => {
    if (!candidate.sibling_group || gap === 0) return false
    const window = entries.slice(Math.max(0, entries.length - gap))
    return window.some(e => {
      const placed = usable.find(c => c.filename === e.filename)
      return placed?.sibling_group === candidate.sibling_group
    })
  }

  while (total < targetSec) {
    let picked: MixCandidate | undefined
    let sawBlocked = false
    for (const candidate of pool) {
      if (used.has(candidate.filename)) continue
      if (siblingTooClose(candidate)) { sawBlocked = true; continue }
      picked = candidate
      break
    }
    if (!picked) {
      // Nothing placeable. Either the library is exhausted, or everything left
      // is a sibling of something recent. Both are shortfalls, and the second
      // one is worth naming separately so the owner does not conclude his
      // library is smaller than it is.
      if (sawBlocked) blocked++
      break
    }
    // Stop BEFORE overshooting when the caller asked for that; otherwise take
    // the track whole and run long.
    if (!rules.overshoot && total + picked.duration_sec > targetSec) break
    entries.push({
      filename: picked.filename,
      title: picked.title,
      start_sec: Math.round(total),
      duration_sec: picked.duration_sec,
    })
    used.add(picked.filename)
    total += picked.duration_sec
  }

  const shortfall = Math.max(0, Math.round(targetSec - total))
  if (shortfall > 0) {
    notes.push(
      `The library is ${Math.ceil(shortfall / 60)} minute(s) short of the target. `
      + 'Nothing was generated to cover it — top up the library and rebuild.',
    )
  }
  if (blocked > 0) {
    notes.push(
      'Some tracks were held back because they came from the same request as one playing nearby, '
      + 'and two of those in a row sound like one song repeating.',
    )
  }

  return {
    entries,
    total_sec: Math.round(total),
    shortfall_sec: shortfall,
    blocked_by_sibling_rule: blocked,
    notes,
  }
}

/** `H:MM:SS` when the video runs an hour or more, `M:SS` below that. */
export function formatTimestamp(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const hours = Math.floor(s / 3600)
  const minutes = Math.floor((s % 3600) / 60)
  const seconds = s % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`
}

/**
 * The tracklist that goes in the video description.
 *
 * Free to produce and the reason these channels earn watch-time: every entry is
 * a timestamp a viewer can click. Derived from the stitch, so it cannot drift
 * from the audio — the boundaries ARE the start times.
 */
export function renderTracklist(plan: MixPlan): string {
  return plan.entries
    .map(entry => `${formatTimestamp(entry.start_sec)} ${entry.title}`)
    .join('\n')
}
