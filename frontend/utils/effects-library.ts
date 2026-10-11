/**
 * The Effects Library page's logic, kept out of the `.vue` file so it can be
 * tested in plain node.
 *
 * The page edits one episode's `scene_effects.json` (see
 * `electron/server/services/episode-effects.ts`): a whole-episode stack, theme
 * stacks and per-scene stacks of `{ uid, id, params, fades, order }`. What the
 * page SHOWS for a target is every effect that will render on it, in the order
 * it will render — the same rule the render applies — so the stack panel is
 * never a second opinion.
 */

import { EFFECT_STACK_GROUPS, normalizeSceneOverlay, overlayStackGroup, type EffectStackGroup, type SceneOverlayDocument } from '@shared/scene-effects'
import { EFFECT_SCOPE_ORDER_BASE, type ParamField } from '@shared/effect-params'

export interface LibraryEntry {
  id: string
  name: string
  description: string
  category: string
  approximation?: string
  document: SceneOverlayDocument
  origin?: { origin: 'built-in' | 'content-pack'; pack_id?: string; pack_version?: string }
}

export interface AppliedEffect {
  uid: string
  id: string
  enabled: boolean
  params?: Record<string, unknown>
  fade_in_sec?: number
  fade_out_sec?: number
  order?: number
}

export interface EpisodeEffectsFile {
  schema_version: 1
  updated_at: string | null
  custom_order: boolean
  episode: AppliedEffect[]
  themes: Array<{ theme: string; effects: AppliedEffect[] }>
  scenes: Array<{ scene_id: string; effects: AppliedEffect[] }>
}

export interface SceneRow {
  id: string
  scene_index: number
  start_sec: number
  end_sec: number
  has_image: boolean
  theme: string | null
  label: string
}

export type EffectTarget =
  | { kind: 'episode' }
  | { kind: 'scene'; id: string }
  | { kind: 'theme'; theme: string }

export type StackScope = 'episode' | 'theme' | 'scene'

export interface StackRow {
  applied: AppliedEffect
  scope: StackScope
  /** The list the entry lives in, so the page can edit or remove it there. */
  list: AppliedEffect[]
  entry: LibraryEntry | null
  doc: SceneOverlayDocument | null
  group: EffectStackGroup
  order: number
}

/** Starting fade for an effect on one scene — mirrors `DEFAULT_SCENE_FADE_SEC`. */
export const DEFAULT_SCENE_FADE_SEC = 2

export function emptyEffectsFile(): EpisodeEffectsFile {
  return { schema_version: 1, updated_at: null, custom_order: false, episode: [], themes: [], scenes: [] }
}

/** The filter tabs on the page, from the library's own categories. */
export const CATEGORY_TABS: Array<{ key: string; label: string; categories: string[] }> = [
  { key: 'all', label: 'All', categories: [] },
  { key: 'weather', label: 'Weather', categories: ['weather'] },
  { key: 'atmosphere', label: 'Atmosphere', categories: ['atmosphere'] },
  { key: 'light', label: 'Light', categories: ['light'] },
  { key: 'film', label: 'Film & lens', categories: ['texture', 'grade'] },
  { key: 'titles', label: 'Titles & framing', categories: ['framing', 'title', 'brand'] },
  // 1.4.283 — the camera moves, shown as a gallery; no overlay has this category.
  { key: 'motions', label: 'Camera motions', categories: ['camera-motion'] },
  // E1 (1.4.287) — the scene transitions, shown as a gallery; no overlay has this category.
  { key: 'transitions', label: 'Transitions', categories: ['transition'] },
]

/** Short, stable fingerprint of an effect's document, so a gallery clip's URL changes when the effect does. */
export function documentVersion(doc: unknown): string {
  const text = JSON.stringify(doc ?? null)
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0
  return h.toString(36)
}

/** Section headings, in page order. An unknown pack category lands in "More". */
export const CATEGORY_SECTIONS: Array<{ label: string; categories: string[] }> = [
  { label: 'Weather', categories: ['weather'] },
  { label: 'Atmosphere', categories: ['atmosphere'] },
  { label: 'Light', categories: ['light'] },
  { label: 'Film & lens', categories: ['texture', 'grade'] },
  { label: 'Titles & framing', categories: ['framing', 'title', 'brand'] },
]

