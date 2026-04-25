<template>
  <div>
    <div class="page-header">
      <Breadcrumb />
      <h1 class="page-title">Image Prompts</h1>
    </div>
    <TopActionBar
      :project-slug="slug"
      :presets="promptPresets"
      v-model:episode-id="form.episode_id"
      filter-field="prompts"
      generate-label="Generate All Image Prompts"
      loading-label="Generating…"
      :generate-loading="generating"
      :generate-disabled="!form.episode_id || !scriptReady"
      :generate-status="generating ? `Generating prompts for ${form.episode_id}…` : (form.episode_id && !scriptReady ? noScriptTooltip : '')"
      @generate="generate"
      @preset-applied="success('Preset applied')"
      @preset-saved="success('Preset saved')"
      @preset-deleted="success('Preset deleted')"
    />

    <p class="text-muted mt-1 mb-2">
      Image prompts are split into two pools — <strong>scenes</strong> (per-chapter visuals used in the final video)
      and <strong>thumbnails</strong> (cover art candidates). Keeping them separate means a scene regen doesn't clobber
      your saved thumbnails and vice-versa. Generate both at once with the top button, or each pool independently below.
    </p>

    <div class="card mt-3">
      <div class="form-group" style="max-width: 520px;">
        <ModelSelector v-model="form.model" :project-slug="slug" />
      </div>

      <!-- Style preset -->
      <div class="grid-2">
        <div class="form-group">
          <label>Art Style</label>
          <select v-model="form.style_preset" class="select" @change="onStyleChange">
            <optgroup label="Built-in Presets">
              <option value="storybook">Storybook Illustration</option>
              <option value="3d-render">3D Render</option>
              <option value="watercolor">Watercolor</option>
              <option value="anime">Anime / Manga</option>
              <option value="photorealistic">Photorealistic</option>
              <option value="cinematic">Cinematic</option>
              <option value="pixel-art">Pixel Art</option>
              <option value="oil-painting">Oil Painting</option>
              <option value="flat-design">Flat Design / Vector</option>
              <option value="charcoal">Charcoal / Sketch</option>
            </optgroup>
            <optgroup label="Custom" v-if="customStyles.length">
              <option v-for="cs in customStyles" :key="cs.id" :value="cs.id">{{ cs.name }}</option>
            </optgroup>
            <option value="custom">+ Write custom style...</option>
          </select>
        </div>
        <div class="form-group">
          <label>Aspect Ratio</label>
          <select v-model="form.aspect_ratio" class="select">
            <option value="16:9">16:9 — Landscape (YouTube)</option>
            <option value="1:1">1:1 — Square (Instagram)</option>
            <option value="9:16">9:16 — Portrait (Stories/TikTok)</option>
            <option value="4:3">4:3 — Classic</option>
            <option value="3:4">3:4 — Portrait Classic</option>
            <option value="21:9">21:9 — Ultrawide</option>
          </select>
        </div>
      </div>

      <div class="form-group" v-if="form.style_preset === 'custom' || showStyleEditor">
        <label>Style Tag</label>
        <textarea v-model="form.style_tag" class="textarea" style="min-height: 60px; font-size: 13px;"
          placeholder="Describe the visual style…" />

        <!-- Reference-image style extraction (pain-point #7). Upload an -->
        <!-- image → Claude/GPT-4o returns a style-only description that -->
        <!-- populates the textarea above. Re-analyze lets users iterate on -->
        <!-- the focus hint without re-picking the file. -->
        <div class="style-extract mt-2">
          <div class="style-extract-row">
            <button
              type="button"
              class="btn btn-sm btn-secondary"
              :disabled="extracting"
              :title="referenceImagePath ? 'Pick a different image' : 'Pick a reference image to analyse'"
              @click="pickReferenceImage"
            >
              <LoadingSpinner v-if="extracting" size="sm" />
              <span v-else aria-hidden="true">📷</span>
              {{ referenceImagePath ? 'Change reference…' : 'Extract from reference image…' }}
            </button>

            <select v-if="visionModels.length" v-model="visionModel" class="select select-sm" style="max-width: 220px;" :disabled="extracting">
              <option v-for="m in visionModels" :key="m.id" :value="m.id" :disabled="!m.has_key">
                {{ formatVisionModelLabel(m) }}
              </option>
            </select>

            <button
              v-if="referenceImagePath"
              type="button"
              class="btn btn-sm btn-primary"
              :disabled="extracting"
              title="Re-run analysis on the same reference (useful after changing the model or focus hint)"
              @click="extractStyle"
            >
              <LoadingSpinner v-if="extracting" size="sm" />
              ⟳ Re-analyze
            </button>
          </div>

          <div v-if="referenceImagePath" class="style-extract-preview mt-2">
            <img
              :src="referencePreviewUrl"
              alt="Reference image"
              class="style-extract-thumb"
              :title="referenceImagePath"
            />
            <div class="style-extract-meta">
              <div class="style-extract-filename">{{ referenceImageName }}</div>
              <div v-if="lastAnalyzedAt" class="text-muted" style="font-size: 11px;">
                Analyzed {{ lastAnalysisModel }} · {{ lastAnalyzedAtRelative }}
              </div>
              <div v-else class="text-muted" style="font-size: 11px;">
                Hit Re-analyze to extract the style description.
              </div>
              <button
                type="button"
                class="btn btn-ghost btn-sm style-extract-clear"
                @click="clearReference"
              >
                Remove reference
              </button>
            </div>
          </div>

          <p class="text-muted mt-1" style="font-size: 11px;">
            Tip: pick a thumbnail or scene image that matches the look you want. The vision model describes only the
            style (medium, palette, lighting, texture) — not the subject — and drops it into the textarea above.
            Costs a few cents per extract.
          </p>
        </div>
      </div>

      <!-- ── Scene Prompts section ─────────────────────────────────────── -->
      <div class="split-section mt-2">
        <div class="split-header">
          <h3 style="font-size:14px; margin:0">🎬 Scene Prompts</h3>
          <span class="text-muted" style="font-size:11px">~{{ estimatedScenes }} prompts will be generated</span>
        </div>
        <div class="grid-2">
          <div class="form-group">
            <label>Scenes per Chapter</label>
            <select v-model.number="form.scenes_per_chapter" class="select">
              <option :value="1">1 per chapter (default)</option>
              <option :value="2">2 per chapter</option>
              <option :value="3">3 per chapter</option>
              <option :value="4">4 per chapter</option>
              <option :value="0">Custom total...</option>
            </select>
            <span class="text-muted" style="font-size:11px; display:block; margin-top:4px;">
              Start with 1 to keep costs low — you can always generate more scenes for specific chapters later.
            </span>
          </div>
          <div class="form-group" v-if="form.scenes_per_chapter === 0">
            <label>Total Scene Prompts</label>
            <input v-model.number="form.total_scenes" class="input" type="number" min="1" max="60" />
          </div>
          <div class="form-group" v-else>
            <label>Estimated Total</label>
            <div class="estimate-value">~{{ estimatedScenes }} scenes</div>
          </div>
        </div>
        <button
          class="btn btn-sm btn-primary mt-2"
          :disabled="!form.episode_id || generating || !scriptReady"
          :title="!scriptReady && form.episode_id ? noScriptTooltip : 'Only regenerates scene prompts — thumbnails on disk are left untouched.'"
          @click="generateScenes"
        >
          <LoadingSpinner v-if="generating" size="sm" />
          Generate Scene Prompts Only
        </button>
      </div>

      <!-- ── Thumbnail Prompts section ─────────────────────────────────── -->
      <div class="split-section mt-2">
        <div class="split-header">
          <h3 style="font-size:14px; margin:0">🖼️ Thumbnail Prompts</h3>
          <span class="text-muted" style="font-size:11px">{{ safeThumbCount }} thumbnail variations</span>
        </div>
        <div class="grid-2">
          <div class="form-group">
            <label>Thumbnail Count</label>
            <input v-model.number="form.thumb_count" class="input" type="number" min="1" max="10" />
          </div>
          <div class="form-group">
            <label>Text Style</label>
            <select v-model="form.thumb_text_style" class="select">
              <option v-for="p in TEXT_STYLE_PRESETS" :key="p.id" :value="p.id">{{ p.label }}</option>
            </select>
            <input
              v-if="form.thumb_text_style === 'custom'"
              v-model="form.thumb_text_style_custom"
              class="input mt-1"
              placeholder="e.g. holographic rainbow foil, pastel sparkles with subtle glow…"
              maxlength="240"
            />
            <p v-if="form.thumb_text_style === 'custom'" class="text-muted" style="font-size: 11px; margin-top: 4px;">
              Free-form description (up to 240 chars). Dropped verbatim into the LLM prompt — be specific.
            </p>
          </div>
        </div>
        <div class="grid-2">
          <div class="form-group">
            <label>Text Position</label>
            <select v-model="form.thumb_text_position" class="select">
              <option value="center">Center</option>
              <option value="top">Top</option>
              <option value="bottom">Bottom</option>
            </select>
          </div>
          <div class="form-group">
            <label>Font Style</label>
            <select v-model="form.thumb_font_style" class="select">
              <option v-for="p in FONT_STYLE_PRESETS" :key="p.id" :value="p.id">{{ p.label }}</option>
            </select>
            <input
              v-if="form.thumb_font_style === 'custom'"
              v-model="form.thumb_font_style_custom"
              class="input mt-1"
              placeholder="e.g. bold slab serif with rounded corners, art-deco inspired…"
              maxlength="240"
            />
          </div>
        </div>

        <!-- Randomize + Surprise Me: full-size like the Ideas generator's -->
        <!-- action cluster so these feel like first-class actions, not -->
        <!-- afterthoughts (pain-point from test feedback). -->
        <div class="flex gap-2 mt-2" style="align-items: center; flex-wrap: wrap;">
          <button
            type="button"
            class="btn btn-secondary"
            title="Picks a random style + font preset (skips 'custom' to avoid blank fields)."
            @click="randomizeThumbStyles"
          >
            🎲 Randomize Styles
          </button>
          <button
            type="button"
            class="btn btn-secondary"
            :disabled="!form.episode_id || generating || !scriptReady"
            :title="!scriptReady && form.episode_id ? noScriptTooltip : 'Randomize style + font, then generate thumbnails immediately.'"
            @click="surpriseMeThumb"
          >
            ✨ Surprise Me
          </button>
        </div>

        <button
          class="btn btn-sm btn-primary mt-2"
          :disabled="!form.episode_id || generating || !scriptReady"
          :title="!scriptReady && form.episode_id ? noScriptTooltip : 'Only regenerates thumbnail prompts — scenes on disk are left untouched.'"
          @click="generateThumbnails"
        >
          <LoadingSpinner v-if="generating" size="sm" />
          Generate Thumbnail Prompts Only
        </button>
      </div>

      <div class="flex items-center gap-2 mt-2">
        <label class="checkbox-label">
          <input type="checkbox" v-model="form.force" />
          Force regenerate (overwrite existing)
        </label>
      </div>
      <!-- Progress bar -->
      <div v-if="generating" class="progress-bar mt-1">
        <div class="progress-fill" />
      </div>
    </div>

    <!-- Tabs: Current / History -->
    <div v-if="generatedPrompts || history.length > 0" class="mt-3">
      <div class="tabs">
        <button :class="['tab', { active: activeTab === 'current' }]" @click="activeTab = 'current'">
          Current {{ generatedPrompts ? `(${generatedPrompts.scenes.length + generatedPrompts.thumbnails.length})` : '' }}
        </button>
        <button :class="['tab', { active: activeTab === 'history' }]" @click="activeTab = 'history'">
          History ({{ history.length }})
        </button>
      </div>

      <!-- Current tab -->
      <div v-if="activeTab === 'current' && generatedPrompts" class="card mt-1">
        <div class="card-header">
          <h3>Review &amp; Edit</h3>
          <div class="flex gap-2">
            <button class="btn btn-sm btn-secondary" @click="saveToFile">Re-save edits</button>
            <button class="btn btn-sm btn-primary" @click="navigateTo(`/projects/${slug}/images`)">
              Generate Images →
            </button>
          </div>
        </div>

        <h3 class="mt-2">Scene Prompts ({{ generatedPrompts.scenes.length }})</h3>
        <div class="prompt-list mt-1">
          <div v-for="(scene, i) in generatedPrompts.scenes" :key="i" class="prompt-item">
            <div class="prompt-header">
              <strong>Scene {{ scene.number }}: {{ scene.title }}</strong>
              <button class="btn-icon" @click="removePrompt('scenes', Number(i))">✕</button>
            </div>
            <textarea v-model="scene.prompt" class="textarea prompt-edit" />
          </div>
        </div>

        <h3 class="mt-3">Thumbnail Prompts ({{ generatedPrompts.thumbnails.length }})</h3>
        <div class="prompt-list mt-1">
          <div v-for="(thumb, i) in generatedPrompts.thumbnails" :key="i" class="prompt-item">
            <div class="prompt-header">
              <strong>Thumbnail {{ thumb.number }}: {{ thumb.title }}</strong>
              <button class="btn-icon" @click="removePrompt('thumbnails', Number(i))">✕</button>
            </div>
            <textarea v-model="thumb.prompt" class="textarea prompt-edit" />
          </div>
        </div>
      </div>

      <EmptyState
        v-if="activeTab === 'current' && !generatedPrompts"
        class="mt-1"
        icon="🎨"
        title="No prompts generated yet"
        message="Configure your style, scene count, and thumbnail settings above — then click Generate."
      />

      <!-- History tab -->
      <div v-if="activeTab === 'history'" class="card mt-1">
        <EmptyState v-if="history.length === 0" icon="🕘" title="No history yet" message="Past prompt generations in this session will appear here." />
        <table v-else class="history-table">
          <thead>
            <tr>
              <th>Episode</th>
              <th>Style</th>
              <th>Ratio</th>
              <th>Scenes</th>
              <th>Thumbs</th>
              <th>Time</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(entry, i) in history" :key="i">
              <td class="td-code">{{ entry.episode_id }}</td>
              <td>{{ entry.style_preset }}</td>
              <td>{{ entry.aspect_ratio }}</td>
              <td>{{ entry.prompts.scenes.length }}</td>
              <td>{{ entry.prompts.thumbnails.length }}</td>
              <td class="text-muted">{{ formatTime(entry.generated_at) }}</td>
              <td>
                <button class="btn btn-sm btn-secondary" @click="loadFromHistory(entry)">Load</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

  </div>
</template>

<script setup lang="ts">
definePageMeta({ layout: 'dashboard' })
useHead({ title: "Image Prompts — Story Studio KH" })
const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { get, post } = useApi()
const { success, error: showError } = useToast()

const generating = ref(false)
const showStyleEditor = ref(false)
const generatedPrompts = ref<any>(null)
const customStyles = ref<any[]>([])
const activeTab = ref('current')

// ── Reference-image style extraction (pain-point #7) ─────────────────────
interface VisionModelCap { id: string; provider: 'anthropic' | 'openai' | 'unknown'; has_key: boolean }
const extracting = ref(false)
const referenceImagePath = ref<string | null>(null)
const lastAnalyzedAt = ref<string | null>(null)
const lastAnalysisModel = ref<string | null>(null)
const visionModels = ref<VisionModelCap[]>([])
const visionModel = ref<string>('claude-sonnet-4-6')

// Session history
interface HistoryEntry {
  episode_id: string
  style_preset: string
  aspect_ratio: string
  // Which slice of the result this entry captured — drives the "scenes only"
  // / "thumbs only" / "all" annotation in the History tab.
  mode: 'all' | 'scenes' | 'thumbnails'
  prompts: any
  generated_at: string
}
const history = ref<HistoryEntry[]>([])

const { promptGenerating: isGenerating } = useGenerating()

const STYLE_PRESETS: Record<string, string> = {
  'storybook': 'Storybook 2D illustration style, flat design, bold outlines, warm and luminous colour palette, bright golden and shiny accent details, soft cel-shaded depth, dreamlike and cosy atmosphere.',
  '3d-render': 'High-quality 3D rendered scene, soft ambient lighting, smooth materials, subtle depth of field, warm color grading, cinematic composition.',
  'watercolor': 'Delicate watercolor painting style, soft wet-on-wet washes, visible paper texture, gentle bleeding edges, pastel and muted tones, dreamy and ethereal atmosphere.',
  'anime': 'Japanese anime illustration style, clean linework, vibrant colors, expressive characters, dynamic composition, detailed backgrounds, Studio Ghibli inspired warmth.',
  'photorealistic': 'Photorealistic digital art, natural lighting, detailed textures, shallow depth of field, professional photography composition, atmospheric perspective.',
  'cinematic': 'Cinematic wide-angle shot, dramatic volumetric lighting, film grain, anamorphic lens flare, moody color grading, epic scale and atmosphere.',
  'pixel-art': 'Detailed pixel art style, limited color palette, clean pixels, retro game aesthetic, charming and nostalgic, warm tones.',
  'oil-painting': 'Classical oil painting style, visible brushstrokes, rich impasto texture, warm golden-hour lighting, Renaissance-inspired composition, deep saturated colors.',
  'flat-design': 'Modern flat design illustration, geometric shapes, bold solid colors, minimal shadows, clean vector aesthetic, contemporary and playful.',
  'charcoal': 'Charcoal drawing style, dramatic contrast, rough paper texture, expressive gestural strokes, moody atmosphere, monochrome with subtle warm tints.',
}

// Thumbnail text + font preset catalogs. Ids must match the backend maps
// in `electron/server/models/thumbnail-styles.ts` — when the user picks an
// id the backend resolves the rich phrase; when they pick `custom`, the
// `*_custom` text is sent as-is.
interface StylePreset { id: string; label: string }
const TEXT_STYLE_PRESETS: StylePreset[] = [
  { id: 'gold',             label: 'Golden Glow' },
  { id: 'white',            label: 'Clean White' },
  { id: 'neon',             label: 'Neon Glow' },
  { id: 'metallic',         label: '3D Metallic' },
  { id: 'chrome',           label: 'Chrome / Silver' },
  { id: 'script',           label: 'Elegant Script (gold)' },
  { id: 'fire',             label: 'Fiery Orange/Red' },
  { id: 'ice',              label: 'Icy Blue' },
  { id: 'gradient-sunset',  label: 'Sunset Gradient' },
  { id: 'gradient-ocean',   label: 'Ocean Gradient' },
  { id: 'comic',            label: 'Comic Book POP' },
  { id: 'horror',           label: 'Horror / Blood Drip' },
  { id: 'retro',            label: 'Retro 80s Synthwave' },
  { id: 'shadow',           label: 'Deep Drop Shadow' },
  { id: 'glitch',           label: 'Digital Glitch' },
  { id: 'embossed',         label: 'Embossed 3D Bevel' },
  { id: 'handwritten',      label: 'Handwritten Inked' },
  { id: 'vintage',          label: 'Vintage Sepia' },
  { id: 'pastel',           label: 'Soft Pastel' },
  { id: 'custom',           label: 'Custom (describe it…)' },
]
const FONT_STYLE_PRESETS: StylePreset[] = [
  { id: 'serif',        label: 'Serif (Classic)' },
  { id: 'script',       label: 'Script (Elegant)' },
  { id: 'bold',         label: 'Bold Sans-Serif' },
  { id: 'fantasy',      label: 'Fantasy' },
  { id: 'display',      label: 'Display / Headline' },
  { id: 'condensed',    label: 'Condensed Sans' },
  { id: 'handwritten',  label: 'Handwritten / Casual' },
  { id: 'gothic',       label: 'Blackletter Gothic' },
  { id: 'retro-chrome', label: 'Retro Chrome' },
  { id: 'futuristic',   label: 'Futuristic / Tech' },
  { id: 'typewriter',   label: 'Typewriter / Monospace' },
  { id: 'brush',        label: 'Brush Stroke' },
  { id: 'graffiti',     label: 'Graffiti / Street' },
  { id: 'playful',      label: 'Playful Rounded' },
  { id: 'stencil',      label: 'Stencil' },
  { id: 'hand-drawn',   label: 'Hand-Drawn Sketch' },
  { id: 'custom',       label: 'Custom (describe it…)' },
]

const form = reactive({
  episode_id: '',
  model: 'gpt-4o',
  style_preset: 'storybook',
  style_tag: STYLE_PRESETS['storybook'],
  aspect_ratio: '16:9',
  scenes_per_chapter: 1,
  total_scenes: 10,
  thumb_count: 5,
  thumb_text_style: 'gold',
  thumb_text_style_custom: '',
  thumb_text_position: 'center',
  thumb_font_style: 'serif',
  thumb_font_style_custom: '',
  force: false,
})

function pickRandomPresetId(presets: StylePreset[]): string {
  // Skip the 'custom' sentinel — randomizing into custom would leave the
  // *_custom text empty and confuse the user about why their thumbnail
  // didn't pick up the new style.
  const pool = presets.filter(p => p.id !== 'custom')
  const pick = pool[Math.floor(Math.random() * pool.length)]
  return pick!.id
}

function randomizeThumbStyles() {
  form.thumb_text_style = pickRandomPresetId(TEXT_STYLE_PRESETS)
  form.thumb_font_style = pickRandomPresetId(FONT_STYLE_PRESETS)
  success(`Rolled: ${form.thumb_text_style} + ${form.thumb_font_style}`)
}

async function surpriseMeThumb() {
  randomizeThumbStyles()
  await nextTick()
  await generateThumbnails()
}

// Source-of-truth episode hydration. `scriptReady` is the gate for the
// Generate buttons below — image prompts read narration context from the
// script docx, so generating without it would 500 on the backend. Refetch
// when a script-only job lands so the gate enables itself live.
const { selectedEpisode, scriptReady } = useEpisodeStatus(
  computed(() => form.episode_id),
  slug,
  { refetchOnJobTypes: ['script-only'] },
)
const noScriptTooltip = 'Generate the script first to unlock this generator.'

// Both sides coerced + NaN-guarded. Previously either a non-numeric
// `suggested_chapters` from the ideas record OR an older preset that
// restored `scenes_per_chapter` as undefined could land NaN here and
// surface in the UI as "~NaN scenes / ~NaN prompts will be generated".
const estimatedScenes = computed(() => {
  const chapters = Number(selectedEpisode.value?.suggested_chapters)
  const perChapter = Number(form.scenes_per_chapter)
  const safeChapters = Number.isFinite(chapters) && chapters > 0 ? chapters : 10
  const safePer = Number.isFinite(perChapter) && perChapter > 0 ? perChapter : 0
  const total = safeChapters * safePer
  return Number.isFinite(total) && total > 0 ? total : 0
})

// Same defensive coercion for the thumbnail variations display — clearing
// the number input would otherwise render "NaN thumbnail variations".
const safeThumbCount = computed(() => {
  const n = Number(form.thumb_count)
  return Number.isFinite(n) && n > 0 ? n : 0
})

// Clamp numeric form fields so clearing the input (→ NaN via v-model.number)
// doesn't wedge the form in a submit-blocking state. Default to a sensible
// minimum, user can still raise after typing again.
watch(() => form.thumb_count, (v) => {
  if (!Number.isFinite(v) || v < 1) form.thumb_count = 1
})
watch(() => form.total_scenes, (v) => {
  if (!Number.isFinite(v) || v < 1) form.total_scenes = 1
})

// ── Presets ─────────────────────────────────────────────────────────────
const promptPresets = usePresets<any>({
  slug: slug.value,
  configKey: 'image_prompts',
  snapshot: () => ({ form: { ...form } }),
  apply: (data) => { if (data?.form) Object.assign(form, data.form) },
})
onMounted(() => {
  void promptPresets.load()
  void loadVisionCaps()
})

// ── Vision / style-extraction ──────────────────────────────────────────
const VISION_CAPABLE = new Set<string>([
  'claude-sonnet-4-6', 'claude-opus-4-7', 'claude-3-5-sonnet-latest',
  'claude-3-5-sonnet-20241022', 'claude-3-opus-20240229',
  'gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-5',
])

const referencePreviewUrl = computed(() => {
  if (!referenceImagePath.value) return ''
  return `/api/projects/${slug.value}/video-editor/preview-image?path=${encodeURIComponent(referenceImagePath.value)}`
})

const referenceImageName = computed(() => {
  const p = referenceImagePath.value || ''
  return p.split('/').pop() || p
})

const lastAnalyzedAtRelative = computed(() => {
  if (!lastAnalyzedAt.value) return ''
  const diff = Date.now() - new Date(lastAnalyzedAt.value).getTime()
  if (diff < 60_000) return 'just now'
  if (diff < 3600_000) return `${Math.round(diff / 60_000)} min ago`
  return `${Math.round(diff / 3600_000)} h ago`
})

function formatVisionModelLabel(m: VisionModelCap): string {
  const base = m.id
  if (!m.has_key) return `${base} — no key`
  return base
}

async function loadVisionCaps() {
  try {
    const data = await get<{ models: VisionModelCap[]; default: string }>(
      `/projects/${slug.value}/vision/caps`,
    )
    visionModels.value = data.models || []
    // Default: current image-prompts model if it's vision-capable AND has a
    // key, else the first vision-capable model that has a key, else the
    // server-suggested default.
    const current = form.model
    if (VISION_CAPABLE.has(current) && visionModels.value.find(m => m.id === current && m.has_key)) {
      visionModel.value = current
    } else {
      const firstWithKey = visionModels.value.find(m => m.has_key)
      visionModel.value = firstWithKey?.id || data.default
    }
  } catch { /* tolerate — keep default */ }
}

async function pickReferenceImage() {
  try {
    const r = await post<{ path: string | null }>('/system/pick-file', {
      title: 'Choose a reference image',
      buttonLabel: 'Use as Reference',
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    })
    if (!r.path) return
    referenceImagePath.value = r.path
    lastAnalyzedAt.value = null
    lastAnalysisModel.value = null
    // Auto-extract on first pick — saves the user one click. Re-analyze is
    // for iterating on the model/focus without re-picking.
    await extractStyle()
  } catch (e: any) {
    showError(`Reference picker failed — ${e.data?.detail || e.message || 'unknown error'}`)
  }
}

async function extractStyle() {
  if (!referenceImagePath.value) {
    showError('Pick a reference image first')
    return
  }
  extracting.value = true
  try {
    const data = await post<{ style_text: string; model_used: string }>(
      `/projects/${slug.value}/analyze-style`,
      {
        image_path: referenceImagePath.value,
        model: visionModel.value,
      },
    )
    // Switch to custom style so the textarea is visible + editable.
    form.style_preset = 'custom'
    showStyleEditor.value = true
    form.style_tag = data.style_text
    lastAnalyzedAt.value = new Date().toISOString()
    lastAnalysisModel.value = data.model_used
    success(`Style extracted via ${data.model_used}`)
  } catch (e: any) {
    showError(e?.data?.detail || 'Style analysis failed')
  } finally {
    extracting.value = false
  }
}

function clearReference() {
  referenceImagePath.value = null
  lastAnalyzedAt.value = null
  lastAnalysisModel.value = null
}

function onStyleChange() {
  if (form.style_preset in STYLE_PRESETS) {
    form.style_tag = STYLE_PRESETS[form.style_preset]
    showStyleEditor.value = false
  } else if (form.style_preset === 'custom') {
    form.style_tag = ''
    showStyleEditor.value = true
  }
}

function removePrompt(type: 'scenes' | 'thumbnails', index: number) {
  if (generatedPrompts.value) generatedPrompts.value[type].splice(index, 1)
}

function formatTime(d: string) {
  try { return new Date(d).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) }
  catch { return d }
}

