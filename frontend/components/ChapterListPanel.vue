<!--
  Per-chapter source files panel for scripts.vue.

  One row per chapter file on disk, fetched from
  `GET /projects/:slug/episodes/:id/chapter-list`. Each row exposes a
  Regenerate button that POSTs to `/generate/chapter-only` with the
  chapter number and the current form's settings (model, style,
  words_per_chapter, etc.). Other chapters on disk are not touched;
  the unified narration_docx is auto-assembled after the regen.

  The panel also surfaces an `audio_stale` warning per row: when the
  user regenerates a chapter, the existing audio chunks for that
  chapter become out of date. We don't auto-delete audio — just hint
  the user via a pill so they can choose to refresh it from the audio
  page when ready.

  Visual language matches AudioChapterSelector for consistency.
-->
<template>
  <div class="chapter-panel">
    <div class="chp-header">
      <h3>📖 Chapters</h3>
      <div class="chp-actions">
        <button class="btn btn-sm btn-ghost" :disabled="loading" @click="refresh">
          <LoadingSpinner v-if="loading" size="sm" />
          ↻ Refresh
        </button>
      </div>
    </div>
    <p class="text-muted" style="font-size: 12px; margin: 0 0 8px 0;">
      Click ▸ to preview a chapter's expanded text inline. Regenerate any
      chapter individually — the unified narration downstream tools read
      is auto-rebuilt after each regen.
    </p>

    <div v-if="!episodeId" class="chp-empty">Select an episode to see its chapters.</div>
    <div v-else-if="loading && !chapters.length" class="chp-empty">Loading chapters…</div>
    <div v-else-if="!chapters.length" class="chp-empty">
      No chapters yet. Generate the script (above) to create the chapter files,
      then regenerate any individual chapter from this panel.
    </div>

    <ul v-else class="chp-list" role="list">
      <li
        v-for="ch in chapters"
        :key="ch.number"
        class="chp-item"
        :class="{ 'has-stale-audio': ch.audio_stale, 'is-expanded': expandedChapters.has(ch.number) }"
      >
        <div class="chp-row">
          <button
            type="button"
            class="chp-expand"
            :title="expandedChapters.has(ch.number) ? 'Hide preview' : 'Preview chapter content'"
            :aria-label="expandedChapters.has(ch.number) ? 'Hide preview' : 'Show preview'"
            @click="togglePreview(ch.number)"
          >
            <span class="chp-expand-icon">{{ expandedChapters.has(ch.number) ? '▾' : '▸' }}</span>
            <span class="chp-expand-label">{{ expandedChapters.has(ch.number) ? 'Hide' : 'Preview' }}</span>
          </button>
          <div class="chp-meta">
            <strong class="chp-num">Chapter {{ String(ch.number).padStart(2, '0') }}</strong>
            <span class="chp-title">{{ ch.title }}</span>
          </div>
          <div class="chp-stats">
            <span v-if="ch.word_count" class="chp-pill">{{ ch.word_count.toLocaleString() }} words</span>
            <span v-if="ch.character_count" class="chp-pill" title="Character count — TTS providers charge per-character, so this is the closer-to-truth volume signal for cost estimation.">{{ ch.character_count.toLocaleString() }} chars</span>
            <span v-if="ch.modified_at" class="chp-pill">{{ relativeTime(ch.modified_at) }}</span>
            <span v-if="ch.audio_stale" class="chp-pill pill-stale" :title="staleTooltip">
              ⚠ audio stale
            </span>
          </div>
          <input
            class="input chp-words-input"
            type="number"
            :min="MIN_WORDS_PER_CHAPTER"
            step="50"
            v-model.number="wordOverrides[ch.number]"
            :placeholder="`${form?.words_per_chapter || 500}`"
            :title="`Per-chapter word target for this regen (min ${MIN_WORDS_PER_CHAPTER} — backend floors lower values to ${MIN_WORDS_PER_CHAPTER}). Leave blank to use the form default.`"
            @blur="onWordsBlur(ch.number)"
          />
          <button
            class="btn btn-sm btn-secondary chp-regen"
            :disabled="!scriptReady || isRegenerating(ch.number)"
            :title="!scriptReady ? noScriptTooltip : 'Regenerate this chapter only'"
            @click="regenerate(ch.number)"
          >
            <LoadingSpinner v-if="isRegenerating(ch.number)" size="sm" />
            {{ isRegenerating(ch.number) ? 'Regenerating…' : '↻ Regenerate' }}
          </button>
        </div>

        <!-- Inline preview drawer. Rendered only when expanded so we
             don't pay the docx-parse cost for chapters the user hasn't
             opened. Cached per-chapter (see previewCache) so re-opening
             a chapter is instant; cache cleared whenever refreshKey
             ticks (regen completion, episode switch). -->
        <div v-if="expandedChapters.has(ch.number)" class="chp-preview">
          <div v-if="previewLoading.has(ch.number)" class="chp-preview-status">
            Loading chapter content…
          </div>
          <div v-else-if="previewErrors.get(ch.number)" class="chp-preview-error">
            {{ previewErrors.get(ch.number) }}
            <button class="btn btn-sm btn-ghost" @click="loadPreview(ch.number, /* force */ true)">
              ↻ Retry
            </button>
          </div>
          <pre v-else-if="previewCache.get(ch.number)" class="chp-preview-content">{{ previewCache.get(ch.number) }}</pre>
          <div v-else class="chp-preview-status">No content available.</div>
        </div>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
