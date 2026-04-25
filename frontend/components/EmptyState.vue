<template>
  <div class="empty-state" role="status">
    <div v-if="icon" class="empty-icon" aria-hidden="true">{{ icon }}</div>
    <h3 v-if="title" class="empty-title">{{ title }}</h3>
    <p v-if="message" class="empty-message">{{ message }}</p>
    <slot name="action">
      <NuxtLink v-if="actionTo" :to="actionTo" class="btn btn-primary mt-2">
        {{ actionLabel || 'Get started' }}
      </NuxtLink>
    </slot>
    <slot />
  </div>
</template>

<script setup lang="ts">
defineProps<{
  icon?: string
  title?: string
  message?: string
  actionTo?: string
  actionLabel?: string
}>()
</script>

<style scoped>
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 48px 24px;
  text-align: center;
  background: var(--bg-secondary);
  border: 1px dashed var(--border);
  border-radius: var(--radius-lg);
  color: var(--text-muted);
}
.empty-icon {
  font-size: 48px;
  opacity: 0.6;
  margin-bottom: 4px;
}
.empty-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-secondary);
  margin: 0;
}
.empty-message {
  font-size: 13px;
  max-width: 420px;
  line-height: 1.5;
  margin: 0;
}
</style>
