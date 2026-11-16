/**
 * Branded typography — the channel's switch, its accent pool, and which accent one episode drew.
 *
 * The switch is its OWN default-off setting (`config.branded_typography`), independent of
 * `format_pool`: turning the format pool on never enables this, and a channel that never turns it
 * on keeps the model-lettered thumbnail and its metadata title byte-identical.
 *
 * Accents are the channel's own accepted transparent PNGs, copied into
 * `<channel>/branded-typography/accents/` and referenced by a relative file name plus their sha256,
 * size and alpha flag — so the folder travels with the channel. Nothing is hard-deleted: retiring an
 * accent moves its file to this app's one Trash and records `retired_at` in the setting.
 *
 * The last-N guard reads the assignments this channel's own renders stored (one small ledger), and
 * the pick is FNV over the eligible list — the same rule the format pool uses. A pinned (or
 * `randomise: false`) choice is recorded as `pinned`, never confused with the hash.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

import {
  BRANDED_TYPOGRAPHY_DEFAULTS,
  BrandedTypographySchema,
  eligibleAccents,
  pickBrandedAccent,
  type BrandedAccent,
  type BrandedAccentPick,
  type BrandedTypography,
} from '../contracts/branded-typography.js'
import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import { moveToTrashSync, trashRootFor } from '../lib/trash-move.js'
import * as pm from './project-manager.js'

export const BRANDED_DIRNAME = 'branded-typography'
export const BRANDED_ACCENTS_SUBDIR = 'accents'
export const BRANDED_ASSIGNMENTS_FILENAME = 'assignments.json'

/** The accent cap is the contract's own list bound. */
export const BRANDED_MAX_ACCENTS = 100

export class BrandedTypographyRefusal extends Error {
  readonly statusCode = 400
  readonly expose = true
}

/** The setting in force, or null when this channel never configured it (= OFF). */
export function brandedFromConfig(config: unknown): BrandedTypography | null {
  const raw = (config as { branded_typography?: unknown } | null | undefined)?.branded_typography
  if (!raw || typeof raw !== 'object') return null
  const parsed = BrandedTypographySchema.safeParse(raw)
  // A setting that does not validate is OFF, never half-on — the same rule the format pool uses.
  return parsed.success ? parsed.data : null
}

export async function readBrandedTypography(slug: string): Promise<BrandedTypography | null> {
  const config = await pm.getConfig(slug)
  return brandedFromConfig(config)
}

export function brandedRoot(projectDir: string): string {
  return path.join(projectDir, BRANDED_DIRNAME)
}

export function brandedAccentDir(projectDir: string): string {
  return path.join(brandedRoot(projectDir), BRANDED_ACCENTS_SUBDIR)
}

export function liveAccents(settings: BrandedTypography | null): BrandedAccent[] {
  return (settings?.accents || []).filter(accent => !accent.retired_at)
}

/** The accent's absolute path. The stored file is relative to the accent folder, never a path. */
export function accentPathFor(projectDir: string, accent: Pick<BrandedAccent, 'file'>): string {
  return path.join(brandedAccentDir(projectDir), path.basename(accent.file))
}

/**
 * The last-N guard, clamped to what this channel's pool can honour.
 *
 * `N <= accents - 1` is the contract: with 3 accents and N=3 the guard would always wrap. A value
 * the pool cannot honour is reduced with a plain reason rather than silently changing behaviour.
 */
export function clampNoRepeat(
  requested: number,
  accentCount: number,
): { n: number; reason: string | null } {
  const wanted = Math.max(1, Math.floor(Number(requested) || 1))
  // A pool of one has nothing to avoid, and 0 accents is OFF anyway.
  const ceiling = Math.max(1, accentCount - 1)
  if (wanted <= ceiling) return { n: wanted, reason: null }
  return {
    n: ceiling,
    reason: accentCount <= 1
      ? `Only ${accentCount} accent${accentCount === 1 ? '' : 's'} in the pool, so the last-N guard is off.`
      : `The pool has ${accentCount} accents, so "don't repeat within the last ${wanted}" was reduced to ${ceiling}.`,
  }
}