export const GROUP_LABELS: Record<EffectStackGroup, string> = {
  camera: 'Camera',
  grade: 'Grade',
  'far-atmosphere': 'Far atmosphere',
  weather: 'Weather',
  'near-atmosphere': 'Near atmosphere',
  'light-particles': 'Light particles',
  light: 'Light',
  lens: 'Lens',
  overlays: 'Overlays',
}

export function sectionFor(entries: readonly LibraryEntry[], tab: string, search: string): Array<{ label: string; entries: LibraryEntry[] }> {
  const q = search.trim().toLowerCase()
  const allowed = CATEGORY_TABS.find(t => t.key === tab)?.categories ?? []
  const visible = entries.filter(entry => (!allowed.length || allowed.includes(entry.category))
    && (!q || `${entry.name} ${entry.description}`.toLowerCase().includes(q)))
  const known = new Set(CATEGORY_SECTIONS.flatMap(s => s.categories))
  const sections = CATEGORY_SECTIONS.map(section => ({ label: section.label, entries: visible.filter(e => section.categories.includes(e.category)) }))
  sections.push({ label: 'More', entries: visible.filter(e => !known.has(e.category)) })
  return sections.filter(section => section.entries.length)
}

/** The finished document for an applied effect, or null when the library lacks it. */
export function resolveDoc(entry: LibraryEntry | null | undefined, params?: Record<string, unknown>): SceneOverlayDocument | null {
  if (!entry) return null
  return params && Object.keys(params).length
    ? normalizeSceneOverlay({ ...entry.document, ...params, kind: entry.document.kind, timing: entry.document.timing })
    : entry.document
}

/** The list a target edits, created when missing. */
export function targetList(file: EpisodeEffectsFile, target: EffectTarget): AppliedEffect[] {
  if (target.kind === 'episode') return file.episode
  if (target.kind === 'theme') {
    let rule = file.themes.find(t => t.theme.toLowerCase() === target.theme.toLowerCase())
    if (!rule) { rule = { theme: target.theme, effects: [] }; file.themes.push(rule) }
    return rule.effects
  }
  let stack = file.scenes.find(s => s.scene_id === target.id)
  if (!stack) { stack = { scene_id: target.id, effects: [] }; file.scenes.push(stack) }
  return stack.effects
}

/** Every effect that renders on a target, in render order. */
export function stackRowsForTarget(
  file: EpisodeEffectsFile,
  target: EffectTarget,
  scenes: readonly SceneRow[],
  library: readonly LibraryEntry[],
): StackRow[] {
  const rows: StackRow[] = []
  const add = (list: AppliedEffect[], scope: StackScope) => {
    list.forEach((applied, index) => {
      const entry = library.find(e => e.id === applied.id) ?? null
      const doc = resolveDoc(entry, applied.params)
      rows.push({
        applied, scope, list, entry, doc,
        group: doc ? overlayStackGroup(doc) : 'overlays',
        order: applied.order ?? EFFECT_SCOPE_ORDER_BASE[scope] + index,
      })
    })
  }
  add(file.episode, 'episode')
  const theme = target.kind === 'theme' ? target.theme
    : target.kind === 'scene' ? scenes.find(s => s.id === target.id)?.theme ?? null
    : null
  if (theme) {
    const rule = file.themes.find(t => t.theme.toLowerCase() === theme.toLowerCase())
    if (rule) add(rule.effects, 'theme')
  }
  if (target.kind === 'scene') {
    const stack = file.scenes.find(s => s.scene_id === target.id)
    if (stack) add(stack.effects, 'scene')
  }
  const rank = (group: EffectStackGroup) => file.custom_order ? 0 : EFFECT_STACK_GROUPS.indexOf(group)
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => rank(a.row.group) - rank(b.row.group) || a.row.order - b.row.order || a.i - b.i)
    .map(x => x.row)
}

/** The documents a target renders, for the live preview and the exact preview. */
export function enabledDocs(rows: readonly StackRow[]): SceneOverlayDocument[] {
  return rows.filter(r => r.applied.enabled && r.doc).map(r => r.doc!)
}

/**
 * Move `dragged` to just before `target` (or to the end of the list when
 * `target` is null) by giving it an order between its new neighbours.
 *
 * In layer groups an effect can only move inside its own group — the group
 * decides where it renders — so a drop into another group returns a sentence
 * saying so instead of moving it.
 */
