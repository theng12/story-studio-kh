<template>
  <!-- One control for "which folder?" everywhere a path is chosen.

       Shows the folder as a short friendly path (~/Documents/…/episodes) with the
       full path on hover, a "Choose…" button that opens the Mac's own folder
       picker (Electron's dialog via POST /system/pick-folder; the in-app browser
       in server mode — both through usePathPicker), "Show in Finder", and a
       typed-path fallback for when no native picker exists (dev server, plain
       browser). The full path is what is emitted and saved; the short one is
       display only.

       Usage:
         <FolderField
           v-model="exportRoot"
           label="Where finished videos go"
           hint="Story Studio creates one folder per episode inside it."
           picker-title="Where should finished videos go?"
           picker-button-label="Use This Folder"
           clearable clear-label="Use Default"
           @change="saveExportRoot"
         />

       - v-model / `modelValue` — the full absolute path ('' = none chosen).
       - `@change(path)`  — fires once after the user picks, types, or clears
                            (not on programmatic updates); save from here.
       - `hint` or #hint  — one visible sentence under the field.
       - `allowTyping`    — offer "Type a Path" (default on).
       - `revealable`     — offer "Show in Finder" when a path is set (default on).
       - `clearable`      — offer a clear button labelled `clearLabel`. -->
  <div class="folder-field" :class="{ 'is-empty': !modelValue, 'is-disabled': disabled }">
    <label v-if="label" :for="editing ? inputId : undefined" class="folder-field-label">{{ label }}</label>
    <div class="folder-field-row" role="group" :aria-label="label || undefined">
      <span class="folder-field-icon" aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round">
          <path d="M1.75 4.25c0-.83.67-1.5 1.5-1.5h3.1l1.4 1.5h5c.83 0 1.5.67 1.5 1.5v6c0 .83-.67 1.5-1.5 1.5H3.25c-.83 0-1.5-.67-1.5-1.5v-7.5Z" />
        </svg>
      </span>
      <input
        v-if="editing"
        :id="inputId"
        ref="inputEl"
        v-model="draft"
        class="input input-sm folder-field-input"
        :placeholder="typedPlaceholder"
        spellcheck="false"
        autocomplete="off"
        @keydown.enter.prevent="commitTyped"
        @keydown.esc.prevent="cancelTyped"
      >
      <span
        v-else
        class="folder-field-path"
        :class="{ 'is-placeholder': !modelValue }"
        :title="modelValue || undefined"
      >{{ display || placeholder }}</span>
      <div class="folder-field-actions">
        <template v-if="editing">
          <button type="button" class="btn btn-sm btn-primary" :disabled="!draft.trim()" @click="commitTyped">Use This Path</button>
          <button type="button" class="btn btn-sm btn-quiet" @click="cancelTyped">Cancel</button>
        </template>
        <template v-else>
          <button type="button" class="btn btn-sm btn-secondary" :disabled="disabled || picking" @click="choose">
            {{ picking ? 'Choosing…' : chooseLabel }}
          </button>
          <button v-if="modelValue && revealable" type="button" class="btn btn-sm btn-quiet" :disabled="revealing" @click="reveal">Show in Finder</button>
          <button v-if="allowTyping" type="button" class="btn btn-sm btn-quiet" :disabled="disabled" @click="startTyping">Type a Path</button>
          <button v-if="clearable && modelValue" type="button" class="btn btn-sm btn-quiet" :disabled="disabled" @click="clear">{{ clearLabel }}</button>
        </template>
      </div>
    </div>
    <p v-if="message" class="hint folder-field-message" :data-tone="messageTone" role="status">{{ message }}</p>
    <p v-else-if="hint || $slots.hint" class="hint folder-field-hint"><slot name="hint">{{ hint }}</slot></p>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue'
import { pickFolder } from '../composables/usePathPicker'
import { friendlyPath } from '../utils/friendly-path'

