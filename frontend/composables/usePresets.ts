/**
 * Per-tab preset storage, keyed by config.{configKey}_presets and
 * config.{configKey}_last_preset_id. Provides uniform apply/save/delete
 * semantics so every generator tab uses the same pattern.
 *
 * Usage:
 *   const presets = usePresets({
 *     slug: slug.value,
 *     configKey: 'script',           // writes config.script_presets
 *     snapshot: () => ({ ...form }), // capture current state
 *     apply: (data) => Object.assign(form, data),
 *   })
 *   presets.load()       // call on mount
 *   presets.saveAs(name) // user clicked "Save as…"
 *   presets.overwrite()  // user clicked "Save"
 *   presets.applyActive()// user clicked "Apply"
 *   presets.remove()     // user clicked "Delete"
 */

// Explicit Vue + composable imports so this module is usable from plain
// node:test (no Nuxt auto-import context). Nuxt's auto-imports remain
// additive inside .vue files.
import { ref, computed, nextTick } from 'vue'
import { useApi } from './useApi.js'
// The Preset shape is defined on PresetPicker.vue, but we re-declare it
// here so this module is type-resolvable outside Nuxt's `~/` alias (needed
// by the test runner).
//
// `type` is optional — older presets (saved before tagging existed) leave
// it undefined and are treated as 'all'. New presets are tagged by
// `usePresets({ presetType })` so the picker can filter per-section.
//
// Future types (art-style, prompt-style, etc.) slot in via this union
// without schema changes; they share the `configKey` storage pattern.
// (`script-style` was a 2026 experiment that lived in the Script Generator's
// "Reference Styles" panel — removed in favour of the more general Format
// system + FormatFromSampleWizard, which cover the same need at a better scope.)
export type PresetType = 'script' | 'introduction' | 'research' | 'art-style' | 'prompt-style' | 'broll' | 'scene-plan' | 'style-bible' | 'scene-review' | 'motion-review' | 'visual-recipe' | 'continuity-page' | 'all'
export interface Preset {
  id: string
  name: string
  data: any
  type?: PresetType
  /** Shipped with the app, not persisted in project config. */
  builtin?: boolean
}

export interface UsePresetsOptions<T> {
  slug: string
  configKey: string
  snapshot: () => T
  apply: (data: T) => void
  /** Optional app-shipped presets surfaced alongside user-saved ones. */
  builtInPresets?: Preset[]
  /**
   * Tag for newly-saved presets. The composable also filters its `presets`
   * list to entries whose `type` matches (or is missing — for backwards
   * compat with pre-tagging presets, which are treated as 'all').
   * Omit to share a single untyped preset pool with the legacy behaviour.
   */
  presetType?: PresetType
  /**
   * Keys to strip (recursively) from snapshot bodies on save AND from
   * stored preset data before apply. Defaults to per-episode identifiers
   * so presets never overwrite whichever episode the user currently has
   * selected — this was a universal footgun across every generator page.
   *
   * Set to `[]` to opt out if a page legitimately needs to persist one
   * of these fields in a preset (none does today).
   */
  excludeKeys?: string[]
  /**
   * v1.0.93+ — whether `load()` should auto-apply the active preset on
   * mount. Defaults to `true` (every generator page relies on this for
   * "remember my last setup" UX). Pages where the form state is also
   * driven by another source — most notably the Ideas Generator, which
   * hydrates `niche_id` / `format_id` from the project meta — should
   * pass `false` and rely on the user clicking Apply explicitly. Without
   * this opt-out the preset auto-apply races the project-meta hydration
   * and silently overwrites the project's niche on every navigation.
   */
  autoApplyOnLoad?: boolean
}

// Per-episode fields that should never live inside a saved preset.
// `title` joined this list after a post-batch incident: the script page's
// saved preset carried the title from the episode it was saved under, and
// when a batch reused that preset, every batched episode inherited the
// stale title — the script generator then wrote content into folders
// named "{code} - {stale-title}", creating duplicate-per-episode directories.
const DEFAULT_EXCLUDE_KEYS = ['episode_id', 'episodeId', 'episode', 'title']

