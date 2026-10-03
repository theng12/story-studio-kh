/**
 * Coverage planner for a song pool (SPEC §2.2 rule 1). PURE and seeded.
 *
 * Code decides WHAT each new song is — ensemble × mood × tempo band × key × structure — and the
 * writing model only writes the words. Per axis the least-filled value (relative to its weight)
 * comes first; a combination already in the pool is never handed out again until every
 * combination has been used. The same pool + seed always gives the same plan.
 */
import { comboCount, comboKey, formulaKeys, type SongFormula, type Weighted } from '../contracts/song-formula.js'

export interface PlannedCell {
  ensemble: string
  mood: string
  tempo_band: string
  tempo_bpm: number
  key: string
  structure: string
  texture: string
  theme: string
  length_s: number
  energy: number
  combo_key: string
  seed: number
}

/** What the planner needs to know about a song already in the pool. */
export interface ExistingCell {
  ensemble?: string; mood?: string; tempo_band?: string; key?: string; structure?: string
  texture?: string; theme?: string; combo_key?: string
}

export function hashSeed(text: string): number {
  let h = 2166136261
  for (const ch of text) { h ^= ch.codePointAt(0)!; h = Math.imul(h, 16777619) >>> 0 }
  return h >>> 0
}

function rng(seed: string) {
  let a = hashSeed(seed)
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Counts = Map<string, number>
const norm = (s: string | undefined) => (s || '').trim().toLowerCase()
const bump = (m: Counts, k: string | undefined) => { if (k) m.set(norm(k), (m.get(norm(k)) || 0) + 1) }

/** Values in "most needed first" order: lowest count/weight, seeded tie-break; weight 0 dropped. */
function order(values: Weighted[], counts: Counts, spread: boolean, rand: () => number): string[] {
  return values
    .filter(v => v.weight > 0)
    .map(v => ({ v: v.value, d: spread ? (counts.get(norm(v.value)) || 0) / v.weight : 0, r: rand() }))
    .sort((a, b) => a.d - b.d || a.r - b.r)
    .map(x => x.v)
}

/** Weighted random pick (no spreading) — used when spread_least_filled is off. */
function weightedOrder(values: Weighted[], rand: () => number): string[] {
  // Efraimidis–Spirakis: key = u^(1/w); larger first.
  return values.filter(v => v.weight > 0)
    .map(v => ({ v: v.value, k: Math.pow(rand(), 1 / v.weight) }))
    .sort((a, b) => b.k - a.k).map(x => x.v)
}

/**
 * First unused combination in rank-sum order: try (0,0,0,0,0), then every combination whose
 * ranks sum to 1, then 2 … so each axis stays as close to its most-needed value as it can.
 */
function firstFree(axes: string[][], used: Set<string>): string[] | null {
  const lens = axes.map(a => a.length)
  const maxSum = lens.reduce((s, l) => s + l - 1, 0)
  const pick: number[] = []
  const walk = (axis: number, left: number): string[] | null => {
    if (axis === axes.length) {
      if (left !== 0) return null
      const c = pick.map((p, i) => axes[i]![p]!)
      return used.has(c.map(norm).join('|')) ? null : c
    }
    for (let r = 0; r < lens[axis]! && r <= left; r++) {
      pick[axis] = r
      const hit = walk(axis + 1, left - r)
      if (hit) return hit
    }
    return null
  }
  for (let s = 0; s <= maxSum; s++) {
    const hit = walk(0, s)
    if (hit) return hit
  }
  return null
}

export function planCells(
  formula: SongFormula,
  existing: ExistingCell[],
  count: number,
  seed: string,
  themes: string[] = [],
): PlannedCell[] {
  const rand = rng(seed)
  const spread = formula.variety.spread_least_filled
  const counts = { ensemble: new Map(), mood: new Map(), band: new Map(), key: new Map(), structure: new Map(), texture: new Map(), theme: new Map() } as Record<string, Counts>
  const used = new Set<string>()
  for (const s of existing) {
    bump(counts.ensemble!, s.ensemble); bump(counts.mood!, s.mood); bump(counts.band!, s.tempo_band)
    bump(counts.key!, s.key); bump(counts.structure!, s.structure); bump(counts.texture!, s.texture); bump(counts.theme!, s.theme)
    if (s.combo_key) used.add(s.combo_key)
  }
  const total = comboCount(formula)
  const bands = formula.tempo_bands.filter(b => b.weight > 0)
  const bandWeighted = bands.map(b => ({ value: b.id, weight: b.weight }))
  const keyWeighted = formulaKeys(formula).map(k => ({ value: k, weight: 1 }))
  const minBpm = Math.min(...bands.map(b => b.min_bpm))
  const maxBpm = Math.max(...bands.map(b => b.max_bpm))
  const ord = (vals: Weighted[], c: Counts) => spread ? order(vals, c, true, rand) : weightedOrder(vals, rand)

  const out: PlannedCell[] = []
  for (let i = 0; i < Math.max(0, Math.floor(count)); i++) {
    const axes = [
      ord(formula.ensembles, counts.ensemble!),
      ord(formula.moods, counts.mood!),
      ord(bandWeighted, counts.band!),
      ord(keyWeighted, counts.key!),
      ord(formula.structures, counts.structure!),
    ]
    // Every combination used (or uniqueness switched off): start again from the most needed.
    const unique = formula.variety.unique_combos && used.size < total
    const cell = (unique ? firstFree(axes, used) : null) || axes.map(a => a[0]!)
    const [ensemble, mood, bandId, key, structure] = cell as [string, string, string, string, string]
    const band = bands.find(b => b.id === bandId)!
    const bpm = band.min_bpm + Math.floor(rand() * (band.max_bpm - band.min_bpm + 1))
    const texture = ord(formula.textures, counts.texture!)[0]!
    const theme = themes.length ? ord(themes.map(t => ({ value: t, weight: 1 })), counts.theme!)[0]! : ''
    const length = formula.length_s.min + Math.floor(rand() * (formula.length_s.max - formula.length_s.min + 1))
    const energy = maxBpm > minBpm ? 1 + Math.round((4 * (bpm - minBpm)) / (maxBpm - minBpm)) : 3
    const key5 = comboKey({ ensemble, mood, tempo_band: bandId, key, structure })
    used.add(key5)
    bump(counts.ensemble!, ensemble); bump(counts.mood!, mood); bump(counts.band!, bandId)
    bump(counts.key!, key); bump(counts.structure!, structure); bump(counts.texture!, texture); bump(counts.theme!, theme)
    out.push({
      ensemble, mood, tempo_band: bandId, tempo_bpm: bpm, key, structure, texture, theme,
      length_s: length, energy, combo_key: key5, seed: hashSeed(`${seed}:${i}:audio`),
    })
  }
  return out
}

/** Songs per (row value × column value) — the "Coverage of the pool" grid (mood × tempo band). */
export function coverageGrid(
  songs: ExistingCell[],
  rows: string[],
  cols: string[],
  rowOf: (s: ExistingCell) => string | undefined,
  colOf: (s: ExistingCell) => string | undefined,
): number[][] {
  const grid = rows.map(() => cols.map(() => 0))
  for (const s of songs) {
    const r = rows.findIndex(v => norm(v) === norm(rowOf(s)))
    const c = cols.findIndex(v => norm(v) === norm(colOf(s)))
    if (r >= 0 && c >= 0) grid[r]![c]!++
  }
  return grid
}
