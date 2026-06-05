<template>
  <div class="card mt-2">
    <!-- v1.0.93+ cross-device banner.
         Appears above the picker controls when the currently-active preset
         was saved on a different Mac. Calls out the device name so the
         user knows where the file paths originated, and points at the
         path-check banner below (rendered by the page, not this component)
         for the actionable reselection step. Yellow so it reads as
         "heads up, you might need to do something" rather than red
         "this is broken". -->
    <div v-if="activePresetIsCrossDevice" class="cross-device-banner">
      <span class="banner-icon" aria-hidden="true">⚠</span>
      <span class="banner-text">
        Saved on <strong>{{ activePresetMachineLabel || 'another device' }}</strong>
        — file paths may not exist on this Mac. See the path-check below.
      </span>
    </div>

    <div class="flex gap-2" style="align-items: center; flex-wrap: wrap;">
      <h3 style="margin-right: 8px;">{{ label || 'Preset' }}</h3>
      <select :value="activeId" class="select select-sm" style="max-width: 280px;" @change="onSelect(($event.target as HTMLSelectElement).value)">
        <option value="">— none —</option>
        <option v-for="p in presets" :key="p.id" :value="p.id">
          {{ formatOption(p) }}
        </option>
      </select>
      <span v-if="activePresetName" class="last-used-badge">Last used: {{ activePresetName }}</span>
      <button class="btn btn-sm btn-secondary" :disabled="!activeId" @click="$emit('apply')">Apply</button>
      <button class="btn btn-sm btn-secondary" :disabled="!activeId" @click="$emit('overwrite')">Save</button>
      <button class="btn btn-sm btn-secondary" @click="openSaveAs">Save as…</button>
      <!-- v1.0.284 — rename the active preset in place. Same modal shape as
           Save-as (single input + Enter to confirm), pre-filled with the
           current name. Surfaces here because the management page (Presets
           tab) is too far away when you just want to fix a typo without
           leaving the generator you're working in. -->
      <button class="btn btn-sm btn-secondary" :disabled="!activeId" @click="openRename">Rename</button>

      <!-- v1.0.93+ device-filter toggle.
           Only renders when there's actually something to toggle to (at
           least one cross-device preset exists for this section's type).
           Hiding it on small projects keeps the toolbar uncluttered for
           single-device users. -->
      <button
        v-if="showDeviceToggle"
        type="button"
        class="btn btn-sm btn-secondary device-toggle"
        :class="{ 'is-all': showAllDevices }"
        :title="showAllDevices
          ? 'Showing presets from every Mac you\'ve used. Click to hide other devices.'
          : `Showing only presets saved on this Mac (${currentMachineLabel || 'this device'}). ${crossDeviceCount} preset${crossDeviceCount === 1 ? '' : 's'} from other devices are hidden.`"
        @click="$emit('update:showAllDevices', !showAllDevices)"
      >
        <template v-if="showAllDevices">🌐 All devices · {{ presets.length }}</template>
        <template v-else>📍 This device · {{ presets.length }}<span v-if="crossDeviceCount > 0" class="cross-device-stash"> (+{{ crossDeviceCount }})</span></template>
      </button>

      <button class="btn btn-sm btn-danger" :disabled="!activeId" @click="confirmDelete">Delete</button>
    </div>
    <p v-if="hint" class="text-muted mt-1" style="font-size: 12px;">{{ hint }}</p>

    <!-- Save-as modal — uses the shared Modal primitive for overlay + trap. -->
    <Modal
      :visible="showSaveAs"
      size="sm"
      labelledby="preset-save-as-title"
      @close="showSaveAs = false"
    >
      <h3 id="preset-save-as-title">Save preset as…</h3>
      <p class="text-muted mt-1 mb-2" style="font-size:12px">
        Snapshots the current settings on this tab so you can reuse them later. Required for Pipeline.
        <span v-if="currentMachineLabel">
          Saved as <strong>{{ currentMachineLabel }}</strong>'s preset — visible on this Mac by default,
          and to other Macs via the "🌐 All devices" toggle.
        </span>
      </p>
      <input
        v-model="newName"
        ref="newNameInput"
        class="input"
        placeholder="e.g. Default, Sleep Stories, Shorts"
        @keydown.enter="confirmSaveAs"
      />
      <div class="flex gap-2 mt-2" style="justify-content:flex-end">
        <button class="btn btn-secondary" @click="showSaveAs = false">Cancel</button>
        <button class="btn btn-primary" :disabled="!newName.trim()" @click="confirmSaveAs">Save</button>
      </div>
    </Modal>

    <!-- v1.0.284 — Rename modal. Same primitive as Save-as for visual
         consistency; the only difference is the input pre-fills with the
         current name so the user can edit (not retype) it. -->
    <Modal
      :visible="showRename"
      size="sm"
      labelledby="preset-rename-title"
      @close="showRename = false"
    >
      <h3 id="preset-rename-title">Rename preset</h3>
      <p class="text-muted mt-1 mb-2" style="font-size:12px">
        Only the label changes — the preset's settings stay exactly the same. Other Macs
        viewing this preset will see the new name next time they load.
      </p>
      <input
        v-model="renameName"
        ref="renameInput"
        class="input"
        placeholder="New name"
        @keydown.enter="confirmRename"
        @keydown.escape="showRename = false"
      />
      <div class="flex gap-2 mt-2" style="justify-content:flex-end">
        <button class="btn btn-secondary" @click="showRename = false">Cancel</button>
        <button class="btn btn-primary" :disabled="!renameName.trim() || renameName.trim() === currentName" @click="confirmRename">Rename</button>
      </div>
    </Modal>
  </div>
