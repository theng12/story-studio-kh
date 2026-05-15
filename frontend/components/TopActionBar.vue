<!--
  Compact toolbar strip for generator pages. Holds the three things that
  always go together at the start of a generator flow:
    1. Preset picker (loads form settings) + ⋯ overflow menu (Apply / Save / Save as / Delete)
    2. Episode selector (targets the generation)
    3. Generate button (kicks off the job)

  This bar is STATIC — it scrolls away with the page. Per-control
  explanations live in hover popovers (preset values, episode status,
  generate action description) so the bar stays visually clean.

  The page title and breadcrumb are owned by the page itself in a
  `<div class="page-header">` block above this bar — not by the bar.
-->
<template>
  <div class="top-action-bar" role="region" aria-label="Primary actions">
    <!-- Preset region -->
    <div v-if="presets" class="region preset-region">
      <span class="region-label" aria-hidden="true">⚙</span>
      <Popover>
        <select
          class="select select-sm preset-select"
          :value="presets.activeId.value"
          aria-label="Preset"
          @change="onPresetSelect(($event.target as HTMLSelectElement).value)"
        >
          <option value="">— no preset —</option>
          <option v-for="p in presets.presets.value" :key="p.id" :value="p.id">
            {{ formatPresetOption(p) }}
          </option>
        </select>
        <template #content>
          <div v-if="activePreset" class="popover-title">{{ activePreset.name }}</div>
          <div v-else class="popover-title">No preset selected</div>
          <template v-if="activePreset">
            <div
              v-for="(row, i) in presetSummary"
              :key="i"
              class="popover-row"
            >
              <span class="label">{{ row.k }}</span>
              <span>{{ row.v }}</span>
            </div>
            <div v-if="presetSummary.length === 0" class="popover-row">
              <span class="label">(no settings to preview)</span>
            </div>
          </template>
          <template v-else>
            Pick a preset to load saved settings into this page.
          </template>
        </template>
      </Popover>
      <OverflowMenu :items="presetMenuItems" aria-label="Preset actions" />
    </div>

    <!-- Episode region -->
    <div v-if="episodeMode === 'single'" class="region episode-region">
      <span class="region-label" aria-hidden="true">📺</span>
      <Popover>
        <div class="episode-selector-wrap">
          <EpisodeSelector
            :model-value="episodeId"
            :project-slug="projectSlug"
            :filter-field="filterField"
            @update:model-value="(v: string) => $emit('update:episodeId', v)"
            @episode-selected="onEpisodeSelected"
          />
        </div>
        <template #content>
          <div class="popover-title">
            {{ activeEpisode ? (activeEpisode.title || activeEpisode.episode_code) : 'No episode selected' }}
          </div>
          <template v-if="activeEpisode">
            <div class="popover-status">
              <span class="item" :class="episodeStatusClass(activeEpisode, 'script')">script {{ episodeStatusIcon(activeEpisode, 'script') }}</span>
              <span class="item" :class="episodeStatusClass(activeEpisode, 'images')">images {{ episodeStatusIcon(activeEpisode, 'images') }}</span>
              <span class="item" :class="episodeStatusClass(activeEpisode, 'audio')">audio {{ episodeStatusIcon(activeEpisode, 'audio') }}</span>
              <span class="item" :class="episodeStatusClass(activeEpisode, 'merged_audio')">merged {{ episodeStatusIcon(activeEpisode, 'merged_audio') }}</span>
              <span class="item" :class="episodeStatusClass(activeEpisode, 'video')">video {{ episodeStatusIcon(activeEpisode, 'video') }}</span>
            </div>
          </template>
          <template v-else>
            Pick the episode this run will target.
          </template>
        </template>
      </Popover>
    </div>
    <!-- Multi-episode mode (pipeline): the page provides its own
         multi-select grid in the body, so the toolbar yields the slot
         space for any extra controls instead of rendering a single
         selector. -->
    <div v-else-if="episodeMode === 'multi'" class="region episode-region">
      <span class="region-label" aria-hidden="true">📺</span>
      <span class="multi-episode-hint">Episodes selected below</span>
      <slot name="episodes" />
    </div>

    <!-- Spacer pushes Generate to the right when the row has room. -->
    <div class="region-spacer" />

    <!-- Generate region -->
    <div class="region generate-region">
      <slot name="actions" />
      <Popover>
        <button
          class="btn btn-primary btn-primary-cta"
          :disabled="generateDisabled || generateLoading"
          :aria-label="generateLabel"
          @click="$emit('generate')"
        >
          <LoadingSpinner v-if="generateLoading" size="sm" />
          {{ generateLoading && generateLoadingLabel ? generateLoadingLabel : generateLabel }}
        </button>
        <template #content>
          <div class="popover-title">{{ generateLabel }}</div>
          <div class="popover-row">
            <span>{{ generateActionSentence }}</span>
          </div>
          <div class="popover-row" style="margin-top: 6px">
            <span class="label">Status</span>
            <span>{{ generateStatusSentence }}</span>
          </div>
        </template>
      </Popover>
    </div>

    <!-- Save-as modal (same pattern as the old PresetPicker) -->
    <Modal
      :visible="showSaveAs"
      size="sm"
      labelledby="top-action-preset-save-title"
      @close="showSaveAs = false"
    >
      <h3 id="top-action-preset-save-title">Save preset as…</h3>
      <p class="text-muted mt-1 mb-2" style="font-size:12px">
        Snapshots the current settings on this page so you can reuse them later.
      </p>
      <input
        v-model="newPresetName"
        ref="newPresetNameInput"
        class="input"
        placeholder="e.g. Default, Sleep Stories, Shorts"
        @keydown.enter="confirmSaveAs"
      />
      <div class="flex gap-2 mt-2" style="justify-content:flex-end">
        <button class="btn btn-secondary" @click="showSaveAs = false">Cancel</button>
        <button class="btn btn-primary" :disabled="!newPresetName.trim()" @click="confirmSaveAs">Save</button>
      </div>
    </Modal>
  </div>