interface ChapterRow {
  number: number
  title: string
  present: boolean
  word_count: number
  /** v1.0.72+: character count from the chapter-list endpoint. Useful
   *  for TTS billing previews (providers charge per-character). */
  character_count?: number
  modified_at: string | null
  audio_stale: boolean
}

const props = defineProps<{
  projectSlug: string
  episodeId: string
  title?: string
  scriptReady: boolean
  // The script form so we can carry style / model / words-per-chapter
  // into the chapter-only regen request.
  form: any
  refreshKey?: number
}>()

const { get, post } = useApi()
const freshChapterAction = useFreshGenerationAction()
const { jobs } = useJobs()
const { success, error: showError } = useToast()

const chapters = ref<ChapterRow[]>([])
const loading = ref(false)
// Per-chapter in-flight set. Tracks chapter numbers whose chapter-only job
// is queued or running. Disables that chapter's button only — siblings stay
// clickable, so the user can queue multiple regens which run back-to-back
// (chapter-only queue is serial server-side, but the UI no longer makes
// the user wait on a previous job to enqueue the next). Cleared per-chapter
// when the watcher sees the matching chapter-only job reach a terminal state.
const regenInFlight = ref<Set<number>>(new Set())
function isRegenerating(n: number): boolean {
  return regenInFlight.value.has(n)
}
// Per-chapter words_per_chapter overrides — populated from the form's
// global default and overridden by the user inline. Sent on the regen
// request so a single chapter can be re-rolled at a different length.
// Cleared on episode switch.
const wordOverrides = ref<Record<number, number | undefined>>({})

// Per-row inline preview state. expandedChapters is the set of chapter
// numbers whose drawer is currently open; previewCache stores the
// fetched content per chapter (so closing + re-opening doesn't refetch).
// previewLoading + previewErrors track the in-flight fetch.
//
// Cache invalidation: cleared on episode switch AND on every refreshKey
// bump (which scripts.vue ticks after expand_chapters or chapter-only
// completes). Prevents showing stale content after a regen lands.
const expandedChapters = ref<Set<number>>(new Set())
const previewCache = ref<Map<number, string>>(new Map())
const previewLoading = ref<Set<number>>(new Set())
const previewErrors = ref<Map<number, string>>(new Map())

const noScriptTooltip = 'Generate the script first to unlock per-chapter regenerate.'
const staleTooltip = 'This chapter\'s source was changed after the audio was generated. Visit the Audio page and regenerate this section to refresh.'

