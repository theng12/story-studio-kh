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
    <!-- Header: title + bulk Generate All button + total count -->
    <div class="igp-head">
      <div class="igp-title-row">
        <h3 class="igp-title">{{ kindLabel }} Generator</h3>
        <span class="text-muted text-xs">
          {{ prompts.length }} {{ kindLabelLower }}{{ prompts.length === 1 ? '' : 's' }} on disk
          <template v-if="renderedCount > 0">
            · {{ renderedCount }} rendered
          </template>
        </span>
      </div>
      <button
        type="button"
        class="btn btn-sm btn-primary"
        :disabled="bulkDisabled || !prompts.length"
        :title="bulkDisabled
          ? `Render in flight — wait for it to finish or cancel via the Jobs panel`
          : `Render every ${kindLabelLower}. Skips already-rendered ones unless Force is on.`"
        @click="runBulk"
      >
        <LoadingSpinner v-if="bulkDisabled" size="sm" />
        <span v-else aria-hidden="true">✨</span>
        {{ bulkDisabled ? 'Bulk rendering…' : `Generate All ${prompts.length} ${kindLabelLower}${prompts.length === 1 ? '' : 's'}` }}
      </button>
    </div>

    <!-- v1.0.416 — Thumbnail-only: optional render-time guidance appended to the
         prompt for THIS generation (per-row or bulk), no prompt-reprompt needed. -->
    <div v-if="kind === 'thumbnail'" class="igp-extra">
      <label class="igp-extra-label">
        Extra details for this render <span class="text-muted text-xs">(optional — applied to every thumbnail you generate below)</span>
      </label>
      <textarea
        v-model="extraDetails"
        class="textarea textarea-sm"
        rows="2"
        placeholder="e.g. push the subject closer, make the title bigger and higher-contrast, warmer lighting"
      ></textarea>
    </div>

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
          :image-path="imagePathByNumber.get(row.number) || null"
          :slug="projectSlug"
          :cache-key="cacheKey"
          :busy="busy.has(row.number)"
          :error="errors[row.number] || null"
          :cap="promptCharCap ?? null"
          :model-label="modelLabel"
          @generate="runOne(row.number)"
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
import { ref, computed, watch } from 'vue'
import ImageGeneratorRow from './ImageGeneratorRow.vue'

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
  /** Shared form fields the panels both consume. Passed through to per-row
   *  + bulk POST /generate/images requests so model/aspect_ratio/tier/etc.
   *  match what the parent images.vue shows. */
  model?: string
  aspectRatio?: string
  generationMode?: 'skip' | 'regenerate' | 'new_version'
  imageMode?: 'text2img' | 'img2img'
  tier?: string
  referenceSources?: Record<string, any>
  referenceStrength?: 'loose' | 'balanced' | 'strong'
  /** v1.0.308 — explicit render dimensions for LOCAL models. Set by the parent
   *  only when the model is an Image Studio model + a sub-Full size is picked;
   *  undefined for cloud models (which render from the aspect string). Sent on
   *  both per-row and bulk POST /generate/images so the panel's renders match
   *  the Size the form shows. */
  renderWidth?: number
  renderHeight?: number
  /** Bumped by parent (e.g. on tab switch) to force a re-fetch of the
   *  prompt list + disk scan. */
  refreshKey?: number
  /** Soft prompt-character cap for the active image model (advisory).
   *  Passed down so each row can colour-code its char counter against the
   *  cap. Absent = no documented cap (badge shows the raw count). */
  promptCharCap?: number | null
  /** Friendly model label for the cap tooltip. */
  modelLabel?: string
}>()

const emit = defineEmits<{
  (e: 'open-preview', path: string): void
  /** Fires whenever a per-row or bulk render successfully completes — lets
   *  the parent invalidate any sibling caches (e.g. the Edit gallery's
   *  scan list). */
  (e: 'refresh'): void
}>()

const { get, post } = useApi()
const { success, error: showError } = useToast()

// Title-case + lowercase variants for in-template use. Saves repeated
// .toLowerCase() / String capitalization in template expressions.
const kindLabel = computed(() => props.kind === 'scene' ? 'Scene' : 'Thumbnail')
const kindLabelLower = computed(() => kindLabel.value.toLowerCase())

// v1.0.416 — optional render-time guidance for thumbnails (see template).
// Appended to the prompt server-side for both per-row and bulk renders.
const extraDetails = ref('')

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

