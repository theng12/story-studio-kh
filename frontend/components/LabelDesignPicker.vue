<template>
  <div v-if="preset" class="label-picker">
    <p>Choose any themes and motions for proposals. If none are chosen, labels use the usual designs and fade.</p>
    <p v-if="loading" role="status">Loading label themes…</p>
    <p v-else-if="error" role="alert">{{ error }} <button type="button" class="btn btn-sm btn-secondary" @click="load">Try again</button></p>
    <p v-else-if="!themeSamples.length">No visible label themes are available.</p>
    <fieldset v-else class="preset-choices">
      <legend>Label themes</legend>
      <div class="label-picker-grid">
        <button v-for="design in themeSamples" :key="design.theme" type="button" class="label-picker-card" :aria-pressed="selectedThemes.includes(design.theme)" @click="toggle('themes', design.theme)">
          <span class="label-picker-sample"><img v-if="design.sample_url && !failedSamples.has(design.id)" :src="design.sample_url" alt="" @error="failedSamples.add(design.id); failedSamples = new Set(failedSamples)" /><span v-else>Sample unavailable</span></span>
          <strong>{{ design.theme }}</strong>
        </button>
      </div>
    </fieldset>
    <div v-if="selectedThemes.some(theme => !themeSamples.some(design => design.theme === theme))" class="preset-choices">
      <p>Selected themes that are unavailable:</p>
      <button v-for="theme in selectedThemes.filter(theme => !themeSamples.some(design => design.theme === theme))" :key="theme" type="button" class="btn btn-sm btn-secondary" @click="toggle('themes', theme)">Remove {{ theme }}</button>
    </div>
    <fieldset class="preset-choices">
      <legend>Label motions</legend>
      <div class="motion-list">
        <button v-for="item in motions.filter(item => item.id)" :key="item.id" type="button" class="motion-choice" :aria-pressed="selectedMotions.includes(item.id)" @click="toggle('motions', item.id)">
          <span class="motion-sample"><span v-if="item.id === 'line-draw'" class="sample-line" /><span :class="`sample-${item.id}`">Label</span></span>{{ item.name }}
        </button>
      </div>
    </fieldset>
  </div>
  <div v-else class="label-picker">
    <button type="button" class="btn btn-sm btn-secondary label-picker-trigger" aria-haspopup="dialog" :aria-expanded="open" @click="show">
      {{ designs.find(design => design.id === modelValue)?.name || modelValue }} · Change
    </button>
    <div v-if="modelValue.startsWith('label:')" class="motion-list" aria-label="Label motion">
      <button v-for="item in motions" :key="item.id" type="button" class="motion-choice" :aria-pressed="(motion || '') === item.id" @click="emit('update:motion', item.id)">
        <span class="motion-sample"><span v-if="item.id === 'line-draw'" class="sample-line" /><span :class="`sample-${item.id}`">Label</span></span>{{ item.name }}
      </button>
    </div>
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
import { computed, ref, watch } from 'vue'

const props = withDefaults(defineProps<{ modelValue?: string; projectSlug: string; motion?: string; preset?: boolean; selectedThemes?: string[]; selectedMotions?: string[] }>(), { modelValue: '', selectedThemes: () => [], selectedMotions: () => [] })
const emit = defineEmits<{ 'update:modelValue': [value: string]; 'update:motion': [value: string]; 'update:selectedThemes': [value: string[]]; 'update:selectedMotions': [value: string[]] }>()
const motions = [
  { id: '', name: 'Still' }, { id: 'pop', name: 'Pop' }, { id: 'slide', name: 'Slide' },
  { id: 'pulse', name: 'Pulse' }, { id: 'float', name: 'Float' },
  { id: 'wipe', name: 'Wipe' }, { id: 'line-draw', name: 'Line draw' },
]
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
const themeSamples = computed(() => themes.value.flatMap(theme => {
  const design = designs.value.find(item => item.theme === theme && !item.hidden)
  return design ? [design] : []
}))
function toggle(kind: 'themes' | 'motions', value: string) {
  const current = kind === 'themes' ? props.selectedThemes : props.selectedMotions
  const next = current.includes(value) ? current.filter(item => item !== value) : [...current, value]
  if (kind === 'themes') emit('update:selectedThemes', next)
  else emit('update:selectedMotions', next)
}
watch(() => [props.preset, props.projectSlug] as const, ([preset]) => { if (preset) void load() }, { immediate: true })
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
.preset-choices { border: 0; padding: 0; margin: .75rem 0; min-width: 0; }
.preset-choices legend { font-weight: 600; }
.label-picker-card[aria-pressed="true"] { border-color: var(--accent); }
.motion-choice:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.motion-list { display: flex; flex-wrap: wrap; gap: .35rem; margin-top: .5rem; }
.motion-choice { display: grid; gap: .2rem; text-align: center; color: inherit; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: .35rem; cursor: pointer; }
.motion-choice[aria-pressed="true"] { border-color: var(--accent); }
.motion-sample { width: 72px; height: 35px; display: grid; place-items: center; overflow: hidden; position: relative; background: var(--bg-tertiary); }
.motion-sample > span:not(.sample-line) { background: #f4c75d; color: #242322; padding: 2px 5px; }
.sample-wipe { animation: wipe 2s infinite; }
.sample-slide { animation: slide 2s infinite; }
.sample-pop { animation: pop 2s infinite; }
.sample-pulse { animation: pulse 2s infinite; }
.sample-float { animation: float 2s infinite; }
.sample-line { position: absolute; left: 48%; top: 65%; width: 45%; height: 2px; background: #f4c75d; transform-origin: left; animation: line-draw 2s infinite; }
@keyframes wipe { 0%, 10% { clip-path: inset(0 100% 0 0); } 30%, 100% { clip-path: inset(0); } }
@keyframes line-draw { 0%, 10% { transform: scaleX(0); } 30%, 100% { transform: scaleX(1); } }
@keyframes slide { 0%, 10% { transform: translateX(-80px); } 30%, 100% { transform: translateX(0); } }
@keyframes pop { 0%, 10% { transform: scale(.8); } 25% { transform: scale(1.05); } 35%, 100% { transform: scale(1); } }
@keyframes pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.05); } }
@keyframes float { 0%, 100% { transform: translateY(-3px); } 50% { transform: translateY(3px); } }
@media (prefers-reduced-motion: reduce) { .motion-sample span { animation: none; } }
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
