<template>
  <section class="metadata-checklist" aria-label="Upload checklist">
    <h3>Upload checklist</h3>
    <p class="hint">Field presence only. Missing or unchecked items do not block upload.</p>
    <ul>
      <li v-for="item in checklist" :key="item.field">
        <span>{{ item.label }}<small v-if="item.detail">{{ item.detail }}</small></span>
        <strong :class="item.state === 'present' ? 'tone-success' : item.state === 'missing' ? 'tone-warn' : 'hint'">
          {{ stateLabels[item.state] }}
        </strong>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
interface ChecklistItem {
  field: string
  label: string
  state: 'present' | 'missing' | 'not_checked'
  detail?: string
}
const props = defineProps<{ items?: ChecklistItem[] }>()
const stateLabels = { present: 'Present', missing: 'Missing', not_checked: 'Not checked' }
const checklist = computed<ChecklistItem[]>(() => props.items?.length ? props.items : [
  ['title', 'Title'], ['description', 'Description'], ['tags', 'Tags'], ['thumbnail', 'Thumbnail'],
  ['schedule', 'Schedule'], ['privacy', 'Visibility'], ['category', 'Category'], ['disclosure', 'AI disclosure choice'],
].map(([field, label]) => ({ field, label, state: 'not_checked' })))
</script>

<style scoped>
.metadata-checklist { margin: 1.25rem 0; }
.metadata-checklist h3 { margin: 0 0 .35rem; }
.metadata-checklist p { margin: 0 0 .65rem; }
.metadata-checklist ul { list-style: none; margin: 0; padding: 0; }
.metadata-checklist li { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; padding: .4rem 0; }
.metadata-checklist small { display: block; margin-top: .15rem; color: var(--text-muted); }
.metadata-checklist strong { flex-shrink: 0; font-size: .875rem; font-weight: 600; }
.tone-success { color: var(--success); }
.tone-warn { color: var(--warning, #d97706); }
</style>
