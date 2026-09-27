/**
 * Reveal effects at assembly time: the episode's settings in, one planned clip per scene out.
 *
 * This is the join between the engine (`reveal-selection`, `reveal-pacing`, `reveal-render`) and
 * the video-assembly job. It exists as its own module because two callers need the *same* answer
 * and must not compute it twice: the timeline (which needs each scene's duration) and
 * `prepareSceneClips` (which needs each scene's document). The render fingerprint hashes what this
 * returns, so a changed reveal re-renders and an unchanged one reuses its clips.
 *
 * **Duration is the whole point.** A reveal plus a hold lets one image carry 10–15 s instead of the
 * uniform recycling default, and the pace band — not the layout — decides how long a scene stays.
 * Rule 4 of the design is enforced here rather than trusted: the reveal itself is never randomised
 * per scene in *length*; `planSceneHold` picks one length per scene from that scene's window.
 */

import {
  REVEAL_COHERENCE_MODES,
  defaultSceneReveal,
  normalizeSceneReveal,
  type RevealCoherence,
  type SceneRevealDocument,
} from '../contracts/scene-reveal.js'
import { BUILT_IN_SCENE_REVEALS, DEFAULT_REVEAL_POOL } from '../contracts/scene-reveal-presets.js'
import { isRevealPace, planSceneHold, type RevealHoldPlan, type RevealPace } from './reveal-pacing.js'
import { planEpisodeReveals, type RevealOverride, type RevealPlanEntry } from './reveal-selection.js'
import { listRevealPresets } from '../services/style-effect-loader.js'

/** What an episode states about reveals. Every field optional: absent means the design's default. */
export interface SceneRevealSettings {
  /** Off unless asked for. A reveal changes how an episode looks, so it is never a silent default. */
  enabled?: boolean
  /** Preset ids the episode may draw from. Empty or absent means the engine's default pool. */
  pool?: string[]
  /** The episode's seed; per-scene effects are derived from it, so a re-render is identical. */
  seed?: number
  coherence?: RevealCoherence
  pace?: RevealPace
  /** Per-preset cap per episode; `0` means no cap. */
  cap_per_effect?: number
  no_immediate_repeat?: boolean
  /** Manual per-scene choices from the UI, including rerolls. */
  overrides?: RevealOverride[]
}

export interface PlannedSceneReveal {
  scene_id: string
  scene_index: number
  preset_id: string
  document: SceneRevealDocument
  source: RevealPlanEntry['source']
  hold: RevealHoldPlan
  /** Set when the pool could not honour the rules and this is the repeat it fell back to. */
  capped_around?: string
}

export interface ResolvedSceneReveals {
  enabled: boolean
  pace: RevealPace
  seed: number
  coherence: RevealCoherence
  pool: string[]
  scenes: PlannedSceneReveal[]
  /** One duration per scene, in scene order — the same numbers the timeline must use. */
  durations: number[]
}

/** One scene as the planner needs it: identity, position, and the window it has to fill. */
export interface RevealAssemblyScene {
  scene_id: string
  scene_index: number
  act_index?: number
  /** The scene's window on the timeline, seconds. */
  window_seconds: number
  narration_seconds?: number
  /** Narration line ends and music beats this scene may snap its hold to. */
  snap?: { narration_line_ends?: number[]; beat_seconds?: number[] }
}

const DEFAULT_REVEAL_SEED = 7

function normalizeCoherence(value: unknown): RevealCoherence {
  return REVEAL_COHERENCE_MODES.includes(value as RevealCoherence)
    ? (value as RevealCoherence)
    : 'scene'
}

function normalizePool(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((id): id is string => typeof id === 'string' && !!id.trim())
    .map(id => id.trim()))]
}

/**
 * Resolve the episode's reveal settings into a plan, one entry per scene, in scene order.
 *
 * A disabled episode returns `enabled: false` with no scenes rather than an empty-looking plan:
 * a caller must be able to tell "reveals are off" from "reveals are on and planned nothing", and
 * the second is a project with no scenes.
 */