// Per-chapter word floor enforced by the backend (chunked-narration.ts:
// effectiveWordTarget + computeWordBudget both clamp to 120). Below the
// floor, the typed override silently became 120 server-side, producing
// a confusing mismatch between input and actual generated wordcount.
// Snap to floor on blur so the input reflects what generation receives.
const MIN_WORDS_PER_CHAPTER = 120

function onWordsBlur(num: number) {
  const current = wordOverrides.value[num]
  if (typeof current === 'number' && current > 0 && current < MIN_WORDS_PER_CHAPTER) {
    wordOverrides.value[num] = MIN_WORDS_PER_CHAPTER
  }
}

async function refresh() {
  if (!props.episodeId) {
    chapters.value = []
    return
  }
  loading.value = true
  try {
    const titleParam = props.title ? `?title=${encodeURIComponent(props.title)}` : ''
    const data = await get<{ chapters: ChapterRow[] }>(
      `/projects/${props.projectSlug}/episodes/${props.episodeId}/chapter-list${titleParam}`,
    )
    chapters.value = data.chapters || []
  } catch (e: any) {
    chapters.value = []
    showError(e?.data?.detail || 'Could not load chapters')
  } finally {
    loading.value = false
  }
}

async function loadPreview(num: number, force = false): Promise<void> {
  if (!props.episodeId) return
  // Cache hit: show instantly. Force-refresh skips this for retry.
  if (!force && previewCache.value.has(num)) return
  previewLoading.value.add(num)
  previewErrors.value.delete(num)
  try {
    const titleParam = props.title ? `?title=${encodeURIComponent(props.title)}` : ''
    const data = await get<{ content: string }>(
      `/projects/${props.projectSlug}/episodes/${props.episodeId}/chapters/${num}/content${titleParam}`,
    )
    previewCache.value.set(num, data.content || '(empty chapter)')
    // Trigger Vue reactivity for the Map (set() doesn't auto-trigger
    // on reactive Maps in some cases; bump the ref to force it).
    previewCache.value = new Map(previewCache.value)
  } catch (e: any) {
    const msg = e?.data?.detail || `Could not load chapter ${num}`
    previewErrors.value.set(num, msg)
    previewErrors.value = new Map(previewErrors.value)
  } finally {
    previewLoading.value.delete(num)
    previewLoading.value = new Set(previewLoading.value)
  }
}

function togglePreview(num: number) {
  if (expandedChapters.value.has(num)) {
    expandedChapters.value.delete(num)
  } else {
    expandedChapters.value.add(num)
    void loadPreview(num)
  }
  // Vue 3 tracks Set mutations via the reactivity proxy, but reassigning
  // forces a downstream re-render in cases where deep tracking misses.
  expandedChapters.value = new Set(expandedChapters.value)
}

function clearPreviewCache() {
  // Called on episode switch + on refreshKey bump (regen completion).
  // Keeps the expanded set so the user's chosen "open" rows stay open
  // through a regen — the next render fetches fresh content for each.
  previewCache.value = new Map()
  previewErrors.value = new Map()
  previewLoading.value = new Set()
  // Re-fetch any currently-open chapters so the user sees fresh content
  // immediately after a regen lands (otherwise the drawer would show
  // empty until they collapsed + re-expanded).
  for (const n of expandedChapters.value) {
    void loadPreview(n, /* force */ true)
  }
}

