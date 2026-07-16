<!--
  Compact toolbar strip for generator pages. Holds the three things that
  always go together at the start of a generator flow:
    1. Preset picker plus direct actions (Apply / Save / Save as / Rename / Delete)
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
      <span class="region-label">Preset</span>
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
      <!-- v1.0.119+ — Preset actions inlined as buttons. The previous
           ⋯ overflow menu hid common actions (Apply / Save /
           Save as… / Rename / Delete) behind a kebab, which trained the user to
           click twice for the operation they perform every session.
           Matches the PresetPicker row style used elsewhere (Ideas,
           Prompts) so the action set is consistent project-wide. -->
      <div class="preset-actions" role="group" aria-label="Preset actions">
        <button
          type="button"
          class="btn btn-sm btn-secondary"
          :disabled="!hasActivePreset"
          title="Load the preset's saved values into this page's form."
          @click="onApply"
        >Apply</button>
        <button
          type="button"
          class="btn btn-sm btn-secondary"
          :disabled="!hasActivePreset"
          title="Save the page's current values back into the active preset."
          @click="onOverwrite"
        >Save</button>
        <button
          type="button"
          class="btn btn-sm btn-secondary"
          title="Snapshot the current values under a new preset name."
          @click="openSaveAs"
        >Save as…</button>
        <button
          type="button"
          class="btn btn-sm btn-secondary"
          :disabled="!hasActivePreset"
          title="Change the active preset's name without changing its saved settings."
          @click="openRename"
        >Rename</button>
        <button
          type="button"
          class="btn btn-sm btn-danger"
          :disabled="!hasActivePreset"
          title="Remove the active preset from this project."
          @click="onDelete"
        >Delete</button>
      </div>
    </div>

    <!-- Episode region -->
    <div v-if="episodeMode === 'single'" class="region episode-region">
      <span class="region-label">Episode</span>
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
      <span class="region-label">Episodes</span>
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

    <!-- Preset action modals use the same keyboard-safe pattern as PresetPicker. -->
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
        :disabled="savingPreset"
        @keyup.enter.stop.prevent="confirmSaveAs"
      />
      <div class="flex gap-2 mt-2" style="justify-content:flex-end">
        <button type="button" class="btn btn-secondary" :disabled="savingPreset" @click="showSaveAs = false">Cancel</button>
        <button type="button" class="btn btn-primary" :disabled="!newPresetName.trim() || savingPreset" @click="confirmSaveAs">
          {{ savingPreset ? 'Saving…' : 'Save' }}
        </button>
      </div>
    </Modal>

    <Modal
      :visible="showRename"
      size="sm"
      labelledby="top-action-preset-rename-title"
      @close="showRename = false"
    >
      <h3 id="top-action-preset-rename-title">Rename preset</h3>
      <p class="text-muted mt-1 mb-2" style="font-size:12px">
        This changes only the preset name. Its saved settings stay exactly the same.
      </p>
      <input
        v-model="renamePresetName"
        ref="renamePresetNameInput"
        class="input"
        placeholder="Preset name"
        :disabled="renamingPreset"
        @keyup.enter.stop.prevent="confirmRename"
      />
      <div class="flex gap-2 mt-2" style="justify-content:flex-end">
        <button type="button" class="btn btn-secondary" :disabled="renamingPreset" @click="showRename = false">Cancel</button>
        <button type="button" class="btn btn-primary" :disabled="!renamePresetName.trim() || renamingPreset" @click="confirmRename">
          {{ renamingPreset ? 'Renaming…' : 'Rename' }}
        </button>
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
// v1.0.119 — Removed OverflowMenu import + OverflowItem shape: preset
// actions inlined as buttons in the template, no kebab fallback.

