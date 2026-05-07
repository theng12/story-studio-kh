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
      <!-- Cast for this episode — same picker as the Scripts page. The
           selected character names + descriptions are folded into the
           LLM prompt so every scene/thumbnail prompt actually includes
           the character description as the requirements demand (instead
           of the LLM inventing or drifting between regenerations). -->
      <div v-if="form.episode_id" class="form-group field-wide">
        <CharacterPicker
          v-model="form.character_ids"
          :project-slug="slug"
          :episode-code="form.episode_id"
        />
      </div>

      <div class="form-group field-medium">
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

      <!-- Style preview row. The pill (always visible when style_tag has
           content) shows EXACTLY what gets sent as style — eliminates the
           "is my custom style actually being used?" anxiety. The Preview
           button generates ONE sample image keyed by hash of the style
           description; same description across episodes / projects re-uses
           the cached PNG and costs nothing. First-time-seen style ≈ $0.005
           on the configured image model. -->
      <div v-if="form.style_tag && form.style_tag.trim()" class="style-preview-row">
        <div class="style-preview-pill" :title="form.style_tag">
          <span class="style-preview-pill-icon" aria-hidden="true">🎨</span>
          <span class="style-preview-pill-label">Style:</span>
          <span class="style-preview-pill-text">{{ form.style_tag.trim() }}</span>
        </div>
        <button
          type="button"
          class="btn btn-sm btn-secondary style-preview-btn"
          :disabled="stylePreview.loading"
          :title="stylePreview.cached === false
            ? 'Generated a fresh sample (~$0.005). Cached now — re-clicking on this exact style is free.'
            : stylePreview.cached === true
              ? 'Cached preview — free. Edit the style above to invalidate.'
              : 'Generate a single sample image of this style. ~$0.005 first time, free thereafter for the exact same description.'"
          @click="generateStylePreview"
        >
          <LoadingSpinner v-if="stylePreview.loading" size="sm" />
          <span v-else aria-hidden="true">🖼️</span>
          {{ stylePreview.loading ? 'Rendering…' : 'Preview style' }}
        </button>
        <span v-if="stylePreview.error" class="style-preview-error" :title="stylePreview.error">
          ⚠ {{ stylePreview.error }}
        </span>
      </div>

      <!-- Sample render thumbnail. Only visible after a successful preview
           call (cache hit OR fresh generation). Click expands to a larger
           inline view via the existing image lightbox. -->
      <div v-if="stylePreview.url" class="style-preview-thumb-wrap">
        <img
          :src="stylePreview.url"
          alt="Style preview sample"
          class="style-preview-thumb"
          :title="`Preview generated ${stylePreview.cached ? '(cache hit, free)' : '(fresh, charged once)'} on ${stylePreview.model_id || 'default model'}`"
        />
        <div class="style-preview-thumb-meta">
          <span :class="['style-preview-pill-tag', stylePreview.cached ? 'is-cache' : 'is-fresh']">
            {{ stylePreview.cached ? '✓ cached' : '✨ fresh' }}
          </span>
          <span class="text-muted text-xs">
            {{ stylePreview.model_id || '' }}
          </span>
        </div>
      </div>

      <div class="form-group" v-if="form.style_preset === 'custom' || showStyleEditor">
        <label>Style Tag</label>
        <textarea v-model="form.style_tag" class="textarea style-tag-textarea"
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

            <select v-if="visionModels.length" v-model="visionModel" class="select select-sm vision-model-select" :disabled="extracting">
              <option v-for="m in visionModels" :key="m.id" :value="m.id" :disabled="!m.has_key">
                {{ formatVisionModelLabel(m) }}
              </option>
            </select>

            <button
              v-if="referenceImagePath"
              type="button"
              class="btn btn-sm btn-primary"
              :disabled="extracting"
              title="Re-run analysis on the same reference (useful after changing the focus hint below or the vision model above)"
              @click="extractStyle"
            >
              <LoadingSpinner v-if="extracting" size="sm" />
              ⟳ Re-analyze
            </button>
          </div>

          <!-- Optional focus hint — biases the vision model's vocabulary
               (e.g. "lighting", "palette", "illustration"). Backend's
               /analyze-style accepts this; UI exposes it so the user can
               re-analyze with a different focus without re-picking the
               reference. -->
          <div class="style-extract-focus-row mt-1">
            <label class="style-extract-focus-label" for="style-focus">Focus hint <span class="text-muted">(optional)</span></label>
            <input
              id="style-focus"
              v-model="extractFocus"
              type="text"
              class="input input-sm style-extract-focus-input"
              :disabled="extracting"
              placeholder="e.g. lighting, illustration, painterly mood"
              @keydown.enter.prevent="referenceImagePath && extractStyle()"
            />
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
              <div v-if="lastAnalyzedAt" class="text-muted text-xs">
                Analyzed {{ lastAnalysisModel }} · {{ lastAnalyzedAtRelative }}
              </div>
              <div v-else class="text-muted text-xs">
                Hit Re-analyze to extract the style description.
              </div>
              <div class="flex gap-2 mt-1 flex-wrap">
                <button
                  type="button"
                  class="btn btn-ghost btn-sm"
                  title="Clean up the reference with AI before re-analysing — useful if it has watermarks or unwanted text."
                  @click="openReferenceEdit"
                >
                  ✨ Edit with AI
                </button>
                <button
                  type="button"
                  class="btn btn-ghost btn-sm"
                  :disabled="!form.style_tag.trim() || savingStylePreset"
                  :title="!form.style_tag.trim() ? 'Generate or write a style description first' : 'Save the current description as a named custom style preset, reusable across episodes'"
                  @click="openSaveStylePreset"
                >
                  💾 Save as preset…
                </button>
                <button
                  type="button"
                  class="btn btn-ghost btn-sm"
                  @click="clearReference"
                >
                  Remove reference
                </button>
              </div>
            </div>
          </div>

          <!-- Inline name-the-preset form. Hidden by default; flips open
               on "Save as preset" click. Keep it inline (vs. a Modal) so
               the user can still see the source description they're naming. -->
          <div v-if="showSavePresetForm" class="style-save-preset-form mt-2">
            <label class="style-save-preset-label">Name this style preset</label>
            <div class="flex gap-2">
              <input
                v-model="newPresetName"
                type="text"
                class="input input-sm flex-1"
                placeholder="e.g. Watercolour Sunset"
                :disabled="savingStylePreset"
                @keydown.enter.prevent="saveStylePreset"
                @keydown.escape="cancelSaveStylePreset"
                ref="savePresetInputEl"
              />
              <button
                type="button"
                class="btn btn-primary btn-sm"
                :disabled="!newPresetName.trim() || savingStylePreset"
                @click="saveStylePreset"
              >
                <LoadingSpinner v-if="savingStylePreset" size="sm" />
                {{ savingStylePreset ? 'Saving…' : 'Save' }}
              </button>
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                :disabled="savingStylePreset"
                @click="cancelSaveStylePreset"
              >
                Cancel
              </button>
            </div>
            <p class="text-muted text-xs mt-1">
              Saved per-project under "Custom" in the Art Style dropdown above. Source model + reference path are recorded so you can trace later.
            </p>
          </div>

          <p class="text-muted text-xs mt-1">
            Tip: pick a thumbnail or scene image that matches the look you want. The vision model describes only the
            style (medium, palette, lighting, texture) — not the subject — and drops it into the textarea above.
            Costs a few cents per extract.
          </p>
        </div>
      </div>

      <!-- ── Scene Prompts section ─────────────────────────────────────── -->
      <div class="split-section mt-2">
        <div class="split-header">
          <h3 class="split-title">🎬 Scene Prompts</h3>
          <span class="text-muted text-xs">~{{ estimatedScenes }} prompts will be generated</span>
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
            <span class="text-muted text-xs scene-count-hint">
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
          <h3 class="split-title">🖼️ Thumbnail Prompts</h3>
          <span class="text-muted text-xs">{{ safeThumbCount }} thumbnail variations</span>
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
            <p v-if="form.thumb_text_style === 'custom'" class="text-muted text-xs hint-line">
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
        <div class="flex gap-2 mt-2 items-center flex-wrap">
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

    <!-- Shared AI image-edit dialog for the reference image. Mounted at -->
    <!-- the page root; openReferenceEdit() flips the v-model. -->
    <ImageEditDialog
      v-model="referenceEditOpen"
      :project-slug="slug"
      :image-path="referenceImagePath || ''"
      @accepted="onReferenceEditAccepted"
    />

  </div>