async function regenerate(num: number) {
  if (!props.scriptReady) {
    showError(noScriptTooltip)
    return
  }
  // Per-row words override falls back to the form default. Inline blank
  // = use form default. Inline number = override that single chapter.
  const inlineOverride = wordOverrides.value[num]
  const wordTarget = (typeof inlineOverride === 'number' && Number.isFinite(inlineOverride) && inlineOverride > 0)
    ? Math.round(inlineOverride)
    : props.form?.words_per_chapter
  regenInFlight.value = new Set([...regenInFlight.value, num])
  const payload = {
    episode_id: props.episodeId,
    title: props.title || '',
    chapter_number: num,
    model: props.form?.model,
    style: props.form?.style,
    length: props.form?.length,
    chapters: props.form?.chapters,
    total_words: props.form?.total_words,
    words_per_chapter: wordTarget,
  }
  const operationId = freshChapterAction.begin(payload, `chapter:${num}`)
  try {
    await post(`/projects/${props.projectSlug}/generate/chapter-only`, {
      ...payload,
      operation_id: operationId,
    })
    freshChapterAction.complete(operationId)
    success(inlineOverride
      ? `Chapter ${num} regenerate queued at ${wordTarget} words`
      : `Chapter ${num} regenerate queued`,
    )
  } catch (e: any) {
    showError(e?.data?.detail || "Couldn't confirm the request arrived. Click the same button again — it won't run twice.")
    // Clear THIS chapter's in-flight on error. Success path leaves it set;
    // the relevantJobsSignal watcher clears it when the job lands terminal.
    const next = new Set(regenInFlight.value)
    next.delete(num)
    regenInFlight.value = next
  }
}

// When a chapter-only OR expand_chapters job lands for this episode,
// refresh the list (mtime + word count change). Mounted alongside
// OutlineReviewPanel so cancel + chapter completion both write here.
//
// IMPORTANT: deep-watching the whole jobs array used to fire on every
// output_lines push from a running job — combined with the outline panel's
// own deep watch, that locked the UI thread during chunked expansion.
// We now watch a derived status signal so the callback fires once per
// terminal transition, not once per progress update.
const relevantJobsSignal = computed(() =>
  jobs.value
    .filter(j =>
      j.episode_id === props.episodeId &&
      (j.type === 'chapter-only' || j.type === 'expand_chapters'),
    )
    .map(j => `${j.job_id}:${j.status}`)
    .sort()
    .join('|'),
)
// Each terminal transition is handled ONCE (keyed job:status, like
// scripts.vue's seenDoneJobs), and a change refreshes the list at most once.
// Without this every old finished job re-ran refresh() on every change, and an
// old done job for chapter N cleared the flag of a NEW chapter-N regen.
// Seeded with what was already finished when the panel opened.
const terminalKey = (job: { job_id: string; status: string }) => `${job.job_id}:${job.status}`
const isTerminal = (status: string) => status === 'done' || status === 'error' || status === 'cancelled'
const handledTerminalJobs = new Set(jobs.value.filter(j => isTerminal(j.status)).map(terminalKey))
watch(relevantJobsSignal, () => {
  let landed = false
  for (const job of jobs.value) {
    if (job.episode_id !== props.episodeId) continue
    if (job.type !== 'chapter-only' && job.type !== 'expand_chapters') continue
    if (!isTerminal(job.status) || handledTerminalJobs.has(terminalKey(job))) continue
    handledTerminalJobs.add(terminalKey(job))
    // chapter-only carries the chapter number in params — use it to clear
    // ONLY that chapter's in-flight flag. Siblings still queued/running
    // stay flagged. expand_chapters has no chapter number; we only refresh
    // for it.
    const jobChapter = job.type === 'chapter-only' ? Number(job.params?.chapter_number) : NaN
    const wasInFlight = Number.isFinite(jobChapter) && regenInFlight.value.has(jobChapter)
    if (wasInFlight) {
      const next = new Set(regenInFlight.value)
      next.delete(jobChapter)
      regenInFlight.value = next
    }
    if (job.status === 'done') landed = true
    else if (job.status === 'error' && wasInFlight) {
      showError(`Chapter ${jobChapter} regenerate failed — see the Jobs tab.`)
    }
  }
  if (landed) {
    clearPreviewCache()
    void refresh()
  }
})

