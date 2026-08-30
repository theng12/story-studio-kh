<template>
  <span
    :class="['badge', `badge-${status}`]"
    role="status"
    :aria-label="`Status: ${label}`"
  >
    <span v-if="status === 'running'" class="pulse-dot" aria-hidden="true" />
    {{ label }}
  </span>
</template>

<script setup lang="ts">
const props = defineProps<{ status: string }>()

const label = computed(() => {
  const labels: Record<string, string> = {
    running: 'Running',
    queued: 'Queued',
    paused: 'Paused',
    done: 'Done',
    error: 'Needs attention',
    cancelled: 'Cancelled',
  }
  return labels[props.status] || props.status
})
</script>

<style scoped>
.pulse-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--info);
  margin-right: 4px;
  animation: pulse 1.5s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}
</style>