</template>

<script setup lang="ts">
definePageMeta({ layout: 'dashboard' })
useAppTitle('Image Prompts')
const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { get, post, put } = useApi()
const { success, error: showError } = useToast()

const generating = ref(false)
const showStyleEditor = ref(false)
const generatedPrompts = ref<any>(null)
const activeTab = ref('current')

// User-saved style presets (Gap A from audit pain-point #7).
// Sourced reactively from the project config so a save flows back into
// the dropdown without a manual refresh. Tolerates `style_presets` being
// absent on older configs by treating undefined as an empty array.
interface StylePresetMeta {
  id: string
  name: string
  description: string
  source_model?: string
  source_reference?: string
  created_at: string
}
const { config, refreshConfig } = useProject()
const customStyles = computed<StylePresetMeta[]>(
  () => Array.isArray((config.value as any)?.style_presets)
    ? (config.value as any).style_presets
    : [],
)

// ── Style preview (pill + sample render, cached app-wide by hash) ───────
//
// Reads `form.style_tag` and POSTs to /style-preview to get a single
// sample image of the style. Backend caches the PNG by sha256 of the
// (normalised) description — same description across episodes / projects
// reuses the cached file for free. We don't auto-fire on every keystroke
// (would burn money on iteration); only the explicit Preview button
// triggers generation. The pill itself is text-only, free, always visible.
interface StylePreviewState {
  loading: boolean
  url: string | null
  cached: boolean | null
  model_id: string | null
  hash: string | null
  /** Style description that produced the currently-shown thumbnail. Used
   *  to clear the thumbnail when the user edits style_tag past it. */
  style_tag_at_render: string | null
  error: string | null
}
const stylePreview = ref<StylePreviewState>({
  loading: false,
  url: null,
  cached: null,
  model_id: null,
  hash: null,
  style_tag_at_render: null,
  error: null,
})

