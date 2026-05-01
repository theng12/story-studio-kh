<template>
  <div>
    <div class="page-header">
      <Breadcrumb />
      <h1 class="page-title">Images</h1>
    </div>
    <!-- Live download speed for the running image-generation job. Only
         visible while bytes are flowing in from the provider CDN; auto-
         hides between jobs. Hover any metric for an inline explainer. -->
    <AssetDownloadStrip :job-types="['images', 'scene_images', 'thumb_images', 'images_repair']" />
    <TopActionBar
      :project-slug="slug"
      :presets="imgPresets"
      v-model:episode-id="form.episode_id"
      :filter-field="form.mode === 'thumbs' ? 'thumbnails' : 'images'"
      :generate-label="generateButtonLabel"
      loading-label="Queuing…"
      :generate-loading="submitting"
      :generate-disabled="!form.episode_id"
      :generate-status="generating ? `${generatingLabel} for ${form.episode_id}…` : ''"
      @generate="submit"
      @preset-applied="success('Preset applied')"
      @preset-saved="success('Preset saved')"
      @preset-deleted="success('Preset deleted')"
    />

    <p class="text-muted mt-1 mb-2">Generate scene and thumbnail artwork from your prompts via kie.ai.</p>

    <!-- Mode tabs — replaces three separate pages -->
    <div class="mode-tabs mt-3" role="tablist" aria-label="Image generation mode">
      <button
        v-for="tab in modeTabs" :key="tab.id"
        :class="['mode-tab', { active: form.mode === tab.id }]"
        role="tab"
        :aria-selected="form.mode === tab.id"
        @click="selectMode(tab.id)"
      >
        <span class="mode-tab-icon" aria-hidden="true">{{ tab.icon }}</span>
        <span class="mode-tab-label">{{ tab.label }}</span>
        <span class="mode-tab-hint">{{ tab.hint }}</span>
      </button>
    </div>

    <div class="card mt-2">
      <div class="grid-2">
        <div class="form-group">
          <label>Image Model <span class="required" aria-hidden="true">*</span></label>
          <select v-model="form.model" class="select">
            <optgroup v-for="g in imageModelGroups" :key="g.provider" :label="g.label">
              <option v-for="m in g.items" :key="m.id" :value="m.id">
                {{ formatModelOption(m) }}
              </option>
            </optgroup>
          </select>
          <span v-if="form.mode === 'thumbs'" class="text-muted" style="font-size: 11px;">
            Tip: Use a higher-quality model for eye-catching thumbnails
          </span>
        </div>

        <!-- Tier picker — only renders for variable-priced models that
             carry a `tiers[]` array (resolution/speed/etc.). Flat-priced
             models hide it entirely. Inline cost preview ("8 cr · ~$0.04")
             keeps the explain-as-you-go expectation: every option shows
             both credits and rough USD so the user can compare without
             pulling out a calculator. -->
        <div v-if="modelTiers.length > 0" class="form-group">
          <label>{{ modelTierLabel }}</label>
          <div class="tier-picker">
            <label
              v-for="t in modelTiers"
              :key="t.id"
              class="tier-option"
              :class="{ active: form.tier === t.id }"
            >
              <input type="radio" :value="t.id" v-model="form.tier" />
              <span class="tier-option-label">{{ t.label }}</span>
              <span class="tier-option-cost">{{ t.credits }} cr · ~{{ formatUsd(t.credits) }}</span>
            </label>
          </div>
        </div>
      </div>

      <div class="grid-3">
        <div class="form-group">
          <label>Aspect Ratio</label>
          <select v-model="form.aspect_ratio" class="select">
            <option v-for="ar in aspectRatios" :key="ar.value" :value="ar.value">
              {{ ar.value }} — {{ ar.label }}
            </option>
          </select>
        </div>
        <div class="form-group">
          <label>Specific # (optional)</label>
          <input
            v-model.number="specificNum"
            class="input"
            type="number"
            min="1"
            :placeholder="specificPlaceholder"
          />
        </div>
      </div>

      <!-- Generation Mode (M6): single tri-state replaces the `force`
           checkbox. Backend payload is unchanged — translation happens at
           submit. NOTE: today the image generator skips existing files by
           default, so 'skip' and 'new_version' behave identically until
           generators/images.ts learns _v2 naming. The UI option is kept
           visible so the surface is consistent with audio. -->
      <div class="form-group">
        <label>Generation Mode</label>
        <div class="generation-mode-row">
          <label class="generation-mode-option">
            <input type="radio" value="skip" v-model="form.generation_mode" />
            <div>
              <strong>Skip existing</strong>
              <span class="text-muted">Don't regenerate scenes/thumbs that already exist.</span>
            </div>
          </label>
          <label class="generation-mode-option">
            <input type="radio" value="regenerate" v-model="form.generation_mode" />
            <div>
              <strong>Regenerate</strong>
              <span class="text-muted">Overwrite existing variants in place.</span>
            </div>
          </label>
          <label class="generation-mode-option">
            <input type="radio" value="new_version" v-model="form.generation_mode" />
            <div>
              <strong>New version</strong>
              <span class="text-muted">Currently behaves like Skip — _v2 image variants are planned.</span>
            </div>
          </label>
        </div>
      </div>

    </div>

    <!-- Image integrity pill + Repair. Generators skip existing non-empty -->
    <!-- files natively, so Repair = re-submit the same form with force=false. -->
    <div v-if="form.episode_id" class="card mt-2" aria-labelledby="image-integrity-heading">
      <h3 id="image-integrity-heading" style="margin-bottom: 6px;">Image integrity</h3>
      <p class="text-muted" style="font-size: 12px; margin-bottom: 10px;">
        Check whether every expected image is on disk. <strong>Repair missing</strong>
        queues a new job with the current form settings — the generator automatically
        skips scenes/thumbnails that already have ≥1 variant with content.
      </p>

      <div v-if="imageStatus.loading" class="text-muted" style="font-size: 13px;">
        <LoadingSpinner size="sm" /> Checking…
      </div>

      <div v-else-if="imageStatus.error" class="text-danger" style="font-size: 13px;">
        {{ imageStatus.error }}
        <button class="btn btn-sm btn-ghost ml-2" @click="refreshImageStatus">Retry</button>
      </div>

      <div v-else-if="!imageStatus.hasAny" class="text-muted" style="font-size: 13px;">
        No scene or thumbnail prompts found for this episode yet. Generate prompts
        first on the <NuxtLink :to="`/projects/${slug}/image-prompts`">Image Prompts</NuxtLink> page.
      </div>

      <div v-else class="flex items-center gap-2" style="flex-wrap: wrap;">
        <span v-if="imageStatus.scenes" class="integrity-pill" :class="imageStatus.scenes.missing.length ? 'warn' : 'ok'">
          <template v-if="imageStatus.scenes.missing.length === 0">✓ {{ imageStatus.scenes.total }} scenes present</template>
          <template v-else>⚠ {{ imageStatus.scenes.missing.length }} of {{ imageStatus.scenes.total }} scenes missing</template>
        </span>
        <span v-if="imageStatus.thumbnails" class="integrity-pill" :class="imageStatus.thumbnails.missing.length ? 'warn' : 'ok'">
          <template v-if="imageStatus.thumbnails.missing.length === 0">✓ {{ imageStatus.thumbnails.total }} thumbnails present</template>
          <template v-else>⚠ {{ imageStatus.thumbnails.missing.length }} of {{ imageStatus.thumbnails.total }} thumbnails missing</template>
        </span>

        <button
          v-if="imageStatus.hasMissing"
          class="btn btn-sm btn-secondary"
          :disabled="submitting || generating"
          @click="repairMissing"
        >
          Repair missing ({{ imageStatus.totalMissing }})
        </button>

        <button class="btn btn-sm btn-ghost" :disabled="imageStatus.loading" @click="refreshImageStatus">
          Refresh
        </button>
      </div>

      <div v-if="imageStatus.missingScenesList || imageStatus.missingThumbsList" class="missing-detail mt-2">
        <div v-if="imageStatus.missingScenesList" class="text-muted" style="font-size: 12px;">
          Missing scenes: {{ imageStatus.missingScenesList }}
        </div>
        <div v-if="imageStatus.missingThumbsList" class="text-muted" style="font-size: 12px;">
          Missing thumbnails: {{ imageStatus.missingThumbsList }}
        </div>
      </div>
    </div>

    <!-- Contextual help -->
    <div class="help-note mt-2">
      <span class="help-icon" aria-hidden="true">💡</span>
      <div>
        <strong>Need prompts first?</strong>
        Generate image prompts for this episode on the
        <NuxtLink :to="`/projects/${slug}/image-prompts`">Image Prompts</NuxtLink>
        page before running image generation.
      </div>
    </div>

  </div>
