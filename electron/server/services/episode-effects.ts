/**
 * Per-episode effect stacks — the Effects Library's own file.
 *
 * Why a sidecar and not Video Assembly's `scene_effects`: that list lives in
 * the Effects PRESET, which is reusable across episodes by design (AGENTS.md
 * §5). "Rain on scene 4" names one episode's scene, so it is episode state and
 * belongs beside that episode's `scene_plan.json`, the same way approved
 * contextual cues do. The render reads it at preflight, so a Pipeline batch and
 * a single render behave the same.
 *
 *   <episode>/scene_effects.json
 *   {
 *     "schema_version": 1,
 *     "custom_order": false,           // false = render in layer groups
 *     "episode": [AppliedEffect…],     // the whole episode
 *     "themes":  [{ "theme": "rainy", "effects": [AppliedEffect…] }],
 *     "scenes":  [{ "scene_id": "s4", "effects": [AppliedEffect…] }]
 *   }
 *
 * An AppliedEffect is a library id plus the fields the owner changed — never a
 * frozen document — exactly like Video Assembly's list, so improving a built-in
 * reaches every episode that chose it.
 */

import fs from 'fs/promises'
import path from 'path'
import { existsSync } from 'fs'

import {
  EFFECT_STACK_GROUPS,
  LIBRARY_V1_5_KINDS,
  isSceneStageOverlay,
  normalizeSceneOverlay,
  overlayStackGroup,
  type EffectStackGroup,
  type SceneOverlayDocument,
} from '../contracts/scene-effects.js'
import { isContentPackItemId } from '../contracts/content-origin.js'
import { BUILT_IN_EFFECT_STACKS, type BuiltInOverlay, type EffectStackItem, type UnavailableOverlay } from '../contracts/scene-effect-presets.js'
import { writeJsonAtomic } from '../lib/atomic-store.js'
import { EFFECT_SCOPE_ORDER_BASE } from '../contracts/effect-params.js'

export const EPISODE_EFFECTS_FILENAME = 'scene_effects.json'
export const EPISODE_EFFECTS_SCHEMA_VERSION = 1

/** Starting fade for an effect on one scene: the length of a typical scene crossfade. */
export const DEFAULT_SCENE_FADE_SEC = 2

export interface AppliedEffect {
  /** Stable per-instance id, so the same effect can sit twice in one stack. */
  uid: string
  /** Library id (`rain`, `vignette-soft`, or a content-pack id). */
  id: string
  enabled: boolean
  params?: Record<string, unknown>
  /** Fade in from the start of its window. Scene effects default to {@link DEFAULT_SCENE_FADE_SEC}. */
  fade_in_sec?: number
  fade_out_sec?: number
  /**
   * Position in the stack, shared across scopes so "Custom order" can place a
   * scene's rain under the episode's fog. Absent = after everything placed so
   * far in its own list (whole episode first, then themes, then scenes).
   */
  order?: number
}

export interface EpisodeEffectsFile {
  schema_version: typeof EPISODE_EFFECTS_SCHEMA_VERSION
  updated_at: string | null
  custom_order: boolean
  episode: AppliedEffect[]
  themes: Array<{ theme: string; effects: AppliedEffect[] }>
  scenes: Array<{ scene_id: string; effects: AppliedEffect[] }>
}

export function emptyEpisodeEffects(): EpisodeEffectsFile {
  return { schema_version: EPISODE_EFFECTS_SCHEMA_VERSION, updated_at: null, custom_order: false, episode: [], themes: [], scenes: [] }
}

const ID = /^[A-Za-z0-9._-]{1,160}$/
const MAX_PER_STACK = 24

function clampFade(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  const n = Number(value)
  if (!Number.isFinite(n)) return undefined
  return Math.max(0, Math.min(60, n))
}

function normalizeApplied(list: unknown): AppliedEffect[] {
  if (!Array.isArray(list)) return []
  const out: AppliedEffect[] = []
  const seen = new Set<string>()
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    if (typeof r.id !== 'string' || !ID.test(r.id)) continue
    let uid = typeof r.uid === 'string' && ID.test(r.uid) ? r.uid : `${r.id}-${out.length + 1}`
    while (seen.has(uid)) uid = `${uid}x`
    seen.add(uid)
    const params = r.params && typeof r.params === 'object' && !Array.isArray(r.params)
      ? { ...(r.params as Record<string, unknown>) }
      : undefined
    // Timing is decided by where the effect sits, never by a stored window.
    if (params) delete params.timing
    out.push({
      uid,
      id: r.id,
      enabled: r.enabled !== false,
      ...(params ? { params } : {}),
      ...(clampFade(r.fade_in_sec) !== undefined ? { fade_in_sec: clampFade(r.fade_in_sec) } : {}),
      ...(clampFade(r.fade_out_sec) !== undefined ? { fade_out_sec: clampFade(r.fade_out_sec) } : {}),
      ...(typeof r.order === 'number' && Number.isFinite(r.order) ? { order: Math.max(-1e6, Math.min(1e6, r.order)) } : {}),
    })
    if (out.length >= MAX_PER_STACK) break
  }
  return out
}

