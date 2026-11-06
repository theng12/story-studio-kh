<!--
  ImageGeneratorPanel — the Thumbnail board: a list of the episode's
  thumbnail prompts with inline preview + per-row Generate/Regenerate
  controls. Mounted once, in images.vue.

  Each panel:
   - Loads the prompt list from disk via /episodes/:id/image-prompts
     (same endpoint PromptReviewPanel uses).
   - Loads the rendered-image disk scan via /projects/:slug/video-editor/scan/:id
     (same endpoint Video Assembly uses) and matches by
     filename-parsed number so each row knows its rendered path.
   - Renders a paginated list (25 per page; matches PromptReviewPanel).
   - Owns per-row busy/error state and the cache-bust key for preview
     refresh after a successful render.
   - Bulk generation lives in the page's top Generate button; this panel
     only renders single rows (same backend job, with a thumb_number).

  Job lifecycle: POST /generate/images returns a queued Job; we poll
  /projects/:slug/jobs/:job_id until done/error/cancelled. Same pattern
  as the image-prompts page (v1.0.87 refactor).
-->
<template>
  <div v-if="episodeId" class="igp">
    <!-- Header: a compact board summary. -->
    <div class="igp-head">
      <div class="igp-title-row">
        <h3 class="igp-title">Thumbnail board</h3>
        <span class="text-muted text-xs">
          <!-- Owner, 2026-10-25: "all thumbnail prompts and generation is required
               to have 3 each, so I have something to choose from." The board is
               where the candidates are, so it says plainly how many there are. -->
          <template v-if="prompts.length">{{ thumbnailOptionsLabel(prompts.length) }} to choose from · </template>
          {{ renderedCount }} / {{ prompts.length }} ready
          <template v-if="missingCount"> · {{ missingCount }} missing</template>
        </span>
      </div>
    </div>
    <p class="igp-guard" role="status">
      <template v-if="jobActiveForEpisode">A render is already in progress for this episode. </template>
      The Generate Thumbnail Images button at the top renders the whole board. Each row's own button renders just that one {{ kindLabelLower }}.
    </p>

    <details v-if="renderedCount > 1" class="igp-compare">
      <summary>Compare thumbnails</summary>
      <div class="igp-compare-grid">
        <figure v-for="image in comparisonImages" :key="image.filename">
          <button type="button" class="igp-compare-preview" :aria-label="`Preview thumbnail ${image.number || image.filename}`" @click="$emit('open-preview', image.path)">
            <ResilientImage :src="`/api/projects/${projectSlug}/video-editor/preview-image?path=${encodeURIComponent(image.path)}&k=${cacheKey}`" :alt="`Thumbnail ${image.number || image.filename}`" loading="lazy" />
          </button>
          <figcaption>
            {{ image.filename }}
            <button type="button" class="btn btn-sm btn-secondary" @click="togglePinForRow(image.filename)">
              {{ image.filename === pinnedFilename ? 'Pinned for upload' : 'Pin for upload' }}
            </button>
          </figcaption>
        </figure>
      </div>
    </details>

    <!-- Loading / error / empty states -->
    <div v-if="loading" class="igp-status">
      <LoadingSpinner size="sm" /> Loading prompts…
    </div>
    <div v-else-if="loadError" class="igp-status igp-status-error">{{ loadError }}</div>
    <div v-else-if="!prompts.length" class="igp-status">
      No {{ kindLabelLower }} prompts found yet for {{ episodeId }}. Generate prompts on
      the Thumbnail Prompts page first, then return here to render them.
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
          :key="row.number"
          :row="row"
          :prefix="kindLabel"
          :image-path="imageByNumber.get(row.number)?.path || null"
          :show-pin="true"
          :pinned-for-upload="imageByNumber.get(row.number)?.filename === pinnedFilename"
          :score="scoreFor(imageByNumber.get(row.number)?.filename || '')"
          :auto-picked="imageByNumber.get(row.number)?.filename === autoPickedFilename"
          :slug="projectSlug"
          :cache-key="cacheKey"
          :busy="busy.has(row.number)"
          :error="errors[row.number] || null"
          :cap="promptCharCap ?? null"
          :model-label="modelLabel"
          :paid="paid"
          :show-text-layer="showTextLayer"
          @generate="runOne(row.number)"
          @pin-toggle="togglePinForRow(imageByNumber.get(row.number)?.filename || null)"
          @open-preview="(p) => $emit('open-preview', p)"
          @add-text="$emit('add-text', imageByNumber.get(row.number)?.filename || null)"
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
// The ONE count rule (electron/server/contracts/thumbnail-counts.ts): the board
// and the generator read the same words for the same number.
import { thumbnailOptionsLabel } from '@shared/thumbnail-counts'
import { customerSafeJobText, jobRequestIds } from '../utils/job-presentation.js'

interface PromptRow { number: number; title: string; prompt: string }
interface ScannedImage { filename: string; path: string; number?: number | null }

