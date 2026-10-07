<template>
  <!-- v1.0.183 — Phase 2 scaffold. The reusable "what shapes this step"
       context strip, extracted from the Ideas + Script pages which each
       hand-rolled the same bordered strip + warn state + clickable summary
       + expandable detail. Pages supply their own summary line (chips /
       key+value) via the `summary` slot and their own detail via the default
       slot; this component owns the chrome: border, warning tint, the toggle
       button, and the expand/collapse.

       Usage:
         <ContextStrip v-model:open="x" :has-warning="needsAttn" warn-label="⚠ check">
           <template #summary>…chips / summary line…</template>
           …detail panel…
         </ContextStrip>

       - v-model:open       — open/closed state (two-way).
       - hasWarning         — tints the strip amber + shows warnLabel.
       - warnLabel          — chip shown when hasWarning (e.g. "⚠ check").
       - openLabel/closedLabel — the toggle text per state.
       - persistKey         — optional per-project localStorage memory. -->
  <div class="context-strip" :class="{ 'has-warning': hasWarning }">
    <button
      type="button"
      class="context-summary"
      :aria-expanded="isOpen"
      @click="toggle"
    >
      <span class="context-summary-content"><slot name="summary" /></span>
      <span v-if="hasWarning && warnLabel" class="context-warn">{{ warnLabel }}</span>
      <span class="context-toggle" aria-hidden="true">{{ isOpen ? openLabel : closedLabel }}</span>
    </button>
    <div v-show="isOpen" class="context-detail">
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'

const props = withDefaults(defineProps<{
  open?: boolean
  hasWarning?: boolean
  warnLabel?: string
  openLabel?: string
  closedLabel?: string
  persistKey?: string
}>(), {
  hasWarning: false,
  warnLabel: '⚠ check',
  openLabel: '▾ Hide detail',
  closedLabel: '⚙ Show detail',
})

const emit = defineEmits<{ 'update:open': [boolean] }>()

function readInitial(): boolean {
  if (props.open !== undefined) return props.open
  if (props.persistKey && typeof localStorage !== 'undefined') {
    const v = localStorage.getItem(props.persistKey)
    if (v === '1') return true
    if (v === '0') return false
  }
  return false
}

const isOpen = ref(readInitial())
watch(() => props.open, (v) => { if (v !== undefined && v !== isOpen.value) isOpen.value = v })

function toggle() { isOpen.value = !isOpen.value }

watch(isOpen, (v) => {
  emit('update:open', v)
  if (props.persistKey && typeof localStorage !== 'undefined') {
    localStorage.setItem(props.persistKey, v ? '1' : '0')
  }
})
</script>

<style scoped>
.context-strip {
  margin-top: 10px;
  border: 1px solid var(--border, #2a2a2a);
  border-left: 3px solid var(--accent, #6c8fff);
  border-radius: var(--radius-sm, 6px);
  background: var(--bg-tertiary, #1c1c1c);
  overflow: hidden;
}
.context-strip.has-warning {
  border-left-color: color-mix(in srgb, var(--accent) 85%, transparent);
  background: color-mix(in srgb, var(--accent) 4%, transparent);
}
.context-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 9px 14px;
  background: transparent;
  border: none;
  cursor: pointer;
  text-align: left;
  font-size: 13px;
  color: var(--text-primary, #e6e6e6);
}
.context-summary:hover { background: rgba(255, 255, 255, 0.02); }
.context-summary-content {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  flex: 1 1 auto;
  min-width: 0;
}
.context-warn {
  flex: 0 0 auto;
  font-size: var(--font-xs);
  color: color-mix(in srgb, var(--accent) 95%, transparent);
  padding: 1px 8px;
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  border-radius: 999px;
}
.context-toggle {
  margin-left: auto;
  flex: 0 0 auto;
  font-size: 12px;
  color: var(--accent, #6c8fff);
  white-space: nowrap;
}
.context-detail {
  padding: 2px 14px 12px;
  border-top: 1px dashed var(--border, #2a2a2a);
}
.context-detail > * { margin-top: 10px; }

/* Shared sub-styles used by callers inside the summary/detail slots so each
   page doesn't redeclare them. */
:slotted(.ctx-key),
:slotted(.context-key) {
  color: var(--text-muted, #9a9a9a);
  font-size: var(--font-xs);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
:slotted(.is-fallback) { color: var(--text-muted, #9a9a9a); font-style: italic; font-weight: normal; }
:slotted(.context-dot) { color: var(--border, #3a3a3a); }
:slotted(.context-override) { color: var(--accent, #6c8fff); font-size: var(--font-xs); }
</style>
