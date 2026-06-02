<!--
  v1.0.152+ — Custom image model picker, mirror of VoicePicker's pattern.

  Replaces the plain <select><optgroup> dropdown in images.vue with a
  trigger+panel design that gives each source (cloud kie.ai vs local
  Image Studio KH) clear visual identity, surfaces cost-vs-free at a
  glance, and shows the modal's live catalog so the user can see what's
  actually downloaded on the Pinokio side without leaving Story Studio.

  Cross-source compatibility behaviour mirrors VoicePicker:
    - When the parent passes `imageMode === 'img2img'`, models without
      `supports_reference_images: true` are dimmed + their Select button
      disabled. A warning chip explains why.
    - Top compat hint banner colour-codes by the picked model's source
      (cloud / local) and explains the trade-offs.

  Live catalog: lazy-fetched from /imagestudio/catalog on first panel
  open. Failure is non-fatal — the local section still renders the
  registered model ids from project config, just without the rich
  catalog metadata (size, gated, capabilities). A 'open modal UI ↗'
  link sends the user to Image Studio's own web UI for managing what's
  downloaded.
-->
<template>
  <div class="image-model-picker" @click.stop>
    <!-- Trigger pill — shows current provider + selection + cost -->
    <button type="button" class="imp-trigger" :class="{ open: expanded }" @click="toggle">
      <span
        v-if="currentProviderName"
        class="imp-prov"
        :class="`prov-${currentProviderName.toLowerCase().replace(/[^a-z]/g,'')}`"
      >{{ currentProviderName }}</span>
      <span class="imp-current" :title="currentLabel">
        {{ currentLabel }}
      </span>
      <span v-if="currentCostChip" class="imp-cost-chip">{{ currentCostChip }}</span>
      <span class="imp-chev" aria-hidden="true">▾</span>
    </button>

    <!-- Expanded panel -->
    <div v-if="expanded" class="imp-panel">
      <!-- Compat hint at the top: explains cost vs free + img2img caveat. -->
      <div class="imp-compat-hint">
        <span class="imp-compat-icon" aria-hidden="true">💡</span>
        <span class="imp-compat-text">
          <strong>Cloud</strong> models (☁︎ kie.ai) charge credits per image —
          fast, always available, no setup.
          <strong>Local</strong> models (💻 Image Studio KH) are free
          (Apple Silicon compute) but require the Pinokio modal running
          + Tailscale connected.
          <template v-if="imageMode === 'img2img'">
            <br>
            <span class="imp-hint-ref">
              ⚠ Image → Image mode: only models with reference-image
              support actually consume your references; others are
              dimmed below.
            </span>
          </template>
        </span>
      </div>

      <!-- Search + capability filters -->
      <div class="imp-toolbar">
        <input
          v-model="search"
          type="text"
          class="input input-sm imp-search"
          placeholder="Search models…"
          autofocus
        />
      </div>
      <div class="imp-filters">
        <button
          type="button"
          :class="['imp-cap-chip', { active: capFilter === '' }]"
          @click="capFilter = ''"
        >All</button>
        <button
          type="button"
          :class="['imp-cap-chip', { active: capFilter === 'txt2img' }]"
          @click="capFilter = 'txt2img'"
          title="Text-to-image only"
        >T2I</button>
        <button
          type="button"
          :class="['imp-cap-chip', { active: capFilter === 'img2img' }]"
          @click="capFilter = 'img2img'"
          title="Image-to-image / reference-capable"
        >I2I / refs</button>
        <button
          type="button"
          :class="['imp-cap-chip', { active: capFilter === 'edit' }]"
          @click="capFilter = 'edit'"
          title="Instruction-edit (Kontext / Qwen-Edit style)"
        >Edit</button>
      </div>

      <div class="imp-list">
        <!-- ☁︎ Cloud section — each row is tagged with its real provider. -->
        <div v-if="filteredCloudModels.length" class="imp-section">
          <div class="imp-section-heading">
            <span>☁︎ Cloud models ({{ filteredCloudModels.length }})</span>
          </div>
          <div
            v-for="m in filteredCloudModels"
            :key="'cloud-' + m.id"
            class="imp-row"
            :class="{
              selected: modelValue === m.id,
              incompatible: imageMode === 'img2img' && !m.supportsRefs,
            }"
            :title="imageMode === 'img2img' && !m.supportsRefs ? 'This model would silently ignore reference images — pick an I2I-capable one above' : ''"
          >
            <button
              type="button"
              class="imp-select"
              :disabled="imageMode === 'img2img' && !m.supportsRefs"
              @click="select(m.id)"
            >
              <span class="imp-row-name">
                <span class="imp-prov" :class="`prov-${(m.providerName || '').toLowerCase().replace(/[^a-z]/g,'')}`">{{ m.providerName }}</span>
                {{ m.label }}
              </span>
              <span class="imp-row-meta">
                <span class="imp-chip imp-cost">{{ m.costChip }}</span>
                <span v-if="m.supportsRefs" class="imp-chip imp-cap-refs">refs</span>
                <span v-if="m.tiered" class="imp-chip subtle">tiered</span>
                <span v-if="imageMode === 'img2img' && !m.supportsRefs" class="imp-chip warn">no refs</span>
              </span>
            </button>
          </div>
        </div>

        <!-- 💻 Local section (Image Studio KH) -->
        <div v-if="localModels.length || localCatalogLoading || localCatalogError" class="imp-section imp-section-local">
          <div class="imp-section-heading imp-vs-heading">
            <span>💻 Image Studio KH — local ({{ filteredLocalModels.length }})</span>
            <span class="imp-vs-actions">
              <button
                type="button"
                class="imp-vs-refresh"
                :disabled="localCatalogLoading"
                title="Re-fetch the live catalog from your Image Studio modal"
                @click.stop="loadLocalCatalog"
              >{{ localCatalogLoading ? '…' : '⟳' }}</button>
              <a
                class="imp-vs-manage"
                href="#"
                title="Manage downloaded models in Image Studio's web UI"
                @click.stop.prevent="openImageStudioWeb"
              >open modal UI ↗</a>
            </span>
          </div>
          <div v-if="localCatalogError" class="imp-vs-error">
            ⚠ {{ localCatalogError }} — the modal may be offline.
            Set the URL in
            <a href="#" class="imp-link" @click.prevent="goToLocalModelsSettings">Settings → This Mac → Local Models</a>
            and try Refresh.
          </div>
          <div
            v-for="m in filteredLocalModels"
            :key="'local-' + m.id"
            class="imp-row"
            :class="{
              selected: modelValue === m.id,
              incompatible: !m.available || (imageMode === 'img2img' && !m.supportsImgImg),
            }"
            :title="m.unavailableReason || (imageMode === 'img2img' && !m.supportsImgImg ? 'This model is text-only — pick an I2I-capable model' : '')"
          >
            <button
              type="button"
              class="imp-select"
              :disabled="!m.available || (imageMode === 'img2img' && !m.supportsImgImg)"
              @click="select(m.id)"
            >
              <span class="imp-row-name">{{ m.label }}</span>
              <span class="imp-row-meta">
                <span class="imp-chip imp-cost free">free</span>
                <span v-if="m.sizeGb" class="imp-chip subtle">{{ m.sizeGb }} GB</span>
                <span v-if="m.appleOptimized" class="imp-chip">MLX</span>
                <span v-for="c in m.capChips" :key="c" class="imp-chip imp-cap-refs">{{ c }}</span>
                <span v-if="m.gated" class="imp-chip warn" title="Requires a Hugging Face token + license acceptance">gated</span>
                <span v-if="!m.fitsMemory" class="imp-chip warn" :title="`Needs more unified memory than this Mac has`">needs more RAM</span>
                <span v-else-if="!m.ready" class="imp-chip warn" title="Engine family not loaded/ready on the modal">engine off</span>
                <span v-if="imageMode === 'img2img' && !m.supportsImgImg" class="imp-chip warn">no refs</span>
              </span>
              <span v-if="m.bestFor" class="imp-row-bestfor">{{ m.bestFor }}</span>
            </button>
          </div>
        </div>

        <div
          v-if="!filteredCloudModels.length && !filteredLocalModels.length && !localCatalogLoading"
          class="imp-empty"
        >
          No models match. Clear the search / filter, or
          <a href="#" class="imp-link" @click.prevent="clearFilters">reset</a>.
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * Standalone image model picker. Doesn't know anything about Image
 * Studio's wire protocol — it only consumes the project's
 * `config.image_models` catalog + the live /imagestudio/catalog
 * response. The pick is emitted as a Story Studio model id (e.g.
 * 'imagestudio-flux2-klein-mlx-4bit' or 'flux-kontext-pro'); the
 * parent treats the value identically to the old <select>.
 */

