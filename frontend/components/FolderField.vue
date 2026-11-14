<template>
  <!-- One control for "which folder?" everywhere a path is chosen.

       Shows the folder as a short friendly path (~/Documents/…/episodes) with the
       full path on hover, a "Choose…" button that opens the Mac's own folder
       picker (Electron's dialog via POST /system/pick-folder; the in-app browser
       in server mode — both through usePathPicker) and "Show in Finder". A folder
       that is no longer there says so. The full path is what is emitted and
       saved; what is shown is the folder's own name.

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
       - `revealable`     — offer "Show in Finder" when a path is set (default on).
       - A path is only ever chosen with the picker; it is shown read-only,
         never as a free-text input (owner, 2026-11-14).
       - `clearable`      — offer a clear button labelled `clearLabel`.
       - #badge           — a small status chip beside the label (e.g. "Not found"). -->
  <div class="folder-field" :class="{ 'is-empty': !modelValue, 'is-disabled': disabled }">
    <div v-if="label || $slots.badge" class="folder-field-head">
      <label v-if="label" class="folder-field-label">{{ label }}</label>
      <slot name="badge" />
    </div>
    <div class="folder-field-row" role="group" :aria-label="label || undefined">
      <span class="folder-field-icon" aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round">
          <path d="M1.75 4.25c0-.83.67-1.5 1.5-1.5h3.1l1.4 1.5h5c.83 0 1.5.67 1.5 1.5v6c0 .83-.67 1.5-1.5 1.5H3.25c-.83 0-1.5-.67-1.5-1.5v-7.5Z" />
        </svg>
      </span>
      <span
        class="folder-field-path"
        :class="{ 'is-placeholder': !modelValue }"
        :title="modelValue || undefined"
      >{{ display || placeholder }}</span>
      <span v-if="missing" class="folder-field-missing">Folder not found</span>
      <div class="folder-field-actions">
        <button type="button" class="btn btn-sm btn-secondary" :disabled="disabled || picking" @click="choose">
          {{ picking ? 'Choosing…' : chooseLabel }}
        </button>
        <button v-if="modelValue && canReveal" type="button" class="btn btn-sm btn-quiet" :disabled="revealing" @click="reveal">Show in Finder</button>
        <button v-if="clearable && modelValue" type="button" class="btn btn-sm btn-quiet" :disabled="disabled" @click="clear">{{ clearLabel }}</button>
      </div>
    </div>
    <p v-if="message" class="hint folder-field-message" :data-tone="messageTone" role="status">{{ message }}</p>
    <p v-else-if="hint || $slots.hint" class="hint folder-field-hint"><slot name="hint">{{ hint }}</slot></p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { pickFolder } from '../composables/usePathPicker'
import { friendlyPath } from '../utils/friendly-path'
import { isServerMode } from '../composables/useServerMode'

const props = withDefaults(defineProps<{
  modelValue?: string | null
  label?: string
  hint?: string
  placeholder?: string
  pickerTitle?: string
  pickerButtonLabel?: string
  chooseLabel?: string
  clearLabel?: string
  disabled?: boolean
  revealable?: boolean
  clearable?: boolean
  /** Longest friendly path shown before middle folders collapse into `…`. */
  maxLength?: number
}>(), {
  modelValue: '',
  label: '',
  hint: '',
  placeholder: 'No folder chosen',
  pickerTitle: 'Choose a folder',
  pickerButtonLabel: 'Choose',
  chooseLabel: 'Choose…',
  clearLabel: 'Clear',
  disabled: false,
  revealable: true,
  clearable: false,
  maxLength: 48,
})

const emit = defineEmits<{
  'update:modelValue': [string]
  change: [string]
}>()

const picking = ref(false)
const revealing = ref(false)
const message = ref('')
const messageTone = ref<'info' | 'error'>('info')
const missing = ref(false)

/** "Show in Finder" reveals a folder on the machine RUNNING the app; a remote browser would open a Finder window nobody can see. */
const canReveal = computed(() => props.revealable && !isServerMode())

/** The folder's own name — the last part of the path — with the full path on hover. */
const display = computed(() => {
  const raw = String(props.modelValue || '').trim()
  if (!raw) return ''
  const name = raw.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || raw
  return name || friendlyPath(props.modelValue, props.maxLength)
})

let checkToken = 0
/** Does this folder still exist? A check that fails is "not checked", never "missing". */
async function checkExists() {
  const raw = String(props.modelValue || '').trim()
  if (!raw) { missing.value = false; return }
  const token = ++checkToken
  try {
    const r = await $fetch('/api/system/validate-path', {
      method: 'POST',
      body: { path: raw, must_exist: true, must_be_dir: true },
    }) as { valid?: boolean; reason?: string }
    if (token !== checkToken) return
    missing.value = r?.valid === false && /does not exist/.test(String(r?.reason || ''))
  } catch {
    if (token === checkToken) missing.value = false
  }
}

watch(() => props.modelValue, () => { void checkExists() }, { immediate: true })

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
      ? 'The folder picker is not available here. Open Story Studio in the app or its browser page and try again.'
      : `The folder picker did not open: ${detail || 'unknown error'}.`
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

function clear() {
  setPath('')
}
</script>

<style scoped>
.folder-field { display: grid; gap: var(--space-1); min-width: 0; }
.folder-field-head { display: flex; align-items: center; gap: var(--space-2); }
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
.folder-field-actions { display: flex; flex: none; flex-wrap: wrap; gap: var(--space-1); margin-left: auto; }
.folder-field.is-disabled .folder-field-row { opacity: 0.6; }
.folder-field-message[data-tone='error'] { color: var(--error); }
.folder-field-missing { flex: none; color: var(--warning, #d97706); font-size: var(--font-xs); }
</style>
