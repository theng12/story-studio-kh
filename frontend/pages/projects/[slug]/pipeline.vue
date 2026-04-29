<template>
  <div>
    <div class="page-header">
      <Breadcrumb />
      <h1 class="page-title">Pipeline</h1>
    </div>
    <TopActionBar
      :project-slug="slug"
      episode-mode="multi"
      :generate-label="runButtonLabel"
      loading-label="Queuing…"
      :generate-loading="submitting"
      :generate-disabled="!canRun"
      :generate-status="submitting ? 'Queuing batch…' : ''"
      @generate="openConfirm"
    />

    <p class="text-muted mt-1 mb-2">
      Select episodes and steps to run as a batch. Each episode's chain runs
      in sequence (<span title="Each step waits for the previous to finish on the same episode before starting.">
        script → intro → metadata → image prompts → images → video clips → audio → audio merge → video assembly
      </span>); different episodes' steps run concurrently when the queue has capacity.
      Uses each generator's last-used preset for step settings.
      <strong title="Pending = anything the 'Select all pending' button picks up. Includes every core step plus video assembly (added 2026 — previously excluded).">Video Assembly is now included in pending</strong>
      so one click can finish an episode end-to-end.
    </p>

    <!-- ── Steps to run ─────────────────────────────────────────────────── -->
    <div class="card mt-3">
      <div class="flex items-center justify-between">
        <h3>Steps to Run</h3>
        <span class="text-muted" style="font-size:12px">
          Each checked step uses the <strong>last-used preset</strong> on its generator page.
        </span>
      </div>

      <div class="steps-grid mt-2">
        <label
          v-for="step in stepsMeta"
          :key="step.id"
          class="step-tile"
          :class="{
            selected: stepChecked[step.id],
            missing: stepChecked[step.id] && !presetNameFor(step.id),
            costly: step.costly,
            disabled: stepDisabled(step.id),
          }"
          :title="stepDisabledReason(step.id)"
        >
          <input type="checkbox" v-model="stepChecked[step.id]" :disabled="stepDisabled(step.id)" />
          <div class="step-body">
            <div class="step-head">
              <span class="step-icon" aria-hidden="true">{{ step.icon }}</span>
              <strong>{{ step.label }}</strong>
            </div>
            <div class="step-preset">
              <template v-if="presetNameFor(step.id)">
                Preset: <span class="preset-name">{{ presetNameFor(step.id) }}</span>
              </template>
              <template v-else>
                <span class="preset-missing">⚠ No preset —</span>
                <NuxtLink :to="`/projects/${slug}${step.link}`" class="preset-link">set one →</NuxtLink>
              </template>
            </div>
            <div v-if="stepDisabled(step.id)" class="step-warning">{{ stepDisabledReason(step.id) }}</div>
            <div v-else-if="step.warning" class="step-warning">⚠ {{ step.warning }}</div>
          </div>
        </label>
      </div>
    </div>

    <!-- ── Episodes to include ──────────────────────────────────────────── -->
    <div class="card mt-2">
      <div class="flex items-center justify-between" style="flex-wrap:wrap; gap:8px">
        <h3>Episodes</h3>
        <div class="ep-actions-row">
          <!-- Bulk mark/unmark — only visible when there's a selection so
               the row stays uncluttered for the common (no-selection) case.
               Sit at the front because they act on the current selection
               and the user thinks "what do I do with these checked rows?"
               left-to-right. -->
          <template v-if="selectedEpisodes.size > 0">
            <button
              class="btn btn-sm btn-secondary"
              :disabled="bulkMarking"
              :title="`Mark all ${selectedEpisodes.size} selected episode(s) as already done. Asks for confirmation. Reversible.`"
              @click="bulkMarkSelected(true)"
            >
              {{ bulkMarking ? 'Working…' : `✓ Mark ${selectedEpisodes.size} as done` }}
            </button>
            <button
              class="btn btn-sm btn-secondary"
              :disabled="bulkMarking"
              :title="`Unmark all ${selectedEpisodes.size} selected episode(s). Asks for confirmation. Status falls back to file detection.`"
              @click="bulkMarkSelected(false)"
            >
              ↻ Unmark {{ selectedEpisodes.size }}
            </button>
            <span class="ep-actions-divider" aria-hidden="true" />
          </template>

          <!-- Global selection (across all pages, respects current filter) -->
          <button class="btn btn-sm btn-secondary" :title="selectButtonTitle" @click="selectAllPending">Select all pending</button>
          <button class="btn btn-sm btn-secondary" :title="selectAllTitle" @click="selectAll">Select all</button>

          <span class="ep-actions-divider" aria-hidden="true" />

          <!-- Page-scoped selection — quick way to grab just the visible
               page so you can review + mark-done one page at a time. -->
          <button
            class="btn btn-sm btn-secondary"
            title="Select only the episodes visible on this page (respects current sort + filter)."
            @click="selectAllOnPage"
          >Select page</button>
          <button
            class="btn btn-sm btn-secondary"
            title="Select only this page's episodes that still need at least one core step. Adds to the existing selection."
            @click="selectAllPendingOnPage"
          >Select pending on page</button>

          <span class="ep-actions-divider" aria-hidden="true" />

          <button class="btn btn-sm btn-secondary" @click="selectNone">Clear</button>
          <button class="btn btn-sm btn-ghost" :disabled="epLoading || epRevalidating" @click="onRefreshClick" title="Refresh episode statuses. Shift-click for a deeper rescan that wipes the on-disk cache too — use after iCloud delivers files from another Mac.">
            {{ (epLoading || epRevalidating) ? '⟳ Refreshing…' : '↻ Refresh' }}
          </button>
        </div>
      </div>

      <!-- Sort + filter + page-size toolbar. Scales the list to 100+ episodes
           without overwhelming the viewport. Sort + filter are derivations
           on `episodes.value` (no network calls); pagination is a pure
           slice. Selection checkboxes live in a Set keyed by episode_code,
           so selecting across multiple pages or after filter changes keeps
           the user's intent intact. -->
      <div v-if="episodes.length" class="episode-toolbar mt-2">
        <!-- Search by episode code or title. Mirrors the Ideas page's search
             box at the front of its filter row. Empty = no filter. -->
        <div class="toolbar-group toolbar-search">
          <input
            v-model="searchQuery"
            class="input input-sm pipeline-search-input"
            type="search"
            placeholder="Search episode code or title…"
            title="Filter the list to episodes whose code or title contains this text. Combines with the Show filter on the right."
          />
          <button
            v-if="searchQuery"
            type="button"
            class="search-clear-btn"
            title="Clear search"
            aria-label="Clear search"
            @click="searchQuery = ''"
          >✕</button>
        </div>

        <div class="toolbar-group">
          <label class="toolbar-label">Sort</label>
          <select v-model="sortKey" class="select input-sm">
            <option value="code-asc">Episode code · oldest first</option>
            <option value="code-desc">Episode code · newest first</option>
            <option value="title">Title · A → Z</option>
            <option value="missing-desc">Most missing steps first</option>
            <option value="missing-asc">Fewest missing first (nearly done)</option>
          </select>
        </div>

        <div class="toolbar-group">
          <label class="toolbar-label">Show</label>
          <select
            v-model="filterMode"
            class="select input-sm"
            title="Narrow the list to episodes missing a specific pipeline step. Counts reflect how many episodes are missing that step."
          >
            <optgroup label="Overview">
              <option value="all">All episodes ({{ episodes.length }})</option>
              <option value="missing-only">Missing any core component ({{ pendingEpisodesCount }})</option>
            </optgroup>
            <optgroup label="Missing a specific step">
              <option value="missing-script">Missing script ({{ missingCountByStep['script-only'] }})</option>
              <option value="missing-introduction">Missing introduction ({{ missingCountByStep['introduction-only'] }})</option>
              <option value="missing-image-prompts">Missing image prompts ({{ missingCountByStep['image_prompts'] }})</option>
              <option value="missing-images">Missing images ({{ missingCountByStep['images'] }})</option>
              <option value="missing-audio">Missing audio ({{ missingCountByStep['audio'] }})</option>
              <option value="missing-audio-merge">Missing merged audio ({{ missingCountByStep['audio_merge'] }})</option>
              <option value="missing-metadata">Missing metadata ({{ missingCountByStep['metadata'] }})</option>
              <option value="missing-video">Missing video ({{ missingCountByStep['video'] }})</option>
              <option value="missing-video-assembly">Missing video assembly ({{ missingCountByStep['video_assembly'] }})</option>
            </optgroup>
          </select>
          <span
            v-if="filterMode !== 'all'"
            class="filter-hit-badge"
            :title="`${filteredHitCount} episode(s) match the current filter`"
          >{{ filteredHitCount }} match</span>
        </div>

        <div class="toolbar-group">
          <label class="toolbar-label">Per page</label>
          <select v-model.number="pageSize" class="select input-sm">
            <option :value="10">10</option>
            <option :value="20">20</option>
            <option :value="50">50</option>
            <option :value="100">100</option>
          </select>
        </div>

        <div class="toolbar-count">
          {{ visibleRangeText }}
        </div>
      </div>

      <div v-if="epLoading && !episodes.length" class="text-muted mt-2" style="font-size:13px">
        <LoadingSpinner size="sm" /> Loading episodes…
      </div>

      <div v-else-if="!episodes.length" class="text-muted mt-2" style="font-size:13px">
        No accepted ideas yet. Go to <NuxtLink :to="`/projects/${slug}/ideas`">Ideas Generator</NuxtLink> and accept some first.
      </div>

      <div v-else-if="!sortedFilteredEpisodes.length" class="text-muted mt-2" style="font-size:13px">
        No episodes match the current filter. Switch "Show" back to All to see everything.
      </div>

      <div v-else class="episode-list mt-2">
        <label
          v-for="ep in paginatedEpisodes"
          :key="ep.episode_code"
          class="episode-row"
          :class="{
            selected: selectedEpisodes.has(ep.episode_code),
            'marked-done': ep.marked_done,
          }"
        >
          <input type="checkbox" :checked="selectedEpisodes.has(ep.episode_code)" @change="toggleEpisode(ep.episode_code)" />
          <div class="ep-main">
            <div class="ep-head">
              <strong>{{ ep.episode_code }}</strong>
              <span class="ep-title">{{ ep.title }}</span>
              <!-- Manual-done pill: visible only when the user explicitly
                   flagged this episode "already done" (e.g. for YouTube
                   imports the pipeline should stop nagging about). The pill
                   is the at-a-glance signal that this row's green pills come
                   from a manual override, not from file detection. -->
              <span
                v-if="ep.marked_done"
                class="manual-done-pill"
                title="This episode was manually marked done — file detection is bypassed. Use the menu (⋮) to revert."
              >✓ Done (manual)</span>
            </div>
            <!-- Per-step completion indicator. One pill per pipeline step,
                 same order + icons as the step-tile list above so the row
                 reads like a progress bar. Done steps are solid green with
                 a ✓ corner marker; missing steps are muted so the gaps are
                 visible at a glance. Done-ness uses the same truth table as
                 the backend's isStepAlreadyDone(), so pills never disagree
                 with the skip logic. -->
            <div class="ep-status">
              <span
                v-for="step in stepsMeta"
                :key="step.id"
                :class="[
                  'ep-pill',
                  isStepDoneForEpisode(step.id, ep.status) ? 'done' : 'missing',
                  isStepManualForEpisode(step.id, ep) ? 'manual' : '',
                ]"
                :title="pillTitle(step, ep)"
              >
                {{ step.icon }}
              </span>
            </div>
          </div>
          <!-- Per-episode kebab menu. Wraps in a click.stop'ed div so
               clicking the trigger doesn't toggle the row checkbox (which
               would happen if the click bubbled up to the wrapping label).
               The menu sits in a portal-free absolute popover anchored to
               the button — sufficient for the row count we expect. -->
          <div class="ep-kebab" @click.prevent.stop>
            <button
              class="kebab-trigger"
              :aria-expanded="openKebabFor === ep.episode_code"
              :aria-label="`Actions for ${ep.episode_code}`"
              title="More actions"
              @click="toggleKebab(ep.episode_code, $event)"
            >⋮</button>
            <!-- Teleport to <body> with fixed positioning so the menu can
                 never be clipped by the surrounding scroll container or
                 the page-content overflow. positionKebabFor() computes
                 top/left from the trigger's bounding rect when opening,
                 and auto-flips upward if there's not enough room below. -->
            <Teleport to="body">
              <div
                v-if="openKebabFor === ep.episode_code && kebabPos"
                class="kebab-menu"
                role="menu"
                :style="{
                  top: kebabPos.top + 'px',
                  left: kebabPos.left + 'px',
                  width: kebabPos.width + 'px',
                }"
              >
                <button
                  v-if="!ep.marked_done"
                  class="kebab-item"
                  role="menuitem"
                  @click="onMarkDone(ep, true)"
                >
                  <span class="kebab-icon">✓</span>
                  <div class="kebab-body">
                    <strong>Mark as already done</strong>
                    <span class="kebab-hint">Stop the pipeline from nagging about this episode. Useful for YouTube imports.</span>
                  </div>
                </button>
                <button
                  v-else
                  class="kebab-item"
                  role="menuitem"
                  @click="onMarkDone(ep, false)"
                >
                  <span class="kebab-icon">↻</span>
                  <div class="kebab-body">
                    <strong>Unmark — revert to file detection</strong>
                    <span class="kebab-hint">Drop the manual override. Asset state will reflect what's actually on disk.</span>
                  </div>
                </button>
                <button
                  class="kebab-item"
                  role="menuitem"
                  @click="openImportFor(ep)"
                >
                  <span class="kebab-icon">📥</span>
                  <div class="kebab-body">
                    <strong>Import existing assets…</strong>
                    <span class="kebab-hint">Copy weirdly-named files from disk into the canonical episode folders.</span>
                  </div>
                </button>
                <button
                  class="kebab-item"
                  role="menuitem"
                  @click="openOverridesFor(ep)"
                >
                  <span class="kebab-icon">⚙</span>
                  <div class="kebab-body">
                    <strong>Edit asset overrides…</strong>
                    <span class="kebab-hint">Pin individual asset states (Force ✓ / Force ✗ / Detect) for this episode.</span>
                  </div>
                </button>
              </div>
            </Teleport>
          </div>
        </label>
      </div>

      <!-- Asset import dialog — shared across all rows. importEpisode tracks
           which row the kebab launched it from. -->
      <AssetImportDialog
        v-if="importEpisode"
        :visible="!!importEpisode"
        :slug="slug"
        :episode-code="importEpisode.episode_code"
        :chapter-count="importEpisode.suggested_chapters"
        @close="importEpisode = null"
        @imported="onImported"
      />

      <!-- Per-asset override picker — same shared-instance pattern. -->
      <StatusOverridePicker
        v-if="overrideEpisode"
        :visible="!!overrideEpisode"
        :slug="slug"
        :episode-code="overrideEpisode.episode_code"
        :initial="overrideEpisode.status_overrides as any"
        @close="overrideEpisode = null"
        @saved="onOverridesSaved"
      />

      <!-- Pagination controls — shown whenever the filtered set exceeds
           the page-size threshold. Prev/Next bracket a compact page
           indicator; selected episodes persist across pages because
           `selectedEpisodes` is keyed by episode_code, independent of
           which slice is currently visible. -->
      <div v-if="totalPages > 1" class="pagination mt-2">
        <button class="btn btn-sm btn-secondary" :disabled="currentPage <= 1" @click="goToPage(1)" title="First page">« First</button>
        <button class="btn btn-sm btn-secondary" :disabled="currentPage <= 1" @click="goToPage(currentPage - 1)">← Prev</button>
        <span class="page-indicator">
          Page <strong>{{ currentPage }}</strong> of {{ totalPages }}
        </span>
        <button class="btn btn-sm btn-secondary" :disabled="currentPage >= totalPages" @click="goToPage(currentPage + 1)">Next →</button>
        <button class="btn btn-sm btn-secondary" :disabled="currentPage >= totalPages" @click="goToPage(totalPages)" title="Last page">Last »</button>
      </div>

      <div v-if="episodes.length" class="selection-summary mt-2 text-muted" style="font-size:12px">
        <strong>{{ selectedEpisodes.size }}</strong> of {{ episodes.length }} episode(s) selected · queued jobs = {{ selectedEpisodes.size * checkedStepCount }}
        <template v-if="filterMode === 'missing-only' || sortKey !== 'code-asc'">
          · showing <strong>{{ sortedFilteredEpisodes.length }}</strong> after filter/sort
        </template>
      </div>
    </div>

    <!-- ── Blocking problems summary ────────────────────────────────────── -->
    <div v-if="blockingIssues.length" class="card mt-2 problems-card">
      <strong>⚠ Can't start yet</strong>
      <ul class="mt-1" style="font-size:13px; padding-left:18px">
        <li v-for="(msg, i) in blockingIssues" :key="i">{{ msg }}</li>
      </ul>
    </div>


    <!-- ── Confirmation modal ───────────────────────────────────────────── -->
    <Modal :visible="showConfirm" size="md" labelledby="batch-confirm-title" @close="showConfirm = false">
      <h3 id="batch-confirm-title">Run batch?</h3>
      <p class="text-muted mt-1" style="font-size:13px">
        About to queue <strong>{{ selectedEpisodes.size * checkedStepCount }}</strong> job(s):
        <strong>{{ selectedEpisodes.size }}</strong> episodes ×
        <strong>{{ checkedStepCount }}</strong> step(s) each.
      </p>
      <div class="chain-preview">
        <span v-for="(step, i) in checkedStepsOrdered" :key="step.id" class="chain-step">
          <span class="chain-icon" aria-hidden="true">{{ step.icon }}</span>
          <span>{{ step.label }}</span>
          <span v-if="i < checkedStepsOrdered.length - 1" class="chain-arrow">→</span>
        </span>
      </div>
      <p class="text-muted mt-2" style="font-size:12px">
        Steps within each episode run in order. Different episodes' steps run
        concurrently when the queue has capacity. If a step fails for an
        episode, that episode's chain stops; other episodes continue.
      </p>

      <!-- Force re-run toggle: skip-when-done is the default so routine
           runs over partially-complete episodes don't burn tokens on
           regeneration. Opt in here to regenerate regardless of existing
           output. -->
      <label class="force-rerun" :title="forceRerunTitle">
        <input type="checkbox" v-model="forceRerun" />
        <span class="force-rerun-label">
          Force re-run
          <span class="force-rerun-hint">
            — regenerate every selected step even if its output already exists. Spends tokens on work that's already done.
          </span>
        </span>
      </label>

      <div class="flex gap-2 mt-3" style="justify-content:flex-end">
        <button class="btn btn-secondary" :disabled="submitting" @click="showConfirm = false">Cancel</button>
        <button class="btn btn-primary" :disabled="submitting" @click="submit">
          <LoadingSpinner v-if="submitting" size="sm" />
          {{ submitting ? 'Queuing…' : (forceRerun ? 'Start batch (force)' : 'Start batch') }}
        </button>
      </div>
    </Modal>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ layout: 'dashboard' })
