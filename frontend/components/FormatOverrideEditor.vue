<template>
  <div class="override-editor">
    <header class="oe-header">
      <div>
        <strong>Per-project overrides</strong>
        <div class="oe-hint">
          Tweak individual format fields without forking the whole format. Each row shows the base value
          (from <em>{{ baseFormat?.name || 'the selected format' }}</em>); toggle "override" to replace it
          for this project only. Empty overrides revert to the base.
        </div>
      </div>
      <button v-if="hasAnyOverride" class="btn btn-ghost btn-sm" @click="clearAll">
        Clear all overrides
      </button>
    </header>

    <div v-if="!baseFormat" class="oe-empty">Select a format above to edit its overrides.</div>

    <div v-else class="oe-tabs">
      <button
        v-for="t in tabs" :key="t.id"
        :class="['oe-tab', { active: activeTab === t.id }]"
        @click="activeTab = t.id"
      >
        {{ t.label }}<span v-if="tabHasOverride(t.id)" class="dot" title="this stage has overrides" />
      </button>
    </div>

    <!-- ── SCRIPT ── -->
    <div v-if="baseFormat && activeTab === 'script'" class="oe-pane">
      <OverrideField
        label="Closing hint"
        hint="One-line guidance appended to the script prompt — sets the emotional landing for every episode (e.g. 'drifting into sleep' for sleep stories, 'earned catharsis' for adventure)."
        :base-value="baseFormat.script.closingHint"
        :override-value="overrides.script?.closingHint"
        type="textarea"
        @update="(v: any) => setOverride(['script', 'closingHint'], v)"
      />
      <OverrideField
        label="Default chapter count"
        hint="Suggested chapter count when the user picks 'auto'. The user can still override per-episode."
        :base-value="baseFormat.script.defaultChapterCount"
        :override-value="overrides.script?.defaultChapterCount"
        type="number"
        :min="1" :max="40"
        @update="(v: any) => setOverride(['script', 'defaultChapterCount'], v)"
      />
      <OverrideField
        label="Default length (minutes)"
        hint="Suggested target duration when the user picks 'auto'. Drives word-count math too."
        :base-value="baseFormat.script.defaultLengthMinutes"
        :override-value="overrides.script?.defaultLengthMinutes"
        type="number"
        :min="5" :max="240"
        @update="(v: any) => setOverride(['script', 'defaultLengthMinutes'], v)"
      />
      <OverrideField
        label="Default narrator style"
        hint="Which narrator persona is selected by default for new episodes. Pick from the format's narrator pool."
        :base-value="baseFormat.script.defaultNarratorStyleId"
        :override-value="overrides.script?.defaultNarratorStyleId"
        type="select"
        :options="baseFormat.script.narratorStyles.map(n => ({ value: n.id, label: `${n.id} — ${n.label}` }))"
        @update="(v: any) => setOverride(['script', 'defaultNarratorStyleId'], v)"
      />
    </div>

    <!-- ── IMAGE PROMPTS ── -->
    <div v-if="baseFormat && activeTab === 'imagePrompts'" class="oe-pane">
      <OverrideField
        label="Visual style hint"
        hint="Short description of the visual vibe — surfaces in pickers and per-prompt guidance."
        :base-value="baseFormat.imagePrompts.visualStyleHint"
        :override-value="overrides.imagePrompts?.visualStyleHint"
        type="textarea"
        @update="(v: any) => setOverride(['imagePrompts', 'visualStyleHint'], v)"
      />
      <OverrideField
        label="Default style tag"
        hint="Appended to every generated image prompt. Drives provider rendering style consistently across episodes."
        :base-value="baseFormat.imagePrompts.defaultStyleTag"
        :override-value="overrides.imagePrompts?.defaultStyleTag"
        type="textarea"
        @update="(v: any) => setOverride(['imagePrompts', 'defaultStyleTag'], v)"
      />
      <OverrideField
        label="Default thumbnails per episode"
        hint="How many thumbnail prompt variants the LLM generates per episode."
        :base-value="baseFormat.imagePrompts.defaultThumbnails"
        :override-value="overrides.imagePrompts?.defaultThumbnails"
        type="number"
        :min="1" :max="20"
        @update="(v: any) => setOverride(['imagePrompts', 'defaultThumbnails'], v)"
      />
    </div>

    <!-- ── METADATA ── -->
    <div v-if="baseFormat && activeTab === 'metadata'" class="oe-pane">
      <OverrideField
        label="Title style hint"
        hint="One-line guidance for the SEO title generator. Replaces the format's title tone instructions."
        :base-value="baseFormat.metadata.titleStyleHint"
        :override-value="overrides.metadata?.titleStyleHint"
        type="textarea"
        @update="(v: any) => setOverride(['metadata', 'titleStyleHint'], v)"
      />
      <OverrideField
        label="Broad keyword pool"
        hint="Always-included tags / keyword pool for the YouTube tag generator. Comma-separated."
        :base-value="baseFormat.metadata.broadKeywords.join(', ')"
        :override-value="overrides.metadata?.broadKeywords?.join(', ')"
        type="textarea"
        @update="(v: any) => setOverride(['metadata', 'broadKeywords'], parseCommaList(v))"
      />
    </div>

    <!-- ── IDEA ── -->
    <div v-if="baseFormat && activeTab === 'idea'" class="oe-pane">
      <OverrideField
        label="Audience default"
        hint="Default 'target audience' value when generating new ideas — fills the Audience field if the user leaves it blank."
        :base-value="baseFormat.idea.audienceDefault"
        :override-value="overrides.idea?.audienceDefault"
        type="text"
        @update="(v: any) => setOverride(['idea', 'audienceDefault'], v)"
      />
      <OverrideField
        label="Idea-generation rules"
        hint="Free-form guidance injected into every idea-generation prompt. Format-specific constraints (e.g. 'no jump scares')."
        :base-value="baseFormat.idea.guidanceText"
        :override-value="overrides.idea?.guidanceText"
        type="textarea"
        @update="(v: any) => setOverride(['idea', 'guidanceText'], v)"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import OverrideField from './OverrideField.vue'
