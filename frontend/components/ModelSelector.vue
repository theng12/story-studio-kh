<template>
  <div class="form-group">
    <label>AI Model</label>
    <select :value="modelValue" @change="$emit('update:modelValue', ($event.target as HTMLSelectElement).value)" class="select">
      <optgroup v-for="g in groups" :key="g.provider" :label="g.label">
        <option
          v-for="m in g.items"
          :key="m.id"
          :value="m.id"
          :disabled="isDisabled(m.data)"
          :title="tooltipFor(m.data)"
        >
          {{ m.data.label }}{{ suffixFor(m.data) }}
        </option>
      </optgroup>
    </select>
  </div>
</template>

<script setup lang="ts">
interface LlmModelRow {
  id: string
  label: string
  provider: string
  available: boolean
  // Backend-supplied reason explaining why a model that *has* a key still
  // can't be used (e.g. account tier doesn't include GPT-5). null/undefined
  // means no extra restriction beyond the api-key check.
  disabled_reason?: string | null
}

const props = defineProps<{
  modelValue: string
  projectSlug: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const { get } = useApi()

const allModels = ref<LlmModelRow[]>([])

function isDisabled(m: LlmModelRow) {
  return !m.available || !!m.disabled_reason
}
function suffixFor(m: LlmModelRow) {
  if (m.disabled_reason) return ' (unavailable)'
  if (!m.available) return ' (no key)'
  return ''
}
function tooltipFor(m: LlmModelRow) {
  if (m.disabled_reason) return m.disabled_reason
  if (!m.available) return 'No API key configured for this provider'
  return ''
}

// Provider-grouped view for the <optgroup> rendering.
const groups = computed(() => {
  const record: Record<string, LlmModelRow> = {}
  for (const m of allModels.value) record[m.id] = m
  return groupModels<LlmModelRow>(record, (_id, m) => m.provider || 'other')
})

async function loadModels() {
  try {
    allModels.value = await get(`/models?project=${props.projectSlug}`)

    // Auto-fallback: if the current selection isn't usable (no key OR
    // flagged unavailable), switch to the first model that *is* usable.
    // Excluding disabled_reason here prevents accidentally landing on
    // gpt-5 just because alphabetically/declaration-order it comes first.
    const current = allModels.value.find(m => m.id === props.modelValue)
    if (!current || isDisabled(current)) {
      const firstUsable = allModels.value.find(m => !isDisabled(m))
      if (firstUsable) {
        emit('update:modelValue', firstUsable.id)
      }
    }
  } catch {}
}

watch(() => props.projectSlug, loadModels, { immediate: true })
</script>

<style scoped>
option:disabled {
  color: var(--text-muted);
  font-style: italic;
}
</style>
