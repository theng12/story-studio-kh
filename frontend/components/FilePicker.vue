<template>
  <div class="file-picker">
    <input
      :value="modelValue"
      @input="(e) => emit('update:modelValue', (e.target as HTMLInputElement).value)"
      @blur="normalizeTypedValue"
      class="input file-picker-input"
      :placeholder="placeholder"
      :aria-label="ariaLabel || 'File path'"
    />
    <button
      type="button"
      class="btn btn-sm btn-secondary"
      :disabled="picking"
      @click="browse"
      :title="title || 'Browse for a file'"
    >{{ picking ? '…' : 'Browse' }}</button>
    <button
      v-if="modelValue && clearable"
      type="button"
      class="btn-icon"
      @click="emit('update:modelValue', '')"
      title="Clear"
    >✕</button>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{
  modelValue: string
  placeholder?: string
  filters?: Array<{ name: string; extensions: string[] }>
  title?: string
  buttonLabel?: string
  ariaLabel?: string
  clearable?: boolean
  /**
   * ABSOLUTE path to the project's episodes folder, used to collapse a picked
   * path into a portable `${PROJECT}/…` form. Renamed from `outputRoot`: every
   * caller was passing the stored `output_root` field, which was the RELATIVE
   * './episodes', and `toPortablePath` silently declines a non-absolute base —
   * so Browse never produced a portable path and nobody saw an error. Pass
   * `episodesRoot` from `useProject()`.
   *
   * Omit entirely to skip the round-trip. An empty string still calls, so
   * `${ASSET}/…` collapsing keeps working when the project isn't loaded yet.
   */
  episodesRoot?: string
}>()

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const { post } = useApi()
const { error: showError } = useToast()
const picking = ref(false)

async function collapseToPortablePath(input: string): Promise<string> {
  const raw = String(input || '').trim()
  if (!raw) return ''
  if (typeof props.episodesRoot === 'undefined') return raw
  try {
    const result = await post<{ output: string }>('/system/resolve-asset-path', {
      path: raw,
      output_root: props.episodesRoot || undefined,
      mode: 'portable',
    })
    return String(result?.output || raw)
  } catch {
    return raw
  }
}

async function normalizeTypedValue() {
  const normalized = await collapseToPortablePath(props.modelValue)
  if (normalized !== props.modelValue) emit('update:modelValue', normalized)
}

async function browse() {
  if (picking.value) return
  picking.value = true
  try {
    const result = await post<{ path: string | null }>('/system/pick-file', {
      title: props.title || 'Choose a file',
      buttonLabel: props.buttonLabel || 'Select',
      filters: props.filters || [{ name: 'All Files', extensions: ['*'] }],
    })
    if (result.path) emit('update:modelValue', await collapseToPortablePath(result.path))
  } catch (e: any) {
    // Previously silent — that turned "backend returned 500" into "Browse
    // button looks broken" for users who had no way to know their request
    // hit a standalone backend that couldn't reach Electron's dialog. Now
    // the toast surfaces whatever the server said, so at worst the user
    // sees a clear message and can still type the path manually.
    showError(e?.data?.detail || 'File picker unavailable')
  } finally {
    picking.value = false
  }
}
</script>

<style scoped>
.file-picker {
  display: flex;
  gap: 6px;
  align-items: center;
}

.file-picker-input {
  flex: 1;
  min-width: 0;
}

.btn-icon {
  padding: 4px 8px;
  background: transparent;
  border: 1px solid var(--border);
  color: var(--text-muted);
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
}

.btn-icon:hover {
  color: var(--text-primary);
  border-color: var(--text-muted);
}
</style>