useHead({ title: 'Pipeline — Story Studio KH' })

const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { get, post, patch: patchApi } = useApi()
const { success, error: showError } = useToast()
const { ask } = useConfirm()
const { config } = useProject()

// ── Step metadata ──────────────────────────────────────────────────────
// ID matches the BatchStep enum on the backend (routes/pipeline.ts).
//
// `script-only` and `introduction-only` replaced the legacy coupled
// `script` step in M1. They live in separate checkboxes so users can
// run chapters without intros (or vice-versa for retro-fitting intros
// to already-generated scripts via the per-page UI). The intro step is
// gated on the script step in this UI — see `stepDisabled` below.
type StepId =
  | 'script-only' | 'introduction-only'
  | 'image_prompts' | 'images' | 'audio' | 'audio_merge'
  | 'metadata' | 'video' | 'video_assembly'
interface StepMeta {
  id: StepId
  label: string
  icon: string
  link: string
  presetList: string
  presetActive: string
  /** If true, unchecked by default — user must opt in. For cost-sensitive steps. */
  costly?: boolean
  /** Human-readable warning rendered on the step tile when costly. */
  warning?: string
}
// Order in this array is the chain order for each episode's batch run.
// script-only → introduction-only → metadata → image_prompts → images →
// (video if opted in) → audio → audio_merge → video_assembly.
// Metadata sits early so titles/descriptions are ready before any image work
// — image prompts and the post-merge metadata-driven exports both benefit.
const stepsMeta: StepMeta[] = [
  { id: 'script-only',       label: 'Script (chapters)', icon: '📝', link: '/scripts',        presetList: 'script_presets',          presetActive: 'script_last_preset_script' },
  { id: 'introduction-only', label: 'Introduction',      icon: '🎙', link: '/scripts',        presetList: 'script_presets',          presetActive: 'script_last_preset_introduction' },
  { id: 'metadata',          label: 'Metadata',          icon: '📄', link: '/metadata',       presetList: 'metadata_presets',        presetActive: 'metadata_last_preset' },
  { id: 'image_prompts',     label: 'Image Prompts',     icon: '🎨', link: '/image-prompts',  presetList: 'image_prompts_presets',   presetActive: 'image_prompts_last_preset' },
  { id: 'images',            label: 'Images (all)',      icon: '📸', link: '/images',         presetList: 'image_generator_presets', presetActive: 'image_generator_last_preset' },
  { id: 'video',             label: 'Video Clips',       icon: '🎬', link: '/video',          presetList: 'video_generator_presets', presetActive: 'video_generator_last_preset', costly: true, warning: '$0.50–$2 per clip — off by default' },
  { id: 'audio',             label: 'Audio (TTS)',       icon: '🎙', link: '/audio',          presetList: 'audio_generator_presets', presetActive: 'audio_generator_last_preset' },
  { id: 'audio_merge',       label: 'Audio Merge',       icon: '🎛', link: '/audio-merge',    presetList: 'audio_merge_presets',     presetActive: 'audio_merge_last_preset' },
  { id: 'video_assembly',    label: 'Video Assembly',    icon: '🎞', link: '/video-assembly', presetList: 'video_bundle_presets',    presetActive: 'video_bundle_last_preset' },
]
const stepChecked = reactive<Record<StepId, boolean>>({
  'script-only': true,
  'introduction-only': true,
  image_prompts: true, images: true, audio: true, audio_merge: true, metadata: true,
  video: false,             // opt-in because it's expensive
  // video_assembly defaults ON so "Run all pending" finishes episodes end
  // -to-end in one click. The chain mechanism guarantees it waits for its
  // inputs (audio_merge + images) — if an episode is missing either, that
  // episode's chain stops at the failing step and skips assembly
  // automatically while other episodes continue.
  video_assembly: true,
})

