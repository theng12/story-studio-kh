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
  <div class="board workspace-page">
    <WorkspaceHero
      eyebrow="Episode control room"
      title="Production Board"
      description="See every episode against the same verified completion rules, then open, repair, or mark imported work from one place."
    >
      <template #aside>
        <div class="workspace-metrics">
          <span class="workspace-metric"><strong>{{ episodes.length }}</strong> episodes</span>
          <span class="workspace-metric"><strong>{{ columns.length }}</strong> tracked stages</span>
          <span v-if="searchActive || needsWorkOnly || stepFilter" class="workspace-metric" data-tone="info">
            <strong>{{ visibleEpisodes.length }}</strong> shown
          </span>
        </div>
      </template>
    </WorkspaceHero>

    <div class="workspace-command-surface board-command-surface">
      <div class="board-tools">
        <!-- Click-mode switch: Open (jump to the step) vs Mark done (toggle a
             manual override for imported-from-elsewhere steps). -->
        <div class="board-mode" role="group" aria-label="Cell click action">
          <button
            type="button"
            class="board-mode-btn"
            :class="{ active: mode === 'open' }"
            title="Click a cell to open that step for that episode."
            @click="mode = 'open'"
          >↗ Open</button>
          <button
            type="button"
            class="board-mode-btn"
            :class="{ active: mode === 'mark' }"
            title="Click a pending cell to mark it done by hand (for results you imported from outside the app). Click a hand-marked cell to undo."
            @click="mode = 'mark'"
          >✓ Mark done</button>
        </div>
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
          :class="{ active: needsWorkOnly }"
          title="Hide episodes whose steps are all done — focus on what still needs work."
          @click="needsWorkOnly = !needsWorkOnly"
        >
          {{ needsWorkOnly ? '◉' : '○' }} Needs work only
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
        <!-- v1.0.481 — Repair moved here from the retired Assets tab. Re-pulls
             provider-completed jobs (images/video/audio) that finished on the
             provider but never persisted locally. No credits consumed. -->
        <button
          type="button"
          class="board-filter"
          title="Re-download provider-completed images/video/audio that didn't persist locally (crash, network blip, timeout). Reads provider history — no credits consumed."
          @click="repairOpen = true"
        >
          ↻ Repair…
        </button>
      </div>
      <button
        v-if="stepFilter && stepFilterCol"
        type="button"
        class="board-stepfilter-chip"
        title="Clear this step filter"
        @click="stepFilter = null"
      >Needs {{ stepFilterCol.label }} ✕</button>
      <div v-if="visibleEpisodes.length" class="board-pagination" aria-label="Episode pages">
        <span class="board-page-range">{{ visibleRangeText }}</span>
        <button
          type="button"
          class="board-page-btn board-page-edge"
          :disabled="currentPage <= 1"
          title="First page"
          aria-label="First page"
          @click="goToPage(1)"
        >«</button>
        <button
          type="button"
          class="board-page-btn"
          :disabled="currentPage <= 1"
          @click="goToPage(currentPage - 1)"
        >Prev</button>
        <span class="board-page-indicator">
          Page <strong>{{ currentPage }}</strong> of {{ totalPages }}
        </span>
        <button
          type="button"
          class="board-page-btn"
          :disabled="currentPage >= totalPages"
          @click="goToPage(currentPage + 1)"
        >Next</button>
        <button
          type="button"
          class="board-page-btn board-page-edge"
          :disabled="currentPage >= totalPages"
          title="Last page"
          aria-label="Last page"
          @click="goToPage(totalPages)"
        >»</button>
      </div>
    </div>

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
        <template v-if="stepFilter && stepFilterCol">Every episode has {{ stepFilterCol.label }} done. </template>
        <template v-if="needsWorkOnly">Every episode is fully done. </template>
        <template v-if="searchActive">No episode matches "{{ search }}". </template>
        Clear the filters to see all {{ episodes.length }}.
      </p>
      <button class="btn btn-secondary" @click="search = ''; needsWorkOnly = false; stepFilter = null">Show all episodes</button>
    </div>

    <!-- The matrix -->
    <div v-else class="board-scroll">
      <table class="board-grid">
        <thead>
          <tr class="board-phase-row">
            <th class="col-ep sticky-col phase-head" rowspan="2">Episode</th>
            <th
              v-for="phase in columnPhases"
              :key="phase.key"
              class="phase-head"
              :colspan="phase.count"
            >
              {{ phase.label }}
            </th>
          </tr>
          <tr>
            <th
              v-for="col in columns"
              :key="col.key"
              class="col-step sticky-head stage-head"
            >
              <button
                type="button"
                class="step-h"
                :class="{ 'step-h-active': stepFilter === col.field }"
                :title="stepFilter === col.field
                  ? `Showing only episodes that still need ${col.label} — click to clear`
                  : `Show only episodes that still need ${col.label}`"
                @click="toggleStepFilter(col.field)"
              >
                <span class="step-h-icon">{{ col.icon }}</span>
                <span class="step-h-label">{{ col.label }}</span>
                <span v-if="col.optional" class="step-h-optional">optional</span>
                <span class="step-h-count">{{ doneCount(col) }}/{{ episodes.length }}</span>
              </button>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="ep in paginatedEpisodes" :key="ep.episode_code" class="board-row">
            <th class="col-ep sticky-col">
              <div class="ep-cell">
                <div class="ep-cell-text">
                  <span class="ep-code">
                    {{ ep.episode_code }}
                    <span v-if="isGenerating(ep.episode_code)" class="ep-busy" title="A job is running for this episode">🔄</span>
                    <span v-if="ep.marked_done" class="ep-donepill" title="Whole episode marked done">done</span>
                  </span>
                  <span class="ep-title" :title="ep.title">{{ ep.title }}</span>
                </div>
                <button
                  type="button"
                  class="ep-import"
                  :title="`Import a finished file for ${ep.episode_code} (audio, thumbnail, final video…) — it lands with the right name and flips the step done.`"
                  :aria-label="`Import a finished file for ${ep.episode_code}`"
                  @click="openImport(ep)"
                >⬆</button>
              </div>
            </th>
            <td
              v-for="col in columns"
              :key="col.key"
              class="col-step"
            >
              <NuxtLink
                v-if="mode === 'open'"
                :to="routeFor(col, ep.episode_code)"
                class="cell"
                :class="cellClass(ep, col)"
                :title="cellTitle(ep, col)"
                :aria-label="cellTitle(ep, col)"
              >
                {{ cellMark(ep, col) }}
              </NuxtLink>
              <button
                v-else
                type="button"
                class="cell cell-btn"
                :class="[cellClass(ep, col), { 'cell-loading': cellBusy(ep, col) }]"
                :disabled="cellBusy(ep, col)"
                :title="markTitle(ep, col)"
                :aria-label="markTitle(ep, col)"
                @click="markCell(ep, col)"
              >
                {{ cellBusy(ep, col) ? '·' : cellMark(ep, col) }}
              </button>
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
      <span class="board-legend-hint">
        · <template v-if="mode === 'open'">click any cell to open that step for that episode</template>
        <template v-else>click a pending cell to mark it done by hand · click a hand-marked one to undo</template>
        · ⬆ on a row imports a finished file for that episode
      </span>
    </div>

    <!-- One shared import dialog, scoped to whichever row's ⬆ was clicked. The
         dialog POSTs straight to /import-assets (no project-wide scan); on
         success the backend invalidates that episode's status cache, so we
         just revalidate to flip the step done. -->
    <AssetImportDialog
      v-if="importEp"
      :visible="true"
      :slug="slug"
      :episode-code="importEp.episode_code"
      :chapter-count="importEp.suggested_chapters"
      @close="importEp = null"
      @imported="onImported"
    />

    <!-- Repair dialog — re-pulls provider-completed jobs that didn't persist
         locally. Relocated here when the per-project Assets tab was retired
         (v1.0.481). Lazily scans on open; refresh the board after closing so
         any recovered files flip their step done. -->
    <RepairAssetsDialog
      v-if="repairOpen"
      :visible="true"
      :slug="slug"
      :episode-codes="repairEpisodes"
      @close="onRepairClosed"
    />
  </div>