export function resolveSceneReveals(input: {
  scenes: RevealAssemblyScene[]
  settings?: SceneRevealSettings
  /** The installed reveal library; defaults to the built-ins. */
  library?: Array<{ id: string; document: SceneRevealDocument }>
}): ResolvedSceneReveals {
  const settings = input.settings ?? {}
  const pace: RevealPace = isRevealPace(settings.pace) ? settings.pace : 'standard'
  const seedValue = Number(settings.seed)
  const seed = Number.isFinite(seedValue) ? Math.trunc(seedValue) : DEFAULT_REVEAL_SEED
  const coherence = normalizeCoherence(settings.coherence)
  // The caller loads the library (built-ins plus installed packs) and passes it in; a default of
  // `listRevealPresets()` is async, and a planner that awaited one would make every caller async
  // for a list that is the same for the whole job.
  const library = input.library?.length ? input.library : BUILT_IN_SCENE_REVEALS
  const pool = normalizePool(settings.pool)

  if (!settings.enabled || input.scenes.length === 0) {
    return { enabled: false, pace, seed, coherence, pool, scenes: [], durations: [] }
  }

  const plan = planEpisodeReveals({
    scenes: input.scenes.map(scene => ({
      scene_id: scene.scene_id,
      scene_index: scene.scene_index,
      act_index: scene.act_index,
    })),
    seed,
    coherence,
    pool: { ids: pool.length ? pool : DEFAULT_REVEAL_POOL, library },
    overrides: settings.overrides,
    cap_per_effect: settings.cap_per_effect,
    no_immediate_repeat: settings.no_immediate_repeat,
  })

  const byScene = new Map(plan.map(entry => [entry.scene_id, entry]))
  const scenes: PlannedSceneReveal[] = []
  const durations: number[] = []
  for (const scene of input.scenes) {
    const entry = byScene.get(scene.scene_id)
    if (!entry) continue
    const planned = planSceneHold({
      pace,
      window_seconds: scene.window_seconds,
      narration_seconds: scene.narration_seconds,
      doc: entry.document,
      snap: scene.snap,
    })
    // **The pace never shortens a scene the plan already timed.** `planSceneHold` clamps its total
    // to the pace band, and a band's maximum is smaller than a long scene's window — a 20 s
    // narration line at a pace that tops out at 14 s would otherwise cut six seconds of narration
    // off the episode. The band is a look; the timeline is the script. The reveal keeps the length
    // the pace chose and the hold absorbs the rest.
    const hold: RevealHoldPlan = planned.total_seconds >= scene.window_seconds
      ? planned
      : {
          ...planned,
          hold_seconds: Math.max(0, scene.window_seconds - planned.reveal_seconds),
          total_seconds: scene.window_seconds,
        }
    scenes.push({
      scene_id: entry.scene_id,
      scene_index: entry.scene_index,
      preset_id: entry.preset_id,
      document: entry.document,
      source: entry.source,
      hold,
      ...(entry.capped_around ? { capped_around: entry.capped_around } : {}),
    })
    durations.push(hold.total_seconds)
  }

  return { enabled: true, pace, seed, coherence, pool, scenes, durations }
}

/**
 * The scene's planned reveal, or `undefined` when the episode has reveals off.
 *
 * Deliberately takes scene *index* rather than id: the caller inside `prepareSceneClips` walks
 * `scenes[i]` and has the index in hand, and an index-keyed lookup cannot silently match the wrong
 * scene the way a missing id would.
 */
export function plannedRevealForScene(
  plan: ResolvedSceneReveals | undefined,
  sceneIndex: number,
): PlannedSceneReveal | undefined {
  if (!plan?.enabled) return undefined
  return plan.scenes.find(scene => scene.scene_index === sceneIndex)
}

/**
 * The reveal document a scene renders with when nothing planned one.
 *
 * Used only to satisfy the renderer's type: a scene with reveals off never reaches the call, so a
 * caller that finds itself here has a bug, and the default document is the engine's own.
 */
export function fallbackRevealDocument(): SceneRevealDocument {
  return normalizeSceneReveal(defaultSceneReveal())
}

/** The preset ids an episode may choose from, with their families — for the UI's pool list. */
export async function revealPoolChoices(
  options: Parameters<typeof listRevealPresets>[0] = {},
): Promise<Array<{ id: string; name: string; family: string; description: string; approximation?: string }>> {
  const library = await listRevealPresets(options)
  return library.map(entry => ({
    id: entry.id,
    name: entry.name,
    family: entry.family,
    description: entry.description,
    ...(entry.approximation ? { approximation: entry.approximation } : {}),
  }))
}

/** The built-in library's ids, so a caller can say whether a pool entry is installed. */
export function builtInRevealIds(): string[] {
  return BUILT_IN_SCENE_REVEALS.map(entry => entry.id)
}
