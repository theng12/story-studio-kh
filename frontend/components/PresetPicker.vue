<template>
  <div class="card mt-2">
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
      <button
        class="btn btn-sm btn-secondary"
        :disabled="!activeId || activePresetIsBuiltIn"
        :title="activePresetIsBuiltIn ? 'Built-in presets can\'t be overwritten. Use Save as… to make your own copy.' : ''"
        @click="$emit('overwrite')"
      >Save</button>
      <details class="preset-more">
        <summary class="btn btn-sm btn-secondary" aria-label="More preset actions">More</summary>
        <div class="preset-more-menu" role="group" aria-label="More preset actions">
          <button type="button" class="preset-menu-item" @click="openSaveAs">Save as…</button>
          <button
            type="button"
            class="preset-menu-item"
            :disabled="!activeId || activePresetIsBuiltIn"
            :title="activePresetIsBuiltIn ? 'Built-in presets can\'t be renamed.' : ''"
            @click="openRename"
          >Rename</button>
          <button
            type="button"
            class="preset-menu-item preset-menu-danger"
            :disabled="!activeId || activePresetIsBuiltIn"
            :title="activePresetIsBuiltIn ? 'Built-in presets can\'t be deleted.' : ''"
            @click="confirmDelete"
          >Delete</button>
        </div>
      </details>
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
        Saves these settings as a local preset for this project so you can reuse them here and in Pipeline.
      </p>
      <input
        v-model="newName"
        ref="newNameInput"
        class="input"
        placeholder="e.g. Default, Sleep Stories, Shorts"
        @keyup.enter.stop.prevent="confirmSaveAs"
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
        Only the label changes. The preset's settings stay exactly the same everywhere it is used.
      </p>
      <input
        v-model="renameName"
        ref="renameInput"
        class="input"
        placeholder="New name"
        @keyup.enter.stop.prevent="confirmRename"
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
import { useDismissableDetails } from '../composables/useDismissableDetails.js'

export interface Preset {
  id: string
  name: string
  data: any
  builtin?: boolean
}

const props = defineProps<{
  presets: Preset[]
  activeId: string
  label?: string
  hint?: string
  /** Built-in presets are app-shipped defaults and can't be mutated. */
  activePresetIsBuiltIn?: boolean
}>()

const emit = defineEmits<{
  (e: 'update:activeId', id: string): void
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

/** Render the single local preset list with useful built-in/last-used tags. */
function formatOption(p: Preset): string {
  return p.name
    + (p.builtin ? ' · built-in' : '')
    + (p.id === props.activeId ? ' (last used)' : '')
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
  newName.value = ''
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
  renameName.value = ''
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

// A <details> menu does not close on an outside click by itself.
useDismissableDetails()
</script>

<style scoped>
/* Modal chrome (overlay, backdrop, focus trap, animations) is owned by the
   shared Modal primitive. This block stays small on purpose — only the
   in-flow chips that sit next to the dropdown need component-local styles. */
.last-used-badge {
  display: inline-flex; align-items: center;
  padding: 2px 10px;
  font-size: var(--font-xs); font-weight: 500;
  color: var(--accent);
  background: rgba(240, 198, 116, 0.12);
  border: 1px solid rgba(240, 198, 116, 0.25);
  border-radius: 999px;
  white-space: nowrap;
}

.preset-more { position: relative; }
.preset-more > summary { list-style: none; user-select: none; }
.preset-more > summary::-webkit-details-marker { display: none; }
.preset-more[open] > summary { border-color: var(--accent); background: var(--accent-dim); }
.preset-more-menu {
  position: absolute;
  z-index: 80;
  top: calc(100% + 6px);
  right: 0;
  display: grid;
  width: 170px;
  padding: 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-secondary);
  box-shadow: var(--shadow-lg);
}
.preset-menu-item {
  min-height: 36px;
  padding: 7px 10px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-primary);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.preset-menu-item:hover:not(:disabled) { background: var(--bg-hover); }
.preset-menu-item:disabled { color: var(--text-muted); cursor: not-allowed; }
.preset-menu-danger { color: var(--error); }

</style>