</template>

<script setup lang="ts">
// Explicit imports so the SFC resolves reliably from inside other
// components (auto-import of a local component from another local
// component has been flaky on first load in this Nuxt setup).
import EpisodeSelector from './EpisodeSelector.vue'
import Modal from './Modal.vue'
import LoadingSpinner from './LoadingSpinner.vue'
import Popover from './Popover.vue'
import OverflowMenu from './OverflowMenu.vue'

type OverflowItem = {
  label: string
  onClick: () => void | Promise<void>
  disabled?: boolean
  danger?: boolean
  title?: string
}

// `presets` is the full object returned by usePresets() on the page.
// Typed loosely to avoid pulling the composable's type graph into here;
// the page side is already typed.
const props = withDefaults(defineProps<{
  projectSlug: string
  // Preset hooks (optional — some pages might not have presets)
  presets?: {
    presets: { value: Array<{ id: string; name: string; data: any; machine_label?: string }> }
    activeId: { value: string }
    setActive: (id: string) => Promise<void>
    applyActive: () => any
    overwrite: () => Promise<any>
    saveAs: (name: string) => Promise<any>
    remove: () => Promise<any>
    // v1.0.93+ device awareness (optional — older pages that haven't
    // adopted device-aware usePresets pass nothing here and the toolbar
    // skips the device-toggle menu item).
    showAllDevices?: { value: boolean }
    machineLabel?: { value: string }
    crossDeviceCount?: { value: number }
    activePresetIsCrossDevice?: { value: boolean }
    activePresetMachineLabel?: { value: string }
  }
  // Episode selector
  episodeId?: string
  filterField?: string
  /** @deprecated — use `episodeMode` instead. `false` maps to `'none'`. */
  showEpisode?: boolean
  /**
   * 'single' (default) — render the EpisodeSelector inline.
   * 'multi' — page owns the episode picker (pipeline); toolbar yields a slot.
   * 'none' — no episode region at all.
   */
  episodeMode?: 'single' | 'multi' | 'none'
  // Generate CTA
  generateLabel: string
  generateLoadingLabel?: string
  generateLoading?: boolean
  generateDisabled?: boolean
  generateStatus?: string
}>(), {
  showEpisode: true,
})

const emit = defineEmits<{
  (e: 'update:episodeId', value: string): void
  (e: 'episode-selected', episode: any): void
  (e: 'generate'): void
  (e: 'preset-applied'): void
  (e: 'preset-saved'): void
  (e: 'preset-deleted'): void
}>()

