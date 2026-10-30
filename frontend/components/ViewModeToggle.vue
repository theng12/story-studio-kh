<template>
  <div class="view-toggle" role="group" :aria-label="label">
    <button
      v-for="option in options" :key="option.value" type="button"
      :class="['view-toggle-option', { active: modelValue === option.value }]"
      :aria-pressed="modelValue === option.value"
      :title="option.title"
      @click="$emit('update:modelValue', option.value)"
    >
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <template v-if="option.value === 'cards'">
          <rect x="2" y="2.5" width="5" height="5" rx="1" />
          <rect x="9" y="2.5" width="5" height="5" rx="1" />
          <rect x="2" y="9.5" width="5" height="4" rx="1" />
          <rect x="9" y="9.5" width="5" height="4" rx="1" />
        </template>
        <template v-else>
          <rect x="2" y="3" width="3" height="3" rx=".75" />
          <rect x="2" y="10" width="3" height="3" rx=".75" />
          <path d="M7.5 4.5h6.5M7.5 11.5h6.5" />
        </template>
      </svg>
      <span>{{ option.label }}</span>
    </button>
  </div>
</template>

<script setup lang="ts">
/**
 * The one Cards / List switch. Shared so every browsable page reads the same
 * and a page added later does not grow a second-looking control.
 *
 * Text labels, not icons alone: "Cards" and "List" say what the switch does,
 * and the two 16px icons beside them say it again for anyone scanning.
 */
import type { ViewMode } from '~/composables/useViewMode'

withDefaults(defineProps<{ modelValue: ViewMode; label?: string }>(), { label: 'View as' })
defineEmits<{ 'update:modelValue': [value: ViewMode] }>()

const options: Array<{ value: ViewMode; label: string; title: string }> = [
  { value: 'cards', label: 'Cards', title: 'Show pictures side by side' },
  { value: 'list', label: 'List', title: 'Show one row per item' },
]
</script>

<style scoped>
.view-toggle { display: inline-flex; gap: 2px; padding: 3px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg-secondary); }
.view-toggle-option { display: inline-flex; min-height: var(--control-height-sm); align-items: center; gap: 6px; padding: 5px 9px; border: 0; border-radius: calc(var(--radius-md) - 3px); background: transparent; color: var(--text-secondary); cursor: pointer; font: inherit; font-size: var(--font-sm); font-weight: 650; }
.view-toggle-option:hover { color: var(--text-primary); }
.view-toggle-option.active { background: var(--accent-dim); color: var(--text-primary); }
.view-toggle-option svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; }
.view-toggle-option:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
@media (max-width: 560px) { .view-toggle-option { min-height: 44px; } }
</style>