function loadFromHistory(entry: HistoryEntry) {
  generatedPrompts.value = JSON.parse(JSON.stringify(entry.prompts))
  form.episode_id = entry.episode_id
  activeTab.value = 'current'
  success(`Loaded prompts for ${entry.episode_id}`)
}

// Generation helpers — `mode` picks which half of the payload the backend
// returns. 'scenes' / 'thumbnails' keep the other half untouched on disk
// (the save endpoint only writes docx files for arrays actually present
// in the payload), so a Scene-only run never clobbers an existing thumb
// file, and vice-versa.
type PromptMode = 'all' | 'scenes' | 'thumbnails'

async function runGenerate(mode: PromptMode) {
  if (!form.episode_id) return
  generating.value = true
  isGenerating.value = true
  try {
    const result = await post(`/projects/${slug.value}/generate/image-prompts`, {
      episode_id: form.episode_id,
      model: form.model,
      style_tag: form.style_tag,
      aspect_ratio: form.aspect_ratio,
      scenes_per_chapter: form.scenes_per_chapter === 0 ? undefined : form.scenes_per_chapter,
      total_scenes: form.scenes_per_chapter === 0 ? form.total_scenes : undefined,
      thumb_count: form.thumb_count,
      thumb_text_style: form.thumb_text_style,
      thumb_text_style_custom: form.thumb_text_style_custom,
      thumb_text_position: form.thumb_text_position,
      thumb_font_style: form.thumb_font_style,
      thumb_font_style_custom: form.thumb_font_style_custom,
      title: selectedEpisode.value?.title || '',
      mode,
    })
    // When generating one half only, merge into the currently-reviewed
    // result so the UI keeps showing the other half that was already there.
    if (mode === 'all' || !generatedPrompts.value) {
      generatedPrompts.value = result
    } else {
      generatedPrompts.value = {
        ...generatedPrompts.value,
        scenes: mode === 'scenes' ? (result.scenes || []) : generatedPrompts.value.scenes,
        thumbnails: mode === 'thumbnails' ? (result.thumbnails || []) : generatedPrompts.value.thumbnails,
      }
    }

    history.value.unshift({
      episode_id: form.episode_id,
      style_preset: form.style_preset,
      aspect_ratio: form.aspect_ratio,
      mode,
      prompts: JSON.parse(JSON.stringify(generatedPrompts.value)),
      generated_at: new Date().toISOString(),
    })

    // Auto-save only the part we just generated so a Scene-only run doesn't
    // resave stale thumbnails (and vice versa).
    const toSave: any = {}
    if (mode === 'all' || mode === 'scenes') toSave.scenes = result.scenes || []
    if (mode === 'all' || mode === 'thumbnails') toSave.thumbnails = result.thumbnails || []
    await post(`/projects/${slug.value}/generate/image-prompts/save`, {
      episode_id: form.episode_id,
      title: selectedEpisode.value?.title || '',
      prompts: toSave,
    })

    activeTab.value = 'current'
    const sceneCt = result.scenes?.length || 0
    const thumbCt = result.thumbnails?.length || 0
    const msg = mode === 'scenes' ? `Generated ${sceneCt} scene prompts`
      : mode === 'thumbnails' ? `Generated ${thumbCt} thumbnail prompts`
      : `Generated ${sceneCt} scene + ${thumbCt} thumbnail prompts`
    success(msg)
  } catch (e: any) {
    showError(e.data?.detail || 'Failed to generate image prompts')
  } finally {
    generating.value = false
    isGenerating.value = false
  }
}

