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
        <p v-if="loading" role="status">Loading label designs…</p>
        <p v-else-if="error" role="alert">{{ error }} <button type="button" class="btn btn-sm btn-secondary" @click="load">Try again</button></p>
        <p v-else-if="!visibleDesigns.length">No designs match these filters.</p>
        <div v-else class="label-picker-grid">
          <button v-for="design in visibleDesigns" :key="design.id" type="button" class="label-picker-card" :class="{ selected: design.id === modelValue }" :aria-pressed="design.id === modelValue" @click="choose(design.id)">
            <span class="label-picker-sample"><img v-if="design.sample_url && !failedSamples.has(design.id)" :src="design.sample_url" alt="" @error="failedSamples.add(design.id); failedSamples = new Set(failedSamples)" /><span v-else>{{ design.sample_url ? 'Sample unavailable' : 'No sample yet' }}</span></span>
            <strong>{{ design.name }}</strong><small>{{ design.family }} · {{ design.theme }}</small>
          </button>
        </div>
      </div>
    </PickerDialog>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'

const props = defineProps<{ modelValue: string; projectSlug: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
type Design = { id: string; name: string; family: string; theme: string; sample_url: string | null }
const { get } = useApi()
const open = ref(false)
const designs = ref<Design[]>([])
const loading = ref(false)
const error = ref('')
const search = ref('')
const family = ref('')
const theme = ref('')
const failedSamples = ref(new Set<string>())
const families = computed(() => [...new Set(designs.value.map(design => design.family))].sort())
const themes = computed(() => [...new Set(designs.value.map(design => design.theme))].sort())
const visibleDesigns = computed(() => designs.value.filter(design =>
  (!family.value || design.family === family.value) && (!theme.value || design.theme === theme.value)
  && [design.name, design.family, design.theme].join(' ').toLowerCase().includes(search.value.trim().toLowerCase()),
))
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
.label-picker-card { display: grid; gap: .35rem; padding: .65rem; color: inherit; text-align: left; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: .5rem; cursor: pointer; }
.label-picker-card:hover, .label-picker-card.selected { border-color: var(--accent); }
.label-picker-card:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.label-picker-card small { color: var(--text-muted); }
.label-picker-sample { display: grid; place-items: center; aspect-ratio: 16 / 9; padding: .5rem; background: var(--bg-tertiary); color: var(--text-muted); font-size: var(--font-xs); }
.label-picker-sample img { width: 100%; height: 100%; object-fit: contain; }
</style>