interface ImageModelEntry {
  label: string
  credits_per_image: number
  provider?: string
  supports_reference_images?: boolean
  tiers?: { credits: number }[]
  // Image Studio-specific enrichments (filled from live catalog).
  size_gb?: number
  apple_optimized?: boolean
  gated?: boolean
  capabilities?: string[]
  best_for?: string
}

/** A row from GET /imagestudio/models — the live, dynamic catalog. */
interface ImageStudioModelInfo {
  id: string                // Story Studio model id: `imagestudio:<repo>`
  repo: string
  label: string
  family: string
  family_label?: string
  capabilities: string[]    // txt2img | img2img | edit
  size_gb?: number
  gated?: boolean
  apple_optimized?: boolean
  best_for?: string
  ready: boolean            // engine family loaded/ready on the modal
  fits_memory: boolean      // this Mac's unified memory meets the model's floor
}

const props = withDefaults(defineProps<{
  modelValue: string
  projectSlug: string
  imageModels: Record<string, ImageModelEntry>
  imageMode?: 'text2img' | 'img2img'
  defaultLabel?: string
}>(), {
  imageMode: 'text2img',
  defaultLabel: 'Pick a model…',
})

const emit = defineEmits<{
  'update:modelValue': [modelId: string]
}>()

const { get } = useApi()
const { error: showError } = useToast()

