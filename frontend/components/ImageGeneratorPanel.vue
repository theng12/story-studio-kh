<!--
  ImageGeneratorPanel — per-tab list of visual prompts with inline
  preview + per-row Generate/Regenerate controls. Two instances mount
  in images.vue (one per kind: scene / thumbnail). v1.0.87+.

  Each panel:
   - Loads the prompt list from disk via /episodes/:id/image-prompts
     (same endpoint PromptReviewPanel uses).
   - Loads the rendered-image disk scan via /projects/:slug/video-editor/scan/:id
     (same endpoint the existing Edit gallery uses) and matches by
     filename-parsed number so each row knows its rendered path.
   - Renders a paginated list (25 per page; matches PromptReviewPanel).
   - Owns per-row busy/error state and the cache-bust key for preview
     refresh after a successful render.
   - Provides a bulk "Generate All N" button at the top of the panel —
     same backend job, just no scene_number / thumb_number filter.

  Job lifecycle: POST /generate/images returns a queued Job; we poll
  /projects/:slug/jobs/:job_id until done/error/cancelled. Same pattern
  as the image-prompts page (v1.0.87 refactor).
-->
<template>
  <div v-if="episodeId" class="igp">
    <!-- Header: a compact board summary and a missing-only bulk action. -->
    <div class="igp-head">
      <div class="igp-title-row">
        <h3 class="igp-title">{{ kind === 'thumbnail' ? 'Thumbnail board' : 'Scene generator' }}</h3>
        <span class="text-muted text-xs">
          {{ renderedCount }} / {{ prompts.length }} ready
          <template v-if="missingCount"> · {{ missingCount }} missing</template>
        </span>
      </div>
      <button
        type="button"
        class="btn btn-sm btn-primary"
        :disabled="bulkDisabled || !prompts.length || (!isRegenerateMode && missingCount === 0)"
        :title="bulkDisabled
          ? `Render in flight — wait for it to finish or cancel via the Jobs panel`
          : isRegenerateMode
            ? `Re-render every ${kindLabelLower} for this episode.`
            : `Generate only the ${kindLabelLower}s that are still missing.`"
        @click="runBulk"
      >
        <LoadingSpinner v-if="bulkDisabled" size="sm" />
        <span v-else aria-hidden="true">✨</span>
        {{ bulkDisabled ? 'Rendering…' : bulkActionLabel }}
      </button>
    </div>
    <p class="igp-guard" role="status">
      <template v-if="jobActiveForEpisode">A render is already in progress for this episode. </template>
      <template v-if="isRegenerateMode">This button re-renders every {{ kindLabelLower }} and replaces the existing files{{ paid ? ' (uses credits)' : '' }}.</template>
      <template v-else>This button renders only missing {{ kindLabelLower }}s. Completed images are preserved.</template>
      Each row's own button renders just that one {{ kindLabelLower }}.
    </p>

    <!-- Loading / error / empty states -->
    <div v-if="loading" class="igp-status">
      <LoadingSpinner size="sm" /> Loading prompts…
    </div>
    <div v-else-if="loadError" class="igp-status igp-status-error">{{ loadError }}</div>
    <div v-else-if="!prompts.length" class="igp-status">
      No {{ kindLabelLower }} prompts found yet for {{ episodeId }}. Generate prompts on
      the {{ kind === 'thumbnail' ? 'Thumbnail Prompts' : 'Scene Prompts' }} page first, then return here to render them.
    </div>

    <!-- Pagination meta (only shows when needed) -->
    <div v-else>
      <div v-if="totalPages > 1" class="igp-meta">
        Showing <strong>{{ rangeStart }}–{{ rangeEnd }}</strong> of {{ prompts.length }}
      </div>

      <!-- Rows for the current page -->
      <div class="igp-list">
        <ImageGeneratorRow
          v-for="row in paginatedPrompts"
          :key="`${kind}-${row.number}`"
          :row="row"
          :prefix="kindLabel"
          :image-path="imageByNumber.get(row.number)?.path || null"
          :show-pin="kind === 'thumbnail'"
          :pinned-for-upload="imageByNumber.get(row.number)?.filename === pinnedFilename"
          :slug="projectSlug"
          :cache-key="cacheKey"
          :busy="busy.has(row.number)"
          :error="errors[row.number] || null"
          :cap="promptCharCap ?? null"
          :model-label="modelLabel"
          :paid="paid"
          @generate="runOne(row.number)"
          @pin-toggle="togglePinForRow(imageByNumber.get(row.number)?.filename || null)"
          @open-preview="(p) => $emit('open-preview', p)"
        />
      </div>

      <!-- Pagination controls (mirrors PromptReviewPanel v1.0.87) -->
      <div v-if="totalPages > 1" class="igp-pagination" role="navigation" :aria-label="`${kindLabel} pagination`">
        <button type="button" class="igp-page-btn" :disabled="page <= 1" title="First page" @click="page = 1">«</button>
        <button type="button" class="igp-page-btn" :disabled="page <= 1" title="Previous page" @click="page -= 1">‹</button>
        <span class="igp-page-label">
          Page <strong>{{ page }}</strong> / {{ totalPages }}
        </span>
        <button type="button" class="igp-page-btn" :disabled="page >= totalPages" title="Next page" @click="page += 1">›</button>
        <button type="button" class="igp-page-btn" :disabled="page >= totalPages" title="Last page" @click="page = totalPages">»</button>
        <select v-model.number="page" class="igp-page-select" :title="`Jump to page (${totalPages} pages)`">
          <option v-for="n in totalPages" :key="n" :value="n">Page {{ n }}</option>
        </select>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import ImageGeneratorRow from './ImageGeneratorRow.vue'
