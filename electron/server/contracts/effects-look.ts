/**
 * A channel's effects LOOK — one route, and an answer to "what will this render
 * bake in?".
 *
 * Before 1.4.282 a vignette, grain or letterbox could be set two ways: the
 * classic Video Assembly checkboxes (`vignette`, `film_grain`, `letterbox`) and
 * the built-in Effect Library (`scene_effects.overlays`, ids such as
 * `vignette-soft`). The page now shows only the Effect Library. A classic
 * checkbox becomes a library entry marked `legacy_slot` when a preset loads, and
 * at render the marked entry goes back into the classic field, so it is drawn by
 * the same filter, at the same place in the chain, as it always was — a channel
 * that had the checkbox keeps exactly the same pixels. (The classic place is
 * under the aged-film look and the frame; a library entry picked fresh renders
 * in the library's own place.)
 *
 * Two lists are easy to confuse, and both are named here:
 * - `overlays.layers` — CUSTOM OVERLAY FILES: an image or video on disk (`source_path`).
 * - `scene_effects.overlays` — BUILT-IN EFFECTS: `{ id, enabled, params }`.
 * A built-in effect put in the file list, a pasted catalogue document, or an
 * entry missing `enabled` used to vanish without a word. `normalizeEffectsLook`
 * puts each where it renders, or names what it cannot place.
 *
 * Pure and dependency-free beyond the contracts: the pages import it via `@shared`.
 */

import { isContentPackItemId } from './content-origin.js'
import { BUILT_IN_OVERLAYS, findBuiltInOverlay } from './scene-effect-presets.js'

export type LegacySlot = 'vignette' | 'film_grain' | 'letterbox'
const LEGACY_SLOTS: readonly LegacySlot[] = ['vignette', 'film_grain', 'letterbox']

export interface LookEntry {
  id: string
  enabled: boolean
  params?: Record<string, unknown>
  legacy_slot?: LegacySlot
}

type Look = Record<string, any>

const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)

/** The built-in a classic checkbox becomes, with its value in that built-in's terms. */
function legacyToEntry(slot: LegacySlot, cfg: Record<string, any>): LookEntry {
  if (slot === 'vignette') return { id: 'vignette-soft', enabled: true, legacy_slot: slot, params: { intensity: cfg.strength ?? 0.7 } }
  if (slot === 'film_grain') return { id: 'film-grain-fine', enabled: true, legacy_slot: slot, params: { amount: cfg.strength ?? 15 } }
  return {
    id: cfg.ratio === '1.85:1' ? 'letterbox-185' : 'letterbox-235',
    enabled: true,
    legacy_slot: slot,
    params: { ratio: cfg.ratio ?? '2.35:1', color: cfg.color ?? 'black', mode: cfg.mode === 'cover' ? 'cover' : 'fit' },
  }
}

/** The classic field a marked entry renders through — the inverse of `legacyToEntry`. */
function entryToLegacy(entry: LookEntry): Record<string, unknown> {
  const doc = (findBuiltInOverlay(entry.id)?.document || {}) as Record<string, any>
  const p = { ...doc, ...(entry.params || {}) }
  if (entry.legacy_slot === 'vignette') return { enabled: true, strength: p.intensity }
  if (entry.legacy_slot === 'film_grain') return { enabled: true, strength: p.amount }
  return { enabled: true, ratio: p.ratio, color: p.color, mode: p.mode === 'cover' ? 'cover' : 'fit' }
}

/** The built-in a pasted catalogue document stands for: same kind (and loop variant). */
function idForDocument(doc: Record<string, any>): string | null {
  const match = BUILT_IN_OVERLAYS.find(o => o.document.kind === doc.kind
    && (doc.kind !== 'atmosphere-loop' || (o.document as any).variant === doc.variant))
  return match?.id ?? null
}

/** A document's own fields as params: everything but the envelope. */
function documentParams(doc: Record<string, any>): Record<string, unknown> {
  const { schema_version: _v, kind: _k, timing: _t, variant: _variant, ...params } = doc
  return params
}

const effectName = (id: string) => findBuiltInOverlay(id)?.name ?? id

/**
 * Put every effect entry where it renders. Returns a copy; `notes` says what
 * moved and what could not be placed. With `migrateLegacy`, enabled classic
 * checkboxes become marked Effect Library entries (preset load on the page).
 * A look that needs no fixing comes back structurally unchanged.
 */
