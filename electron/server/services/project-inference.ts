/**
 * Folder-first project inference.
 *
 * When a user picks a project folder in the Import dialog, we'd rather read
 * the folder's actual structure than demand a `.story-studio-project.json`
 * manifest. The owner's multi-machine flow is "copy folder, click Import,
 * keep going"; a manifest becomes an optional hint, not a hard requirement.
 *
 * What we infer from disk:
 *   - `episode_prefix` + `episode_digits`  (e.g. "EP" × 4 from `EP0001`)
 *   - `season_prefix` + `season_size`     (e.g. "Season" × 10 from `Season 001`)
 *   - `subfolder_names`                   (reverse-engineered via classifySubfolder)
 *   - `name`, `slug`                      (from folder basename)
 *
 * We never throw — an empty or unrecognised folder returns a valid
 * `InferenceResult` populated with defaults + warnings, so the import UI can
 * still proceed with sensible starting values.
 *
 * Fields we deliberately don't try to infer:
 *   - `folder_template`  (fixed at the default — custom nesting patterns are
 *      rare enough that asking is better than guessing wrong)
 *   - `project_id`       (minted at commit time when no manifest carries one)
 *   - `youtube_channel_url`, presets, production standards — intentionally
 *      not carried across machines (see plan v2 schema).
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { DEFAULT_SUBFOLDER_NAMES } from '../models/types.js'
import type { SubfolderNames } from '../models/types.js'
import { FOLDER_PATTERN, classifySubfolder } from './episode-import.js'
import { sanitizeProjectSlug } from './slug.js'

// Season folders look like "Season 001", "Batch 02", "Volume 1" — token then
// 1-3 digits. The digits can leak for 100-season sets; this is fine for the
// owner's personal-use scope.
const SEASON_PATTERN = /^([A-Za-z]+)\s+(\d{1,3})$/

export type NeedsConfirmation =
  | { field: 'episode_prefix'; reason: 'mixed' | 'empty'; candidates?: string[] }
  | { field: 'episode_digits'; reason: 'mixed'; candidates?: number[] }
  | { field: 'season_size'; reason: 'variable'; observed_sizes?: number[] }
  | { field: 'season_prefix'; reason: 'unrecognized' | 'mixed'; observed?: string; candidates?: string[] }

export interface InferenceResult {
  ok: boolean
  name: string
  slug: string
  episode_prefix: string
  episode_digits: number
  season_size: number
  season_prefix: string
  folder_template: string
  subfolder_names: SubfolderNames
  needs_confirmation: NeedsConfirmation[]
  warnings: string[]
  error?: string
}

const DEFAULT_FOLDER_TEMPLATE = '{season_prefix} {season_num}/{code} - {title}/'

/** Slug helper — thin alias so the call sites below read naturally. */
const slugify = sanitizeProjectSlug

async function safeReaddir(dir: string): Promise<string[]> {
  try { return await fs.readdir(dir) } catch { return [] }
}

async function isDir(p: string): Promise<boolean> {
  try { return (await fs.stat(p)).isDirectory() } catch { return false }
}

function defaultsFor(name: string): InferenceResult {
  return {
    ok: true,
    name,
    slug: slugify(name),
    episode_prefix: 'EP',
    episode_digits: 4,
    season_size: 10,
    season_prefix: 'Season',
    folder_template: DEFAULT_FOLDER_TEMPLATE,
    subfolder_names: { ...DEFAULT_SUBFOLDER_NAMES },
    needs_confirmation: [],
    warnings: [],
  }
}

/**
 * Re-derive a `subfolder_names` template from the immediate children of
 * `episodeDir`. For each bucket (script, metadata, …) we look for a child
 * folder that `classifySubfolder` maps to that bucket, then substitute the
 * episode code back into a `{code}` placeholder. Buckets with no match
 * keep their DEFAULT_SUBFOLDER_NAMES template.
 */
