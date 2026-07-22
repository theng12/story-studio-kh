/**
 * SFX / Sound layer — the per-episode `sfx_plan.json` sidecar.
 *
 * This is the data backbone of the universal sound layer (see
 * docs/sfx-sound-layer-spec.md). The plan is authored by the SFX director LLM,
 * edited in the Video Assembly "Sound" section, and read by the SFX mixer at
 * final-render time.
 *
 * Safety contract (the whole feature is opt-in + reversible):
 *   - No `sfx_plan.json`, or `enabled:false`, or zero resolved cues  ⇒  the
 *     render is byte-for-byte what it is today. Nothing here ever rewrites the
 *     merged audio; the mixer produces a NEW file consumed via the renderer's
 *     existing `merged_audio_path` override.
 *   - `normalizePlan` is defensive: a malformed/partial sidecar coerces to a
 *     safe plan rather than throwing, so a bad file can never crash a render.
 *
 * The sidecar lives in the episode's merged-audio subfolder (grouped with the
 * audio it augments), resolved the same way as the scene-plan sidecar.
 */
import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { resolveSubfolderNames } from './utils.js'
import { findSubfolder } from '../lib/folder-resolver.js'

export const SFX_PLAN_SIDECAR = 'sfx_plan.json'

/**
 * How a cue's clip was sourced. Legacy external values remain readable so old
 * sidecars still assemble, but new automatic external sourcing is disabled.
 */
export type SfxSource = '' | 'pool' | 'freesound' | 'elevenlabs'

/** Lifecycle of a single cue. */
export type SfxStatus = 'proposed' | 'matched' | 'empty' | 'user-swapped' | 'muted'

/** An ambient bed — a loopable atmosphere spanning a time range, ducked low. */
export interface SfxBed {
  label: string
  start_sec: number
  end_sec: number
  source: SfxSource
  /** Pool id the clip lives in (when source==='pool' or curated back into one). */
  pool_id?: string
  /** Resolved clip filename within the pool, or absolute path. `''` = unresolved. */
  clip: string
  gain_db: number
  status: SfxStatus
}

/** A spot one-shot — a short effect anchored to a single moment. */
export interface SfxSpot {
  label: string
  at_sec: number
  source: SfxSource
  pool_id?: string
  clip: string
  gain_db: number
  status: SfxStatus
}

export interface SfxPlan {
  schema_version: 1
  /** Master toggle. false (or a missing file) ⇒ render is unchanged. */
  enabled: boolean
  beds: SfxBed[]
  spots: SfxSpot[]
}

/** Sensible default gains (dB) — VO/merged sits at 0 dB reference. */
export const DEFAULT_BED_GAIN_DB = -20
export const DEFAULT_SPOT_GAIN_DB = -12

export function emptyPlan(): SfxPlan {
  return { schema_version: 1, enabled: false, beds: [], spots: [] }
}

// ── Defensive normalization ────────────────────────────────────────────────

function num(v: any, fallback: number): number {
  const n = typeof v === 'number' ? v : parseFloat(v)
  return Number.isFinite(n) ? n : fallback
}
function clampGain(v: any, fallback: number): number {
  // Keep gains in a sane window; a corrupt huge value can't blow up the mix.
  const n = num(v, fallback)
  return Math.max(-60, Math.min(12, n))
}
function str(v: any): string {
  return typeof v === 'string' ? v : ''
}
function source(v: any): SfxSource {
  return v === 'pool' || v === 'freesound' || v === 'elevenlabs' ? v : ''
}
function status(v: any): SfxStatus {
  return v === 'matched' || v === 'empty' || v === 'user-swapped' || v === 'muted' || v === 'proposed'
    ? v
    : 'proposed'
}

function normBed(raw: any): SfxBed | null {
  if (!raw || typeof raw !== 'object') return null
  const start = Math.max(0, num(raw.start_sec, 0))
  const end = Math.max(start, num(raw.end_sec, start))
  return {
    label: str(raw.label),
    start_sec: start,
    end_sec: end,
    source: source(raw.source),
    pool_id: str(raw.pool_id) || undefined,
    clip: str(raw.clip),
    gain_db: clampGain(raw.gain_db, DEFAULT_BED_GAIN_DB),
    status: status(raw.status),
  }
}

