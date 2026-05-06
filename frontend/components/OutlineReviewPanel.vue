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
          <div class="op-row-actions">
            <button
              class="btn btn-sm btn-secondary"
              :disabled="!canExpand || isChapterDone(entry.n) || expanding"
              :title="!approvedAt
                ? 'Approve the outline first'
                : isChapterDone(entry.n)
                  ? 'Already on disk — use the Chapters panel to regenerate'
                  : `Expand only chapter ${entry.n}`"
              @click="expandOne(entry.n)"
            >
              ▶ Expand
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

const canExpand = computed(() => !!approvedAt.value)
const pendingCount = computed(() =>
  outline.value.filter(e => !chaptersDone.value.includes(e.n)).length,
)

function isChapterDone(n: number): boolean {
  return chaptersDone.value.includes(n)
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

// ── Lifecycle ─────────────────────────────────────────────────────────────

onMounted(() => { void loadOutline() })

watch(() => [props.episodeId, props.title, props.refreshKey], () => { void loadOutline() })

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
.op-words-input {
  width: 96px;
  text-align: right;
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
