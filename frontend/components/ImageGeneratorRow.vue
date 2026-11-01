<!--
  Single row inside ImageGeneratorPanel. Renders one image-prompt as:
   - A small preview thumbnail (or "not rendered yet" placeholder)
   - Numbered title + prefix ("Thumbnail 01")
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
           open its lightbox). -->
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
        <span class="igr-toggle-icon ds-chevron" aria-hidden="true" :class="{ 'is-open': expanded }" />
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
      <button
        v-if="showPin && imagePath"
        type="button"
        :class="['btn btn-sm igr-pin-btn', { 'is-pinned': pinnedForUpload }]"
        :title="pinnedForUpload
          ? 'Pinned for upload. Click to return to automatic thumbnail selection.'
          : 'Use this thumbnail for the next YouTube upload.'"
        @click="$emit('pin-toggle')"
      >
        {{ pinnedForUpload ? 'Pinned for Upload' : 'Pin for Upload' }}
      </button>
      <!-- The score this picture got, and why. Plain words: a number when one
           was measured, "Not scored" when it was not, and the model's own
           reason either way. -->
      <span
        v-if="score"
        :class="['igr-score', `igr-score-${score.state}`, { 'is-picked': autoPicked }]"
        :title="scoreTitle"
      >
        {{ scoreLabel }}
      </span>
      <!-- Add text: only present when the channel has the thumbnail text layer
           switched on. It opens the editor against THIS rendered file, so the
           headline is drawn onto a copy and the artwork itself is never changed. -->
      <button
        v-if="showTextLayer && imagePath"
        type="button"
        class="btn btn-sm btn-secondary"
        title="Add a headline to a copy of this thumbnail"
        @click="$emit('add-text')"
      >
        Add text
      </button>
    </div>

    <!-- The reason, in one line under the row. Never hidden: a score without
         its reason is a number nobody can act on. -->
    <div v-if="score && scoreReason" class="igr-score-reason">{{ scoreReason }}</div>

    <div v-if="expanded" class="igr-prompt">{{ row.prompt }}</div>
    <div v-if="error" class="igr-error" :title="error">⚠ {{ error }}</div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'

interface PromptRowData { number: number; title: string; prompt: string }
const props = defineProps<{
  row: PromptRowData
  /** "Thumbnail" — drives the title prefix + button copy. */
  prefix: string
  /** Path to the rendered image on disk, or null if not yet generated.
   *  Drives the thumbnail vs. placeholder branch + Generate vs. Regenerate
   *  button copy. */
  imagePath: string | null
  /** Thumbnail selection belongs beside the generated artwork, not in a
   *  separate gallery. */
  showPin?: boolean
  pinnedForUpload?: boolean
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
  /** Whether the selected model uses credits (unknown counts as paid). */
  paid?: boolean
  /** Channel has the thumbnail text layer on — shows the Add text button. */
  showTextLayer?: boolean
  /**
   * This picture's score (owner, 2026-11-01).
   *
   * `state` is `scored`, `rejected_by_rule` or `not_scored` — never a bare
   * number, because "no score" and "a score of zero" are different facts.
   */
  score?: {
    state: 'scored' | 'rejected_by_rule' | 'not_scored'
    score?: number
    reason?: string
    text_issue?: string
  } | null
  /** True when this picture is the automatic pick. */
  autoPicked?: boolean
}>()

defineEmits<{
  (e: 'generate'): void
  (e: 'open-preview', path: string): void
  (e: 'pin-toggle'): void
  (e: 'add-text'): void
}>()

const expanded = ref(false)

// Stable per-row preview URL. Uses the /video-editor/preview-image endpoint,
// wired through the on-disk path so a row's thumbnail tracks whatever the
// executor wrote.
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

// ── The score (owner, 2026-11-01) ─────────────────────────────────────────
//
// Plain words on purpose. A score is shown as a number WITH the model's own
// reason; a picture that was not measured says "Not scored" and says why.
// A picture a local rule set aside says so too — it was not judged by the
// model, so it has no model score to show.

const scoreLabel = computed(() => {
  const entry = props.score
  if (!entry) return ''
  if (entry.state === 'scored') {
    const number = typeof entry.score === 'number' ? entry.score : null
    return number === null ? 'Scored' : `Score ${number}`
  }
  if (entry.state === 'rejected_by_rule') return 'Set aside'
  return 'Not scored'
})

/** The model's reason, plus any text problem it reported. */
const scoreReason = computed(() => {
  const entry = props.score
  if (!entry) return ''
  const parts: string[] = []
  if (entry.reason) parts.push(entry.reason)
  if (entry.text_issue) parts.push(`Text: ${entry.text_issue}`)
  return parts.join(' — ')
})

/** The tooltip: the same words, with the reason shown in full. */
const scoreTitle = computed(() => {
  const entry = props.score
  if (!entry) return ''
  const picked = props.autoPicked ? ' Chosen automatically for upload.' : ''
  if (!entry.reason && !entry.text_issue) return picked.trim()
  return `${scoreReason.value}${picked}`
})

const actionTitle = computed(() => {
  if (props.busy) return 'Generation in progress — wait a few seconds'
  const kind = props.prefix.toLowerCase()
  const cost = props.paid === false ? 'Free on this model.' : 'Uses credits for one image.'
  if (props.imagePath) {
    return `Re-render just this ${kind} and replace the current one. Other ${kind}s stay as they are. ${cost}`
  }
  return `Render just this one ${kind} — a quick way to test the prompt before rendering the rest. ${cost}`
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
    return `⚠ ${Math.abs(remaining)} chars over the ${props.cap}-char limit${modelHint}. ` +
      `The model may refuse it or cut it short — shorten this prompt before rendering.`
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
.igr-pin-btn {
  white-space: nowrap;
  color: var(--text-secondary);
}
.igr-pin-btn.is-pinned {
  border-color: var(--accent);
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}

/* The score badge. One quiet register: the number when a model gave one,
   plain words when it did not. */
.igr-score {
  flex: 0 0 auto;
  font-size: var(--font-xs);
  font-weight: 600;
  padding: 2px 7px;
  border-radius: 3px;
  white-space: nowrap;
  border: 1px solid transparent;
}
.igr-score-scored {
  color: rgb(21, 128, 61);
  background: rgba(34, 197, 94, 0.10);
  border-color: rgba(34, 197, 94, 0.25);
}
.igr-score-rejected_by_rule {
  color: rgb(161, 98, 7);
  background: rgba(234, 179, 8, 0.12);
  border-color: rgba(234, 179, 8, 0.30);
}
.igr-score-not_scored {
  color: var(--text-muted);
  background: var(--bg-tertiary);
  border-color: var(--border);
}
/* The automatic pick. The accent ring is the only thing that says "chosen",
   so it reads at a glance without a louder badge. */
.igr-score.is-picked {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 35%, transparent);
}

.igr-score-reason {
  margin-top: 6px;
  font-size: var(--font-xs);
  line-height: 1.45;
  color: var(--text-secondary);
}

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
