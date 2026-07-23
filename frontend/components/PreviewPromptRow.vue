<!--
  Single row in the "Preview what will be generated" card on the Image
  Generator page. Shows one prompt (scene or thumbnail) with:

    - Number + title (always visible)
    - Expand-toggle to read the full prompt body
    - 🖼️ Preview button that renders a sample image of THIS prompt with
      the user's currently-selected model / aspect / tier
    - Cached / fresh badge after a successful preview
    - Thumbnail of the rendered sample

  All preview-render state is owned by the parent (images.vue) — this row
  just emits `preview` when clicked and re-renders when the parent passes
  a new `state` prop. Keeps the cache + provider plumbing in one place.
-->
<template>
  <div class="prw">
    <div class="prw-head">
      <button
        type="button"
        class="prw-toggle"
        :aria-expanded="expanded ? 'true' : 'false'"
        :title="expanded ? 'Hide full prompt text' : 'Show full prompt text'"
        @click="expanded = !expanded"
      >
        <span class="prw-toggle-icon" aria-hidden="true">{{ expanded ? '▾' : '▸' }}</span>
        <span class="prw-num">{{ String(row.number).padStart(2, '0') }}</span>
        <span class="prw-title">{{ prefix }} — {{ row.title || `(no title)` }}</span>
      </button>
      <button
        type="button"
        class="btn btn-sm btn-secondary prw-preview-btn"
        :disabled="!!state?.loading"
        :title="state?.cached === true
          ? 'Cached preview — free. Editing the prompt or changing model/aspect/tier invalidates.'
          : state?.cached === false
            ? 'Generated a fresh sample. Cached now — re-clicking is free until you change inputs.'
            : 'Generate one sample image of this prompt with your current model + aspect + tier. ~$0.005 first time, free thereafter for the same combo.'"
        @click="$emit('preview')"
      >
        <LoadingSpinner v-if="state?.loading" size="sm" />
        <span v-else aria-hidden="true">🖼️</span>
        {{ state?.loading ? 'Rendering…' : (state?.url ? 'Re-preview' : 'Preview') }}
      </button>
    </div>

    <div v-if="expanded" class="prw-prompt">{{ row.prompt }}</div>

    <div v-if="state?.error" class="prw-error" :title="state.error">
      ⚠ {{ state.error }}
    </div>

    <div v-if="state?.url" class="prw-thumb-wrap">
      <img :src="state.url" alt="Sample render of this prompt" class="prw-thumb" />
      <div class="prw-thumb-meta">
        <span :class="['prw-tag', state.cached ? 'is-cache' : 'is-fresh']">
          {{ state.cached ? '✓ cached' : '✨ fresh' }}
        </span>
        <span v-if="state.model_id" class="text-muted text-xs">
          {{ previewModelName }}{{ state.aspect_ratio ? ` · ${state.aspect_ratio}` : '' }}{{ state.tier ? ` · ${state.tier}` : '' }}
        </span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
interface PreviewState {
  loading: boolean
  url: string | null
  cached: boolean | null
  hash: string | null
  model_id: string | null
  aspect_ratio: string | null
  tier: string | null
  error: string | null
}
interface PromptRow {
  number: number
  title?: string
  prompt: string
}
const props = defineProps<{
  row: PromptRow
  prefix: string
  state: PreviewState | null
}>()
defineEmits<{ (e: 'preview'): void }>()

import { computed, onMounted, ref } from 'vue'
const expanded = ref(false)
const genStudioModels = useGenStudioModelDisplay()
const previewModelName = computed(() =>
  genStudioModels.displayName(props.state?.model_id) || props.state?.model_id || '',
)

onMounted(() => {
  void genStudioModels.refresh()
})
</script>

<style scoped>
.prw {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-primary);
  padding: 8px 10px;
  margin: 4px 0;
}
.prw-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.prw-toggle {
  flex: 1 1 200px;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  background: none;
  border: none;
  text-align: left;
  cursor: pointer;
  color: var(--text-primary);
}
.prw-toggle:hover { color: var(--accent); }
.prw-toggle-icon {
  display: inline-block;
  width: 12px;
  text-align: center;
  color: var(--text-muted);
}
.prw-num {
  font-family: var(--font-mono, monospace);
  font-size: var(--font-xs);
  color: var(--text-muted);
  font-weight: 600;
}
.prw-title {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.prw-preview-btn { white-space: nowrap; }
.prw-prompt {
  margin-top: 8px;
  padding: 8px 10px;
  background: var(--bg-tertiary);
  border-radius: var(--radius-sm);
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
}
.prw-error {
  margin-top: 6px;
  font-size: var(--font-xs);
  color: rgb(220, 38, 38);
  cursor: help;
}
.prw-thumb-wrap {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: flex-start;
}
.prw-thumb {
  width: 200px;
  height: 200px;
  object-fit: cover;
  border-radius: var(--radius-md);
  border: 1px solid var(--border);
  background: var(--bg-tertiary);
}
.prw-thumb-meta {
  display: flex;
  align-items: center;
  gap: 6px;
}
.prw-tag {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: var(--font-xs);
  font-weight: 600;
  font-family: var(--font-mono, monospace);
}
.prw-tag.is-cache {
  background: rgba(16, 185, 129, 0.10);
  color: rgb(16, 185, 129);
  border: 1px solid rgba(16, 185, 129, 0.28);
}
.prw-tag.is-fresh {
  background: rgba(245, 158, 11, 0.10);
  color: rgb(180, 120, 8);
  border: 1px solid rgba(245, 158, 11, 0.28);
}
</style>