/** One stored assignment: what this episode actually drew, and how it was chosen. */
export interface BrandedAssignment {
  accent_id: string
  member_id: string | null
  /** 'pooled' = the deterministic pick; 'pinned' = a human (or `randomise: false`) choice. */
  source: 'pooled' | 'pinned'
  at: string
}

interface AssignmentsFile {
  version: 1
  episodes: Record<string, Omit<BrandedAssignment, 'at'> & { at: string }>
}

function assignmentsPath(projectDir: string): string {
  return path.join(brandedRoot(projectDir), BRANDED_ASSIGNMENTS_FILENAME)
}

/** Every stored assignment keyed by episode code. A read never creates the file. */
export async function readBrandedAssignments(projectDir: string): Promise<Record<string, BrandedAssignment>> {
  try {
    const raw = await fs.readFile(assignmentsPath(projectDir), 'utf8')
    const parsed = JSON.parse(raw) as AssignmentsFile
    const episodes = parsed && typeof parsed === 'object' && parsed.episodes && typeof parsed.episodes === 'object'
      ? parsed.episodes
      : {}
    const out: Record<string, BrandedAssignment> = {}
    for (const [code, entry] of Object.entries(episodes)) {
      if (!entry || typeof entry !== 'object') continue
      if (typeof entry.accent_id !== 'string' || !entry.accent_id) continue
      out[code] = {
        accent_id: entry.accent_id,
        member_id: typeof entry.member_id === 'string' ? entry.member_id : null,
        source: entry.source === 'pinned' ? 'pinned' : 'pooled',
        at: typeof entry.at === 'string' ? entry.at : '',
      }
    }
    return out
  } catch {
    // An unreadable ledger is "nothing stored yet" for the guard only; the render still records its
    // own assignment below, so the next episode gets a real answer rather than an invented one.
    return {}
  }
}

/** The accents the last `n` OTHER episodes drew, oldest first, for `eligibleAccents`. */
export function recentAccentIds(
  assignments: Record<string, BrandedAssignment>,
  exceptEpisode: string,
  n: number,
): string[] {
  return Object.entries(assignments)
    .filter(([code]) => code.toUpperCase() !== exceptEpisode.toUpperCase())
    .sort((a, b) => (a[1].at < b[1].at ? -1 : a[1].at > b[1].at ? 1 : 0))
    .slice(-Math.max(0, n))
    .map(([, entry]) => entry.accent_id)
}

/**
 * Record what the episode drew. This is the "pin the manifest last" step: it runs only after the
 * branded file and its sidecar are durably on disk, and a failure here is the caller's signal to
 * write `not_branded` rather than serve a picture whose assignment nobody can account for.
 */
export async function recordBrandedAssignment(
  projectDir: string,
  episodeCode: string,
  assignment: BrandedAssignment,
): Promise<void> {
  await fs.mkdir(brandedRoot(projectDir), { recursive: true })
  const file = assignmentsPath(projectDir)
  await withLock(file, async () => {
    let current: AssignmentsFile = { version: 1, episodes: {} }
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as AssignmentsFile
      if (parsed?.version === 1 && parsed.episodes && typeof parsed.episodes === 'object') current = parsed
    } catch { /* a missing or unreadable ledger starts clean; it holds assignments only */ }
    current.episodes[episodeCode.toUpperCase()] = assignment
    await writeJsonAtomic(file, current)
  })
}

/** The accent the episode actually stored, when it is still live. */
export async function resolveEpisodeAccent(
  slug: string,
  projectDir: string,
  episodeCode: string,
  settings: BrandedTypography,
  memberId: string | null,
): Promise<{ pick: BrandedAccentPick | null; n: number; reason: string | null }> {
  const accents = liveAccents(settings)
  if (!accents.length) return { pick: null, n: 1, reason: 'This channel has no accepted accent yet.' }
  const { n, reason } = clampNoRepeat(settings.no_repeat_episodes, accents.length)
  // `randomise: false` pins the channel's first live accent — a deliberate default choice, recorded
  // as pinned so it is never read back as a hash fallback.
  const pinnedId = settings.randomise ? null : accents[0]!.id
  const recent = recentAccentIds(await readBrandedAssignments(projectDir), episodeCode, n)
  const pick = pickBrandedAccent(episodeCode, accents, recent, n, pinnedId)
  return { pick, n, reason }
}

