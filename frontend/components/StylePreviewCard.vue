<!--
  Style Preview card for /projects/:slug/images.

  Free-form textarea + Preview button. Renders ONE sample image of the
  user's typed style description against a fixed neutral baseline scene,
  using whatever model + aspect + tier they've picked on the page.
  Cached app-wide by sha256(style + model + aspect + tier) so re-clicks
  on the same combo are free.

  Episode-independent — visible at the top of /images even when no
  episode is selected. Useful for "what does 'oil painting at golden
  hour' look like on Flux Kontext at 16:9?" exploration before
  committing to an episode batch.
-->
<template>
  <div class="card mt-2 spc">
    <div class="spc-head">
      <h3 class="spc-title">🎨 Try a style</h3>
      <span class="text-muted text-xs">~$0.005 first time on this combo, free thereafter</span>
    </div>
    <p class="text-muted text-sm spc-blurb">
      Type a style description and render one sample with your current
      <strong>{{ modelLabel }}</strong> · <strong>{{ aspectRatio }}</strong>{{ tier ? ` · ${tier}` : '' }}.
      Quick visual gut-check before kicking off a full batch.
    </p>
    <textarea
      v-model="styleText"
      class="textarea spc-textarea"
      rows="3"
      placeholder="e.g. oil painting at golden hour, soft brush strokes, warm palette, 2D illustration"
    />
    <div class="spc-controls">
      <button
        type="button"
        class="btn btn-sm btn-secondary"
        :disabled="state.loading || !styleText.trim() || !model"
        :title="!styleText.trim()
          ? 'Type a style description first'
          : !model
            ? 'Pick an image model first'
            : state.cached === true
              ? 'Cached preview — free. Edit the style above or change model/aspect/tier to invalidate.'
              : state.cached === false
                ? 'Generated a fresh sample. Cached now — re-clicking the same combo is free.'
                : 'Render one sample image of this style with your current model + aspect + tier.'"
        @click="generate"
      >
        <LoadingSpinner v-if="state.loading" size="sm" />
        <span v-else aria-hidden="true">🖼️</span>
        {{ state.loading ? 'Rendering…' : (state.url ? 'Re-preview' : 'Preview style') }}
      </button>
      <span v-if="state.error" class="spc-error" :title="state.error">⚠ {{ state.error }}</span>
    </div>
    <div v-if="state.url" class="spc-thumb-wrap">
      <img :src="state.url" alt="Style preview sample" class="spc-thumb" />
      <div class="spc-thumb-meta">
        <span :class="['spc-tag', state.cached ? 'is-cache' : 'is-fresh']">
          {{ state.cached ? '✓ cached' : '✨ fresh' }}
        </span>
        <span v-if="state.model_id" class="text-muted text-xs">
          {{ state.model_id }}{{ state.aspect_ratio ? ` · ${state.aspect_ratio}` : '' }}{{ state.tier ? ` · ${state.tier}` : '' }}
        </span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'

interface PreviewState {
  loading: boolean
  url: string | null
  cached: boolean | null
  hash: string | null
  model_id: string | null
  aspect_ratio: string | null
  tier: string | null
  /** Style text + model + aspect + tier that produced the rendered
   *  thumbnail. We track this so editing any of those clears the
   *  thumbnail (stale-render protection). */
  signature_at_render: string | null
  error: string | null
}

const props = defineProps<{
  projectSlug: string
  model: string
  aspectRatio: string
  tier?: string
  /** Friendly model label for the blurb — falls back to model id when absent. */
  modelLabel?: string
}>()

const { post } = useApi()

const styleText = ref('')
const state = ref<PreviewState>({
  loading: false,
  url: null,
  cached: null,
  hash: null,
  model_id: null,
  aspect_ratio: null,
  tier: null,
  signature_at_render: null,
  error: null,
})

function currentSignature(): string {
  return `${styleText.value.trim().toLowerCase()}|${props.model}|${props.aspectRatio}|${props.tier || ''}`
}

async function generate(): Promise<void> {
  const styleTag = styleText.value.trim()
  if (!styleTag || state.value.loading || !props.model) return
  state.value.loading = true
  state.value.error = null
  try {
    const data = await post<{
      hash: string; url: string; cached: boolean
      model_id: string; aspect_ratio: string; tier: string
      created_at: string; size_bytes: number
    }>(`/projects/${props.projectSlug}/style-preview`, {
      style_tag: styleTag,
      model: props.model,
      aspect_ratio: props.aspectRatio,
      tier: props.tier || undefined,
    })
    state.value = {
      loading: false,
      url: data.url,
      cached: !!data.cached,
      hash: data.hash,
      model_id: data.model_id,
      aspect_ratio: data.aspect_ratio,
      tier: data.tier || null,
      signature_at_render: currentSignature(),
      error: null,
    }
  } catch (e: any) {
    state.value = {
      ...state.value,
      loading: false,
      error: e?.data?.detail || e?.message || 'Preview failed',
    }
  }
}

// Clear the rendered thumbnail when ANY input that affects the cache key
// changes. Avoids the misleading "this preview matches your current
// settings" implication when the sample on screen no longer matches what
// would be rendered now.
watch([
  styleText,
  () => props.model,
  () => props.aspectRatio,
  () => props.tier,
], () => {
  if (state.value.signature_at_render &&
      state.value.signature_at_render !== currentSignature()) {
    state.value.url = null
    state.value.cached = null
    state.value.hash = null
    state.value.model_id = null
    state.value.aspect_ratio = null
    state.value.tier = null
    state.value.signature_at_render = null
  }
})
</script>

<style scoped>
.spc { padding: 12px 14px; }
.spc-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}
.spc-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}
.spc-blurb {
  margin: 4px 0 8px 0;
}
.spc-textarea {
  width: 100%;
  font-size: 12px;
  resize: vertical;
}
.spc-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 8px;
}
.spc-error {
  font-size: 11px;
  color: rgb(220, 38, 38);
  cursor: help;
}
.spc-thumb-wrap {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: flex-start;
}
.spc-thumb {
  width: 200px;
  height: 200px;
  object-fit: cover;
  border-radius: var(--radius-md);
  border: 1px solid var(--border);
  background: var(--bg-tertiary);
}
.spc-thumb-meta {
  display: flex;
  align-items: center;
  gap: 6px;
}
.spc-tag {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  font-family: var(--font-mono, monospace);
}
.spc-tag.is-cache {
  background: rgba(16, 185, 129, 0.10);
  color: rgb(16, 185, 129);
  border: 1px solid rgba(16, 185, 129, 0.28);
}
.spc-tag.is-fresh {
  background: rgba(245, 158, 11, 0.10);
  color: rgb(180, 120, 8);
  border: 1px solid rgba(245, 158, 11, 0.28);
}
</style>
