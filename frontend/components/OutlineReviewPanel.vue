<!--
  OutlineReviewPanel — Phase 3 of the outline-first refactor.

  Sits between "Generate Outline" and "Expand Chapters" in scripts.vue.
  Loads the chunked-progress sidecar via GET /episodes/:id/outline,
  renders editable rows, saves edits via PUT /episodes/:id/outline, and
  enqueues expand_chapters jobs (all-pending or selected) via POST
  /generate/expand-chapters.

  Mode-aware: listicle outlines surface hook_line + key_facts as the
  editable seed material; narrative outlines surface synopsis + key_beats.
  Per-row words_per_chapter input lets the user assign a longer or shorter
  target to a single chapter — that override flows through the sidecar
  into the batch prompt's per-slot Length: line.

  Approval state is the load-bearing UX:
    null  → "Draft outline — review and approve before expanding" (amber).
    set   → "Approved on {date}" (green); Expand buttons unlock.
  Expansion never runs without approval (the backend gate also enforces it).
-->
<template>
  <div class="outline-panel-host">
    <div v-if="loaded && outline.length" class="outline-panel">
    <div class="op-header">
      <div class="op-title-row">
        <h3>🗂️ Outline review</h3>
        <span :class="['op-status', approvedAt ? 'op-approved' : 'op-draft']">
          {{ approvedAt ? `✓ Approved ${relativeTime(approvedAt)}` : '⚠ Draft — review before expanding' }}
        </span>
        <span v-if="editedAt && !justSaved" class="op-edited">edited {{ relativeTime(editedAt) }}</span>
        <span v-if="justSaved" class="op-edited">edits saved</span>
      </div>
      <p class="op-help">
        Each row is an editable topic. The {{ mode === 'listicle' ? 'hook + key facts' : 'synopsis + key beats' }} seed
        the LLM during expansion. Set a per-chapter word target to override the global default for one slot
        (minimum {{ MIN_WORDS_PER_CHAPTER }} — values below the floor snap up on blur).
        The ▲▼ buttons swap topics in place and keep chapter numbers stable; existing chapter docx files
        on disk only update when you click <strong>Regenerate</strong> — rows whose docx no longer matches
        the outline show an ✏ outdated pill.
      </p>
      <!-- v3 sidecar exposes the form-field snapshot from outline-build
           time. Surface it so the user understands which model + word
           target + pattern + cast the upcoming Expand will run against —
           changing the form above no longer affects expansion of THIS
           outline (sidecar is authoritative). Hidden for v1/v2 sidecars
           where the snapshot is null (legacy outlines fall back to the
           current form fields). -->
      <p v-if="generationParams" class="op-locked-params" :title="lockedParamsTooltip">
        🔒 Locked at outline build:
        <span class="op-locked-pill">{{ generationParams.model }}</span>
        <span class="op-locked-pill">~{{ generationParams.words_per_chapter.toLocaleString() }} words/chapter</span>
        <span v-if="generationParams.perspective" class="op-locked-pill">
          POV: {{ perspectiveLabel(generationParams.perspective) }}
        </span>
        <span v-if="generationParams.style" class="op-locked-pill">
          style: {{ generationParams.style }}
        </span>
        <span v-if="generationParams.character_ids?.length" class="op-locked-pill">
          cast: {{ generationParams.character_ids.length }}
        </span>
      </p>
    </div>

    <ul class="op-list" role="list">
      <li v-for="(entry, idx) in outline" :key="entry.n" class="op-row">
        <div class="op-row-head">
          <label class="op-check">
            <input type="checkbox" v-model="selectedNs" :value="entry.n" :disabled="isChapterDone(entry.n)" />
            <span class="op-num">{{ String(entry.n).padStart(2, '0') }}</span>
          </label>
          <input
            class="input op-title-input"
            v-model="outline[idx].title"
            placeholder="Topic title"
            :title="isChapterDone(entry.n) ? 'This chapter is already on disk — edits affect future regens via Chapter list' : 'Edit topic title'"
            @blur="markDirtyAndAutosave"
          />
          <div class="op-words-cell">
            <input
              class="input op-words-input"
              type="number"
              :min="MIN_WORDS_PER_CHAPTER"
              step="50"
              :value="outline[idx].words_per_chapter ?? ''"
              :placeholder="`${defaultWords}`"
              :title="`Per-chapter word target (min ${MIN_WORDS_PER_CHAPTER} — backend floors lower values to ${MIN_WORDS_PER_CHAPTER}). Leave blank to use the global default.`"
              @input="onWordsInput($event, idx)"
              @blur="onWordsBlur(idx)"
            />
            <!-- Actual generation stats once the chapter is on disk —
                 word count + character count, fetched via /chapter-list.
                 Lets the user compare the LLM's output against the target
                 input above. Empty string when not yet on disk. -->
            <span v-if="rowCountSummary(entry.n)" class="op-words-actual"
              :title="`Actual generated content for chapter ${entry.n}. Compare to your target above.`">
              {{ rowCountSummary(entry.n) }}
            </span>
          </div>
          <div class="op-row-actions">
            <!-- Single button that morphs: Expand when chapter is pending
                 (calls /generate/expand-chapters with chaptersToExpand=[n]),
                 Regenerate when chapter is on disk (calls /generate/chapter-
                 only which honours the outline title + hook + facts via
                 the Phase 1 sidecar lookup AND any per-row word override).
                 Same row, same button, different verb depending on state. -->
            <!-- v1.0.103+ — was `:disabled="!canExpand || expanding"`
                 which made the button silently no-op when the outline
                 was still in Draft. Users clicked + nothing happened +
                 reported "silently failed". Now: only disable while
                 expanding (in-flight); when not approved, the click
                 handler routes to expandOne which surfaces an explicit
                 "Approve first" toast + offer-to-approve flow. -->
            <button
              v-if="!isChapterDone(entry.n)"
              class="btn btn-sm btn-secondary"
              :class="{ 'is-needs-approval': !approvedAt }"
              :disabled="expanding"
              :title="!approvedAt
                ? 'Outline is in Draft — click to approve and expand this chapter'
                : `Expand only chapter ${entry.n}`"
              @click="expandOne(entry.n)"
            >
              ▶ Expand
            </button>
            <button
              v-else
              class="btn btn-sm btn-secondary"
              :disabled="isRegenerating(entry.n)"
              :title="`Regenerate chapter ${entry.n} — keeps the same outline title, applies any per-row word override`"
              @click="regenerateOne(entry.n)"
            >
              <LoadingSpinner v-if="isRegenerating(entry.n)" size="sm" />
              {{ isRegenerating(entry.n) ? 'Queueing…' : '↻ Regenerate' }}
            </button>
            <!-- Preview button only shows once the chapter is on disk —
                 there's nothing to preview before expansion. Click to
                 open the drawer below this row showing the chapter prose,
                 click again to close. Multiple rows can be open at once.
                 Custom op-preview-toggle styling (instead of generic btn)
                 so it visually pops as a distinct affordance from the
                 outline-editing buttons next to it. -->
            <button
              v-if="isChapterDone(entry.n)"
              type="button"
              :class="['op-preview-toggle', { 'is-open': expandedPreviews.has(entry.n) }]"
              :title="expandedPreviews.has(entry.n) ? 'Hide chapter preview' : 'Preview the expanded chapter content'"
              @click="togglePreview(entry.n)"
            >
              <span class="op-preview-icon">{{ expandedPreviews.has(entry.n) ? '▾' : '▸' }}</span>
              <span>{{ expandedPreviews.has(entry.n) ? 'Hide preview' : 'Preview text' }}</span>
            </button>
            <button
              class="btn btn-sm btn-ghost"
              :title="`Swap topics with the row above. Chapter numbers stay in place — the docx on disk only updates after you Regenerate.`"
              :disabled="idx === 0"
              @click="reorder(idx, -1)"
            >▲</button>
            <button
              class="btn btn-sm btn-ghost"
              :title="`Swap topics with the row below. Chapter numbers stay in place — the docx on disk only updates after you Regenerate.`"
              :disabled="idx === outline.length - 1"
              @click="reorder(idx, 1)"
            >▼</button>
            <span v-if="isChapterDone(entry.n)" class="op-pill op-pill-done" title="Chapter file is on disk">on disk</span>
            <!-- Drift indicator: outline title diverged from the docx heading.
                 Fires after reorder (which swaps content but keeps n stable,
                 so the n=N row now shows a different title than the docx at
                 _Chapter_NN.docx) and after a plain title edit. The docx is
                 unchanged — Regenerate refreshes it. -->
            <span
              v-if="isChapterDone(entry.n) && isOutlineDriftedFromDisk(entry.n)"
              class="op-pill op-pill-stale"
              title="Outline title differs from what's on disk. Regenerate this chapter to refresh the docx."
            >✏ outdated</span>
          </div>
        </div>
        <div v-if="mode === 'listicle'" class="op-row-body">
          <input
            class="input op-hook-input"
            v-model="outline[idx].hook_line"
            placeholder="One-line hook (provocative claim or counter-intuitive question)"
            @blur="markDirtyAndAutosave"
          />
          <!-- v1.0.103+ — was bound via :value + @input with a
               split/trim/filter on every keystroke, which lost trailing
               spaces + empty lines and reset the cursor to the end.
               Now v-model'd on a per-row text buffer; blur commits the
               buffer to the array (split/trim/filter happens once). -->
          <textarea
            class="textarea op-facts-input"
            v-model="factsBufferByN[entry.n]"
            placeholder="Key facts — one per line. The LLM uses these as expansion seeds."
            rows="2"
            @blur="commitFactsBuffer(entry.n)"
          />
        </div>
        <div v-else class="op-row-body">
          <textarea
            class="textarea op-synopsis-input"
            v-model="outline[idx].synopsis"
            placeholder="~30-word synopsis"
            rows="2"
            @blur="markDirtyAndAutosave"
          />
          <!-- v1.0.103+ — same fix as the listicle facts textarea above.
               Raw text lives in beatsBufferByN[n]; blur commits to the
               array as a split/trim/filter pass. -->
          <textarea
            class="textarea op-beats-input"
            v-model="beatsBufferByN[entry.n]"
            placeholder="Key beats — one per line"
            rows="2"
            @blur="commitBeatsBuffer(entry.n)"
          />
        </div>

        <!-- Inline preview drawer for the expanded chapter content. Lazy-
             loaded once the user clicks Preview, cached per chapter so
             closing + re-opening is instant. Cache cleared on episode
             switch + on every expand_chapters / chapter-only completion. -->
        <div v-if="expandedPreviews.has(entry.n)" class="op-preview">
          <div v-if="previewLoading.has(entry.n)" class="op-preview-status">
            Loading chapter content…
          </div>
          <div v-else-if="previewErrors.get(entry.n)" class="op-preview-error">
            {{ previewErrors.get(entry.n) }}
            <button class="btn btn-sm btn-ghost" @click="loadPreview(entry.n, /* force */ true)">
              ↻ Retry
            </button>
          </div>
          <template v-else-if="previewCache.get(entry.n)">
            <!-- Stats header above the prose: actual word + character
                 counts from the chapter-list fetch. Lets the user verify
                 the LLM hit the target without scrolling away. -->
            <div v-if="rowCountSummary(entry.n)" class="op-preview-stats">
              {{ rowCountSummary(entry.n) }}
              <span class="op-preview-stats-target">
                · target ~{{ (outline[idx].words_per_chapter ?? defaultWords).toLocaleString() }} words
              </span>
            </div>
            <pre class="op-preview-content">{{ previewCache.get(entry.n) }}</pre>
          </template>
          <div v-else class="op-preview-status">No content available.</div>
        </div>
      </li>
    </ul>

    <div class="op-footer">
      <div class="op-footer-left">
        <button class="btn btn-secondary" :disabled="!isDirty || saving" @click="saveEdits()">
          <LoadingSpinner v-if="saving" size="sm" />
          {{ saving ? 'Saving…' : (isDirty ? 'Save edits' : 'No unsaved changes') }}
        </button>
        <button
          v-if="!approvedAt"
          class="btn btn-primary"
          :disabled="saving"
          @click="approveOutline"
          title="Lock in this outline so expand-chapters can run"
        >
          ✓ Mark approved
        </button>
      </div>
      <div class="op-footer-right">
        <!-- v1.0.103+ — Approval gate moved INTO the click handler so
             the buttons fire and show explicit feedback instead of
             going visually-dead. Still disabled when there's nothing
             to expand or while a job is in flight. -->
        <button
          class="btn btn-secondary"
          :class="{ 'is-needs-approval': !approvedAt && selectedNs.length > 0 }"
          :disabled="expanding || selectedNs.length === 0"
          :title="!approvedAt
            ? 'Outline is in Draft — click to approve and expand selected'
            : selectedNs.length === 0
              ? 'Tick the checkboxes for chapters you want to expand'
              : `Expand ${selectedNs.length} selected chapter(s)`"
          @click="expandSelected"
        >
          <LoadingSpinner v-if="expanding" size="sm" />
          ▶ Expand selected ({{ selectedNs.length }})
        </button>
        <button
          class="btn btn-primary"
          :class="{ 'is-needs-approval': !approvedAt && pendingCount > 0 }"
          :disabled="expanding || pendingCount === 0"
          :title="!approvedAt
            ? 'Outline is in Draft — click to approve and expand all'
            : pendingCount === 0
              ? 'All chapters already on disk'
              : `Expand all ${pendingCount} pending chapter(s)`"
          @click="expandAll"
        >
          <LoadingSpinner v-if="expanding" size="sm" />
          ▶ Expand all ({{ pendingCount }})
        </button>
      </div>
    </div>
  </div>
  </div><!-- /.outline-panel-host -->
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'