/** Lenient read of whatever is on disk. Never throws. */
export function normalizeEpisodeEffects(input: unknown): EpisodeEffectsFile {
  const s = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const themes = Array.isArray(s.themes) ? s.themes : []
  const scenes = Array.isArray(s.scenes) ? s.scenes : []
  return {
    schema_version: EPISODE_EFFECTS_SCHEMA_VERSION,
    updated_at: typeof s.updated_at === 'string' ? s.updated_at : null,
    custom_order: s.custom_order === true,
    episode: normalizeApplied(s.episode),
    themes: themes
      .filter((t: any) => t && typeof t.theme === 'string' && t.theme.trim())
      .map((t: any) => ({ theme: String(t.theme).trim().slice(0, 80), effects: normalizeApplied(t.effects) }))
      .filter(t => t.effects.length),
    scenes: scenes
      .filter((t: any) => t && typeof t.scene_id === 'string' && ID.test(t.scene_id))
      .map((t: any) => ({ scene_id: String(t.scene_id), effects: normalizeApplied(t.effects) }))
      .filter(t => t.effects.length),
  }
}

export function episodeEffectsPath(episodeDir: string): string {
  return path.join(episodeDir, EPISODE_EFFECTS_FILENAME)
}

export async function readEpisodeEffects(episodeDir: string): Promise<EpisodeEffectsFile> {
  const file = episodeEffectsPath(episodeDir)
  if (!existsSync(file)) return emptyEpisodeEffects()
  try {
    return normalizeEpisodeEffects(JSON.parse(await fs.readFile(file, 'utf8')))
  } catch {
    // Unreadable is reported by the route that shows it; a render treats it as
    // "no episode effects" only after saying so (see the generator).
    throw new Error(`${EPISODE_EFFECTS_FILENAME} in this episode could not be read. Open the Effects Library and save the stack again.`)
  }
}

export async function writeEpisodeEffects(episodeDir: string, input: unknown): Promise<EpisodeEffectsFile> {
  const normalized = { ...normalizeEpisodeEffects(input), updated_at: new Date().toISOString() }
  await writeJsonAtomic(episodeEffectsPath(episodeDir), normalized)
  return normalized
}

export function episodeEffectsCount(file: EpisodeEffectsFile): number {
  return file.episode.length + file.themes.reduce((n, t) => n + t.effects.length, 0)
    + file.scenes.reduce((n, t) => n + t.effects.length, 0)
}

// ═══════════════════════════════════════════════════════════════════════════
// Resolving a stack for a render
// ═══════════════════════════════════════════════════════════════════════════

/** Where one scene sits in the COMPOSED video, in seconds. */
export interface SceneWindow {
  scene_id: string
  start_sec: number
  end_sec: number
  theme?: string | null
}

export type StackScope = 'project' | 'episode' | 'theme' | 'scene'

export interface ResolvedStackEntry {
  uid: string
  /** Stack position; see `AppliedEffect.order`. */
  order: number
  id: string
  name: string
  approximation?: string
  scope: StackScope
  /** Scene id or theme the entry came from, for the job log. */
  scope_label?: string
  group: EffectStackGroup
  document: SceneOverlayDocument
}

export interface ResolvedEpisodeStack {
  entries: ResolvedStackEntry[]
  unavailable: UnavailableOverlay[]
  /** Plain-English notes for the job log: skipped scenes, merged theme runs. */
  notes: string[]
  custom_order: boolean
}

function resolveDocument(applied: AppliedEffect, library: readonly BuiltInOverlay[]): { entry: BuiltInOverlay; doc: SceneOverlayDocument } | null {
  const entry = library.find(candidate => candidate.id === applied.id)
  if (!entry) return null
  const doc = applied.params
    ? normalizeSceneOverlay({ ...entry.document, ...applied.params, kind: entry.document.kind, timing: entry.document.timing })
    : entry.document
  return { entry, doc }
}

/** Merge consecutive windows that touch, so a theme run fades once, not at every cut. */
function mergeWindows(windows: SceneWindow[]): Array<{ start: number; end: number; ids: string[] }> {
  const sorted = [...windows].sort((a, b) => a.start_sec - b.start_sec)
  const out: Array<{ start: number; end: number; ids: string[] }> = []
  for (const w of sorted) {
    const last = out[out.length - 1]
    if (last && w.start_sec - last.end <= 0.5) {
      last.end = Math.max(last.end, w.end_sec)
      last.ids.push(w.scene_id)
    } else {
      out.push({ start: w.start_sec, end: w.end_sec, ids: [w.scene_id] })
    }
  }
  return out
}