// Resolve episode mode: prefer the explicit prop, fall back to the legacy
// boolean so existing pages don't break mid-migration.
const episodeMode = computed<'single' | 'multi' | 'none'>(() => {
  if (props.episodeMode) return props.episodeMode
  return props.showEpisode === false ? 'none' : 'single'
})

const showSaveAs = ref(false)
const newPresetName = ref('')
const newPresetNameInput = ref<HTMLInputElement | null>(null)

// Active episode (captured from EpisodeSelector's emit) — used by the
// hover popover to show per-section status icons.
const activeEpisode = ref<any | null>(null)
function onEpisodeSelected(ep: any) {
  activeEpisode.value = ep
  emit('episode-selected', ep)
}

// ── Preset summary for the hover popover ────────────────────────────────
const activePreset = computed(() => {
  const id = props.presets?.activeId.value
  if (!id) return null
  return props.presets?.presets.value.find(p => p.id === id) || null
})

// Pull a small, human-readable preview of the preset's key field values.
// We don't know the schema (varies per page) — most pages stash settings
// under a nested `form` object, so we descend one level when a top-level
// value is an object. Skip arrays and deep nesting (too bulky to summarise).
const presetSummary = computed<Array<{ k: string; v: string }>>(() => {
  const data = activePreset.value?.data
  if (!data || typeof data !== 'object') return []
  const rows: Array<{ k: string; v: string }> = []
  function pushRow(k: string, v: unknown) {
    if (rows.length >= 5) return
    if (v === null || v === undefined || v === '') return
    if (typeof v === 'object') return
    let display = String(v)
    if (display.length > 40) display = display.slice(0, 37) + '…'
    rows.push({ k, v: display })
  }
  for (const [k, v] of Object.entries(data)) {
    if (rows.length >= 5) break
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [nk, nv] of Object.entries(v as Record<string, unknown>)) {
        pushRow(nk, nv)
        if (rows.length >= 5) break
      }
    } else {
      pushRow(k, v)
    }
  }
  return rows
})

// ── Generate-button popover content ─────────────────────────────────────
const generateActionSentence = computed(() => {
  const target = props.episodeId ? `for ${props.episodeId}` : ''
  const preset = activePreset.value ? ` using preset '${activePreset.value.name}'` : ''
  return `${props.generateLabel} ${target}${preset}.`.replace(/\s+/g, ' ').trim()
})

const generateStatusSentence = computed(() => {
  if (props.generateLoading) return props.generateStatus || 'Running…'
  if (props.generateDisabled) return props.generateStatus || 'Not ready — fill in the required inputs first.'
  if (props.generateStatus) return props.generateStatus
  return 'Idle — ready when you are.'
})

// v1.0.93+ — device-aware label rendering. In "all devices" mode every
// option gets a `· ⌂ <machine>` suffix so the user can tell which Mac
// each preset is from. Legacy presets (no machine_label) are tagged
// `· (legacy)` so it's clear they predate the device-tagging system.
function formatPresetOption(p: { name: string; machine_label?: string }): string {
  if (!props.presets?.showAllDevices) return p.name
  if (props.presets.showAllDevices.value) {
    return p.machine_label ? `${p.name} · ⌂ ${p.machine_label}` : `${p.name} · (legacy)`
  }
  // In "this device" mode, the legacy chip is still useful — those
  // entries show through the filter because they have no machine_label,
  // and the user should be able to tell them apart from properly-tagged
  // ones (they could be from any device).
  if (!p.machine_label && props.presets.machineLabel?.value) {
    return `${p.name} · (legacy)`
  }
  return p.name
}

// Whether the device-toggle entry should appear in the overflow menu.
// Only show it when the composable opted in to device awareness AND there's
// actually something to toggle (≥1 cross-device preset). Otherwise the
// entry is dead weight in the menu.
const showDeviceToggleItem = computed(() => {
  if (!props.presets?.showAllDevices) return false
  return (props.presets.crossDeviceCount?.value ?? 0) > 0
})

