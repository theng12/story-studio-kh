<template>
  <div class="reveal-picker">
    <button type="button" class="select trigger" :disabled="disabled" :aria-label="label" aria-haspopup="dialog" :aria-expanded="open" @click="show">
      <span>{{ triggerText }}</span><span aria-hidden="true">▾</span>
    </button>
    <PickerDialog :visible="open" :title="title" :description="description" size="xl" @close="open = false">
      <div class="picker-content">
        <label class="weight">Line weight for this episode
          <select v-model="draftWeight" class="select" aria-label="Sample line weight">
            <option value="thin">Thin</option><option value="normal">Normal</option><option value="bold">Bold</option>
          </select>
        </label>
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <div v-if="!multiple" class="other-choices">
          <button v-if="inheritLabel" type="button" class="btn btn-sm" @click="choose(inheritValue)">{{ inheritLabel }}</button>
          <button v-if="allowMix" type="button" class="btn btn-sm" @click="choose('mix')">Mix — a different style per scene</button>
        </div>
        <div class="grid">
          <button v-for="item in reveals" :key="item.id" type="button" class="card" :aria-pressed="multiple ? draftMix.includes(item.id) : modelValue === item.id" @click="multiple ? toggle(item.id) : choose(item.id)">
            <span class="sample">
              <video :key="`${item.id}-${draftWeight}`" :src="`/api/sketch-reveals/${encodeURIComponent(item.id)}/sample?weight=${draftWeight}`" autoplay loop muted playsinline preload="metadata" @loadeddata="ready[item.id] = true" @error="failed[item.id] = true" />
              <small v-if="!ready[item.id]">{{ failed[item.id] ? 'Sample unavailable' : 'Preparing sample…' }}</small>
            </span>
            <strong>{{ item.label }}</strong>
          </button>
        </div>
        <p v-if="Object.values(failed).some(Boolean)" class="error" role="status">One or more samples could not be rendered. Check that the current Sketch Draw helper is available.</p>
        <button v-if="multiple" type="button" class="btn btn-primary" :disabled="draftMix.length < 2" @click="applyMix">Use {{ draftMix.length }} styles</button>
      </div>
    </PickerDialog>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'

const props = withDefaults(defineProps<{
  modelValue: string
  reveals: Array<{ id: string; label: string }>
  weight: 'thin' | 'normal' | 'bold'
  label: string
  title: string
  description?: string
  inheritLabel?: string
  inheritValue?: string
  allowMix?: boolean
  multiple?: boolean
  mix?: string[]
  disabled?: boolean
  error?: string
}>(), { description: '', inheritLabel: '', inheritValue: '', allowMix: false, multiple: false, mix: () => [], disabled: false, error: '' })
const emit = defineEmits<{ pick: [value: string]; mix: [value: string[]]; weight: [value: 'thin' | 'normal' | 'bold'] }>()
const open = ref(false)
const draftWeight = ref(props.weight)
const draftMix = ref<string[]>([])
const ready = reactive<Record<string, boolean>>({})
const failed = reactive<Record<string, boolean>>({})
const triggerText = computed(() => props.multiple ? `Choose Mix styles (${props.mix.length})` : props.modelValue === props.inheritValue && props.inheritLabel ? props.inheritLabel : props.modelValue === 'mix' ? 'Mix — a different style per scene' : props.reveals.find(item => item.id === props.modelValue)?.label || props.modelValue || 'Choose a reveal')
watch(draftWeight, () => { for (const k of Object.keys(ready)) delete ready[k]; for (const k of Object.keys(failed)) delete failed[k] })
function show() { draftWeight.value = props.weight; draftMix.value = [...props.mix]; for (const k of Object.keys(ready)) delete ready[k]; for (const k of Object.keys(failed)) delete failed[k]; open.value = true }
function saveWeight() { if (draftWeight.value !== props.weight) emit('weight', draftWeight.value) }
function choose(value: string) { saveWeight(); emit('pick', value); open.value = false }
function toggle(value: string) { draftMix.value = draftMix.value.includes(value) ? draftMix.value.filter(item => item !== value) : [...draftMix.value, value] }
function applyMix() { saveWeight(); emit('mix', draftMix.value); open.value = false }
</script>

<style scoped>
.trigger { display: flex; justify-content: space-between; gap: 1em; text-align: left; width: 100%; cursor: pointer; }
.picker-content { padding: 16px; overflow-y: auto; }
.weight { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-bottom: 12px; }
.weight select { width: auto; }
.other-choices { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 12px; margin-bottom: 14px; }
.card { display: grid; gap: 8px; padding: 8px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg-primary); color: var(--text-primary); text-align: left; cursor: pointer; }
.card[aria-pressed='true'] { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.sample { display: block; aspect-ratio: 16 / 9; background: var(--bg-secondary); overflow: hidden; border-radius: 6px; }
video { display: block; width: 100%; height: 100%; object-fit: cover; }
.error { color: var(--text-danger, #c33); }
</style>
