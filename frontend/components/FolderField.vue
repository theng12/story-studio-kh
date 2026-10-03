<template>
  <!-- A folder you choose, never type (owner, 2026-10-03: "where finished
       videos go — no pick, it's a long text path to type").
       API shared with ux/design-system's FolderField: v-model, label, hint.
       NOTE FOR MERGE: this is the ux/settings local copy; keep one. -->
  <div class="folder-field" :class="{ disabled }">
    <div class="folder-field-head">
      <span :id="labelId" class="folder-field-label">{{ label }}</span>
      <slot name="badge" />
    </div>
    <div class="folder-field-row">
      <span
        class="folder-field-path"
        :class="{ empty: !modelValue }"
        :title="modelValue || placeholder"
        :aria-labelledby="labelId"
        role="textbox"
        aria-readonly="true"
      >
        <span class="folder-field-name">{{ modelValue ? folderName : placeholder }}</span>
        <span v-if="modelValue && parentPath" class="folder-field-parent">{{ parentPath }}</span>
      </span>
      <button
        type="button"
        class="btn btn-secondary btn-sm"
        :disabled="disabled || picking"
        :aria-describedby="hint ? hintId : undefined"
        @click="choose"
      >{{ picking ? 'Opening…' : buttonLabel }}</button>
      <slot name="actions" />
    </div>
    <p v-if="hint" :id="hintId" class="folder-field-hint">{{ hint }}</p>
    <p v-if="pickError" class="folder-field-error" role="alert">{{ pickError }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import { pickFolder } from '~/composables/usePathPicker'

const props = withDefaults(defineProps<{
  modelValue: string
  label: string
  hint?: string
  placeholder?: string
  /** Title of the native folder dialog. */
  pickerTitle?: string
  /** Confirm button of the native folder dialog. */
  pickerButton?: string
  buttonLabel?: string
  disabled?: boolean
  /**
   * When true the field does not change itself: it emits `picked` and the
   * parent decides (for a choice that needs a confirm, like moving the Library).
   */
  confirmFirst?: boolean
}>(), {
  hint: '',
  placeholder: 'No folder chosen',
  pickerTitle: 'Choose a folder',
  pickerButton: 'Use This Folder',
  buttonLabel: 'Choose…',
  disabled: false,
  confirmFirst: false,
})
const emit = defineEmits<{ 'update:modelValue': [value: string]; picked: [value: string] }>()

const uid = useId()
const labelId = `folder-field-label-${uid}`
const hintId = `folder-field-hint-${uid}`
const picking = ref(false)
const pickError = ref('')

const parts = computed(() => String(props.modelValue || '').replace(/[\\/]+$/, '').split(/[\\/]/))
const folderName = computed(() => parts.value[parts.value.length - 1] || props.modelValue)
const parentPath = computed(() => parts.value.slice(0, -1).join('/') || '')

async function choose(): Promise<void> {
  if (props.disabled || picking.value) return
  picking.value = true
  pickError.value = ''
  try {
    const picked = await pickFolder({ title: props.pickerTitle, button_label: props.pickerButton, initial_path: props.modelValue || undefined })
    if (!picked) return
    emit('picked', picked)
    if (!props.confirmFirst) emit('update:modelValue', picked)
  } catch (e: any) {
    const detail = e?.data?.detail || e?.message || ''
    pickError.value = /Electron main process not detected|not available/i.test(detail)
      ? 'The folder picker only works in the Story Studio app.'
      : `The folder picker did not open${detail ? ` (${detail})` : ''}. Try again.`
  } finally {
    picking.value = false
  }
}
</script>

<style scoped>
.folder-field { display: grid; gap: 6px; min-width: 0; }
.folder-field-head { display: flex; align-items: center; gap: 8px; }
.folder-field-label { font-size: 13px; font-weight: 600; color: var(--text-primary); }
.folder-field-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
.folder-field-path {
  display: grid; flex: 1 1 auto; min-width: 0; padding: 7px 10px;
  border: 1px solid var(--border); border-radius: 6px; background: var(--bg-primary);
}
.folder-field-name { overflow: hidden; color: var(--text-primary); font-size: 13px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.folder-field-parent { overflow: hidden; color: var(--text-muted); font-family: ui-monospace, monospace; font-size: var(--font-xs); text-overflow: ellipsis; white-space: nowrap; }
.folder-field-path.empty .folder-field-name { color: var(--text-muted); font-weight: 400; }
.folder-field-row .btn { flex: 0 0 auto; }
.folder-field-hint { margin: 0; color: var(--text-muted); font-size: 12px; line-height: 1.45; }
.folder-field-error { margin: 0; color: var(--error); font-size: 12px; }
.folder-field.disabled { opacity: .65; }
</style>