// Intro depends on script context. If the user unchecks Script (chapters),
// auto-uncheck Introduction so the batch never queues an intro step that
// has no chapter context to read. The user can re-enable both together.
watch(() => stepChecked['script-only'], (on) => {
  if (!on) stepChecked['introduction-only'] = false
})
// Metadata reads the finished script + intro to write titles/descriptions/
// tags. Without either, the generator has nothing to summarise — auto-uncheck
// it when its inputs disappear (mirrors the intro→script gate above).
watch(() => [stepChecked['script-only'], stepChecked['introduction-only']] as const, ([s, i]) => {
  if (!s || !i) stepChecked['metadata'] = false
})
function stepDisabled(stepId: StepId): boolean {
  if (stepId === 'introduction-only') return !stepChecked['script-only']
  if (stepId === 'metadata') return !stepChecked['script-only'] || !stepChecked['introduction-only']
  return false
}
function stepDisabledReason(stepId: StepId): string {
  if (stepId === 'introduction-only' && !stepChecked['script-only']) {
    return 'Introduction needs the Script (chapters) step — enable that first.'
  }
  if (stepId === 'metadata' && (!stepChecked['script-only'] || !stepChecked['introduction-only'])) {
    return 'Metadata needs both Script (chapters) and Introduction — enable those first.'
  }
  return ''
}