/** Everything the settings route needs to render without touching disk twice. */
export async function brandedTypographyView(slug: string): Promise<{
  settings: BrandedTypography
  configured: boolean
  accents: BrandedAccent[]
  clamp_reason: string | null
}> {
  const settings = (await readBrandedTypography(slug)) || BRANDED_TYPOGRAPHY_DEFAULTS
  const accents = liveAccents(settings)
  const { reason } = clampNoRepeat(settings.no_repeat_episodes, accents.length)
  return { settings, configured: (await readBrandedTypography(slug)) !== null, accents, clamp_reason: reason }
}

// ── accents: add, list, retire ──────────────────────────────────────────────

/** A refused file names what was wrong with it, in the words the settings page can show. */
async function inspectAccentFile(file: string): Promise<{ sha256: string; bytes: number; width: number; height: number; hasAlpha: boolean }> {
  const stat = await fs.stat(file).catch(() => null)
  if (!stat?.isFile()) throw new BrandedTypographyRefusal('That accent is not a file Story Studio can read.')
  const bytes = await fs.readFile(file)
  let meta: { format?: string; hasAlpha?: boolean; width?: number; height?: number }
  try {
    meta = await sharp(bytes).metadata()
  } catch {
    throw new BrandedTypographyRefusal('That file is not an image Story Studio can read. Choose a PNG with a transparent background.')
  }
  if (meta.format !== 'png') {
    throw new BrandedTypographyRefusal(`That file is ${meta.format || 'an unknown format'}, not a PNG. Accents must be transparent PNGs.`)
  }
  if (!meta.hasAlpha) {
    throw new BrandedTypographyRefusal('That PNG has no transparency, so it would sit on the thumbnail as a solid rectangle. Choose a PNG with a transparent background.')
  }
  if (!meta.width || !meta.height) throw new BrandedTypographyRefusal('That PNG has no readable size.')
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
    width: meta.width,
    height: meta.height,
    hasAlpha: true,
  }
}

export interface AddedAccent { accent: BrandedAccent; replaced: boolean }

/**
 * Copy a browser-picked PNG into the channel's accent folder and add it to the setting.
 *
 * The stored file name carries its own digest, so an upload is always a new file and the same bytes
 * added twice resolve to one entry. Replacing an accent whose id is given retires the old file
 * (moved to Trash) after the setting accepts the new one.
 */
