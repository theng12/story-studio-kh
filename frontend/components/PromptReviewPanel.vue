<!--
  Per-prompt Regenerate panel for /projects/:slug/image-prompts.

  Listing of every thumbnail prompt currently on disk for the selected
  episode, with a 🔁 Regenerate button per row that re-runs THAT ONE prompt
  through the LLM. Mirrors the per-chapter
  Regenerate UX on the Script Generator's OutlineReviewPanel.
-->
<template>
  <div v-if="show" class="card mt-2 prp">
    <div class="prp-head">
      <h3 class="prp-title">🔁 Prompt Review</h3>
      <span class="text-muted text-xs">
        Expand any row to inspect the full prompt, edit it, save it back to disk, or reprompt that one row with feedback.
      </span>
    </div>

    <div v-if="loading" class="text-muted text-md prp-status">
      <LoadingSpinner size="sm" /> Loading prompts…
    </div>
    <div v-else-if="error" class="text-muted text-md prp-status">
      {{ error }}
    </div>
    <template v-else>
      <ul v-if="thumbnails.length" class="prp-list" role="list">
        <li class="prp-section">Thumbnails</li>
        <li v-for="row in thumbnails" :key="`t-${row.number}`" class="prp-row">
          <PromptRow
            :row="row" :prefix="thumbnailHeadlineMode && thumbnailHeadlineMode !== 'episode-title' ? 'Hook' : 'Thumbnail'"
            :title-label="thumbnailHeadlineMode && thumbnailHeadlineMode !== 'episode-title' ? 'Thumbnail hook' : 'Title'"
            :busy="busy.has(`thumbnail-${row.number}`)"
            :saving="saving.has(`thumbnail-${row.number}`)"
            :error="errors[`thumbnail-${row.number}`] || null"
            :cap="thumbnailPromptCap ?? null"
            :model-label="thumbnailModelLabel"
            @save="saveOne(row.number, $event)"
            @regenerate="regenerateOne(row.number, $event)"
          />
        </li>
      </ul>
      <div v-else class="text-muted text-md prp-status">
        No thumbnail prompts found yet. Click Generate above first.
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import PromptRow from './PromptReviewPanelRow.vue'

interface PromptRowData { number: number; title: string; prompt: string }

const props = defineProps<{
  projectSlug: string
  episodeId: string
  /** Episode title — required by resolveEpisodePaths backend-side to find
   *  the right folder. Without it, the GET 404s. */
  title?: string
  /** LLM model to use for regeneration. Pass the same live GenStudio model
   *  used for the bulk batch so style
   *  + voice stay consistent. */
  model?: string
  /** Bumped by the parent (e.g. when the bulk image-prompts job
   *  completes) to force a re-read of the docx. */
  refreshKey?: number
  /** The published prompt-character CEILING for the image model these prompts
   *  will feed. Each row renders a char-counter against it, amber when over,
   *  so the user spots prompts that would be refused before paying credits.
   *  Advisory only: nothing here blocks a save, a regenerate, or a render. */
  thumbnailPromptCap?: number | null
  /** Friendly model label for the row tooltips ("Seedream", etc.). */
  thumbnailModelLabel?: string
  /** Recipe-owned copy strategy for thumbnail rows. */
  thumbnailHeadlineMode?: string
  /**
   * NEW-10 — the lettering the workspace currently has selected. A single-row
   * regeneration appends the same ratio/title clause the bulk run does, and
   * without these that clause described an unchosen font to a customer who had
   * chosen one. Omitted means "choose to suit the concept", exactly as before.
   */
  thumbnailFontStyle?: string
  thumbnailTextStyle?: string
  thumbnailFontStyleCustom?: string
  thumbnailTextStyleCustom?: string
}>()

const emit = defineEmits<{
  /** The thumbnail numbers now on disk for this episode (after every load). */
  (e: 'loaded', payload: { thumbnails: number[] }): void
}>()

const { get, post, put } = useApi()
const freshPromptAction = useFreshGenerationAction()
const { success, error: showError } = useToast()