const expanded = ref(false)
const search = ref('')
const capFilter = ref<'' | 'txt2img' | 'img2img' | 'edit'>('')

// Image Studio dynamic model state (from GET /imagestudio/models).
const localCatalog = ref<ImageStudioModelInfo[]>([])
const localCatalogLoading = ref(false)
const localCatalogError = ref('')
const imagestudioBaseUrl = ref('')

const currentId = computed(() => props.modelValue)
const currentModel = computed(() => props.imageModels?.[currentId.value])
/** Label for the trigger pill — registered config first, else the live catalog. */
const currentLabel = computed(() => {
  if (currentModel.value?.label) return currentModel.value.label
  const live = localCatalog.value.find(m => m.id === currentId.value)
  return live?.label || currentId.value || props.defaultLabel
})
const currentSource = computed<'cloud' | 'local' | ''>(() => {
  if (currentId.value?.startsWith('imagestudio:') || currentModel.value?.provider === 'imagestudio') return 'local'
  if (currentModel.value) return 'cloud'
  return ''
})
/** Provider name for the trigger badge (registered config, or a live local model). */
const currentProviderName = computed(() => {
  if (currentModel.value?.provider) return providerLabel(currentModel.value.provider)
  if (currentId.value?.startsWith('imagestudio:')) return 'Image Studio'
  if (currentModel.value) return 'kie.ai'
  return ''
})