const props = withDefaults(defineProps<{
  modelValue?: string | null
  label?: string
  hint?: string
  placeholder?: string
  typedPlaceholder?: string
  pickerTitle?: string
  pickerButtonLabel?: string
  chooseLabel?: string
  clearLabel?: string
  disabled?: boolean
  allowTyping?: boolean
  revealable?: boolean
  clearable?: boolean
  /** Longest friendly path shown before middle folders collapse into `…`. */
  maxLength?: number
}>(), {
  modelValue: '',
  label: '',
  hint: '',
  placeholder: 'No folder chosen',
  typedPlaceholder: '/Users/you/Documents/Folder',
  pickerTitle: 'Choose a folder',
  pickerButtonLabel: 'Choose',
  chooseLabel: 'Choose…',
  clearLabel: 'Clear',
  disabled: false,
  allowTyping: true,
  revealable: true,
  clearable: false,
  maxLength: 48,
})

const emit = defineEmits<{
  'update:modelValue': [string]
  change: [string]
}>()

const inputId = `folder-field-${useId()}`
const inputEl = ref<HTMLInputElement | null>(null)
const editing = ref(false)
const draft = ref('')
const picking = ref(false)
const revealing = ref(false)
const message = ref('')
const messageTone = ref<'info' | 'error'>('info')

const display = computed(() => friendlyPath(props.modelValue, props.maxLength))

watch(() => props.modelValue, () => { message.value = '' })

function setPath(path: string) {
  emit('update:modelValue', path)
  emit('change', path)
}

function errorDetail(e: any): string {
  return String(e?.data?.detail || e?.message || '').trim()
}

async function choose() {
  if (picking.value || props.disabled) return
  picking.value = true
  message.value = ''
  try {
    const picked = await pickFolder({
      title: props.pickerTitle,
      button_label: props.pickerButtonLabel,
      initial_path: props.modelValue || undefined,
    })
    if (picked) setPath(picked)
  } catch (e: any) {
    const detail = errorDetail(e)
    const noNativePicker = /not detected|not available/i.test(detail) || (e?.status ?? e?.response?.status) === 503
    messageTone.value = noNativePicker ? 'info' : 'error'
    message.value = noNativePicker
      ? 'The folder picker only opens inside the Story Studio app. Type or paste the folder path instead.'
      : `The folder picker did not open: ${detail || 'unknown error'}. You can type or paste the path instead.`
    if (props.allowTyping) startTyping()
  } finally {
    picking.value = false
  }
}

async function reveal() {
  if (!props.modelValue || revealing.value) return
  revealing.value = true
  message.value = ''
  try {
    await $fetch('/api/system/reveal-folder', { method: 'POST', body: { path: props.modelValue } })
  } catch (e: any) {
    messageTone.value = 'error'
    message.value = errorDetail(e) || 'Finder could not show this folder.'
  } finally {
    revealing.value = false
  }
}

function startTyping() {
  draft.value = props.modelValue || ''
  editing.value = true
  nextTick(() => inputEl.value?.focus())
}

function commitTyped() {
  const typed = draft.value.trim()
  if (!typed) return
  editing.value = false
  message.value = ''
  if (typed !== props.modelValue) setPath(typed)
}

function cancelTyped() {
  editing.value = false
}

function clear() {
  setPath('')
}
</script>

<style scoped>
.folder-field { display: grid; gap: var(--space-1); min-width: 0; }
.folder-field-label { margin-bottom: 2px; }
.folder-field-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  padding: 6px 6px 6px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-primary);
}
.folder-field-icon { display: inline-flex; flex: none; color: var(--text-muted); }
.folder-field-path {
  flex: 1 1 200px;
  min-width: 0;
  overflow: hidden;
  color: var(--text-primary);
  font-size: var(--font-sm);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.folder-field-path.is-placeholder { color: var(--text-muted); }
.folder-field-input { flex: 1 1 240px; min-width: 0; width: auto; }
.folder-field-actions { display: flex; flex: none; flex-wrap: wrap; gap: var(--space-1); margin-left: auto; }
.folder-field.is-disabled .folder-field-row { opacity: 0.6; }
.folder-field-message[data-tone='error'] { color: var(--error); }
</style>