</template>

<script setup lang="ts">
definePageMeta({ layout: 'dashboard' })
useHead({ title: "Images — Story Studio KH" })

const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { post, get } = useApi()
const { config } = useProject()

// All image models currently go via kie.ai. Grouping future-proofs the
// dropdown for when a second provider is added.
const imageModelGroups = computed(() => groupModels(config.value?.image_models, () => 'kie'))
const { success, error: showError } = useToast()
const { imageGenerating, thumbImageGenerating } = useGenerating()
const { confirmGeneration } = useConfirmation()

const submitting = ref(false)
const specificNum = ref<number | null>(null)

type Mode = 'all' | 'scenes' | 'thumbs'

const form = reactive({
  episode_id: '',
  model: 'grok-imagine',
  mode: 'all' as Mode,
  aspect_ratio: '16:9',
  // Unified Generation Mode (M6) — replaces the standalone `force` checkbox.
  // Translated to `force` at submit time; the backend's image generator
  // (generators/images.ts) only knows about that boolean today, so this
  // is purely a UI consolidation. Default 'skip' matches the prior
  // default behaviour (force=false).
  generation_mode: 'skip' as 'skip' | 'regenerate' | 'new_version',
  // Tier id for variable-priced kie.ai models (nano-banana-2 1k/2k/4k,
  // ideogram-v3 turbo/balanced/quality, etc.). Flat-priced models ignore
  // this. Reset on model switch via the watcher below.
  tier: '' as string,
})

