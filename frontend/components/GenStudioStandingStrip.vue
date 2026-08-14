<template>
  <NuxtLink
    to="/usage"
    class="genstudio-standing-strip"
    aria-label="GenStudio account standing"
    :title="usageError || 'Open GenStudio usage'"
  >
    <span>GenStudio</span>
    <strong>{{ creditSummary }}</strong>
    <small v-if="standingSummary">{{ standingSummary }}</small>
  </NuxtLink>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'

const {
  genstudioCredits,
  genstudioTier,
  genstudioActiveLanes,
  genstudioLaneLimit,
  genstudioConfigured,
  usageError,
  startPolling,
} = useCredits()

const creditSummary = computed(() => {
  if (!genstudioConfigured.value) return 'Set up'
  if (genstudioCredits.value === null) return 'Unavailable'
  return `${genstudioCredits.value.toLocaleString()} credits`
})

const standingSummary = computed(() => {
  const facts: string[] = []
  if (genstudioTier.value) facts.push(genstudioTier.value.current.display_name)
  if (genstudioActiveLanes.value !== null && genstudioLaneLimit.value !== null) {
    facts.push(`${genstudioActiveLanes.value}/${genstudioLaneLimit.value} lanes`)
  }
  return facts.join(' · ')
})

let releasePolling: (() => void) | null = null
onMounted(() => { releasePolling = startPolling() })
onUnmounted(() => { releasePolling?.() })
</script>

<style scoped>
.genstudio-standing-strip {
  display: flex;
  min-width: 0;
  min-height: 32px;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 4px 8px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-size: var(--font-xs);
}
.genstudio-standing-strip:hover { background: var(--bg-hover); color: var(--text-primary); }
.genstudio-standing-strip strong { color: var(--text-primary); font-weight: 650; }
.genstudio-standing-strip small { width: 100%; color: var(--text-muted); line-height: 1.35; }
</style>