const thumbnails = ref<PromptRowData[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
const busy = ref<Set<string>>(new Set())
const saving = ref<Set<string>>(new Set())
const errors = ref<Record<string, string>>({})

// Card visibility: only when we have an episode_id selected. Empty list
// renders the "click Generate" hint; full lists render the rows.
const show = computed(() => !!props.episodeId)

// Bumped per load; a slower response for an earlier episode is dropped.
let loadSequence = 0

async function loadPrompts(): Promise<void> {
  if (!props.episodeId || !props.projectSlug) return
  const sequence = ++loadSequence
  loading.value = true
  error.value = null
  thumbnails.value = []
  try {
    const titleParam = props.title ? `?title=${encodeURIComponent(props.title)}` : ''
    const data = await get<{ thumbnails: PromptRowData[] }>(
      `/projects/${props.projectSlug}/episodes/${props.episodeId}/image-prompts${titleParam}`,
    )
    if (sequence !== loadSequence) return
    thumbnails.value = Array.isArray(data?.thumbnails) ? data.thumbnails : []
    emit('loaded', { thumbnails: thumbnails.value.map(row => Number(row.number)) })
  } catch (e: any) {
    if (sequence !== loadSequence) return
    if (e?.status === 404) {
      // 404 = prompts not generated yet → empty card with the "click
      // Generate" hint. Not an error condition for the user.
      thumbnails.value = []
      error.value = null
      emit('loaded', { thumbnails: [] })
    } else {
      error.value = e?.data?.detail || e?.message || 'Failed to load prompts'
    }
  } finally {
    if (sequence === loadSequence) loading.value = false
  }
}

async function regenerateOne(
  number: number,
  payload: { title: string; prompt: string; notes: string; reword?: boolean },
): Promise<void> {
  const kind = 'thumbnail'
  const key = `${kind}-${number}`
  if (busy.value.has(key)) return
  const episodeId = props.episodeId
  busy.value = new Set([...busy.value, key])
  errors.value = { ...errors.value, [key]: '' }
  const request = {
    kind, number,
    title: props.title,
    model: props.model,
    current_title: payload.title,
    current_prompt: payload.prompt,
    notes: payload.notes,
    headline_mode: props.thumbnailHeadlineMode,
    // NEW-10 — a regenerated thumbnail row keeps the workspace's lettering, so
    // the enforced clause names the chosen style instead of a generic one.
    thumb_font_style: props.thumbnailFontStyle,
    thumb_text_style: props.thumbnailTextStyle,
    thumb_font_style_custom: props.thumbnailFontStyleCustom,
    thumb_text_style_custom: props.thumbnailTextStyleCustom,
    prompt_char_cap: props.thumbnailPromptCap || undefined,
    ...(payload.reword ? { reword: true } : {}),
  }
  const operationId = freshPromptAction.begin(request, key)
  try {
    const data = await post<{ number: number; title: string; prompt: string }>(
      `/projects/${props.projectSlug}/episodes/${episodeId}/image-prompts/regenerate`,
      {
        ...request,
        // The same ceiling the row's counter is measured against, so a rewrite
        // is written under the limit rather than back over it. Null/0 → omitted
        // → no limit is in force and the writer is left unconstrained.
        operation_id: operationId,
        // Set only by the row's explicit "Reword" button — asks for a different
        // angle on the same idea with the difficult-subjects guidance applied.
        // Never inferred from a failure.
      },
    )
    freshPromptAction.complete(operationId)
    if (episodeId !== props.episodeId) return
    // Patch the in-memory list so the card reflects the new prompt
    // without a full reload.
    const idx = thumbnails.value.findIndex(p => p.number === number)
    if (idx >= 0) {
      thumbnails.value = [
        ...thumbnails.value.slice(0, idx),
        { number: data.number, title: data.title, prompt: data.prompt },
        ...thumbnails.value.slice(idx + 1),
      ]
    }
    success(`Thumbnail ${number} ${payload.reword ? 'reworded — same idea, different angle' : 'regenerated'}`)
  } catch (e: any) {
    if (episodeId !== props.episodeId) return
    const msg = e?.data?.detail || e?.message || `${payload.reword ? 'Reword' : 'Regeneration'} failed`
    errors.value = { ...errors.value, [key]: msg }
    showError(msg)
  } finally {
    const next = new Set(busy.value)
    next.delete(key)
    busy.value = next
  }
}

async function saveOne(
  number: number,
  payload: { title: string; prompt: string },
): Promise<void> {
  const kind = 'thumbnail'
  const key = `${kind}-${number}`
  if (saving.value.has(key)) return
  // The edit belongs to the episode it was made on, even if the picker moves.
  const episodeId = props.episodeId
  const episodeTitle = props.title || ''
  saving.value = new Set([...saving.value, key])
  errors.value = { ...errors.value, [key]: '' }
  try {
    const data = await put<{ number: number; title: string; prompt: string }>(
      `/projects/${props.projectSlug}/episodes/${episodeId}/image-prompts/item?title=${encodeURIComponent(episodeTitle)}`,
      {
        kind,
        number,
        title: payload.title,
        prompt: payload.prompt,
      },
    )
    success(`Thumbnail ${number} saved for ${episodeId}`)
    if (episodeId !== props.episodeId) return
    const idx = thumbnails.value.findIndex(p => p.number === number)
    if (idx >= 0) {
      thumbnails.value = [
        ...thumbnails.value.slice(0, idx),
        { number: data.number, title: data.title, prompt: data.prompt },
        ...thumbnails.value.slice(idx + 1),
      ]
    }
  } catch (e: any) {
    if (episodeId !== props.episodeId) {
      showError(`Could not save thumbnail ${number} for ${episodeId}: ${e?.data?.detail || e?.message || 'Save failed'}`)
      return
    }
    const msg = e?.data?.detail || e?.message || 'Save failed'
    errors.value = { ...errors.value, [key]: msg }
    showError(msg)
  } finally {
    const next = new Set(saving.value)
    next.delete(key)
    saving.value = next
  }
}

watch(() => [props.episodeId, props.title, props.refreshKey], (next, prev) => {
  // Row spinners and errors belong to one episode.
  if (!prev || next[0] !== prev[0]) {
    busy.value = new Set()
    saving.value = new Set()
    errors.value = {}
  }
  if (props.episodeId) void loadPrompts()
}, { immediate: true })
</script>

<style scoped>
.prp { padding: 12px 14px; }
.prp-head {
  display: flex; align-items: baseline; justify-content: space-between;
  gap: 8px; flex-wrap: wrap;
}
.prp-title {
  margin: 0;
  font-size: 14px; font-weight: 600;
  color: var(--text-primary);
}
.prp-status { padding: 8px 0; }
.prp-list { list-style: none; margin: 8px 0 0 0; padding: 0; }
.prp-section {
  margin-top: 12px;
  font-size: var(--font-xs); font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.04em;
  color: var(--text-muted);
}
.prp-section:first-of-type { margin-top: 0; }
.prp-row { padding: 0; }
</style>