/**
 * Turn the project look's new-kind effects, the episode file and the scene
 * windows into one ordered list of finished documents with their live windows.
 *
 * A scene effect's window is the scene's window widened by half its fade on
 * each side, so the fade straddles the cut the way a crossfade does. Effects
 * render group by group (grade → atmosphere → weather → particles → light →
 * lens → overlays) unless the episode turned on Custom order.
 */
export function resolveEpisodeEffectStack(opts: {
  file: EpisodeEffectsFile
  library: readonly BuiltInOverlay[]
  windows: readonly SceneWindow[]
  /** Video Assembly's own effect list (the reusable look). Only its v1.5 kinds join this stack. */
  projectLook?: Array<{ id: string; enabled?: boolean; params?: Record<string, unknown> }>
  /** Seconds of picture; bounds an open window. */
  duration: number
}): ResolvedEpisodeStack {
  const { file, library, windows, duration } = opts
  const entries: ResolvedStackEntry[] = []
  const unavailable: UnavailableOverlay[] = []
  const notes: string[] = []
  const missing = (id: string) => {
    if (!unavailable.some(u => u.id === id)) unavailable.push({ id, from_content_pack: isContentPackItemId(id) })
  }
  const SCOPE_BASE: Record<StackScope, number> = EFFECT_SCOPE_ORDER_BASE
  const push = (applied: AppliedEffect, scope: StackScope, window: { start: number; end: number | null } | null, label?: string, index = 0) => {
    if (!applied.enabled) return
    const resolved = resolveDocument(applied, library)
    if (!resolved) { missing(applied.id); return }
    const { entry, doc } = resolved
    // Living pictures and outlined effects are drawn on their scene's clip
    // (`resolveSceneStage`), never on the composed timeline.
    if (isSceneStageOverlay(doc)) {
      if (scope !== 'scene') notes.push(`${entry.name} skipped ${scope === 'theme' ? `for theme "${label}"` : `on the ${scope}`}: an outline belongs to one scene's picture, so it only works in a single scene's stack.`)
      return
    }
    const defaultFade = scope === 'scene' || scope === 'theme' ? DEFAULT_SCENE_FADE_SEC : 0
    const fi = applied.fade_in_sec ?? defaultFade
    const fo = applied.fade_out_sec ?? defaultFade
    const timing = window
      ? {
          start_sec: Math.max(0, window.start - fi / 2),
          end_sec: window.end === null ? null : Math.min(duration, window.end + fo / 2),
          fade_in_sec: window.start - fi / 2 <= 0 ? Math.max(0, fi / 2 + window.start) : fi,
          fade_out_sec: fo,
        }
      : { ...doc.timing, fade_in_sec: fi, fade_out_sec: fo }
    entries.push({
      uid: applied.uid,
      order: applied.order ?? SCOPE_BASE[scope] + index,
      id: entry.id,
      name: entry.name,
      ...(entry.approximation ? { approximation: entry.approximation } : {}),
      scope,
      ...(label ? { scope_label: label } : {}),
      group: overlayStackGroup(doc),
      document: normalizeSceneOverlay({ ...doc, timing }),
    })
  }

  // 1. The project look's new-kind effects (rain on every episode of a channel).
  for (const [i, item] of (opts.projectLook || []).entries()) {
    if (!item || item.enabled === false) continue
    const found = library.find(candidate => candidate.id === item.id)
    // Older kinds keep rendering where they always did; unknown ids are the
    // generator's existing business.
    if (!found || !LIBRARY_V1_5_KINDS.includes(found.document.kind)) continue
    push({ uid: `project-${i + 1}`, id: item.id, enabled: true, ...(item.params ? { params: item.params } : {}) }, 'project', null, undefined, i)
  }
  // 2. This episode, whole.
  file.episode.forEach((applied, i) => push(applied, 'episode', null, undefined, i))
  // 3. Every scene of a theme, consecutive scenes merged into one window.
  for (const rule of file.themes) {
    const matching = windows.filter(w => (w.theme || '').trim().toLowerCase() === rule.theme.toLowerCase())
    if (!matching.length) {
      notes.push(`Theme "${rule.theme}" effects skipped: no scene in this episode has that theme.`)
      continue
    }
    for (const run of mergeWindows(matching)) {
      rule.effects.forEach((applied, i) => push(applied, 'theme', { start: run.start, end: run.end }, rule.theme, i))
    }
  }
  // 4. One scene.
  for (const stack of file.scenes) {
    const window = windows.find(w => w.scene_id === stack.scene_id)
    if (!window) {
      notes.push(`Effects for scene "${stack.scene_id}" skipped: that scene is no longer in this episode's Scene Plan.`)
      continue
    }
    stack.effects.forEach((applied, i) => push(applied, 'scene', { start: window.start_sec, end: window.end_sec }, stack.scene_id, i))
  }

  // Layer groups first (unless Custom order), then the arranged order; stable.
  const rank = (group: EffectStackGroup) => file.custom_order ? 0 : EFFECT_STACK_GROUPS.indexOf(group)
  const indexed = entries.map((entry, index) => ({ entry, index }))
  indexed.sort((a, b) => rank(a.entry.group) - rank(b.entry.group) || a.entry.order - b.entry.order || a.index - b.index)
  entries.splice(0, entries.length, ...indexed.map(i => i.entry))
  return { entries, unavailable, notes, custom_order: file.custom_order }
}