import { customerSafeJobText, jobRequestIds } from '../utils/job-presentation.js'

interface PromptRow { number: number; title: string; prompt: string }
interface ScannedImage { filename: string; path: string; number?: number | null }

const props = defineProps<{
  /** Which side of the generator this panel drives. Determines the prompt
   *  list endpoint shape (scenes vs thumbnails), the job-request mode, and
   *  the user-facing copy. */
  kind: 'scene' | 'thumbnail'
  projectSlug: string
  episodeId: string
  /** Episode title — used by the backend to resolve the on-disk folder. */
  title: string
  generationMode?: 'skip' | 'regenerate'
  /** The page's ONE request builder (model, ratio, size, seed, reference,
   *  extra details…). Returns null when it refused or the customer cancelled.
   *  `ask` = show the page's confirmation. The panel adds only thumb_number,
   *  force and operation_id, so every render on the page sends the same body. */
  prepare: (force: boolean, ask: boolean) => Promise<Record<string, any> | null>
  /** Whether the selected model uses credits (unknown counts as paid). */
  paid?: boolean
  /** Bumped by parent (e.g. on tab switch) to force a re-fetch of the
   *  prompt list + disk scan. */
  refreshKey?: number
  /** Soft prompt-character cap for the active image model (advisory).
   *  Passed down so each row can colour-code its char counter against the
   *  cap. Absent = no documented cap (badge shows the raw count). */
  promptCharCap?: number | null
  /** Friendly model label for the cap tooltip. */
  modelLabel?: string
  /** The thumbnail currently selected for upload, if the user pinned one. */
  pinnedFilename?: string | null
}>()

const emit = defineEmits<{
  (e: 'open-preview', path: string): void
  /** Fires whenever a per-row or bulk render successfully completes — lets
   *  the parent invalidate any sibling caches (e.g. the Edit gallery's
   *  scan list). */
  (e: 'refresh'): void
  (e: 'pin-toggle', filename: string): void
}>()

const { get, post } = useApi()
const { success, error: showError } = useToast()

// Title-case + lowercase variants for in-template use. Saves repeated
// .toLowerCase() / String capitalization in template expressions.
const kindLabel = computed(() => props.kind === 'scene' ? 'Scene' : 'Thumbnail')
const kindLabelLower = computed(() => kindLabel.value.toLowerCase())

// ── Prompt list (text from /episodes/:id/image-prompts) ────────────────────

const prompts = ref<PromptRow[]>([])
const loading = ref(false)
const loadError = ref<string | null>(null)