</template>

<script setup lang="ts">
import { FLOW_PHASES, normalizeVisualSource, flowForVisualSource, type FlowStep, type VisualSource } from '~/composables/useProjectFlow'
import AssetImportDialog from '~/components/AssetImportDialog.vue'
import RepairAssetsDialog from '~/components/RepairAssetsDialog.vue'

definePageMeta({ layout: 'dashboard' })
useAppTitle('Production Board')

const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { get, patch } = useApi()
const { success, error: showError, info: showInfo } = useToast()

const {
  episodes,
  isLoading: loading,
  isRevalidating,
  refresh,
  revalidate,
  revalidateAfterMutation,
  updateEpisode,
} = useEpisodes(slug)
const { jobs } = useJobs()

// Cell-click mode. 'open' (default) = navigate to the step page; 'mark' =
// toggle a manual done override (for steps whose result you imported from
// outside the app, so file-detection never flips them done).
const mode = ref<'open' | 'mark'>('open')
const busyCell = ref('') // `${code}:${field}` while a PATCH is in flight
const importEp = ref<any | null>(null) // episode row whose import dialog is open
// Repair dialog (re-pull provider-completed jobs). Auto-opens when the board
// is reached via ?repair=1 — the entry point used by the dashboard + Jobs
// "Repair" CTAs that previously deep-linked to the retired Assets tab.
const repairOpen = ref(route.query.repair === '1')
// v1.2.8 — `?repair=1&episode=EP0053` scopes the same dialog to one episode.
// That is the targeted-recovery entry point used from a failed job's own row,
// where the episode is already known and scanning the whole library is waste.
// The board's own "↻ Repair…" button leaves this empty and still searches
// everything, which is what it is for.
//
// v1.4.43 — `episode` is repeatable, so the batch-finished banner can hand
// over every episode that actually failed instead of triggering a full scan
// to reach episodes it could already name.
const repairEpisodes = ref(queryEpisodes())
function queryEpisodes(): string[] {
  const raw = route.query.episode
  const list = Array.isArray(raw) ? raw : [raw]
  return list.filter((code): code is string => typeof code === 'string' && !!code.trim()).map(code => code.trim())
}

