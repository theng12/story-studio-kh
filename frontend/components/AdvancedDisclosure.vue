<template>
  <!-- v1.0.182 — Phase 2 scaffold. The reusable "Advanced options" collapsible
       extracted from the Script / Metadata / Audio-Assembly pages, which each
       hand-rolled the same toggle + body + per-project persistence. Centralising
       it means every flow page (and future formats) gets the identical look +
       behaviour for free, and the beginner-friendly "power knobs are one click
       away" pattern is enforced rather than copy-pasted.

       Usage:
         <AdvancedDisclosure label="Advanced options">…power controls…</AdvancedDisclosure>
         <AdvancedDisclosure label="Audio layers (…)" persist-key="audio_merge_advanced_open_<slug>">…</AdvancedDisclosure>

       - `label`       — the toggle text (the ▸/▾ chevron is prepended automatically).
       - `persistKey`  — optional localStorage key; when set, open/closed state is
                          remembered across reloads (pass a per-project key).
       - `defaultOpen` — initial state when there's no persisted value.
       - `badge`       — optional small chip on the right (e.g. "⚠ check").
       - v-model:open  — optional two-way binding if the parent needs the state. -->
  <div class="adv-disclosure">
    <button
      type="button"
      class="adv-disclosure-toggle"
      :aria-expanded="isOpen"
      @click="toggle"
    >
      <span class="adv-disclosure-chevron" aria-hidden="true">{{ isOpen ? '▾' : '▸' }}</span>
      <span class="adv-disclosure-label">{{ label }}</span>
      <span v-if="badge" class="adv-disclosure-badge">{{ badge }}</span>
    </button>
    <div v-show="isOpen" class="adv-disclosure-body">
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'

const props = withDefaults(defineProps<{
  label: string
  persistKey?: string
  defaultOpen?: boolean
  badge?: string
  /** Two-way open state (optional). */
  open?: boolean
}>(), {
  defaultOpen: false,
})

const emit = defineEmits<{ 'update:open': [boolean] }>()

function readInitial(): boolean {
  if (props.open !== undefined) return props.open
  if (props.persistKey && typeof localStorage !== 'undefined') {
    const v = localStorage.getItem(props.persistKey)
    if (v === '1') return true
    if (v === '0') return false
  }
  return props.defaultOpen
}

const isOpen = ref(readInitial())

// Keep in sync if the parent drives `open`.
watch(() => props.open, (v) => { if (v !== undefined && v !== isOpen.value) isOpen.value = v })

function toggle() {
  isOpen.value = !isOpen.value
}

watch(isOpen, (v) => {
  emit('update:open', v)
  if (props.persistKey && typeof localStorage !== 'undefined') {
    // Persist both states explicitly ('0' vs '1') so a deliberate close is
    // remembered, not treated as "never set → fall back to defaultOpen".
    localStorage.setItem(props.persistKey, v ? '1' : '0')
  }
})
</script>

<style scoped>
.adv-disclosure { margin-top: 10px; }
.adv-disclosure-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 8px 12px;
  background: transparent;
  border: 1px dashed var(--border, #2a2a2a);
  border-radius: var(--radius-sm, 6px);
  cursor: pointer;
  text-align: left;
  font-size: 12px;
  color: var(--text-muted, #9a9a9a);
  transition: color 0.12s, border-color 0.12s;
}
.adv-disclosure-toggle:hover {
  color: var(--text-primary, #e6e6e6);
  border-color: var(--accent, #6c8fff);
}
.adv-disclosure-chevron { flex: 0 0 auto; font-size: 11px; }
.adv-disclosure-label { flex: 1 1 auto; }
.adv-disclosure-badge {
  flex: 0 0 auto;
  font-size: 11px;
  color: rgba(240, 198, 116, 0.95);
  padding: 1px 8px;
  background: rgba(240, 198, 116, 0.12);
  border-radius: 999px;
}
.adv-disclosure-body { margin-top: 10px; }
</style>
