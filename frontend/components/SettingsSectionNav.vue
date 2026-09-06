<template>
  <div class="settings-section-nav">
    <label class="settings-search">
      <span class="sr-only">Find a setting</span>
      <input
        v-model="query"
        type="search"
        placeholder="Find a setting…"
        autocomplete="off"
        @keydown.escape="query = ''"
      />
      <span v-if="query" class="settings-search-count" aria-live="polite">
        {{ matchCount }} {{ matchCount === 1 ? 'section' : 'sections' }}
      </span>
    </label>

    <nav aria-label="Settings sections">
      <section
        v-for="zone in filteredZones"
        :key="zone.id"
        class="settings-nav-scope"
        :data-settings-scope="zone.id"
      >
        <header>
          <strong>{{ zone.title }}</strong>
          <span>{{ zone.scope }}</span>
        </header>
        <div class="settings-nav-links">
          <a
            v-for="section in zone.sections"
            :key="section.id"
            :href="`#${section.id}`"
            :class="{ active: modelValue === section.id }"
            :aria-current="modelValue === section.id ? 'page' : undefined"
            @click="$emit('update:modelValue', section.id)"
          >
            <strong>{{ section.label }}</strong>
            <span>{{ section.description }}</span>
          </a>
        </div>
      </section>
    </nav>

    <p v-if="!matchCount" class="settings-search-empty" role="status">
      No settings match “{{ query }}”. Try a feature, service, or file name.
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'

interface SettingsSection {
  id: string
  label: string
  description: string
  keywords?: string
}

interface SettingsZone {
  id: string
  title: string
  scope: string
  sections: SettingsSection[]
}

const props = defineProps<{ zones: SettingsZone[]; modelValue: string }>()
defineEmits<{ 'update:modelValue': [value: string] }>()

const query = ref('')
const normalizedQuery = computed(() => query.value.trim().toLocaleLowerCase())
const filteredZones = computed(() => props.zones
  .map(zone => ({
    ...zone,
    sections: normalizedQuery.value
      ? zone.sections.filter(section => [section.label, section.description, section.keywords]
          .filter(Boolean)
          .join(' ')
          .toLocaleLowerCase()
          .includes(normalizedQuery.value))
      : zone.sections,
  }))
  .filter(zone => zone.sections.length))
const matchCount = computed(() => filteredZones.value.reduce((total, zone) => total + zone.sections.length, 0))
</script>

<style scoped>
.settings-section-nav { display: grid; gap: 12px; margin-top: 16px; }
.settings-search { position: relative; display: block; }
.settings-search input {
  width: 100%; min-height: 42px; padding: 9px 96px 9px 12px; border: 1px solid var(--border);
  border-radius: 10px; background: var(--bg-secondary); color: var(--text-primary); font: inherit;
}
.settings-search input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.settings-search-count { position: absolute; right: 11px; top: 50%; translate: 0 -50%; color: var(--text-muted); font-size: var(--font-xs); }
nav { display: grid; grid-template-columns: minmax(230px, .8fr) minmax(360px, 1.2fr); gap: 12px; }
.settings-nav-scope { min-width: 0; padding: 12px; border: 1px solid var(--border); border-radius: 12px; background: var(--bg-secondary); }
.settings-nav-scope > header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
.settings-nav-scope > header strong { font-size: var(--font-sm); }
.settings-nav-scope > header span { color: var(--text-muted); font-size: var(--font-xs); }
.settings-nav-links { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 5px; }
.settings-nav-links a { display: grid; gap: 2px; min-width: 0; padding: 9px 10px; border: 1px solid transparent; border-radius: 9px; color: var(--text-secondary); text-decoration: none; }
.settings-nav-links a:hover { border-color: var(--border); background: var(--bg-tertiary); color: var(--text-primary); }
.settings-nav-links a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.settings-nav-links a.active { border-color: color-mix(in srgb, var(--accent) 42%, var(--border)); background: var(--accent-dim); color: var(--text-primary); }
.settings-nav-links strong { font-size: var(--font-xs); }
.settings-nav-links span { overflow: hidden; color: var(--text-muted); font-size: var(--font-xs); line-height: 1.35; text-overflow: ellipsis; white-space: nowrap; }
.settings-search-empty { margin: 0; padding: 14px; border: 1px dashed var(--border); border-radius: 10px; color: var(--text-muted); text-align: center; }
@media (max-width: 900px) { nav { grid-template-columns: 1fr; } }
@media (max-width: 560px) {
  .settings-nav-links { grid-template-columns: 1fr; }
  .settings-nav-scope > header { align-items: flex-start; flex-direction: column; gap: 2px; }
}
</style>