async function inferSubfolderNames(
  episodeDir: string,
  episodeCode: string,
): Promise<{ subfolder_names: SubfolderNames; matched: number; total: number }> {
  const out: SubfolderNames = { ...DEFAULT_SUBFOLDER_NAMES }
  const bucketKeys: Array<keyof SubfolderNames> = [
    'script', 'metadata', 'scene_prompts', 'thumb_prompts',
    'images', 'thumbnails', 'audio', 'merged_audio', 'subtitles', 'video',
  ]
  const matchedBuckets = new Set<keyof SubfolderNames>()
  const entries = await fs.readdir(episodeDir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const bucket = classifySubfolder(entry.name)
    if (!bucket) continue
    // episode-import's InspectedAssets key set is the same as SubfolderNames'.
    const k = bucket as keyof SubfolderNames
    if (!bucketKeys.includes(k)) continue
    // Replace the literal episode code with the `{code}` placeholder so the
    // template works for every future episode in this project.
    const withPlaceholder = entry.name.replace(episodeCode, '{code}')
    out[k] = withPlaceholder
    matchedBuckets.add(k)
  }
  return { subfolder_names: out, matched: matchedBuckets.size, total: bucketKeys.length }
}

export async function inferProjectMetadata(folderPath: string): Promise<InferenceResult> {
  const basename = path.basename(folderPath) || 'project'
  const base = defaultsFor(basename)

  if (!path.isAbsolute(folderPath)) {
    return { ...base, ok: false, error: 'Folder path must be absolute.' }
  }
  if (!existsSync(folderPath)) {
    return { ...base, ok: false, error: 'Folder not found.' }
  }
  if (!(await isDir(folderPath))) {
    return { ...base, ok: false, error: 'Path is not a directory.' }
  }

  // ── Scan top-level entries ─────────────────────────────────────────────
  const topEntries = await fs.readdir(folderPath, { withFileTypes: true }).catch(() => [])
  const seasonDirs: Array<{ name: string; prefix: string; num: number; fullPath: string }> = []
  const rootEpisodes: Array<{ name: string; prefix: string; digits: number; fullPath: string }> = []

  for (const entry of topEntries) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('.')) continue
    const sm = entry.name.match(SEASON_PATTERN)
    if (sm) {
      seasonDirs.push({
        name: entry.name,
        prefix: sm[1]!,
        num: parseInt(sm[2]!, 10),
        fullPath: path.join(folderPath, entry.name),
      })
      continue
    }
    const em = entry.name.match(FOLDER_PATTERN)
    if (em) {
      const codeLetters = em[1]!.match(/^[A-Z]+/)?.[0] || 'EP'
      const codeDigits = em[1]!.replace(codeLetters, '').length
      rootEpisodes.push({
        name: entry.name,
        prefix: codeLetters,
        digits: codeDigits,
        fullPath: path.join(folderPath, entry.name),
      })
    }
  }

  // ── Season prefix ──────────────────────────────────────────────────────
  if (seasonDirs.length > 0) {
    const prefixCounts = new Map<string, number>()
    for (const s of seasonDirs) prefixCounts.set(s.prefix, (prefixCounts.get(s.prefix) || 0) + 1)
    const entries = [...prefixCounts.entries()].sort((a, b) => b[1] - a[1])
    const [topPrefix] = entries[0]!
    base.season_prefix = topPrefix
    if (entries.length > 1) {
      base.needs_confirmation.push({
        field: 'season_prefix',
        reason: 'mixed',
        candidates: entries.map(e => e[0]),
      })
    }
  } else if (rootEpisodes.length === 0) {
    base.warnings.push('No season or episode folders detected — using defaults (Season × 10 episodes).')
  } else {
    base.warnings.push('Episodes found at the root (no season folders) — assuming a flat layout with Season × 10 defaults.')
  }

  // ── Walk season dirs (or root if flat) for episodes ────────────────────
  const episodeBuckets: Array<{ prefix: string; digits: number; fullPath: string; name: string }> = []
  const episodesPerSeason: number[] = []

  if (seasonDirs.length > 0) {
    for (const season of seasonDirs) {
      const kids = await fs.readdir(season.fullPath, { withFileTypes: true }).catch(() => [])
      let count = 0
      for (const kid of kids) {
        if (!kid.isDirectory() || kid.name.startsWith('.')) continue
        const m = kid.name.match(FOLDER_PATTERN)
        if (!m) continue
        const letters = m[1]!.match(/^[A-Z]+/)?.[0] || 'EP'
        const digits = m[1]!.replace(letters, '').length
        episodeBuckets.push({
          prefix: letters,
          digits,
          fullPath: path.join(season.fullPath, kid.name),
          name: kid.name,
        })
        count++
      }
      if (count > 0) episodesPerSeason.push(count)
    }
  } else {
    for (const ep of rootEpisodes) {
      episodeBuckets.push({ prefix: ep.prefix, digits: ep.digits, fullPath: ep.fullPath, name: ep.name })
    }
  }

  // ── Episode prefix + digits ────────────────────────────────────────────
  if (episodeBuckets.length > 0) {
    const prefixCounts = new Map<string, number>()
    const digitCounts = new Map<number, number>()
    for (const ep of episodeBuckets) {
      prefixCounts.set(ep.prefix, (prefixCounts.get(ep.prefix) || 0) + 1)
      digitCounts.set(ep.digits, (digitCounts.get(ep.digits) || 0) + 1)
    }
    const prefixEntries = [...prefixCounts.entries()].sort((a, b) => b[1] - a[1])
    const digitEntries = [...digitCounts.entries()].sort((a, b) => b[1] - a[1])
    base.episode_prefix = prefixEntries[0]![0]
    base.episode_digits = digitEntries[0]![0]
    if (prefixEntries.length > 1) {
      base.needs_confirmation.push({
        field: 'episode_prefix',
        reason: 'mixed',
        candidates: prefixEntries.map(e => e[0]),
      })
    }
    if (digitEntries.length > 1) {
      base.needs_confirmation.push({
        field: 'episode_digits',
        reason: 'mixed',
        candidates: digitEntries.map(e => e[0]).sort((a, b) => a - b),
      })
    }
  } else {
    base.needs_confirmation.push({ field: 'episode_prefix', reason: 'empty' })
  }

  // ── Season size ────────────────────────────────────────────────────────
  if (episodesPerSeason.length >= 2) {
    const modalCount = mode(episodesPerSeason)
    base.season_size = modalCount
    const min = Math.min(...episodesPerSeason)
    const max = Math.max(...episodesPerSeason)
    // Mark ambiguous when variance is large enough that "10 episodes/season"
    // wouldn't reliably match reality. Using a ±2 window keeps the common
    // case (one short season near the current date) from triggering a
    // confirmation prompt.
    if (max - min > 2) {
      base.needs_confirmation.push({
        field: 'season_size',
        reason: 'variable',
        observed_sizes: [...episodesPerSeason].sort((a, b) => a - b),
      })
    }
  } else if (episodesPerSeason.length === 1) {
    // Single season can't tell us the target cadence; keep default.
    base.season_size = Math.max(episodesPerSeason[0]!, 1)
  }

  // ── Subfolder names ────────────────────────────────────────────────────
  if (episodeBuckets.length > 0) {
    // Pick the first episode alphabetically for deterministic inference.
    const sample = [...episodeBuckets].sort((a, b) => a.name.localeCompare(b.name))[0]!
    const sampleCode = sample.name.match(FOLDER_PATTERN)?.[1] || ''
    if (sampleCode) {
      const sub = await inferSubfolderNames(sample.fullPath, sampleCode)
      base.subfolder_names = sub.subfolder_names
      if (sub.matched === 0) {
        base.warnings.push('No recognised subfolders inside the first episode — using default subfolder names.')
      }
    }
  }

  return base
}

function mode(arr: number[]): number {
  const counts = new Map<number, number>()
  for (const n of arr) counts.set(n, (counts.get(n) || 0) + 1)
  let best = arr[0]!
  let bestCount = 0
  for (const [n, c] of counts) {
    if (c > bestCount) { best = n; bestCount = c }
  }
  return best
}