async function loadPrompts(): Promise<void> {
  if (!props.episodeId || !props.projectSlug) return
  loading.value = true
  loadError.value = null
  try {
    const titleParam = props.title ? `?title=${encodeURIComponent(props.title)}` : ''
    const data = await get<{ scenes?: PromptRow[]; thumbnails?: PromptRow[] }>(
      `/projects/${props.projectSlug}/episodes/${props.episodeId}/image-prompts${titleParam}`,
    )
    const list = props.kind === 'scene' ? data?.scenes : data?.thumbnails
    prompts.value = Array.isArray(list)
      ? list.slice().sort((a, b) => Number(a.number) - Number(b.number))
      : []
  } catch (e: any) {
    if (e?.status === 404 || e?.statusCode === 404) {
      // 404 → no prompts yet for this episode. Not an error condition.
      prompts.value = []
      loadError.value = null
    } else {
      loadError.value = e?.data?.detail || e?.message || 'Could not load prompts'
    }
  } finally {
    loading.value = false
  }
}

// ── Rendered-image disk scan ───────────────────────────────────────────────

const renderedImages = ref<ScannedImage[]>([])
const cacheKey = ref(0)

async function loadScan(): Promise<void> {
  if (!props.episodeId || !props.projectSlug) return
  try {
    const r = await get<{ scenes?: ScannedImage[]; thumbnails?: ScannedImage[] }>(
      `/projects/${props.projectSlug}/video-editor/scan/${props.episodeId}`,
    )
    renderedImages.value = (props.kind === 'scene' ? r?.scenes : r?.thumbnails) || []
  } catch {
    // Best-effort — empty scan just means no images on disk. We don't want
    // a failed scan to block the prompt list rendering.
    renderedImages.value = []
  }
}

// ── Match prompts to rendered images by number ─────────────────────────────
//
// The backend scan endpoint (scanEpisodeAssets) returns `{ filename, path,
// number }` for both scenes and thumbnails — the number is extracted there
// via extractSceneNumber. Trust that field directly; fall back to filename
// regex only if it's missing (defensive — covers older/edited variants the
// scanner couldn't parse). Edited variants are skipped so the row's preview
// always tracks the canonical render.

const SCENE_NUMBER_REGEX = /_Scene(\d+)_v\d+/i
const THUMB_NUMBER_REGEX = /_Thumb(\d+)_v\d+/i
const EDITED_REGEX = /_edited_v\d+/i

const imageByNumber = computed<Map<number, ScannedImage>>(() => {
  const m = new Map<number, ScannedImage>()
  for (const img of renderedImages.value) {
    if (EDITED_REGEX.test(img.filename)) continue
    let n: number | null = typeof img.number === 'number' ? img.number : null
    if (n == null) {
      const re = props.kind === 'scene' ? SCENE_NUMBER_REGEX : THUMB_NUMBER_REGEX
      const match = re.exec(img.filename)
      if (match) n = parseInt(match[1]!, 10)
    }
    if (n == null || !Number.isFinite(n)) continue
    // First match wins (the scan endpoint should already deduplicate, but
    // be defensive — keep the canonical _v1 path stable).
    if (!m.has(n)) m.set(n, img)
  }
  return m
})

// Only images that belong to a prompt on this board count as "ready".
const renderedCount = computed(() => prompts.value.filter(row => imageByNumber.value.has(row.number)).length)
const missingCount = computed(() => Math.max(0, prompts.value.length - renderedCount.value))
const isRegenerateMode = computed(() => props.generationMode === 'regenerate')
const bulkActionLabel = computed(() => {
  if (isRegenerateMode.value) {
    return `Regenerate ${prompts.value.length} ${kindLabelLower.value}${prompts.value.length === 1 ? '' : 's'}`
  }
  if (missingCount.value === 0) return `All ${kindLabelLower.value}s ready`
  return `Generate ${missingCount.value} missing`
})

function togglePinForRow(filename: string | null): void {
  if (filename) emit('pin-toggle', filename)
}

// ── Pagination ─────────────────────────────────────────────────────────────

const PAGE_SIZE = 25
const page = ref(1)
const totalPages = computed(() => Math.max(1, Math.ceil(prompts.value.length / PAGE_SIZE)))
const paginatedPrompts = computed(() => {
  const start = (page.value - 1) * PAGE_SIZE
  return prompts.value.slice(start, start + PAGE_SIZE)
})
const rangeStart = computed(() => prompts.value.length === 0 ? 0 : (page.value - 1) * PAGE_SIZE + 1)
const rangeEnd = computed(() => Math.min(prompts.value.length, page.value * PAGE_SIZE))