function openImport(ep: any) { importEp.value = ep }

// After closing Repair, re-read status from disk — any recovered file should
// flip its step done on the board.
function onRepairClosed() {
  repairOpen.value = false
  repairEpisodes.value = []
  void revalidate()
}
function onImported() {
  // Backend invalidated this episode's status cache on import; pull the fresh
  // status so the relevant step flips done. Dialog stays open for staging more.
  void revalidate()
}

// ── Format-aware columns ──────────────────────────────────────────────────
// Map each flow step to the per-episode status field it reports on. Steps
// without a detectable per-episode status (Ideas — implicit; Subtitles +
// Character Sheet — no per-episode signal) are intentionally omitted so every
// cell is a real, meaningful status.
//
const STEP_FIELD: Record<string, string> = {
  research: 'research',
  // v1.4.73 — `status.introduction` has been returned per episode all along
  // and rendered nowhere: no badge, no count, no filter. That is how four
  // episodes reached paid audio with no opening without anyone noticing. It
  // is a column now, and because the Introduction step is optional it never
  // blocks an episode from reading as done.
  introduction: 'introduction',
  script: 'script',
  metadata: 'metadata',
  'thumb-prompts': 'thumb_prompts',
  thumbnails: 'thumbnails',
  scenes: 'images',
  audio: 'audio',
  'audio-merge': 'merged_audio',
  subtitles: 'subtitles',
  'character-sheet': 'character_sheet',
  'scene-plan': 'scene_plan',
  'scene-review': 'scene_review',
  'motion-review': 'motion_review',
  'video-assembly': 'video_assembly',
}

interface BoardCol extends FlowStep { field: string }

const visualSource = ref<VisualSource>('narrated-scenes')
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
    .filter(s => !!STEP_FIELD[s.key])
    .map(s => ({ ...s, field: STEP_FIELD[s.key] })))
const columnPhases = computed(() => FLOW_PHASES.map(phase => ({
  ...phase,
  count: columns.value.filter(column => column.phase === phase.key).length,
})).filter(phase => phase.count > 0))
const requiredColumnFields = computed(() =>
  columns.value.filter(col => !col.optional).map(col => col.field))
const columnDoneCounts = computed(() => {
  const counts: Record<string, number> = {}
  for (const col of columns.value) counts[col.field] = 0
  for (const ep of episodes.value) {
    for (const field of Object.keys(counts)) {
      if (ep.status?.[field] === true) counts[field]++
    }
  }
  return counts
})