interface OutlineEntry {
  n: number
  title: string
  synopsis?: string
  key_beats?: string[]
  hook_line?: string
  key_facts?: string[]
  words_per_chapter?: number
}

interface GenerationParams {
  model: string
  length?: number
  total_words?: number
  words_per_chapter: number
  style?: string
  perspective?: string
  custom_perspective?: string
  character_ids?: string[]
  custom_style_text?: string
}

interface OutlineResponse {
  mode: 'narrative' | 'listicle'
  total_chapters: number
  outline: OutlineEntry[]
  outline_completed_at: string
  outline_approved_at: string | null
  outline_edited_at: string | null
  chapters_done: number[]
  /** v3+: snapshot of the form fields used to build the outline. null on
   *  v1/v2 sidecars (predates the snapshot). UI shows the locked model +
   *  word target so the user sees what expand-chapters will run against. */
  generation_params: GenerationParams | null
}

const props = defineProps<{
  projectSlug: string
  episodeId: string
  title?: string
  /** Form values from scripts.vue — used for the words_per_chapter
   *  default placeholder. Reactive in parent; we just read on mount. */
  defaultWords: number
  /** The full script form. Used for per-chapter Regenerate calls,
   *  which need model + style + length context that scripts.vue owns.
   *  Same prop shape ChapterListPanel takes for the same reason. */
  form?: any
  /** Bumped by scripts.vue when an outline_only or expand_chapters job
   *  reaches a terminal state — triggers a fresh load to pick up new
   *  outline / chapters_done. */
  refreshKey?: number
}>()

