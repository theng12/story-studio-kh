<!--
  Production Board (v1.0.341) — episodes × pipeline-steps status matrix.

  The app is otherwise tool-centric (you navigate to "Scripts", "Audio").
  Production thinking is episode-centric ("where is EP0042?"). This board is
  the missing overview: one row per episode, one column per pipeline step,
  each cell a status chip (✓ done · ✓̣ manual · ○ pending · 🔄 generating).
  Click any cell to jump to that step's page for that episode.

  - Columns come from flowForVisualSource() — the SAME format-aware step list
    that drives the sidebar + flow ribbon, so the board never drifts from the
    real nav. Only steps with a detectable per-episode status are shown.
  - Status is read straight off the shared /episodes data (useEpisodes), so it
    reflects file-detection AND manual mark-done overrides, and costs no extra
    backend work. Built to stay smooth at 300+ episodes (CSS row virtualization
    + the request coalescing / single-walk index added in v1.0.337).
-->
<template>
  <div class="board">
    <header class="board-head">
      <div class="board-title">
        <h1>Production Board</h1>
        <span v-if="!loading" class="board-count">
          <template v-if="searchActive || hidePending">{{ visibleEpisodes.length }} of {{ episodes.length }} shown</template>
          <template v-else>{{ episodes.length }} episode{{ episodes.length === 1 ? '' : 's' }}</template>
        </span>
        <span v-else class="board-count">Loading…</span>
      </div>

      <div class="board-tools">
        <div class="board-search">
          <span class="board-search-icon" aria-hidden="true">🔎</span>
          <input
            v-model="search"
            class="input board-search-input"
            type="search"
            placeholder="Search code or title…"
            @keydown.esc.prevent="search = ''"
          />
        </div>
        <button
          type="button"
          class="board-filter"
          :class="{ active: hidePending }"
          title="Hide episodes whose steps are all done — focus on what still needs work."
          @click="hidePending = !hidePending"
        >
          {{ hidePending ? '◉' : '○' }} Needs work only
        </button>
        <button
          type="button"
          class="board-filter"
          :disabled="loading || isRevalidating"
          title="Re-read every episode's status from disk."
          @click="refresh()"
        >
          {{ loading || isRevalidating ? '…' : '↻' }} Refresh
        </button>
      </div>
    </header>

    <!-- Loading (cold) -->
    <div v-if="loading && !episodes.length" class="board-empty">
      <LoadingSpinner size="md" />
      <p>Reading episode status…</p>
    </div>

    <!-- Empty -->
    <div v-else-if="!episodes.length" class="board-empty">
      <p class="board-empty-title">No episodes yet</p>
      <p class="text-muted">Accept some ideas in the Ideas Generator and they'll show up here, step by step.</p>
      <NuxtLink :to="`/projects/${slug}/ideas`" class="btn btn-primary">Go to Ideas</NuxtLink>
    </div>

    <!-- No match after filter -->
    <div v-else-if="!visibleEpisodes.length" class="board-empty">
      <p class="board-empty-title">Nothing matches</p>
      <p class="text-muted">
        <template v-if="hidePending">Every shown episode is fully done. </template>
        <template v-if="searchActive">No episode matches "{{ search }}". </template>
        Clear the filters to see all {{ episodes.length }}.
      </p>
      <button class="btn btn-secondary" @click="search = ''; hidePending = false">Clear filters</button>
    </div>

    <!-- The matrix -->
    <div v-else class="board-scroll">
      <table class="board-grid">
        <thead>
          <tr>
            <th class="col-ep sticky-col sticky-head">Episode</th>
            <th
              v-for="col in columns"
              :key="col.key"
              class="col-step sticky-head"
              :title="col.label"
            >
              <div class="step-h">
                <span class="step-h-icon">{{ col.icon }}</span>
                <span class="step-h-label">{{ col.label }}</span>
                <span class="step-h-count">{{ doneCount(col) }}/{{ episodes.length }}</span>
              </div>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="ep in visibleEpisodes" :key="ep.episode_code" class="board-row">
            <th class="col-ep sticky-col">
              <div class="ep-cell">
                <span class="ep-code">
                  {{ ep.episode_code }}
                  <span v-if="isGenerating(ep.episode_code)" class="ep-busy" title="A job is running for this episode">🔄</span>
                  <span v-if="ep.marked_done" class="ep-donepill" title="Whole episode marked done">done</span>
                </span>
                <span class="ep-title" :title="ep.title">{{ ep.title }}</span>
              </div>
            </th>
            <td
              v-for="col in columns"
              :key="col.key"
              class="col-step"
            >
              <NuxtLink
                :to="routeFor(col, ep.episode_code)"
                class="cell"
                :class="cellClass(ep, col)"
                :title="cellTitle(ep, col)"
              >
                {{ cellMark(ep, col) }}
              </NuxtLink>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="episodes.length" class="board-legend">
      <span><b class="lg-done">✓</b> done (detected)</span>
      <span><b class="lg-manual">✓</b> marked done by hand</span>
      <span><b class="lg-pending">○</b> pending</span>
      <span>🔄 generating now</span>
      <span class="board-legend-hint">· click any cell to open that step for that episode</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { normalizeVisualSource, flowForVisualSource, type FlowStep, type VisualSource } from '~/composables/useProjectFlow'