/** Tiny KIE pricing constant — keeps the formatter consistent with images.vue. */
const KIE_USD_PER_CREDIT = 0.005
function formatUsd(credits: number): string {
  if (!credits || credits <= 0) return ''
  const usd = credits * KIE_USD_PER_CREDIT
  return usd < 0.01 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(usd < 0.1 ? 3 : 2)}`
}

/** Cost chip text — 'free' for local, '<N> cr · ~$USD' for cloud. */
function costChipFor(m: ImageModelEntry): string {
  if (m.provider === 'imagestudio') return 'free'
  if (m.provider === 'openai-image') return 'OpenAI · billed direct'
  if (m.provider === 'openrouter-image') return 'OpenRouter · billed direct'
  const tiers = m.tiers
  if (Array.isArray(tiers) && tiers.length > 1) {
    const credits = tiers.map(t => t.credits)
    const min = Math.min(...credits)
    const max = Math.max(...credits)
    return `${min}–${max} cr · ${formatUsd(min)}–${formatUsd(max)}`
  }
  return `${m.credits_per_image} cr · ${formatUsd(m.credits_per_image)}`
}

const currentCostChip = computed(() => currentModel.value ? costChipFor(currentModel.value) : '')

interface DisplayRow {
  id: string
  label: string
  costChip: string
  supportsRefs: boolean
  tiered: boolean
  // Local-only fields. Carried as undefined for cloud rows.
  sizeGb?: number
  appleOptimized?: boolean
  gated?: boolean
  supportsImgImg?: boolean
  bestFor?: string
  capChips?: string[]
  ready?: boolean
  fitsMemory?: boolean
  available?: boolean
  unavailableReason?: string
  supportsTxt2img?: boolean
  providerName?: string
}

/** Friendly provider name shown as the leading chip on each cloud row, so
 *  models are grouped at a glance by who actually serves them (not all "kie"). */
function providerLabel(provider?: string): string {
  switch (provider) {
    case 'openai-image': return 'OpenAI'
    case 'openrouter-image': return 'OpenRouter'
    case 'kie': case undefined: case '': return 'kie.ai'
    case 'imagestudio': return 'Image Studio'
    default: return provider!
  }
}

const cloudModels = computed<DisplayRow[]>(() => {
  return Object.entries(props.imageModels)
    .filter(([, m]) => (m.provider || 'kie') !== 'imagestudio')
    .map(([id, m]) => ({
      id,
      label: m.label,
      costChip: costChipFor(m),
      supportsRefs: !!m.supports_reference_images,
      tiered: Array.isArray(m.tiers) && m.tiers.length > 1,
      supportsTxt2img: true,
      providerName: providerLabel(m.provider),
    }))
    // Group visually by provider: kie.ai first, then OpenAI, OpenRouter, …
    .sort((a, b) => (a.providerName || '').localeCompare(b.providerName || '') || a.label.localeCompare(b.label))
})

/**
 * v1.0.205+ — local models come straight from the modal's LIVE catalog
 * (GET /imagestudio/models), not from the project's saved catalog. So any
 * model the modal lists — downloaded today or added in a future build —
 * appears with no app change. Each row's id is `imagestudio:<repo>`, which
 * the generator + provider resolve directly. Rows the engine can't run
 * (memory floor unmet, family not loaded) are shown but disabled, with a
 * chip explaining why, so the user sees the full menu without confusion.
 */
const localModels = computed<DisplayRow[]>(() => {
  return localCatalog.value.map(m => {
    const caps = m.capabilities || []
    const supportsImgImg = caps.includes('img2img') || caps.includes('edit')
    const available = m.ready && m.fits_memory
    const unavailableReason = !m.fits_memory
      ? 'Needs more unified memory than this Mac has'
      : !m.ready
        ? 'This engine family is not loaded/ready on the modal'
        : ''
    // Capability chips: i2i / edit (txt2img is universal — no chip).
    const capChips: string[] = []
    if (caps.includes('img2img')) capChips.push('i2i')
    if (caps.includes('edit')) capChips.push('edit')
    return {
      id: m.id,
      label: m.label,
      costChip: 'free',
      supportsRefs: supportsImgImg,
      tiered: false,
      sizeGb: m.size_gb,
      appleOptimized: m.apple_optimized,
      gated: m.gated,
      supportsImgImg,
      bestFor: m.best_for,
      capChips,
      ready: m.ready,
      fitsMemory: m.fits_memory,
      available,
      unavailableReason,
      supportsTxt2img: caps.includes('txt2img'),
    }
  })
})

/** Filters: search + capability + img2img mode (handled at the row level via dim). */
function applyFilters(rows: DisplayRow[]): DisplayRow[] {
  const q = search.value.trim().toLowerCase()
  return rows.filter(r => {
    if (q) {
      const haystack = [r.label, r.bestFor].filter(Boolean).join(' ').toLowerCase()
      if (!haystack.includes(q)) return false
    }
    if (capFilter.value === 'img2img' && !r.supportsRefs && !r.supportsImgImg) return false
    if (capFilter.value === 'edit') {
      // Cloud kie-edit models we don't model explicitly; the closest
      // proxy is supports_reference_images for instruction-edit-style
      // models like Flux Kontext + Qwen Image Edit. Local rows have
      // explicit `edit` in capabilities — that's already covered by
      // supportsImgImg in our shape, so we don't add a second filter.
      if (!r.supportsRefs && !r.supportsImgImg) return false
    }
    // 'txt2img' filter: hide edit-only local models (they can't do T2I).
    if (capFilter.value === 'txt2img' && r.supportsTxt2img === false) return false
    return true
  })
}

const filteredCloudModels = computed(() => applyFilters(cloudModels.value))
const filteredLocalModels = computed(() => applyFilters(localModels.value))

async function loadLocalCatalog() {
  localCatalogLoading.value = true
  localCatalogError.value = ''
  try {
    const data = await get<{ ok: boolean; models: ImageStudioModelInfo[]; baseUrl: string; error?: string }>(`/imagestudio/models`)
    const models = Array.isArray(data.models) ? data.models : []
    // Runnable models (ready + fit this Mac) first, then the rest; stable
    // by label within each group so the list doesn't jump around.
    models.sort((a, b) => {
      const ra = (a.ready && a.fits_memory) ? 0 : 1
      const rb = (b.ready && b.fits_memory) ? 0 : 1
      return ra - rb || a.label.localeCompare(b.label)
    })
    localCatalog.value = models
    imagestudioBaseUrl.value = data.baseUrl || ''
    if (!data.ok && !models.length) {
      localCatalogError.value = data.error || 'Image Studio modal unreachable'
    }
  } catch (e: any) {
    localCatalogError.value = e?.data?.detail || e?.message || 'Image Studio modal unreachable'
    localCatalog.value = []
  } finally {
    localCatalogLoading.value = false
  }
}

function select(modelId: string) {
  emit('update:modelValue', modelId)
  expanded.value = false
}

function toggle() {
  expanded.value = !expanded.value
  if (expanded.value && !localCatalog.value.length && !localCatalogLoading.value && !localCatalogError.value) {
    void loadLocalCatalog()
  }
}

function clearFilters() {
  search.value = ''
  capFilter.value = ''
}

function goToLocalModelsSettings() {
  const router = useRouter()
  void router.push(`/projects/${props.projectSlug}/settings#local-tts`)
  expanded.value = false
}

