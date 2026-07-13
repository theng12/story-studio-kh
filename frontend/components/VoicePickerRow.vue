<template>
  <div class="vp-row" :class="{ selected }">
    <button type="button" class="vp-star" :class="{ favourite }" :title="favourite ? 'Remove favourite' : 'Add favourite'" @click="$emit('favourite')">
      {{ favourite ? '★' : '☆' }}
    </button>
    <button type="button" class="vp-select" @click="$emit('select')">
      <strong>{{ name }}</strong>
      <span>{{ providerLabel }}</span>
    </button>
    <button type="button" class="vp-preview" title="Preview voice" @click="$emit('preview')">▶</button>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  name: string
  selected: boolean
  favourite: boolean
  providerLabel: string
}>()

defineEmits<{
  select: []
  favourite: []
  preview: []
}>()
</script>

<style scoped>
.vp-row { display: flex; align-items: center; gap: 5px; padding: 5px; border: 1px solid transparent; border-radius: var(--radius-sm); }
.vp-row:hover, .vp-row.selected { background: var(--bg-tertiary); border-color: var(--border); }
.vp-row.selected { border-color: var(--accent); background: var(--accent-dim); }
.vp-star { border: 0; background: transparent; color: var(--text-muted); cursor: pointer; font-size: 15px; }
.vp-star.favourite, .vp-star:hover { color: var(--accent); }
.vp-select { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 2px; border: 0; background: transparent; color: inherit; cursor: pointer; text-align: left; }
.vp-select strong { font-size: 13px; }
.vp-select span { color: var(--text-muted); font-size: 10px; }
.vp-preview { padding: 3px 8px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: transparent; color: var(--accent); cursor: pointer; }
</style>
