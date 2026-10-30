<template>
  <div class="font-picker">
    <button
      type="button"
      class="fp-trigger"
      aria-haspopup="dialog"
      :aria-expanded="open"
      @click="open = true"
    >
      <span v-if="currentLabel" class="fp-trigger-name" :style="triggerStyle">{{ currentLabel }}</span>
      <span v-else class="fp-trigger-name fp-muted">No font chosen</span>
      <span class="fp-chev ds-chevron" data-dir="down" aria-hidden="true" />
    </button>

    <!--
      The owner's rule, 2026-10-30: "everything that can be a visual option,
      must be a visual option." A font is not a word in a list — the row draws
      the face itself, so the choice is made by looking, not by recognising a
      name. A family this browser cannot draw says so instead of showing a
      fallback that would pass for it.
    -->
    <PickerDialog
      :visible="open"
      :title="title"
      :description="description"
      :count="`${options.length} fonts`"
      close-label="Close font picker"
      @close="open = false"
    >
      <div class="fp-list" role="listbox" :aria-label="title">
        <button
          v-for="option in options"
          :key="option.value"
          type="button"
          class="fp-option"
          :class="{ 'is-selected': option.value === modelValue }"
          role="option"
          :aria-selected="option.value === modelValue"
          @click="choose(option)"
        >
          <span v-if="hasSample(option)" class="fp-face" :style="{ fontFamily: faceOf(option) }">{{ specimen }}</span>
          <span v-else class="fp-face fp-face-empty">No sample yet</span>
          <span class="fp-name">
            <strong>{{ option.label }}</strong>
            <span v-if="option.value === modelValue" class="fp-check" aria-label="Selected">✓</span>
          </span>
        </button>
      </div>
    </PickerDialog>
  </div>
</template>

<script setup lang="ts">
/**
 * Font chooser: the shared popup all three font fields open — Thumbnail Text,
 * Thumbnail Template and Subtitle Style.
 *
 * Callers keep their own field label, hint and write path; this component owns
 * only the trigger (the current face, drawn in itself) and the list. Options
 * carry a `family` to draw — the CSS family, which may be a stack — and an
 * option without one (a custom family nothing has named yet) has no sample.
 */
import { computed, ref } from 'vue'
import { fontSampleAvailable } from '../utils/font-sample'

interface FontPickerOption {
  value: string
  label: string
  /** CSS family to draw. Defaults to the label, which is how families are written. */
  family?: string
}

const props = withDefaults(defineProps<{
  options: FontPickerOption[]
  /** The saved value. Display and selection only — this component never writes. */
  modelValue?: string | null
  title: string
  description?: string
  /** The words drawn in each face. Empty falls back to a fixed specimen. */
  sample?: string
}>(), { modelValue: null, description: '', sample: '' })

const emit = defineEmits<{ select: [value: string] }>()

const open = ref(false)

const DEFAULT_SPECIMEN = 'Aa — The quick brown fox jumps'

const current = computed(() => props.options.find(option => option.value === props.modelValue) ?? null)
const currentLabel = computed(() => current.value?.label ?? (props.modelValue || ''))
/** A saved value the list does not carry still draws as itself, if it can. */
const currentFamily = computed(() => current.value?.family ?? (current.value ? current.value.label : props.modelValue || ''))
const triggerStyle = computed(() => (
  fontSampleAvailable(currentFamily.value) === false ? undefined : { fontFamily: currentFamily.value }
))
const specimen = computed(() => props.sample?.trim() || DEFAULT_SPECIMEN)

function faceOf(option: FontPickerOption): string {
  return option.family ?? option.label
}

function hasSample(option: FontPickerOption): boolean {
  return fontSampleAvailable(faceOf(option)) !== false
}

function choose(option: FontPickerOption) {
  emit('select', option.value)
  open.value = false
}
</script>

<style scoped>
.font-picker { min-width: 0; }

.fp-trigger {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: var(--font-sm);
  text-align: left;
  cursor: pointer;
}
.fp-trigger:hover { border-color: var(--border-light); }
.fp-trigger:focus-visible { outline: none; border-color: var(--accent); box-shadow: var(--focus-ring); }
.fp-trigger-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fp-chev { color: var(--text-muted); }

.fp-list {
  display: grid;
  min-height: 0;
  flex: 1;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 10px;
  padding: 14px 16px 18px;
  overflow-y: auto;
}

.fp-option {
  display: grid;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-primary);
  color: var(--text-primary);
  text-align: left;
  cursor: pointer;
}
.fp-option:hover { border-color: var(--border-light); }
.fp-option:focus-visible { outline: none; border-color: var(--accent); box-shadow: var(--focus-ring); }
.fp-option.is-selected { border-color: var(--accent); }

.fp-face {
  display: block;
  overflow: hidden;
  color: var(--text-primary);
  font-size: 19px;
  line-height: 1.3;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fp-face-empty { color: var(--text-muted); font-size: var(--font-xs); font-style: italic; }

.fp-name { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.fp-name strong { min-width: 0; overflow: hidden; font-size: var(--font-sm); text-overflow: ellipsis; white-space: nowrap; }
.fp-check { flex: none; color: var(--accent); font-size: var(--font-sm); }

.fp-muted { color: var(--text-muted); }
</style>