const props = defineProps<{
  projectSlug: string
  episodeId: string
  /** Episode title — used by the backend to resolve the on-disk folder. */
  title: string
  /** The page's ONE request builder (model, ratio, size, seed, reference,
   *  extra details…). Returns null when it refused or the customer cancelled.
   *  `ask` = show the page's confirmation. The panel adds only thumb_number,
   *  force and operation_id, so every render on the page sends the same body. */
  prepare: (force: boolean, ask: boolean) => Promise<Record<string, any> | null>
  /** Whether the selected model uses credits (unknown counts as paid). */
  paid?: boolean
  /** Bumped by parent to force a re-fetch of the prompt list + disk scan. */
  refreshKey?: number
  /** Soft prompt-character cap for the active image model (advisory).
   *  Passed down so each row can colour-code its char counter against the
   *  cap. Absent = no documented cap (badge shows the raw count). */
  promptCharCap?: number | null
  /** Friendly model label for the cap tooltip. */
  modelLabel?: string
  /** The thumbnail currently selected for upload, if the user pinned one. */
  pinnedFilename?: string | null
  /**
   * The filename the automatic pick chose, if any (owner, 2026-11-01). The
   * row marks it so the owner can see at a glance which one won.
   */
  autoPickedFilename?: string | null
  /**
   * This episode's scores, by filename. A candidate with no entry here was
   * never measured, so the row says "Not scored" rather than showing nothing.
   */
  scores?: Record<string, {
    state: 'scored' | 'rejected_by_rule' | 'not_scored'
    score?: number
    reason?: string
    text_issue?: string
  }>
  /** Channel has the thumbnail text layer on — shows each row's Add text button. */
  showTextLayer?: boolean
}>()

const emit = defineEmits<{
  (e: 'open-preview', path: string): void
  /** Fires whenever a per-row or bulk render successfully completes — lets
   *  the parent invalidate any sibling caches (e.g. its thumbnail scan). */
  (e: 'refresh'): void
  (e: 'pin-toggle', filename: string): void
  /** The row's rendered filename to headline; null when the row has no image. */
  (e: 'add-text', filename: string | null): void
}>()

const { get, post } = useApi()
const { success, error: showError } = useToast()

// Title-case + lowercase variants for in-template use.
const kindLabel = 'Thumbnail'
const kindLabelLower = 'thumbnail'

// ── Request ownership ─────────────────────────────────────────────────────
//
// images.vue keeps this panel alive with `v-show`, so its props change under a
// LIVE instance: a read issued for the episode the user just left can still be
// in flight. One revision, bumped by every load cycle and by an episode change,
// so only the newest cycle may write anything — the same guard
// useGenStudioVoices uses for its voice list.

let boardRevision = 0
/** The episode the rows on screen were loaded for. A row click is valid only
 *  for this one: the board outlives a selection change, so a stale grid must
 *  never submit against the new episode's live settings. */
const boardEpisodeId = ref('')

// ── Prompt list (text from /episodes/:id/image-prompts) ────────────────────

const prompts = ref<PromptRow[]>([])
const loading = ref(false)
const loadError = ref<string | null>(null)

async function loadPrompts(revision: number): Promise<void> {
  // Captured, not read after the await: the reply belongs to the episode this
  // request was issued for, whatever the selection is by the time it lands.
  const project = props.projectSlug
  const episode = props.episodeId
  const title = props.title
  if (!episode || !project) return
  loading.value = true
  loadError.value = null
  try {
    const titleParam = title ? `?title=${encodeURIComponent(title)}` : ''
    const data = await get<{ thumbnails?: PromptRow[] }>(
      `/projects/${project}/episodes/${episode}/image-prompts${titleParam}`,
    )
    if (revision !== boardRevision) return
    const list = data?.thumbnails
    prompts.value = Array.isArray(list)
      ? list.slice().sort((a, b) => Number(a.number) - Number(b.number))
      : []
    boardEpisodeId.value = episode
  } catch (e: any) {
    if (revision !== boardRevision) return
    if (e?.status === 404 || e?.statusCode === 404) {
      // 404 → no prompts yet for this episode. Not an error condition.
      prompts.value = []
      loadError.value = null
      boardEpisodeId.value = episode
    } else {
      loadError.value = e?.data?.detail || e?.message || 'Could not load prompts'
    }
  } finally {
    // The abandoned read's `finally` no longer owns this state — the newer
    // cycle (or the episode change that cleared it) does.
    if (revision === boardRevision) loading.value = false
  }
}

// ── Rendered-image disk scan ───────────────────────────────────────────────

const renderedImages = ref<ScannedImage[]>([])
const cacheKey = ref(0)

async function loadScan(revision: number): Promise<void> {
  const project = props.projectSlug
  const episode = props.episodeId
  if (!episode || !project) return
  try {
    const r = await get<{ thumbnails?: ScannedImage[] }>(
      `/projects/${project}/video-editor/scan/${episode}`,
    )
    if (revision !== boardRevision) return
    renderedImages.value = r?.thumbnails || []
  } catch {
    if (revision !== boardRevision) return
    // Best-effort — empty scan just means no images on disk. We don't want
    // a failed scan to block the prompt list rendering.
    renderedImages.value = []
  }
}