// ── Filtering ─────────────────────────────────────────────────────────────
const search = ref('')
// Production Board is an exception dashboard: completed episodes are hidden
// until the user explicitly asks to see the full archive.
const needsWorkOnly = ref(true)
// Click a column header to show only episodes still pending THAT step
// ("who needs Audio?"). Null = no per-step filter.
const stepFilter = ref<string | null>(null)
const searchActive = computed(() => search.value.trim().length > 0)
const stepFilterCol = computed(() => columns.value.find(c => c.field === stepFilter.value) || null)
const EPISODES_PER_PAGE = 10
const currentPage = ref(1)

function toggleStepFilter(field: string) {
  stepFilter.value = stepFilter.value === field ? null : field
}
// If a format change drops the filtered column, clear the stale filter.
watch(columns, cols => {
  if (stepFilter.value && !cols.some(c => c.field === stepFilter.value)) stepFilter.value = null
})

const visibleEpisodes = computed(() => {
  let list = episodes.value
  if (stepFilter.value) list = list.filter(ep => ep.status?.[stepFilter.value!] !== true)
  if (needsWorkOnly.value) list = list.filter(ep => !isFullyDone(ep))
  if (searchActive.value) {
    const q = search.value.trim().toLowerCase()
    list = list.filter(ep =>
      (ep.episode_code || '').toLowerCase().includes(q) ||
      (ep.title || '').toLowerCase().includes(q))
  }
  return [...list].sort((a, b) => a.episode_code.localeCompare(b.episode_code))
})

const totalPages = computed(() =>
  Math.max(1, Math.ceil(visibleEpisodes.value.length / EPISODES_PER_PAGE)))

const paginatedEpisodes = computed(() => {
  const start = (currentPage.value - 1) * EPISODES_PER_PAGE
  return visibleEpisodes.value.slice(start, start + EPISODES_PER_PAGE)
})

const visibleRangeText = computed(() => {
  const total = visibleEpisodes.value.length
  if (!total) return '0 of 0'
  const start = (currentPage.value - 1) * EPISODES_PER_PAGE + 1
  const end = Math.min(total, currentPage.value * EPISODES_PER_PAGE)
  return `Showing ${start}–${end} of ${total}`
})

function goToPage(page: number) {
  currentPage.value = Math.max(1, Math.min(totalPages.value, Math.floor(page)))
}

// Filtering can shrink the result set substantially. Always return to a real
// page instead of leaving the board on an empty slice.
watch([search, needsWorkOnly, stepFilter], () => { currentPage.value = 1 })
watch(totalPages, pages => {
  if (currentPage.value > pages) currentPage.value = pages
})

/** Fully done = every required SHOWN column's step is done. Optional columns
 * remain visible and filterable, but never keep an episode in Needs work. */
