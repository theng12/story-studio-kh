<template>
  <div class="form-group">
    <label>
      Episode
      <!-- v1.0.48: episode-count badge — confirms scope ("X loaded") so
           large projects (a channel with 380+ episodes) make slow loads
           feel legitimate instead of like the app is hung.
           v1.0.92: when a search is active the badge shows "N of M
           shown" so the user sees how aggressive their filter is. -->
      <span v-if="!loading && episodes.length" class="ep-count">
        <template v-if="searchActive">· {{ filteredEpisodes.length }} of {{ episodes.length }} shown</template>
        <template v-else>· {{ episodes.length }} loaded</template>
      </span>
      <span v-else-if="loading" class="ep-loading-inline">
        <span class="ep-spinner" aria-hidden="true" />
        Loading episodes… {{ elapsedLabel }}
      </span>
    </label>
    <div class="toggle-row">
      <button :class="['toggle-btn', { active: !showAll }]" @click="showAll = false">Pending Only</button>
      <button :class="['toggle-btn', { active: showAll }]" @click="showAll = true">Show All</button>
      <button
        class="toggle-btn refresh-btn"
        :disabled="loading"
        @click="onRefreshClick"
        :title="loading ? 'Loading…' : 'Refresh (shift-click to rescan from disk — slower, use after files change outside the app)'"
      >
        {{ loading || isRevalidating ? '…' : '↻' }}
      </button>
    </div>
    <WorkspaceNotice
      v-if="loadError && !loading"
      title="Episodes could not be refreshed"
      tone="error"
      class="ep-load-error"
    >
      {{ episodes.length ? 'Your last loaded episode list is still available.' : episodeErrorMessage }}
      <template #actions>
        <button
          type="button"
          class="btn btn-sm btn-secondary"
          :disabled="isRevalidating"
          @click="refresh()"
        >{{ isRevalidating ? 'Retrying…' : 'Retry' }}</button>
      </template>
    </WorkspaceNotice>
    <!-- v1.0.92+ Episode search.
         A native <select> can't be searched once it's open (you only get
         the OS's "first letter jumps to next match" behaviour), which is
         useless for a 380-episode project. This input filters the option
         list before it's rendered, so opening the dropdown only shows
         matches. Matches against episode_code ("TN0042") and title — both
         case-insensitive, partial substring. Pressing Esc clears. -->
    <div v-if="!loading && episodes.length > 5" class="ep-search-row">
      <span class="ep-search-icon" aria-hidden="true">🔎</span>
      <input
        v-model="searchQuery"
        class="input ep-search-input"
        type="search"
        :placeholder="`Search ${episodes.length} episode${episodes.length === 1 ? '' : 's'} by code or title…`"
        @keydown.esc.prevent="searchQuery = ''"
      />
      <button
        v-if="searchActive"
        type="button"
        class="ep-search-clear"
        title="Clear search (Esc)"
        @click="searchQuery = ''"
      >✕</button>
    </div>
    <select
      :value="modelValue"
      :disabled="loading || (!episodes.length && !!loadError)"
      @change="onSelect(($event.target as HTMLSelectElement).value)"
      @focus="loadEpisodes"
      class="select"
    >
      <!-- v1.0.48: placeholder reflects load state. Cold-load: "Loading…
           N episodes". Loaded: standard "Select an episode…". -->
      <option value="" disabled>
        <template v-if="loading && episodes.length === 0">Loading episodes… please wait</template>
        <template v-else-if="searchActive && filteredEpisodes.length === 0">
          No episodes match "{{ searchQuery }}" — clear search or adjust filter
        </template>
        <template v-else>Select an episode...</template>
      </option>
      <option v-for="ep in filteredEpisodes" :key="ep.episode_code" :value="ep.episode_code">
        {{ ep.episode_code }} — {{ ep.title }}{{ statusSuffix(ep) }}{{ localMediaStatusSuffix(ep) }}{{ retainedSuffix(ep) }}
      </option>
    </select>
    <div v-if="legend" class="status-legend">{{ legend }}</div>

    <!-- v1.0.338 — per-step status for the SELECTED episode + manual
         mark-as-done. Step status auto-detects from files on disk; when a
         finished asset is imported from outside the app the step can stay
         "pending" forever with nothing to click. Clicking a pending chip
         stores a manual override (dashed ✓); clicking it again returns the
         step to auto-detect. Collapsed to a one-line summary by default so
         the picker stays compact on every generator page. -->
    <div v-if="selectedEp" class="step-strip">
      <button type="button" class="step-summary" @click="stepsExpanded = !stepsExpanded">
        <span class="step-summary-arrow ds-chevron" aria-hidden="true" :class="{ 'is-open': stepsExpanded }" />
        Steps: {{ doneChipCount }}/{{ visibleChips.length }} done
        <span v-if="manualChipCount" class="step-summary-manual">· {{ manualChipCount }} manual</span>
      </button>
      <template v-if="stepsExpanded">
        <div class="step-chips-row">
          <button
            v-for="chip in visibleChips"
            :key="chip.field"
            type="button"
            class="step-chip"
            :class="chipClass(chip.field)"
            :disabled="togglingStep !== '' || selectedEp.marked_done === true"
            :title="chipTitle(chip)"
            @click="onChipClick(chip)"
          >
            <span class="step-chip-mark">{{ chipMark(chip.field) }}</span>{{ chip.label }}
          </button>
        </div>
        <div class="step-chips-hint">
          <template v-if="togglingStep">
            Updating {{ togglingStepLabel }}… the step count and pending list will refresh together.
          </template>
          <template v-else-if="selectedEp.marked_done === true">
            This episode is marked done — every step is forced ✓. Undo from the Ideas page.
          </template>
          <template v-else>
            Steps auto-detect from files on disk. Imported a result from outside the app?
            Click its step to mark it done by hand (dashed ✓) — click again to return to auto-detect.
          </template>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { isNavigationFailure, NavigationFailureType } from 'vue-router'
import { STEP_STATUS_FIELD } from '~/composables/useProjectFlow'
import { localMediaStatusLabel } from '~/composables/useEpisodes'
import { jobTypeLabel } from '~/utils/job-presentation'

const props = defineProps<{
  modelValue: string
  projectSlug: string
  filterField?: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
  'episode-selected': [episode: any]
}>()

// Use the shared SWR cache for episode lists so EpisodeSelector instances
// across all 9 generator pages share one in-memory copy and dedupe
// concurrent fetches. Manual refresh + job-completion auto-refresh both
// flow through the composable.
const slugRef = computed(() => props.projectSlug)
const {
  episodes,
  isLoading: loading,
  isRevalidating,
  error: loadError,
  load,
  refresh,
  revalidateAfterMutation,
  rescan,
  updateEpisode,
} = useEpisodes(slugRef)
const showAll = ref(false)
const episodeErrorMessage = computed(() => {
  const value = loadError.value as any
  const message = value?.data?.detail || value?.message
  return typeof message === 'string' && message.trim()
    ? message
    : 'Check that Story Studio is online, then retry.'
})

// v1.0.341 — preselect from ?episode_id= in the URL. The Production Board
// links every cell to a step page with ?episode_id=CODE, so landing there
// should open that episode, not an empty picker. Fires ONCE, only when the
// host page hasn't already chosen an episode (so pages that read the query
// themselves — e.g. Scripts — still win). If a "Pending only" filter would
// hide the target (it's already done for this step), flip to Show all so the
// selection is visible rather than a blank <select>.
const route = useRoute()
const router = useRouter()
let didAutoSelect = false
function tryAutoSelectFromQuery() {
  if (didAutoSelect) return
  if (String(route.params.slug || '') !== props.projectSlug) return
  const q = String(route.query.episode_id || '').trim()
  if (!q) return
  const match = episodes.value.find(e => e.episode_code === q)
  if (!match) return // episodes not loaded yet (retry on next change) or unknown code
  didAutoSelect = true
  if (!showAll.value && props.filterField && match.status?.[props.filterField]) {
    showAll.value = true
  }
  emit('update:modelValue', q)
  emit('episode-selected', match)
}
watch(episodes, tryAutoSelectFromQuery)
watch(() => route.query.episode_id, (episode) => {
  if (String(route.params.slug || '') !== props.projectSlug) return
  const queryEpisode = String(episode || '').trim()
  if (!queryEpisode) {
    didAutoSelect = false
    if (props.modelValue) emit('update:modelValue', '')
    return
  }
  if (queryEpisode === props.modelValue) return
  didAutoSelect = false
  tryAutoSelectFromQuery()
})
watch(() => props.projectSlug, () => {
  didAutoSelect = false
  tryAutoSelectFromQuery()
})
onMounted(tryAutoSelectFromQuery)

// ── v1.0.338 — per-step status chips + manual mark-as-done ────────────────
const { patch } = useApi()
const { success, error: showError, info: showInfo } = useToast()

const selectedEp = computed(() =>
  props.modelValue ? episodes.value.find(e => e.episode_code === props.modelValue) || null : null)

interface StepChip { field: string; label: string; conditional?: boolean; activePath?: string }
// Pipeline-ordered. `conditional` steps only apply to some formats
// (research / scene-plan / scene-review for transcript-timed pipelines,
// per-scene Clips for AI-video formats) — they'd read as forever-pending
// noise elsewhere, so they only render when they're done, overridden, or
// this page IS that step (filterField match).
// v1.4.82 — the FIELD names come from the one shared step → status-field map in
// useProjectFlow. They used to be re-typed here, and a re-typed copy is how the
// Dashboard ended up missing two of them: the same episode could then read
// "Steps 10 of 12" on one surface and complete on another. Labels and the
// `conditional` flag stay local — those are presentation, not truth.
const F = STEP_STATUS_FIELD
const STEP_CHIPS: StepChip[] = [
  { field: F.research,        label: 'Research', conditional: true },
  { field: F.script,          label: 'Script' },
  // v1.4.82 — Introduction was returned per episode and shown on no chip at
  // all. Conditional, so it appears only once it is done, overridden, or you
  // are standing on that page — it never adds forever-pending noise.
  { field: F.introduction,    label: 'Introduction', conditional: true, activePath: '/introduction' },
  { field: F.metadata,        label: 'Metadata' },
  { field: F['thumb-prompts'], label: 'Thumb prompts' },
  { field: F.thumbnails,      label: 'Thumbnails' },
  { field: F.audio,           label: 'Audio' },
  { field: F['audio-merge'],  label: 'Audio merge' },
  { field: F.subtitles,       label: 'Subtitles', conditional: true },
  { field: F['character-sheet'], label: 'Character sheet', conditional: true },
  // No flow step reports this one, so it has no entry in the shared map.
  { field: 'broll_picked',    label: 'B-Roll picked', conditional: true },
  { field: F['scene-plan'],   label: 'Scene plan', conditional: true },
  { field: F['scene-review'], label: 'Scene review', conditional: true },
  { field: F['motion-review'], label: 'Motion review (optional)', conditional: true, activePath: '/motion-review' },
  { field: F['video-assembly'], label: 'Final video' },
]

const stepsExpanded = ref(false)
const togglingStep = ref('')
const togglingStepLabel = computed(() =>
  STEP_CHIPS.find(chip => chip.field === togglingStep.value)?.label || 'step')

function overrideFor(field: string): boolean | undefined {
  const o = selectedEp.value?.status_overrides
  return o && typeof o === 'object' ? (o as Record<string, boolean | undefined>)[field] : undefined
}

const visibleChips = computed(() => {
  const ep = selectedEp.value
  if (!ep) return []
  return STEP_CHIPS.filter(c => {
    if (!c.conditional) return true
    return ep.status?.[c.field] === true
      || overrideFor(c.field) !== undefined
      || props.filterField === c.field
      || (c.activePath ? route.path.endsWith(c.activePath) : false)
  })
})
const doneChipCount = computed(() =>
  visibleChips.value.filter(c => selectedEp.value?.status?.[c.field] === true).length)
const manualChipCount = computed(() =>
  visibleChips.value.filter(c => overrideFor(c.field) !== undefined).length)

function chipClass(field: string): Record<string, boolean> {
  const done = selectedEp.value?.status?.[field] === true
  const manual = overrideFor(field) !== undefined
  return {
    'chip-done': done,
    'chip-pending': !done,
    'chip-manual': manual,
    'chip-busy': togglingStep.value === field,
  }
}
function chipMark(field: string): string {
  if (togglingStep.value === field) return '…'
  return selectedEp.value?.status?.[field] === true ? '✓' : '○'
}
function chipTitle(chip: StepChip): string {
  const done = selectedEp.value?.status?.[chip.field] === true
  const manual = overrideFor(chip.field) !== undefined
  if (manual) return `${chip.label}: marked ${done ? 'done' : 'pending'} BY HAND — click to return to auto-detect`
  if (done) return `${chip.label}: done (detected from files on disk)`
  return `${chip.label}: pending — click to mark done by hand (e.g. you imported the finished file)`
}

async function onChipClick(chip: StepChip) {
  const ep = selectedEp.value
  if (!ep || togglingStep.value) return
  const field = chip.field
  const manual = overrideFor(field) !== undefined
  const done = ep.status?.[field] === true

  // Auto-detected done — nothing to toggle (removing a detection isn't a
  // thing; the files are on disk). Explain instead of silently ignoring.
  if (done && !manual) {
    showInfo(`${chip.label} is already detected as done from the files on disk.`)
    return
  }

  // Build the REPLACEMENT overrides object (the PATCH replaces, not merges).
  const next: Record<string, boolean> = {}
  const current = ep.status_overrides
  if (current && typeof current === 'object') {
    for (const [k, v] of Object.entries(current)) {
      if (typeof v === 'boolean') next[k] = v
    }
  }
  if (manual) delete next[field]
  else next[field] = true

  togglingStep.value = field
  let savedOnServer = false
  try {
    const result = await patch<{
      ok: boolean
      episode_code: string
      status_overrides: Record<string, boolean> | null
    }>(`/projects/${props.projectSlug}/episodes/${ep.episode_code}/status-overrides`, {
      overrides: Object.keys(next).length ? next : null,
    })

    const saved = result.status_overrides || {}
    const savedManual = typeof saved[field] === 'boolean'
    if ((!manual && saved[field] !== true) || (manual && savedManual)) {
      throw new Error(`${chip.label} was not confirmed by the saved episode status.`)
    }
    savedOnServer = true

    // Give immediate feedback in every mounted selector/board while the
    // authoritative status is recomputed. Keep the selected completed row
    // visible in Pending-only long enough for the user to see the result.
    updateEpisode(ep.episode_code, currentEp => ({
      ...currentEp,
      status_overrides: Object.keys(saved).length ? saved : null,
      status: {
        ...currentEp.status,
        [field]: manual ? currentEp.status[field] : true,
      },
    }))

    const list = await revalidateAfterMutation(ep.episode_code)
    const confirmed = list.find(row => row.episode_code === ep.episode_code)
    const confirmedOverrides = confirmed?.status_overrides || {}
    if (!confirmed
      || (!manual && (confirmedOverrides as Record<string, boolean>)[field] !== true)
      || (manual && typeof (confirmedOverrides as Record<string, boolean>)[field] === 'boolean')) {
      throw new Error(`${chip.label} was saved but the refreshed episode status did not confirm it.`)
    }
    emit('episode-selected', confirmed)
    success(manual
      ? `${chip.label} returned to auto-detect for ${ep.episode_code}`
      : `${chip.label} marked done for ${ep.episode_code} — status refreshed`)
  } catch (e: any) {
    showError(savedOnServer
      ? `${chip.label} was saved for ${ep.episode_code}, but the refreshed status could not be confirmed. Click Refresh to verify it.`
      : (e?.data?.detail || e?.message || `Could not update ${chip.label} for ${ep.episode_code}`))
  } finally {
    togglingStep.value = ''
  }
}

// v1.0.92+ — episode search (case-insensitive substring on code or
// title). Local-only state: each EpisodeSelector instance owns its own
// query so opening the same project on two surfaces (e.g. Scripts +
// Metadata in side-by-side windows) doesn't cross-contaminate.
const searchQuery = ref('')
const searchActive = computed(() => searchQuery.value.trim().length > 0)

// v1.0.48 Layer 3 — cross-reference active jobs so episodes that are
// CURRENTLY generating a script / audio / video render get a 🔄 badge
// in the dropdown. The disk-derived status (script: bool, audio: bool,
// etc.) only flips after the job lands; without this overlay there's
// no UI signal that a render is in flight for a specific episode.
const { jobs } = useJobs()
const activeJobsByEpisode = computed(() => {
  // Build Map<episode_code, jobType[]> of jobs that are queued or
  // running. Multiple job types per episode (e.g. audio + image-prompts
  // running in parallel) collapse into the array so the suffix can
  // describe whichever is most useful.
  const out = new Map<string, string[]>()
  for (const job of jobs.value || []) {
    if (job.status !== 'queued' && job.status !== 'running') continue
    const code = job.episode_id
    if (!code) continue
    const list = out.get(code) || []
    list.push(job.type)
    out.set(code, list)
  }
  return out
})

/**
 * v1.4.82 — "Pending only" keeps the SELECTED episode on the list even once it
 * is finished, by design: a step you just completed must not vanish from under
 * you mid-edit. But the row then looked identical to a genuinely pending one,
 * which is half of "why does this say pending when the page says done". Say
 * plainly why it is still there.
 */
function retainedSuffix(ep: any): string {
  if (showAll.value || !props.filterField) return ''
  if (ep.episode_code !== props.modelValue) return ''
  return ep.status?.[props.filterField] === true ? ' ✓ done — still listed because it is open' : ''
}

const filteredEpisodes = computed(() => {
  let list = episodes.value
  if (!showAll.value && props.filterField) {
    const field = props.filterField
    list = list.filter(ep => !ep.status[field] || ep.episode_code === props.modelValue)
  }
  // v1.0.92+ — apply search after the pending/all filter so the count
  // badge "N of M shown" reflects what the user is actually scanning,
  // not the raw episodes pool.
  if (searchActive.value) {
    const q = searchQuery.value.trim().toLowerCase()
    list = list.filter(ep =>
      (ep.episode_code || '').toLowerCase().includes(q) ||
      (ep.title || '').toLowerCase().includes(q),
    )
  }
  return [...list].sort((a, b) => a.episode_code.localeCompare(b.episode_code))
})

// v1.0.48 Layer 1 — elapsed-time counter for the "Loading…" hint above.
// Starts when `loading` flips true, stops/resets when it goes false.
// Updates every second, so 380-episode cold-loads feel honest ("12s
// elapsed") instead of stalled. Reset when not loading so the next
// load starts at 0s.
const elapsedSec = ref(0)
let elapsedTimer: ReturnType<typeof setInterval> | null = null
const elapsedLabel = computed(() => elapsedSec.value > 0 ? `(${elapsedSec.value}s elapsed)` : '')
watch(loading, (isLoading) => {
  if (isLoading) {
    elapsedSec.value = 0
    if (elapsedTimer) clearInterval(elapsedTimer)
    elapsedTimer = setInterval(() => { elapsedSec.value++ }, 1000)
  } else {
    if (elapsedTimer) {
      clearInterval(elapsedTimer)
      elapsedTimer = null
    }
    elapsedSec.value = 0
  }
}, { immediate: true })
onBeforeUnmount(() => { if (elapsedTimer) clearInterval(elapsedTimer) })

// F-11 — job-type labels come from the ONE authoritative map in
// `~/utils/job-presentation`. This file used to keep its own short-verb map
// missing most live types, so the dropdown rendered raw slugs.

// Per-context suffix so the user can tell at a glance what each episode is ready for.
// For video assembly specifically: ✓ rendered, ● ready to assemble, ○ missing inputs.
function statusSuffix(ep: any): string {
  // v1.0.48 Layer 3 — in-progress badge wins over disk-derived status.
  // If a render is running RIGHT NOW for this episode, that's the most
  // important signal; what's currently on disk is stale either way.
  const activeTypes = activeJobsByEpisode.value.get(ep.episode_code)
  if (activeTypes && activeTypes.length > 0) {
    // Pick the first job type alphabetically for stable display when
    // multiple are running (rare). Map to a friendly label.
    const primary = activeTypes.slice().sort()[0]
    const label = jobTypeLabel(primary)
    return ` 🔄 generating ${label}…`
  }
  const s = ep.status || {}
  // 'video_assembly' is the OUTPUT (final assembled file present anywhere
  // — project tree, external root, or YouTube-uploaded). 'video' is the
  // INPUT (per-scene AI clips done). The video-assembly page filters
  // by the former; per-scene-clip pages still filter by the latter.
  if (props.filterField === 'video_assembly') {
    if (s.video_assembly) return ' ✓ rendered'
    // Continuity/timestamp projects use scene_review, not the legacy images
    // folder. Prefer that source of truth whenever a complete plan exists.
    if (s.scene_plan) {
      if (!s.scene_review) return ' ○ missing planned images'
      if (!s.merged_audio) return ' ○ missing merged audio'
      return ' ● ready to assemble'
    }
    if (s.video_ready) return ' ● ready to assemble'
    if (!s.images) return ' ○ missing scenes'
    if (!s.merged_audio) return ' ○ missing merged audio'
    return ' ○ not ready'
  }
  if (props.filterField === 'video') {
    if (s.video) return ' ✓ rendered'
    if (s.video_ready) return ' ● ready'
    if (!s.images) return ' ○ missing scenes'
    if (!s.merged_audio) return ' ○ missing merged audio'
    return ' ○ not ready'
  }
  if (props.filterField === 'merged_audio') {
    if (s.merged_audio) return ' ✓'
    if (!s.audio) return ' ○ no narration'
    return ''
  }
  if (props.filterField === 'research') {
    if (s.research_generated) {
      if (s.research_reviewed && !s.research_has_usable_claims) return ' ⚠ all claims ignored'
      if (!s.research_reviewed) return ' ⚠ claims need review'
    }
    if (s.research) {
      const by = (ep.status as any)?.research_reviewed_by
      if (by === 'pipeline-auto') return ' ✓ auto-accepted'
      if (by === 'auto-approval') return ' ✓ auto-approved'
      return ' ✓ researched'
    }
    return ''
  }
  // v1.0.338 — generic per-page suffix. In "Show all" mode the dropdown
  // used to mark only fully-finished episodes (all_done ✓), so you couldn't
  // tell which episodes had THIS page's step done. Now the page's own step
  // (filterField) drives the mark, with "(manual)" when it came from a
  // hand-set override rather than file detection.
  if (props.filterField && s[props.filterField]) {
    const manual = ep.status_overrides
      && typeof ep.status_overrides === 'object'
      && ep.status_overrides[props.filterField] !== undefined
    return manual ? ' ✓ (manual)' : ' ✓'
  }
  return s.all_done ? ' ✓' : ''
}

function localMediaStatusSuffix(ep: any): string {
  const label = localMediaStatusLabel(ep.local_media_status)
  return label ? ` · ${label}` : ''
}

const legend = computed(() => {
  if (props.filterField === 'video' || props.filterField === 'video_assembly') {
    return '✓ rendered · ● ready · ○ missing inputs'
  }
  return ''
})

// v1.0.48 Layer 4 — confirm-before-swap when the CURRENT episode has
// an active job. Switching away mid-generation hides the progress
// panel from the page and the user can lose track that a render is
// running. The job itself keeps going (it's queued / running on the
// backend), but the UX-level concern is real: a dropdown click that
// silently abandons the page's progress view is a class of "did I
// just lose my work?" panic moment we can prevent with one prompt.
//
// Strategy: read the previously-selected modelValue, look up its
// active jobs, and if any are running, ask. If user cancels, revert
// the <select> visually by re-emitting the OLD modelValue (Vue's
// :value binding handles the rollback). If they confirm, proceed.
const { ask } = useConfirm()

async function onSelect(code: string) {
  // No-op when the user picked the same episode they were on (clicking
  // the dropdown without changing).
  if (code === props.modelValue) return

  // Confirm guard — only when the OLD selection has running jobs.
  const oldCode = props.modelValue
  const oldActive = oldCode ? activeJobsByEpisode.value.get(oldCode) : null
  if (oldCode && oldActive && oldActive.length > 0) {
    const labels = oldActive.map(t => jobTypeLabel(t)).join(', ')
    const proceed = await ask({
      title: `Switch away from ${oldCode}?`,
      message:
        `${oldCode} has a generation in progress: ${labels}. ` +
        `The job keeps running on the backend, but switching episodes hides this page's progress panel — ` +
        `come back to ${oldCode} to see when it finishes. ` +
        `(The Jobs tab also lists every running job across episodes.)`,
      confirmLabel: 'Switch Episode',
    })
    if (!proceed) {
      // Force a re-render by re-emitting the old value. Without this
      // the <select> stays visually on the new code even though
      // modelValue prop didn't change — Vue's :value binding only
      // updates when the prop changes, which it didn't.
      emit('update:modelValue', oldCode)
      return
    }
  }

  // The next/previous ribbon reads the current route. Synchronize the picker
  // before a later navigation can reuse an old deep-link selection, while
  // retaining page-local query state such as the active Script tab.
  const hadAutoSelect = didAutoSelect
  didAutoSelect = true
  if (String(route.params.slug || '') === props.projectSlug) {
    // A page guard (unsaved edits) can refuse the navigation; then the episode must not change.
    if (isNavigationFailure(await router.replace({ query: { ...route.query, episode_id: code } }), NavigationFailureType.aborted)) {
      didAutoSelect = hadAutoSelect
      emit('update:modelValue', oldCode)
      return
    }
  }
  emit('update:modelValue', code)
  const ep = episodes.value.find(e => e.episode_code === code)
  if (ep) emit('episode-selected', ep)
}

// Refresh + invalidation are handled inside useEpisodes:
//  - Auto-revalidate on `done` job transitions (any type, current slug)
//  - Manual ↻ button calls refresh() which forces ?refresh=1
//  - Shift+↻ calls rescan() which also wipes the on-disk cache (use
//    after files appear on disk but the UI hasn't caught up).
//
// The dropdown's @focus handler. It must stay on the CACHED path: this
// fires every time the select is tabbed into or clicked, and refresh()
// sends ?refresh=1, which drops the whole project's status cache and
// re-walks every episode folder. On a 300-episode project that turned
// "tab into the dropdown" into a full rescan. load() serves the cached
// list, revalidates quietly if it is older than a few seconds, and only
// blocks when nothing is cached yet — which is all focus ever needed.
async function loadEpisodes() {
  await load()
}

async function onRefreshClick(e: MouseEvent) {
  if (e.shiftKey) await rescan()
  else await refresh()
}

defineExpose({ refresh, rescan })
</script>

<style scoped>
.toggle-row {
  display: flex;
  gap: 2px;
  margin-bottom: 6px;
}

.toggle-btn {
  flex: 1;
  padding: 5px 10px;
  font-size: 12px;
  font-family: inherit;
  border: 1px solid var(--border);
  background: var(--bg-tertiary);
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.15s;
}

.toggle-btn:first-child {
  border-radius: 6px 0 0 6px;
}

.toggle-btn:last-child {
  border-radius: 0 6px 6px 0;
}

.toggle-btn.active {
  background: var(--accent);
  color: #0f1117;
  border-color: var(--accent);
  font-weight: 500;
}

.toggle-btn:not(.active):hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.refresh-btn {
  flex: 0 0 auto;
  padding: 5px 10px;
  border-radius: 0 6px 6px 0 !important;
  border-left: none;
}

.refresh-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.toggle-btn:not(:first-child):not(:last-child) {
  border-radius: 0;
  border-left: none;
  border-right: none;
}

.status-legend {
  font-size: var(--font-xs);
  color: var(--text-muted);
  margin-top: 4px;
}
.ep-load-error { margin: 8px 0; }

/* v1.0.48 — episode-count + loading-state hints next to the label. */
.ep-count {
  font-size: var(--font-xs);
  color: var(--text-muted);
  font-weight: normal;
  margin-left: 6px;
}
.ep-loading-inline {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--font-xs);
  font-weight: normal;
  color: var(--text-muted);
  margin-left: 6px;
}
.ep-spinner {
  display: inline-block;
  width: 10px;
  height: 10px;
  border: 1.5px solid var(--text-muted);
  border-top-color: transparent;
  border-radius: 50%;
  animation: ep-spin 0.7s linear infinite;
}
@keyframes ep-spin {
  to { transform: rotate(360deg); }
}

