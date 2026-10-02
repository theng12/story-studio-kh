<!--
  Per-prompt Regenerate panel for /projects/:slug/image-prompts.

  Read-only listing of every scene + thumbnail prompt currently on disk
  for the selected episode, with a 🔁 Regenerate button per row that
  re-runs THAT ONE prompt through the LLM. Mirrors the per-chapter
  Regenerate UX on the Script Generator's OutlineReviewPanel.

  v1 — no in-place editing or reordering. The user picked "Regenerate
  only" via AskUserQuestion. Edit / reorder can land in v2 if needed.
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
      <ul v-if="scenes.length && showScenes" class="prp-list" role="list">
        <li class="prp-section">
          Scenes
          <span v-if="scenes.length > SCENES_PAGE_SIZE" class="prp-section-meta">
            · showing {{ scenesRangeStart }}–{{ scenesRangeEnd }} of {{ scenes.length }}
          </span>
        </li>
        <li v-for="row in paginatedScenes" :key="`s-${row.number}`" class="prp-row">
          <PromptRow
            :row="row" :prefix="'Scene'"
            :busy="busy.has(`scene-${row.number}`)"
            :saving="saving.has(`scene-${row.number}`)"
            :error="errors[`scene-${row.number}`] || null"
            :cap="scenePromptCap ?? null"
            :model-label="sceneModelLabel"
            @save="saveOne('scene', row.number, $event)"
            @regenerate="regenerateOne('scene', row.number, $event)"
          />
        </li>
        <!-- Pagination controls. Only render when the scenes list exceeds
             one page; compact scene plans stay pagination-free, while long
             narration-timed plans remain usable without one enormous list. -->
        <li v-if="totalScenesPages > 1" class="prp-pagination" role="navigation" aria-label="Scenes pagination">
          <button
            type="button"
            class="prp-page-btn"
            :disabled="scenesPage <= 1"
            @click="scenesPage = 1"
            title="First page"
          >«</button>
          <button
            type="button"
            class="prp-page-btn"
            :disabled="scenesPage <= 1"
            @click="scenesPage -= 1"
            title="Previous page"
          >‹</button>
          <span class="prp-page-label">
            Page <strong>{{ scenesPage }}</strong> / {{ totalScenesPages }}
          </span>
          <button
            type="button"
            class="prp-page-btn"
            :disabled="scenesPage >= totalScenesPages"
            @click="scenesPage += 1"
            title="Next page"
          >›</button>
          <button
            type="button"
            class="prp-page-btn"
            :disabled="scenesPage >= totalScenesPages"
            @click="scenesPage = totalScenesPages"
            title="Last page"
          >»</button>
          <select v-model.number="scenesPage" class="prp-page-select" :title="`Jump to page (${totalScenesPages} pages)`">
            <option v-for="n in totalScenesPages" :key="n" :value="n">Page {{ n }}</option>
          </select>
        </li>
      </ul>
      <ul v-if="thumbnails.length && showThumbs" class="prp-list" role="list">
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
            @save="saveOne('thumbnail', row.number, $event)"
            @regenerate="regenerateOne('thumbnail', row.number, $event)"
          />
        </li>
      </ul>
      <div v-if="(showScenes && !scenes.length && pool === 'scenes') || (showThumbs && !thumbnails.length && pool === 'thumbnails') || (!scenes.length && !thumbnails.length)" class="text-muted text-md prp-status">
        No {{ pool === 'scenes' ? 'scene' : pool === 'thumbnails' ? 'thumbnail' : '' }} prompts found yet. Click Generate above first.
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
   *  will feed (separate per kind in case the Scene and Thumbnail tabs target
   *  different models — reasons-explainers do). Each row renders a
   *  char-counter against the relevant ceiling, amber when over, so the user
   *  spots prompts that would be refused before paying credits. Advisory only:
   *  nothing here blocks a save, a regenerate, or a render. */
  scenePromptCap?: number | null
  thumbnailPromptCap?: number | null
  /** Friendly model labels for the row tooltips ("Seedream", etc.). */
  sceneModelLabel?: string
  thumbnailModelLabel?: string
  /** v1.0.209 — which pool to show. The split Thumbnail-Prompts /
   *  Scene-Prompts pages pass 'thumbnails' / 'scenes' so each only lists +
   *  regenerates its own pool. Defaults to 'all' (both) for any other use. */
  pool?: 'scenes' | 'thumbnails' | 'all'
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
const { success, error: showError, show: showToast } = useToast()

const showScenes = computed(() => (props.pool ?? 'all') !== 'thumbnails')
const showThumbs = computed(() => (props.pool ?? 'all') !== 'scenes')

