<template>
  <div class="vp-row" :class="{ selected, unavailable: disabled }">
    <button
      type="button"
      class="vp-star"
      :class="{ favourite }"
      :disabled="saving"
      :title="saveTitle"
      :aria-label="saveTitle"
      @click="$emit('favourite')"
    >
      {{ saving ? '⋯' : favourite ? '★' : '☆' }}
    </button>
    <button type="button" class="vp-select" :disabled="disabled" :title="disabled ? disabledReason : undefined" @click="$emit('select')">
      <strong>{{ name }}</strong>
      <span class="vp-meta">
        <template v-for="(part, index) in metaParts" :key="part">
          <span v-if="index" aria-hidden="true"> · </span>{{ part }}
        </template>
      </span>
      <span v-if="description" class="vp-description">{{ description }}</span>
      <span v-if="disabled && disabledReason" class="vp-unavailable">{{ disabledReason }}</span>
    </button>
    <button
      type="button"
      class="vp-preview"
      :disabled="!previewAvailable"
      :title="previewAvailable ? (previewNotice || 'Play saved voice preview') : 'No preview is available for this voice yet'"
      :aria-label="previewAvailable ? `Play ${name} preview` : `${name} preview unavailable`"
      @click="$emit('preview')"
    >▶</button>
  </div>
</template>

<script setup lang="ts">
/**
 * One voice row. Every line it renders comes from a field GenStudio published
 * for that voice — provider and engine identity included (AGENTS.md → Provider
 * Transparency). An absent field renders nothing rather than a placeholder.
 */
const props = withDefaults(defineProps<{
  name: string
  selected: boolean
  favourite: boolean
  /** Published provider/engine identity, already resolved by the caller. */
  providerLabel?: string
  language?: string
  description?: string
  /** The model serving this voice. Shown when the list is not model-scoped. */
  modelName?: string
  previewAvailable?: boolean
  previewNotice?: string | null
  disabled?: boolean
  disabledReason?: string
  saving?: boolean
}>(), {
  providerLabel: '',
  language: '',
  description: '',
  modelName: '',
  previewAvailable: false,
  previewNotice: null,
  disabled: false,
  disabledReason: '',
  saving: false,
})

defineEmits<{
  select: []
  favourite: []
  preview: []
}>()

const metaParts = computed(() =>
  [props.language, props.providerLabel, props.modelName].filter(Boolean))
const saveTitle = computed(() => props.favourite ? 'Remove from your saved voices' : 'Save to your Gateway voices')
</script>

<style scoped>
.vp-row { display: flex; align-items: center; gap: 5px; padding: 5px; border: 1px solid transparent; border-radius: var(--radius-sm); }
.vp-row:hover, .vp-row.selected { background: var(--bg-tertiary); border-color: var(--border); }
.vp-row.selected { border-color: var(--accent); background: var(--accent-dim); }
.vp-row.unavailable { opacity: .62; }
.vp-star { border: 0; background: transparent; color: var(--text-muted); cursor: pointer; font-size: 15px; }
.vp-star.favourite, .vp-star:hover { color: var(--accent); }
.vp-star:disabled { cursor: progress; }
.vp-select { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 2px; border: 0; background: transparent; color: inherit; cursor: pointer; text-align: left; }
.vp-select:disabled { cursor: not-allowed; }
.vp-select strong { font-size: 13px; }
.vp-select span { color: var(--text-muted); font-size: var(--font-xs); }
.vp-description { display: -webkit-box; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.vp-unavailable { color: rgb(245,158,11); }
.vp-preview { padding: 3px 8px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: transparent; color: var(--accent); cursor: pointer; }
.vp-preview:disabled { color: var(--text-muted); cursor: not-allowed; opacity: .45; }
</style>
