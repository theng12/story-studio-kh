<!--
  Single row inside ImageGeneratorPanel. Renders one image-prompt as:
   - A small preview thumbnail (or "not rendered yet" placeholder)
   - Numbered title + prefix ("Scene 03", "Thumbnail 01")
   - Generate (when no image on disk) / Regenerate (when one exists) button
   - Optional expandable prompt text for review

  Owns no fetch state — parent (ImageGeneratorPanel) drives generation
  via `busy` + `error` props and listens for the `@generate` event with
  the row's number.

  Mirrors PromptReviewPanelRow's shape so the page reads as one
  consistent surface; the difference is the inline image preview to the
  left of the title row.
-->
<template>
  <div class="igr">
    <div class="igr-head">
      <!-- Preview thumbnail. Renders an <img> when an imagePath is
           provided; placeholder dashed box otherwise. Click opens a
           full-size lightbox (delegated via emit so the parent can
           plug into the existing ImageEditDialog / lightbox flow). -->
      <button
        v-if="imagePath"
        type="button"
        class="igr-thumb"
        :title="`Preview ${prefix} ${row.number}`"
        @click="$emit('open-preview', imagePath)"
      >
        <ResilientImage
          :src="thumbUrl"
          :alt="`${prefix} ${row.number}`"
          class="igr-thumb-img"
          loading="lazy"
          compact
          :manual-retry="false"
        />
      </button>
      <div v-else class="igr-thumb igr-thumb-placeholder" aria-label="No image rendered yet">
        <span class="igr-thumb-placeholder-icon" aria-hidden="true">⊘</span>
      </div>

      <!-- Title block: expand-toggle + prefix + number + status badge.
           The whole row label is one big toggle button so the click
           target is generous (matches PromptReviewPanelRow). -->
      <button
        type="button"
        class="igr-toggle"
        :aria-expanded="expanded ? 'true' : 'false'"
        :title="expanded ? 'Hide prompt text' : 'Show full prompt text'"
        @click="expanded = !expanded"
      >
        <span class="igr-toggle-icon" aria-hidden="true">{{ expanded ? '▾' : '▸' }}</span>
        <span class="igr-num">{{ String(row.number).padStart(2, '0') }}</span>
        <span class="igr-title">{{ prefix }} — {{ row.title || '(no title)' }}</span>
        <span :class="['igr-chars', charStatusClass]" :title="charBadgeTooltip">
          {{ promptLen }}<template v-if="cap"> / {{ cap }}</template>c
        </span>
        <span :class="['igr-status', `igr-status-${statusVariant}`]">{{ statusLabel }}</span>
      </button>

      <button
        type="button"
        class="btn btn-sm btn-secondary igr-action-btn"
        :disabled="busy"
        :title="actionTitle"
        @click="$emit('generate')"
      >
        <LoadingSpinner v-if="busy" size="sm" />
        <span v-else aria-hidden="true">{{ imagePath ? '🔁' : '✨' }}</span>
        {{ busy ? 'Generating…' : (imagePath ? 'Regenerate' : 'Generate') }}
      </button>
    </div>

    <div v-if="expanded" class="igr-prompt">{{ row.prompt }}</div>
    <div v-if="error" class="igr-error" :title="error">⚠ {{ error }}</div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'

interface PromptRowData { number: number; title: string; prompt: string }
const props = defineProps<{
  row: PromptRowData
  /** "Scene" or "Thumbnail" — drives the title prefix + button copy. */
  prefix: string
  /** Path to the rendered image on disk, or null if not yet generated.
   *  Drives the thumbnail vs. placeholder branch + Generate vs. Regenerate
   *  button copy. */
  imagePath: string | null
  /** Slug + cache-bust key used to assemble the preview URL. Centralised
   *  here so the parent doesn't have to build the URL itself for every row. */
  slug: string
  cacheKey: number
  busy: boolean
  error: string | null
  /** Documented prompt-character cap for the active image model
   *  (advisory). Drives the per-row char-counter badge so users spot
   *  prompts that would be rejected/truncated before paying credits. */
  cap?: number | null
  /** Friendly model label for the cap tooltip. */
  modelLabel?: string
}>()

defineEmits<{
  (e: 'generate'): void
  (e: 'open-preview', path: string): void
}>()

const expanded = ref(false)

// Stable per-row preview URL. Reuses the same /video-editor/preview-image
// endpoint the existing Edit gallery uses (images.vue:1188) — wired
// through the same on-disk path so a row's thumbnail tracks whatever
// the executor wrote.
const thumbUrl = computed(() => {
  if (!props.imagePath) return ''
  return `/api/projects/${props.slug}/video-editor/preview-image?path=${encodeURIComponent(props.imagePath)}&k=${props.cacheKey}`
})

const statusLabel = computed(() => {
  if (props.busy) return 'Generating…'
  if (props.error) return 'Error'
  if (props.imagePath) return 'Rendered'
  return 'Not yet'
})
const statusVariant = computed<'busy' | 'error' | 'done' | 'empty'>(() => {
  if (props.busy) return 'busy'
  if (props.error) return 'error'
  if (props.imagePath) return 'done'
  return 'empty'
})