export function moveRow(rows: readonly StackRow[], dragged: StackRow, target: StackRow | null, customOrder: boolean): string | null {
  if (target === dragged) return null
  if (!customOrder && target && target.group !== dragged.group) {
    return `${dragged.entry?.name || dragged.applied.id} stays in ${GROUP_LABELS[dragged.group]} while layer groups are on. Turn on Custom order to place it anywhere.`
  }
  const others = rows.filter(r => r !== dragged && (customOrder || r.group === dragged.group))
  const at = target ? others.indexOf(target) : others.length
  const before = at > 0 ? others[at - 1]!.order : null
  const after = at < others.length ? others[at]!.order : null
  dragged.applied.order = before === null && after === null ? 0
    : before === null ? after! - 1
    : after === null ? before + 1
    : (before + after) / 2
  return null
}

export function newUid(id: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  let n = 1
  while (used.has(`${id}-${n}`)) n++
  return `${id}-${n}`
}

export function allUids(file: EpisodeEffectsFile): string[] {
  return [...file.episode, ...file.themes.flatMap(t => t.effects), ...file.scenes.flatMap(s => s.effects)].map(e => e.uid)
}

/** Only the fields that differ from the library's document — what gets saved. */
export function changedParams(entry: LibraryEntry, doc: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(doc)) {
    if (key === 'kind' || key === 'schema_version' || key === 'timing') continue
    if (JSON.stringify((entry.document as any)[key]) !== JSON.stringify(value)) out[key] = value
  }
  return out
}

/** Add effects to a target. Scene and theme effects start with a crossfade-length fade. */
export function addEffects(file: EpisodeEffectsFile, target: EffectTarget, items: Array<{ id: string; params?: Record<string, unknown> }>): AppliedEffect[] {
  const list = targetList(file, target)
  const taken = allUids(file)
  const added: AppliedEffect[] = []
  for (const item of items) {
    const uid = newUid(item.id, [...taken, ...added.map(a => a.uid)])
    const applied: AppliedEffect = {
      uid, id: item.id, enabled: true,
      ...(item.params && Object.keys(item.params).length ? { params: { ...item.params } } : {}),
      ...(target.kind === 'episode' ? {} : { fade_in_sec: DEFAULT_SCENE_FADE_SEC, fade_out_sec: DEFAULT_SCENE_FADE_SEC }),
    }
    list.push(applied)
    added.push(applied)
  }
  return added
}

/** A stack as a reusable preset body: ids and changed fields only — no scene, window or order. */
export function presetItemsFromRows(rows: readonly StackRow[]): Array<{ id: string; params?: Record<string, unknown> }> {
  return rows.filter(r => r.applied.enabled).map(r => ({
    id: r.applied.id,
    ...(r.applied.params && Object.keys(r.applied.params).length ? { params: { ...r.applied.params } } : {}),
  }))
}

/** Drop empty scene and theme stacks before saving. */
export function compactFile(file: EpisodeEffectsFile): EpisodeEffectsFile {
  return {
    ...file,
    themes: file.themes.filter(t => t.effects.length),
    scenes: file.scenes.filter(s => s.effects.length),
  }
}

export function targetLabel(target: EffectTarget, scenes: readonly SceneRow[]): string {
  if (target.kind === 'episode') return 'Whole episode'
  if (target.kind === 'theme') return `Every "${target.theme}" scene`
  const scene = scenes.find(s => s.id === target.id)
  return scene ? `Scene ${scene.scene_index}` : 'Scene'
}

export function formatParam(field: ParamField, value: unknown): string {
  if (value === null || value === undefined) return 'off'
  if (typeof value !== 'number') return String(value)
  switch (field.format) {
    case 'percent': return field.max !== undefined && field.max > 1 ? `${Math.round(value)} %` : `${Math.round(value * 100)} %`
    case 'share': return `${Math.round(value * 100)} %`
    case 'px': return `${Math.round(value * 10) / 10} px`
    case 'sec': return `${Math.round(value * 10) / 10} s`
    case 'deg': return `${Math.round(value)}°`
    case 'times': return `${(Math.round(value * 100) / 100).toFixed(2)}×`
    default: return String(Math.round(value * 100) / 100)
  }
}

export function formatClock(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`
}
