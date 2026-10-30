<template>
  <!-- ONE title style and ONE place for a page's actions (owner, 2026-10-30).
       The pages had four widths and alignments and two title colours. This is
       the frame: an optional eyebrow, one title, one sentence, and the actions
       pinned to the right of the title line — never a second header band. -->
  <header class="page-title">
    <div class="page-title-text">
      <span v-if="eyebrow" class="page-title-eyebrow">{{ eyebrow }}</span>
      <h1>{{ title }}</h1>
      <p v-if="description || $slots.description" class="page-title-description">
        <slot name="description">{{ description }}</slot>
      </p>
    </div>
    <div v-if="$slots.actions" class="page-title-actions">
      <slot name="actions" />
    </div>
  </header>
</template>

<script setup lang="ts">
defineProps<{
  title: string
  eyebrow?: string
  description?: string
}>()
</script>

<style scoped>
.page-title {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--space-3, 16px);
  margin: 0 0 var(--space-4, 20px);
}
.page-title-text { min-width: 0; }
.page-title-eyebrow {
  display: block;
  margin-bottom: 4px;
  color: var(--accent);
  font-size: var(--font-xs);
  font-weight: 750;
  letter-spacing: .08em;
  text-transform: uppercase;
}
.page-title h1 {
  margin: 0;
  color: var(--text-primary);
  font-size: var(--font-xl, 24px);
  font-weight: 700;
  line-height: 1.2;
}
.page-title-description {
  max-width: 760px;
  margin: 6px 0 0;
  color: var(--text-secondary);
  font-size: var(--font-sm);
  line-height: 1.5;
}
.page-title-actions { display: flex; flex-wrap: wrap; gap: var(--space-2, 8px); }
</style>