function isFullyDone(ep: any): boolean {
  return requiredColumnFields.value.every(field => ep.status?.[field] === true)
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
    'cell-optional': col.optional === true,
  }
}
function cellMark(ep: any, col: BoardCol): string {
  if (cellBusy(ep, col)) return '…'
  return ep.status?.[col.field] === true ? '✓' : '○'
}
// The Research column's ✓ means "evidence exists" — the same field the
// Pipeline's pill and the backend's skip logic read. It does NOT mean the
// claims were triaged, which is a separate editorial fact (`research_reviewed`,
// and `research_reviewed_by` for who did it). Folding triage into the tick
// would make the column disagree with the Pipeline again; leaving it unsaid is
// how a "20/150 researched" header hid seven un-triaged episodes. So it is
// said here, beside the tick, rather than encoded in it.
function researchNote(status: any): string {
  if (!status?.research) return ''
  if (!status.research_reviewed) return ' — claims still to review'
  const who = status.research_reviewed_by === 'pipeline-auto'
    ? 'claims auto-accepted by the Pipeline, not read by a person'
    : 'claims reviewed'
  return status.research_has_usable_claims ? ` — ${who}` : ` — ${who}, none kept`
}
function cellTitle(ep: any, col: BoardCol): string {
  const done = ep.status?.[col.field] === true
  const manual = isManual(ep, col.field)
  const state = done
    ? (manual ? 'done (marked by hand)' : 'done')
    : 'pending'
  const note = col.field === 'research' ? researchNote(ep.status) : ''
  return `${ep.episode_code} · ${col.label}${col.optional ? ' (optional)' : ''}: ${state}${note} — click to open`
}
function doneCount(col: BoardCol): number {
  return columnDoneCounts.value[col.field] || 0
}
function markTitle(ep: any, col: BoardCol): string {
  const detected = ep.status?.[col.field] === true
  const manual = isManual(ep, col.field)
  if (manual) return `${ep.episode_code} · ${col.label}: marked done by hand — click to return to auto-detect`
  if (detected) return `${ep.episode_code} · ${col.label}: detected from files — can't be unmarked`
  return `${ep.episode_code} · ${col.label}: pending — click to mark done by hand`
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

// ── Mark-done mode ──────────────────────────────────────────────────────────
function cellBusy(ep: any, col: BoardCol): boolean {
  return busyCell.value === `${ep.episode_code}:${col.field}`
}

/** Toggle a manual done override for one episode/step. Detected-done cells
 *  (done from files, not a manual flag) are a no-op — you can't un-detect a
 *  file that exists. The PATCH replaces the whole overrides object, so we
 *  rebuild it from the current one and flip just this field. */
async function markCell(ep: any, col: BoardCol) {
  if (busyCell.value) return
  if (ep.marked_done) {
    showInfo(`${ep.episode_code} is marked done as a whole episode — manage that from the Ideas page.`)
    return
  }
  const field = col.field
  const detected = ep.status?.[field] === true
  const manual = isManual(ep, field)
  if (detected && !manual) {
    showInfo(`${col.label} for ${ep.episode_code} is already detected from files on disk.`)
    return
  }

  const next: Record<string, boolean> = {}
  const current = ep.status_overrides
  if (current && typeof current === 'object') {
    for (const [k, v] of Object.entries(current)) {
      if (typeof v === 'boolean') next[k] = v
    }
  }
  if (manual) delete next[field]
  else next[field] = true

  busyCell.value = `${ep.episode_code}:${field}`
  let savedOnServer = false
  try {
    const result = await patch<{
      ok: boolean
      episode_code: string
      status_overrides: Record<string, boolean> | null
    }>(`/projects/${slug.value}/episodes/${ep.episode_code}/status-overrides`, {
      overrides: Object.keys(next).length ? next : null,
    })
    const saved = result.status_overrides || {}
    const savedManual = typeof saved[field] === 'boolean'
    if ((!manual && saved[field] !== true) || (manual && savedManual)) {
      throw new Error(`${col.label} was not confirmed by the saved episode status.`)
    }
    savedOnServer = true
    updateEpisode(ep.episode_code, currentEp => ({
      ...currentEp,
      status_overrides: Object.keys(saved).length ? saved : null,
      status: {
        ...currentEp.status,
        [field]: manual ? currentEp.status[field] : true,
      },
    }))
    const list = await revalidateAfterMutation()
    const confirmed = list.find(row => row.episode_code === ep.episode_code)
    const confirmedOverrides = confirmed?.status_overrides || {}
    if (!confirmed
      || (!manual && (confirmedOverrides as Record<string, boolean>)[field] !== true)
      || (manual && typeof (confirmedOverrides as Record<string, boolean>)[field] === 'boolean')) {
      throw new Error(`${col.label} was saved but the refreshed episode status did not confirm it.`)
    }
    success(manual
      ? `${col.label} → auto-detect for ${ep.episode_code}`
      : `${col.label} marked done for ${ep.episode_code} — board refreshed`)
  } catch (e: any) {
    showError(savedOnServer
      ? `${col.label} was saved for ${ep.episode_code}, but the refreshed board status could not be confirmed. Click Refresh to verify it.`
      : (e?.data?.detail || e?.message || `Could not update ${col.label} for ${ep.episode_code}`))
  } finally {
    busyCell.value = ''
  }
}
</script>

<style scoped>
.board {
  display: flex;
  flex-direction: column;
  min-height: 100%;
  gap: var(--space-4);
}

.board-command-surface {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.board-stepfilter-chip {
  font-size: var(--font-xs);
  font-family: inherit;
  padding: 2px 8px;
  border-radius: 10px;
  border: 1px solid var(--accent);
  background: color-mix(in srgb, var(--accent) 18%, transparent);
  color: var(--text-primary);
  cursor: pointer;
}
.board-stepfilter-chip:hover { background: color-mix(in srgb, var(--accent) 30%, transparent); }
.board-tools {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1 1 760px;
  flex-wrap: wrap;
}
.board-mode {
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
}
.board-mode-btn {
  padding: 6px 10px;
  font-size: 12px;
  font-family: inherit;
  border: 0;
  background: var(--bg-tertiary);
  color: var(--text-muted);
  cursor: pointer;
  white-space: nowrap;
}
.board-mode-btn + .board-mode-btn { border-left: 1px solid var(--border); }
.board-mode-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
.board-mode-btn.active { background: var(--accent); color: #0f1117; }
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
  min-height: var(--control-height-sm);
  padding: 6px 10px 6px 28px;
  font-size: 12px;
  width: min(280px, 40vw);
}
.board-filter {
  min-height: var(--control-height-sm);
  padding: 6px 12px;
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

.board-pagination {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  flex-wrap: wrap;
}
.board-page-range,
.board-page-indicator {
  color: var(--text-muted);
  font-size: 12px;
  white-space: nowrap;
}
.board-page-btn {
  min-width: 48px;
  min-height: var(--control-height-sm);
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.board-page-btn:hover:not(:disabled) {
  border-color: var(--accent);
  background: var(--bg-hover);
  color: var(--text-primary);
}
.board-page-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.board-page-edge { min-width: 32px; padding-inline: 8px; }

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
  overflow-x: auto;
  overflow-y: visible;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--bg-secondary);
  box-shadow: var(--shadow);
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
  top: 27px;
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
.phase-head {
  position: sticky;
  top: 0;
  z-index: 4;
  height: 27px;
  padding: 5px 10px;
  background: color-mix(in srgb, var(--bg-tertiary) 88%, var(--accent) 12%);
  color: var(--text-secondary);
  font-size: var(--font-xs);
  font-weight: 750;
  letter-spacing: .1em;
  text-align: center;
  text-transform: uppercase;
}
.phase-head.sticky-col {
  z-index: 5;
  text-align: left;
  vertical-align: middle;
}

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
  width: 100%;
  border: 0;
  background: transparent;
  font: inherit;
  color: inherit;
  cursor: pointer;
}
.step-h:hover { background: var(--bg-hover); }
.step-h-active {
  background: color-mix(in srgb, var(--accent) 18%, transparent);
  box-shadow: inset 0 -2px 0 var(--accent);
}
.step-h-icon { font-size: 13px; }
.step-h-label { font-size: var(--font-xs); line-height: 1.1; color: var(--text-primary); text-align: center; }
.step-h-optional { font-size: var(--font-xs); line-height: 1; color: var(--accent); text-transform: uppercase; letter-spacing: .05em; }
.step-h-count { font-size: var(--font-xs); color: var(--text-muted); }

/* Cheap virtualization: skip layout/paint for off-screen rows. The fixed
   intrinsic height keeps the scrollbar accurate without windowing JS. */
.board-row {
  content-visibility: auto;
  contain-intrinsic-size: 0 38px;
}

.ep-cell {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.ep-cell-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
/* Import button stays subtle until the row is hovered, so the grid reads
   cleanly but the affordance is one move away. */
.ep-import {
  flex: 0 0 auto;
  width: 22px;
  height: 22px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--bg-tertiary);
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.12s, background 0.12s;
}
.board-row:hover .ep-import { opacity: 1; }
.ep-import:hover { background: var(--bg-hover); color: var(--text-primary); }
.ep-code {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.ep-busy { font-size: var(--font-xs); }
.ep-donepill {
  font-size: var(--font-xs);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--success, #22c55e);
  border: 1px solid color-mix(in srgb, var(--success, #22c55e) 45%, transparent);
  border-radius: 4px;
  padding: 0 4px;
}
.ep-title {
  font-size: var(--font-xs);
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
/* Button variant (Mark-done mode) — strip native button chrome so it reads
   identically to the link cells. */
.cell-btn {
  border: 0;
  background: transparent;
  font: inherit;
  cursor: pointer;
}
.cell-btn:disabled { cursor: default; }
.cell-loading { opacity: 0.5; }
.cell-done { color: var(--success, #22c55e); }
.cell-pending { color: var(--text-muted); opacity: 0.55; }
.cell-optional.cell-pending { opacity: 0.32; }
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
  font-size: var(--font-xs);
  color: var(--text-muted);
}
.board-legend b { font-style: normal; }
.lg-done { color: var(--success, #22c55e); }
.lg-manual { color: var(--success, #22c55e); text-decoration: underline dashed; text-underline-offset: 2px; }
.lg-pending { opacity: 0.55; }
.board-legend-hint { opacity: 0.8; }

@media (max-width: 720px) {
  .board-search,
  .board-search-input {
    width: 100%;
  }

  .board-mode {
    width: 100%;
  }

  .board-mode-btn {
    flex: 1;
  }
}
</style>