export function normalizeEffectsLook<T>(input: T, opts: { migrateLegacy?: boolean } = {}): { look: T; notes: string[] } {
  if (!isObject(input)) return { look: input, notes: [] }
  const look: Look = JSON.parse(JSON.stringify(input))
  const notes: string[] = []
  const hadSection = isObject(look.scene_effects)
  const entries: any[] = hadSection && Array.isArray(look.scene_effects.overlays) ? look.scene_effects.overlays : []
  let sectionOn = hadSection && !!look.scene_effects.enabled
  let touched = false
  const add = (entry: LookEntry, atFront = false) => {
    // Turning a switched-off section on must not wake the entries it was hiding.
    if (entry.enabled && !sectionOn) { entries.forEach(e => { if (e) e.enabled = false }); sectionOn = true }
    if (atFront) entries.unshift(entry)
    else entries.push(entry)
    touched = true
  }

  // Built-in effects: references, not documents; `enabled` defaults to on.
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (!isObject(e)) continue
    if (typeof e.id !== 'string' || !e.id) {
      const doc = isObject(e.document) ? e.document : e
      const id = typeof doc.kind === 'string' ? idForDocument(doc) : null
      if (!id) { notes.push('A built-in effect entry has no id and matches no effect, so it is not rendered.'); continue }
      entries[i] = { id, enabled: e.enabled !== false, params: { ...documentParams(doc), ...(isObject(e.params) ? e.params : {}) } }
      notes.push(`A pasted ${effectName(id)} document was turned into a reference to that built-in effect.`)
      touched = true
      continue
    }
    if ('document' in e || 'name' in e || 'category' in e) {
      entries[i] = { id: e.id, enabled: e.enabled !== false, params: isObject(e.params) ? e.params : {}, ...(e.legacy_slot ? { legacy_slot: e.legacy_slot } : {}) }
      touched = true
    }
    if (typeof entries[i].enabled !== 'boolean') {
      entries[i].enabled = true
      notes.push(`${effectName(e.id)} had no "enabled" flag; it counts as on.`)
      touched = true
    }
    if (!findBuiltInOverlay(e.id) && !isContentPackItemId(e.id)) {
      notes.push(`"${e.id}" is not a built-in effect, so it is skipped at render.`)
    }
  }

  // Custom overlay files: a file on disk. A built-in effect parked here is moved.
  const layers: any[] = isObject(look.overlays) && Array.isArray(look.overlays.layers) ? look.overlays.layers : []
  const filesOn = isObject(look.overlays) && look.overlays.enabled !== false
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i]
    if (!isObject(l)) continue
    if (typeof l.source_path === 'string' && l.source_path.trim()) {
      if (typeof l.enabled !== 'boolean') {
        l.enabled = true
        notes.push(`Overlay file ${l.source_path.split('/').pop()} had no "enabled" flag; it counts as on.`)
      }
      continue
    }
    const id = typeof l.id === 'string' && findBuiltInOverlay(l.id) ? l.id
      : typeof l.kind === 'string' ? idForDocument(l) : null
    if (!id) {
      if (l.enabled !== false) notes.push('An overlay-file row has no file, so it draws nothing.')
      continue
    }
    layers.splice(i, 1)
    add({ id, enabled: filesOn && l.enabled !== false, params: { ...(typeof l.kind === 'string' ? documentParams(l) : {}), ...(isObject(l.params) ? l.params : {}) } })
    notes.push(`${effectName(id)} was in the custom overlay files, which only take image or video files; it moved to the built-in effects.`)
  }

  if (opts.migrateLegacy) {
    for (const slot of [...LEGACY_SLOTS].reverse()) {
      const cfg = look[slot]
      if (!isObject(cfg) || !cfg.enabled) continue
      for (let i = entries.length - 1; i >= 0; i--) if (entries[i]?.legacy_slot === slot) entries.splice(i, 1)
      add(legacyToEntry(slot, cfg), true)
      look[slot] = { ...cfg, enabled: false }
    }
  }

  if (touched) look.scene_effects = { ...(hadSection ? look.scene_effects : {}), enabled: sectionOn, overlays: entries }
  return { look: look as T, notes }
}

/**
 * Render side of the one route: a marked entry goes back into its classic
 * field, so it is drawn exactly as the checkbox was. Mutates and returns `req`.
 */
export function splitLegacySlots<T extends Look>(req: T): T {
  const se = req?.scene_effects
  if (!isObject(se) || !Array.isArray(se.overlays) || !se.overlays.some((e: any) => e?.legacy_slot)) return req
  const keep = se.overlays.filter((e: any) => !e?.legacy_slot)
  for (const e of se.overlays) {
    if (e?.legacy_slot && LEGACY_SLOTS.includes(e.legacy_slot) && se.enabled && e.enabled !== false) {
      (req as Look)[e.legacy_slot] = entryToLegacy(e)
    }
  }
  if (keep.length) (req as Look).scene_effects = { ...se, overlays: keep }
  else delete (req as Look).scene_effects
  return req
}