// ── Match prompts to rendered images by number ─────────────────────────────
//
// The backend scan endpoint (scanEpisodeAssets) returns `{ filename, path,
// number }` — the number is extracted there via extractSceneNumber. Trust
// that field directly; fall back to filename regex only if it's missing
// (defensive — covers files the scanner couldn't parse).

const THUMB_NUMBER_REGEX = /_Thumb(\d+)_v\d+/i

const imageByNumber = computed<Map<number, ScannedImage>>(() => {
  const m = new Map<number, ScannedImage>()
  for (const img of renderedImages.value) {
    let n: number | null = typeof img.number === 'number' ? img.number : null
    if (n == null) {
      const match = THUMB_NUMBER_REGEX.exec(img.filename)
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
const comparisonImages = computed(() => prompts.value.flatMap(row => {
  const image = imageByNumber.value.get(row.number)
  return image ? [image] : []
}))
const renderedCount = computed(() => comparisonImages.value.length)
const missingCount = computed(() => Math.max(0, prompts.value.length - renderedCount.value))

/**
 * One candidate's score, or null when it was never measured.
 *
 * `null` is not the same as a score of 0: a picture with no entry here was
 * never looked at, and the row says so plainly (§6).
 */
function scoreFor(filename: string) {
  if (!filename) return null
  return props.scores?.[filename] || null
}

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

// A render already in flight for this episode (launched from the page's top
// Generate button, or surviving a page reload) is shown above the rows.
const { isJobActiveFor } = useJobs()
const jobActiveForEpisode = computed(() =>
  isJobActiveFor(props.episodeId, ['thumb_images']),
)

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
  // The row belongs to the episode the board was loaded for. images.vue keeps
  // this panel alive across a selection change, so a click that arrives after
  // the user moved on must not render A's row number with B's live parameters
  // and force:true — that overwrites B's real image.
  const episode = boardEpisodeId.value
  if (!episode || episode !== props.episodeId) return
  const params = await props.prepare(true, false)
  if (!params || episode !== props.episodeId) return
  busy.value = new Set([...busy.value, number])
  errors.value = { ...errors.value, [number]: '' }
  try {
    // A row click always overwrites: the intent is "re-render this one".
    const job = await submit({ ...params, thumb_number: number, force: true }, `row-${number}`)
    success(`Queued ${kindLabelLower} ${number} — watch progress in Jobs.`)
    const completed = await waitForJob(job.job_id)
    if (!completed || episode !== props.episodeId) return
    if (completed.status === 'error') throw new Error(jobErrorText(completed, 'Render failed (see Jobs for details)'))
    if (completed.status === 'cancelled') {
      errors.value = { ...errors.value, [number]: 'Cancelled' }
      return
    }
    // Job done — refresh the scan + bump cache key so the row's <img>
    // re-fetches the new bytes.
    await loadScan(boardRevision)
    cacheKey.value++
    emit('refresh')
    success(`${kindLabel} ${number} rendered`)
  } catch (e: any) {
    if (episode !== props.episodeId) return
    const msg = requestErrorText(e, 'Generation failed')
    errors.value = { ...errors.value, [number]: msg }
    showError(`${kindLabel} ${number}: ${msg}`)
  } finally {
    const next = new Set(busy.value)
    next.delete(number)
    busy.value = next
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────

// Every field on this board belongs to one episode, so an episode change
// REPLACES it — not only the row spinners. `flush: 'sync'` blanks them in the
// same tick as the prop change, and the bumped revision stops any read still in
// flight for the old episode from repainting the board afterwards.
watch(() => props.episodeId, () => {
  boardRevision++
  boardEpisodeId.value = ''
  prompts.value = []
  renderedImages.value = []
  loading.value = false
  loadError.value = null
  busy.value = new Set()
  errors.value = {}
}, { flush: 'sync' })

// v1.2.9: `refreshKey` moves when the PARENT knows the files on disk may have
// been rewritten — a repair, an import, a render from the sibling panel.
// Re-scanning alone only refreshes the file list; without the bump the rows
// kept the pre-change pixels, since regeneration reuses the same paths and an
// unchanged src issues no request at all.
watch(
  () => [props.episodeId, props.title, props.refreshKey],
  () => {
    if (props.episodeId) {
      const revision = ++boardRevision
      void loadPrompts(revision)
      void loadScan(revision)
      cacheKey.value++
    }
  },
  { immediate: true },
)
</script>

<style scoped>
.igp-compare { margin: 12px 0; }
.igp-compare summary { cursor: pointer; }
.igp-compare-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; margin-top: 12px; }
.igp-compare figure { margin: 0; min-width: 0; }
.igp-compare-preview { display: block; width: 100%; padding: 0; border: 0; background: transparent; cursor: pointer; }
.igp-compare-preview :deep(img) { width: 100%; aspect-ratio: 16 / 9; object-fit: contain; }
.igp-compare figcaption { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; overflow-wrap: anywhere; margin-top: 8px; }
@media (max-width: 640px) { .igp-compare-grid { grid-template-columns: 1fr; } }

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