const emit = defineEmits<{
  /** Fired after a successful expand-chapters POST so scripts.vue can
   *  refresh ChapterListPanel + show a toast. */
  (e: 'expansion-queued', payload: { jobId: string; chapters: number[] | null }): void
  /** Fired every time the outline sidecar loads so scripts.vue can mirror
   *  the on-disk `total_chapters` + persisted `generation_params` onto its
   *  form inputs. Without this, the form fields silently revert to format
   *  defaults on remount, forcing the user to re-type the chapter count +
   *  words/chapter they already committed at outline-build time. */
  (e: 'outline-loaded', payload: {
    totalChapters: number
    wordsPerChapter: number | null
    totalWords: number | null
    lengthMinutes: number | null
    style: string | null
    perspective: string | null
    customPerspective: string | null
  }): void
}>()

const { get, post, put } = useApi()
const { success, error: showError } = useToast()
const { jobs } = useJobs()

const outline = ref<OutlineEntry[]>([])
const mode = ref<'narrative' | 'listicle'>('listicle')
const totalChapters = ref(0)
const chaptersDone = ref<number[]>([])
const approvedAt = ref<string | null>(null)
const editedAt = ref<string | null>(null)
const generationParams = ref<GenerationParams | null>(null)
const loaded = ref(false)
const saving = ref(false)
// `postingExpand` is true only while the POST /generate/expand-chapters
// request is in flight. Once the response lands the SSE-driven
// `activeExpandJob` computed (below) takes over so the button stays
// disabled until the expansion job actually completes — without that
// chain, a user clicking Expand twice in 100ms would clear the local
// flag on POST resolution and hit the backend's per-(episode, type)
// 409 dedupe with a generic toast.
const postingExpand = ref(false)
const isDirty = ref(false)
const justSaved = ref(false)
const selectedNs = ref<number[]>([])

// Per-row inline preview state (Phase 4). Mirrors the ChapterListPanel
// preview pattern: lazy-load the chapter content from the existing
// /chapters/:n/content endpoint, cache per chapter so close+reopen is
// instant, clear cache on episode switch AND on every expand_chapters /
// chapter-only completion (the on-disk content just changed). Multiple
// rows can be open at once.
const expandedPreviews = ref<Set<number>>(new Set())
const previewCache = ref<Map<number, string>>(new Map())
const previewLoading = ref<Set<number>>(new Set())
const previewErrors = ref<Map<number, string>>(new Map())

// Per-chapter generation stats — populated by the chapter-list endpoint
// once any chapter is on disk. Lets the user see actual word + character
// counts per row so they can compare what the LLM produced against the
// target (the words_per_chapter input). Keyed by chapter number.
//
// `disk_title` is the title parsed from the on-disk docx heading. Compared
// against the outline entry's title to detect drift after the user reorders
// rows (which swaps content but holds `n` stable, leaving the docx out of
// sync) or simply edits a title without regenerating. The drift surfaces
// as an "outdated" pill so the user knows the docx no longer matches the
// outline they see — clicking Regenerate refreshes it.
interface ChapterStats { word_count: number; character_count: number; disk_title: string }
const chapterStats = ref<Map<number, ChapterStats>>(new Map())

const canExpand = computed(() => !!approvedAt.value)
const pendingCount = computed(() =>
  outline.value.filter(e => !chaptersDone.value.includes(e.n)).length,
)

