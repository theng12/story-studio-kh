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
      <!-- Episode-level gate, off unless deliberately turned on here (AGENTS §5:
           a choice the customer makes, never a default the app decides). The
           disabled state when no prompt exists says so rather than looking
           enabled and doing nothing. -->
      <label
        class="prp-auto"
        :title="thumbnails.length
          ? 'When on, every prompt for this episode reads as approved without a per-prompt check. Off by default: a new prompt needs approval.'
          : 'No prompts on this episode yet — generate them first.'"
      >
        <input
          type="checkbox"
          :checked="autoApprove"
          :disabled="saving.has('auto-approve') || !thumbnails.length"
          @change="setAutoApprove($event)"
        />
        Approve prompts automatically
      </label>
    </div>

    <div v-if="loading" class="text-muted text-md prp-status">
      <LoadingSpinner size="sm" /> Loading prompts…
    </div>
    <div v-else-if="error" class="text-muted text-md prp-status">
      {{ error }}
    </div>
    <template v-else>
      <!-- Option settings failed to load while the prompts themselves are
           fine: say so plainly. Never reads as "nothing is stored". -->
      <div v-if="optionsError" class="text-muted text-md prp-status prp-options-error">
        ⚠ {{ optionsError }}
      </div>
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
            @replace-headline="replaceHeadline(row.number, $event)"
            @regenerate="regenerateOne(row.number, $event)"
          />
          <!-- This thumbnail's own metadata (recipe, style, lettering,
               placement), its approval verdict and Duplicate. Collapsed by
               default: the catalogues mount only for a row the customer
               actually opens, and the verdict stays readable in the summary. -->
          <details
            class="prp-options"
            @toggle="toggleOptionEditor(row.number, $event)"
          >
            <summary class="prp-options-summary">
              <span
                class="prp-approval"
                :class="approvedFor(row.number) ? 'is-approved' : 'is-pending'"
              >
                {{ approvedFor(row.number) ? (autoApprove ? '✓ Approved · automatic' : '✓ Approved') : '○ Not approved' }}
              </span>
              <span class="text-muted text-xs">Option settings — recipe, style, lettering, placement</span>
            </summary>
            <PromptReviewOptionEditor
              v-if="openEditors.has(row.number)"
              :number="row.number"
              :entry="options[String(row.number)] || null"
              :project-slug="projectSlug"
              :page-font-style="thumbnailFontStyle || ''"
              :page-text-style="thumbnailTextStyle || ''"
              :auto-approve="autoApprove"
              :approved="approvedFor(row.number)"
              :saving="saving.has(`option-${row.number}`)"
              :duplicating="duplicating.has(`dup-${row.number}`)"
              :error="errors[`option-${row.number}`] || null"
              @save="saveOptionFields(row.number, $event)"
              @approve="setApproval(row.number, $event)"
              @duplicate="duplicateOption(row.number)"
            />
          </details>
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
import PromptReviewOptionEditor from './PromptReviewOptionEditor.vue'
import type { PromptCharCapSetting } from '~/utils/prompt-char-cap'

interface PromptRowData { number: number; title: string; prompt: string }
/** One option's metadata as GET/PUT /image-prompts/options presents it. */
interface OptionEntry {
  thumbnail_template_id?: string
  style_tag?: string
  thumb_font_style?: string
  thumb_text_style?: string
  thumb_text_position?: string
  approved?: boolean
}
interface OptionSettings {
  schema?: number
  auto_approve?: boolean
  options?: Record<string, OptionEntry>
}

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
   *  Advisory only: nothing here blocks a save, a regenerate, or a render.
   *  This is the RESOLVED figure, for DISPLAY only — it is never sent. */
  thumbnailPromptCap?: number | null
  /** The ceiling SELECTION — 'auto' | 'none' | a whole number — as the
   *  workspace holds it. A regeneration carries the SELECTION and the intended
   *  image model, and the backend resolves the number against the live
   *  catalogue, so the ceiling follows the model instead of freezing at the
   *  moment the page loaded. */
  thumbnailPromptCapSetting?: PromptCharCapSetting
  /** The image model these prompts are written FOR. Named in every request so
   *  the ceiling is resolved for the model the customer actually selected. */
  thumbnailIntendedImageModel?: string
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