/* v1.0.92+ — episode search row between the toggle buttons and the
   native <select>. Sits flush with the toggle row above and the select
   below so the three controls read as one cluster. */
.ep-search-row {
  position: relative;
  display: flex;
  align-items: center;
  margin: 6px 0;
}
.ep-search-icon {
  position: absolute;
  left: 8px;
  font-size: 12px;
  color: var(--text-muted);
  pointer-events: none;
  line-height: 1;
}
.ep-search-input {
  flex: 1;
  padding: 6px 28px 6px 28px;
  font-size: 12px;
}
.ep-search-input::-webkit-search-cancel-button {
  /* Hide the WebKit native clear button; we render our own ✕ for
     consistent dark-mode styling across browsers + a clearer click
     target. */
  -webkit-appearance: none;
}
.ep-search-clear {
  position: absolute;
  right: 6px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: 0;
  background: var(--bg-tertiary);
  color: var(--text-muted);
  font-size: var(--font-xs);
  line-height: 1;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.ep-search-clear:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

/* v1.0.338 — per-step status strip (collapsed summary + expandable chips). */
.step-strip {
  margin-top: 6px;
}
.step-summary {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  font-size: var(--font-xs);
  font-family: inherit;
  color: var(--text-muted);
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 6px;
  cursor: pointer;
}
.step-summary:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.step-summary-arrow {
  font-size: var(--font-xs);
  line-height: 1;
}
.step-summary-manual {
  color: var(--accent);
}
.step-chips-row {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 6px;
}
.step-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  font-size: var(--font-xs);
  font-family: inherit;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--bg-tertiary);
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.15s;
}
.step-chip:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.step-chip:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.step-chip.chip-done {
  color: var(--success, #22c55e);
  border-color: color-mix(in srgb, var(--success, #22c55e) 45%, transparent);
}
/* Manual override — dashed ring distinguishes "marked by hand" from
   "detected from files" at a glance. */
.step-chip.chip-manual {
  border-style: dashed;
  border-color: var(--accent);
}
.step-chip.chip-busy {
  opacity: 0.6;
}
.step-chip-mark {
  font-size: var(--font-xs);
  line-height: 1;
}
.step-chips-hint {
  margin-top: 5px;
  font-size: var(--font-xs);
  line-height: 1.5;
  color: var(--text-muted);
}
</style>