// Long-form tooltip for the locked-params row. Spells out the WHY so the
// user understands they can't change model/words for an existing outline
// without regenerating it. Matches the explain-as-you-go pattern the rest
// of the app uses.
const lockedParamsTooltip = computed(() => {
  if (!generationParams.value) return ''
  const gp = generationParams.value
  const parts = [
    `Model: ${gp.model}`,
    `Per-chapter target: ${gp.words_per_chapter.toLocaleString()} words`,
  ]
  if (gp.length) parts.push(`Length: ${gp.length} min`)
  if (gp.total_words) parts.push(`Total words: ${gp.total_words.toLocaleString()}`)
  if (gp.perspective) parts.push(`POV: ${perspectiveLabel(gp.perspective)}`)
  if (gp.style) parts.push(`Narrator style: ${gp.style}`)
  if (gp.custom_perspective) parts.push(`Custom POV: ${gp.custom_perspective}`)
  if (gp.character_ids?.length) parts.push(`Cast: ${gp.character_ids.length} character(s)`)
  return parts.join(' · ') +
    '\n\nExpand-chapters reads these from the outline sidecar, not the form above. ' +
    'To change model/words/cast, regenerate the outline.'
})

function perspectiveLabel(value: string): string {
  return {
    auto: 'Auto',
    none: 'None',
    first: 'First person',
    'first-subject': 'First person as subject',
    'first-plural': 'First person plural',
    second: 'Second person',
    'second-immersive': 'Second person immersive',
    third: 'Third person limited',
    'third-omniscient': 'Third person omniscient',
    'third-documentary': 'Third person documentary',
  }[value] || value
}

// SSE-driven view of the queue: any chapter-only or expand_chapters job
// for THIS episode that's still queued/running. Combined with the local
// posting refs, this is what the buttons actually disable on — so once
// the user clicks, the button stays disabled through POST + queue + run
// + completion, not just POST.
const activeExpandJob = computed(() =>
  jobs.value.some(j =>
    j.episode_id === props.episodeId
    && j.type === 'expand_chapters'
    && (j.status === 'queued' || j.status === 'running')),
)
const activeChapterOnlyChapter = computed<number | null>(() => {
  const j = jobs.value.find(j =>
    j.episode_id === props.episodeId
    && j.type === 'chapter-only'
    && (j.status === 'queued' || j.status === 'running'))
  if (!j) return null
  const n = Number((j.params as any)?.chapter_number)
  return Number.isFinite(n) ? n : -1
})
const expanding = computed(() => postingExpand.value || activeExpandJob.value)

function isChapterDone(n: number): boolean {
  return chaptersDone.value.includes(n)
}

// ── Inline preview (per-row drawer) ───────────────────────────────────────

async function loadPreview(n: number, force = false): Promise<void> {
  if (!props.episodeId) return
  if (!force && previewCache.value.has(n)) return
  previewLoading.value.add(n)
  previewLoading.value = new Set(previewLoading.value)
  previewErrors.value.delete(n)
  previewErrors.value = new Map(previewErrors.value)
  try {
    const titleParam = props.title ? `?title=${encodeURIComponent(props.title)}` : ''
    const data = await get<{ content: string }>(
      `/projects/${props.projectSlug}/episodes/${props.episodeId}/chapters/${n}/content${titleParam}`,
    )
    previewCache.value.set(n, data.content || '(empty chapter)')
    previewCache.value = new Map(previewCache.value)
  } catch (e: any) {
    const msg = e?.data?.detail || `Could not load chapter ${n}`
    previewErrors.value.set(n, msg)
    previewErrors.value = new Map(previewErrors.value)
  } finally {
    previewLoading.value.delete(n)
    previewLoading.value = new Set(previewLoading.value)
  }
}

function togglePreview(n: number) {
  if (expandedPreviews.value.has(n)) {
    expandedPreviews.value.delete(n)
  } else {
    expandedPreviews.value.add(n)
    void loadPreview(n)
  }
  expandedPreviews.value = new Set(expandedPreviews.value)
}

function clearPreviewCache() {
  // Called on episode switch + on every expand_chapters / chapter-only
  // completion. Wipes the cache + re-fetches any open drawers so they
  // show fresh content immediately (otherwise the drawer would show
  // stale content until the user collapsed + re-expanded).
  previewCache.value = new Map()
  previewErrors.value = new Map()
  previewLoading.value = new Set()
  for (const n of expandedPreviews.value) {
    void loadPreview(n, /* force */ true)
  }
}

// Fetch /chapter-list to populate per-row stats (word_count +
// character_count). Cheap (one HTTP call) and the response is small —
// metadata only, no content. Called on outline load + after any
// chapter-changing job completes. Failures are non-fatal: the stat
// pills just don't render until the next refresh.
async function loadChapterStats(): Promise<void> {
  if (!props.episodeId) return
  try {
    const titleParam = props.title ? `?title=${encodeURIComponent(props.title)}` : ''
    const data = await get<{ chapters: Array<{ number: number; title: string; word_count: number; character_count: number }> }>(
      `/projects/${props.projectSlug}/episodes/${props.episodeId}/chapter-list${titleParam}`,
    )
    const next = new Map<number, ChapterStats>()
    for (const ch of data.chapters || []) {
      next.set(ch.number, {
        word_count: ch.word_count || 0,
        character_count: ch.character_count || 0,
        disk_title: ch.title || '',
      })
    }
    chapterStats.value = next
  } catch {
    // Stat pills are advisory — silently skip on error.
  }
}

// Drift detection: an outline entry whose title doesn't match the docx
// heading on disk is "outdated" — the user has reordered rows or edited
// a title since the chapter was last generated. The docx is intact (no
// data loss), but the visible outline no longer describes what the file
// contains. Regenerate refreshes the docx to match.
//
// Title comparison is whitespace+case insensitive so trivial editor
// noise ("My Title " vs "my title") doesn't trip the warning.
function normalizeTitleForCompare(s: string): string {
  return (s || '').trim().toLowerCase().replace(/\s+/g, ' ')
}
function isOutlineDriftedFromDisk(n: number): boolean {
  const stats = chapterStats.value.get(n)
  if (!stats) return false
  const entry = outline.value.find(e => e.n === n)
  if (!entry) return false
  return normalizeTitleForCompare(stats.disk_title) !== normalizeTitleForCompare(entry.title)
}

// Helper for the row-level "actual vs target" delta. Returns a label
// the row renders next to its words_per_chapter input. Empty string
// when the chapter isn't on disk yet (no actual count to compare).
function rowCountSummary(n: number): string {
  const stats = chapterStats.value.get(n)
  if (!stats) return ''
  return `${stats.word_count.toLocaleString()} words · ${stats.character_count.toLocaleString()} chars`
}