/**
 * Recursively clone `value`, omitting any object key in `keys` at any
 * depth. Used for both write (snapshot sanitization) and read (cleaning
 * already-saved preset data before the user's apply() sees it).
 *
 * Arrays are walked element-by-element; primitives and null pass through.
 * Non-plain objects (Date, Map, etc.) are uncommon in preset snapshots,
 * so they get the same walk as plain objects.
 */
function stripKeysDeep(value: any, keys: string[]): any {
  if (value == null) return value
  if (Array.isArray(value)) return value.map(v => stripKeysDeep(v, keys))
  if (typeof value !== 'object') return value
  const out: Record<string, any> = {}
  for (const [k, v] of Object.entries(value)) {
    if (keys.includes(k)) continue
    out[k] = stripKeysDeep(v, keys)
  }
  return out
}

/**
 * Device-scoped presets were retired in favour of one clear local preset
 * list. Keep every legacy preset, but strip its obsolete origin tag so old
 * entries from another Mac are never hidden or presented as a second scope.
 */
function normalizePreset(value: Preset): Preset {
  const normalized = { ...value } as Preset & { machine_label?: unknown }
  delete normalized.machine_label
  return normalized
}

export function usePresets<T = any>(opts: UsePresetsOptions<T>) {
  const { get, put } = useApi()
  const builtInPresets = opts.builtInPresets ?? []
  // `allPresets` holds the raw stored list (untyped + typed). Public
  // `presets` is filtered to entries that match `opts.presetType`, so
  // each instance only sees the slice it owns.
  const allPresets = ref<Preset[]>([])
  const activeId = ref('')
  const excludeKeys = opts.excludeKeys ?? DEFAULT_EXCLUDE_KEYS

  const presetsKey = `${opts.configKey}_presets`
  // Active preset tracking is per-type so each section can remember its
  // own choice independently.
  const activeKey = opts.presetType
    ? `${opts.configKey}_last_preset_${opts.presetType}`
    : `${opts.configKey}_last_preset`

  // One local list, optionally sliced by feature type. Untyped legacy
  // presets remain visible so this migration never loses user data.
  const presets = computed(() => {
    const merged = [...builtInPresets, ...allPresets.value]
    if (!opts.presetType) return merged
    return merged.filter(p => {
      // Untyped presets are treated as 'all' — they appear in every section
      // so legacy presets remain usable from the new typed UI.
      const t = p.type || 'all'
      return t === opts.presetType || t === 'all'
    })
  })

  /** Built-ins are app-shipped defaults: they can be applied, but not
   *  renamed/overwritten/deleted like user-saved presets. */
  const activePresetIsBuiltIn = computed(() => {
    if (!activeId.value) return false
    return !!builtInPresets.find(x => x.id === activeId.value)
  })

  // Wrap the user's snapshot to strip excluded keys — prevents new presets
  // from ever storing episode_id or similar per-episode state.
  function cleanSnapshot(): T {
    return stripKeysDeep(opts.snapshot(), excludeKeys) as T
  }

  // Wrap the user's apply so OLD presets (saved before this fix) also stop
  // polluting the form — strip excluded keys at read time too.
  function cleanApply(data: any): void {
    opts.apply(stripKeysDeep(data, excludeKeys) as T)
  }

  async function load() {
    try {
      const config = await get<any>(`/projects/${opts.slug}/settings/config`)
      allPresets.value = Array.isArray(config[presetsKey])
        ? config[presetsKey].map(normalizePreset)
        : []
      activeId.value = typeof config[activeKey] === 'string' ? config[activeKey] : ''
      // Auto-apply the active preset so the form reflects the saved state
      // when the user re-enters the tab. Without this, the preset dropdown
      // shows "active" but the form sits on its reactive defaults, making
      // every saved preset appear to silently revert after a navigation.
      //
      // v1.0.93+ opt-out: pages where the form is also driven by project
      // meta (Ideas Generator's niche_id / format_id) pass autoApplyOnLoad
      // = false. There the preset auto-apply was racing the project-meta
      // hydration and silently clobbering the project's niche on every
      // navigation — the actual bug the user reported on Abiding Faith.
      const autoApply = opts.autoApplyOnLoad !== false
      if (autoApply && activeId.value) applyActive()
    } catch { /* ignore */ }
  }

  async function persist() {
    // A mutation is also the safe migration point for legacy records: clean
    // the full list before writing, including entries owned by other types.
    allPresets.value = allPresets.value.map((preset) => {
      const normalized = normalizePreset(preset)
      return {
        ...normalized,
        data: stripKeysDeep(normalized.data, excludeKeys),
      }
    })
    await put(`/projects/${opts.slug}/settings/config`, {
      [presetsKey]: allPresets.value,
      [activeKey]: activeId.value,
    })
  }

  function applyActive() {
    const p = presets.value.find(x => x.id === activeId.value)
    if (!p) return null
    cleanApply(p.data)
    return p
  }

  async function saveAs(name: string) {
    const id = `preset-${Date.now()}`
    const fresh: Preset = {
      id,
      name,
      data: cleanSnapshot(),
      ...(opts.presetType ? { type: opts.presetType } : {}),
    }
    // Assign by replacement (not push-mutate) so native <select> elements
    // observing `presets` re-render their options list BEFORE the new
    // `activeId` tries to resolve against them. Without this the DOM
    // <select> briefly had an :value pointing at an <option> that hadn't
    // mounted yet, which manifested as "I just saved but can't apply it".
    allPresets.value = [...allPresets.value, fresh]
    activeId.value = id
    // Let Vue commit the option list update before we fire the PUT.
    await nextTick()
    await persist()
    return fresh
  }

  async function overwrite() {
    if (activePresetIsBuiltIn.value) return null
    const p = allPresets.value.find(x => x.id === activeId.value)
    if (!p) return null
    p.data = cleanSnapshot()
    // If overwriting an untyped legacy preset from a typed instance, also
    // tag it so it stops appearing in other sections.
    if (opts.presetType && !p.type) p.type = opts.presetType
    await persist()
    return p
  }

  async function remove() {
    if (activePresetIsBuiltIn.value) return null
    const p = allPresets.value.find(x => x.id === activeId.value)
    if (!p) return null
    allPresets.value = allPresets.value.filter(x => x.id !== activeId.value)
    activeId.value = ''
    await persist()
    return p
  }

  /**
   * v1.0.284 — rename the currently-active preset in place. Same shape as
   * overwrite/remove: operates on the active preset, no id argument needed.
   * The new name is trimmed; an empty/whitespace-only string is a no-op so
   * the rename modal can't accidentally blank the preset's label.
   *
   * The id is immutable — only the `name` metadata changes. Same persist
   * path as every other mutation (PUT /settings/config with the full
   * presets array), so the active-id pointer stays correct without further
   * plumbing.
   *
   * Originally requested when users found themselves rotating between the
   * generator page (where the preset is in use) and the Presets management
   * page (the only place rename existed) just to fix a typo in a preset name.
   */
  async function rename(newName: string) {
    if (activePresetIsBuiltIn.value) return null
    const trimmed = (newName || '').trim()
    if (!trimmed) return null
    const p = allPresets.value.find(x => x.id === activeId.value)
    if (!p) return null
    if (p.name === trimmed) return p   // no-op when the name didn't change
    p.name = trimmed
    await persist()
    return p
  }

  async function setActive(id: string) {
    activeId.value = id
    await persist()
  }

  return {
    presets, activeId,
    load, persist,
    applyActive, saveAs, overwrite, remove, rename, setActive,
    activePresetIsBuiltIn,
  }
}