const imagePathByNumber = computed<Map<number, string>>(() => {
  const m = new Map<number, string>()
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
    if (!m.has(n)) m.set(n, img.path)
  }
  return m
})

const renderedCount = computed(() => imagePathByNumber.value.size)

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

async function waitForJob(jobId: string): Promise<any> {
  while (true) {
    const job: any = await get(`/projects/${props.projectSlug}/jobs/${jobId}`)
    if (job?.status === 'done' || job?.status === 'error' || job?.status === 'cancelled') return job
    await new Promise(r => setTimeout(r, JOB_POLL_INTERVAL_MS))
  }
}

function sharedJobParams() {
  // Mirror the existing images.vue submit payload shape so the executor
  // sees the same fields whether the user clicks the page-level top
  // Generate or a per-row button. The number filter is added per-call by
  // runOne / runBulk below.
  return {
    episode_id: props.episodeId,
    title: props.title || '',
    model: props.model,
    aspect_ratio: props.aspectRatio,
    tier: props.tier,
    image_mode: props.imageMode,
    reference_sources: props.referenceSources,
    reference_strength: props.referenceStrength,
    // v1.0.308 — local render size. Only included when the parent supplies both
    // (local model + sub-Full tier); cloud models omit them and use the aspect.
    ...(typeof props.renderWidth === 'number' && typeof props.renderHeight === 'number'
      ? { width: props.renderWidth, height: props.renderHeight }
      : {}),
    // v1.0.416 — thumbnail-only render-time guidance, appended to the prompt
    // server-side (generators/images.ts). Sent on per-row + bulk alike.
    ...(props.kind === 'thumbnail' && extraDetails.value.trim()
      ? { extra_details: extraDetails.value.trim() }
      : {}),
    // For 'skip' generation_mode the executor honours its own skip
    // logic (don't overwrite existing files unless force). Per-row
    // calls always pass force=true regardless — clicking Regenerate
    // means "I know an image exists; overwrite it."
  }
}

async function runOne(number: number): Promise<void> {
  if (busy.value.has(number)) return
  busy.value = new Set([...busy.value, number])
  errors.value = { ...errors.value, [number]: '' }
  try {
    const job: any = await post(`/projects/${props.projectSlug}/generate/images`, {
      ...sharedJobParams(),
      mode: props.kind === 'scene' ? 'scenes' : 'thumbs',
      // Backend reads scene_number for scenes, thumb_number for thumbs —
      // see generators/images.ts:615 and :646. Sending the wrong field
      // silently iterates the whole list, so this branch matters.
      ...(props.kind === 'scene' ? { scene_number: number } : { thumb_number: number }),
      // Per-row click always forces overwrite — the user intent is "I
      // want this one re-rendered", regardless of generation_mode setting.
      force: true,
    })
    success(`Queued ${kindLabelLower.value} ${number} — job ${job.job_id}`)
    const completed = await waitForJob(job.job_id)
    if (completed.status === 'error') {
      throw new Error(completed.error || 'Job failed (see Jobs panel for details)')
    }
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
    const msg = e?.data?.detail || e?.message || 'Generation failed'
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
  bulkBusy.value = true
  try {
    const job: any = await post(`/projects/${props.projectSlug}/generate/images`, {
      ...sharedJobParams(),
      mode: props.kind === 'scene' ? 'scenes' : 'thumbs',
      // Bulk respects generation_mode → force mapping the parent page
      // already does (skip vs regenerate vs new_version). Default skip
      // so a partial batch resume doesn't redo everything.
      force: props.generationMode === 'regenerate' || props.generationMode === 'new_version',
    })
    success(`Queued all ${prompts.value.length} ${kindLabelLower.value}s — job ${job.job_id}`)
    const completed = await waitForJob(job.job_id)
    if (completed.status === 'error') {
      throw new Error(completed.error || 'Bulk job failed (see Jobs panel for details)')
    }
    if (completed.status === 'cancelled') {
      showError('Bulk render cancelled')
      return
    }
    await loadScan()
    cacheKey.value++
    emit('refresh')
    success(`Bulk render of ${prompts.value.length} ${kindLabelLower.value}s done`)
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Bulk render failed')
  } finally {
    bulkBusy.value = false
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────

watch(
  () => [props.episodeId, props.title, props.refreshKey, props.kind],
  () => {
    if (props.episodeId) {
      void loadPrompts()
      void loadScan()
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

.igp-meta {
  font-size: 11px;
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