// Per-option metadata (recipe/style/font/text/placement + approval) beside the
// prompts file. Server state only: a load replaces it wholesale, an episode
// change blanks it first (AGENTS §4), and a read never writes — a legacy
// episode with no sidecar stays exactly as empty as it reads (no backfill).
const options = ref<Record<string, OptionEntry>>({})
const autoApprove = ref(false)
const optionsError = ref<string | null>(null)
/** Rows whose option editor is open — the editor mounts only then. */
const openEditors = ref<Set<number>>(new Set())
const duplicating = ref<Set<string>>(new Set())
let optionsSequence = 0

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
  // THIS option's saved choices win over the page-level ones, so a row that
  // was tuned on its own regenerates under its own recipe/style/lettering/
  // placement. Anything not saved falls back exactly as it did before.
  const saved = options.value[String(number)] || {}
  const fontOverride = saved.thumb_font_style || ''
  const textOverride = saved.thumb_text_style || ''
  const request = {
    kind, number,
    title: props.title,
    model: props.model,
    current_title: payload.title,
    current_prompt: payload.prompt,
    notes: payload.notes,
    headline_mode: props.thumbnailHeadlineMode,
    // The five saved per-option fields (the backend honors all five). Absent
    // values stay absent: nothing is invented for an option that never chose.
    ...(saved.thumbnail_template_id ? { thumbnail_template_id: saved.thumbnail_template_id } : {}),
    ...(saved.style_tag ? { style_tag: saved.style_tag } : {}),
    ...(saved.thumb_text_position ? { thumb_text_position: saved.thumb_text_position } : {}),
    // NEW-10 — a regenerated thumbnail row keeps its own lettering when it has
    // one, else the workspace's, so the enforced clause names a real choice.
    thumb_font_style: fontOverride || props.thumbnailFontStyle,
    thumb_text_style: textOverride || props.thumbnailTextStyle,
    // The page's custom lettering text belongs to the page's choice — it is
    // not sent once this option has picked a font/text style of its own.
    ...(fontOverride ? {} : { thumb_font_style_custom: props.thumbnailFontStyleCustom }),
    ...(textOverride ? {} : { thumb_text_style_custom: props.thumbnailTextStyleCustom }),
    // The SELECTION and the model it is written for — never a number resolved
    // here. The backend resolves the ceiling against the live catalogue, so a
    // rewrite is written under the limit the SELECTED model actually publishes
    // rather than under a figure that was true when the page loaded.
    prompt_char_cap: props.thumbnailPromptCapSetting,
    intended_image_model: props.thumbnailIntendedImageModel,
    ...(payload.reword ? { reword: true } : {}),
  }
  const operationId = freshPromptAction.begin(request, key)
  try {
    const data = await post<{ number: number; title: string; prompt: string }>(
      `/projects/${props.projectSlug}/episodes/${episodeId}/image-prompts/regenerate`,
      {
        ...request,
        // The ceiling the rewrite is written under travels with the request as
        // a SELECTION plus the model it is written for; the server resolves
        // the number against the live catalogue when the rewrite runs.
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
    markPromptChanged(number)
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

async function replaceHeadline(number: number, payload: { from: string; to: string }): Promise<void> {
  const kind = 'thumbnail'
  const key = `${kind}-${number}`
  if (saving.value.has(key)) return
  const episodeId = props.episodeId
  const episodeTitle = props.title || ''
  saving.value = new Set([...saving.value, key])
  errors.value = { ...errors.value, [key]: '' }
  try {
    const data = await put<{ number: number; title: string; prompt: string }>(
      `/projects/${props.projectSlug}/episodes/${episodeId}/image-prompts/item?title=${encodeURIComponent(episodeTitle)}`,
      { kind, number, title: payload.to, replace_headline: payload },
    )
    success(`Thumbnail ${number} headline replaced with “${payload.to}”`)
    if (episodeId !== props.episodeId) return
    const idx = thumbnails.value.findIndex(p => p.number === number)
    if (idx >= 0) {
      thumbnails.value = [
        ...thumbnails.value.slice(0, idx),
        { number: data.number, title: data.title, prompt: data.prompt },
        ...thumbnails.value.slice(idx + 1),
      ]
    }
    markPromptChanged(number)
  } catch (e: any) {
    const msg = e?.data?.detail || e?.message || 'Could not replace the headline'
    if (episodeId === props.episodeId) errors.value = { ...errors.value, [key]: msg }
    showError(msg)
  } finally {
    const next = new Set(saving.value)
    next.delete(key)
    saving.value = next
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
    markPromptChanged(number)
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

// ── Per-option metadata (…/image-prompts/options) ─────────────────────────

/** Apply one settings response (GET or PUT return the same whole map — so a
 *  save refreshes this option AND every sibling, which is what it stored). */
function applySettings(data: OptionSettings | null | undefined): void {
  if (!data || typeof data !== 'object') return
  autoApprove.value = data.auto_approve === true
  options.value = data.options && typeof data.options === 'object' ? data.options : {}
}

/** Read-only load. A read NEVER writes: no sidecar stays an empty answer,
 *  never a backfilled one. Fails soft but loud — optionsError explains, and
 *  nothing pretends the settings were checked. */
async function loadOptions(): Promise<void> {
  if (!props.episodeId || !props.projectSlug) return
  const sequence = ++optionsSequence
  const episodeId = props.episodeId
  const project = props.projectSlug
  optionsError.value = null
  try {
    const data = await get<OptionSettings>(
      `/projects/${props.projectSlug}/episodes/${episodeId}/image-prompts/options`,
    )
    if (sequence !== optionsSequence || episodeId !== props.episodeId || project !== props.projectSlug) return
    applySettings(data)
  } catch (e: any) {
    if (sequence !== optionsSequence || episodeId !== props.episodeId || project !== props.projectSlug) return
    options.value = {}
    autoApprove.value = false
    optionsError.value = `Option settings could not be loaded: ${e?.data?.detail || e?.message || 'no answer from the server'}. This episode's saved selections were NOT checked.`
  }
}

/** The honest verdict for one prompt as it stands: automatic approval makes
 *  every prompt approved; otherwise it is the stored hash match the server
 *  computed against the current prompt text. */
function approvedFor(number: number): boolean {
  if (autoApprove.value) return true
  return options.value[String(number)]?.approved === true
}

/** The prompt text changed, so any approval given to the OLD text is stale —
 *  the UI drops to exactly what the server would answer now. */
function markPromptChanged(number: number): void {
  const entry = options.value[String(number)]
  if (!entry) return
  options.value = {
    ...options.value,
    [String(number)]: { ...entry, approved: autoApprove.value },
  }
}

function toggleOptionEditor(number: number, event: Event): void {
  const open = (event.currentTarget as HTMLDetailsElement).open
  const next = new Set(openEditors.value)
  if (open) next.add(number)
  else next.delete(number)
  openEditors.value = next
}

/** One PUT for one option. The episode is captured at click time, the answer
 *  is dropped if the picker has moved on, and failures land in this row's own
 *  error slot — the saved state only changes when the server confirms it. */
async function putOption(number: number, body: Record<string, unknown>, key: string): Promise<void> {
  if (saving.value.has(key)) return
  const episodeId = props.episodeId
  const project = props.projectSlug
  saving.value = new Set([...saving.value, key])
  errors.value = { ...errors.value, [key]: '' }
  try {
    const data = await put<OptionSettings>(
      `/projects/${props.projectSlug}/episodes/${episodeId}/image-prompts/options`,
      { number, ...body },
    )
    if (episodeId !== props.episodeId || project !== props.projectSlug) return
    applySettings(data)
    success(`Thumbnail ${number} settings saved for ${episodeId}`)
  } catch (e: any) {
    if (episodeId !== props.episodeId) return
    const msg = e?.data?.detail || e?.message || 'Could not save this thumbnail’s option settings'
    errors.value = { ...errors.value, [key]: msg }
    showError(msg)
  } finally {
    const next = new Set(saving.value)
    next.delete(key)
    saving.value = next
  }
}

function saveOptionFields(number: number, fields: Record<string, string>): void {
  void putOption(number, fields, `option-${number}`)
}

function setApproval(number: number, approve: boolean): void {
  void putOption(number, { approve }, `option-${number}`)
}

/** Episode-level switch. The contract edits ONE option per PUT, so it rides
 *  on the first prompt's number; an episode with no prompt has nothing to
 *  approve and the toggle stays disabled rather than pretending to save. */
function setAutoApprove(event: Event): void {
  const first = thumbnails.value[0]?.number
  if (first == null) return
  void putOption(first, { auto_approve: (event.target as HTMLInputElement).checked }, 'auto-approve')
}

/** Duplicate this option. The backend answers with the NEW option (its number,
 *  title and prompt), so the list is refreshed from disk — siblings come back
 *  from the server untouched, never rebuilt from stale local state. */
async function duplicateOption(number: number): Promise<void> {
  const key = `dup-${number}`
  if (duplicating.value.has(key)) return
  const episodeId = props.episodeId
  const project = props.projectSlug
  const operationId = freshPromptAction.begin({ project, episodeId, number, action: 'duplicate' }, key)
  duplicating.value = new Set([...duplicating.value, key])
  errors.value = { ...errors.value, [`option-${number}`]: '' }
  try {
    const data = await post<{ number: number; title?: string; prompt?: string }>(
      `/projects/${project}/episodes/${episodeId}/image-prompts/options/duplicate`,
      { number, operation_id: operationId },
    )
    freshPromptAction.complete(operationId)
    if (episodeId !== props.episodeId || project !== props.projectSlug) return
    success(`Thumbnail ${number} duplicated as thumbnail ${data?.number}`)
    await loadPrompts()
    await loadOptions()
  } catch (e: any) {
    if (episodeId !== props.episodeId) return
    const msg = e?.data?.detail || e?.message || 'Could not duplicate this thumbnail option'
    errors.value = { ...errors.value, [`option-${number}`]: msg }
    showError(msg)
  } finally {
    const next = new Set(duplicating.value)
    next.delete(key)
    duplicating.value = next
  }
}

watch(() => [props.episodeId, props.title, props.refreshKey, props.projectSlug], (next, prev) => {
  // Row spinners and errors belong to one episode.
  if (!prev || next[0] !== prev[0] || next[3] !== prev[3]) {
    busy.value = new Set()
    saving.value = new Set()
    errors.value = {}
    // AGENTS §4: another episode's option metadata must not stand for a
    // moment on this one — blanked first, then replaced by its own load.
    options.value = {}
    autoApprove.value = false
    optionsError.value = null
    openEditors.value = new Set()
    duplicating.value = new Set()
  }
  if (props.episodeId) {
    void loadPrompts()
    void loadOptions()
  }
}, { immediate: true })
</script>

<style scoped>
.prp { padding: 12px 14px; }
.prp-head {
  display: flex; align-items: baseline; justify-content: space-between;
  gap: 8px; flex-wrap: wrap;
}
.prp-auto {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: var(--font-xs); color: var(--text-secondary);
  cursor: pointer; white-space: nowrap;
}
.prp-auto input { cursor: pointer; margin: 0; }
.prp-auto:has(input:disabled) { cursor: not-allowed; opacity: 0.7; }
.prp-options-error { color: var(--text-secondary); }
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
.prp-options { margin-top: 4px; }
.prp-options-summary {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 4px 2px;
  cursor: pointer;
  font-size: var(--font-xs);
}
.prp-options-summary:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
.prp-approval {
  padding: 2px 8px;
  border-radius: 10px;
  border: 1px solid transparent;
  font-weight: 600;
}
.prp-approval.is-approved {
  background: rgba(34,197,94,0.10); color: rgb(21,128,61);
  border-color: rgba(34,197,94,0.30);
}
.prp-approval.is-pending {
  background: var(--bg-tertiary); color: var(--text-muted);
  border-color: var(--border);
}
</style>