function openImageStudioWeb() {
  const url = imagestudioBaseUrl.value
  if (!url) {
    showError('Image Studio URL not set — configure it in Settings → This Mac → Local Models.')
    return
  }
  try {
    window.open(url, '_blank', 'noopener,noreferrer')
  } catch {
    window.location.href = url
  }
}

/** Close on Escape — same UX as VoicePicker. */
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && expanded.value) expanded.value = false
}
onMounted(() => {
  window.addEventListener('keydown', onKey)
  // Best-effort prefetch so the local section is populated by the time
  // the user opens the panel. Silently no-ops if the modal is offline.
  void loadLocalCatalog()
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<style scoped>
.image-model-picker { position: relative; width: 100%; }

/* Trigger pill — same visual register as VoicePicker so the two pickers
   read as one design language. */
.imp-trigger {
  display: flex; align-items: center; gap: 8px;
  width: 100%;
  padding: 8px 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: inherit;
  cursor: pointer;
  text-align: left;
  font: inherit;
  transition: border-color 0.15s;
}
.imp-trigger:hover { border-color: var(--text-secondary); }
.imp-trigger.open { border-color: var(--accent); }
.imp-current { flex: 1; min-width: 0; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.imp-source-chip {
  font-size: 10px; padding: 2px 7px; border-radius: 999px;
  font-weight: 600; letter-spacing: 0.2px;
}
.imp-source-chip.src-local {
  background: rgba(91, 179, 124, 0.15);
  color: rgb(34, 134, 70);
}
.imp-source-chip.src-cloud {
  background: rgba(96, 165, 250, 0.15);
  color: rgb(59, 130, 246);
}
.imp-cost-chip {
  font-size: 10px; padding: 2px 7px; border-radius: 999px;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
}
.imp-chev { font-size: 12px; color: var(--text-muted); }
.imp-trigger.open .imp-chev { transform: rotate(180deg); }

/* Expanded panel */
.imp-panel {
  /* v1.0.231 — fixed, comfortable width independent of the (sometimes narrow)
     trigger, so the dropdown is readable even when the picker sits inline in a
     toolbar. Clamps to the viewport on small windows. */
  position: absolute; top: 100%; left: 0; right: auto;
  width: 460px;
  max-width: 92vw;
  margin-top: 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-primary);
  max-height: min(620px, 70vh);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  z-index: 50;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.28);
}

/* Top hint banner */
.imp-compat-hint {
  display: flex; align-items: flex-start; gap: 8px;
  padding: 10px 14px;
  margin: 0;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border);
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--text-secondary);
}
.imp-compat-icon { font-size: 14px; line-height: 1.2; flex-shrink: 0; }
.imp-compat-text strong { color: var(--text-primary); }
.imp-hint-ref {
  display: inline-block;
  margin-top: 4px;
  color: rgb(180, 83, 9);
}