function normSpot(raw: any): SfxSpot | null {
  if (!raw || typeof raw !== 'object') return null
  return {
    label: str(raw.label),
    at_sec: Math.max(0, num(raw.at_sec, 0)),
    source: source(raw.source),
    pool_id: str(raw.pool_id) || undefined,
    clip: str(raw.clip),
    gain_db: clampGain(raw.gain_db, DEFAULT_SPOT_GAIN_DB),
    status: status(raw.status),
  }
}

/** Coerce any parsed value into a safe SfxPlan. Never throws. */
export function normalizePlan(raw: any): SfxPlan {
  if (!raw || typeof raw !== 'object') return emptyPlan()
  const beds = Array.isArray(raw.beds) ? raw.beds.map(normBed).filter(Boolean) as SfxBed[] : []
  const spots = Array.isArray(raw.spots) ? raw.spots.map(normSpot).filter(Boolean) as SfxSpot[] : []
  // Keep beds in time order; spots in trigger order — deterministic mix.
  beds.sort((a, b) => a.start_sec - b.start_sec || a.end_sec - b.end_sec)
  spots.sort((a, b) => a.at_sec - b.at_sec)
  return { schema_version: 1, enabled: raw.enabled === true, beds, spots }
}

/** A cue is "live" only if it's resolved to a clip and not muted/empty. */
export function isCueLive(c: { source: SfxSource; clip: string; status: SfxStatus }): boolean {
  return !!c.clip && c.source !== '' && c.status !== 'muted' && c.status !== 'empty'
}

/** True when the plan would actually change the render (enabled + ≥1 live cue). */
export function planAffectsRender(plan: SfxPlan | null | undefined): boolean {
  if (!plan || !plan.enabled) return false
  return plan.beds.some(isCueLive) || plan.spots.some(isCueLive)
}

// ── Sidecar I/O ─────────────────────────────────────────────────────────────

/** Read+normalize a plan from an explicit path. Returns null if absent. */
export async function readPlanAt(filePath: string): Promise<SfxPlan | null> {
  if (!existsSync(filePath)) return null
  try {
    const raw = await fs.readFile(filePath, 'utf-8')
    return normalizePlan(JSON.parse(raw))
  } catch {
    // A corrupt sidecar must not break callers — treat as "no plan".
    return null
  }
}

/** Write a normalized plan to an explicit path (creates parent dir). */
export async function writePlanAt(filePath: string, plan: SfxPlan): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const normalized = normalizePlan(plan)
  await fs.writeFile(filePath, JSON.stringify(normalized, null, 2) + '\n', 'utf-8')
}

/** Delete the sidecar (reverts the episode to current/no-SFX behaviour). */
export async function deletePlanAt(filePath: string): Promise<void> {
  await fs.rm(filePath, { force: true })
}

/**
 * Resolve the sidecar path for an episode — in the merged-audio subfolder,
 * mirroring resolveScenePlanPath. Prefers an existing file; otherwise returns
 * the canonical location to write to.
 */
export async function resolveSfxPlanPath(slug: string, code: string, episodeDir: string): Promise<string> {
  const names = await resolveSubfolderNames(slug, code)
  const mergedDir = (await findSubfolder(episodeDir, names.merged_audio)) || path.join(episodeDir, names.merged_audio)
  const canonical = path.join(mergedDir, SFX_PLAN_SIDECAR)
  if (existsSync(canonical)) return canonical
  // Legacy/alt: episode root, for forward-compat if a caller wrote it there.
  const legacy = path.join(episodeDir, SFX_PLAN_SIDECAR)
  if (existsSync(legacy)) return legacy
  return canonical
}

export async function readPlan(slug: string, code: string, episodeDir: string): Promise<SfxPlan | null> {
  return readPlanAt(await resolveSfxPlanPath(slug, code, episodeDir))
}

export async function writePlan(slug: string, code: string, episodeDir: string, plan: SfxPlan): Promise<string> {
  const p = await resolveSfxPlanPath(slug, code, episodeDir)
  await writePlanAt(p, plan)
  return p
}
