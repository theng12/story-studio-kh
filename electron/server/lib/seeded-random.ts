/**
 * Seeded randomness, in one place.
 *
 * Three copies of `mulberry32` had grown in this repo — `lib/transition-filters.ts`,
 * `lib/broll-selector.ts` and `generators/video.ts` — because each needed a
 * small deterministic picker and the others' copy was private. Reveal selection
 * would have been the fourth. The algorithm is identical in all of them, so this
 * is a move rather than a rewrite: the same seed still produces the same
 * sequence in every existing caller (their determinism tests are the check).
 *
 * **Why determinism matters here**: re-rendering an episode must produce the
 * identical result. That is this project's method — same input, same output —
 * and it is what makes a randomised look reviewable at all: if a reroll of the
 * episode resequenced every scene, nothing could be traced or compared.
 */

/** Tiny seeded PRNG (mulberry32) — identical across Node and the browser bundle. */
export function mulberry32(seed: number): () => number {
  let a = seed | 0
  return function () {
    a = (a + 0x6d2b79f5) | 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * A seed derived from a parent seed and a label.
 *
 * The design's rule 1: one seed per episode, each scene's effect derived from
 * `(seed, scene_index)`. Deriving rather than running one generator across the
 * whole episode is what makes a *single scene* reproducible on its own — a
 * per-scene reroll can change one scene without moving every later one, and two
 * episodes that share an act keep the same picks.
 */
export function deriveSeed(seed: number, ...parts: Array<number | string>): number {
  let hash = (seed | 0) ^ 0x9e3779b9
  for (const part of parts) {
    const text = String(part)
    for (let i = 0; i < text.length; i++) {
      hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193)
    }
    hash = Math.imul(hash ^ 0x85ebca6b, 0xc2b2ae35)
  }
  return hash >>> 0
}