async function generate() { await runGenerate('all') }
async function generateScenes() { await runGenerate('scenes') }
async function generateThumbnails() { await runGenerate('thumbnails') }

async function saveToFile() {
  if (!generatedPrompts.value) return
  try {
    await post(`/projects/${slug.value}/generate/image-prompts/save`, {
      episode_id: form.episode_id,
      title: selectedEpisode.value?.title || '',
      prompts: generatedPrompts.value,
    })
    success('Image prompts saved to .docx!')
  } catch (e: any) {
    showError(e.data?.detail || 'Failed to save')
  }
}
</script>

<style scoped>
/* Visual separation for the per-section blocks (Scenes vs Thumbnails) */
.split-section {
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 14px 16px;
}
.split-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
}

.estimate-value {
  padding: 10px 14px;
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--accent);
  font-size: 14px;
}

/* Progress bar */
.progress-bar {
  height: 3px;
  background: var(--bg-tertiary);
  border-radius: 2px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: var(--accent);
  border-radius: 2px;
  animation: progressIndeterminate 1.5s ease-in-out infinite;
}

@keyframes progressIndeterminate {
  0% { width: 0%; margin-left: 0; }
  50% { width: 60%; margin-left: 20%; }
  100% { width: 0%; margin-left: 100%; }
}

