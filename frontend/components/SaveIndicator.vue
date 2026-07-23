<template>
  <div class="save-indicator" :class="'state-' + state">
    <template v-if="state === 'saving'">
      <LoadingSpinner size="sm" />
      <span>Saving…</span>
    </template>
    <template v-else-if="state === 'dirty'">
      <span class="dirty-dot" />
      <span>Unsaved changes</span>
    </template>
    <template v-else-if="state === 'saved'">
      <span class="check">✓</span>
      <span>{{ friendlyTime }}</span>
    </template>
    <template v-else-if="state === 'error'">
      <span class="cross">!</span>
      <span>{{ errorMessage || 'Save failed' }}</span>
    </template>
  </div>
</template>

<script setup lang="ts">
import type { AutoSaveState } from '~/composables/useAutoSave'

const props = defineProps<{
  state: AutoSaveState
  savedAt: number | null
  errorMessage?: string
}>()

// Tick every 10s so "Saved just now" → "Saved 1m ago" updates without manual refresh
const now = ref(Date.now())
let interval: ReturnType<typeof setInterval> | null = null
onMounted(() => { interval = setInterval(() => { now.value = Date.now() }, 10000) })
onBeforeUnmount(() => { if (interval) clearInterval(interval) })

const friendlyTime = computed(() => {
  if (!props.savedAt) return 'Saved'
  const diff = Math.floor((now.value - props.savedAt) / 1000)
  if (diff < 5) return 'Saved just now'
  if (diff < 60) return `Saved ${diff}s ago`
  const mins = Math.floor(diff / 60)
  if (mins < 60) return `Saved ${mins}m ago`
  const hrs = Math.floor(mins / 60)
  return `Saved ${hrs}h ago`
})
</script>

<style scoped>
.save-indicator {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: var(--font-xs); font-weight: 500;
  padding: 4px 10px; border-radius: 999px;
  transition: all 0.2s;
}
.state-idle { display: none; }
.state-dirty { background: rgba(234, 179, 8, 0.12); color: #eab308; }
.state-saving { background: rgba(96, 165, 250, 0.12); color: #60a5fa; }
.state-saved { background: rgba(34, 197, 94, 0.12); color: #22c55e; }
.state-error { background: rgba(248, 113, 113, 0.14); color: #f87171; }

.dirty-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: #eab308;
}
.check, .cross { font-weight: 700; }
</style>
