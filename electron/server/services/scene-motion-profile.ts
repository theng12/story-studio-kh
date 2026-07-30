import type { SceneMotionMode, SceneMotionProfile, ScenePlanEntry } from '../models/types.js'

const MODES: SceneMotionMode[] = ['still', 'gentle', 'limited']

export interface MotionProfileAssignment {
  modes: Record<SceneMotionMode, number>
  changed: number
}

function stableNumber(input: string): number {
  let value = 2166136261
  for (let index = 0; index < input.length; index++) {
    value ^= input.charCodeAt(index)
    value = Math.imul(value, 16777619)
  }
  return value >>> 0
}

function splitTargets(total: number, shares: Record<SceneMotionMode, number>): Record<SceneMotionMode, number> {
  const raw = MODES.map(mode => ({ mode, raw: Math.max(0, shares[mode] || 0) * total / 100 }))
  const targets = Object.fromEntries(raw.map(({ mode, raw }) => [mode, Math.floor(raw)])) as Record<SceneMotionMode, number>
  let remaining = total - MODES.reduce((sum, mode) => sum + targets[mode], 0)
  raw
    .sort((a, b) => b.raw - Math.floor(b.raw) - (a.raw - Math.floor(a.raw)))
    .forEach(({ mode }) => {
      if (remaining <= 0) return
      targets[mode]++
      remaining--
    })
  return targets
}

/**
 * The profile follows a scene's semantic role before it uses a stable balance.
 * Maps, specimens and evidence views must remain still; actual phenomena may
 * receive limited animation; unclassified tableaux fill the Formula's target
 * balance deterministically, so retrying a plan never produces a different cut.
 */
export function preferredMotionMode(scene: ScenePlanEntry): SceneMotionMode | null {
  if (scene.scene_type === 'map' || scene.scene_type === 'artifact') return 'still'
  const text = `${scene.visual_prompt || ''} ${scene.transcript_segment || ''}`.toLowerCase()
  if (/\b(map|diagram|chart|timeline|cross[- ]section|specimen|fossil|skeleton|rock layer|core sample|satellite image)\b/.test(text)) return 'still'
  if (/\b(erupt(?:ion|s|ed|ing)?|volcan(?:o|ic|ism|oes)?|storm|wave|flood|migration|swimm?ing|walk(?:ing|s)?|fly(?:ing|s)?|hunt(?:ing|s)?|feeding|herd|flock|lava flow|collision)\b/.test(text)) return 'limited'
  return null
}

export function assignSceneMotionProfile(
  scenes: ScenePlanEntry[],
  profile: SceneMotionProfile,
  opts: { preserveExisting?: boolean } = {},
): MotionProfileAssignment {
  const counts: Record<SceneMotionMode, number> = { still: 0, gentle: 0, limited: 0 }
  let changed = 0
  const phases: Array<{ scenes: ScenePlanEntry[]; shares: Record<SceneMotionMode, number> }> = [
    {
      scenes: scenes.filter(scene => scene.start_sec < profile.opening_duration_sec),
      shares: profile.opening,
    },
    {
      scenes: scenes.filter(scene => scene.start_sec >= profile.opening_duration_sec),
      shares: profile.settled,
    },
  ]

  for (const phase of phases) {
    const target = splitTargets(phase.scenes.length, phase.shares)
    const assigned = new Set<ScenePlanEntry>()

    // First preserve manual / previously-generated choices and non-negotiable
    // evidence scenes. Those semantic decisions win over a ratio target.
    for (const scene of phase.scenes) {
      const existing = opts.preserveExisting ? scene.motion_mode : undefined
      const forced = preferredMotionMode(scene)
      const mode = existing || forced
      if (!mode) continue
      if (scene.motion_mode !== mode) { scene.motion_mode = mode; changed++ }
      counts[mode]++
      assigned.add(scene)
    }

    // Fill remaining target slots with the closest semantic candidates. Ties
    // use a scene-id hash, making the mix reproducible rather than random.
    const remaining = phase.scenes.filter(scene => !assigned.has(scene))
    for (const mode of MODES) {
      let slots = Math.max(0, target[mode] - phase.scenes.filter(scene => assigned.has(scene) && scene.motion_mode === mode).length)
      const candidates = remaining
        .filter(scene => !assigned.has(scene))
        .sort((a, b) => {
          const aPreference = preferredMotionMode(a) === mode ? 0 : 1
          const bPreference = preferredMotionMode(b) === mode ? 0 : 1
          return aPreference - bPreference || stableNumber(`${profile.id}:${a.id}`) - stableNumber(`${profile.id}:${b.id}`)
        })
      for (const scene of candidates) {
        if (slots <= 0) break
        if (scene.motion_mode !== mode) { scene.motion_mode = mode; changed++ }
        counts[mode]++
        assigned.add(scene)
        slots--
      }
    }
    // Rounding or semantic overages can leave a few scenes. Gentle is the
    // lowest-risk visual default for a natural-history tableau.
    for (const scene of remaining.filter(scene => !assigned.has(scene))) {
      if (scene.motion_mode !== 'gentle') { scene.motion_mode = 'gentle'; changed++ }
      counts.gentle++
      assigned.add(scene)
    }
  }
  return { modes: counts, changed }
}

export function motionModeLevel(mode: SceneMotionMode | undefined, fallback: number): number {
  if (mode === 'gentle') return 2
  if (mode === 'limited') return 3
  return fallback
}