const checkedStepsOrdered = computed(() => stepsMeta.filter(s => stepChecked[s.id]))
const checkedStepCount = computed(() => checkedStepsOrdered.value.length)

// Legacy-fallback map. Scripts page uses typed presets (introduced when
// scripts.vue split into scriptPresets + introPresets), but older projects
// still carry the untyped `script_last_preset` key from pre-typing saves.
// Mirrors the fallback chain in electron/server/routes/pipeline.ts.
const LEGACY_ACTIVE_KEY: Partial<Record<StepId, string>> = {
  'script-only': 'script_last_preset',
  'introduction-only': 'script_last_preset',
}

// Type tag for the type-based last-resort fallback. When neither the typed
// nor legacy active pointer resolves to an existing preset, pick the most
// recently saved preset carrying this `type`. Unblocks the common state
// where the user saved typed presets but the active pointer is stale /
// missing (happens when the active-pointer key is dropped on older saves
// or when the user removed the active preset without re-selecting one).
const TYPE_FOR_STEP: Partial<Record<StepId, string>> = {
  'script-only': 'script',
  'introduction-only': 'introduction',
}

function presetNameFor(stepId: StepMeta['id']): string {
  const meta = stepsMeta.find(s => s.id === stepId)!
  const cfg = config.value as any
  const list: any[] = cfg?.[meta.presetList] || []

  // 1. Typed active pointer (canonical).
  const primary: string = cfg?.[meta.presetActive] || ''
  if (primary) {
    const p = list.find(x => x.id === primary)
    if (p) return p.name || ''
  }

  // 2. Legacy untyped active pointer.
  const legacyKey = LEGACY_ACTIVE_KEY[stepId]
  if (legacyKey) {
    const legacy: string = cfg?.[legacyKey] || ''
    if (legacy) {
      const p = list.find(x => x.id === legacy)
      if (p) return p.name || ''
    }
  }

  // 3. Type-based auto-resolve (last-resort). Save-order in usePresets is
  //    chronological (`allPresets.value.push(fresh)`), so the last entry
  //    of a matching type is the newest.
  const wantedType = TYPE_FOR_STEP[stepId]
  if (wantedType) {
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i]?.type === wantedType) return list[i].name || ''
    }
  }

  return ''
}

// ── Episode multi-select ───────────────────────────────────────────────
interface Episode {
  episode_code: string
  title: string
  status: Record<string, boolean>
  // Optional provenance + override fields (Pipeline page reads them for
  // the manual-done pill + per-step "(manual)" annotation; back-end may
  // still omit them on stale rows so all are optional).
  batch_id?: string
  marked_done?: boolean
  marked_done_at?: string | null
  status_overrides?: Record<string, boolean> | null
  // Optional metadata used by the asset import dialog (chapter count
  // primes the audio dropdown). Backend includes when available; UI
  // falls back to a generic 1-20 list when missing.
  suggested_chapters?: number
}
const selectedEpisodes = reactive(new Set<string>())

// Shared SWR cache so navigating away and back to /pipeline is instant.
// Auto-revalidates when any job for this slug completes — selection state
// stays intact because we only touch selectedEpisodes here, not episodes.
const { episodes, isLoading: epLoading, isRevalidating: epRevalidating, refresh: refreshEpisodes, rescan: rescanEpisodes, error: epError } = useEpisodes(slug)

// Surface the underlying load error in a toast (composable stores it but
// doesn't toast — page decides whether to show).
watch(epError, (e) => {
  if (e) showError((e as any)?.data?.detail || (e as any)?.message || 'Failed to load episodes')
})

async function loadEpisodes() { await refreshEpisodes() }

async function onRefreshClick(e: MouseEvent) {
  if (e.shiftKey) await rescanEpisodes()
  else await refreshEpisodes()
}

function toggleEpisode(code: string) {
  if (selectedEpisodes.has(code)) selectedEpisodes.delete(code)
  else selectedEpisodes.add(code)
}
// "Select all" and "Select all pending" operate on the CURRENT FILTER,
// not the full episode list — otherwise a user who's filtered to "missing
// only" and clicks Select all would silently pull in every done episode
// too, which is the opposite of what the filter signaled they wanted.
function selectAll() {
  for (const ep of sortedFilteredEpisodes.value) selectedEpisodes.add(ep.episode_code)
}
function selectNone() {
  selectedEpisodes.clear()
}

// Page-scoped variants. Identical logic to selectAll / selectAllPending
// but operate on `paginatedEpisodes` (just the visible 10/20/50/100) so
// the user can mark-done one page at a time without dragging in episodes
// they haven't reviewed yet on later pages.
function selectAllOnPage() {
  for (const ep of paginatedEpisodes.value) selectedEpisodes.add(ep.episode_code)
}

// ── Sort + filter + pagination ───────────────────────────────────────────
// All client-side — `episodes.value` is the full list from /episodes,
// these refs derive what's rendered. Designed for projects with 100+
// accepted ideas where the full list would otherwise be unscrollable.
type SortKey = 'code-asc' | 'code-desc' | 'title' | 'missing-desc' | 'missing-asc'
type FilterMode =
  | 'all'
  | 'missing-only'
  | 'missing-script'
  | 'missing-introduction'
  | 'missing-image-prompts'
  | 'missing-images'
  | 'missing-audio'
  | 'missing-audio-merge'
  | 'missing-metadata'
  | 'missing-video'
  | 'missing-video-assembly'

// Map filter modes to the underlying step id. Used by both the filter
// predicate and the per-mode count badge so labels and filtering stay
// aligned without a second lookup table.
const FILTER_MODE_TO_STEP: Partial<Record<FilterMode, StepId>> = {
  'missing-script': 'script-only',
  'missing-introduction': 'introduction-only',
  'missing-image-prompts': 'image_prompts',
  'missing-images': 'images',
  'missing-audio': 'audio',
  'missing-audio-merge': 'audio_merge',
  'missing-metadata': 'metadata',
  'missing-video': 'video',
  'missing-video-assembly': 'video_assembly',
}

const sortKey = ref<SortKey>('code-asc')
const filterMode = ref<FilterMode>('all')
const pageSize = ref<10 | 20 | 50 | 100>(10)
const currentPage = ref(1)
// Free-text search across episode_code + title. Mirrors the Ideas page's
// search box. Pure derivation; no network call. Empty string = no filter.
const searchQuery = ref('')

// Count missing CORE steps per episode. Video (AI per-scene generation)
// is opt-in and costly, so it's excluded. video_assembly IS included —
// finishing an episode end-to-end requires the assembled final video,
// and including it here lets "Run all pending" batch the full flow in
// one click (assembly waits for its inputs via the chain mechanism).
const CORE_STEP_IDS: StepId[] = [
  'script-only', 'introduction-only', 'image_prompts',
  'images', 'audio', 'audio_merge', 'metadata', 'video_assembly',
]

function missingCoreSteps(ep: Episode): number {
  let n = 0
  for (const id of CORE_STEP_IDS) {
    if (!isStepDoneForEpisode(id, ep.status)) n++
  }
  return n
}