import type { Format } from '../composables/useFormats.js'

type Path = readonly (string | number)[]
// DeepPartial<Format> as a loose-typed object for editing convenience.
type Overrides = Record<string, any>

const props = defineProps<{
  baseFormat: Format | null
  modelValue: Overrides | null | undefined
}>()

const emit = defineEmits<{
  'update:modelValue': [value: Overrides | null]
}>()

const overrides = computed<Overrides>(() => props.modelValue || {})
const activeTab = ref<'script' | 'imagePrompts' | 'metadata' | 'idea'>('script')

const tabs = [
  { id: 'script' as const, label: 'Script' },
  { id: 'imagePrompts' as const, label: 'Image' },
  { id: 'metadata' as const, label: 'Metadata' },
  { id: 'idea' as const, label: 'Ideas' },
]

const hasAnyOverride = computed(() => Object.keys(overrides.value).length > 0)

function tabHasOverride(tabId: string): boolean {
  const stage = overrides.value[tabId]
  return stage && typeof stage === 'object' && Object.keys(stage).length > 0
}

/**
 * Set or clear an override at a deep path. `value` undefined → clear that key
 * (and prune empty parents up the tree so toggling all overrides off cleans
 * the saved object back to {}).
 */
function setOverride(path: Path, value: any) {
  const next = JSON.parse(JSON.stringify(overrides.value || {}))
  let cursor: any = next
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i] as string
    if (cursor[k] == null || typeof cursor[k] !== 'object') cursor[k] = {}
    cursor = cursor[k]
  }
  const leafKey = path[path.length - 1] as string
  if (value === undefined || value === null || value === '') {
    delete cursor[leafKey]
  } else {
    cursor[leafKey] = value
  }
  // Prune empty parents.
  const pruned = pruneEmpty(next)
  emit('update:modelValue', Object.keys(pruned).length === 0 ? null : pruned)
}

function pruneEmpty(obj: any): any {
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) return obj
  const out: any = {}
  for (const k of Object.keys(obj)) {
    const v = pruneEmpty(obj[k])
    if (v !== undefined && !(typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0)) {
      out[k] = v
    }
  }
  return out
}

function clearAll() {
  emit('update:modelValue', null)
}

function parseCommaList(s: string): string[] {
  return s.split(',').map(x => x.trim()).filter(Boolean)
}
</script>

<style scoped>
.override-editor {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 6px);
  background: var(--bg-secondary);
}

.oe-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
}

.oe-hint {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 2px;
  line-height: 1.4;
  max-width: 540px;
}

.btn-sm { font-size: 11px; padding: 4px 8px; }

.oe-empty {
  font-size: 12px;
  color: var(--text-muted);
  padding: 12px 0;
}

.oe-tabs {
  display: flex;
  gap: 2px;
  border-bottom: 1px solid var(--border);
}

.oe-tab {
  padding: 6px 12px;
  font-size: 12px;
  font-family: inherit;
  background: transparent;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  position: relative;
}

.oe-tab.active {
  color: var(--text-primary);
  border-bottom-color: var(--accent, #6c8fff);
}

.oe-tab .dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent, #6c8fff);
  margin-left: 6px;
  vertical-align: middle;
}

.oe-pane {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-top: 6px;
}
</style>