// `presets` is the full object returned by usePresets() on the page.
// Typed loosely to avoid pulling the composable's type graph into here;
// the page side is already typed.
const props = withDefaults(defineProps<{
  projectSlug: string
  // Preset hooks (optional — some pages might not have presets)
  presets?: {
    presets: { value: Array<{ id: string; name: string; data: any }> }
    activeId: { value: string }
    setActive: (id: string) => Promise<void>
    applyActive: () => any
    overwrite: () => Promise<any>
    saveAs: (name: string) => Promise<any>
    rename: (name: string) => Promise<any>
    remove: () => Promise<any>
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
  (e: 'preset-renamed'): void
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
const savingPreset = ref(false)
const showRename = ref(false)
const renamePresetName = ref('')
const renamePresetNameInput = ref<HTMLInputElement | null>(null)
const renamingPreset = ref(false)

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

function formatPresetOption(p: { name: string }): string {
  return p.name
}

// v1.0.119 — Preset actions inlined as buttons (no more kebab menu).
// `hasActivePreset` gates Apply / Save / Delete; Save as… is always
// enabled since it captures the current form regardless of selection.
const hasActivePreset = computed(() => !!props.presets?.activeId.value)

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
  if (savingPreset.value) return
  newPresetName.value = ''
  showSaveAs.value = true
  nextTick(() => newPresetNameInput.value?.focus())
}

async function confirmSaveAs() {
  const name = newPresetName.value.trim()
  if (!name || savingPreset.value) return
  savingPreset.value = true
  try {
    await props.presets?.saveAs(name)
    newPresetName.value = ''
    showSaveAs.value = false
    emit('preset-saved')
  } finally {
    savingPreset.value = false
  }
}

function openRename() {
  if (!activePreset.value || renamingPreset.value) return
  renamePresetName.value = activePreset.value.name
  showRename.value = true
  nextTick(() => {
    renamePresetNameInput.value?.focus()
    renamePresetNameInput.value?.select()
  })
}

async function confirmRename() {
  const name = renamePresetName.value.trim()
  if (!name || !activePreset.value || renamingPreset.value) return
  renamingPreset.value = true
  try {
    await props.presets?.rename(name)
    renamePresetName.value = ''
    showRename.value = false
    emit('preset-renamed')
  } finally {
    renamingPreset.value = false
  }
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
  align-items: flex-end;
  gap: 10px 14px;
  margin: 16px 0;
  padding: 12px;
  background: color-mix(in srgb, var(--bg-secondary) 96%, var(--accent) 4%);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: 0 10px 28px color-mix(in srgb, #000 9%, transparent);
}

.region {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}
.region-spacer { flex: 1 1 auto; }
.region-label {
  flex-basis: 100%;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .09em;
  text-transform: uppercase;
  color: var(--text-secondary);
  line-height: 1;
  flex-shrink: 0;
}

.preset-region { flex: 0 1 auto; min-width: 0; }
.preset-select {
  min-width: 160px;
  max-width: 240px;
  min-height: var(--control-height-sm);
}

/* v1.0.119 — inline preset actions (Apply / Save / Save as… / Delete).
   flex-wrap so the row gracefully collapses
   under the dropdown on a tight viewport instead of pushing Generate
   off-screen on the right. gap matches the surrounding region's gap
   so the whole bar reads as one rhythm. */
.preset-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.preset-actions .btn {
  min-height: var(--control-height-sm);
  white-space: nowrap;
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
  align-self: flex-end;
  margin-left: auto;
}

.btn-primary-cta {
  min-height: var(--control-height-md);
  padding: 9px 20px;
  font-size: 13px;
  font-weight: 700;
  border-radius: var(--radius-md);
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.top-action-bar :deep(.select-sm),
.top-action-bar :deep(.input-sm) {
  min-height: var(--control-height-sm);
}

@media (max-width: 720px) {
  .preset-region,
  .episode-region,
  .generate-region {
    flex-basis: 100%;
    justify-content: flex-start;
  }

  .generate-region { margin-left: 0; }
  .btn-primary-cta { width: 100%; justify-content: center; }
}
</style>
