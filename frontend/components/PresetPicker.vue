<template>
  <div class="card mt-2">
    <div class="flex gap-2" style="align-items: center; flex-wrap: wrap;">
      <h3 style="margin-right: 8px;">{{ label || 'Preset' }}</h3>
      <select :value="activeId" class="select select-sm" style="max-width: 260px;" @change="onSelect(($event.target as HTMLSelectElement).value)">
        <option value="">— none —</option>
        <option v-for="p in presets" :key="p.id" :value="p.id">
          {{ p.name }}{{ p.id === activeId ? ' (last used)' : '' }}
        </option>
      </select>
      <span v-if="activePresetName" class="last-used-badge">Last used: {{ activePresetName }}</span>
      <button class="btn btn-sm btn-secondary" :disabled="!activeId" @click="$emit('apply')">Apply</button>
      <button class="btn btn-sm btn-secondary" :disabled="!activeId" @click="$emit('overwrite')">Save</button>
      <button class="btn btn-sm btn-secondary" @click="openSaveAs">Save as…</button>
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
  </div>
</template>

<script setup lang="ts">
export interface Preset { id: string; name: string; data: any }

const props = defineProps<{
  presets: Preset[]
  activeId: string
  label?: string
  hint?: string
}>()

const emit = defineEmits<{
  (e: 'update:activeId', id: string): void
  (e: 'apply'): void
  (e: 'overwrite'): void
  (e: 'save-as', name: string): void
  (e: 'delete'): void
}>()

const showSaveAs = ref(false)
const newName = ref('')
const newNameInput = ref<HTMLInputElement | null>(null)

const activePresetName = computed(() => {
  const p = props.presets.find(x => x.id === props.activeId)
  return p?.name || ''
})

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
   in-flow badge that sits next to the dropdown needs component-local styles. */
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
</style>