function relativeTime(iso: string | null): string {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    const diff = (Date.now() - d.getTime()) / 1000
    if (diff < 60) return 'just now'
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
    return d.toLocaleDateString()
  } catch { return '' }
}

async function loadOutline() {
  if (!props.episodeId) {
    loaded.value = false
    outline.value = []
    return
  }
  try {
    const titleParam = props.title ? `?title=${encodeURIComponent(props.title)}` : ''
    const data = await get<OutlineResponse>(
      `/projects/${props.projectSlug}/episodes/${props.episodeId}/outline${titleParam}`,
    )
    outline.value = (data.outline || []).map(e => ({ ...e }))
    // v1.0.103+ — seed the per-row text buffers as soon as the outline
    // is in place. Without this, the textareas render empty on first
    // load (the v-model'd buffer object has no key for n yet).
    seedRowBuffersFromOutline()
    mode.value = data.mode
    totalChapters.value = data.total_chapters
    chaptersDone.value = data.chapters_done || []
    approvedAt.value = data.outline_approved_at
    editedAt.value = data.outline_edited_at
    generationParams.value = data.generation_params
    loaded.value = true
    isDirty.value = false
    justSaved.value = false
    // Mirror the sidecar's authoritative sizing back up to the parent form.
    // The user already committed to N chapters × W words at outline-build
    // time — surface that on the inputs so they don't appear to revert to
    // format defaults after a reload/remount.
    emit('outline-loaded', {
      totalChapters: data.total_chapters,
      wordsPerChapter: data.generation_params?.words_per_chapter ?? null,
      totalWords: data.generation_params?.total_words ?? null,
      lengthMinutes: data.generation_params?.length ?? null,
      style: data.generation_params?.style ?? null,
      perspective: data.generation_params?.perspective ?? null,
      customPerspective: data.generation_params?.custom_perspective ?? null,
    })
    // Prune (don't wipe) selectedNs: keep selections of chapters that are
    // still pending in the refreshed outline. Wiping on every refresh
    // would delete the user's in-flight selection whenever an unrelated
    // job-completion fires the relevant-jobs watcher. Episode switches
    // still wipe via the watcher at the bottom of the file (which also
    // resets expandedPreviews) before this loadOutline runs.
    const validPending = new Set(
      outline.value.filter(e => !chaptersDone.value.includes(e.n)).map(e => e.n),
    )
    selectedNs.value = selectedNs.value.filter(n => validPending.has(n))
    // Whenever any chapter is on disk, fetch the per-chapter stats so
    // the row-level "actual count" pill can render. Don't block the
    // outline render on it — the call runs in parallel.
    if (chaptersDone.value.length > 0) void loadChapterStats()
  } catch (e: any) {
    // 404 = no sidecar yet (user hasn't run outline-only). Hide the panel
    // — scripts.vue shows the Generate Outline button instead.
    if (e?.status === 404 || /no outline/i.test(e?.data?.detail || '')) {
      loaded.value = false
      outline.value = []
      return
    }
    showError(e?.data?.detail || 'Could not load outline')
    loaded.value = false
  }
}

// ── Edit handlers ─────────────────────────────────────────────────────────

let autosaveTimer: ReturnType<typeof setTimeout> | null = null

function markDirtyAndAutosave() {
  isDirty.value = true
  justSaved.value = false
  if (autosaveTimer) clearTimeout(autosaveTimer)
  autosaveTimer = setTimeout(() => { void saveEdits(/* silent */ true) }, 600)
}

// Per-chapter word floor enforced by the backend (see
// electron/server/lib/chunked-narration.ts:effectiveWordTarget +
// computeWordBudget — both clamp to 120). Users typing below this got
// their value silently bumped server-side, producing a confusing mismatch
// between the typed override and the actual generated wordcount. We snap
// to the floor on blur so the visible input matches what the LLM will
// actually receive.
const MIN_WORDS_PER_CHAPTER = 120

function onWordsInput(ev: Event, idx: number) {
  const v = (ev.target as HTMLInputElement).value
  const num = Number(v)
  if (!v || !Number.isFinite(num) || num <= 0) {
    outline.value[idx].words_per_chapter = undefined
  } else {
    // Don't floor mid-typing — the user could be on their way to "1500"
    // (passing through "1", "15", "150"). Floor only on blur.
    outline.value[idx].words_per_chapter = Math.round(num)
  }
  isDirty.value = true
  justSaved.value = false
}

function onWordsBlur(idx: number) {
  // Snap sub-floor values UP to the backend minimum so the input reflects
  // what generation will actually receive. Untouched blanks (= use default)
  // pass through unchanged.
  const current = outline.value[idx].words_per_chapter
  if (typeof current === 'number' && current > 0 && current < MIN_WORDS_PER_CHAPTER) {
    outline.value[idx].words_per_chapter = MIN_WORDS_PER_CHAPTER
  }
  markDirtyAndAutosave()
}

// v1.0.103+ — Per-row text buffers for the key_facts / key_beats
// textareas. Keyed by chapter number (entry.n) so reorders that swap
// content but keep n stable preserve the right buffer→chapter mapping.
//
// The old `:value` + `@input` pattern split/trim/filtered on every
// keystroke, which:
//   - stripped trailing whitespace (so a typed space was instantly
//     erased and the cursor jumped to end of line)
//   - filtered out empty lines (so pressing Enter mid-text instantly
//     removed the newline and the cursor jumped to end)
// Now the textarea v-models the raw string and commits to the array
// on blur — split/trim/filter runs ONCE per edit session, never
// mid-typing.
const factsBufferByN = ref<Record<number, string>>({})
const beatsBufferByN = ref<Record<number, string>>({})

/** Seed both buffer maps from the current outline. Called after
 *  loadOutline() finishes and after reorder() swaps content (because
 *  the buffer at n=N now has stale text for the other row's content). */
function seedRowBuffersFromOutline(): void {
  const facts: Record<number, string> = {}
  const beats: Record<number, string> = {}
  for (const entry of outline.value) {
    facts[entry.n] = (entry.key_facts || []).join('\n')
    beats[entry.n] = (entry.key_beats || []).join('\n')
  }
  factsBufferByN.value = facts
  beatsBufferByN.value = beats
}