watch(() => prompts.value.length, () => { page.value = 1 })
watch(totalPages, (tp) => {
  if (page.value > tp) page.value = tp
  if (page.value < 1) page.value = 1
})

// ── Job lifecycle (per-row + bulk) ─────────────────────────────────────────

const JOB_POLL_INTERVAL_MS = 1500
const busy = ref<Set<number>>(new Set())
const errors = ref<Record<number, string>>({})
const bulkBusy = ref(false)

// v1.0.307 — also reflect a render already in flight for this episode (e.g.
// launched from the page's TopActionBar Generate button, or surviving a page
// reload) so the bulk button greys out consistently — not only during this
// panel's own runBulk poll. Scene vs thumbnail are independent pools, so we
// only watch the kind this panel owns.
const { isJobActiveFor } = useJobs()
const jobActiveForEpisode = computed(() =>
  isJobActiveFor(
    props.episodeId,
    props.kind === 'thumbnail' ? ['thumb_images'] : ['scene_images'],
  ),
)
const bulkDisabled = computed(() => bulkBusy.value || jobActiveForEpisode.value)

const fresh = useFreshGenerationAction()
let disposed = false
onBeforeUnmount(() => { disposed = true })
const MAX_POLL_FAILURES = 5

/** Poll until the job ends. `null` = this panel was closed first (stop quietly).
 *  A single failed read is not a failed job, so a few in a row are tolerated. */
async function waitForJob(jobId: string): Promise<any | null> {
  let failures = 0
  while (!disposed) {
    try {
      const job: any = await get(`/projects/${props.projectSlug}/jobs/${jobId}`)
      failures = 0
      if (job?.status === 'done' || job?.status === 'error' || job?.status === 'cancelled') return job
    } catch (e) {
      if (++failures >= MAX_POLL_FAILURES) throw e
    }
    await new Promise(r => setTimeout(r, JOB_POLL_INTERVAL_MS))
  }
  return null
}

function jobErrorText(job: any, fallback: string): string {
  return job?.error ? customerSafeJobText(job.error, jobRequestIds(job)) : fallback
}
function requestErrorText(e: any, fallback: string): string {
  return customerSafeJobText(e?.data?.detail || e?.message || fallback)
}

/** Submit one render. Every explicit overwrite carries an operation id, so a
 *  retried click after a lost response reuses the same request instead of
 *  paying twice. */
async function submit(body: Record<string, any>, target: string): Promise<any> {
  const operationId = body.force ? fresh.begin(body, target) : null
  const job: any = await post(`/projects/${props.projectSlug}/generate/images`, {
    ...body,
    ...(operationId ? { operation_id: operationId } : {}),
  })
  if (operationId) fresh.complete(operationId)
  return job
}

async function runOne(number: number): Promise<void> {
  if (busy.value.has(number)) return
  const episode = props.episodeId
  const params = await props.prepare(true, false)
  if (!params || episode !== props.episodeId) return
  busy.value = new Set([...busy.value, number])
  errors.value = { ...errors.value, [number]: '' }
  try {
    // A row click always overwrites: the intent is "re-render this one".
    const job = await submit({ ...params, thumb_number: number, force: true }, `row-${number}`)
    success(`Queued ${kindLabelLower.value} ${number} — watch progress in Jobs.`)
    const completed = await waitForJob(job.job_id)
    if (!completed || episode !== props.episodeId) return
    if (completed.status === 'error') throw new Error(jobErrorText(completed, 'Render failed (see Jobs for details)'))
    if (completed.status === 'cancelled') {
      errors.value = { ...errors.value, [number]: 'Cancelled' }
      return
    }
    // Job done — refresh the scan + bump cache key so the row's <img>
    // re-fetches the new bytes.
    await loadScan()
    cacheKey.value++
    emit('refresh')
    success(`${kindLabel.value} ${number} rendered`)
  } catch (e: any) {
    if (episode !== props.episodeId) return
    const msg = requestErrorText(e, 'Generation failed')
    errors.value = { ...errors.value, [number]: msg }
    showError(`${kindLabel.value} ${number}: ${msg}`)
  } finally {
    const next = new Set(busy.value)
    next.delete(number)
    busy.value = next
  }
}

