<template>
  <!-- One control for "which file?" everywhere a file is chosen. The value is
       still the stored path string (nothing about the data changes); what the
       customer sees is the file's own name, with the full path on hover. A file
       that is no longer there says so instead of looking chosen. -->
  <div class="file-picker">
    <div class="file-picker-value" :class="{ 'is-empty': !modelValue }">
      <span class="file-picker-name" :title="modelValue || undefined">{{ displayName }}</span>
      <span v-if="missing" class="file-picker-missing">File not found</span>
    </div>
    <button
      type="button"
      class="btn btn-sm btn-secondary"
      :disabled="picking"
      @click="browse"
      :title="title || 'Browse for a file'"
    >{{ picking ? 'Choosing…' : (chooseLabel || 'Choose…') }}</button>
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
import { computed, ref, watch } from 'vue'

const props = defineProps<{
  modelValue: string
  /** Shown when nothing is chosen. Kept for callers that name the thing, e.g. "No intro chosen". */
  placeholder?: string
  /** The Browse button's words. */
  chooseLabel?: string
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
const missing = ref(false)
let checkToken = 0

/** The file's own name — the last part of a path — never the raw path. */
const displayName = computed(() => {
  const raw = String(props.modelValue || '').trim()
  if (!raw) return props.placeholder || 'No file chosen'
  const name = raw.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || raw
  return name
})

/** Does the file this field names still exist? Portable `${PROJECT}/…` paths resolve against the episode root. */
async function checkExists() {
  const raw = String(props.modelValue || '').trim()
  if (!raw) { missing.value = false; return }
  const token = ++checkToken
  try {
    const r = await post<{ valid: boolean; reason?: string }>('/system/validate-path', {
      path: raw,
      output_root: props.episodesRoot || undefined,
      must_exist: true,
    })
    if (token === checkToken) missing.value = r?.valid === false && /does not exist/.test(String(r?.reason || ''))
  } catch {
    // "Could not check" is not "missing": leave the field looking chosen.
    if (token === checkToken) missing.value = false
  }
}

watch(() => [props.modelValue, props.episodesRoot], () => { void checkExists() }, { immediate: true })

/** `adopt`: a browsed file outside the channel is copied into its `assets/` folder first (2026-10-07). */
async function collapseToPortablePath(input: string, adopt = false): Promise<string> {
  const raw = String(input || '').trim()
  if (!raw) return ''
  if (typeof props.episodesRoot === 'undefined') return raw
  try {
    const result = await post<{ output: string }>('/system/resolve-asset-path', {
      path: raw,
      output_root: props.episodesRoot || undefined,
      mode: adopt ? 'adopt' : 'portable',
    })
    return String(result?.output || raw)
  } catch {
    return raw
  }
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
    if (result.path) emit('update:modelValue', await collapseToPortablePath(result.path, true))
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

.file-picker-value {
  display: flex;
  flex: 1;
  align-items: baseline;
  gap: var(--space-2);
  min-width: 0;
}
.file-picker-name {
  overflow: hidden;
  color: var(--text-primary);
  font-size: var(--font-sm);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-picker-value.is-empty .file-picker-name { color: var(--text-muted); }
.file-picker-missing {
  flex: none;
  color: var(--warning, #d97706);
  font-size: var(--font-xs);
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