function commitFactsBuffer(n: number): void {
  const idx = outline.value.findIndex(e => e.n === n)
  if (idx < 0) return
  const raw = factsBufferByN.value[n] ?? ''
  outline.value[idx].key_facts = raw
    .split('\n').map(s => s.trim()).filter(Boolean)
  markDirtyAndAutosave()
}
function commitBeatsBuffer(n: number): void {
  const idx = outline.value.findIndex(e => e.n === n)
  if (idx < 0) return
  const raw = beatsBufferByN.value[n] ?? ''
  outline.value[idx].key_beats = raw
    .split('\n').map(s => s.trim()).filter(Boolean)
  markDirtyAndAutosave()
}

function reorder(idx: number, delta: -1 | 1) {
  const newIdx = idx + delta
  if (newIdx < 0 || newIdx >= outline.value.length) return
  // Swap entries but PRESERVE chapter numbers (n stays bound to the
  // expansion target). The visual order changes; the on-disk chapter
  // numbering is unchanged. This matches what users expect — "I want
  // chapter 5 to discuss the Mars topic, but show it before chapter 3
  // in my notes" is a UI-only concern.
  // Actually for outline review we want REAL reorder: if the user wants
  // topic X to be chapter 1 instead of chapter 5, swap titles + bodies
  // but keep the existing n values intact (so chapters_done stays
  // consistent). Simplest approach: swap the editable fields (title,
  // hook_line, key_facts, synopsis, key_beats, words_per_chapter)
  // between positions; n stays where it was.
  const a = outline.value[idx]
  const b = outline.value[newIdx]
  const swap = <T extends keyof OutlineEntry>(k: T) => {
    const tmp = a[k]; a[k] = b[k]; b[k] = tmp
  }
  swap('title'); swap('synopsis'); swap('key_beats')
  swap('hook_line'); swap('key_facts'); swap('words_per_chapter')
  // v1.0.103+ — the textarea buffers are keyed by n (which stays stable
  // through a reorder), so the buffer at n=N still holds the OLD row's
  // text after the swap. Re-seed both buffers to match the new content.
  seedRowBuffersFromOutline()
  isDirty.value = true
  justSaved.value = false
}

// ── Save / approve ────────────────────────────────────────────────────────

async function saveEdits(silent = false): Promise<void> {
  if (saving.value) return
  saving.value = true
  try {
    const titleParam = props.title ? `?title=${encodeURIComponent(props.title)}` : ''
    const resp = await put<{ outline_edited_at: string; outline_approved_at: string | null }>(
      `/projects/${props.projectSlug}/episodes/${props.episodeId}/outline${titleParam}`,
      { outline: outline.value, approved: !!approvedAt.value },
    )
    editedAt.value = resp.outline_edited_at
    approvedAt.value = resp.outline_approved_at
    isDirty.value = false
    justSaved.value = true
    if (!silent) success('Outline saved')
  } catch (e: any) {
    showError(e?.data?.detail || 'Could not save outline')
  } finally {
    saving.value = false
  }
}

async function approveOutline() {
  if (saving.value) return
  // Save with approved=true.
  saving.value = true
  try {
    const titleParam = props.title ? `?title=${encodeURIComponent(props.title)}` : ''
    const resp = await put<{ outline_edited_at: string; outline_approved_at: string | null }>(
      `/projects/${props.projectSlug}/episodes/${props.episodeId}/outline${titleParam}`,
      { outline: outline.value, approved: true },
    )
    editedAt.value = resp.outline_edited_at
    approvedAt.value = resp.outline_approved_at
    isDirty.value = false
    success('Outline approved — ready to expand')
  } catch (e: any) {
    showError(e?.data?.detail || 'Could not approve outline')
  } finally {
    saving.value = false
  }
}

// ── Expand triggers ───────────────────────────────────────────────────────

async function postExpand(chapters: number[] | null): Promise<void> {
  if (expanding.value) return
  // v1.0.103+ — explicit approval gate. The buttons used to be
  // HTML-disabled when !approvedAt, which meant clicks didn't fire +
  // users saw nothing happen. Now the buttons stay enabled and we
  // handle the gate here: confirm-and-approve, then expand. Skip
  // confirmation if the user is rapidly clicking through, since the
  // intent is already obvious (they JUST said expand on a Draft).
  if (!approvedAt.value) {
    const { ask } = useConfirm()
    const ok = await ask({
      title: 'Approve the outline?',
      message:
        'This outline is still in Draft. Expanding chapters locks in the current outline content. ' +
        'You can still edit and Regenerate individual chapters afterwards, but the structural review pass should happen here. ' +
        'Click Approve to lock the outline and continue with the expansion.',
      confirmLabel: 'Approve and expand',
    })
    if (!ok) return
    await approveOutline()
    if (!approvedAt.value) {
      // approveOutline already surfaced an error toast; bail.
      return
    }
  }
  if (isDirty.value) {
    // Auto-save before expanding so the LLM works against the user's
    // visible edits, not stale sidecar state.
    await saveEdits(/* silent */ true)
  }
  postingExpand.value = true
  try {
    // Mirror the body shape /generate/outline-only sends, so the backend's
    // setupChunkedJobContext sees a fully-populated GenerateScriptRequest
    // (model in particular — without it callAi crashes on
    // `undefined.startsWith` inside provider dispatch). Filter array goes
    // under chapters_to_expand to avoid colliding with the chapter-count
    // semantic of `chapters` in setupChunkedJobContext.
    const body: any = {
      episode_id: props.episodeId,
      title: props.title || '',
      model: props.form?.model,
      style: props.form?.style,
      perspective: props.form?.perspective,
      length: props.form?.length,
      chapters: props.form?.chapters,
      total_words: props.form?.total_words,
      words_per_chapter: props.form?.words_per_chapter,
      character_ids: props.form?.character_ids,
      custom_style_text: props.form?.custom_style_text,
    }
    if (chapters) body.chapters_to_expand = chapters
    const resp = await post<{ job_id: string }>(
      `/projects/${props.projectSlug}/generate/expand-chapters`,
      body,
    )
    success(chapters
      ? `Queued expansion for chapter${chapters.length === 1 ? '' : 's'} ${chapters.join(', ')}`
      : `Queued expansion for ${pendingCount.value} chapter(s)`,
    )
    emit('expansion-queued', { jobId: resp.job_id, chapters: chapters })
    // Clear selection after a successful queue.
    if (chapters) selectedNs.value = []
  } catch (e: any) {
    showError(e?.data?.detail || 'Could not queue expansion')
  } finally {
    // Only the POST flag clears here — the SSE-driven `activeExpandJob`
    // keeps `expanding` truthy until the queued job hits a terminal
    // state, so the button stays disabled across the whole expansion.
    postingExpand.value = false
  }
}

