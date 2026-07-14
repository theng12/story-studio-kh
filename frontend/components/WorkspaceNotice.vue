<template>
  <div class="workspace-notice" :data-tone="tone" role="status">
    <span class="workspace-notice-icon" aria-hidden="true">{{ resolvedIcon }}</span>
    <div class="workspace-notice-copy">
      <strong>{{ title }}</strong>
      <p><slot /></p>
    </div>
    <div v-if="$slots.actions" class="workspace-notice-actions">
      <slot name="actions" />
    </div>
  </div>
</template>

<script setup lang="ts">
const props = withDefaults(defineProps<{
  title: string
  tone?: 'info' | 'success' | 'warning' | 'error'
  icon?: string
}>(), {
  tone: 'info',
  icon: '',
})

const resolvedIcon = computed(() => props.icon || ({
  info: 'i',
  success: '✓',
  warning: '!',
  error: '×',
}[props.tone]))
</script>