const actionTitle = computed(() => {
  if (props.busy) return 'Generation in progress — wait a few seconds'
  if (props.imagePath) {
    return `Re-render this ${props.prefix.toLowerCase()} with force-overwrite. Other ${props.prefix.toLowerCase()}s on disk stay untouched.`
  }
  return `Render this single ${props.prefix.toLowerCase()} only. Cheap one-off — use to test the prompt before committing to the full batch.`
})

// Char counter (advisory) — colored against the active image model's cap.
const promptLen = computed(() => (props.row?.prompt || '').length)
const charStatusClass = computed(() => {
  if (!props.cap) return 'igr-chars-neutral'
  const ratio = promptLen.value / props.cap
  if (ratio > 1) return 'igr-chars-over'
  if (ratio >= 0.8) return 'igr-chars-warn'
  return 'igr-chars-ok'
})
const charBadgeTooltip = computed(() => {
  if (!props.cap) return `${promptLen.value} characters — no documented cap for this model`
  const remaining = props.cap - promptLen.value
  const modelHint = props.modelLabel ? ` (${props.modelLabel})` : ''
  if (remaining < 0) {
    return `⚠ ${Math.abs(remaining)} chars over the ${props.cap}-char cap${modelHint}. ` +
      `The provider may reject the request or silently truncate — shorten this prompt before paying credits.`
  }
  if (remaining < props.cap * 0.2) {
    return `Close to the ${props.cap}-char cap${modelHint} — ${remaining} chars left.`
  }
  return `${promptLen.value} / ${props.cap} chars${modelHint}.`
})
</script>

<style scoped>
.igr {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 6px);
  background: var(--bg-primary);
  padding: 8px 10px;
  margin: 4px 0;
}

.igr-head {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
}

/* Preview thumbnail */
.igr-thumb {
  flex: 0 0 auto;
  width: 64px; height: 36px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-tertiary);
  overflow: hidden;
  cursor: pointer;
}
.igr-thumb:hover { border-color: var(--accent); }
.igr-thumb-img {
  width: 100%; height: 100%;
  object-fit: cover;
  display: block;
}
.igr-thumb-placeholder {
  display: flex; align-items: center; justify-content: center;
  cursor: default;
  border-style: dashed;
  color: var(--text-muted);
  font-size: 18px;
}
.igr-thumb-placeholder:hover { border-color: var(--border); }

/* Title block (toggle button that fills the rest of the row) */
.igr-toggle {
  flex: 1 1 200px; min-width: 0;
  display: flex; align-items: center; gap: 8px;
  padding: 4px 0; background: none; border: none;
  text-align: left; cursor: pointer;
  color: var(--text-primary);
}
.igr-toggle:hover { color: var(--accent); }
.igr-toggle-icon {
  display: inline-block; width: 12px; text-align: center;
  color: var(--text-muted);
}
.igr-num {
  font-family: var(--font-mono, monospace);
  font-size: var(--font-xs); color: var(--text-muted); font-weight: 600;
}
.igr-title {
  flex: 1 1 auto; min-width: 0;
  font-size: 13px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

/* Status badge — colour-codes the current state at a glance */
.igr-status {
  flex: 0 0 auto;
  font-size: var(--font-xs);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 3px;
  white-space: nowrap;
}
.igr-status-empty { background: var(--bg-tertiary); color: var(--text-muted); }
.igr-status-busy  { background: rgba(108, 143, 255, 0.16); color: var(--accent, #6c8fff); }
.igr-status-done  { background: rgba(80, 200, 120, 0.16); color: rgb(80, 200, 120); }
.igr-status-error { background: rgba(226, 92, 92, 0.16); color: rgb(226, 92, 92); }

.igr-action-btn { white-space: nowrap; }

.igr-chars {
  flex: 0 0 auto;
  font-family: var(--font-mono, monospace);
  font-size: var(--font-xs);
  padding: 2px 6px;
  border-radius: 10px;
  white-space: nowrap;
  border: 1px solid transparent;
  cursor: help;
}
.igr-chars-ok      { background: rgba(34,197,94,0.10); color: rgb(21,128,61); border-color: rgba(34,197,94,0.25); }
.igr-chars-warn    { background: rgba(234,179,8,0.12); color: rgb(161,98,7);  border-color: rgba(234,179,8,0.30); }
.igr-chars-over    { background: rgba(220,38,38,0.12); color: rgb(185,28,28); border-color: rgba(220,38,38,0.35); font-weight: 600; }
.igr-chars-neutral { background: var(--bg-tertiary);   color: var(--text-muted); border-color: var(--border); }

.igr-prompt {
  margin-top: 8px; padding: 8px 10px;
  background: var(--bg-tertiary);
  border-radius: var(--radius-sm, 4px);
  font-size: 12px; line-height: 1.5;
  color: var(--text-secondary);
  white-space: pre-wrap; word-break: break-word;
}

.igr-error {
  margin-top: 6px;
  font-size: var(--font-xs); color: rgb(220, 38, 38);
  cursor: help;
}
</style>
