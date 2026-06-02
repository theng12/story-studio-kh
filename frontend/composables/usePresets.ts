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
import { useMachineLabel } from './useMachineLabel.js'
// The Preset shape is defined on PresetPicker.vue, but we re-declare it
// here so this module is type-resolvable outside Nuxt's `~/` alias (needed
// by the test runner).
//
// `type` is optional — older presets (saved before tagging existed) leave
// it undefined and are treated as 'all'. New presets are tagged by
// `usePresets({ presetType })` so the picker can filter per-section.
//
// `machine_label` (v1.0.93+) records the hostname of the device the preset
// was saved on so the picker can filter by "this device" by default.
// Legacy presets (saved before v1.0.93) leave it undefined and pass through
// the filter unconditionally — they appear in both "this device" and
// "all devices" views until the user re-saves them, at which point they
// pick up the current device's label.
//
// Future types (art-style, prompt-style, etc.) slot in via this union
// without schema changes; they share the `configKey` storage pattern.
// (`script-style` was a 2026 experiment that lived in the Script Generator's
// "Reference Styles" panel — removed in favour of the more general Format
// system + FormatFromSampleWizard, which cover the same need at a better scope.)
export type PresetType = 'script' | 'introduction' | 'art-style' | 'prompt-style' | 'broll' | 'scene-plan' | 'all'
export interface Preset {
  id: string
  name: string
  data: any
  type?: PresetType
  /** Hostname of the device this preset was saved on. Stamped automatically
   *  on save in v1.0.93+. Missing on legacy presets — those pass through
   *  the device filter so nothing disappears for existing users. */
  machine_label?: string
}

export interface UsePresetsOptions<T> {
  slug: string
  configKey: string
  snapshot: () => T
  apply: (data: T) => void
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

export function usePresets<T = any>(opts: UsePresetsOptions<T>) {
  const { get, put } = useApi()
  // `allPresets` holds the raw stored list (untyped + typed). Public
  // `presets` is filtered to entries that match `opts.presetType`, so
  // each instance only sees the slice it owns.
  const allPresets = ref<Preset[]>([])
  const activeId = ref('')
  const excludeKeys = opts.excludeKeys ?? DEFAULT_EXCLUDE_KEYS

  // v1.0.93+ — per-device preset filtering. `showAllDevices` defaults
  // false so the picker only surfaces presets saved on THIS Mac. Toggle
  // exposed so the page-level UI can render a "📍 This device" / "🌐 All
  // devices" switch. `machineLabel` is module-cached across all usePresets
  // instances (one HTTP call per session).
  const { machineLabel } = useMachineLabel()
  const showAllDevices = ref(false)

  const presetsKey = `${opts.configKey}_presets`
  // Active preset tracking is per-type so each section can remember its
  // own choice independently.
  const activeKey = opts.presetType
    ? `${opts.configKey}_last_preset_${opts.presetType}`
    : `${opts.configKey}_last_preset`

  // `presetsByType` — filtered by presetType only. Used for cross-device
  // counters (so "🌐 All devices · M" shows the count across machines for
  // THIS section's preset type, not the entire raw pool).
  const presetsByType = computed(() => {
    if (!opts.presetType) return allPresets.value
    return allPresets.value.filter(p => {
      // Untyped presets are treated as 'all' — they appear in every section
      // so legacy presets remain usable from the new typed UI.
      const t = p.type || 'all'
      return t === opts.presetType || t === 'all'
    })
  })

  const presets = computed(() => {
    // Always filter by presetType first (existing behaviour preserved).
    const typed = presetsByType.value
    // Until the machine-label fetch lands, show everything — falling
    // through to "no presets visible" during the first ~50ms would be a
    // worse experience than showing one extra second of cross-device
    // entries. The label is cached for the rest of the session.
    if (showAllDevices.value || !machineLabel.value) return typed
    return typed.filter(p =>
      // Legacy passthrough: undefined machine_label means "saved before
      // v1.0.93" — show it everywhere so the user can re-save and stamp
      // it with the current device.
      !p.machine_label || p.machine_label === machineLabel.value,
    )
  })

  /** Count of presets saved on OTHER devices that match this section's
   *  presetType. Used by the picker's "🌐 All devices" toggle label. */
  const crossDeviceCount = computed(() => {
    if (!machineLabel.value) return 0
    return presetsByType.value.filter(p =>
      p.machine_label && p.machine_label !== machineLabel.value,
    ).length
  })

  /** True when the currently-active preset was saved on a different device.
   *  Drives the yellow "saved on <other-mac> — paths may not exist" banner
   *  on the picker so the user can't miss it. */
  const activePresetIsCrossDevice = computed(() => {
    if (!activeId.value || !machineLabel.value) return false
    const p = allPresets.value.find(x => x.id === activeId.value)
    return !!(p?.machine_label && p.machine_label !== machineLabel.value)
  })

  /** Machine label of the active preset, or '' when no preset is active /
   *  the preset is legacy (no label). Surfaces the device name in the
   *  cross-device banner so the user knows which Mac the paths came from. */
  const activePresetMachineLabel = computed(() => {
    if (!activeId.value) return ''
    const p = allPresets.value.find(x => x.id === activeId.value)
    return p?.machine_label || ''
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
      allPresets.value = Array.isArray(config[presetsKey]) ? config[presetsKey] : []
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
    await put(`/projects/${opts.slug}/settings/config`, {
      [presetsKey]: allPresets.value,
      [activeKey]: activeId.value,
    })
  }

  function applyActive() {
    const p = allPresets.value.find(x => x.id === activeId.value)
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
      // v1.0.93+ — stamp the current device on every fresh save. Empty
      // string means the label fetch hasn't landed yet (rare; only the
      // first ~50ms of the session) — in that case we omit the field
      // entirely so the preset is treated as legacy and stays visible
      // across devices until it's re-saved. Better than stamping a
      // wrong / partial label.
      ...(machineLabel.value ? { machine_label: machineLabel.value } : {}),
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
    const p = allPresets.value.find(x => x.id === activeId.value)
    if (!p) return null
    p.data = cleanSnapshot()
    // If overwriting an untyped legacy preset from a typed instance, also
    // tag it so it stops appearing in other sections.
    if (opts.presetType && !p.type) p.type = opts.presetType
    // v1.0.93+ — overwriting also restamps the device label so a preset
    // brought over from another machine + edited on this one becomes
    // "owned" by this machine. The user explicitly chose to save the
    // current state, so it's correct to attribute it to the current
    // device. Legacy presets gain a machine_label this way too.
    if (machineLabel.value) p.machine_label = machineLabel.value
    await persist()
    return p
  }

  async function remove() {
    const p = allPresets.value.find(x => x.id === activeId.value)
    if (!p) return null
    allPresets.value = allPresets.value.filter(x => x.id !== activeId.value)
    activeId.value = ''
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
    applyActive, saveAs, overwrite, remove, setActive,
    // v1.0.93+ device-awareness surface. Pages pass these straight through
    // to PresetPicker (or render their own toggle); the composable owns
    // the filtering logic so every usePresets instance behaves identically.
    showAllDevices,
    machineLabel,
    crossDeviceCount,
    activePresetIsCrossDevice,
    activePresetMachineLabel,
  }
}
