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
        @keydown.enter.prevent="results[0] && go(results[0])"
      />
    </label>

    <div v-if="query.trim()" class="settings-search-results" role="list" aria-label="Matching settings">
      <button
        v-for="hit in results"
        :key="`${hit.section}:${hit.anchor}:${hit.label}`"
        type="button"
        class="settings-search-hit"
        role="listitem"
        @click="go(hit)"
      >
        <strong>{{ hit.label }}</strong>
        <span>{{ hit.sectionLabel }}</span>
      </button>
      <p v-if="!results.length" class="settings-search-empty" role="status">
        Nothing matches “{{ query.trim() }}”. Try a word like “schedule”, “folder” or “alerts”.
      </p>
    </div>

    <nav v-else aria-label="Settings sections">
      <section v-for="zone in zones" :key="zone.id" class="settings-nav-scope" :data-settings-scope="zone.id">
        <header>
          <strong>{{ zone.title }}</strong>
          <span>{{ zone.scope }}</span>
        </header>
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
      </section>
    </nav>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { searchSettings, type SettingEntry, type SettingsZoneDef } from '~/utils/settingsIndex'

defineProps<{ zones: SettingsZoneDef[]; modelValue: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: string]; go: [hit: SettingEntry] }>()

const query = ref('')
const results = computed(() => searchSettings(query.value))

function go(hit: SettingEntry): void {
  emit('update:modelValue', hit.section)
  emit('go', hit)
  query.value = ''
}
</script>

<style scoped>
.settings-section-nav { display: grid; gap: 12px; align-content: start; }
.settings-search { display: block; }
.sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.settings-section-nav { position: relative; }
.settings-search input {
  width: 100%; min-height: 36px; padding: 7px 10px; border: 1px solid var(--border);
  border-radius: 6px; background: var(--bg-primary); color: var(--text-primary); font: inherit; font-size: 13px;
}
.settings-search input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
nav { display: grid; gap: 14px; }
.settings-nav-scope { display: grid; gap: 2px; }
.settings-nav-scope > header { display: grid; gap: 1px; margin: 0 0 4px; padding: 0 8px; }
.settings-nav-scope > header strong { color: var(--text-secondary); font-size: var(--font-xs); font-weight: 600; }
.settings-nav-scope > header span { color: var(--text-muted); font-size: var(--font-xs); }
.settings-nav-scope a {
  display: grid; gap: 1px; padding: 7px 8px; border-radius: 6px;
  color: var(--text-secondary); text-decoration: none;
}
.settings-nav-scope a strong { color: var(--text-primary); font-size: 13px; font-weight: 500; }
.settings-nav-scope a span { overflow: hidden; color: var(--text-muted); font-size: var(--font-xs); line-height: 1.35; text-overflow: ellipsis; white-space: nowrap; }
.settings-nav-scope a:hover { background: var(--bg-tertiary); }
.settings-nav-scope a:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.settings-nav-scope a.active { background: var(--accent-dim); }
.settings-nav-scope a.active strong { font-weight: 600; }
.settings-search-results { display: grid; gap: 2px; }
.settings-search-hit {
  display: grid; gap: 1px; padding: 7px 8px; border: 0; border-radius: 6px;
  background: transparent; color: inherit; text-align: left; cursor: pointer; font: inherit;
}
.settings-search-hit:hover, .settings-search-hit:focus-visible { background: var(--bg-tertiary); outline: none; }
.settings-search-hit strong { color: var(--text-primary); font-size: 13px; font-weight: 500; }
.settings-search-hit span { color: var(--text-muted); font-size: var(--font-xs); }
.settings-search-empty { margin: 0; padding: 10px 8px; color: var(--text-muted); font-size: 12px; }
</style>