async function generateStylePreview(): Promise<void> {
  const styleTag = (form.style_tag || '').trim()
  if (!styleTag || stylePreview.value.loading) return
  stylePreview.value.loading = true
  stylePreview.value.error = null
  try {
    const data = await post<{
      hash: string
      url: string
      cached: boolean
      style_tag: string
      model_id: string
      created_at: string
      size_bytes: number
    }>(`/projects/${slug.value}/style-preview`, {
      style_tag: styleTag,
      // Use the user's selected aspect ratio so the preview matches the
      // shape they'll see in actual scenes. The backend defaults to 1:1
      // when omitted; passing the form value keeps preview parity with
      // the eventual production render.
      aspect_ratio: form.aspect_ratio || '1:1',
    })
    stylePreview.value.url = data.url
    stylePreview.value.cached = !!data.cached
    stylePreview.value.model_id = data.model_id
    stylePreview.value.hash = data.hash
    stylePreview.value.style_tag_at_render = styleTag
  } catch (e: any) {
    stylePreview.value.error = e?.data?.detail || e?.message || 'Preview failed'
  } finally {
    stylePreview.value.loading = false
  }
}

// (The `watch(() => form.style_tag, ...)` that clears the rendered preview
// when the user edits past it lives AFTER the form declaration below — it
// can't run here without TDZ-hitting `form`.)

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
  // Cast injected into the LLM prompt so every scene/thumbnail prompt
  // actually includes character descriptions (the requirement was always
  // there but had no character data behind it). Empty array = today's
  // legacy behaviour. usePresets snapshots the form, so saving an Image
  // Prompts preset captures the cast automatically.
  character_ids: [] as string[],
})