definePageMeta({ layout: 'dashboard' })
useAppTitle('Production Board')

const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { get } = useApi()

const { episodes, isLoading: loading, isRevalidating, refresh } = useEpisodes(slug)
const { jobs } = useJobs()

// ── Format-aware columns ──────────────────────────────────────────────────
// Map each flow step to the per-episode status field it reports on. Steps
// without a detectable per-episode status (Ideas — implicit; Subtitles +
// Character Sheet — no per-episode signal) are intentionally omitted so every
// cell is a real, meaningful status.
const STEP_FIELD: Record<string, string> = {
  research: 'research',
  script: 'script',
  metadata: 'metadata',
  'thumb-prompts': 'thumb_prompts',
  'scene-prompts': 'scene_prompts',
  thumbnails: 'thumbnails',
  scenes: 'images',
  audio: 'audio',
  'audio-merge': 'merged_audio',
  'scene-plan': 'scene_plan',
  'scene-review': 'scene_review',
  'video-assembly': 'video_assembly',
  'timestamp-assemble': 'video_assembly',
}

interface BoardCol extends FlowStep { field: string }

const visualSource = ref<VisualSource>('scene-images')
async function loadVisualSource() {
  if (!slug.value) return
  try {
    const f = await get<{ visualSource?: string; sceneAlignment?: string }>(`/projects/${slug.value}/effective-format`)
    visualSource.value = normalizeVisualSource(f?.visualSource, f?.sceneAlignment)
  } catch { /* keep default */ }
}
watch(slug, loadVisualSource, { immediate: true })

const columns = computed<BoardCol[]>(() =>
  flowForVisualSource(visualSource.value)
    .filter(s => STEP_FIELD[s.key])
    .map(s => ({ ...s, field: STEP_FIELD[s.key] })))

// ── Filtering ─────────────────────────────────────────────────────────────
const search = ref('')
const hidePending = ref(false)
const searchActive = computed(() => search.value.trim().length > 0)

const visibleEpisodes = computed(() => {
  let list = episodes.value
  if (hidePending.value) list = list.filter(ep => !isFullyDone(ep))
  if (searchActive.value) {
    const q = search.value.trim().toLowerCase()
    list = list.filter(ep =>
      (ep.episode_code || '').toLowerCase().includes(q) ||
      (ep.title || '').toLowerCase().includes(q))
  }
  return [...list].sort((a, b) => a.episode_code.localeCompare(b.episode_code))
})

/** Fully done = every SHOWN column's step is done for this episode. */
function isFullyDone(ep: any): boolean {
  return columns.value.every(col => ep.status?.[col.field] === true)
}

// ── Active jobs (row-level 🔄) ─────────────────────────────────────────────
const generatingCodes = computed(() => {
  const out = new Set<string>()
  for (const job of jobs.value || []) {
    if ((job.status === 'queued' || job.status === 'running') && job.episode_id) {
      out.add(job.episode_id)
    }
  }
  return out
})
function isGenerating(code: string): boolean {
  return generatingCodes.value.has(code)
}

// ── Cell rendering ──────────────────────────────────────────────────────────
function isManual(ep: any, field: string): boolean {
  const o = ep.status_overrides
  return !!o && typeof o === 'object' && o[field] !== undefined
}
function cellClass(ep: any, col: BoardCol): Record<string, boolean> {
  const done = ep.status?.[col.field] === true
  return {
    'cell-done': done,
    'cell-pending': !done,
    'cell-manual': isManual(ep, col.field),
  }
}
function cellMark(ep: any, col: BoardCol): string {
  return ep.status?.[col.field] === true ? '✓' : '○'
}
function cellTitle(ep: any, col: BoardCol): string {
  const done = ep.status?.[col.field] === true
  const manual = isManual(ep, col.field)
  const state = done
    ? (manual ? 'done (marked by hand)' : 'done')
    : 'pending'
  return `${ep.episode_code} · ${col.label}: ${state} — click to open`
}
function doneCount(col: BoardCol): number {
  return episodes.value.filter(ep => ep.status?.[col.field] === true).length
}