const pct = (v: unknown) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n > 1 ? n : n * 100) : null
}
const fileName = (p: unknown) => String(p || '').split('/').pop()

/**
 * Every effect a render with this look bakes in, one line each. Accepts the
 * flat render request or the Effects slot of a preset (same keys). Per-episode
 * Effects Library effects (`scene_effects.json`) are not in a look and come on top.
 */
export function describeEffectStack(input: unknown): string[] {
  if (!isObject(input)) return []
  const look = splitLegacySlots(normalizeEffectsLook(input).look as Look)
  const out: string[] = []
  const on = (v: any) => isObject(v) && v.enabled
  if (on(look.color_grading)) out.push(`Colour grade: ${look.color_grading.preset || 'custom'}`)
  if (on(look.vignette)) out.push(`Vignette (strength ${look.vignette.strength ?? 0.7})`)
  if (on(look.film_grain)) out.push(`Film grain (strength ${look.film_grain.strength ?? 15})`)
  if (on(look.aged_archive_film)) out.push(`Aged archive film (${look.aged_archive_film.strength ?? 45})`)
  if (on(look.letterbox)) out.push(`Letterbox ${look.letterbox.ratio || '2.35:1'}, ${look.letterbox.mode === 'cover' ? 'cinematic crop (covers edges)' : 'whole picture kept'}`)
  if (on(look.frame)) out.push('Presentation frame')
  if (on(look.scene_effects) && Array.isArray(look.scene_effects.overlays)) {
    for (const e of look.scene_effects.overlays) {
      if (!e?.enabled) continue
      const built = findBuiltInOverlay(e.id)
      if (!built) { out.push(`Effect: ${e.id}${isContentPackItemId(e.id) ? ' (Content Pack)' : ' (unknown, skipped)'}`); continue }
      out.push(`Effect: ${built.name}${built.document.kind === 'atmosphere-loop' ? ' (moving loop, slower render)' : ''}`)
    }
  }
  if (on(look.overlays) && Array.isArray(look.overlays.layers)) {
    for (const l of look.overlays.layers) if (l?.enabled && l.source_path) out.push(`Overlay file: ${fileName(l.source_path)}`)
  }
  if (on(look.chroma_key) && look.chroma_key.source_path) out.push(`Green-screen overlay: ${fileName(look.chroma_key.source_path)}`)
  if (on(look.logo) && look.logo.image_path) out.push(`Logo: ${look.logo.position || 'corner'}, ${pct(look.logo.opacity) ?? 100}% opacity`)
  if (on(look.title_card)) out.push('Title card')
  if (on(look.chapter_titles)) out.push('Chapter titles')
  if (on(look.outro_card)) out.push('Outro card')
  return out
}

export interface PresetLike { id: string; name?: string; data?: unknown }

/** Key-sorted JSON, so two presets saved with keys in a different order still match. */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`
  if (isObject(v)) return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`
  return JSON.stringify(v) ?? 'null'
}

/** "Effects & Overlays" and "effects & overlay" are the same name. */
function nameKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').map(w => w.replace(/s$/, '')).join(' ')
}

/**
 * Presets that look like copies of each other — same settings, or the same
 * name give or take case, punctuation and a plural — each with a merge hint.
 * Never deletes anything.
 */
export function duplicatePresetHints(presets: readonly PresetLike[]): string[] {
  const groups = (key: (p: PresetLike) => string) => {
    const by = new Map<string, PresetLike[]>()
    for (const p of presets) {
      const k = key(p)
      if (k) by.set(k, [...(by.get(k) || []), p])
    }
    return [...by.values()].filter(g => g.length > 1)
  }
  const quoted = (g: PresetLike[]) => g.map(p => `"${p.name || p.id}"`).join(', ')
  const hints: string[] = []
  const reported: PresetLike[][] = []
  for (const g of groups(p => stableJson(p.data ?? null))) {
    reported.push(g)
    hints.push(`${quoted(g)} have identical settings. Keep one and delete the others — nothing is deleted automatically.`)
  }
  for (const g of groups(p => nameKey(p.name || ''))) {
    if (reported.some(r => g.every(p => r.includes(p)))) continue
    hints.push(`${quoted(g)} have nearly the same name but different settings. Pick the one to keep, then delete or rename the others — nothing is deleted automatically.`)
  }
  return hints
}
