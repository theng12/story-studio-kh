import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { DEFAULT_SCENE_PACING } from '../contracts/pacing.js'
import type { SceneMotionProfile } from '../models/types.js'
import { getEffectiveFormat } from './format-loader.js'

export interface ScenePlanPacing {
  min_sec: number
  max_sec: number
  mode: 'live' | 'documentary'
  opening_duration_sec?: number
  settled_min_sec?: number
  settled_max_sec?: number
}

export interface ScenePlanPacingContext {
  pacing?: ScenePlanPacing
  formula_motion_profile?: SceneMotionProfile
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

  let pacing: ScenePlanPacing = { ...DEFAULT_SCENE_PACING, mode: 'live' }
  const continuityPath = path.join(episodeDir, 'continuity.json')
  if (existsSync(continuityPath)) {
    try {
      const config = JSON.parse(await fs.readFile(continuityPath, 'utf-8'))
      const min = Number(config?.pacing?.min_sec)
      const max = Number(config?.pacing?.max_sec)
      if (Number.isFinite(min) && Number.isFinite(max) && max >= min) {
        const opening = Number(config?.pacing?.opening_duration_sec)
        const settledMin = Number(config?.pacing?.settled_min_sec)
        const settledMax = Number(config?.pacing?.settled_max_sec)
        const documentary = Number.isFinite(opening) && opening >= 0
          && Number.isFinite(settledMin) && Number.isFinite(settledMax)
          && settledMin >= 1 && settledMax >= settledMin
        pacing = {
          min_sec: min,
          max_sec: max,
          mode: documentary ? 'documentary' : 'live',
          ...(documentary ? {
            opening_duration_sec: opening,
            settled_min_sec: settledMin,
            settled_max_sec: settledMax,
          } : {}),
        }
      }
    } catch { /* preserve the continuity default */ }
    return { pacing, formula_motion_profile }
  }

  const profile = format.script.visualPacingProfile
  if (profile) {
    pacing = {
      min_sec: profile.opening.min_sec,
      max_sec: profile.opening.max_sec,
      mode: 'documentary',
      opening_duration_sec: profile.opening_duration_sec,
      settled_min_sec: profile.settled.min_sec,
      settled_max_sec: profile.settled.max_sec,
    }
  }
  return { pacing, formula_motion_profile }
}

export function allowedSubtitleCueGapSec(pacing?: Pick<ScenePlanPacing, 'max_sec'>): number {
  return Math.max(30, (pacing?.max_sec ?? 12) * 3)
}