</template>

<script setup lang="ts">
export interface Preset {
  id: string
  name: string
  data: any
  /** v1.0.93+ device tag (hostname). Missing on legacy presets — those
   *  pass through the filter, and the picker labels them `(legacy)`. */
  machine_label?: string
}

const props = defineProps<{
  presets: Preset[]
  activeId: string
  label?: string
  hint?: string
  /** v1.0.93+ — hostname of the current Mac (from useMachineLabel). When
   *  present, the picker filters presets to this device by default and
   *  shows the toggle. Empty string disables the device filter entirely
   *  (legacy callers that don't opt in see the original behaviour). */
  currentMachineLabel?: string
  /** v-model: whether the user has flipped to "show all devices". */
  showAllDevices?: boolean
  /** Count of cross-device presets currently hidden (rendered as "+N"
   *  next to the "This device" toggle label). */
  crossDeviceCount?: number
  /** Whether the active preset comes from a different Mac. Drives the
   *  yellow banner above the picker. */
  activePresetIsCrossDevice?: boolean
  /** Hostname stamped on the active preset (e.g. "Macbook-Pro"). Shown
   *  in the cross-device banner so the user knows where it came from. */
  activePresetMachineLabel?: string
}>()

const emit = defineEmits<{
  (e: 'update:activeId', id: string): void
  (e: 'update:showAllDevices', value: boolean): void
  (e: 'apply'): void
  (e: 'overwrite'): void
  (e: 'save-as', name: string): void
  (e: 'rename', name: string): void
  (e: 'delete'): void
}>()

const showSaveAs = ref(false)
const newName = ref('')
const newNameInput = ref<HTMLInputElement | null>(null)

// v1.0.284 — rename modal state. Kept separate from save-as so opening one
// doesn't disturb the other's input value.
const showRename = ref(false)
const renameName = ref('')
const renameInput = ref<HTMLInputElement | null>(null)

const activePresetName = computed(() => {
  const p = props.presets.find(x => x.id === props.activeId)
  return p?.name || ''
})
const currentName = computed(() => activePresetName.value)

// Only render the device toggle when there's actually something to toggle.
// Calling out a feature that does nothing (zero cross-device presets) is
// noise; surfacing it the moment a second device touches the project is
// when it earns its place in the toolbar.
const showDeviceToggle = computed(() => {
  if (!props.currentMachineLabel) return false
  return (props.crossDeviceCount ?? 0) > 0
})