async function runBulk(): Promise<void> {
  // Guard against a double-fire: bulkBusy covers this panel's own run, and
  // jobActiveForEpisode covers a render queued from elsewhere (TopActionBar,
  // reload). The button is disabled in both cases — this is belt-and-braces.
  if (bulkBusy.value || jobActiveForEpisode.value || !prompts.value.length) return
  const episode = props.episodeId
  // Default is missing-only. Regeneration is the sole explicit overwrite
  // action, so recovery never re-pays for artwork already on disk. Same
  // confirmation as the page's top button.
  const force = props.generationMode === 'regenerate'
  const requested = force ? `all ${prompts.value.length}` : `${missingCount.value} missing`
  bulkBusy.value = true
  try {
    const params = await props.prepare(force, true)
    if (!params || episode !== props.episodeId) return
    const job = await submit({ ...params, force }, 'bulk')
    success(`Queued ${requested} ${kindLabelLower.value}s — watch progress in Jobs.`)
    const completed = await waitForJob(job.job_id)
    if (!completed || episode !== props.episodeId) return
    if (completed.status === 'error') throw new Error(jobErrorText(completed, 'Render failed (see Jobs for details)'))
    if (completed.status === 'cancelled') {
      showError('Render cancelled')
      return
    }
    await loadScan()
    cacheKey.value++
    emit('refresh')
    success(`${kindLabel.value} board refreshed`)
  } catch (e: any) {
    if (episode === props.episodeId) showError(requestErrorText(e, 'Render failed'))
  } finally {
    bulkBusy.value = false
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────

// Row state belongs to one episode; a running render for the old one keeps
// going in Jobs but must not paint its spinner or error onto this board.
watch(() => props.episodeId, () => {
  busy.value = new Set()
  errors.value = {}
  bulkBusy.value = false
})

watch(
  () => [props.episodeId, props.title, props.refreshKey, props.kind],
  () => {
    if (props.episodeId) {
      void loadPrompts()
      void loadScan()
      // v1.2.9: `refreshKey` moves when the PARENT knows the files on disk may
      // have been rewritten — a repair, an import, a render from the sibling
      // panel. Re-scanning alone only refreshes the file list; without the
      // bump the rows kept the pre-change pixels, since regeneration reuses
      // the same paths and an unchanged src issues no request at all.
      cacheKey.value++
    }
  },
  { immediate: true },
)
</script>

<style scoped>
.igp {
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 6px);
  background: var(--bg-secondary);
  margin-top: 12px;
}

.igp-head {
  display: flex; align-items: center; justify-content: space-between;
  gap: 12px; flex-wrap: wrap;
  margin-bottom: 8px;
}

.igp-title-row {
  display: flex; flex-direction: column; gap: 2px;
}

.igp-title {
  margin: 0;
  font-size: 14px; font-weight: 600;
  color: var(--text-primary);
}

.igp-status {
  padding: 12px 0;
  color: var(--text-muted);
  font-size: 13px;
}
.igp-status-error {
  color: rgb(220, 38, 38);
}
.igp-guard {
  margin: 0 0 10px;
  color: var(--text-secondary);
  font-size: var(--font-xs);
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.igp-meta {
  font-size: var(--font-xs);
  color: var(--text-muted);
  padding: 4px 0;
}

.igp-list {
  display: flex;
  flex-direction: column;
}

/* Pagination — same visual register as PromptReviewPanel v1.0.87. */
.igp-pagination {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding: 8px 0 0;
  margin-top: 8px;
  border-top: 1px solid var(--border);
}
.igp-page-btn {
  padding: 4px 10px;
  font-size: 13px;
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-primary);
  cursor: pointer;
  font-family: inherit;
  min-width: 28px;
}
.igp-page-btn:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.igp-page-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.igp-page-label {
  font-size: 12px;
  color: var(--text-muted);
  padding: 0 6px;
}
.igp-page-label strong { color: var(--text-primary); }
.igp-page-select {
  margin-left: auto;
  padding: 4px 8px;
  font-size: 12px;
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-primary);
  cursor: pointer;
}
</style>
