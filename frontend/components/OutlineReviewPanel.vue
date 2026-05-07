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
        the LLM during expansion. Set a per-chapter word target to override the global default for one slot.
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
              min="100"
              step="50"
              :value="outline[idx].words_per_chapter ?? ''"
              :placeholder="`${defaultWords}`"
              title="Per-chapter word target. Leave blank to use the global default."
              @input="onWordsInput($event, idx)"
              @blur="markDirtyAndAutosave"
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
            <button
              v-if="!isChapterDone(entry.n)"
              class="btn btn-sm btn-secondary"
              :disabled="!canExpand || expanding"
              :title="!approvedAt
                ? 'Approve the outline first'
                : `Expand only chapter ${entry.n}`"
              @click="expandOne(entry.n)"
            >
              ▶ Expand
            </button>
            <button
              v-else
              class="btn btn-sm btn-secondary"
              :disabled="regenInFlight !== null"
              :title="`Regenerate chapter ${entry.n} — keeps the same outline title, applies any per-row word override`"
              @click="regenerateOne(entry.n)"
            >
              <LoadingSpinner v-if="regenInFlight === entry.n" size="sm" />
              {{ regenInFlight === entry.n ? 'Regenerating…' : '↻ Regenerate' }}
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
              :title="`Move chapter ${entry.n} up`"
              :disabled="idx === 0"
              @click="reorder(idx, -1)"
            >▲</button>
            <button
              class="btn btn-sm btn-ghost"
              :title="`Move chapter ${entry.n} down`"
              :disabled="idx === outline.length - 1"
              @click="reorder(idx, 1)"
            >▼</button>
            <span v-if="isChapterDone(entry.n)" class="op-pill op-pill-done" title="Chapter file is on disk">on disk</span>
          </div>
        </div>
        <div v-if="mode === 'listicle'" class="op-row-body">
          <input
            class="input op-hook-input"
            v-model="outline[idx].hook_line"
            placeholder="One-line hook (provocative claim or counter-intuitive question)"
            @blur="markDirtyAndAutosave"
          />
          <textarea
            class="textarea op-facts-input"
            :value="(outline[idx].key_facts || []).join('\n')"
            placeholder="Key facts — one per line. The LLM uses these as expansion seeds."
            rows="2"
            @input="onFactsInput($event, idx)"
            @blur="markDirtyAndAutosave"
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
          <textarea
            class="textarea op-beats-input"
            :value="(outline[idx].key_beats || []).join('\n')"
            placeholder="Key beats — one per line"
            rows="2"
            @input="onBeatsInput($event, idx)"
            @blur="markDirtyAndAutosave"
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
        <button
          class="btn btn-secondary"
          :disabled="!canExpand || expanding || selectedNs.length === 0"
          :title="!approvedAt ? 'Approve the outline first' : selectedNs.length === 0 ? 'Tick the checkboxes for chapters you want to expand' : `Expand ${selectedNs.length} selected chapter(s)`"
          @click="expandSelected"
        >
          <LoadingSpinner v-if="expanding" size="sm" />
          ▶ Expand selected ({{ selectedNs.length }})
        </button>
        <button
          class="btn btn-primary"
          :disabled="!canExpand || expanding || pendingCount === 0"
          :title="!approvedAt ? 'Approve the outline first' : pendingCount === 0 ? 'All chapters already on disk' : `Expand all ${pendingCount} pending chapter(s)`"
          @click="expandAll"
        >
          <LoadingSpinner v-if="expanding" size="sm" />
          ▶ Expand all ({{ pendingCount }})
        </button>
      </div>
    </div>
  </div>

  <!-- No outline yet (sidecar absent) — render nothing. scripts.vue shows
       the "Generate Outline" button instead. -->
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

interface OutlineResponse {
  mode: 'narrative' | 'listicle'
  total_chapters: number
  outline: OutlineEntry[]
  outline_completed_at: string
  outline_approved_at: string | null
  outline_edited_at: string | null
  chapters_done: number[]
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
const loaded = ref(false)
const saving = ref(false)
const expanding = ref(false)
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
interface ChapterStats { word_count: number; character_count: number }
const chapterStats = ref<Map<number, ChapterStats>>(new Map())

const canExpand = computed(() => !!approvedAt.value)
const pendingCount = computed(() =>
  outline.value.filter(e => !chaptersDone.value.includes(e.n)).length,
)

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
    const data = await get<{ chapters: Array<{ number: number; word_count: number; character_count: number }> }>(
      `/projects/${props.projectSlug}/episodes/${props.episodeId}/chapter-list${titleParam}`,
    )
    const next = new Map<number, ChapterStats>()
    for (const ch of data.chapters || []) {
      next.set(ch.number, {
        word_count: ch.word_count || 0,
        character_count: ch.character_count || 0,
      })
    }
    chapterStats.value = next
  } catch {
    // Stat pills are advisory — silently skip on error.
  }
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
    mode.value = data.mode
    totalChapters.value = data.total_chapters
    chaptersDone.value = data.chapters_done || []
    approvedAt.value = data.outline_approved_at
    editedAt.value = data.outline_edited_at
    loaded.value = true
    isDirty.value = false
    justSaved.value = false
    selectedNs.value = []
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

function onWordsInput(ev: Event, idx: number) {
  const v = (ev.target as HTMLInputElement).value
  const num = Number(v)
  if (!v || !Number.isFinite(num) || num <= 0) {
    outline.value[idx].words_per_chapter = undefined
  } else {
    outline.value[idx].words_per_chapter = Math.round(num)
  }
  isDirty.value = true
  justSaved.value = false
}

function onFactsInput(ev: Event, idx: number) {
  const lines = (ev.target as HTMLTextAreaElement).value
    .split('\n').map(s => s.trim()).filter(Boolean)
  outline.value[idx].key_facts = lines
  isDirty.value = true
  justSaved.value = false
}

function onBeatsInput(ev: Event, idx: number) {
  const lines = (ev.target as HTMLTextAreaElement).value
    .split('\n').map(s => s.trim()).filter(Boolean)
  outline.value[idx].key_beats = lines
  isDirty.value = true
  justSaved.value = false
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
  if (isDirty.value) {
    // Auto-save before expanding so the LLM works against the user's
    // visible edits, not stale sidecar state.
    await saveEdits(/* silent */ true)
  }
  expanding.value = true
  try {
    const body: any = {
      episode_id: props.episodeId,
      title: props.title || '',
    }
    if (chapters) body.chapters = chapters
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
    expanding.value = false
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
const regenInFlight = ref<number | null>(null)
async function regenerateOne(n: number): Promise<void> {
  if (regenInFlight.value !== null) return
  if (isDirty.value) await saveEdits(/* silent */ true)
  regenInFlight.value = n

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
    // The chapter-only job watcher already clears previewCache on done;
    // we don't need to await terminal state here. Drop the in-flight
    // flag so the user can immediately queue another row's regen.
    regenInFlight.value = null
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────

onMounted(() => { void loadOutline() })

watch(() => [props.episodeId, props.title, props.refreshKey], (next, prev) => {
  // Episode switch: close any open preview drawers and wipe the cache
  // — the previous episode's content doesn't belong here. refreshKey
  // bumps don't switch episode, so we keep open drawers but clear
  // their cache (the chapter content may have changed on disk).
  const prevEpisodeId = Array.isArray(prev) ? prev[0] : undefined
  const nextEpisodeId = Array.isArray(next) ? next[0] : undefined
  if (prevEpisodeId !== nextEpisodeId) {
    expandedPreviews.value = new Set()
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