// Natural sort for episode codes so TN0002 comes before TN0010 (not
// string-sorted "TN0010" < "TN0002" < "TN0011"). Falls back to locale
// compare for anything the regex doesn't match.
function compareEpisodeCodes(a: string, b: string): number {
  const re = /^([A-Za-z]+)(\d+)/
  const ma = a.match(re); const mb = b.match(re)
  const mA1 = ma?.[1], mA2 = ma?.[2], mB1 = mb?.[1], mB2 = mb?.[2]
  if (mA1 && mB1 && mA2 && mB2 && mA1 === mB1) {
    return parseInt(mA2, 10) - parseInt(mB2, 10)
  }
  return a.localeCompare(b)
}

const sortedFilteredEpisodes = computed<Episode[]>(() => {
  let filtered: Episode[]
  const targetStep = FILTER_MODE_TO_STEP[filterMode.value]
  if (targetStep) {
    filtered = episodes.value.filter(ep => !isStepDoneForEpisode(targetStep, ep.status))
  } else if (filterMode.value === 'missing-only') {
    filtered = episodes.value.filter(ep => missingCoreSteps(ep) > 0)
  } else {
    filtered = episodes.value.slice()
  }
  // Free-text narrow on episode_code + title. Case-insensitive substring
  // match. Composes after the dropdown filter so "Missing audio" + "TN0042"
  // does what you'd expect.
  const q = searchQuery.value.trim().toLowerCase()
  if (q) {
    filtered = filtered.filter(ep =>
      (ep.episode_code || '').toLowerCase().includes(q)
      || (ep.title || '').toLowerCase().includes(q),
    )
  }
  const sorted = filtered.slice()
  switch (sortKey.value) {
    case 'code-asc':
      sorted.sort((a, b) => compareEpisodeCodes(a.episode_code, b.episode_code))
      break
    case 'code-desc':
      sorted.sort((a, b) => compareEpisodeCodes(b.episode_code, a.episode_code))
      break
    case 'title':
      sorted.sort((a, b) => (a.title || '').localeCompare(b.title || ''))
      break
    case 'missing-desc':
      sorted.sort((a, b) => missingCoreSteps(b) - missingCoreSteps(a)
        || compareEpisodeCodes(a.episode_code, b.episode_code))
      break
    case 'missing-asc':
      sorted.sort((a, b) => missingCoreSteps(a) - missingCoreSteps(b)
        || compareEpisodeCodes(a.episode_code, b.episode_code))
      break
  }
  return sorted
})

const totalPages = computed(() => Math.max(1, Math.ceil(sortedFilteredEpisodes.value.length / pageSize.value)))

const paginatedEpisodes = computed<Episode[]>(() => {
  const start = (currentPage.value - 1) * pageSize.value
  return sortedFilteredEpisodes.value.slice(start, start + pageSize.value)
})

const pendingEpisodesCount = computed(() => episodes.value.filter(ep => missingCoreSteps(ep) > 0).length)

// Per-step missing counts — drives the count badges in the filter dropdown
// so users see "(4)" next to e.g. "Missing audio" before selecting it.
const missingCountByStep = computed<Record<StepId, number>>(() => {
  const ids: StepId[] = [
    'script-only', 'introduction-only', 'image_prompts',
    'images', 'audio', 'audio_merge', 'metadata',
    'video', 'video_assembly',
  ]
  const counts = {} as Record<StepId, number>
  for (const id of ids) counts[id] = 0
  for (const ep of episodes.value) {
    for (const id of ids) {
      if (!isStepDoneForEpisode(id, ep.status)) counts[id] = (counts[id] ?? 0) + 1
    }
  }
  return counts
})

// Active filter's hit count — surfaced as an inline badge next to the
// dropdown so the user immediately sees how narrowly their filter cuts.
const filteredHitCount = computed(() => sortedFilteredEpisodes.value.length)

const visibleRangeText = computed(() => {
  const total = sortedFilteredEpisodes.value.length
  if (total === 0) return '0 of 0'
  const start = (currentPage.value - 1) * pageSize.value + 1
  const end = Math.min(total, currentPage.value * pageSize.value)
  return `Showing ${start}–${end} of ${total}`
})

function goToPage(n: number) {
  const clamped = Math.max(1, Math.min(totalPages.value, Math.floor(n)))
  currentPage.value = clamped
}

// Reset to page 1 whenever filter, sort, or page-size changes — otherwise
// the user can land on an empty page after the list shrinks.
watch([filterMode, sortKey, pageSize, searchQuery], () => { currentPage.value = 1 })

// Clamp if the filtered list shrinks below the current page (e.g. episode
// finished and was filtered out of the missing-only view).
watch(totalPages, (tp) => { if (currentPage.value > tp) currentPage.value = tp })

const selectButtonTitle = computed(() => filterMode.value === 'missing-only'
  ? 'Select every episode currently shown (after the missing-only filter) that has a missing checked step'
  : 'Select every episode that has a missing checked step')

const selectAllTitle = computed(() => filterMode.value === 'missing-only'
  ? `Select all ${sortedFilteredEpisodes.value.length} episode(s) matching the current filter`
  : `Select all ${episodes.value.length} episode(s)`)
// Single truth table for "is this step done on this episode?", used by
// both selectAllPending AND the per-step pill indicator on each episode
// row. Mirrors the backend's isStepAlreadyDone() in routes/pipeline.ts
// so the UI pills, the pending selector, and the batch skip logic all
// agree.
//
// video_assembly has no canonical completion marker — treat as "not done"
// so the pill is a reminder rather than a false "✓ done". The skip
// logic on the backend declines to auto-skip video_assembly for the same
// reason.
function isStepDoneForEpisode(stepId: StepId, status: Record<string, boolean> | undefined): boolean {
  const s = status || {}
  switch (stepId) {
    case 'script-only':        return !!s.script
    case 'introduction-only':  return !!s.introduction
    case 'image_prompts':      return !!s.scene_prompts && !!s.thumb_prompts
    case 'images':             return !!s.images && !!s.thumbnails
    case 'audio':              return !!s.audio
    case 'audio_merge':        return !!s.merged_audio
    case 'metadata':           return !!s.metadata
    case 'video':              return !!s.video
    case 'video_assembly':     return !!s.video_assembly
  }
  return false
}

// "Pending" = not fully done across every selected step. Reuses the
// truth table above. video / video_assembly are deliberately EXCLUDED
// from the pending check — those are opt-in / costly steps. An episode
// that has the 7 core steps done should not be treated as pending just
// because it has no video.
function selectAllPending() {
  selectedEpisodes.clear()
  // Only AI per-scene video generation stays opt-in — video_assembly is
  // the final packaging step and we WANT the batch to include it so
  // "Run all pending" finishes episodes end-to-end.
  const EXCLUDED_FROM_PENDING: StepId[] = ['video']
  // Operate on the filtered set so "Select all pending" respects the
  // user's current filter choice. When the filter is "all", this is
  // every episode; when "missing-only", it's already the narrower pool.
  for (const ep of sortedFilteredEpisodes.value) {
    const needsAny = checkedStepsOrdered.value.some(step => {
      if (EXCLUDED_FROM_PENDING.includes(step.id)) return false
      return !isStepDoneForEpisode(step.id, ep.status)
    })
    if (needsAny) selectedEpisodes.add(ep.episode_code)
  }
}

// Page-scoped variant — same pending logic, scoped to just the visible
// page. Doesn't clear existing selection so the user can build a working
// set across pages if they really want to.
function selectAllPendingOnPage() {
  const EXCLUDED_FROM_PENDING: StepId[] = ['video']
  for (const ep of paginatedEpisodes.value) {
    const needsAny = checkedStepsOrdered.value.some(step => {
      if (EXCLUDED_FROM_PENDING.includes(step.id)) return false
      return !isStepDoneForEpisode(step.id, ep.status)
    })
    if (needsAny) selectedEpisodes.add(ep.episode_code)
  }
}

