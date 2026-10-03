<template>
  <div class="workspace-page creation-workspace thumbnail-prompts-workspace">
    <WorkspaceHero
      eyebrow="Create · Art direction"
      title="Thumbnail Prompts"
      description="Create a few strong cover-art directions, then pick the one worth rendering."
    >
      <template #aside>
        <div class="workspace-metrics" aria-label="Thumbnail prompt workspace context">
          <span class="workspace-metric" :data-tone="form.episode_id ? 'success' : 'warning'"><strong>{{ form.episode_id || 'No episode' }}</strong> target</span>
          <span class="workspace-metric" data-tone="info"><strong>{{ activeForm.aspect_ratio }}</strong> frame</span>
          <span v-if="promptsJobActiveForEpisode" class="workspace-metric" data-tone="warning"><strong>Active</strong> generation</span>
        </div>
      </template>
    </WorkspaceHero>
    <div class="workspace-command-surface creation-command-surface">
      <TopActionBar
      :project-slug="slug"
      :presets="promptPresets"
      v-model:episode-id="form.episode_id"
      :filter-field="promptFilterField"
      :generate-label="generateLabel"
      :generate-loading="generating || promptsJobActiveForEpisode"
      :generate-disabled="!form.episode_id"
      :generate-status="(generating || promptsJobActiveForEpisode) ? `Generating prompts for ${form.episode_id}…` : ''"
      @generate="generate"
      />
      <p class="workspace-command-copy">
        Pick a look, add one idea if you have it, then generate variations.
      </p>
    </div>


    <div class="card workspace-section prompt-settings-panel">
      <div class="grid-2">
        <div class="form-group">
          <ModelSelector
            v-model="form.thumbnail.model"
            :project-slug="slug"
            writing-step
            label="Prompt model"
            :require-vision="Boolean(form.thumbnail.thumb_reference_asset)"
          />
          <p class="text-muted text-xs hint-line">
            <template v-if="form.thumbnail.thumb_reference_asset">Only vision-capable models are shown while this reference is attached.</template>
            <template v-else>This model writes the thumbnail prompts. Image rendering uses the separate model chosen in Thumbnail Generator.</template>
          </p>
        </div>
        <div class="form-group">
          <label>Variations</label>
          <input v-model.number="form.thumbnail.thumb_count" class="input" type="number" min="1" max="6" />
          <p class="text-muted text-xs hint-line">Start with three. You can refine or regenerate one prompt later.</p>
        </div>
      </div>
      <div v-if="form.episode_id && existingThumbNumbers.length" class="replace-prompts-row mt-1">
        <button
          type="button"
          class="btn btn-sm btn-secondary"
          :disabled="generating || promptsJobActiveForEpisode"
          @click="replaceAllThumbnailPrompts"
        >
          Replace All {{ existingThumbNumbers.length }} Prompts
        </button>
        <span class="text-muted text-xs">
          Generate only fills in missing prompts. This writes every prompt for {{ form.episode_id }} again from scratch.
        </span>
      </div>
      <div class="form-group mt-2">
        <ThumbnailRecipePicker
          :selected-recipe-id="form.thumbnail.thumbnail_template_id"
          @select="applyThumbnailRecipe"
        />
      </div>
      <div v-if="thumbnailHeadlineInvents" class="thumbnail-hook-policy mt-1">
        <div>
          <span>CURIOUS COPY</span>
          <strong>Short thumbnail hook</strong>
          <p>Each variation gets its own 1–4 word hook, generated from the episode’s real question and rendered directly inside the image.</p>
        </div>
        <span>Full YouTube title stays in Metadata</span>
      </div>
      <div class="form-group mt-2">
        <label>Visual art style</label>
        <StylePicker
          :slug="slug"
          :active-style-bible="form.thumbnail.style_tag"
          @apply="applyThumbnailVisualStyle"
        />
      </div>

      <!-- Rare on purpose: importing a reference is something he does now and
           again, and it was sitting between the art style and the lettering,
           interrupting the run he actually makes every episode — style, then
           recipe, then what the words say and look like. -->
      <details class="advanced-reference mt-2">
        <summary>
          <span>Use an existing thumbnail as a guide</span>
          <span class="advanced-reference__note">{{ thumbnailReferenceSummary }}</span>
        </summary>
        <section class="thumbnail-reference-card" aria-labelledby="thumbnail-reference-heading">
          <div class="thumbnail-reference-card__heading">
            <div>
              <p class="thumbnail-reference-card__eyebrow">OPTIONAL · PRIVATE INPUT</p>
              <h3 id="thumbnail-reference-heading">Reference-guided thumbnail</h3>
              <p class="text-muted text-xs">
                Import one existing thumbnail, analyse its composition, then use it privately as an original re-framing guide for this channel.
              </p>
            </div>
            <span class="thumbnail-reference-card__status" :class="{ active: form.thumbnail.thumb_reference_asset }">
              {{ form.thumbnail.thumb_reference_asset ? 'Reference ready' : 'No reference' }}
            </span>
          </div>

          <div class="flex gap-2 items-center flex-wrap mt-1">
            <button
              type="button"
              class="btn btn-secondary"
              :disabled="extractingThumbRef || !thumbnailVisionModels.length"
              @click="extractThumbReferenceStyle"
            >
              <LoadingSpinner v-if="extractingThumbRef" size="sm" />
              <span v-else aria-hidden="true">📷</span>
              {{ form.thumbnail.thumb_reference_asset ? 'Replace & analyse reference…' : 'Import & analyse reference…' }}
            </button>
            <button
              v-if="form.thumbnail.thumb_reference_asset"
              type="button"
              class="btn btn-ghost"
              @click="clearThumbnailReference"
            >
              Remove Reference
            </button>
            <button
              v-if="thumbnailVisionLoadError || !thumbnailVisionModels.length"
              type="button"
              class="btn btn-ghost"
              :disabled="thumbnailVisionLoading"
              @click="loadThumbnailVisionModels"
            >
              {{ thumbnailVisionLoading ? 'Checking Vision Models…' : 'Retry Vision Models' }}
            </button>
          </div>

          <template v-if="thumbnailVisionModels.length">
            <p class="text-muted text-xs hint-line">
              The image is uploaded privately to the Gateway for analysis and generation—never as a local path, browser URL, or public URL.
            </p>
            <div class="form-group mt-1">
              <label>Composition analysis model</label>
              <ModelMenu
                v-model="thumbnailVisionModel"
                class="vision-model-select"
                :options="thumbnailVisionModelMenuOptions"
                media-type="llm"
                title="Thumbnail reference analysis model"
                search-placeholder="Search vision models…"
                :disabled="extractingThumbRef"
              />
              <p v-if="selectedThumbnailVisionModel" class="text-muted text-xs hint-line">
                Reads {{ selectedThumbnailVisionModel.max_input_images }} image · {{ selectedThumbnailVisionModel.accepted_image_mime_types.map(type => type.replace(/^image\//, '').toUpperCase()).join(', ') }} files · up to {{ Math.round(selectedThumbnailVisionModel.max_image_bytes / 1024 / 1024) }} MB and {{ selectedThumbnailVisionModel.max_image_dimension }}px on the longest side
              </p>
            </div>
          </template>
          <p v-else class="thumbnail-reference-card__warning">
            {{ thumbnailVisionLoadError || 'No currently available Gateway model is qualified to analyse a thumbnail reference. Check the Gateway connection, then retry.' }}
          </p>

          <template v-if="form.thumbnail.thumb_reference_asset">
            <textarea
              v-model="form.thumbnail.thumb_reference_style"
              class="textarea mt-1"
              rows="3"
              aria-label="Reference composition brief"
              placeholder="Analysed composition brief…"
            />
            <p class="text-muted text-xs hint-line">
              <strong>{{ form.thumbnail.thumb_reference_asset.filename }}</strong> · analysed by {{ form.thumbnail.thumb_reference_asset.analysis_model_name }} · saved with this preset, project, and Pipeline runs.
            </p>
          </template>
        </section>
      </details>

      <!-- One card for the whole lettering decision, the way Channel art style
           is one card: the letterform, the treatment and where it sits. They
           were three scattered dropdowns of words nobody can picture. -->
      <section class="lettering-card mt-2" aria-labelledby="lettering-heading">
        <header class="lettering-head">
          <div><span class="lettering-eyebrow">Thumbnail lettering</span><h4 id="lettering-heading">What the words say, and how they look</h4></div>
          <button type="button" class="link-btn" title="Pick a random font, text style and title location. Nothing is generated." @click="randomizeThumbStyles">🎲 Shuffle Lettering</button>
        </header>

        <!-- WHAT THE WORDS SAY comes before how they look, because it is the
             decision that changes the picture most. It lived higher up the page
             in a block he never saw -- twice -- so it now sits in the one card
             he does. -->
        <div class="lettering-part">
          <div class="lettering-part-head"><strong>Thumbnail text</strong><span>What the words actually say</span></div>
          <div class="headline-modes" role="radiogroup" aria-label="What the thumbnail text should say">
            <button
              v-for="mode in headlineModes" :key="mode.id" type="button" role="radio"
              :aria-checked="form.thumbnail.thumb_headline_mode === mode.id"
              :class="['headline-mode', { selected: form.thumbnail.thumb_headline_mode === mode.id }]"
              @click="form.thumbnail.thumb_headline_mode = mode.id"
            >
              <strong>{{ mode.label }}</strong>
              <span>{{ mode.summary }}</span>
            </button>
          </div>
          <p v-if="!headlineModes.length" class="text-muted text-xs">Could not load the text options — reopen the page to try again.</p>
        </div>

        <div class="lettering-part">
          <div class="lettering-part-head"><strong>Font</strong><span>The shape of the letters</span></div>
          <LetteringSwatchPicker
            v-model="form.thumbnail.thumb_font_style" kind="font"
            :aspect-ratio="form.thumbnail.aspect_ratio || '16:9'"
            title="Choose a font"
            caption="Same word in every swatch, so only the letterform differs"
          />
        </div>

        <div class="lettering-part">
          <div class="lettering-part-head"><strong>Text style</strong><span>The finish on the letters</span></div>
          <LetteringSwatchPicker
            v-model="form.thumbnail.thumb_text_style" kind="text"
            :aspect-ratio="form.thumbnail.aspect_ratio || '16:9'"
            title="Choose a text style"
            caption="Same word and same letterform, so only the finish differs"
          />
        </div>

        <div class="lettering-part">
          <div class="lettering-part-head"><strong>Title location</strong><span>Where the words sit in the frame</span></div>
          <div class="lettering-positions" role="radiogroup" aria-label="Title location">
            <button
              v-for="option in titleLocations" :key="option.id" type="button" role="radio"
              :aria-checked="form.thumbnail.thumb_text_position === option.id"
              :class="['position-chip', { selected: form.thumbnail.thumb_text_position === option.id }]"
              @click="form.thumbnail.thumb_text_position = option.id"
            >{{ option.label }}</button>
          </div>
        </div>
      </section>
      <div class="flex gap-2 mt-1 items-center flex-wrap">
        <button
          type="button"
          class="btn btn-secondary"
          :disabled="!form.episode_id || generating"
          @click="surpriseMeThumb"
        >
          ✨ Shuffle &amp; Generate
        </button>
        <span class="text-muted text-xs">Shuffles the lettering, then generates the missing prompts straight away.</span>
      </div>

      <div class="form-group mt-2">
        <label>What should make someone click? <span class="text-muted">(optional)</span></label>
        <textarea
          v-model="form.thumbnail.thumb_creative_direction"
          class="textarea"
          rows="3"
          placeholder="e.g. a lone ship against an impossible storm, urgent and mysterious"
        />
        <p class="text-muted text-xs hint-line">
          <template v-if="thumbnailHeadlineMode === 'none'">No words are drawn on these thumbnails — this note only guides the picture.</template>
          <template v-else-if="thumbnailHeadlineInvents">Each thumbnail gets its own short text, written to suit it. Check it with the prompt before rendering.</template>
          <template v-else>The episode title is drawn directly into every thumbnail.</template>
          This note is for this episode only and is cleared when you switch episode.
        </p>
      </div>

      <div v-if="generating" class="progress-bar mt-2">
        <div class="progress-fill" />
      </div>
    </div>

    <PromptReviewPanel
      v-if="form.episode_id"
      :project-slug="slug"
      :episode-id="form.episode_id"
      :title="selectedEpisode?.title || ''"
      :model="activeForm.model"
      :refresh-key="reviewRefreshKey"
      :thumbnail-headline-mode="thumbnailHeadlineMode"
      :thumbnail-prompt-cap="effectivePromptCharCap || null"
      :thumbnail-model-label="intendedImageModel?.display_name || ''"
      :thumbnail-font-style="form.thumbnail.thumb_font_style"
      :thumbnail-text-style="form.thumbnail.thumb_text_style"
      :thumbnail-font-style-custom="form.thumbnail.thumb_font_style_custom"
      :thumbnail-text-style-custom="form.thumbnail.thumb_text_style_custom"
      @loaded="existingThumbNumbers = $event.thumbnails"
    />

  </div>
</template>

<script setup lang="ts">
import { DEFAULT_EXCLUDE_KEYS } from '~/composables/usePresets'
import {
  normalizePromptCharCapSetting,
  publishedPromptCharCap,
  resolvePromptCharCap,
  type PromptCharCapSetting,
} from '~/utils/prompt-char-cap'
import { readRememberedImageModelId } from '~/utils/project-image-model'
import { selectLiveGenStudioModel } from '~/utils/live-genstudio-model-selection'
import { thumbnailVisionModelMenuOption, type ThumbnailVisionModel } from '~/utils/thumbnail-vision-model-menu'
definePageMeta({ layout: 'dashboard' })
const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { get, post, put } = useApi()
const freshImagePromptsAction = useFreshGenerationAction()
const { success, info: showInfo, error: showError } = useToast()

const generating = ref(false)
/** Thumbnail prompt numbers on disk for this episode, reported by PromptReviewPanel. */
const existingThumbNumbers = ref<number[]>([])

/**
 * Run `restore` (the remembered-form restore) and report, per sub-form, which
 * of `keys` it actually supplied. Keys it did not supply get their default back.
 */
function probeRememberedKeys<K extends string>(
  form: object,
  keys: Record<K, readonly string[]>,
  restore: () => void,
): Record<K, Set<string>> {
  const target = form as Record<string, Record<string, any>>
  const defaults: Record<string, Record<string, any>> = {}
  for (const sub of Object.keys(keys) as K[]) {
    const subForm = target[sub]!
    const subDefaults: Record<string, any> = {}
    defaults[sub] = subDefaults
    for (const key of keys[sub]) {
      subDefaults[key] = subForm[key]
      subForm[key] = undefined
    }
  }
  restore()
  const remembered = {} as Record<K, Set<string>>
  for (const sub of Object.keys(keys) as K[]) {
    const subForm = target[sub]!
    const subDefaults = defaults[sub]!
    const seen = new Set<string>()
    remembered[sub] = seen
    for (const key of keys[sub]) {
      if (subForm[key] === undefined || subForm[key] === null) subForm[key] = subDefaults[key]
      else seen.add(key)
    }
  }
  return remembered
}
// Bumped after the bulk Generate completes so the per-prompt
// PromptReviewPanel re-fetches the freshly-saved docx and the user
// sees their just-generated prompts in the regen panel.
const reviewRefreshKey = ref(0)
useAppTitle('Thumbnail Prompts')
// The Pending-only episode filter follows the thumbnail prompt status.
const promptFilterField = computed(() => 'thumb_prompts')
const generateLabel = 'Generate Thumbnail Prompts'
// Old `?tab=scenes` links land on the one remaining tab.
const _router = useRouter()
if (route.query.tab === 'scenes') {
  void _router.replace({ query: { ...route.query, tab: 'thumbnails' } })
}

// ── Thumbnail reference (analysed by a Gateway vision model) ─────────────
interface ThumbnailReferenceAsset {
  id: string
  filename: string
  sha256: string
  reframing_prompt: string
  analysis_model_name: string
  analyzed_at: string
  [key: string]: any
}
const thumbnailVisionModels = ref<ThumbnailVisionModel[]>([])
const thumbnailVisionModel = ref('')
const thumbnailVisionLoading = ref(false)
const thumbnailVisionLoadError = ref('')
// Called through an arrow rather than passed to `map` directly: `map` hands its
// callback the array index second, and the options bag is what carries `now`.
const thumbnailVisionModelMenuOptions = computed(() => thumbnailVisionModels.value.map(model => thumbnailVisionModelMenuOption(model)))
const selectedThumbnailVisionModel = computed(() => thumbnailVisionModels.value.find(model => model.id === thumbnailVisionModel.value) || null)

// Lights the Thumbnail Prompts nav pulse while a run is going.
const { thumbPromptGenerating } = useGenerating()

const DEFAULT_STYLE_TAG = 'Storybook 2D illustration style, flat design, bold outlines, warm and luminous colour palette, bright golden and shiny accent details, soft cel-shaded depth, dreamlike and cosy atmosphere.'

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
  { id: 'script',           label: 'Golden Shimmer' },
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
  { id: 'handwritten',      label: 'Inked Finish' },
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

// The form keeps its thumbnail settings under `form.thumbnail`; `episode_id`
// stays at the top level. Stored forms may still carry an old `scene` object,
// which is simply never read.
type SharedFormFields = {
  model: string
  style_preset: string
  style_tag: string
  aspect_ratio: string
  character_ids: string[]
  force: boolean
}
type ThumbnailForm = SharedFormFields & {
  thumbnail_template_id: string
  thumb_count: number
  thumb_text_style: string
  thumb_text_style_custom: string
  thumb_text_position: string
  thumb_font_style: string
  thumb_font_style_custom: string
  thumb_title_mode: 'ai'
  thumb_headline_mode: string
  thumb_art_direction: string
  thumb_reference_style: string
  thumb_reference_asset: ThumbnailReferenceAsset | null
  thumb_creative_mode: 'strict' | 'guided' | 'open'
  thumb_strategy: 'auto' | 'character' | 'object' | 'environment' | 'typographic' | 'mystery' | 'documentary'
  thumb_creative_direction: string
  /** Which image model these prompts are written FOR (a hint, not a render
   *  decision) and the character ceiling in force. See utils/prompt-char-cap. */
  intended_image_model: string
  prompt_char_cap: PromptCharCapSetting
}
const form = reactive({
  episode_id: '',
  thumbnail: {
    model: '',
    style_preset: 'storybook',
    style_tag: DEFAULT_STYLE_TAG,
    aspect_ratio: '16:9',
    character_ids: [] as string[],
    force: false,
    thumbnail_template_id: '',
    thumb_count: 3,
    thumb_text_style: 'auto',
    thumb_text_style_custom: '',
    thumb_text_position: 'auto',
    thumb_font_style: 'auto',
    thumb_font_style_custom: '',
    thumb_title_mode: 'ai',
    // Starts on the short option for new work; a recipe or an explicit
    // choice still wins. See PREFERRED_NEW_HEADLINE_MODE.
    thumb_headline_mode: 'short-hook' as string,
    thumb_art_direction: '',
    thumb_reference_style: '',
    thumb_reference_asset: null,
    thumb_creative_mode: 'guided',
    thumb_strategy: 'auto',
    thumb_creative_direction: '',
    // Which image model these prompts are WRITTEN for. A writing hint only: it
    // drives the Auto character ceiling and nothing else, and never changes
    // what the Generator page renders with. Both fields ride the existing
    // thumbnail preset (which snapshots this object wholesale).
    intended_image_model: '',
    prompt_char_cap: 'auto' as PromptCharCapSetting,
  } as ThumbnailForm,
})

// ── Prompt character ceiling ────────────────────────────────────────────────
// An LLM writes these prompts; a separately chosen image model renders them.
// The ceiling comes from GenStudio's published `max_prompt_characters` for the
// model the user intends to render with — never from a list kept here — and is
// handed to the writer as a limit, not as a length to fill. Nothing is
// truncated: an over-ceiling prompt is counted and flagged amber on its row.
const { models: genStudioImageModels, refresh: refreshGenStudioImageModels } = useGenStudioImageModels()
const usableImageModels = computed(() =>
  genStudioImageModels.value.filter(model => model.available !== false && model.qualification_only !== true),
)
const intendedImageModel = computed(() =>
  usableImageModels.value.find(model => model.id === form.thumbnail.intended_image_model) || null,
)
const intendedImageModelCap = computed(() => publishedPromptCharCap(intendedImageModel.value))
/** The number in force. 0 = no ceiling, so no instruction and no warning. */
const effectivePromptCharCap = computed(() =>
  resolvePromptCharCap(normalizePromptCharCapSetting(form.thumbnail.prompt_char_cap), intendedImageModelCap.value),
)
// Auto has to follow SOMETHING, so the intended model is seeded from whatever
// this project already renders images with. Seeding only — never written back.
if (!form.thumbnail.intended_image_model && typeof window !== 'undefined') {
  form.thumbnail.intended_image_model = readRememberedImageModelId(slug.value, window.localStorage)
}
// The catalogue refresh already runs on mount further down; the ceiling reads
// the same snapshot rather than fetching it a second time.

function applyThumbnailVisualStyle(data: { style_bible: string; negative_prompt: string }): void {
  form.thumbnail.style_preset = 'custom'
  form.thumbnail.style_tag = data.style_bible || ''
  success('Visual style applied to Thumbnail Prompts')
}

type SelectedThumbnailRecipe = {
  id: string
  name: string
  recipe?: {
    defaultTextStyle?: string
    defaultFontStyle?: string
    defaultTextPosition?: 'top' | 'center' | 'bottom' | 'bottom-left'
    conceptGuidance?: string
    headlineMode?: 'episode-title' | 'curiosity-hook'
  }
}

async function applyThumbnailRecipe(template: SelectedThumbnailRecipe): Promise<void> {
  form.thumbnail.thumbnail_template_id = template.id
  const recipe = template.recipe
  form.thumbnail.thumb_title_mode = 'ai'
  if (recipe?.headlineMode) form.thumbnail.thumb_headline_mode = recipe.headlineMode
  if (recipe?.defaultTextStyle) form.thumbnail.thumb_text_style = recipe.defaultTextStyle
  if (recipe?.defaultFontStyle) form.thumbnail.thumb_font_style = recipe.defaultFontStyle
  if (recipe?.defaultTextPosition) form.thumbnail.thumb_text_position = recipe.defaultTextPosition
  if (recipe?.conceptGuidance) form.thumbnail.thumb_art_direction = recipe.conceptGuidance
  try {
    await put(`/projects/${slug.value}/settings/config`, { thumbnail_template_id: template.id })
    success(`Applied ${template.name}. Its composition will be used without changing your visual art style.`)
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Recipe selected for this session, but could not save it to the project')
  }
}

// v1.0.259 — remember the prompt settings (model / style / aspect /
// art-direction / cast) across reloads. `force` is a per-run regenerate flag,
// so reset it to false after the restore so a remembered run can't silently
// re-overwrite on the next visit.
//
// Which of the format/template-seedable fields did the remembered form
// actually restore? Probe by blanking them first: a key still blank after the
// restore was not remembered and gets its default back. Format and template
// defaults later seed ONLY those keys, so a remembered choice (or a preset)
// is never overwritten on the next visit.
const SEEDABLE_KEYS = {
  thumbnail: ['thumb_headline_mode', 'style_tag', 'style_preset', 'thumb_count', 'aspect_ratio'],
} as const
const rememberedKeys = probeRememberedKeys(form, SEEDABLE_KEYS, () =>
  useRememberedForm('image-prompts', slug, form, { include: ['thumbnail'] }))
form.thumbnail.force = false
form.thumbnail.thumb_title_mode = 'ai'
// The click brief describes ONE episode (AGENTS §4): never carried in from a
// previous visit, and never saved into a preset (see thumbnailPresets).
form.thumbnail.thumb_creative_direction = ''
const thumbnailHeadlineMode = computed<string>(() => form.thumbnail.thumb_headline_mode)
/** True for every mode where the model chooses the words, which is all of them
 *  except the exact episode title and rendering nothing at all. */
const thumbnailHeadlineInvents = computed<boolean>(() =>
  headlineModes.value.find(mode => mode.id === thumbnailHeadlineMode.value)?.invents
    ?? thumbnailHeadlineMode.value !== 'episode-title',
)

let promptScopeSequence = 0
// v1.0.115+ — clear the in-flight indicator on episode swap. The local
// `generating` ref is normally true only during the POST window (reset
// in the submit handler's `finally`), but defensively clearing it on
// episode change prevents the TopActionBar from briefly showing
// "Generating prompts for [old ep]…" if the user is fast enough to swap
// while the POST is still inflight. Symmetrical with video-assembly.vue
// and audio-merge.vue.
watch([slug, () => form.episode_id], ([, newEp], [, oldEp]) => {
  promptScopeSequence++
  if (newEp !== oldEp) {
    generating.value = false
    existingThumbNumbers.value = []
    // The click brief was written for the previous episode (AGENTS §4).
    if (oldEp && form.thumbnail.thumb_creative_direction.trim()) {
      form.thumbnail.thumb_creative_direction = ''
      showInfo('Cleared "What should make someone click?" — it was written for the previous episode.')
    }
  }
}, { flush: 'sync' })

// The thumbnail sub-form. Kept as a computed because the template binds to it.
const activeForm = computed<ThumbnailForm>(() => form.thumbnail)

const selectedGenStudioImageModel = computed(() =>
  genStudioImageModels.value.find(model => model.id === activeForm.value.model),
)
interface HeadlineModeOption { id: string; label: string; summary: string; invents: boolean }
const headlineModes = ref<HeadlineModeOption[]>([])
const thumbnailReferenceSummary = computed(() =>
  form.thumbnail.thumb_reference_style?.trim() ? 'A reference is applied' : 'Not used')

const titleLocations = [
  { id: 'auto', label: 'Let the model decide' },
  { id: 'top', label: 'Top' },
  { id: 'center', label: 'Centre' },
  { id: 'bottom', label: 'Bottom' },
  { id: 'bottom-left', label: 'Bottom left' },
]
onMounted(async () => {
  try {
    const result = await get<{ modes: HeadlineModeOption[] }>('/thumbnail-headline-modes')
    headlineModes.value = result.modes || []
  } catch { /* the select below still works; only the descriptions are missing */ }
})

// Keep the form on a ratio the selected model actually publishes.
watch(selectedGenStudioImageModel, (model) => {
  if (!model?.aspect_ratios?.length) return
  if (!model.aspect_ratios.includes(activeForm.value.aspect_ratio)) {
    activeForm.value.aspect_ratio = model.default_aspect_ratio || model.aspect_ratios[0]!
  }
})
onMounted(() => {
  void refreshGenStudioImageModels().catch(() => {})
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
  form.thumbnail.thumb_text_style = pickRandomPresetId(TEXT_STYLE_PRESETS)
  form.thumbnail.thumb_font_style = pickRandomPresetId(FONT_STYLE_PRESETS)
  const positions = ['top', 'center', 'bottom']
  form.thumbnail.thumb_text_position = positions[Math.floor(Math.random() * positions.length)]!
  success(`Rolled: ${form.thumbnail.thumb_text_style} + ${form.thumbnail.thumb_font_style} + ${form.thumbnail.thumb_text_position}`)
}

async function surpriseMeThumb() {
  randomizeThumbStyles()
  await nextTick()
  await generateThumbnails()
}

const { selectedEpisode } = useEpisodeStatus(
  computed(() => form.episode_id),
  slug,
)

// v1.0.307 — keep Generate disabled for the WHOLE queued job, not just the
// brief enqueue POST that flips `generating` (see useJobs.isJobActiveFor).
const { isJobActiveFor } = useJobs()
const promptsJobActiveForEpisode = computed(() => isJobActiveFor(form.episode_id, ['image_prompts']))

// Defensive coercion for the thumbnail variation count — a cleared number
// input is NaN.
const safeThumbCount = computed(() => {
  const n = Number(form.thumbnail.thumb_count)
  return Number.isFinite(n) && n > 0 ? n : 0
})

// Clamp numeric form fields so clearing the input (→ NaN via v-model.number)
// doesn't wedge the form in a submit-blocking state. Default to a sensible
// minimum, user can still raise after typing again.
watch(() => form.thumbnail.thumb_count, (v) => {
  if (!Number.isFinite(v) || v < 1) form.thumbnail.thumb_count = 1
})
// ── Presets ─────────────────────────────────────────────────────────────
//
// Thumbnail prompt presets live under `thumbnail_prompts_presets`. The legacy
// `image_prompts_presets` key is not migrated.
const thumbnailPresets = usePresets<any>({
  slug: slug.value,
  configKey: 'thumbnail_prompts',
  // The click brief is episode text. Stripped on save AND on apply; apply is an
  // Object.assign, so the live (current-episode) value survives either way.
  excludeKeys: [...DEFAULT_EXCLUDE_KEYS, 'thumb_creative_direction'],
  snapshot: () => ({ form: { ...form.thumbnail } }),
  apply: (data) => { if (data?.form) Object.assign(form.thumbnail, data.form) },
})
// Bound to TopActionBar.
const promptPresets = computed(() => thumbnailPresets)

/**
 * Format-aware seeding of the form's defaults. Pulls from the project's
 * effective Format; a remembered value or an active preset still wins.
 *
 * Per-format JSON keys consumed:
 *   imagePrompts.defaultThumbnails   → form.thumbnail.thumb_count
 *   imagePrompts.recommendedAspect   → form.thumbnail.aspect_ratio
 *   imagePrompts.defaultStyleTag     → form.thumbnail.style_tag (style_preset = 'custom')
 */
async function applyFormatDefaultsIfNoPreset() {
  // A remembered value or an active preset is the customer's choice. Seed only
  // the keys neither supplied.
  const seedThumb = (key: string) => !thumbnailPresets.activeId.value && !rememberedKeys.thumbnail.has(key)
  if (!['style_tag', 'thumb_count', 'aspect_ratio'].some(seedThumb)) return
  try {
    const f = await get<any>(`/projects/${slug.value}/effective-format`)
    const ip = f?.imagePrompts
    if (!ip) return
    if (typeof ip.defaultThumbnails === 'number' && ip.defaultThumbnails > 0 && seedThumb('thumb_count')) {
      form.thumbnail.thumb_count = ip.defaultThumbnails
    }
    if (typeof ip.recommendedAspect === 'string' && ip.recommendedAspect) {
      if (seedThumb('aspect_ratio')) form.thumbnail.aspect_ratio = ip.recommendedAspect
    }
    if (typeof ip.defaultStyleTag === 'string' && ip.defaultStyleTag.trim() && seedThumb('style_tag')) {
      form.thumbnail.style_preset = 'custom'
      form.thumbnail.style_tag = ip.defaultStyleTag
    }
  } catch {
    // Format endpoint unavailable / project missing — keep the legacy
    // hardcoded values. Non-fatal.
  }
}

onMounted(async () => {
  // Presets load first so the format seeding below knows whether one is active.
  await Promise.all([
    thumbnailPresets.load(),
    loadThumbnailVisionModels(),
  ])
  await applyFormatDefaultsIfNoPreset()
  try {
    const effective = await get<{ template: { id: string; name: string; recipe?: { headlineMode?: 'episode-title' | 'curiosity-hook' } } | null }>(`/projects/${slug.value}/effective-thumbnail-template`)
    if (effective.template) {
      if (!form.thumbnail.thumbnail_template_id) form.thumbnail.thumbnail_template_id = effective.template.id
      // The template only SEEDS "Thumbnail text"; the customer's remembered or
      // preset choice stands on every later visit.
      if (!thumbnailPresets.activeId.value && !rememberedKeys.thumbnail.has('thumb_headline_mode')) {
        form.thumbnail.thumb_headline_mode = effective.template.recipe?.headlineMode === 'curiosity-hook'
          ? 'curiosity-hook'
          : 'episode-title'
      }
    }
  } catch {
    // Catalog availability never blocks prompt authoring.
  }
})

// ── Thumbnail reference vision ──────────────────────────────────────────
async function loadThumbnailVisionModels() {
  thumbnailVisionLoading.value = true
  thumbnailVisionLoadError.value = ''
  try {
    const data = await get<{ models: ThumbnailVisionModel[] }>(`/projects/${slug.value}/thumbnail-reference/vision-models`)
    thumbnailVisionModels.value = Array.isArray(data.models) ? data.models : []
    const selected = selectLiveGenStudioModel(
      thumbnailVisionModel.value,
      thumbnailVisionModels.value.map(model => ({ ...model, available: true })),
      false,
      'llm',
    )
    if (selected && selected.id !== thumbnailVisionModel.value) thumbnailVisionModel.value = selected.id
    if (!thumbnailVisionModels.value.length) {
      thumbnailVisionLoadError.value = 'The Gateway is connected, but it has not published a currently available vision model with image input and structured JSON output.'
    }
  } catch (error: any) {
    thumbnailVisionModels.value = []
    thumbnailVisionLoadError.value = error?.data?.detail || error?.message || 'Could not reach the Gateway vision-model catalog.'
  } finally {
    thumbnailVisionLoading.value = false
  }
}

// v1.0.224 — thumbnail-scoped reference replication: pulls a thumbnail's look
// into form.thumbnail.thumb_reference_style, which the generator injects as the
// reference layer of the thumbnail art direction.
const extractingThumbRef = ref(false)
async function extractThumbReferenceStyle() {
  try {
    const r = await post<{ path: string | null }>('/system/pick-file', {
      title: 'Choose a reference thumbnail',
      buttonLabel: 'Use as Reference',
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    })
    if (!r.path) return
    extractingThumbRef.value = true
    if (!thumbnailVisionModel.value) throw new Error('No Gateway vision model is currently available for thumbnail analysis.')
    const data = await post<{ reference: ThumbnailReferenceAsset }>(
      `/projects/${slug.value}/thumbnail-reference/analyze`,
      { source_path: r.path, model_id: thumbnailVisionModel.value },
    )
    form.thumbnail.thumb_reference_asset = data.reference
    form.thumbnail.thumb_reference_style = data.reference.reframing_prompt
    success(`Composition reference analysed via ${data.reference.analysis_model_name}`)
  } catch (e: any) {
    showError(e?.data?.detail || 'Reference style extraction failed')
  } finally {
    extractingThumbRef.value = false
  }
}

async function clearThumbnailReference() {
  form.thumbnail.thumb_reference_asset = null
  form.thumbnail.thumb_reference_style = ''
  try {
    await put(`/projects/${slug.value}/settings/config`, { thumbnail_reference_asset: null })
  } catch (e: any) {
    showError(e?.data?.detail || 'Reference was cleared from this preset, but could not clear the project default.')
  }
}

// v1.0.87+: image-prompts generation now runs as an enqueued background
// job (Jobs tab visibility, per-step output_lines, retryable on error)
// instead of a synchronous LLM call. Flow:
//   1. POST /generate/image-prompts → returns the queued Job ({ job_id, … }).
//   2. Poll GET /jobs/:jobId until status ∈ {done, error, cancelled}.
//   3. On done: GET /episodes/:id/image-prompts to count the just-written
//      prompts for the toast, and bump the per-prompt review-panel refresh key.
//   4. On error: surface the stored job error.
//
// Why poll instead of subscribing to the Jobs SSE stream: the SSE
// composable is already wired by the dashboard layout for the Jobs panel
// + per-page generating indicators; subscribing again from this page
// would double-count badges. A small poll-by-id loop is simpler and
// has the same UX latency (1.5s tick is fast enough for a 1-3 min job).

const JOB_POLL_INTERVAL_MS = 1500
let promptGenerationSequence = 0

let pageDisposed = false
onBeforeUnmount(() => { pageDisposed = true })
const MAX_POLL_FAILURES = 5

/** Poll until the job ends; `null` = the page closed first. A single failed
 *  read is not a failed job, so a few in a row are tolerated. */
async function waitForJob(slug: string, jobId: string): Promise<any | null> {
  let failures = 0
  while (!pageDisposed) {
    try {
      const job: any = await get(`/projects/${slug}/jobs/${jobId}`)
      failures = 0
      if (job?.status === 'done' || job?.status === 'error' || job?.status === 'cancelled') {
        return job
      }
    } catch (e) {
      if (++failures >= MAX_POLL_FAILURES) throw e
    }
    await new Promise(r => setTimeout(r, JOB_POLL_INTERVAL_MS))
  }
  return null
}

async function runGenerate(replaceAll = false) {
  const ep = form.episode_id
  if (!ep) return
  // Fill-gaps runs write only the numbers still missing; note them up front so
  // the result toast can say what actually happened.
  const missingBefore = Array.from({ length: safeThumbCount.value }, (_, i) => i + 1)
    .filter(n => !existingThumbNumbers.value.includes(n)).length
  const generationSlug = slug.value
  const scope = promptScopeSequence
  const requestSequence = ++promptGenerationSequence
  generating.value = true
  thumbPromptGenerating.value = true
  const payload = {
    episode_id: ep,
    model: activeForm.value.model,
    style_tag: activeForm.value.style_tag,
    aspect_ratio: activeForm.value.aspect_ratio,
    thumb_count: form.thumbnail.thumb_count,
    thumbnail_template_id: form.thumbnail.thumbnail_template_id || undefined,
    thumb_title_mode: 'ai',
    thumb_headline_mode: form.thumbnail.thumb_headline_mode,
    thumb_text_style: form.thumbnail.thumb_text_style,
    thumb_text_position: form.thumbnail.thumb_text_position,
    thumb_font_style: form.thumbnail.thumb_font_style,
    // The free-form description the customer typed for a `custom` choice. The
    // backend resolvers have always accepted it; without sending it the run fell
    // back to the built-in treatment and the text was silently ignored. Sent
    // only when `custom` is the chosen id so the request fingerprint changes
    // exactly when the text actually matters.
    thumb_text_style_custom: form.thumbnail.thumb_text_style === 'custom'
      ? form.thumbnail.thumb_text_style_custom
      : undefined,
    thumb_font_style_custom: form.thumbnail.thumb_font_style === 'custom'
      ? form.thumbnail.thumb_font_style_custom
      : undefined,
    thumb_reference_style: form.thumbnail.thumb_reference_style,
    thumb_creative_direction: form.thumbnail.thumb_creative_direction,
    prompt_char_cap: effectivePromptCharCap.value || undefined,
    title: selectedEpisode.value?.title || '',
    mode: 'thumbnails',
    character_ids: activeForm.value.character_ids,
    fill_gaps: !replaceAll,
    force: replaceAll,
  }
  const operationId = payload.force ? freshImagePromptsAction.begin(payload) : null
  try {
    const job: any = await post(`/projects/${generationSlug}/generate/image-prompts`, {
      ...payload,
      // v1.0.87+: always multiplication. No more Custom-total mode —
      // the backend's executor multiplies scenes_per_chapter × chapter_
      // count to get the final scene count and proceeds straight into
      // chunked generation. total_scenes is no longer sent; the
      // executor still reads it as a fallback for legacy presets but
      // the form no longer surfaces it.
      // The RESOLVED ceiling. Only this page knows which image model these
      // prompts are for; 0 → undefined → no limit is sent.
      // Cast for this generation. Backend resolves these via
      // character-manager and folds the descriptions into the LLM prompt
      // so every scene/thumbnail prompt actually includes them.
      ...(operationId ? { operation_id: operationId } : {}),
    })
    if (operationId) freshImagePromptsAction.complete(operationId)

    // Job is now in the queue + visible in the Jobs panel. Surface that
    // immediately so the user knows the click registered, then poll for
    // completion. We don't block paint while the job runs — the existing
    // `generating` flag keeps the button disabled + spinner showing.
    success('Queued thumbnail prompts — watch progress in Jobs.')

    const completed = await waitForJob(generationSlug, job.job_id)
    if (!completed) return
    if (scope !== promptScopeSequence || slug.value !== generationSlug || form.episode_id !== ep || requestSequence !== promptGenerationSequence) return
    if (completed.status === 'error') {
      throw new Error(completed.error || 'Job failed (see Jobs panel for details)')
    }
    if (completed.status === 'cancelled') {
      showError('Generation cancelled')
      return
    }

    // Job done — executor wrote the docx to disk. Read it back to count the prompts.
    const titleParam = payload.title
      ? `?title=${encodeURIComponent(payload.title)}`
      : ''
    const onDisk: any = await get(
      `/projects/${generationSlug}/episodes/${ep}/image-prompts${titleParam}`,
    )
    if (scope !== promptScopeSequence || slug.value !== generationSlug || form.episode_id !== ep || requestSequence !== promptGenerationSequence) return

    // Bump the review-panel refresh key so the per-prompt panel
    // re-fetches the freshly-written docx.
    reviewRefreshKey.value++

    const thumbCt = onDisk?.thumbnails?.length || 0
    if (payload.force) success(`Replaced all ${thumbCt} thumbnail prompts`)
    else if (missingBefore === 0) showInfo(`All ${thumbCt} prompts already exist — nothing new generated. Use "Replace all" to write them again.`)
    else success(`Generated ${missingBefore} new thumbnail prompt${missingBefore === 1 ? '' : 's'} (${thumbCt} in total)`)
  } catch (e: any) {
    if (scope !== promptScopeSequence || slug.value !== generationSlug || form.episode_id !== ep || requestSequence !== promptGenerationSequence) return
    console.error('[image-prompts] thumbnail prompts generation failed:', e)
    showError(e.data?.detail || e.message || 'Failed to generate thumbnail prompts')
  } finally {
    if (scope === promptScopeSequence && slug.value === generationSlug && form.episode_id === ep && requestSequence === promptGenerationSequence) {
      generating.value = false
      thumbPromptGenerating.value = false
    }
  }
}

async function generate() { await runGenerate() }
// Used by surpriseMeThumb (randomize → generate).
async function generateThumbnails() { await runGenerate() }

/** The one explicit overwrite: asks first, then rewrites every prompt. */
async function replaceAllThumbnailPrompts() {
  const count = existingThumbNumbers.value.length
  if (!await useConfirm().ask({
    title: `Replace all ${count} thumbnail prompts?`,
    message: `Every thumbnail prompt for ${form.episode_id} is written again from scratch, including any you edited by hand. The old prompts are replaced.`,
    confirmLabel: 'Replace All',
    danger: true,
  })) return
  await runGenerate(true)
}

</script>

<style scoped>
.advanced-reference { border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-secondary); }
.advanced-reference > summary { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 44px; padding: 11px 15px; color: var(--text-secondary); cursor: pointer; font-size: var(--font-sm); font-weight: 650; list-style: none; }
.advanced-reference > summary::-webkit-details-marker { display: none; }
.advanced-reference > summary::after { content: '▾'; color: var(--text-muted); transition: transform .16s ease; }
.advanced-reference[open] > summary::after { transform: rotate(180deg); }
.advanced-reference > summary:hover { color: var(--text-primary); }
.advanced-reference > summary:focus-visible { outline: 3px solid var(--accent); outline-offset: -3px; border-radius: var(--radius-lg); }
.advanced-reference__note { color: var(--text-muted); font-size: var(--font-xs); font-weight: 500; }
.advanced-reference .thumbnail-reference-card { border: 0; border-top: 1px solid var(--border); border-radius: 0; }
@media (prefers-reduced-motion: reduce) { .advanced-reference > summary::after { transition: none; } }
.lettering-card { display: grid; gap: 16px; padding: 15px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-secondary); }
.lettering-head { display: flex; align-items: start; justify-content: space-between; gap: 12px; }
.lettering-eyebrow { display: block; color: var(--accent); font-size: var(--font-xs); font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
.lettering-head h4 { margin-top: 2px; font-size: var(--font-lg); letter-spacing: -.02em; }
.lettering-part { display: grid; gap: 7px; }
.lettering-part-head { display: flex; align-items: baseline; gap: 8px; }
.lettering-part-head strong { font-size: var(--font-sm); }
.lettering-part-head span { color: var(--text-muted); font-size: var(--font-xs); }
.lettering-positions { display: flex; flex-wrap: wrap; gap: 6px; }
.position-chip { min-height: var(--control-height-sm); padding: 6px 12px; border: 1px solid var(--border); border-radius: 999px; background: var(--bg-primary); color: var(--text-secondary); cursor: pointer; font: inherit; font-size: var(--font-sm); }
.position-chip:hover { border-color: var(--border-light); color: var(--text-primary); }
.position-chip.selected { border-color: color-mix(in srgb, var(--accent) 60%, var(--border)); background: var(--accent-dim); color: var(--accent); }
.position-chip:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
@media (max-width: 560px) { .position-chip { min-height: 44px; } }
.headline-modes { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 186px), 1fr)); gap: 7px; }
.headline-mode { display: grid; gap: 3px; padding: 9px 11px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg-primary); cursor: pointer; text-align: left; }
.headline-mode:hover { border-color: var(--border-light); }
.headline-mode.selected { border-color: var(--accent); background: var(--accent-dim); }
.headline-mode:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
.headline-mode strong { color: var(--text-primary); font-size: var(--font-sm); }
.headline-mode.selected strong { color: var(--accent); }
.headline-mode span { color: var(--text-muted); font-size: var(--font-xs); line-height: 1.4; }
@media (max-width: 560px) { .headline-mode { min-height: 44px; } }
.thumbnail-hook-policy {
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:14px;
  padding:10px 12px;
  border:1px solid color-mix(in srgb,var(--accent) 35%,var(--border));
  border-radius:10px;
  background:color-mix(in srgb,var(--accent-dim) 60%,var(--bg-secondary));
}
.thumbnail-hook-policy>div { display:grid; gap:2px; }
.thumbnail-hook-policy>div>span { color:var(--accent); font-size:var(--font-xs); font-weight:800; letter-spacing:.12em; }
.thumbnail-hook-policy strong { font-size:13px; }
.thumbnail-hook-policy p { margin:0; color:var(--text-secondary); font-size:var(--font-xs); line-height:1.45; }
.thumbnail-hook-policy>span { max-width:180px; color:var(--text-muted); font-size:var(--font-xs); text-align:right; }
@media (max-width:620px) { .thumbnail-hook-policy { align-items:flex-start; flex-direction:column; }.thumbnail-hook-policy>span { max-width:none; text-align:left; } }
</style>

