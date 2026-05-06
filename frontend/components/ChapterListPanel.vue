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
      Regenerate any chapter individually. The unified narration
      downstream tools read is auto-rebuilt after each regen.
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
        :class="{ 'has-stale-audio': ch.audio_stale }"
      >
        <div class="chp-row">
          <div class="chp-meta">
            <strong class="chp-num">Chapter {{ String(ch.number).padStart(2, '0') }}</strong>
            <span class="chp-title">{{ ch.title }}</span>
          </div>
          <div class="chp-stats">
            <span v-if="ch.word_count" class="chp-pill">{{ ch.word_count.toLocaleString() }} words</span>
            <span v-if="ch.modified_at" class="chp-pill">{{ relativeTime(ch.modified_at) }}</span>
            <span v-if="ch.audio_stale" class="chp-pill pill-stale" :title="staleTooltip">
              ⚠ audio stale
            </span>
          </div>
          <input
            class="input chp-words-input"
            type="number"
            min="100"
            step="50"
            v-model.number="wordOverrides[ch.number]"
            :placeholder="`${form?.words_per_chapter || 500}`"
            title="Per-chapter word target for this regen. Leave blank to use the form default. Listicle outline overrides flow through automatically."
          />
          <button
            class="btn btn-sm btn-secondary chp-regen"
            :disabled="!scriptReady || regenInFlight === ch.number || regenInFlight !== null"
            :title="!scriptReady ? noScriptTooltip : 'Regenerate this chapter only'"
            @click="regenerate(ch.number)"
          >
            <LoadingSpinner v-if="regenInFlight === ch.number" size="sm" />
            {{ regenInFlight === ch.number ? 'Regenerating…' : '↻ Regenerate' }}
          </button>
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
const { jobs } = useJobs()
const { success, error: showError } = useToast()

const chapters = ref<ChapterRow[]>([])
const loading = ref(false)
const regenInFlight = ref<number | null>(null)
// Per-chapter words_per_chapter overrides — populated from the form's
// global default and overridden by the user inline. Sent on the regen
// request so a single chapter can be re-rolled at a different length.
// Cleared on episode switch.
const wordOverrides = ref<Record<number, number | undefined>>({})
const noScriptTooltip = 'Generate the script first to unlock per-chapter regenerate.'
const staleTooltip = 'This chapter\'s source was changed after the audio was generated. Visit the Audio page and regenerate this section to refresh.'

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
  regenInFlight.value = num
  try {
    await post(`/projects/${props.projectSlug}/generate/chapter-only`, {
      episode_id: props.episodeId,
      title: props.title || '',
      chapter_number: num,
      model: props.form?.model,
      style: props.form?.style,
      length: props.form?.length,
      chapters: props.form?.chapters,
      total_words: props.form?.total_words,
      words_per_chapter: wordTarget,
    })
    success(inlineOverride
      ? `Chapter ${num} regenerate queued at ${wordTarget} words`
      : `Chapter ${num} regenerate queued`,
    )
  } catch (e: any) {
    showError(e?.data?.detail || `Failed to queue chapter ${num} regen`)
    regenInFlight.value = null
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
watch(relevantJobsSignal, () => {
  // Cheap path: just walk the current jobs and act on terminal states.
  // The signal-based watch only fires when something transitions, so
  // this is at most a handful of iterations per real event.
  for (const job of jobs.value) {
    if (job.episode_id !== props.episodeId) continue
    const isRelevant = job.type === 'chapter-only' || job.type === 'expand_chapters'
    if (!isRelevant) continue
    if (job.status === 'done') {
      // chapter-only fires the in-flight tracker reset; expand_chapters
      // refresh applies regardless of whether a per-chapter regen was
      // running.
      if (job.type === 'chapter-only' && regenInFlight.value !== null) {
        regenInFlight.value = null
      }
      void refresh()
    } else if (job.status === 'error' && job.type === 'chapter-only' && regenInFlight.value !== null) {
      regenInFlight.value = null
      showError('Chapter regenerate failed — see Jobs tab.')
    }
  }
})

watch(() => [props.episodeId, props.title, props.refreshKey], () => {
  // Clear per-row word overrides on episode switch — the previous
  // episode's overrides don't apply to the new one. Refresh-key bumps
  // (job-completion ticks) keep them since the user is still on the
  // same episode and may want to retry with the same custom length.
  if (props.episodeId !== lastEpisodeId.value) {
    wordOverrides.value = {}
    lastEpisodeId.value = props.episodeId
  }
  refresh()
}, { immediate: true })

const lastEpisodeId = ref<string | undefined>(undefined)

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
  grid-template-columns: 1fr auto auto auto;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  font-size: 13px;
}
.chp-words-input {
  width: 90px;
  text-align: right;
  font-size: 12px;
  padding: 4px 8px;
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
  font-size: 11px;
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
