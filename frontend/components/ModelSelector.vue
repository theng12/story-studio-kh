<template>
  <div class="form-group">
    <label>AI Model</label>
    <select :value="modelValue" @change="$emit('update:modelValue', ($event.target as HTMLSelectElement).value)" class="select">
      <optgroup v-for="g in groups" :key="g.provider" :label="g.label">
        <option
          v-for="m in g.items"
          :key="m.id"
          :value="m.id"
          :disabled="!m.data.available"
        >
          {{ m.data.label }}{{ !m.data.available ? ' (no key)' : '' }}
        </option>
      </optgroup>
    </select>
  </div>
</template>

<script setup lang="ts">
interface LlmModelRow { id: string; label: string; provider: string; available: boolean }

const props = defineProps<{
  modelValue: string
  projectSlug: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const { get } = useApi()

const allModels = ref<LlmModelRow[]>([])

// Provider-grouped view for the <optgroup> rendering.
const groups = computed(() => {
  const record: Record<string, LlmModelRow> = {}
  for (const m of allModels.value) record[m.id] = m
  return groupModels<LlmModelRow>(record, (_id, m) => m.provider || 'other')
})

async function loadModels() {
  try {
    allModels.value = await get(`/models?project=${props.projectSlug}`)

    // If current model has no key, auto-switch to first available
    const current = allModels.value.find(m => m.id === props.modelValue)
    if (!current?.available) {
      const firstAvailable = allModels.value.find(m => m.available)
      if (firstAvailable) {
        emit('update:modelValue', firstAvailable.id)
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