<style scoped>
/* Helper line that hangs directly under an input. */
.hint-line { margin-top: 4px; }

/* Vision-model menu sits inline without truncating long model names. */
.vision-model-select { width: min(420px, 100%); }

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

/* Thumbnail reference is deliberately a first-class card, immediately after
   recipe + art style. It must remain visible when the live vision catalog is
   unavailable so creators can understand what to fix instead of wondering
   where the workflow went. */
.thumbnail-reference-card {
  padding: 16px;
  border: 1px solid color-mix(in srgb, var(--accent) 36%, var(--border));
  border-radius: var(--radius-md);
  background: linear-gradient(135deg, color-mix(in srgb, var(--accent) 8%, var(--bg-tertiary)), var(--bg-tertiary));
}
.thumbnail-reference-card__heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.thumbnail-reference-card__heading h3 { margin: 2px 0 4px; font-size: 15px; color: var(--text-primary); }
.thumbnail-reference-card__heading p { margin: 0; max-width: 720px; line-height: 1.45; }
.thumbnail-reference-card__eyebrow { color: var(--accent); font-size: var(--font-xs); font-weight: 700; letter-spacing: .12em; }
.thumbnail-reference-card__status {
  flex: 0 0 auto;
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--text-muted);
  font-size: var(--font-xs);
  font-weight: 600;
}
.thumbnail-reference-card__status.active { border-color: var(--success); color: var(--success); }
.thumbnail-reference-card__warning { margin: 10px 0 0; color: var(--warning, #d97706); font-size: var(--font-xs); line-height: 1.45; }
@media (max-width: 640px) {
  .thumbnail-reference-card__heading { flex-direction: column; gap: 8px; }
}
</style>