/** Render an option label. Appends `· ⌂ <machine>` when the user is in
 *  "all devices" mode so they can tell each preset apart. Adds `(legacy)`
 *  on presets without a machine_label so they're flagged as "could be
 *  from any device — re-save to claim them". */
function formatOption(p: Preset): string {
  const base = p.name + (p.id === props.activeId ? ' (last used)' : '')
  if (props.showAllDevices) {
    if (!p.machine_label) return `${base} · (legacy)`
    return `${base} · ⌂ ${p.machine_label}`
  }
  // In "this device" mode, only legacy entries need the chip — they're
  // showing here only because the filter passes undefined machine_label
  // through. Stamping them isn't automatic, so we surface the (legacy)
  // marker so the user knows the entry isn't strictly "this device".
  if (!p.machine_label && props.currentMachineLabel) return `${base} · (legacy)`
  return base
}

function onSelect(id: string) { emit('update:activeId', id) }

function openSaveAs() {
  newName.value = ''
  showSaveAs.value = true
  nextTick(() => newNameInput.value?.focus())
}

function confirmSaveAs() {
  const name = newName.value.trim()
  if (!name) return
  emit('save-as', name)
  showSaveAs.value = false
}

// v1.0.284 — rename flow. Pre-fills the input with the current name (so
// the user edits rather than retypes), focuses + selects on open. Confirm
// only fires when the trimmed value differs from the current name — the
// Rename button is disabled otherwise so a stray Enter doesn't no-op fire.
function openRename() {
  if (!props.activeId) return
  renameName.value = currentName.value
  showRename.value = true
  nextTick(() => {
    renameInput.value?.focus()
    renameInput.value?.select()
  })
}
function confirmRename() {
  const name = renameName.value.trim()
  if (!name || name === currentName.value) return
  emit('rename', name)
  showRename.value = false
}

async function confirmDelete() {
  const p = props.presets.find(x => x.id === props.activeId)
  if (!p) return
  const { ask } = useConfirm()
  const ok = await ask({
    title: `Delete preset "${p.name}"?`,
    message: 'The preset is removed from this project. Content saved using it stays on disk.',
    confirmLabel: 'Delete preset',
    danger: true,
  })
  if (!ok) return
  emit('delete')
}
</script>

<style scoped>
/* Modal chrome (overlay, backdrop, focus trap, animations) is owned by the
   shared Modal primitive. This block stays small on purpose — only the
   in-flow chips that sit next to the dropdown need component-local styles. */
.last-used-badge {
  display: inline-flex; align-items: center;
  padding: 2px 10px;
  font-size: 11px; font-weight: 500;
  color: var(--accent);
  background: rgba(240, 198, 116, 0.12);
  border: 1px solid rgba(240, 198, 116, 0.25);
  border-radius: 999px;
  white-space: nowrap;
}

/* v1.0.93+ device-filter toggle. Stays visually grouped with the action
   buttons (same size + radius), but gets an active-state colour shift when
   the user flips to "all devices" so the surface change is unmissable. */
.device-toggle {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.device-toggle.is-all {
  background: rgba(108, 143, 255, 0.16);
  border-color: rgba(108, 143, 255, 0.35);
  color: var(--accent, #6c8fff);
}
.cross-device-stash {
  margin-left: 4px;
  color: var(--text-muted);
  font-weight: normal;
}

/* v1.0.93+ cross-device banner. Yellow because it's a heads-up, not a
   blocker — the apply still happens; the user just needs to know paths
   may need reselecting. The matching apply-time path-check banner lives
   on the page (audio-merge.vue / video-assembly.vue) so it can render the
   "Pick replacement" buttons wired to the page's existing file pickers. */
.cross-device-banner {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-bottom: 10px;
  padding: 8px 12px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-secondary);
  background: rgba(240, 198, 116, 0.08);
  border: 1px solid rgba(240, 198, 116, 0.30);
  border-radius: var(--radius-sm, 4px);
}
.cross-device-banner .banner-icon {
  color: rgba(240, 198, 116, 0.9);
  font-weight: 600;
  font-size: 13px;
  flex-shrink: 0;
}
</style>