function expandOne(n: number) { void postExpand([n]) }
function expandSelected() { void postExpand([...selectedNs.value].sort((a, b) => a - b)) }
function expandAll() { void postExpand(null) }

// Per-chapter regenerate (Phase 4 follow-up). Once a chapter is on
// disk, the row's primary action should be "regenerate this chapter"
// not "expand this chapter" — they're functionally the same operation
// but the user model is different. We POST to /generate/chapter-only
// (the existing endpoint that already threads outline title + hook +
// key_facts into the prompt via the Phase 1 sidecar lookup, AND honours
// per-chapter words override). Reuses the form prop the same way
// ChapterListPanel does.
//
// Auto-saves any pending outline edits first so the regen prompt sees
// the user's latest title / hook / facts, not the stale sidecar.
// Per-chapter in-flight set so the user can queue multiple regens in a row.
// Each entry holds the chapter number whose POST is currently being awaited
// (cleared in finally regardless of success/error). Backend dedupes per
// (episode, chapter), so two clicks on the SAME chapter still 409 — but
// different chapters all enqueue and run back-to-back behind the queue.
const regenInFlight = ref<Set<number>>(new Set())
function isRegenerating(n: number): boolean {
  return regenInFlight.value.has(n)
}
async function regenerateOne(n: number): Promise<void> {
  if (regenInFlight.value.has(n)) return
  if (isDirty.value) await saveEdits(/* silent */ true)
  regenInFlight.value = new Set([...regenInFlight.value, n])

  // Per-row word override on the outline entry wins over the form
  // default. Same precedence as ChapterListPanel + the batch prompt.
  const entry = outline.value.find(e => e.n === n)
  const entryOverride = entry?.words_per_chapter
  const wordTarget = (typeof entryOverride === 'number' && Number.isFinite(entryOverride) && entryOverride > 0)
    ? Math.round(entryOverride)
    : props.form?.words_per_chapter

  try {
    await post(`/projects/${props.projectSlug}/generate/chapter-only`, {
      episode_id: props.episodeId,
      title: props.title || '',
      chapter_number: n,
      model: props.form?.model,
      style: props.form?.style,
      length: props.form?.length,
      chapters: props.form?.chapters,
      total_words: props.form?.total_words,
      words_per_chapter: wordTarget,
    })
    success(entryOverride
      ? `Chapter ${n} regenerate queued at ${wordTarget} words`
      : `Chapter ${n} regenerate queued`)
  } catch (e: any) {
    showError(e?.data?.detail || `Failed to queue chapter ${n} regen`)
  } finally {
    // Clear THIS chapter's in-flight flag so its button re-enables. Other
    // chapters in flight stay flagged. Reassign the Set so Vue tracks the
    // mutation (Set methods alone don't trigger reactivity).
    const next = new Set(regenInFlight.value)
    next.delete(n)
    regenInFlight.value = next
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────

onMounted(() => { void loadOutline() })

watch(() => [props.episodeId, props.title, props.refreshKey], (next, prev) => {
  // Episode switch: close any open preview drawers, wipe the cache, and
  // drop any chapter selections from the previous episode (whose chapter
  // numbers may not even exist in the new outline). refreshKey bumps
  // don't switch episode, so we keep open drawers + selections but
  // clear preview cache (the chapter content may have changed on disk).
  const prevEpisodeId = Array.isArray(prev) ? prev[0] : undefined
  const nextEpisodeId = Array.isArray(next) ? next[0] : undefined
  if (prevEpisodeId !== nextEpisodeId) {
    expandedPreviews.value = new Set()
    selectedNs.value = []
  }
  clearPreviewCache()
  void loadOutline()
})

// Auto-refresh when an outline_only or expand_chapters job for THIS
// episode reaches a terminal state — the sidecar may have changed
// (new outline, new chapters_done).
//
// IMPORTANT: deep-watching the whole `jobs` array makes the watcher fire
// on every output_lines push from a running expansion job — easily
// hundreds of times per second across a multi-batch listicle expansion.
// Combined with this panel rendering 50+ editable rows, it locked the
// UI thread (user couldn't navigate to the Jobs tab during expand).
//
// Fix: derive a tiny string signal of "relevant job statuses" and watch
// THAT instead. The signal only changes when a relevant job transitions
// states (queued → running → done/error/cancelled), so the watcher fires
// once per transition, not once per output line.
const relevantJobsSignal = computed(() =>
  jobs.value
    .filter(j =>
      j.episode_id === props.episodeId &&
      (j.type === 'outline_only' || j.type === 'expand_chapters'),
    )
    .map(j => `${j.job_id}:${j.status}`)
    .sort()
    .join('|'),
)
watch(relevantJobsSignal, (next, prev) => {
  if (next === prev) return
  // Reload only when something just transitioned to 'done' (or back from
  // an in-flight state). The signal changes on any transition, but
  // queued → running doesn't need a sidecar refresh — only the terminal
  // ones do.
  const prevHasDone = (prev || '').includes(':done')
  const nextHasDone = next.includes(':done')
  if (nextHasDone && !prevHasDone) {
    void loadOutline()
    // expand_chapters just landed → on-disk chapter content is fresh.
    // Wipe + re-fetch any open preview drawers so the user sees the
    // new text immediately, no manual re-toggle needed.
    clearPreviewCache()
    void loadChapterStats()
  }
})

// Also watch chapter-only completions — per-chapter regen replaces a
// single chapter's docx, so any open preview for that chapter needs to
// re-fetch. Same signal-based pattern, scoped to chapter-only.
const chapterOnlySignal = computed(() =>
  jobs.value
    .filter(j => j.episode_id === props.episodeId && j.type === 'chapter-only')
    .map(j => `${j.job_id}:${j.status}`)
    .sort()
    .join('|'),
)
watch(chapterOnlySignal, (next, prev) => {
  if (next === prev) return
  const prevHasDone = (prev || '').includes(':done')
  const nextHasDone = next.includes(':done')
  if (nextHasDone && !prevHasDone) {
    clearPreviewCache()
    void loadChapterStats()
  }
})

onUnmounted(() => {
  if (autosaveTimer) clearTimeout(autosaveTimer)
})

// Expose loaded so scripts.vue can show the right empty-state.
defineExpose({ loaded, reload: loadOutline })
</script>

<style scoped>
.outline-panel {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 14px 16px;
  margin-top: 16px;
}

.op-header {
  margin-bottom: 12px;
}
.op-title-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.op-title-row h3 {
  margin: 0;
  font-size: 14px;
  color: var(--text-primary);
}
.op-status {
  font-size: 12px;
  font-weight: 500;
  padding: 3px 9px;
  border-radius: 999px;
  border: 1px solid var(--border);
}
.op-approved {
  background: rgba(16, 185, 129, 0.10);
  color: rgb(16, 185, 129);
  border-color: rgba(16, 185, 129, 0.35);
}
.op-draft {
  background: rgba(255, 180, 0, 0.10);
  color: rgb(200, 140, 0);
  border-color: rgba(255, 180, 0, 0.35);
}
.op-edited {
  font-size: 11px;
  color: var(--text-muted);
  font-style: italic;
}
.op-help {
  margin: 8px 0 0 0;
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.5;
}
/* Stable host: contains the v-if'd outline panel so the component's root
   vnode always has a real DOM el. No visual presence when empty. */
.outline-panel-host { display: contents; }

.op-locked-params {
  margin: 6px 0 0 0;
  font-size: 11px;
  color: var(--text-muted);
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  cursor: help;
}
.op-locked-pill {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  font-family: var(--font-mono, monospace);
  font-size: 10px;
  color: var(--text-secondary);
}

.op-list {
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-primary);
  overflow: hidden;
}
.op-row {
  border-bottom: 1px solid var(--border);
  padding: 10px 12px;
}
.op-row:last-child { border-bottom: none; }

.op-row-head {
  display: grid;
  grid-template-columns: auto 1fr auto auto;
  gap: 10px;
  align-items: center;
}
.op-check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  user-select: none;
}
.op-num {
  font-weight: 600;
  color: var(--text-primary);
  font-size: 13px;
  min-width: 28px;
  text-align: center;
}
.op-title-input { font-weight: 500; }
.op-words-cell {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  min-width: 0;
}
.op-words-input {
  width: 96px;
  text-align: right;
}
.op-words-actual {
  font-size: 11px;
  color: var(--text-muted);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.op-row-actions {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.op-pill {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--bg-tertiary);
  color: var(--text-muted);
  border: 1px solid var(--border);
}
.op-pill-done {
  background: rgba(16, 185, 129, 0.10);
  color: rgb(16, 185, 129);
  border-color: rgba(16, 185, 129, 0.35);
}
/* Drift pill — outline title diverged from the on-disk docx heading.
   Yellow/amber so it reads as "needs attention" without alarming the
   user. Same palette as ChapterListPanel's audio-stale pill. */
.op-pill-stale {
  background: rgba(234, 179, 8, 0.14);
  color: rgb(202, 138, 4);
  border-color: rgba(234, 179, 8, 0.3);
}

/* v1.0.103+ — Expand buttons that need approval first. Tinted amber
   so it reads "actionable but you'll be asked to approve first" rather
   than visually-dead disabled. Click still fires; the postExpand()
   handler intercepts and prompts to approve. */
.btn.is-needs-approval {
  background: rgba(234, 179, 8, 0.10);
  border-color: rgba(234, 179, 8, 0.45);
  color: rgb(202, 138, 4);
}
.btn.is-needs-approval:hover {
  background: rgba(234, 179, 8, 0.20);
  border-color: rgba(234, 179, 8, 0.7);
  color: rgb(180, 110, 0);
}

.op-row-body {
  margin-top: 8px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.op-hook-input,
.op-synopsis-input,
.op-facts-input,
.op-beats-input {
  font-size: 12.5px;
}

/* Preview toggle button — distinct from the generic .btn cluster
   around it (Expand, ▲, ▼, on-disk pill) so it reads as a viewer
   affordance, not another action. Uses the accent color in its
   default state to stand out in the row. */
.op-preview-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 12px;
  border-radius: var(--radius-sm);
  border: 1px solid rgba(99, 179, 237, 0.45);
  background: rgba(99, 179, 237, 0.10);
  color: rgb(99, 179, 237);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
  white-space: nowrap;
}
.op-preview-toggle:hover {
  background: rgba(99, 179, 237, 0.20);
  border-color: rgba(99, 179, 237, 0.7);
}
.op-preview-toggle.is-open {
  background: rgba(99, 179, 237, 0.30);
  border-color: rgb(99, 179, 237);
  color: var(--text-primary);
}
.op-preview-icon {
  font-size: 11px;
  line-height: 1;
}

/* Inline preview drawer — lazy-loaded chapter content rendered as
   read-only prose. Visually offset from the row so it reads as a
   "child" of that chapter, not a separate row. Mirrors ChapterListPanel's
   .chp-preview block. */
.op-preview {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--border);
}
.op-preview-status,
.op-preview-error {
  padding: 8px 0;
  font-size: 12px;
  color: var(--text-muted);
  font-style: italic;
}
.op-preview-error {
  color: rgb(220, 100, 100);
  display: flex;
  align-items: center;
  gap: 10px;
}
.op-preview-stats {
  margin-bottom: 8px;
  padding: 6px 10px;
  background: var(--bg-tertiary);
  border-radius: var(--radius-sm);
  font-size: 12px;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}
.op-preview-stats-target {
  color: var(--text-muted);
  margin-left: 4px;
}
.op-preview-content {
  margin: 0;
  padding: 12px 14px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-family: ui-serif, Georgia, Cambria, "Times New Roman", serif;
  font-size: 14px;
  line-height: 1.7;
  color: var(--text-primary);
  white-space: pre-wrap;
  word-wrap: break-word;
  max-height: 400px;
  overflow-y: auto;
}

.op-footer {
  margin-top: 12px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.op-footer-left,
.op-footer-right {
  display: inline-flex;
  gap: 8px;
  flex-wrap: wrap;
}

@media (max-width: 720px) {
  .op-row-head {
    grid-template-columns: auto 1fr;
    grid-template-rows: auto auto;
  }
  .op-words-input { grid-column: 1 / -1; }
  .op-row-actions { grid-column: 1 / -1; }
  .op-row-body { grid-template-columns: 1fr; }
}
</style>