/* Tabs */
.tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--border);
}

.tab {
  padding: 10px 18px;
  font-size: 14px;
  color: var(--text-muted);
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  font-family: inherit;
}
.tab:hover { color: var(--text-primary); }
.tab.active { color: var(--accent); border-bottom-color: var(--accent); }

/* History table */
.history-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.history-table th {
  text-align: left;
  font-size: 12px;
  color: var(--text-muted);
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
}
.history-table td {
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
}
.td-code { font-weight: 600; color: var(--accent); }

/* Prompts */
.prompt-list { display: flex; flex-direction: column; gap: 12px; }
.prompt-item { background: var(--bg-tertiary); border-radius: var(--radius-md); padding: 12px; }
.prompt-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; font-size: 14px; }
.prompt-edit { min-height: 60px; font-size: 13px; background: var(--bg-primary); }
.btn-icon { background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 14px; padding: 4px 8px; border-radius: 4px; }
.btn-icon:hover { color: var(--error); background: rgba(248, 113, 113, 0.1); }
.checkbox-label { display: flex; align-items: center; gap: 6px; font-size: 13px; cursor: pointer; color: var(--text-muted); }

.style-extract { padding: 10px 12px; background: var(--bg-tertiary); border-radius: var(--radius-sm); border: 1px dashed var(--border); }
.style-extract-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.style-extract-preview { display: flex; gap: 12px; align-items: flex-start; }
.style-extract-thumb { width: 80px; height: 80px; object-fit: cover; border-radius: var(--radius-sm); border: 1px solid var(--border); flex-shrink: 0; }
.style-extract-meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.style-extract-filename { font-size: 12px; font-weight: 600; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.style-extract-clear { align-self: flex-start; margin-top: 4px; padding: 2px 8px; font-size: 11px; color: var(--text-muted); }
.style-extract-clear:hover { color: var(--error); }
</style>
