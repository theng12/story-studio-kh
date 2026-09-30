/**
 * Reveal selection — which reveal each scene gets, and why it is the same one
 * every time.
 *
 * The design's rules, and what each one is for:
 *
 * 1. **Seed per episode, derive per scene.** One seed on the episode; a scene's
 *    effect comes from `deriveSeed(seed, scene_index)`. Reproducible by
 *    construction: re-rendering an episode gives the identical result, and a
 *    per-scene reroll moves *one* scene instead of resequencing the rest.
 * 2. **Draw from an enabled pool**, never from everything in the library.
 * 3. **No immediate repeats, and a cap per effect.** The same reveal twice in a
 *    row reads as a mistake rather than a choice; a cap stops one striking
 *    effect from becoming the episode's whole vocabulary.
 * 4. **Randomise the look, never the duration.** Only the preset is picked
 *    here; the length comes from the script and the pace (`reveal-pacing.ts`).
 * 5. **Per-scene reroll**, without disturbing any other scene.
 * 6. **Derived by default, stored only when overridden.**
 * 7. **Coherence modes:** per scene (default), per act (one look per group,
 *    changing at act boundaries — usually the most professional), or fixed
 *    (one effect for the episode).
 */

import {
  normalizeSceneReveal,
  type SceneRevealDocument,
} from '../contracts/scene-reveal.js'
import {
  BUILT_IN_SCENE_REVEALS,
  DEFAULT_REVEAL_ID,
  DEFAULT_REVEAL_POOL,
  builtInReveal,
} from '../contracts/scene-reveal-presets.js'
import { deriveSeed, mulberry32 } from './seeded-random.js'
import type { RevealCoherence } from '../contracts/scene-reveal.js'
import type { RevealPace } from './reveal-pacing.js'

export interface RevealSceneInput {
  /** Stable scene identity, used for the derived seed and for overrides. */
  scene_id: string
  /** Zero-based position, which is what the seed derivation uses. */
  scene_index: number
  /**
   * The act this scene belongs to, for the `act` coherence mode.
   *
   * Optional: a project with no acts is one act, and the mode then behaves like
   * `fixed` — which is the honest reading of "one look per group" when there is
   * only one group.
   */
  act_index?: number
}

export interface RevealOverride {
  scene_id: string
  preset_id: string
  /** Bumped by a reroll so the override is a *new* choice, not the old one. */
  reroll?: number
  document?: SceneRevealDocument
}

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

export interface RevealPlanEntry {
  scene_id: string
  scene_index: number
  preset_id: string
  /** The document that will be compiled — the preset's, or the override's. */
  document: SceneRevealDocument
  /** Where this choice came from. `derived` recomputes; `override` is stored. */
  source: 'derived' | 'override'
  /** Set when the pool could not honour the rules and this is the fallback. */
  capped_around?: string
}

export interface RevealPool {
  /** Preset ids the episode may draw from. Empty means the default pool. */
  ids: string[]
  /** The installed library the ids are resolved against; defaults to built-ins. */
  library?: Array<{ id: string; document: SceneRevealDocument }>
}

function resolvePool(pool: RevealPool | undefined): Array<{ id: string; document: SceneRevealDocument }> {
  const library = pool?.library?.length ? pool.library : BUILT_IN_SCENE_REVEALS
  const ids = (pool?.ids?.length ? pool.ids : DEFAULT_REVEAL_POOL)
    .filter(id => library.some(entry => entry.id === id))
  const effective = ids.length ? ids : [DEFAULT_REVEAL_ID]
  return effective.map(id => {
    const entry = library.find(candidate => candidate.id === id)!
    return { id, document: normalizeSceneReveal(entry.document) }
  })
}

/**
 * The pick for one scene.
 *
 * `rand` is advanced exactly once per scene regardless of how many candidates
 * are rejected — that is what keeps the sequence stable when a cap or a repeat
 * rejects a candidate: the *stream position* depends only on the scene index.
 * Drawing again after a rejection would make scene 7's pick depend on scene 6's
 * cap, and a reroll of scene 6 would silently resequence the episode.
 */
function pickForScene(
  candidates: Array<{ id: string; document: SceneRevealDocument }>,
  rand: () => number,
  history: { previousId: string | null; counts: Map<string, number> },
  rules: { noImmediate: boolean; cap: number },
): { id: string; document: SceneRevealDocument; cappedAround?: string } {
  const draw = rand()
  const start = Math.floor(draw * candidates.length) % candidates.length
  for (let step = 0; step < candidates.length; step++) {
    const candidate = candidates[(start + step) % candidates.length]!
    const count = history.counts.get(candidate.id) ?? 0
    if (rules.noImmediate && candidate.id === history.previousId && candidates.length > 1) continue
    if (rules.cap > 0 && count >= rules.cap) continue
    return { id: candidate.id, document: candidate.document }
  }
  // Every candidate is capped out or is the previous one. The rules are a
  // preference about *look*, and a scene with no reveal at all is worse than a
  // repeat — so the pick falls back to the drawn candidate, and says so.
  const fallback = candidates[start]!
  return { id: fallback.id, document: fallback.document, cappedAround: fallback.id }
}

/**
 * Plan every scene's reveal.
 *
 * Deterministic given `(seed, pool, scenes, overrides)`. The plan is the single
 * source the renderer, the fingerprint and the UI all read, so a retry renders
 * the same episode without anything being persisted for it.
 */
