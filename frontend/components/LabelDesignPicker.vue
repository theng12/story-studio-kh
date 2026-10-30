<template>
  <div class="label-picker">
    <button type="button" class="btn btn-sm btn-secondary label-picker-trigger" aria-haspopup="dialog" :aria-expanded="open" @click="show">
      {{ designs.find(design => design.id === modelValue)?.name || modelValue }} · Change
    </button>
    <PickerDialog :visible="open" title="Label designs" description="Choose a treatment for this label." size="xl" close-label="Close label designs" @close="open = false">
      <div class="label-picker-toolbar">
        <input v-model="search" class="input" type="search" aria-label="Search label designs" placeholder="Search designs" />
        <label>Family <select v-model="family" class="select"><option value="">All families</option><option v-for="item in families" :key="item" :value="item">{{ item }}</option></select></label>
        <label>Theme <select v-model="theme" class="select"><option value="">All themes</option><option v-for="item in themes" :key="item" :value="item">{{ item }}</option></select></label>
      </div>
      <div class="label-picker-results">
        <p v-if="saveError" role="alert">{{ saveError }}</p>
        <p v-if="loading" role="status">Loading label designs…</p>
        <p v-else-if="error" role="alert">{{ error }} <button type="button" class="btn btn-sm btn-secondary" @click="load">Try again</button></p>
        <template v-else>
          <p v-if="!visibleDesigns.length">No designs match these filters.</p>
          <div v-else class="label-picker-grid">
            <div v-for="design in visibleDesigns" :key="design.id" class="label-picker-item">
              <button type="button" class="label-picker-card" :class="{ selected: design.id === modelValue }" :aria-pressed="design.id === modelValue" @click="choose(design.id)">
                <span class="label-picker-sample"><img v-if="design.sample_url && !failedSamples.has(design.id)" :src="design.sample_url" alt="" @error="failedSamples.add(design.id); failedSamples = new Set(failedSamples)" /><span v-else>{{ design.sample_url ? 'Sample unavailable' : 'No sample yet' }}</span></span>
                <strong>{{ design.name }}</strong><small>{{ design.family }} · {{ design.theme }}</small>
              </button>
              <button type="button" class="label-picker-action" :disabled="saving" :aria-label="`Hide ${design.name}`" @click="setHidden(design, true)">Hide</button>
            </div>
          </div>
          <section v-if="hiddenDesigns.length" class="label-picker-hidden" aria-label="Hidden designs">
            <h3>Hidden</h3>
            <div v-for="design in hiddenDesigns" :key="design.id" class="label-picker-hidden-row">
              <span>{{ design.name }}</span><button type="button" class="label-picker-action" :disabled="saving" :aria-label="`Restore ${design.name}`" @click="setHidden(design, false)">Restore</button>
            </div>
          </section>
        </template>
      </div>
    </PickerDialog>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'

const props = defineProps<{ modelValue: string; projectSlug: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
type Design = { id: string; name: string; family: string; theme: string; sample_url: string | null; hidden: boolean }
const { get, put } = useApi()
const open = ref(false)
const designs = ref<Design[]>([])
const loading = ref(false)
const error = ref('')
const saveError = ref('')
const saving = ref(false)
const search = ref('')
const family = ref('')
const theme = ref('')
const failedSamples = ref(new Set<string>())
const families = computed(() => [...new Set(designs.value.map(design => design.family))].sort())
const themes = computed(() => [...new Set(designs.value.map(design => design.theme))].sort())
const visibleDesigns = computed(() => designs.value.filter(design =>
  !design.hidden && (!family.value || design.family === family.value) && (!theme.value || design.theme === theme.value)
  && [design.name, design.family, design.theme].join(' ').toLowerCase().includes(search.value.trim().toLowerCase()),
))
const hiddenDesigns = computed(() => designs.value.filter(design => design.hidden))
async function setHidden(design: Design, hidden: boolean) {
  saving.value = true
  saveError.value = ''
  try {
    await put(`/projects/${encodeURIComponent(props.projectSlug)}/sound-and-labels/label-designs/${encodeURIComponent(design.id)}/visibility`, { hidden })
    design.hidden = hidden
  } catch (cause: any) {
    saveError.value = cause?.data?.detail || 'Could not change label visibility. Try again.'
  } finally { saving.value = false }
}
async function load() {
  loading.value = true
  error.value = ''
  try {
    const data = await get<{ designs: Design[] }>(`/projects/${encodeURIComponent(props.projectSlug)}/sound-and-labels/label-designs`)
    designs.value = data.designs
    failedSamples.value = new Set()
  } catch (cause: any) {
    error.value = cause?.data?.detail || 'Could not load label designs.'
  } finally { loading.value = false }
}
function show() { open.value = true; void load() }
function choose(id: string) { emit('update:modelValue', id); open.value = false }
</script>

<style scoped>
.label-picker-trigger { width: 100%; text-align: left; }
.label-picker-toolbar { display: flex; flex-wrap: wrap; gap: .75rem; padding: 1rem; }
.label-picker-toolbar > input { flex: 1 1 12rem; min-width: 0; }
.label-picker-toolbar label { display: grid; gap: .25rem; color: var(--text-muted); font-size: var(--font-xs); }
.label-picker-results { min-height: 0; overflow-y: auto; padding: 0 1rem 1rem; }
.label-picker-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: .75rem; }
.label-picker-item { display: grid; align-content: start; gap: .25rem; }
.label-picker-card { display: grid; gap: .35rem; padding: .65rem; color: inherit; text-align: left; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: .5rem; cursor: pointer; }
.label-picker-action { justify-self: start; border: 0; padding: .3rem .25rem; color: var(--text-muted); background: transparent; cursor: pointer; }
.label-picker-action:hover { color: var(--accent); }
.label-picker-action:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.label-picker-action:disabled { opacity: .5; cursor: wait; }
.label-picker-hidden { margin-top: 1.25rem; }
.label-picker-hidden h3 { font-size: var(--font-sm); }
.label-picker-hidden-row { display: flex; align-items: center; justify-content: space-between; gap: 1rem; border-bottom: 1px solid var(--border); padding: .3rem 0; }
.label-picker-card:hover, .label-picker-card.selected { border-color: var(--accent); }
.label-picker-card:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.label-picker-card small { color: var(--text-muted); }
.label-picker-sample { display: grid; place-items: center; aspect-ratio: 16 / 9; padding: .5rem; background: var(--bg-tertiary); color: var(--text-muted); font-size: var(--font-xs); }
.label-picker-sample img { width: 100%; height: 100%; object-fit: contain; }
</style>
