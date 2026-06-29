/**
 * Scripted B-Roll — the per-episode `broll_plan.json` sidecar.
 *
 * Holds the timed beats of a stock-footage video: each beat is a slice of
 * narration, the filmable search queries the shot director produced for it, and
 * (once resolved) the chosen clip + where to start within it. See
 * docs/scripted-broll-format-spec.md.
 *
 * Mirrors services/sfx-plan.ts: defensive normalize (garbage → safe, never
 * throws), explicit opt-in gate, sidecar I/O. With no plan / disabled / no
 * resolved beat, the existing Video Assembly behaviour is unchanged.
 */
import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { resolveSubfolderNames } from './utils.js'
import { findSubfolder } from '../lib/folder-resolver.js'

export const BROLL_PLAN_SIDECAR = 'broll_plan.json'

/** Where a beat's clip came from. `''` = not yet resolved. */
export type BrollSource = '' | 'pexels' | 'pixabay' | 'nasa' | 'ai-gen' | 'substitute'
export type BrollBeatStatus = 'proposed' | 'matched' | 'empty' | 'user-swapped'

export interface BrollBeat {
  start_sec: number
  end_sec: number
  /** Narration line(s) this beat covers. */
  line: string
  /** Filmable search queries — primary first, then backups. */
  queries: string[]
  source: BrollSource
  /** Pool the chosen clip lives in (when resolved into one). */
  pool_id?: string
  /** Resolved clip filename within the pool, or absolute path. `''` = unresolved. */
  clip: string
  /** Where to start within a longer clip (seconds). */
  in_point_sec: number
  status: BrollBeatStatus
}

export interface BrollPlan {
  schema_version: 1
  /** Master toggle. false (or a missing file) ⇒ assembly is unchanged. */
  enabled: boolean
  /** Channel style woven into the AI-gen fallback prompt (per-run override). */
  broll_style: string
  beats: BrollBeat[]
}

export function emptyPlan(): BrollPlan {
  return { schema_version: 1, enabled: false, broll_style: '', beats: [] }
}

// ── Defensive normalization ──────────────────────────────────────────────────

function num(v: any, fallback: number): number {
  const n = typeof v === 'number' ? v : parseFloat(v)
  return Number.isFinite(n) ? n : fallback
}
function str(v: any): string {
  return typeof v === 'string' ? v : ''
}
function source(v: any): BrollSource {
  return v === 'pexels' || v === 'pixabay' || v === 'nasa' || v === 'ai-gen' || v === 'substitute' ? v : ''
}
function status(v: any): BrollBeatStatus {
  return v === 'matched' || v === 'empty' || v === 'user-swapped' || v === 'proposed' ? v : 'proposed'
}
function strArr(v: any): string[] {
  return Array.isArray(v) ? v.map(str).map(s => s.trim()).filter(Boolean) : []
}

function normBeat(raw: any): BrollBeat | null {
  if (!raw || typeof raw !== 'object') return null
  const start = Math.max(0, num(raw.start_sec, 0))
  const end = Math.max(start, num(raw.end_sec, start))
  return {
    start_sec: start,
    end_sec: end,
    line: str(raw.line),
    queries: strArr(raw.queries),
    source: source(raw.source),
    pool_id: str(raw.pool_id) || undefined,
    clip: str(raw.clip),
    in_point_sec: Math.max(0, num(raw.in_point_sec, 0)),
    status: status(raw.status),
  }
}

/** Coerce any parsed value into a safe BrollPlan. Never throws. */
export function normalizePlan(raw: any): BrollPlan {
  if (!raw || typeof raw !== 'object') return emptyPlan()
  const beats = Array.isArray(raw.beats) ? (raw.beats.map(normBeat).filter(Boolean) as BrollBeat[]) : []
  beats.sort((a, b) => a.start_sec - b.start_sec || a.end_sec - b.end_sec)
  return { schema_version: 1, enabled: raw.enabled === true, broll_style: str(raw.broll_style), beats }
}

/** A beat is "live" only if it's resolved to a clip. */
export function isBeatLive(b: { source: BrollSource; clip: string; status: BrollBeatStatus }): boolean {
  return !!b.clip && b.source !== '' && b.status !== 'empty'
}

/** True when the plan would actually drive assembly (enabled + ≥1 live beat). */
export function planDrivesAssembly(plan: BrollPlan | null | undefined): boolean {
  if (!plan || !plan.enabled) return false
  return plan.beats.some(isBeatLive)
}

// ── Sidecar I/O ───────────────────────────────────────────────────────────────

export async function readPlanAt(filePath: string): Promise<BrollPlan | null> {
  if (!existsSync(filePath)) return null
  try {
    return normalizePlan(JSON.parse(await fs.readFile(filePath, 'utf-8')))
  } catch {
    return null
  }
}

export async function writePlanAt(filePath: string, plan: BrollPlan): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(normalizePlan(plan), null, 2) + '\n', 'utf-8')
}

export async function deletePlanAt(filePath: string): Promise<void> {
  await fs.rm(filePath, { force: true })
}

/** Sidecar path — in the episode's video-assets subfolder, mirroring resolveScenePlanPath. */
export async function resolveBrollPlanPath(slug: string, code: string, episodeDir: string): Promise<string> {
  const names = await resolveSubfolderNames(slug, code)
  const dir = (await findSubfolder(episodeDir, names.video_assets)) || path.join(episodeDir, names.video_assets)
  const canonical = path.join(dir, BROLL_PLAN_SIDECAR)
  if (existsSync(canonical)) return canonical
  const legacy = path.join(episodeDir, BROLL_PLAN_SIDECAR)
  if (existsSync(legacy)) return legacy
  return canonical
}

export async function readPlan(slug: string, code: string, episodeDir: string): Promise<BrollPlan | null> {
  return readPlanAt(await resolveBrollPlanPath(slug, code, episodeDir))
}

export async function writePlan(slug: string, code: string, episodeDir: string, plan: BrollPlan): Promise<string> {
  const p = await resolveBrollPlanPath(slug, code, episodeDir)
  await writePlanAt(p, plan)
  return p
}
