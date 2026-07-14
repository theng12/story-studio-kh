<template>
  <section class="card workspace-section">
    <header v-if="title || eyebrow || description || $slots.actions" class="workspace-section-header">
      <div>
        <span v-if="eyebrow" class="workspace-section-eyebrow">{{ eyebrow }}</span>
        <h2 v-if="title" class="workspace-section-title">{{ title }}</h2>
        <p v-if="description" class="workspace-section-description">{{ description }}</p>
      </div>
      <div v-if="$slots.actions" class="workspace-section-actions">
        <slot name="actions" />
      </div>
    </header>
    <slot />
  </section>
</template>

<script setup lang="ts">
withDefaults(defineProps<{
  title?: string
  eyebrow?: string
  description?: string
}>(), {
  title: '',
  eyebrow: '',
  description: '',
})
</script>