// ── Preset overflow menu items ──────────────────────────────────────────
const presetMenuItems = computed<OverflowItem[]>(() => {
  const hasActive = !!props.presets?.activeId.value
  const items: OverflowItem[] = [
    {
      label: 'Apply preset to this page',
      onClick: onApply,
      disabled: !hasActive,
      title: 'Load the preset\'s saved values into this page\'s form.',
    },
    {
      label: 'Overwrite current preset',
      onClick: onOverwrite,
      disabled: !hasActive,
      title: 'Save the page\'s current values back into the active preset.',
    },
    {
      label: 'Save as new preset…',
      onClick: openSaveAs,
      title: 'Snapshot the current values under a new preset name.',
    },
    {
      label: 'Delete preset',
      onClick: onDelete,
      disabled: !hasActive,
      danger: true,
      title: 'Remove the active preset from this project.',
    },
  ]
  // Append the device-toggle item only when relevant. Sits at the bottom
  // (after Delete) so it doesn't interrupt the primary workflow.
  if (showDeviceToggleItem.value && props.presets?.showAllDevices) {
    const allDevs = props.presets.showAllDevices.value
    const others = props.presets.crossDeviceCount?.value ?? 0
    items.push({
      label: allDevs
        ? `📍 Show only this device's presets`
        : `🌐 Show all devices (+${others} from other Macs)`,
      onClick: () => {
        if (props.presets?.showAllDevices) {
          props.presets.showAllDevices.value = !props.presets.showAllDevices.value
        }
      },
      title: allDevs
        ? 'Hide presets saved on other Macs.'
        : `Reveal presets saved on other Macs. File paths inside cross-device presets may not exist on this Mac — the page will flag any broken paths after you apply.`,
    })
  }
  return items
})

function onPresetSelect(id: string) {
  props.presets?.setActive(id)
}

function onApply() {
  props.presets?.applyActive()
  emit('preset-applied')
}

async function onOverwrite() {
  await props.presets?.overwrite()
  emit('preset-saved')
}

async function onDelete() {
  const p = props.presets?.presets.value.find(x => x.id === props.presets?.activeId.value)
  if (!p) return
  const { ask } = useConfirm()
  const ok = await ask({
    title: `Delete preset "${p.name}"?`,
    message: 'The preset is removed from this project. Any content previously generated with it is untouched.',
    confirmLabel: 'Delete preset',
    danger: true,
  })
  if (!ok) return
  await props.presets?.remove()
  emit('preset-deleted')
}

function openSaveAs() {
  newPresetName.value = ''
  showSaveAs.value = true
  nextTick(() => newPresetNameInput.value?.focus())
}

async function confirmSaveAs() {
  const name = newPresetName.value.trim()
  if (!name) return
  await props.presets?.saveAs(name)
  showSaveAs.value = false
  emit('preset-saved')
}

// ── Episode status helpers ──────────────────────────────────────────────
function episodeStatusDone(ep: any, key: string): boolean {
  const s = ep?.status
  if (!s) return false
  return !!s[key]
}
function episodeStatusIcon(ep: any, key: string) {
  return episodeStatusDone(ep, key) ? '✓' : '○'
}
function episodeStatusClass(ep: any, key: string) {
  return episodeStatusDone(ep, key) ? 'ok' : 'pending'
}
</script>

<style scoped>
.top-action-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin: 0 0 16px;
  padding: 8px 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 8px;
}

.region {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  min-width: 0;
}
.region-spacer { flex: 1 1 auto; }
.region-label {
  font-size: 14px;
  color: var(--text-muted);
  line-height: 1;
  flex-shrink: 0;
}

.preset-region { flex: 0 1 auto; min-width: 0; }
.preset-select {
  min-width: 160px;
  max-width: 240px;
}

.episode-region {
  flex: 1 1 280px;
  min-width: 0;
}
.episode-selector-wrap {
  flex: 1 1 auto;
  min-width: 0;
}
/* EpisodeSelector ships with its own form-group + label and a "Pending only"
   toggle row. Inside the toolbar we want it compact: drop the label
   (the leading 📺 + the popover already say what this is) and the
   form-group margin (toolbar's own gap handles spacing). */
.episode-region :deep(.form-group) { margin-bottom: 0; }
.episode-region :deep(.form-group > label) { display: none; }

.multi-episode-hint {
  font-size: 12px;
  color: var(--text-muted);
  font-style: italic;
}

.generate-region {
  flex: 0 0 auto;
}

.btn-primary-cta {
  padding: 8px 18px;
  font-size: 13px;
  font-weight: 600;
  border-radius: 6px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

@media (max-width: 720px) {
  .preset-region,
  .episode-region,
  .generate-region {
    flex-basis: 100%;
    justify-content: flex-start;
  }
}
</style>