// ── Mark-done kebab menu ────────────────────────────────────────────────
// Per-episode action menu wired to the new mark-done route. Closes on any
// document click that isn't on a kebab trigger/menu — single global handler
// keeps the close-on-outside-click logic centralized rather than re-binding
// per row.
const openKebabFor = ref<string | null>(null)
const markingDone = ref<Set<string>>(new Set())

// Teleport-to-body coords for the kebab menu. Computed from the trigger
// button's bounding rect when the menu opens. Lets the menu escape the
// scrolling Episodes container (otherwise the menu on the last visible
// row gets clipped by the parent's overflow). Auto-flips upward when
// there's not enough room below the trigger.
const kebabPos = ref<{ top: number; left: number; width: number } | null>(null)
const KEBAB_MENU_WIDTH = 300         // matches min-width below + padding
const KEBAB_MENU_MAX_HEIGHT = 220    // tallest the menu gets with 4 items
const KEBAB_GAP = 4                  // px between trigger and menu

function positionKebabFor(triggerEl: HTMLElement) {
  const r = triggerEl.getBoundingClientRect()
  // Right-align the menu under the trigger by default.
  let left = r.right - KEBAB_MENU_WIDTH
  // Clamp to viewport with an 8px gutter so a narrow window still shows it fully.
  left = Math.max(8, Math.min(left, window.innerWidth - KEBAB_MENU_WIDTH - 8))
  // Auto-flip: if there's not enough space below, position above.
  const spaceBelow = window.innerHeight - r.bottom
  let top: number
  if (spaceBelow < KEBAB_MENU_MAX_HEIGHT + KEBAB_GAP) {
    top = r.top - KEBAB_GAP - KEBAB_MENU_MAX_HEIGHT
    // If above is also tight (extreme tiny window), pin to viewport top.
    if (top < 8) top = 8
  } else {
    top = r.bottom + KEBAB_GAP
  }
  kebabPos.value = { top, left, width: KEBAB_MENU_WIDTH }
}

function toggleKebab(code: string, ev?: MouseEvent) {
  if (openKebabFor.value === code) {
    openKebabFor.value = null
    kebabPos.value = null
    return
  }
  openKebabFor.value = code
  // Position the teleported menu against the actual trigger button. The
  // event target is the <button class="kebab-trigger"> the user clicked.
  const trigger = ev?.currentTarget as HTMLElement | undefined
  if (trigger) positionKebabFor(trigger)
}

function closeKebab() {
  openKebabFor.value = null
  kebabPos.value = null
}

function isStepManualForEpisode(stepId: StepId, ep: Episode): boolean {
  // Marked-done short-circuits everything — every pill is "manual".
  if (ep.marked_done) return true
  const ov = ep.status_overrides
  if (!ov) return false
  // Map step IDs back to the underlying status field(s). If any input
  // field for the step is overridden, the pill carries the (manual) hint.
  switch (stepId) {
    case 'script-only':       return 'script' in ov
    case 'introduction-only': return 'introduction' in ov
    case 'image_prompts':     return 'scene_prompts' in ov || 'thumb_prompts' in ov
    case 'images':            return 'images' in ov || 'thumbnails' in ov
    case 'audio':             return 'audio' in ov
    case 'audio_merge':       return 'merged_audio' in ov
    case 'metadata':          return 'metadata' in ov
    case 'video':             return 'video' in ov
    case 'video_assembly':    return 'video_assembly' in ov
  }
  return false
}

function pillTitle(step: StepMeta, ep: Episode): string {
  const done = isStepDoneForEpisode(step.id, ep.status)
  const manual = isStepManualForEpisode(step.id, ep)
  const status = done ? '✓ done' : 'missing'
  if (ep.marked_done) return `${step.label} — ${status} (whole episode marked done manually)`
  if (manual) return `${step.label} — ${status} (manual override)`
  return `${step.label} — ${status}`
}

// Asset import dialog launch state. importEpisode === null when closed;
// otherwise points at the episode the dialog is bound to. We re-use the
// same dialog component for every row (mounted only when open).
const importEpisode = ref<Episode | null>(null)
const overrideEpisode = ref<Episode | null>(null)

function openImportFor(ep: Episode) {
  closeKebab()
  importEpisode.value = ep
}

function openOverridesFor(ep: Episode) {
  closeKebab()
  overrideEpisode.value = ep
}

function onImported(_summary: any) {
  // Refresh the episode list so newly-imported assets show up in the
  // status pills. The backend invalidates its own cache; the frontend
  // composable refetches on demand.
  refreshEpisodes()
}

function onOverridesSaved(_payload: any) {
  // Override route invalidates the episode-status cache server-side;
  // refresh so the per-step pills (and (manual) annotation) update.
  refreshEpisodes()
}

async function onMarkDone(ep: Episode, done: boolean) {
  if (markingDone.value.has(ep.episode_code)) return
  markingDone.value.add(ep.episode_code)
  closeKebab()
  // Optimistic toggle — flip the local field immediately so the row
  // re-renders with the manual pill and dimmed pills before the network
  // round-trip completes. If the request fails we roll back via the
  // catch branch.
  const prev = ep.marked_done
  ep.marked_done = done
  try {
    await patchApi(`/projects/${slug.value}/episodes/${ep.episode_code}/mark-done`, { done })
    // Force a refresh — the per-step status fields haven't changed locally
    // (they reflect file detection), so triggering a refetch ensures the
    // server's recomputed override-applied status replaces our optimistic
    // copy on the next paint.
    await refreshEpisodes()
    success(done ? `${ep.episode_code} marked done` : `${ep.episode_code} reverted to file detection`)
  } catch (e: any) {
    ep.marked_done = prev
    showError(e?.data?.detail || 'Failed to update mark-done state')
  } finally {
    markingDone.value.delete(ep.episode_code)
  }
}

// ── Bulk mark/unmark (operates on the current checkbox selection) ──────
// Sequential with a small concurrency cap so we don't fire 100 PATCH
// requests at once if the user selects everything. Per-episode failures
// don't block the rest — we collect counts and surface them in a toast
// at the end.
const bulkMarking = ref(false)

