<template>
  <span :class="['spinner', sizeClass]" role="status" :aria-label="label">
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" stroke-opacity="0.2" />
      <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" stroke-width="3" stroke-linecap="round" />
    </svg>
    <span v-if="label && showLabel" class="spinner-label">{{ label }}</span>
  </span>
</template>

<script setup lang="ts">
const props = defineProps<{
  size?: 'sm' | 'md' | 'lg'
  label?: string
  showLabel?: boolean
}>()

const sizeClass = computed(() => `spinner-${props.size || 'md'}`)
</script>

<style scoped>
.spinner {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: currentColor;
}
.spinner svg {
  animation: spin 0.9s linear infinite;
  flex-shrink: 0;
}
.spinner-sm svg { width: 12px; height: 12px; }
.spinner-md svg { width: 16px; height: 16px; }
.spinner-lg svg { width: 24px; height: 24px; }
.spinner-label { font-size: 13px; }

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* Respect user preference for reduced motion */
@media (prefers-reduced-motion: reduce) {
  .spinner svg { animation-duration: 3s; }
}
</style>