// Style preview thumbnail invalidator. Lives here (not next to the
// stylePreview ref above) because watch(() => form.style_tag, ...)
// captures `form` reactively at setup time and would TDZ-throw if
// declared before `const form = reactive(...)`. Same trap as the
// ChapterListPanel TDZ fix earlier today.
//
// Behaviour: when the user edits style_tag past the description that
// produced the rendered thumbnail, drop the thumbnail so a stale render
// can't sit under fresh text. Loading + error state stay untouched.
watch(() => form.style_tag, (next) => {
  const cur = (next || '').trim()
  if (stylePreview.value.style_tag_at_render &&
      cur !== stylePreview.value.style_tag_at_render) {
    stylePreview.value.url = null
    stylePreview.value.cached = null
    stylePreview.value.hash = null
    stylePreview.value.model_id = null
    stylePreview.value.style_tag_at_render = null
  }
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

// Authoritative chapter count for this episode comes from the chunked-progress
// sidecar (set when outline_only / script-only built). The episode record's
// `suggested_chapters` is only the IDEA-stage hint and goes stale the moment
// the user regenerates an outline at a different count — e.g. the user-
// reported case where EP0001 was generated as 7 from the idea, then expanded
// to 20 chapters; image-prompts kept showing "~7 prompts" because it still
// read the stale idea hint. The watcher below loads sidecar.total_chapters
// per episode pick; the computed prefers it and only falls back to the idea
// hint when no sidecar exists yet (pure idea-stage episode).
const actualChapterCount = ref<number | null>(null)
watch(
  () => [selectedEpisode.value?.episode_code, selectedEpisode.value?.title] as [string?, string?],
  async ([code, title]) => {
    actualChapterCount.value = null
    if (!code || !slug.value) return
    try {
      const titleParam = title ? `?title=${encodeURIComponent(title)}` : ''
      const data = await get<{ total_chapters?: number }>(
        `/projects/${slug.value}/episodes/${code}/outline${titleParam}`,
      )
      if (typeof data?.total_chapters === 'number' && data.total_chapters > 0) {
        actualChapterCount.value = data.total_chapters
      }
    } catch {
      // No sidecar yet (idea-stage episode, never had a script generated)
      // — falls back to suggested_chapters in the computed below.
    }
  },
  { immediate: true },
)

// Both sides coerced + NaN-guarded. Previously either a non-numeric
// `suggested_chapters` from the ideas record OR an older preset that
// restored `scenes_per_chapter` as undefined could land NaN here and
// surface in the UI as "~NaN scenes / ~NaN prompts will be generated".
const estimatedScenes = computed(() => {
  // Real chapter count from the sidecar wins over the idea hint; idea
  // hint is the fallback when no script exists yet.
  const real = Number(actualChapterCount.value)
  const suggested = Number(selectedEpisode.value?.suggested_chapters)
  const chapters = Number.isFinite(real) && real > 0
    ? real
    : (Number.isFinite(suggested) && suggested > 0 ? suggested : 10)
  const perChapter = Number(form.scenes_per_chapter)
  const safePer = Number.isFinite(perChapter) && perChapter > 0 ? perChapter : 0
  const total = chapters * safePer
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

/**
 * v1.0.71+: format-aware seeding of the form's defaults BEFORE the
 * preset loader runs. Out-of-the-box the form had hardcoded sleep-
 * story numbers (5 thumbs, 16:9 aspect, 1 scene per chapter for ~10
 * total). For listicle channels with `imagePrompts.defaultScenesTotalRange:
 * [10, 10]` and `defaultThumbnails: 3`, those defaults were wrong.
 * Pull from the project's effective Format when present; preset.load()
 * still overrides if the user has saved one.
 *
 * Per-format JSON keys consumed:
 *   imagePrompts.defaultScenesTotalRange  → form.total_scenes (low end)
 *                                           form.scenes_per_chapter = 0
 *                                           (signals "use total_scenes")
 *   imagePrompts.defaultThumbnails        → form.thumb_count
 *   imagePrompts.recommendedAspect        → form.aspect_ratio
 *   imagePrompts.defaultStyleTag          → form.style_tag (with style_preset = 'custom'
 *                                           so the format's tuned visual language —
 *                                           "minimalist circular badge" for listicle,
 *                                           "editorial infographic" for educational —
 *                                           lands in the textarea instead of the
 *                                           hardcoded 'storybook' fallback. The user
 *                                           can still pick a STYLE_PRESETS option to
 *                                           override.)
 */
async function applyFormatDefaultsIfNoPreset() {
  try {
    const f = await get<any>(`/projects/${slug.value}/effective-format`)
    const ip = f?.imagePrompts
    if (!ip) return
    if (Array.isArray(ip.defaultScenesTotalRange) && ip.defaultScenesTotalRange.length === 2) {
      const [lo] = ip.defaultScenesTotalRange
      if (typeof lo === 'number' && lo > 0) {
        // 0 in scenes_per_chapter signals "use total_scenes" (see the
        // form template gate at scenes_per_chapter === 0). Listicle
        // formats set defaultScenesTotalRange = [10, 10] — exactly 10
        // scenes — which maps cleanly onto this control.
        form.scenes_per_chapter = 0
        form.total_scenes = lo
      }
    }
    if (typeof ip.defaultThumbnails === 'number' && ip.defaultThumbnails > 0) {
      form.thumb_count = ip.defaultThumbnails
    }
    if (typeof ip.recommendedAspect === 'string' && ip.recommendedAspect) {
      form.aspect_ratio = ip.recommendedAspect
    }
    if (typeof ip.defaultStyleTag === 'string' && ip.defaultStyleTag.trim()) {
      // Switching to 'custom' opens the style editor (see onStyleChange);
      // we set style_tag manually here instead of going through that
      // handler so the page boots up with the editor already showing the
      // format's text.
      form.style_preset = 'custom'
      form.style_tag = ip.defaultStyleTag
    }
  } catch {
    // Format endpoint unavailable / project missing — keep the legacy
    // hardcoded values. Non-fatal.
  }
}

onMounted(async () => {
  // Format-aware seeding runs BEFORE preset load. If the user has an
  // active preset, its values override these — but the format defaults
  // are the right starting point for projects with no saved preset yet.
  await applyFormatDefaultsIfNoPreset()
  void promptPresets.load()
  void loadVisionCaps()
})

// ── Vision / style-extraction ──────────────────────────────────────────
const VISION_CAPABLE = new Set<string>([
  'claude-sonnet-4-6', 'claude-opus-4-7', 'claude-3-5-sonnet-latest',
  'claude-3-5-sonnet-20241022', 'claude-3-opus-20240229',
  'gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-5',
])

// Bumped after each accepted AI edit so the <img> re-fetches the file
// instead of showing the stale cached pre-edit pixels.
const referenceEditKey = ref(0)
const referencePreviewUrl = computed(() => {
  if (!referenceImagePath.value) return ''
  return `/api/projects/${slug.value}/video-editor/preview-image?path=${encodeURIComponent(referenceImagePath.value)}&k=${referenceEditKey.value}`
})

// "✨ Edit with AI" button on the reference-image preview row. Reuses the
// shared ImageEditDialog (mounted at template root). On accept, the dialog
// returns the new path; we keep the same path bound here when the user
// chooses Replace, or swap to the new versioned file otherwise.
const referenceEditOpen = ref(false)
function openReferenceEdit() {
  if (!referenceImagePath.value) return
  referenceEditOpen.value = true
}
function onReferenceEditAccepted(newPath: string) {
  referenceImagePath.value = newPath
  referenceEditKey.value++  // bust the preview cache
  // Clear any stale "Analyzed N min ago" — the image's content changed,
  // so the previous style extraction no longer describes it.
  lastAnalyzedAt.value = ''
  lastAnalysisModel.value = ''
}

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

// Optional focus hint sent alongside the image+prompt on /analyze-style.
// Backend uses it to bias the vision model's vocabulary (e.g. "lighting"
// vs "palette" vs "illustration").
const extractFocus = ref('')

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
        // Empty string = no focus; backend tolerates either undefined or
        // empty. Trim defensively in case the user accidentally pasted
        // whitespace.
        focus: extractFocus.value.trim() || undefined,
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

// ── Save-as-preset flow ─────────────────────────────────────────────────
// Captures whatever's in form.style_tag right now (could be a vision-
// extracted description, a hand-written one, or a fork of an existing
// custom preset) and persists it under a name in config.style_presets.
const showSavePresetForm = ref(false)
const newPresetName = ref('')
const savingStylePreset = ref(false)
const savePresetInputEl = ref<HTMLInputElement | null>(null)

function openSaveStylePreset() {
  if (!form.style_tag.trim()) return
  showSavePresetForm.value = true
  newPresetName.value = ''
  // Focus the input on next tick so keyboard users can type immediately
  // without an extra Tab press.
  nextTick(() => savePresetInputEl.value?.focus())
}

function cancelSaveStylePreset() {
  showSavePresetForm.value = false
  newPresetName.value = ''
}

/**
 * Generate a stable, file-system-safe id from a name. Collision with an
 * existing id is resolved by suffixing `-2`, `-3`, … so a user saving
 * "Watercolour" twice ends up with `watercolour` and `watercolour-2`
 * rather than overwriting the first silently.
 */
function makeStylePresetId(name: string, existing: StylePresetMeta[]): string {
  const base = name.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'style'
  if (!existing.some(c => c.id === base)) return base
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`
    if (!existing.some(c => c.id === candidate)) return candidate
  }
  return `${base}-${Date.now()}`
}

async function saveStylePreset() {
  const name = newPresetName.value.trim()
  if (!name || !form.style_tag.trim() || savingStylePreset.value) return
  savingStylePreset.value = true
  try {
    const existing = customStyles.value
    const newPreset: StylePresetMeta = {
      id: makeStylePresetId(name, existing),
      name,
      description: form.style_tag.trim(),
      source_model: lastAnalysisModel.value || undefined,
      source_reference: referenceImagePath.value || undefined,
      created_at: new Date().toISOString(),
    }
    // Persist via the existing settings/config PUT — same path voice_presets
    // uses. The route's UpdateConfig schema passes `style_presets` through
    // (we registered it in contracts/index.ts), so this single round-trip
    // both saves the preset and refreshes the dropdown via the reactive
    // config ref.
    await put(`/projects/${slug.value}/settings/config`, {
      style_presets: [...existing, newPreset],
    })
    await refreshConfig(slug.value)
    // Switch the dropdown to the new entry so the user immediately sees
    // their save reflected. Selecting it also re-fills the textarea (a no-op
    // here since it already matches), keeping behaviour predictable.
    form.style_preset = newPreset.id
    showSavePresetForm.value = false
    newPresetName.value = ''
    success(`Saved "${newPreset.name}" — pick it from the Art Style dropdown next time.`)
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to save style preset')
  } finally {
    savingStylePreset.value = false
  }
}

// ── Reference path persistence (Gap C from audit pain-point #7) ──────────
// Per-project localStorage key so iCloud-synced project switches stay
// remembered across reloads. Cleared explicitly via clearReference.
const REF_PATH_LS_KEY = computed(() => `story-studio:${slug.value}:image-prompts:reference-path`)

function loadPersistedReferencePath() {
  if (typeof window === 'undefined') return  // SSR safety, even though Nuxt runs in SPA mode here
  try {
    const raw = window.localStorage.getItem(REF_PATH_LS_KEY.value)
    if (raw && typeof raw === 'string' && raw.trim()) {
      referenceImagePath.value = raw
    }
  } catch { /* localStorage may be unavailable in private mode — ignore */ }
}

watch(referenceImagePath, (v) => {
  if (typeof window === 'undefined') return
  try {
    if (v) window.localStorage.setItem(REF_PATH_LS_KEY.value, v)
    else   window.localStorage.removeItem(REF_PATH_LS_KEY.value)
  } catch { /* ignore quota / private-mode errors */ }
})

onMounted(() => loadPersistedReferencePath())

function onStyleChange() {
  if (form.style_preset in STYLE_PRESETS) {
    form.style_tag = STYLE_PRESETS[form.style_preset]
    showStyleEditor.value = false
    return
  }
  if (form.style_preset === 'custom') {
    form.style_tag = ''
    showStyleEditor.value = true
    return
  }
  // User-saved custom preset — id matches an entry in config.style_presets.
  // Treat selection as "load this description and put me in editable mode"
  // so the user can fork the preset (tweak + save under a new name) without
  // mutating the original.
  const saved = customStyles.value.find(cs => cs.id === form.style_preset)
  if (saved) {
    form.style_tag = saved.description
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
      // Cast for this generation. Backend resolves these via
      // character-manager and folds the descriptions into the LLM prompt
      // so every scene/thumbnail prompt actually includes them.
      character_ids: form.character_ids,
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
    // Name the pool that failed so the toast is actionable. Multi-pool
    // 'all' runs aggregate errors at the backend, so the detail message
    // (when present) carries the per-pool breakdown.
    const poolLabel = mode === 'scenes' ? 'scene prompts'
      : mode === 'thumbnails' ? 'thumbnail prompts'
      : 'image prompts (scenes + thumbnails)'
    console.error(`[image-prompts] ${poolLabel} generation failed:`, e)
    showError(e.data?.detail || `Failed to generate ${poolLabel}`)
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
/* Form-field width tokens (mirror scripts.vue). */
.field-medium { max-width: 520px; }
.field-wide   { max-width: 720px; }

/* Helper line that hangs directly under an input. */
.hint-line { margin-top: 4px; }

/* Style-tag textarea — short, no monospace. */
.style-tag-textarea { min-height: 60px; font-size: 13px; }

/* Vision-model dropdown sits inline with the file picker. */
.vision-model-select { max-width: 220px; }

/* Optional focus-hint row beneath the extract / re-analyze buttons.
 * Compact label-input pair so it doesn't dominate the section. */
.style-extract-focus-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.style-extract-focus-label {
  font-size: 11px;
  color: var(--text-secondary);
  font-weight: 500;
}
.style-extract-focus-input { flex: 1; min-width: 200px; }

/* Inline name-the-preset form. Lives under the reference preview block,
 * sized to read as a small subordinate flow (not a competing card). */
.style-save-preset-form {
  padding: 10px 12px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.style-save-preset-label {
  display: block;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 6px;
}

/* Sub-section title for Scenes / Thumbnails split — smaller than h3. */
.split-title { font-size: 14px; margin: 0; }

/* Inline hint that appears under the "Scenes per Chapter" select. */
.scene-count-hint { display: block; margin-top: 4px; }

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

/* Style preview row — pill (text only, always free) + Preview button. */
.style-preview-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 8px 0;
}
.style-preview-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  background: rgba(99, 102, 241, 0.10);
  border: 1px solid rgba(99, 102, 241, 0.28);
  font-size: 11px;
  color: var(--text-secondary);
  max-width: min(640px, 100%);
  cursor: help;
}
.style-preview-pill-icon { font-size: 12px; }
.style-preview-pill-label { font-weight: 600; color: var(--text-primary); }
.style-preview-pill-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1 1 auto;
  min-width: 0;
}
.style-preview-btn { white-space: nowrap; }
.style-preview-error {
  font-size: 11px;
  color: rgb(220, 38, 38);
  cursor: help;
}
.style-preview-thumb-wrap {
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: flex-start;
  margin: 4px 0 12px;
}
.style-preview-thumb {
  width: 160px;
  height: 160px;
  object-fit: cover;
  border-radius: var(--radius-md);
  border: 1px solid var(--border);
  background: var(--bg-tertiary);
}
.style-preview-thumb-meta {
  display: flex;
  align-items: center;
  gap: 6px;
}
.style-preview-pill-tag {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  font-family: var(--font-mono, monospace);
}
.style-preview-pill-tag.is-cache {
  background: rgba(16, 185, 129, 0.10);
  color: rgb(16, 185, 129);
  border: 1px solid rgba(16, 185, 129, 0.28);
}
.style-preview-pill-tag.is-fresh {
  background: rgba(245, 158, 11, 0.10);
  color: rgb(180, 120, 8);
  border: 1px solid rgba(245, 158, 11, 0.28);
}

.style-extract { padding: 10px 12px; background: var(--bg-tertiary); border-radius: var(--radius-sm); border: 1px dashed var(--border); }
.style-extract-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.style-extract-preview { display: flex; gap: 12px; align-items: flex-start; }
.style-extract-thumb { width: 80px; height: 80px; object-fit: cover; border-radius: var(--radius-sm); border: 1px solid var(--border); flex-shrink: 0; }
.style-extract-meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.style-extract-filename { font-size: 12px; font-weight: 600; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.style-extract-clear { align-self: flex-start; margin-top: 4px; padding: 2px 8px; font-size: 11px; color: var(--text-muted); }
.style-extract-clear:hover { color: var(--error); }
</style>