async function bulkMarkSelected(done: boolean) {
  if (bulkMarking.value) return
  const codes = Array.from(selectedEpisodes)
  if (!codes.length) return

  // Filter out no-ops (already in target state) so the confirm count and
  // the toast counts both reflect actual work.
  const toUpdate: Episode[] = []
  let alreadyInState = 0
  for (const code of codes) {
    const ep = episodes.value.find(e => e.episode_code === code)
    if (!ep) continue
    if (!!ep.marked_done === done) alreadyInState++
    else toUpdate.push(ep)
  }

  if (!toUpdate.length) {
    success(done
      ? `All ${alreadyInState} selected episode(s) are already marked done.`
      : `None of the ${alreadyInState} selected episode(s) are currently marked done.`,
    )
    return
  }

  // Confirm dialog — same pattern as the existing per-episode flow uses
  // (TopActionBar's preset delete). danger=true gives the destructive-action
  // styling. Spell out exactly what the action does so the user can't be
  // surprised by it.
  const ok = await ask({
    title: done
      ? `Mark ${toUpdate.length} episode(s) as already done?`
      : `Unmark ${toUpdate.length} episode(s)?`,
    message: done
      ? `Stops the pipeline from nagging about ${toUpdate.length} episode${toUpdate.length === 1 ? '' : 's'}. ${alreadyInState ? `(${alreadyInState} already-marked episode${alreadyInState === 1 ? '' : 's'} in the selection will be skipped.)` : ''} No files are deleted — fully reversible from the per-episode menu or with "Unmark selected".`
      : `Drops the manual override on ${toUpdate.length} episode${toUpdate.length === 1 ? '' : 's'} so their status reflects what's actually on disk. ${alreadyInState ? `(${alreadyInState} unmarked episode${alreadyInState === 1 ? '' : 's'} in the selection will be skipped.)` : ''} No files are deleted.`,
    confirmLabel: done ? 'Mark done' : 'Unmark',
    danger: !done,    // unmark feels more destructive (drops an override the user explicitly set)
  })
  if (!ok) return

  bulkMarking.value = true
  let okCount = 0
  let failCount = 0
  const CONCURRENCY = 5
  try {
    // Optimistic flip across the batch first so the UI feels snappy. We
    // roll back failed ones below.
    for (const ep of toUpdate) ep.marked_done = done
    for (const ep of toUpdate) markingDone.value.add(ep.episode_code)

    // Run in chunks of CONCURRENCY at a time. Promise.all per chunk keeps
    // the loop simple without needing a real concurrency-limiter library.
    for (let i = 0; i < toUpdate.length; i += CONCURRENCY) {
      const chunk = toUpdate.slice(i, i + CONCURRENCY)
      const results = await Promise.all(chunk.map(async (ep) => {
        try {
          await patchApi(`/projects/${slug.value}/episodes/${ep.episode_code}/mark-done`, { done })
          return { ep, ok: true }
        } catch (e: any) {
          return { ep, ok: false, err: e?.data?.detail || e?.message }
        }
      }))
      for (const r of results) {
        if (r.ok) okCount++
        else { failCount++; r.ep.marked_done = !done /* rollback */ }
      }
    }

    // Pull the server's recomputed override-applied status. Same reasoning
    // as the single-episode handler — file-detection pills haven't changed
    // locally so we need a refetch to see the truth.
    await refreshEpisodes()

    const verb = done ? 'marked done' : 'unmarked'
    if (failCount === 0) {
      success(`${okCount} episode${okCount === 1 ? '' : 's'} ${verb}${alreadyInState ? ` · ${alreadyInState} skipped (already in state)` : ''}.`)
    } else if (okCount === 0) {
      showError(`Bulk ${verb} failed for all ${failCount} episode(s). Check the network or backend.`)
    } else {
      showError(`${okCount} ${verb}, ${failCount} failed${alreadyInState ? `, ${alreadyInState} skipped` : ''}. Failed rows reverted.`)
    }
  } finally {
    for (const ep of toUpdate) markingDone.value.delete(ep.episode_code)
    bulkMarking.value = false
  }
}

// Outside-click + scroll + key handlers. The menu is teleported to <body>
// with fixed positioning, so:
//   - outside-click test must accept clicks inside .kebab-menu (it's no
//     longer a descendant of .ep-kebab in the DOM tree)
//   - we close on scroll because fixed positioning leaves the menu
//     anchored to the viewport, not the trigger — when the user scrolls
//     the row away, the menu would otherwise float orphaned. Closing is
//     simpler than re-positioning continuously and matches native menus.
if (typeof window !== 'undefined') {
  const onDocClick = (e: MouseEvent) => {
    if (!openKebabFor.value) return
    const t = e.target as HTMLElement | null
    if (t && (t.closest('.ep-kebab') || t.closest('.kebab-menu'))) return
    closeKebab()
  }
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeKebab() }
  // Capture phase so we catch scroll events on any ancestor (the
  // <main class="main-content"> scroll container, the window, etc.).
  const onScroll = () => { if (openKebabFor.value) closeKebab() }
  onMounted(() => {
    document.addEventListener('click', onDocClick)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
  })
  onBeforeUnmount(() => {
    document.removeEventListener('click', onDocClick)
    document.removeEventListener('keydown', onKey)
    window.removeEventListener('scroll', onScroll, true)
  })
}

// ── Validation ─────────────────────────────────────────────────────────
const blockingIssues = computed<string[]>(() => {
  const issues: string[] = []
  if (checkedStepCount.value === 0) issues.push('Pick at least one step to run.')
  if (selectedEpisodes.size === 0) issues.push('Select at least one episode.')
  for (const step of checkedStepsOrdered.value) {
    if (!presetNameFor(step.id)) {
      issues.push(`No active preset for "${step.label}". Open that generator page, apply a preset, then come back.`)
    }
  }
  return issues
})

const canRun = computed(() => blockingIssues.value.length === 0 && !submitting.value)
const runButtonLabel = computed(() => {
  if (selectedEpisodes.size === 0 || checkedStepCount.value === 0) return 'Run Batch'
  return `Run Batch (${selectedEpisodes.size * checkedStepCount.value} jobs)`
})

// ── Submit ─────────────────────────────────────────────────────────────
const submitting = ref(false)
const showConfirm = ref(false)
// Force re-run: opt-in to regenerate every selected step even if its
// output already exists on disk. Off by default so routine batch runs
// don't silently burn tokens on work that's already done.
const forceRerun = ref(false)
const forceRerunTitle = computed(() => forceRerun.value
  ? 'Force re-run is ON — every selected step will run for every selected episode, regardless of existing output.'
  : 'Force re-run is OFF — steps whose output already exists will be skipped automatically.')

function openConfirm() {
  if (!canRun.value) return
  showConfirm.value = true
}