/** Route to a step's page for one episode (mirrors useProjectFlow.routeFor,
 *  plus episode preselect). */
function routeFor(col: BoardCol, code: string): string {
  const base = `/projects/${slug.value}${col.path}`
  const params = new URLSearchParams()
  if (col.tab) params.set('tab', col.tab)
  params.set('episode_id', code)
  return `${base}?${params.toString()}`
}
</script>

<style scoped>
.board {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.board-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}
.board-title {
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.board-title h1 {
  margin: 0;
  font-size: 20px;
}
.board-count {
  font-size: 12px;
  color: var(--text-muted);
}
.board-tools {
  display: flex;
  align-items: center;
  gap: 8px;
}
.board-search {
  position: relative;
  display: flex;
  align-items: center;
}
.board-search-icon {
  position: absolute;
  left: 8px;
  font-size: 12px;
  pointer-events: none;
  opacity: 0.7;
}
.board-search-input {
  padding: 6px 10px 6px 26px;
  font-size: 12px;
  width: 200px;
}
.board-filter {
  padding: 6px 10px;
  font-size: 12px;
  font-family: inherit;
  border: 1px solid var(--border);
  background: var(--bg-tertiary);
  color: var(--text-muted);
  border-radius: 6px;
  cursor: pointer;
  white-space: nowrap;
}
.board-filter:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-primary); }
.board-filter.active { background: var(--accent); color: #0f1117; border-color: var(--accent); }
.board-filter:disabled { opacity: 0.5; cursor: not-allowed; }

/* ── Empty / loading ── */
.board-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 60px 20px;
  text-align: center;
}
.board-empty-title { font-size: 16px; font-weight: 600; margin: 0; }

/* ── Grid ── */
.board-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
}
.board-grid {
  border-collapse: separate;
  border-spacing: 0;
  font-size: 12px;
  width: max-content;
  min-width: 100%;
}
.board-grid th,
.board-grid td {
  border-bottom: 1px solid var(--border);
  border-right: 1px solid var(--border);
}
.sticky-head {
  position: sticky;
  top: 0;
  z-index: 2;
  background: var(--bg-secondary);
}
.sticky-col {
  position: sticky;
  left: 0;
  z-index: 1;
  background: var(--bg-secondary);
}
.sticky-head.sticky-col { z-index: 3; }

.col-ep {
  text-align: left;
  min-width: 230px;
  max-width: 300px;
  padding: 8px 12px;
}
.col-step {
  text-align: center;
  padding: 0;
  min-width: 84px;
}
.step-h {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  padding: 6px 8px;
}
.step-h-icon { font-size: 13px; }
.step-h-label { font-size: 10px; line-height: 1.1; color: var(--text-primary); text-align: center; }
.step-h-count { font-size: 9px; color: var(--text-muted); }

/* Cheap virtualization: skip layout/paint for off-screen rows. The fixed
   intrinsic height keeps the scrollbar accurate without windowing JS. */
.board-row {
  content-visibility: auto;
  contain-intrinsic-size: 0 38px;
}

.ep-cell { display: flex; flex-direction: column; gap: 1px; }
.ep-code {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.ep-busy { font-size: 11px; }
.ep-donepill {
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--success, #22c55e);
  border: 1px solid color-mix(in srgb, var(--success, #22c55e) 45%, transparent);
  border-radius: 4px;
  padding: 0 4px;
}
.ep-title {
  font-size: 11px;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 280px;
}

.cell {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 38px;
  width: 100%;
  font-size: 13px;
  text-decoration: none;
  color: var(--text-muted);
  transition: background 0.12s;
}
.cell:hover { background: var(--bg-hover); }
.cell-done { color: var(--success, #22c55e); }
.cell-pending { color: var(--text-muted); opacity: 0.55; }
/* Manual override — dashed underline ring echoes the EpisodeSelector chips. */
.cell-manual {
  text-decoration: underline dashed;
  text-underline-offset: 3px;
}

.board-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  align-items: center;
  padding: 8px 2px 0;
  font-size: 11px;
  color: var(--text-muted);
}
.board-legend b { font-style: normal; }
.lg-done { color: var(--success, #22c55e); }
.lg-manual { color: var(--success, #22c55e); text-decoration: underline dashed; text-underline-offset: 2px; }
.lg-pending { opacity: 0.55; }
.board-legend-hint { opacity: 0.8; }
</style>
