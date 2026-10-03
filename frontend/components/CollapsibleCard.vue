<template>
  <!-- The one collapsible section. A native <details>, so the whole header is
       the click target and Enter / Space toggle it from the keyboard with no
       extra code. The chevron sits INSIDE the header on the right and turns
       when the card opens (styles: `.ds-collapsible` in
       assets/css/design-system.css, so raw `<details class="ds-collapsible">`
       markup looks identical).

       Usage:
         <CollapsibleCard title="Writing instructions"
                          description="Project guidance, intro rules, and reusable presets">
           …body…
         </CollapsibleCard>
         <CollapsibleCard title="Advanced" variant="plain" persist-key="files_advanced_open_<slug>" badge="2 issues" badge-tone="warning">…</CollapsibleCard>

       - `title` / #title       — header text (13–15 px semibold).
       - `description`          — one muted line under the title.
       - `badge` + `badgeTone`  — a small status chip in the header (or #badge slot).
       - `variant`              — 'card' (bordered surface, default) | 'plain' (no border, for use inside a card).
       - `persistKey`           — remember open/closed in localStorage (pass a per-project key).
       - `defaultOpen`, v-model:open — initial / two-way open state. -->
  <details
    class="ds-collapsible"
    :data-variant="variant"
    :open="isOpen"
    @toggle="onToggle"
  >
    <summary class="ds-collapsible-header">
      <span class="ds-collapsible-text">
        <span class="ds-collapsible-title"><slot name="title">{{ title }}</slot></span>
        <span v-if="description || $slots.description" class="ds-collapsible-description">
          <slot name="description">{{ description }}</slot>
        </span>
      </span>
      <span v-if="badge || $slots.badge" class="ds-chip" :data-tone="badgeTone">
        <slot name="badge">{{ badge }}</slot>
      </span>
      <span class="ds-collapsible-chevron" aria-hidden="true" />
    </summary>
    <div class="ds-collapsible-body">
      <slot />
    </div>
  </details>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'

const props = withDefaults(defineProps<{
  title?: string
  description?: string
  badge?: string
  badgeTone?: 'neutral' | 'info' | 'success' | 'warning' | 'error'
  variant?: 'card' | 'plain'
  persistKey?: string
  defaultOpen?: boolean
  open?: boolean
}>(), {
  title: '',
  description: '',
  badge: '',
  badgeTone: 'neutral',
  variant: 'card',
  persistKey: '',
  defaultOpen: false,
  open: undefined,
})

const emit = defineEmits<{ 'update:open': [boolean] }>()

function readInitial(): boolean {
  if (props.open !== undefined) return props.open
  if (props.persistKey) {
    try {
      const stored = localStorage.getItem(props.persistKey)
      if (stored === '1') return true
      if (stored === '0') return false
    } catch { /* storage unavailable — fall back to the default */ }
  }
  return props.defaultOpen
}

const isOpen = ref(readInitial())

watch(() => props.open, (value) => {
  if (value !== undefined && value !== isOpen.value) isOpen.value = value
})

function onToggle(event: Event) {
  const open = (event.target as HTMLDetailsElement).open
  if (open === isOpen.value) return
  isOpen.value = open
  emit('update:open', open)
  if (props.persistKey) {
    try { localStorage.setItem(props.persistKey, open ? '1' : '0') } catch { /* not persisted */ }
  }
}
</script>
