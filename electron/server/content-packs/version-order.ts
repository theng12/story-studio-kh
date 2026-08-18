/**
 * Ordering version strings by their NUMBERS, for display (v1.4.1).
 *
 * ── Why this exists ──
 *
 * `'1.0.9' < '1.0.10'` is FALSE. String comparison reads the characters, so it
 * puts `1.0.10` before `1.0.2` and calls `1.0.9` the newest version a pack ever
 * shipped. Five places sorted Content Pack versions with `localeCompare` or a
 * bare `.sort()`, and every one of them was correct only for as long as no pack
 * reached a double-digit patch release.
 *
 * Found while auditing the app's own version handling after the owner fixed
 * Story Studio at `1.4.x` forever — only the third digit moves now, so it will
 * pass 1.4.9 within days. The app's own comparisons turned out to be safe
 * already (`compareVersions` in release-utils, `compareExactSemver` in the pack
 * installer, and a plain `!==` for What's New). These pack-display sorts were
 * the real instance of the same mistake, in a neighbouring version space.
 *
 * ── Why not reuse `compareExactSemver` ──
 *
 * The installer's comparator parses each segment with `BigInt`, which THROWS on
 * anything non-numeric. That is exactly right where it is used — a compatibility
 * gate should refuse a version it cannot parse. It is exactly wrong here: these
 * are display paths building an API response, and a malformed key on disk would
 * turn a mis-ordered list into a 500. So this one degrades to a string compare
 * for a segment it cannot read, and never throws.
 *
 * The strict comparator keeps its job. This one only decides what order things
 * are shown in.
 */

/**
 * Compare two dotted version strings numerically, segment by segment.
 * Returns <0, 0, >0 like any sort comparator. Never throws.
 */
export function compareVersionStrings(left: unknown, right: unknown): number {
  const a = String(left ?? '').split('.')
  const b = String(right ?? '').split('.')
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i += 1) {
    // A missing segment is 0, so `1.4` and `1.4.0` are the same version rather
    // than two versions in an arbitrary order.
    const l = a[i] ?? '0'
    const r = b[i] ?? '0'
    const isNum = /^\d+$/.test(l) && /^\d+$/.test(r)
    if (isNum) {
      const ln = Number(l)
      const rn = Number(r)
      if (ln !== rn) return ln < rn ? -1 : 1
    } else if (l !== r) {
      // Unreadable segment (a pre-release tag, or something corrupt). Fall back
      // to a stable string order rather than guessing or failing.
      return l < r ? -1 : 1
    }
  }
  return 0
}

/** Newest first. */
export function compareVersionStringsDescending(left: unknown, right: unknown): number {
  return compareVersionStrings(right, left)
}