const scenes = ref<PromptRowData[]>([])
const thumbnails = ref<PromptRowData[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
const busy = ref<Set<string>>(new Set())
const saving = ref<Set<string>>(new Set())
const errors = ref<Record<string, string>>({})

// v1.0.87+: scenes pagination. Reasons-explainer at sentence-aligned
// pacing routinely lands 150-250 scenes per episode, which renders as
// an unscrollable wall in the legacy "list every row" layout. Page
// size 25 fits one screen and matches the chunked-batch boundary
// (batches of 10 + thumbnail row = 25 visible) so the user can spot
// which batch a row came from.
const SCENES_PAGE_SIZE = 25
const scenesPage = ref(1)
const totalScenesPages = computed(() =>
  Math.max(1, Math.ceil(scenes.value.length / SCENES_PAGE_SIZE)),
)
const paginatedScenes = computed(() => {
  const start = (scenesPage.value - 1) * SCENES_PAGE_SIZE
  return scenes.value.slice(start, start + SCENES_PAGE_SIZE)
})
const scenesRangeStart = computed(() =>
  scenes.value.length === 0 ? 0 : (scenesPage.value - 1) * SCENES_PAGE_SIZE + 1,
)
const scenesRangeEnd = computed(() =>
  Math.min(scenes.value.length, scenesPage.value * SCENES_PAGE_SIZE),
)

// Reset to page 1 whenever the scenes list changes (fresh episode load,
// post-regenerate refresh, or a full bulk generation completing). Without
// this, a user paged to page 8 of an old episode would land on page 8
// of the new episode's smaller list and see blank rows.
watch(() => scenes.value.length, () => {
  scenesPage.value = 1
})
// Defensive clamp: if anything else moves scenesPage out of range, snap
// it back into bounds rather than rendering an empty page.
watch(totalScenesPages, (tp) => {
  if (scenesPage.value > tp) scenesPage.value = tp
  if (scenesPage.value < 1) scenesPage.value = 1
})

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
  scenes.value = []
  thumbnails.value = []
  try {
    const titleParam = props.title ? `?title=${encodeURIComponent(props.title)}` : ''
    const data = await get<{ scenes: PromptRowData[]; thumbnails: PromptRowData[] }>(
      `/projects/${props.projectSlug}/episodes/${props.episodeId}/image-prompts${titleParam}`,
    )
    if (sequence !== loadSequence) return
    scenes.value = Array.isArray(data?.scenes) ? data.scenes : []
    thumbnails.value = Array.isArray(data?.thumbnails) ? data.thumbnails : []
    emit('loaded', { thumbnails: thumbnails.value.map(row => Number(row.number)) })
  } catch (e: any) {
    if (sequence !== loadSequence) return
    if (e?.status === 404) {
      // 404 = prompts not generated yet → empty card with the "click
      // Generate" hint. Not an error condition for the user.
      scenes.value = []
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
  kind: 'scene' | 'thumbnail',
  number: number,
  payload: { title: string; prompt: string; notes: string; reword?: boolean },
): Promise<void> {
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
    headline_mode: kind === 'thumbnail' ? props.thumbnailHeadlineMode : undefined,
    // NEW-10 — a regenerated thumbnail row keeps the workspace's lettering, so
    // the enforced clause names the chosen style instead of a generic one.
    thumb_font_style: kind === 'thumbnail' ? props.thumbnailFontStyle : undefined,
    thumb_text_style: kind === 'thumbnail' ? props.thumbnailTextStyle : undefined,
    thumb_font_style_custom: kind === 'thumbnail' ? props.thumbnailFontStyleCustom : undefined,
    thumb_text_style_custom: kind === 'thumbnail' ? props.thumbnailTextStyleCustom : undefined,
    prompt_char_cap: (kind === 'scene' ? props.scenePromptCap : props.thumbnailPromptCap) || undefined,
    ...(payload.reword ? { reword: true } : {}),
  }
  const operationId = freshPromptAction.begin(request, key)
  try {
    const data = await post<{ number: number; title: string; prompt: string; model_notice?: string }>(
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
    const list = kind === 'scene' ? scenes : thumbnails
    const idx = list.value.findIndex(p => p.number === number)
    if (idx >= 0) {
      list.value = [
        ...list.value.slice(0, idx),
        { number: data.number, title: data.title, prompt: data.prompt },
        ...list.value.slice(idx + 1),
      ]
    }
    success(`${kind === 'scene' ? 'Scene' : 'Thumbnail'} ${number} ${payload.reword ? 'reworded — same idea, different angle' : 'regenerated'}`)
    // The server healed away from the saved model. Informational, never
    // blocking — the prompt IS regenerated. Longer dwell than the default
    // because the sentence names two products and what to do about them.
    if (data.model_notice) showToast(data.model_notice, 'info', 12000)
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
  kind: 'scene' | 'thumbnail',
  number: number,
  payload: { title: string; prompt: string },
): Promise<void> {
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
    success(`${kind === 'scene' ? 'Scene' : 'Thumbnail'} ${number} saved for ${episodeId}`)
    if (episodeId !== props.episodeId) return
    const list = kind === 'scene' ? scenes : thumbnails
    const idx = list.value.findIndex(p => p.number === number)
    if (idx >= 0) {
      list.value = [
        ...list.value.slice(0, idx),
        { number: data.number, title: data.title, prompt: data.prompt },
        ...list.value.slice(idx + 1),
      ]
    }
  } catch (e: any) {
    if (episodeId !== props.episodeId) {
      showError(`Could not save ${kind} ${number} for ${episodeId}: ${e?.data?.detail || e?.message || 'Save failed'}`)
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
.prp-section-meta {
  font-weight: 400;
  text-transform: none;
  letter-spacing: 0;
  color: var(--text-muted);
}
.prp-row { padding: 0; }

/* Pagination controls — render only when scenes.length > SCENES_PAGE_SIZE.
 * Sticks to the bottom of the scenes list (same <ul>) so visual grouping
 * stays clear. Compact button row + a select for fast jumps in long
 * episodes (250 scenes = 10 pages; tap-pagination would be tedious). */
.prp-pagination {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding: 8px 0 0;
  margin-top: 8px;
  border-top: 1px solid var(--border);
}
.prp-page-btn {
  padding: 4px 10px;
  font-size: 13px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-primary);
  cursor: pointer;
  font-family: inherit;
  min-width: 28px;
}
.prp-page-btn:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.prp-page-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.prp-page-label {
  font-size: 12px;
  color: var(--text-muted);
  padding: 0 6px;
}
.prp-page-label strong { color: var(--text-primary); }
.prp-page-select {
  margin-left: auto;
  padding: 4px 8px;
  font-size: 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-primary);
  cursor: pointer;
}
</style>
