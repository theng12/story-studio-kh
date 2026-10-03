<template>
  <!-- A card that opens and closes. The chevron is drawn inside the card and
       centred on the title, replacing the native ▶ marker that sat outside
       the card edge (`list-style-position: outside`) in Writing & style.
       NOTE FOR MERGE: ux/settings local copy of ux/design-system's
       CollapsibleCard (title, subtitle, default slot, v-model:open); keep one. -->
  <details class="collapsible-card" :open="isOpen" @toggle="onToggle">
    <summary class="collapsible-card-summary">
      <span class="collapsible-card-chevron" aria-hidden="true" />
      <span class="collapsible-card-heading">
        <strong>{{ title }}</strong>
        <small v-if="subtitle">{{ subtitle }}</small>
      </span>
      <span v-if="$slots.badge" class="collapsible-card-badge"><slot name="badge" /></span>
    </summary>
    <div class="collapsible-card-body"><slot /></div>
  </details>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'

const props = withDefaults(defineProps<{ title: string; subtitle?: string; open?: boolean }>(), { subtitle: '', open: false })
const emit = defineEmits<{ 'update:open': [value: boolean] }>()
const isOpen = ref(props.open)
watch(() => props.open, value => { isOpen.value = value })
function onToggle(event: Event): void {
  isOpen.value = (event.target as HTMLDetailsElement).open
  emit('update:open', isOpen.value)
}
</script>

<style scoped>
.collapsible-card { border: 1px solid var(--border); border-radius: 8px; background: var(--bg-secondary); }
.collapsible-card-summary {
  display: flex; align-items: center; gap: 10px; padding: 12px 16px;
  list-style: none; cursor: pointer; border-radius: 8px;
}
.collapsible-card-summary::-webkit-details-marker { display: none; }
.collapsible-card-summary::marker { content: ''; }
.collapsible-card-summary:hover { background: var(--bg-tertiary); }
.collapsible-card-summary:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.collapsible-card-chevron {
  flex: 0 0 auto; width: 7px; height: 7px; margin: 0 2px;
  border-right: 2px solid var(--text-muted); border-bottom: 2px solid var(--text-muted);
  transform: rotate(-45deg); transition: transform .15s ease;
}
.collapsible-card[open] > .collapsible-card-summary .collapsible-card-chevron { transform: rotate(45deg); }
.collapsible-card-heading { display: grid; flex: 1 1 auto; gap: 2px; min-width: 0; }
.collapsible-card-heading strong { color: var(--text-primary); font-size: 14px; }
.collapsible-card-heading small { color: var(--text-muted); font-size: 12px; font-weight: 400; }
.collapsible-card-badge { flex: 0 0 auto; }
.collapsible-card[open] > .collapsible-card-summary { border-bottom: 1px solid var(--border); border-radius: 8px 8px 0 0; }
.collapsible-card-body { padding: 16px; }
</style>