// Per-credit USD rate at kie.ai (1 credit = $0.005, verified across the
// 2026-04-28 pricing-page audit). Plumbed here so the dropdown labels
// + tier picker share one source of truth — change in one place if the
// rate shifts.
const KIE_USD_PER_CREDIT = 0.005
function formatUsd(credits: number): string {
  if (!credits || credits <= 0) return ''
  const usd = credits * KIE_USD_PER_CREDIT
  // 3 decimals for sub-penny prices (z-image at $0.004), 2 otherwise.
  return usd < 0.01 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(usd < 0.1 ? 3 : 2)}`
}

// Renders a single line for the model dropdown. For tiered models we
// show a price RANGE (cheapest tier → priciest) so the user sees at a
// glance that the cost varies with resolution/speed; the tier picker
// below the dropdown locks in the actual choice. Flat-priced models
// just show one number.
function formatModelOption(m: { data: any }): string {
  const d = m.data
  if (Array.isArray(d.tiers) && d.tiers.length > 1) {
    const credits = d.tiers.map((t: any) => t.credits)
    const min = Math.min(...credits)
    const max = Math.max(...credits)
    return `${d.label} (${min}–${max} cr · ${formatUsd(min)}–${formatUsd(max)})`
  }
  return `${d.label} (${d.credits_per_image} cr · ${formatUsd(d.credits_per_image)})`
}

// Tier helpers — exposed to the template via computeds so the picker
// renders only when the active model has tiers.
const modelTiers = computed<{ id: string; label: string; credits: number }[]>(() => {
  const m = config.value?.image_models?.[form.model] as any
  return Array.isArray(m?.tiers) ? m.tiers : []
})
const modelTierLabel = computed(() => {
  // Naming the picker by axis: "Resolution" if tier ids look like 1k/2k/4k,
  // "Quality" for turbo/balanced/quality, generic "Tier" otherwise. Keeps
  // the label descriptive without forcing per-model schema config.
  const ids = modelTiers.value.map(t => t.id.toLowerCase())
  if (ids.some(id => /^\d+k(-\d+k)?$/.test(id))) return 'Resolution'
  if (ids.some(id => ['turbo', 'balanced', 'quality'].includes(id))) return 'Quality'
  return 'Tier'
})

// When the active model changes, snap the tier selection back to the new
// model's default_tier (or first tier, or empty). Without this, switching
// from gpt-image-2 (default '1k') to ideogram-v3 (default 'balanced')
// would leave form.tier='1k', which isn't a valid ideogram tier.
watch(() => form.model, () => {
  const m = config.value?.image_models?.[form.model] as any
  const tiers = Array.isArray(m?.tiers) ? m.tiers : []
  if (!tiers.length) {
    form.tier = ''
    return
  }
  const def = tiers.find((t: any) => t.id === m.default_tier) ?? tiers[0]
  form.tier = def?.id || ''
}, { immediate: true })

// ── Presets ─────────────────────────────────────────────────────────────
const imgPresets = usePresets<any>({
  slug: slug.value,
  configKey: 'image_generator',
  snapshot: () => ({ form: { ...form } }),
  apply: (data) => { if (data?.form) Object.assign(form, data.form) },
})
onMounted(() => imgPresets.load())

const modeTabs: Array<{ id: Mode; label: string; icon: string; hint: string }> = [
  { id: 'all',    label: 'Both',        icon: '🖼️', hint: 'Scenes + Thumbnails' },
  { id: 'scenes', label: 'Scenes',      icon: '🎬', hint: 'Story artwork only' },
  { id: 'thumbs', label: 'Thumbnails',  icon: '📸', hint: 'YouTube thumbnails only' },
]

const aspectRatios = computed(() => {
  if (form.mode === 'thumbs') {
    return [
      { value: '16:9', label: 'YouTube Thumbnail' },
      { value: '1:1',  label: 'Square' },
      { value: '4:3',  label: 'Classic' },
    ]
  }
  return [
    { value: '16:9',  label: 'Landscape' },
    { value: '1:1',   label: 'Square' },
    { value: '9:16',  label: 'Portrait' },
    { value: '4:3',   label: 'Standard' },
    { value: '3:4',   label: 'Tall' },
    { value: '21:9',  label: 'Ultrawide' },
  ]
})

const specificPlaceholder = computed(() => {
  if (form.mode === 'scenes') return 'All scenes'
  if (form.mode === 'thumbs') return 'All thumbnails'
  return 'All'
})

const generateButtonLabel = computed(() => {
  if (form.mode === 'scenes') return 'Generate Scene Images'
  if (form.mode === 'thumbs') return 'Generate Thumbnail Images'
  return 'Generate Images (Scenes + Thumbnails)'
})

const generatingLabel = computed(() => {
  if (form.mode === 'scenes') return 'Generating scene images'
  if (form.mode === 'thumbs') return 'Generating thumbnail images'
  return 'Generating images'
})

const generating = computed(() => {
  if (form.mode === 'scenes') return imageGenerating.value
  if (form.mode === 'thumbs') return thumbImageGenerating.value
  return imageGenerating.value || thumbImageGenerating.value
})

function selectMode(m: Mode) {
  form.mode = m
  specificNum.value = null
  // Reset aspect ratio to the default for this mode
  if (m === 'thumbs' && !['16:9', '1:1', '4:3'].includes(form.aspect_ratio)) {
    form.aspect_ratio = '16:9'
  }
}

function getConfirmationType(): 'scene_images' | 'thumb_images' | 'images' {
  if (form.mode === 'scenes') return 'scene_images'
  if (form.mode === 'thumbs') return 'thumb_images'
  return 'images'
}

// ── Image integrity pill ────────────────────────────────────────────────
// Fetches asset-status when episode changes. Repair just re-submits the
// same form — `fileExistsWithContent` in the generator means existing
// files are skipped, so only missing ones get regenerated.
interface ImageStatusState {
  loading: boolean
  error: string
  hasAny: boolean       // whether any prompts were found
  scenes: { total: number; present: number; missing: number[] } | null
  thumbnails: { total: number; present: number; missing: number[] } | null
  hasMissing: boolean
  totalMissing: number
  missingScenesList: string    // "3, 7, 12" for the UI
  missingThumbsList: string
}
const imageStatus = reactive<ImageStatusState>({
  loading: false, error: '', hasAny: false,
  scenes: null, thumbnails: null,
  hasMissing: false, totalMissing: 0,
  missingScenesList: '', missingThumbsList: '',
})

async function refreshImageStatus() {
  if (!form.episode_id) return
  imageStatus.loading = true
  imageStatus.error = ''
  try {
    const r = await get<any>(`/projects/${slug.value}/episodes/${form.episode_id}/image-status`)
    imageStatus.scenes = r.scenes ?? null
    imageStatus.thumbnails = r.thumbnails ?? null
    imageStatus.hasAny = !!(r.scenes || r.thumbnails)
    const missScene = imageStatus.scenes?.missing.length ?? 0
    const missThumb = imageStatus.thumbnails?.missing.length ?? 0
    imageStatus.hasMissing = missScene + missThumb > 0
    imageStatus.totalMissing = missScene + missThumb
    imageStatus.missingScenesList = missScene > 0 ? imageStatus.scenes!.missing.join(', ') : ''
    imageStatus.missingThumbsList = missThumb > 0 ? imageStatus.thumbnails!.missing.join(', ') : ''
  } catch (e: any) {
    imageStatus.error = e?.data?.detail || e?.message || 'Could not check image integrity'
  } finally {
    imageStatus.loading = false
  }
}

async function repairMissing() {
  // Calls the dedicated repair endpoint (not the generation endpoint).
  // The reconciler downloads from already-paid-for provider task records
  // and never re-submits the prompt — zero credit cost.
  //
  // Files without a stored task id (generated before recordTask() was
  // wired up, or never generated at all) come back as
  // "needs_fresh_generation" — the user sees a clear message in the job
  // log telling them to click Generate for those specific items.
  submitting.value = true
  try {
    await post(`/projects/${slug.value}/generate/images-repair`, { episode_id: form.episode_id })
    success(`Repair job queued — recovers from provider history (no credit cost). Check the Jobs tab.`)
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to queue repair')
  } finally {
    submitting.value = false
  }
}

watch(() => form.episode_id, (v) => { if (v) refreshImageStatus() }, { immediate: true })

async function submit() {
  // Translate Generation Mode (M6) → backend `force`. The image generator
  // doesn't have _v2 file naming yet, so 'new_version' currently maps to
  // 'skip' until that lands; the radio option is documented to that effect.
  const force = form.generation_mode === 'regenerate'
  const params: any = {
    episode_id: form.episode_id,
    model: form.model,
    mode: form.mode,
    aspect_ratio: form.aspect_ratio,
    force,
  }
  // Forward tier only when the active model has tiers. Flat-priced models
  // ignore the field server-side, but sending it would clutter the request
  // log + the cost-confirmation receipt with a meaningless ' · ' suffix.
  if (form.tier) params.tier = form.tier

  // Send the right optional # field per mode
  if (specificNum.value) {
    if (form.mode === 'thumbs') params.thumb_number = specificNum.value
    else params.scene_number = specificNum.value
  }

  if (!await confirmGeneration(slug.value, getConfirmationType(), params)) return

  submitting.value = true
  if (form.mode === 'thumbs') thumbImageGenerating.value = true
  else imageGenerating.value = true

  try {
    await post(`/projects/${slug.value}/generate/images`, params)
    success('Image generation queued!')
  } catch (e: any) {
    showError(e.data?.detail || 'Failed to queue image generation')
    imageGenerating.value = false
    thumbImageGenerating.value = false
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.required { color: var(--error); margin-left: 2px; }

/* Generation Mode (M6) — three-up radio cards. Mirror of audio.vue;
   if more pages adopt this control later, lift to a shared component. */
.generation-mode-row {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  margin-top: 4px;
}
@media (max-width: 720px) {
  .generation-mode-row { grid-template-columns: 1fr; }
}
.generation-mode-option {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-tertiary);
  cursor: pointer;
  transition: border-color 0.12s, background 0.12s;
}
.generation-mode-option:has(input:checked) {
  border-color: var(--accent);
  background: rgba(96, 165, 250, 0.08);
}
.generation-mode-option input { margin-top: 2px; }
.generation-mode-option strong { display: block; font-size: 13px; color: var(--text-primary); }
.generation-mode-option .text-muted { display: block; font-size: 11px; color: var(--text-muted); margin-top: 2px; }

/* Tier picker — compact pill row sized to fit alongside the model
   dropdown. Matches the generation-mode option look but without the
   helper-text line, since each tier already shows credits + USD. */
.tier-picker {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.tier-option {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-tertiary);
  cursor: pointer;
  font-size: 12px;
  transition: border-color .12s, background .12s;
}
.tier-option:hover { border-color: var(--accent); }
.tier-option.active {
  border-color: var(--accent);
  background: rgba(240, 198, 116, 0.10);
}
.tier-option input { margin: 0; }
.tier-option-label { font-weight: 600; color: var(--text-primary); }
.tier-option-cost { color: var(--text-muted); font-size: 11px; }

.integrity-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 500;
  border: 1px solid transparent;
}
.integrity-pill.ok {
  background: rgba(34, 197, 94, 0.12);
  color: rgb(22, 163, 74);
  border-color: rgba(34, 197, 94, 0.3);
}
.integrity-pill.warn {
  background: rgba(245, 158, 11, 0.14);
  color: rgb(180, 83, 9);
  border-color: rgba(245, 158, 11, 0.35);
}
.missing-detail { font-family: var(--font-mono, monospace); }

.mode-tabs {
  display: flex;
  gap: 6px;
  background: var(--bg-tertiary);
  padding: 4px;
  border-radius: var(--radius-md);
  border: 1px solid var(--border);
}
.mode-tab {
  flex: 1;
  background: none;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  padding: 10px 14px;
  color: var(--text-secondary);
  cursor: pointer;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  transition: all 0.15s;
}
.mode-tab:hover { color: var(--text-primary); background: var(--bg-hover); }
.mode-tab.active {
  background: var(--accent-dim);
  color: var(--accent);
  border-color: rgba(240, 198, 116, 0.3);
}
.mode-tab-icon { font-size: 18px; }
.mode-tab-label { font-weight: 600; font-size: 13px; }
.mode-tab-hint { font-size: 11px; color: var(--text-muted); }
.mode-tab.active .mode-tab-hint { color: var(--accent); opacity: 0.8; }

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  cursor: pointer;
  color: var(--text-muted);
}

.generating-status { display: flex; flex-direction: column; gap: 4px; }
.gen-label { font-size: 12px; color: var(--accent); }
.progress-bar { height: 3px; background: var(--bg-tertiary); border-radius: 2px; overflow: hidden; }
.progress-fill { height: 100%; background: var(--accent); border-radius: 2px; animation: progressIndeterminate 1.5s ease-in-out infinite; }
@keyframes progressIndeterminate { 0% { width: 0%; margin-left: 0; } 50% { width: 60%; margin-left: 20%; } 100% { width: 0%; margin-left: 100%; } }

.help-note {
  display: flex;
  gap: 10px;
  padding: 12px 16px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 13px;
  color: var(--text-secondary);
}
.help-note strong { color: var(--text-primary); }
.help-note a { color: var(--accent); }
.help-icon { font-size: 16px; }
</style>
