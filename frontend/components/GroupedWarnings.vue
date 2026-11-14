<template>
  <!-- One line per distinct warning. A warning that appears on several items
       says how many times and how many items it affects, and expands to name
       them. Singles read as a plain line. -->
  <section v-if="groups.length" class="grouped-warnings" aria-label="Warnings">
    <template v-for="group in groups" :key="group.text">
      <details v-if="group.items.length > 1" class="grouped-warning is-repeated">
        <summary>
          <strong>{{ group.count }}×</strong>
          <span class="grouped-warning-text">{{ group.text }}</span>
          <span class="grouped-warning-count">across {{ group.items.length }} {{ itemNoun }}</span>
        </summary>
        <ul>
          <li v-for="item in group.items" :key="item">{{ item }}</li>
        </ul>
      </details>
      <p v-else class="grouped-warning">
        <span class="grouped-warning-text">{{ group.text }}</span>
      </p>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'

interface WarningEntry {
  /** The sentence shown to the customer. Identical sentences are grouped. */
  text: string
  /** The item the warning belongs to; never repeated for the same item. */
  item: string
}

const props = withDefaults(defineProps<{
  entries: readonly WarningEntry[]
  itemNoun?: string
}>(), { itemNoun: 'items' })

const groups = computed(() => {
  const byText = new Map<string, { text: string; count: number; items: string[] }>()
  for (const entry of props.entries) {
    const text = String(entry.text || '').trim()
    if (!text) continue
    const group = byText.get(text) || { text, count: 0, items: [] }
    group.count += 1
    if (!group.items.includes(entry.item)) group.items.push(entry.item)
    byText.set(text, group)
  }
  return [...byText.values()]
})
</script>

<style scoped>
.grouped-warnings { display: grid; gap: 6px; margin-top: 12px; }
.grouped-warning {
  margin: 0;
  padding: 9px 12px;
  border: 1px solid color-mix(in srgb, var(--warning) 38%, var(--border));
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--warning) 8%, var(--bg-secondary));
  color: var(--text-primary);
  font-size: var(--font-sm);
  line-height: 1.45;
}
details.grouped-warning > summary {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
  cursor: pointer;
  list-style: none;
}
details.grouped-warning > summary::-webkit-details-marker { display: none; }
details.grouped-warning > summary::before {
  content: '▸';
  color: var(--warning);
  font-size: var(--font-xs);
}
details.grouped-warning[open] > summary::before { content: '▾'; }
.grouped-warning strong { color: var(--warning); font-variant-numeric: tabular-nums; }
.grouped-warning-text { min-width: 0; }
.grouped-warning-count { color: var(--text-secondary); font-size: var(--font-xs); }
.grouped-warning ul { margin: 8px 0 0 18px; padding: 0; color: var(--text-secondary); font-size: var(--font-xs); }
</style>
