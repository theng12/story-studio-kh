<template>
  <div class="topic-pack-picker">
    <div class="picker-heading">
      <span>Topic Packs — reusable subject lanes</span>
      <span class="hint">Select one or more. Campaigns rotate across their subjects and coverage angles instead of asking the model to improvise 100 variations.</span>
    </div>

    <p v-if="!seriesFormulaId" class="empty-note">Choose a Series Formula first.</p>
    <p v-else-if="isLoading" class="empty-note">Loading compatible Topic Packs…</p>
    <p v-else-if="!compatible.length" class="empty-note">
      This formula has no compatible Topic Packs yet. Its example topics will be used.
    </p>
    <div v-else class="pack-grid">
      <label
        v-for="pack in compatible"
        :key="pack.id"
        class="pack-card"
        :class="{ selected: selectedIds.has(pack.id), disabled }"
      >
        <input
          type="checkbox"
          :checked="selectedIds.has(pack.id)"
          :disabled="disabled"
          @change="toggle(pack.id)"
        />
        <span class="pack-copy">
          <span class="pack-title">
            <strong>{{ pack.name }}</strong>
            <span v-if="!pack.builtin" class="custom-badge">custom</span>
          </span>
          <span class="pack-description">{{ pack.description }}</span>
          <span class="pack-stats">{{ pack.subjects.length }} subjects<span v-if="pack.ideaAxes?.length"> · {{ pack.ideaAxes.length }} coverage axes</span></span>
        </span>
      </label>
    </div>

    <p v-if="error" class="error-note">
      Failed to load Topic Packs: {{ formatErr(error) }}
      <button type="button" class="btn btn-ghost btn-sm" :disabled="isLoading" @click="refresh()">
        {{ isLoading ? 'Retrying…' : 'Try again' }}
      </button>
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue'

const props = defineProps<{
  modelValue: string[]
  seriesFormulaId: string
  disabled?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string[]]
}>()

const { isLoading, isReady, error, compatibleWith, refresh } = useTopicPacks()
const compatible = computed(() => compatibleWith(props.seriesFormulaId))
const compatibleIds = computed(() => new Set(compatible.value.map(pack => pack.id)))
const selectedIds = computed(() => new Set(props.modelValue || []))

function toggle(id: string) {
  const next = new Set(props.modelValue || [])
  if (next.has(id)) next.delete(id)
  else next.add(id)
  emit('update:modelValue', [...next])
}

// A formula switch must not retain packs that are incompatible with it.
watch([
  () => props.seriesFormulaId,
  isReady,
  () => compatible.value.map(pack => pack.id).join('|'),
], () => {
  if (!isReady.value) return
  const next = (props.modelValue || []).filter(id => compatibleIds.value.has(id))
  if (next.length !== (props.modelValue || []).length) emit('update:modelValue', next)
})

function formatErr(cause: any): string {
  return cause?.data?.detail || cause?.message || String(cause)
}
</script>

<style scoped>
.topic-pack-picker { display: flex; flex-direction: column; gap: 8px; }
.picker-heading { display: flex; flex-direction: column; gap: 2px; font-size: 13px; color: var(--text-primary); }
.hint { color: var(--text-muted); font-size: var(--font-xs); font-weight: normal; line-height: 1.4; }
.pack-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 8px; }
.pack-card { display: flex; align-items: flex-start; gap: 9px; border: 1px solid var(--border); border-radius: var(--radius-md, 6px); padding: 10px 12px; background: var(--bg-secondary); cursor: pointer; }
.pack-card.selected { border-color: var(--accent); background: var(--accent-dim, rgba(108, 143, 255, .1)); }
.pack-card.disabled { cursor: default; opacity: .65; }
.pack-card input { margin-top: 3px; }
.pack-copy, .pack-title { display: flex; }
.pack-copy { flex-direction: column; gap: 3px; min-width: 0; }
.pack-title { align-items: center; gap: 6px; color: var(--text-primary); font-size: 13px; }
.pack-description { color: var(--text-secondary); font-size: var(--font-xs); line-height: 1.4; }
.pack-stats { color: var(--text-muted); font-size: var(--font-xs); }
.custom-badge { font-size: var(--font-xs); text-transform: uppercase; letter-spacing: .05em; color: var(--accent); }
.empty-note, .error-note { margin: 0; padding: 8px 10px; border-radius: 4px; background: var(--bg-secondary); color: var(--text-muted); font-size: var(--font-xs); }
.error-note { color: var(--error, #e25c5c); }
</style>