export function planEpisodeReveals(input: {
  scenes: RevealSceneInput[]
  seed: number
  coherence: RevealCoherence
  /** Preset-level policy; the first scene's document decides the episode's. */
  pool?: RevealPool
  overrides?: RevealOverride[]
  /** Per-preset cap; `0` means no cap. */
  cap_per_effect?: number
  no_immediate_repeat?: boolean
}): RevealPlanEntry[] {
  const candidates = resolvePool(input.pool)
  const overrides = new Map((input.overrides ?? []).map(entry => [entry.scene_id, entry]))
  const rules = {
    noImmediate: input.no_immediate_repeat !== false,
    cap: Math.max(0, Math.round(input.cap_per_effect ?? 0)),
  }

  const entries: RevealPlanEntry[] = []
  const counts = new Map<string, number>()
  let previousId: string | null = null
  /** In `act` coherence the act's first scene picks, and the rest inherit. */
  let actPick: { id: string; document: SceneRevealDocument } | null = null
  let actOfPick: number | undefined
  /** In `episode` coherence the first scene picks for the whole episode. */
  let episodePick: { id: string; document: SceneRevealDocument } | null = null

  for (const scene of input.scenes) {
    const override = overrides.get(scene.scene_id)
    if (override) {
      const preset = candidates.find(entry => entry.id === override.preset_id)
        ?? builtInReveal(override.preset_id)
      const document = override.document
        ? normalizeSceneReveal(override.document)
        : normalizeSceneReveal(preset?.document ?? builtInReveal(DEFAULT_REVEAL_ID)!.document)
      entries.push({
        scene_id: scene.scene_id,
        scene_index: scene.scene_index,
        preset_id: override.preset_id,
        document,
        source: 'override',
      })
      counts.set(override.preset_id, (counts.get(override.preset_id) ?? 0) + 1)
      previousId = override.preset_id
      if (input.coherence === 'episode' && !episodePick) {
        episodePick = { id: override.preset_id, document }
      }
      if (input.coherence === 'act' && actOfPick === undefined) {
        actOfPick = scene.act_index
        actPick = { id: override.preset_id, document }
      }
      continue
    }

    // Coherence: one look per act, or one for the episode, decided by the first
    // scene in the group and then inherited.
    if (input.coherence === 'episode' && episodePick) {
      entries.push({
        scene_id: scene.scene_id, scene_index: scene.scene_index,
        preset_id: episodePick.id, document: episodePick.document, source: 'derived',
      })
      counts.set(episodePick.id, (counts.get(episodePick.id) ?? 0) + 1)
      previousId = episodePick.id
      continue
    }
    if (input.coherence === 'act' && actPick && actOfPick === scene.act_index) {
      entries.push({
        scene_id: scene.scene_id, scene_index: scene.scene_index,
        preset_id: actPick.id, document: actPick.document, source: 'derived',
      })
      counts.set(actPick.id, (counts.get(actPick.id) ?? 0) + 1)
      previousId = actPick.id
      continue
    }

    // A cap is per pass, not per episode: when every candidate in the pool has
    // reached it, the pool starts again. The alternative — refusing to draw —
    // would either repeat one effect for the rest of the episode or leave scenes
    // with no reveal at all, and both are worse than a second pass that still
    // obeys the no-immediate-repeat rule.
    let passRestarted = false
    if (rules.cap > 0 && candidates.every(candidate => (counts.get(candidate.id) ?? 0) >= rules.cap)) {
      counts.clear()
      passRestarted = true
    }
    const rand = mulberry32(deriveSeed(input.seed, 'reveal', scene.scene_index))
    const pick = pickForScene(candidates, rand, { previousId, counts }, rules)
    counts.set(pick.id, (counts.get(pick.id) ?? 0) + 1)
    previousId = pick.id
    if (input.coherence === 'episode') episodePick = { id: pick.id, document: pick.document }
    if (input.coherence === 'act') {
      actOfPick = scene.act_index
      actPick = { id: pick.id, document: pick.document }
    }
    entries.push({
      scene_id: scene.scene_id,
      scene_index: scene.scene_index,
      preset_id: pick.id,
      document: pick.document,
      source: 'derived',
      ...(pick.cappedAround || passRestarted ? { capped_around: pick.id } : {}),
    })
  }
  return entries
}

/**
 * Reroll one scene.
 *
 * The reroll is a new *choice*, not a new sequence: it advances the scene's own
 * derived stream past the current pick, so rerolling scene 4 leaves scenes 5+
 * exactly as they were. That is the whole reason the derivation is per scene
 * rather than one generator walked across the episode.
 */
export function rerollSceneReveal(input: {
  scenes: RevealSceneInput[]
  seed: number
  coherence: RevealCoherence
  scene_id: string
  current_preset_id: string
  pool?: RevealPool
  cap_per_effect?: number
  no_immediate_repeat?: boolean
  /** Which occurrence of the scene's stream to take; the UI bumps this. */
  reroll?: number
}): RevealPlanEntry | null {
  const scene = input.scenes.find(entry => entry.scene_id === input.scene_id)
  if (!scene) return null
  const candidates = resolvePool(input.pool)
  if (candidates.length <= 1) return null

  const rand = mulberry32(deriveSeed(input.seed, 'reveal', scene.scene_index))
  const attempts = Math.max(1, Math.round(input.reroll ?? 1))
  // Walk the same stream the plan walked, then keep going: the first draw is
  // the scene's derived pick, so a reroll must start after it.
  let pick = pickForScene(candidates, rand, { previousId: null, counts: new Map() }, { noImmediate: false, cap: 0 })
  for (let i = 0; i < attempts; i++) {
    pick = pickForScene(candidates, rand, { previousId: pick.id, counts: new Map() }, {
      noImmediate: true,
      cap: Math.max(0, Math.round(input.cap_per_effect ?? 0)),
    })
    if (pick.id !== input.current_preset_id) break
  }
  return {
    scene_id: scene.scene_id,
    scene_index: scene.scene_index,
    preset_id: pick.id,
    document: pick.document,
    source: 'override',
  }
}