/* Search + filters */
.imp-toolbar { display: flex; padding: 10px 12px 6px; }
.imp-search { flex: 1; }
.imp-filters { display: flex; gap: 4px; padding: 0 12px 8px; flex-wrap: wrap; }
.imp-cap-chip {
  font-size: 11px;
  padding: 3px 10px;
  border-radius: 999px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  color: var(--text-secondary);
  font-family: inherit;
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.imp-cap-chip:hover { background: var(--bg-hover); color: var(--text-primary); }
.imp-cap-chip.active { background: var(--accent); color: var(--accent-on); border-color: var(--accent); }

/* List + sections */
.imp-list { flex: 1; overflow-y: auto; padding: 0 6px 10px; display: flex; flex-direction: column; gap: 2px; }
.imp-section { display: flex; flex-direction: column; gap: 2px; margin-top: 8px; }
.imp-section-heading {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  color: var(--text-muted);
  padding: 6px 10px;
  font-weight: 600;
}
.imp-section-local .imp-section-heading {
  /* Subtle green accent for the local section so eye links to the
     compat-hint banner and per-row 'free' chip. */
  background: rgba(91, 179, 124, 0.06);
  border-left: 2px solid rgba(91, 179, 124, 0.5);
  padding-left: 8px;
  border-radius: 2px;
}
.imp-vs-heading {
  display: flex; align-items: center; justify-content: space-between; gap: 6px;
}
.imp-vs-actions { display: inline-flex; align-items: center; gap: 8px; text-transform: none; letter-spacing: 0; }
.imp-vs-refresh {
  background: none; border: 1px solid var(--border); border-radius: 4px;
  padding: 0 6px; line-height: 1.8;
  color: var(--text-muted); font-size: 12px;
  cursor: pointer;
}
.imp-vs-refresh:hover:not(:disabled) { color: var(--accent); border-color: var(--accent); }
.imp-vs-refresh:disabled { opacity: 0.5; cursor: default; }
.imp-vs-manage { font-size: 10.5px; color: var(--accent); text-decoration: none; }
.imp-vs-manage:hover { text-decoration: underline; }

.imp-vs-error {
  margin: 4px 12px 0;
  padding: 6px 10px;
  background: rgba(245, 158, 11, 0.10);
  border: 1px solid rgba(245, 158, 11, 0.35);
  border-radius: 4px;
  font-size: 11px;
  color: rgb(180, 83, 9);
  line-height: 1.5;
}

/* Rows */
.imp-row {
  display: flex; align-items: stretch;
  padding: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  border: 1px solid transparent;
  transition: background 0.1s, border-color 0.1s;
}
.imp-row:hover { background: var(--bg-tertiary); }
.imp-row.selected { border-color: var(--accent); background: var(--accent-dim); }
.imp-row.incompatible { opacity: 0.5; cursor: not-allowed; }
.imp-row.incompatible .imp-select { cursor: not-allowed; }

.imp-select {
  flex: 1; min-width: 0;
  display: flex; flex-direction: column; align-items: flex-start; gap: 4px;
  background: none; border: none; cursor: pointer;
  color: inherit; font: inherit; text-align: left;
  padding: 10px 12px;
}
.imp-row-name { font-size: 14px; color: var(--text-primary); font-weight: 600; display: flex; align-items: center; gap: 6px; }
/* Provider badge at the front of each cloud row — colour-coded per provider. */
.imp-prov {
  flex-shrink: 0;
  font-size: 10px; font-weight: 700; letter-spacing: 0.2px;
  padding: 2px 7px; border-radius: 5px;
  background: var(--bg-tertiary); color: var(--text-secondary);
  text-transform: none;
}
.imp-prov.prov-openai { background: rgba(16, 163, 127, 0.16); color: rgb(16, 140, 110); }
.imp-prov.prov-openrouter { background: rgba(139, 92, 246, 0.16); color: rgb(124, 58, 237); }
.imp-prov.prov-kieai { background: rgba(96, 165, 250, 0.16); color: rgb(37, 99, 235); }
.imp-row-meta { display: flex; flex-wrap: wrap; gap: 5px; font-size: 11px; color: var(--text-muted); }
.imp-row-bestfor { font-size: 11.5px; color: var(--text-muted); margin-top: 2px; line-height: 1.45; font-style: italic; }
.imp-chip { padding: 2px 7px; border-radius: 999px; background: var(--bg-tertiary); color: var(--text-secondary); text-transform: lowercase; font-size: 11px; }
.imp-chip.subtle { background: transparent; border: 1px solid var(--border); }
.imp-chip.warn { background: rgba(245,158,11,0.15); color: rgb(180,83,9); text-transform: none; }
.imp-chip.imp-cost {
  background: rgba(96, 165, 250, 0.15);
  color: rgb(59, 130, 246);
  text-transform: none;
  font-variant-numeric: tabular-nums;
}
.imp-chip.imp-cost.free {
  background: rgba(91, 179, 124, 0.15);
  color: rgb(34, 134, 70);
}
.imp-chip.imp-cap-refs {
  background: rgba(167, 139, 250, 0.15);
  color: rgb(139, 92, 246);
  text-transform: none;
}

.imp-empty { padding: 24px 16px; text-align: center; font-size: 12px; color: var(--text-muted); }
.imp-link { color: var(--accent); text-decoration: underline; cursor: pointer; }
.imp-link:hover { filter: brightness(1.1); }
</style>