/**
 * The scene-stage effects of each scene (living pictures, effects clipped to an
 * outline), in stack order. Only single-scene stacks can carry them.
 */
export function resolveSceneStage(file: EpisodeEffectsFile, library: readonly BuiltInOverlay[]): Map<string, Array<{ uid: string; name: string; document: SceneOverlayDocument }>> {
  const out = new Map<string, Array<{ uid: string; name: string; document: SceneOverlayDocument }>>()
  for (const stack of file.scenes) {
    const items = stack.effects
      .map((applied, index) => ({ applied, index }))
      .filter(({ applied }) => applied.enabled)
      .map(({ applied, index }) => ({ applied, index, resolved: resolveDocument(applied, library) }))
      .filter(({ resolved }) => resolved && isSceneStageOverlay(resolved.doc))
      .map(({ applied, index, resolved }) => ({
        rank: file.custom_order ? 0 : EFFECT_STACK_GROUPS.indexOf(overlayStackGroup(resolved!.doc)),
        order: applied.order ?? index,
        item: {
          uid: applied.uid,
          name: resolved!.doc.kind === 'living-region' ? `${resolved!.entry.name} (${resolved!.doc.motion})` : resolved!.entry.name,
          document: resolved!.doc,
        },
      }))
      .sort((a, b) => a.rank - b.rank || a.order - b.order)
      .map(x => x.item)
    if (items.length) out.set(stack.scene_id, [...(out.get(stack.scene_id) || []), ...items])
  }
  return out
}

/** Groups drawn under the classic vignette / grain / letterbox controls; the rest go over them. */
export function isLowerStackGroup(group: EffectStackGroup): boolean {
  return group !== 'lens' && group !== 'overlays'
}

// ═══════════════════════════════════════════════════════════════════════════
// A channel's starting look
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The effects of the named stack presets, in order: built-in stacks
 * (`stack-rainy-night`…) and the project's saved ones (`config.effect_stack_presets`,
 * the Effects Library's "Save as Preset"). Unknown ids are returned so the
 * caller can say which look is gone.
 */
export function effectsForLook(
  lookIds: readonly string[],
  savedPresets: unknown,
): { items: EffectStackItem[]; unknown: string[] } {
  const saved = Array.isArray(savedPresets) ? savedPresets : []
  const items: EffectStackItem[] = []
  const unknown: string[] = []
  for (const id of lookIds) {
    const builtIn = BUILT_IN_EFFECT_STACKS.find(stack => stack.id === id)
    const mine = saved.find((p: any) => p && p.id === id && Array.isArray(p.data?.effects))
    const effects: unknown[] = builtIn ? builtIn.effects : mine ? (mine as any).data.effects : []
    if (!builtIn && !mine) { unknown.push(id); continue }
    for (const e of effects as any[]) {
      if (e && typeof e.id === 'string') items.push({ id: e.id, ...(e.params && typeof e.params === 'object' ? { params: { ...e.params } } : {}) })
    }
  }
  return { items, unknown }
}

/**
 * Give a new episode its channel's look (Music Formula `episodeDefaults.effects_look`)
 * as whole-episode effects — ONLY when the episode has no effects file yet, so
 * a look never overwrites what the owner set, and re-building an episode never
 * re-adds effects he removed. Returns what it did, for the caller to announce.
 */
export async function seedEpisodeEffectsFromLook(
  episodeDir: string,
  lookIds: readonly string[],
  savedPresets: unknown,
): Promise<{ seeded: boolean; added: number; unknown: string[] }> {
  if (!lookIds.length || existsSync(episodeEffectsPath(episodeDir))) return { seeded: false, added: 0, unknown: [] }
  const { items, unknown } = effectsForLook(lookIds, savedPresets)
  if (!items.length) return { seeded: false, added: 0, unknown }
  await writeEpisodeEffects(episodeDir, {
    episode: items.map((item, i) => ({ uid: `${item.id}-${i + 1}`, id: item.id, enabled: true, ...(item.params ? { params: item.params } : {}) })),
  })
  return { seeded: true, added: items.length, unknown }
}