export async function addBrandedAccent(
  slug: string,
  pickedPath: string,
  label: string,
  replaceId: string | null = null,
): Promise<AddedAccent> {
  const projectDir = pm.getProjectDir(slug)
  if (!projectDir) throw new BrandedTypographyRefusal('Project not found.')
  if (typeof pickedPath !== 'string' || !pickedPath.trim()) {
    throw new BrandedTypographyRefusal('Choose a PNG file for the accent.')
  }
  const cleanLabel = String(label || '').trim() || path.basename(pickedPath, path.extname(pickedPath))
  if (cleanLabel.length > 120) throw new BrandedTypographyRefusal('An accent label can be at most 120 characters.')
  const inspected = await inspectAccentFile(pickedPath)
  const settings = (await readBrandedTypography(slug)) || { ...BRANDED_TYPOGRAPHY_DEFAULTS }
  const current = [...settings.accents]
  const existingIndex = replaceId ? current.findIndex(accent => accent.id === replaceId && !accent.retired_at) : -1
  if (replaceId && existingIndex < 0) throw new BrandedTypographyRefusal('That accent is no longer in this channel’s list. Reload the page and try again.')
  if (existingIndex < 0 && current.filter(accent => !accent.retired_at).length >= BRANDED_MAX_ACCENTS) {
    throw new BrandedTypographyRefusal(`This channel already has ${BRANDED_MAX_ACCENTS} accents — the most it can hold. Retire one before adding another.`)
  }

  const dir = brandedAccentDir(projectDir)
  await fs.mkdir(dir, { recursive: true })
  const extension = path.extname(pickedPath).toLowerCase() || '.png'
  const file = `accent-${inspected.sha256.slice(0, 16)}${extension}`
  const target = path.join(dir, file)
  if (!existsSync(target)) {
    // Content-addressed copy: the same bytes never produce a second file.
    await fs.copyFile(pickedPath, target)
  }
  const reused = current.find(accent => accent.sha256 === inspected.sha256 && !accent.retired_at && accent.id !== replaceId)
  const nextAccent: BrandedAccent = {
    id: replaceId || reused?.id || `accent-${inspected.sha256.slice(0, 12)}`,
    label: cleanLabel,
    file,
    sha256: inspected.sha256,
    width: inspected.width,
    height: inspected.height,
    has_alpha: true,
  }
  const nextAccents = existingIndex >= 0
    ? current.map((accent, index) => (index === existingIndex ? nextAccent : accent))
    : [...current, nextAccent]
  const retired = existingIndex >= 0 ? current[existingIndex]! : null
  await pm.updateConfig(slug, {
    branded_typography: { ...settings, enabled: settings.enabled, accents: nextAccents },
  })
  if (retired && retired.file !== file) {
    const retiredPath = accentPathFor(projectDir, retired)
    if (existsSync(retiredPath)) {
      moveToTrashSync(retiredPath, path.join(trashRootFor(dir, projectDir, slug), 'branded-typography'), 'branded-accent')
    }
  }
  return { accent: nextAccent, replaced: existingIndex >= 0 }
}

/** Retire an accent: the file moves to this app's Trash and the setting keeps the record. */
export async function retireBrandedAccent(slug: string, id: string): Promise<BrandedAccent> {
  const projectDir = pm.getProjectDir(slug)
  if (!projectDir) throw new BrandedTypographyRefusal('Project not found.')
  const settings = (await readBrandedTypography(slug)) || { ...BRANDED_TYPOGRAPHY_DEFAULTS }
  const index = settings.accents.findIndex(accent => accent.id === id && !accent.retired_at)
  if (index < 0) throw new BrandedTypographyRefusal('That accent is not in this channel’s list. Reload the page and try again.')
  const target = settings.accents[index]!
  const retired: BrandedAccent = { ...target, retired_at: new Date().toISOString() }
  const nextAccents = settings.accents.map((accent, i) => (i === index ? retired : accent))
  await pm.updateConfig(slug, { branded_typography: { ...settings, accents: nextAccents } })
  // A file another live accent still uses (the same bytes added under two labels) is not moved.
  if (!nextAccents.some(accent => !accent.retired_at && accent.file === target.file)) {
    const file = accentPathFor(projectDir, target)
    if (existsSync(file)) {
      const dir = brandedAccentDir(projectDir)
      moveToTrashSync(file, path.join(trashRootFor(dir, projectDir, slug), 'branded-typography'), 'branded-accent')
    }
  }
  return retired
}

/** Validate and save the whole setting. The route passes the already-parsed body. */
export async function saveBrandedTypography(slug: string, next: BrandedTypography): Promise<{ settings: BrandedTypography; clamp_reason: string | null }> {
  const parsed = BrandedTypographySchema.safeParse(next)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    throw new BrandedTypographyRefusal(
      `That branded-typography setting cannot be saved: ${first?.path.join('.') || 'value'} — ${first?.message || 'not valid'}.`,
    )
  }
  // Live accents only: a save may carry the pool's live entries; retired ones are kept as they are.
  const live = liveAccents(parsed.data)
  const { n, reason } = clampNoRepeat(parsed.data.no_repeat_episodes, live.length)
  const settings: BrandedTypography = { ...parsed.data, no_repeat_episodes: n }
  await pm.updateConfig(slug, { branded_typography: settings })
  return { settings, clamp_reason: reason }
}

/** The other, purely functional half the render needs: which accents are eligible for a test. */
export { eligibleAccents }
