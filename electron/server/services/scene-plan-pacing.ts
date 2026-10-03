import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import {
  DEFAULT_SCENE_PACING,
  LEGACY_SNAPSHOTLESS_REPAIR_PACING,
  parseScenePacing,
  parseSavedScenePlanPacing,
  type ScenePacing,
  type ScenePacingPeriod,
} from '../contracts/pacing.js'
import type { SceneMotionProfile } from '../models/types.js'
import { getEffectiveFormat } from './format-loader.js'
import { readProjectStartingPacing } from './formula-starting-defaults.js'

export interface ScenePlanPacing {
  min_sec: number
  max_sec: number
  mode: 'live' | 'documentary' | 'variable'
  periods?: ScenePacingPeriod[]
  opening_duration_sec?: number
  settled_min_sec?: number
  settled_max_sec?: number
}

export interface ScenePlanPacingContext {
  pacing?: ScenePlanPacing
  formula_motion_profile?: SceneMotionProfile
}

export interface ScenePlanRepairPacing {
  min_sec: number
  max_sec: number
  pacing?: ScenePacing
}

/** Existing plans own their saved timing. A plan from before pacing snapshots
 * may use an explicitly saved episode draft, but that draft is parsed through
 * the same strict contract as new planning. Only a genuinely absent pacing
 * field keeps the historical 3–12 repair band. */
export function resolveScenePlanRepairPacing(
  savedPlanPacing: unknown,
  continuityText?: string,
): ScenePlanRepairPacing {
  if (savedPlanPacing !== undefined) {
    const pacing = parseSavedScenePlanPacing(savedPlanPacing)
    return { pacing, min_sec: pacing.min_sec, max_sec: pacing.max_sec }
  }
  if (continuityText === undefined) return { ...LEGACY_SNAPSHOTLESS_REPAIR_PACING }

  let config: unknown
  try {
    config = JSON.parse(continuityText)
  } catch (error) {
    throw new Error(`continuity.json: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('continuity.json must contain an object')
  }
  const source = config as Record<string, unknown>
  if (!Object.prototype.hasOwnProperty.call(source, 'pacing')) return { ...LEGACY_SNAPSHOTLESS_REPAIR_PACING }
  const pacing = parseScenePacing(source.pacing)
  return { pacing, min_sec: pacing.min_sec, max_sec: pacing.max_sec }
}

/** The same pacing decision used by Scene Plan generation and readiness. */
export async function resolveScenePlanPacing(
  slug: string,
  episodeDir: string,
  resolvedFormat?: Awaited<ReturnType<typeof getEffectiveFormat>>,
): Promise<ScenePlanPacingContext> {
  const format = resolvedFormat ?? await getEffectiveFormat(slug)
  const formula_motion_profile = format?.script.motionProfile
  if (format?.visualSource !== 'continuity-chain') return { formula_motion_profile }

  // No saved episode pacing: the channel's starting pacing (set from its
  // Formula at creation), else the one app-wide default.
  let pacing: ScenePlanPacing = scenePlanPacing(await readProjectStartingPacing(slug) ?? { ...DEFAULT_SCENE_PACING })
  const continuityPath = path.join(episodeDir, 'continuity.json')
  if (existsSync(continuityPath)) {
    try {
      const config = JSON.parse(await fs.readFile(continuityPath, 'utf-8'))
      pacing = scenePlanPacing(parseScenePacing(config?.pacing))
    } catch (error) {
      throw new Error(`continuity.json: ${error instanceof Error ? error.message : String(error)}`)
    }
    return { pacing, formula_motion_profile }
  }
  return { pacing, formula_motion_profile }
}

function scenePlanPacing(pacing: ScenePacing): ScenePlanPacing {
  if (pacing.mode !== 'variable') {
    return { min_sec: pacing.min_sec, max_sec: pacing.max_sec, mode: 'live' }
  }
  const legacy = pacing.opening_duration_sec !== undefined
  return {
    min_sec: pacing.min_sec,
    max_sec: pacing.max_sec,
    mode: legacy ? 'documentary' : 'variable',
    periods: pacing.periods,
    ...(legacy ? {
      opening_duration_sec: pacing.opening_duration_sec,
      settled_min_sec: pacing.settled_min_sec,
      settled_max_sec: pacing.settled_max_sec,
    } : {}),
  }
}

export function allowedSubtitleCueGapSec(): number {
  return 30
}