async function submit() {
  if (!canRun.value) return
  submitting.value = true
  try {
    const body = {
      episode_ids: [...selectedEpisodes],
      steps: checkedStepsOrdered.value.map(s => s.id),
      force: forceRerun.value,
    }
    const r = await post<any>(`/projects/${slug.value}/pipeline/run-batch`, body)
    showConfirm.value = false
    const { enqueued, skipped, total_jobs_planned, steps_skipped_as_done } = r || {}
    const skipDoneCount = Array.isArray(steps_skipped_as_done) ? steps_skipped_as_done.length : 0
    const parts: string[] = []
    parts.push(`Queued ${enqueued} chain(s) — ${total_jobs_planned} total jobs`)
    if (skipDoneCount > 0) parts.push(`${skipDoneCount} step(s) skipped as already complete`)
    if (skipped?.length) parts.push(`${skipped.length} episode(s) skipped — see Jobs tab`)
    success(parts.join(' · '))
    // Let the user watch it unfold without manual navigation:
    navigateTo(`/projects/${slug.value}/jobs`)
  } catch (e: any) {
    const missing = e?.data?.missing
    if (Array.isArray(missing) && missing.length) {
      showError(missing.map((m: any) => m.reason).join(' '))
    } else {
      showError(e?.data?.detail || 'Batch failed to start')
    }
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
/* ── Steps grid ───────────────────────────────────────────────────────── */
.steps-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 10px;
}
.step-tile {
  display: flex;
  gap: 10px;
  padding: 12px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.step-tile.selected { border-color: var(--accent); background: rgba(240, 198, 116, 0.06); }
.step-tile.missing  { border-color: rgb(180, 83, 9); background: rgba(245, 158, 11, 0.08); }
.step-tile.costly { border-style: dashed; }
.step-tile.disabled { opacity: 0.55; cursor: not-allowed; }
.step-tile.disabled input { cursor: not-allowed; }
.step-warning { margin-top: 4px; font-size: 11px; color: rgb(180, 83, 9); }
.step-body { flex: 1; }
.step-head { display: flex; align-items: center; gap: 8px; }
.step-icon { font-size: 16px; }
.step-preset { margin-top: 4px; font-size: 11px; color: var(--text-muted); }
.preset-name { color: var(--accent); font-weight: 500; }
.preset-missing { color: rgb(180, 83, 9); }
.preset-link { color: var(--accent); text-decoration: underline; }

/* ── Episode list ─────────────────────────────────────────────────────── */
.episode-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 52vh;
  overflow-y: auto;
  padding: 2px;
}
.episode-row {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 12px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.episode-row.selected { border-color: var(--accent); background: rgba(240, 198, 116, 0.06); }
.episode-row:hover { border-color: var(--accent); }
.ep-main { flex: 1; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.ep-head { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
.ep-title { color: var(--text-secondary); font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ep-status { display: flex; gap: 6px; font-size: 13px; flex-wrap: wrap; }
.ep-pill {
  position: relative;
  display: inline-flex; align-items: center; justify-content: center;
  width: 24px; height: 24px;
  border-radius: 50%;
  font-size: 12px;
  transition: opacity 0.15s, filter 0.15s, background 0.15s;
  cursor: help;
}

/* Completed step: solid green + small ✓ tick in the corner so a row of 9
   icons reads as an at-a-glance progress bar. */
.ep-pill.done {
  background: rgba(46, 160, 67, 0.18);
  border: 1px solid rgba(46, 160, 67, 0.35);
  color: var(--text-primary);
}
.ep-pill.done::after {
  content: '✓';
  position: absolute;
  right: -2px; bottom: -2px;
  width: 11px; height: 11px;
  line-height: 10px;
  border-radius: 50%;
  background: var(--success, #3fb950);
  color: white;
  font-size: 9px;
  font-weight: 700;
  text-align: center;
}

/* Missing step: visibly greyed out, no border, low opacity so the eye
   lands on the done ones. Still visible enough to show which icon it is. */
.ep-pill.missing {
  background: var(--bg-primary, rgba(0, 0, 0, 0.2));
  border: 1px dashed var(--border);
  opacity: 0.4;
  filter: grayscale(1);
}

/* Backward-compat aliases for any consumer still using the old classes.
   Remove once we're sure nothing references them. */
.ep-pill.ok { background: rgba(46, 160, 67, 0.18); color: var(--text-primary); }
.ep-pill.pending { opacity: 0.4; filter: grayscale(1); }

.selection-summary { padding: 4px 2px; }

/* ── Episode-list toolbar (sort / filter / page-size) ───────────────── */
.episode-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 18px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-tertiary);
  font-size: 12px;
}
.toolbar-group {
  display: flex;
  align-items: center;
  gap: 6px;
}
.toolbar-label {
  color: var(--text-muted);
  font-weight: 500;
}

/* Episode-actions row — same flex layout as the inline `.flex.gap-2` it
   replaced, but with a defined class so we can style the dividers. */
.ep-actions-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
/* Visual divider between groups (bulk · global · page · clear/refresh).
   Thin vertical bar, slightly muted, just enough to read at a glance. */
.ep-actions-divider {
  display: inline-block;
  width: 1px;
  height: 18px;
  background: var(--border);
  margin: 0 2px;
}

/* Search input + clear button. Sits at the front of the toolbar so it
   reads naturally left-to-right ("find in this list, then sort/filter"). */
.toolbar-search {
  position: relative;
  flex: 1 1 240px;
  max-width: 320px;
}
.pipeline-search-input {
  width: 100%;
  padding-right: 26px;          /* leave room for the ✕ button */
}
.search-clear-btn {
  position: absolute;
  right: 4px;
  top: 50%;
  transform: translateY(-50%);
  background: transparent;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  padding: 4px 6px;
  border-radius: 4px;
}
.search-clear-btn:hover { color: var(--text-primary); background: var(--bg-hover); }
.toolbar-count {
  margin-left: auto;
  color: var(--text-muted);
  font-size: 12px;
}
.filter-hit-badge {
  display: inline-flex;
  align-items: center;
  padding: 1px 7px;
  font-size: 11px;
  font-weight: 500;
  border-radius: 999px;
  background: var(--accent-dim);
  color: var(--accent);
}

/* ── Pagination ───────────────────────────────────────────────────── */
.pagination {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 2px;
  flex-wrap: wrap;
}
.page-indicator {
  font-size: 12px;
  color: var(--text-secondary);
  margin: 0 6px;
}

/* ── Problems card ────────────────────────────────────────────────────── */
.problems-card { border-color: rgba(245, 158, 11, 0.4); background: rgba(245, 158, 11, 0.05); }

/* ── Confirm modal chain preview ──────────────────────────────────────── */
.chain-preview {
  display: flex; align-items: center; gap: 4px;
  flex-wrap: wrap;
  margin-top: 12px;
  padding: 10px 14px;
  background: var(--bg-tertiary);
  border-radius: var(--radius-sm);
  font-size: 13px;
}
.chain-step {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 10px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 999px;
}
.chain-arrow { margin: 0 4px; color: var(--text-muted); }
.chain-icon { font-size: 14px; }

/* ── Force re-run toggle (confirm modal) ──────────────────────────────── */
.force-rerun {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 14px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-tertiary);
  cursor: pointer;
  font-size: 12px;
  line-height: 1.4;
}
.force-rerun input[type="checkbox"] {
  margin-top: 2px;
  flex-shrink: 0;
  cursor: pointer;
}
.force-rerun-label {
  color: var(--text-primary);
  font-weight: 500;
}
.force-rerun-hint {
  color: var(--text-muted);
  font-weight: 400;
}

/* ── Manual-done state (mark-done overhaul) ───────────────────────────── */

/* The whole row gets a subtle green wash + slimmed asset pills so the
   "manual" state reads at a glance even when the menu's closed. */
.episode-row.marked-done {
  border-color: rgba(46, 160, 67, 0.45);
  background: rgba(46, 160, 67, 0.04);
}
.episode-row.marked-done .ep-pill {
  /* Done pills already look right; missing pills go invisible since the
     manual-done flag overrides file detection — there's nothing to fix. */
  opacity: 0.7;
}

/* Pill shown next to the title for marked-done rows. Conveys "this state
   came from a user action, not detection". Click the kebab menu to revert. */
.manual-done-pill {
  display: inline-flex;
  align-items: center;
  padding: 1px 8px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.02em;
  border-radius: 999px;
  background: rgba(46, 160, 67, 0.18);
  color: var(--success, #3fb950);
  border: 1px solid rgba(46, 160, 67, 0.35);
  white-space: nowrap;
}

/* Per-step pill annotation when an individual override is in play (not the
   whole-episode mark-done). Subtle yellow ring distinguishes "manual" from
   "file-detected" without losing the green/grey done/missing distinction. */
.ep-pill.manual {
  outline: 1px solid rgba(240, 198, 116, 0.6);
  outline-offset: 1px;
}

/* ── Per-row kebab menu ──────────────────────────────────────────────── */
.ep-kebab {
  position: relative;
  flex-shrink: 0;
}
.kebab-trigger {
  width: 28px; height: 28px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s, color 0.12s;
}
.kebab-trigger:hover,
.kebab-trigger[aria-expanded="true"] {
  background: var(--bg-secondary);
  border-color: var(--border);
  color: var(--text-primary);
}
/* Kebab menu pane + items live in the unscoped <style> block at the
   bottom of this file. The menu is teleported to <body>, which puts it
   outside this scoped style scope (no data-v-* attribute on its DOM),
   so the styles need to be global to apply. */
</style>

<!-- Unscoped — applies to the kebab menu after it teleports to <body>.
     Anything still in DOM-tree-scope (.ep-kebab, .kebab-trigger) lives
     above in the scoped block. -->
<style>
.kebab-menu {
  position: fixed;             /* teleported; coords come from kebabPos */
  z-index: 250;
  min-width: 280px;
  padding: 4px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.32);
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.kebab-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  background: transparent;
  border: none;
  border-radius: 6px;
  text-align: left;
  cursor: pointer;
  color: var(--text-primary);
  font-family: inherit;
  transition: background 0.1s;
}
.kebab-item:hover { background: var(--bg-tertiary); }
.kebab-icon {
  width: 20px;
  flex-shrink: 0;
  font-size: 14px;
  color: var(--accent);
  text-align: center;
  margin-top: 1px;
}
.kebab-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.kebab-body strong { font-size: 13px; font-weight: 600; }
.kebab-hint { font-size: 11px; color: var(--text-muted); line-height: 1.35; }
</style>
