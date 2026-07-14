<template>
  <header class="workspace-hero">
    <div class="workspace-hero-copy">
      <Breadcrumb v-if="breadcrumb" />
      <span class="workspace-eyebrow">{{ eyebrow }}</span>
      <h1>{{ title }}</h1>
      <p v-if="description" class="workspace-hero-description">{{ description }}</p>
    </div>
    <div v-if="$slots.aside" class="workspace-hero-aside">
      <slot name="aside" />
    </div>
  </header>
</template>

<script setup lang="ts">
withDefaults(defineProps<{
  title: string
  eyebrow: string
  description?: string
  breadcrumb?: boolean
}>(), {
  description: '',
  breadcrumb: true,
})
</script>