// Declared BEFORE the immediate watcher below — `watch(..., { immediate: true })`
// fires the handler synchronously during setup, so `lastEpisodeId` must be
// initialised first. Hitting the TDZ here threw "Cannot access 'lastEpisodeId'
// before initialization" mid-setup, which left ChapterListPanel half-mounted
// and propagated up the tree as the "Cannot read properties of null (reading
// 'parentNode')" freeze on the next navigation/render of scripts.vue.
const lastEpisodeId = ref<string | undefined>(undefined)

watch(() => [props.episodeId, props.title, props.refreshKey], () => {
  // Clear per-row word overrides AND collapse + clear preview cache on
  // episode switch — the previous episode's state doesn't apply to the
  // new one. Refresh-key bumps (job-completion ticks) keep wordOverrides
  // since the user is still on the same episode, but DO clear the
  // preview cache (chapter content just changed on disk).
  if (props.episodeId !== lastEpisodeId.value) {
    wordOverrides.value = {}
    expandedChapters.value = new Set()
    lastEpisodeId.value = props.episodeId
  }
  clearPreviewCache()
  refresh()
}, { immediate: true })

function relativeTime(iso: string): string {
  const d = new Date(iso)
  const diff = (Date.now() - d.getTime()) / 1000
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return d.toLocaleDateString()
}
</script>

<style scoped>
.chapter-panel {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 14px 16px;
  margin-top: 16px;
}

.chp-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.chp-header h3 { margin: 0; font-size: 14px; color: var(--text-primary); }
.chp-actions { display: inline-flex; gap: 4px; }

.chp-empty {
  color: var(--text-muted);
  font-size: 13px;
  padding: 14px 4px;
  text-align: center;
}

.chp-list {
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-primary);
  overflow: hidden;
}
.chp-item {
  border-bottom: 1px solid var(--border);
}
.chp-item:last-child { border-bottom: none; }
.chp-item.has-stale-audio { background: rgba(245, 158, 11, 0.04); }

.chp-row {
  display: grid;
  grid-template-columns: auto 1fr auto auto auto;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  font-size: 13px;
}
.chp-expand {
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  color: var(--text-secondary);
  padding: 4px 10px;
  height: 28px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
  white-space: nowrap;
}
.chp-expand-icon {
  font-size: var(--font-xs);
  line-height: 1;
}
.chp-expand-label {
  font-size: var(--font-xs);
  letter-spacing: 0.2px;
}
.chp-expand:hover {
  background: var(--bg-secondary);
  border-color: var(--border-light);
  color: var(--text-primary);
}
.chp-item.is-expanded .chp-expand {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-dim);
}
.chp-words-input {
  width: 90px;
  text-align: right;
  font-size: 12px;
  padding: 4px 8px;
}

/* Inline preview drawer — lazy-loaded chapter content rendered as
   read-only prose. Visually offset from the row so it reads as a
   "child" of that chapter, not a separate row. */
.chp-preview {
  padding: 0 14px 14px 14px;
  background: var(--bg-secondary);
  border-top: 1px solid var(--border);
}
.chp-preview-status,
.chp-preview-error {
  padding: 12px 0;
  font-size: 12px;
  color: var(--text-muted);
  font-style: italic;
}
.chp-preview-error {
  color: rgb(220, 100, 100);
  display: flex;
  align-items: center;
  gap: 10px;
}
.chp-preview-content {
  margin: 12px 0 0 0;
  padding: 12px 14px;
  background: var(--bg-primary);
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
.chp-meta {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.chp-num { color: var(--text-primary); font-weight: 600; }
.chp-title {
  color: var(--text-secondary);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.chp-stats {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.chp-pill {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: var(--font-xs);
  background: var(--bg-tertiary);
  color: var(--text-muted);
  border: 1px solid var(--border);
  white-space: nowrap;
}
.chp-pill.pill-stale {
  background: rgba(234, 179, 8, 0.14);
  color: rgb(202, 138, 4);
  border-color: rgba(234, 179, 8, 0.3);
}

.chp-regen {
  white-space: nowrap;
}
</style>
