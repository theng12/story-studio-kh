<!--
  v1.0.189 (CC2) — Character Sheet page (continuity-chain).

  The anchor step: pick which project Character(s) lock this episode's look,
  optionally drop in a one-off episode sheet (saved as the img2img master
  reference), and set the continuity config (pacing guardrails, per-scene
  reference toggles, denoise strength). The config persists to
  <episode_dir>/continuity.json and is consumed by the paced Scene Plan (CC3)
  and the sequential renderer (CC4).

  Only reachable for continuity-chain projects (sidebar gates on
  isContinuityChain).
-->
<template>
  <div>
    <div class="page-header">
      <Breadcrumb />
      <h1 class="page-title">🎭 Character Sheet</h1>
    </div>

    <TopActionBar
      :project-slug="slug"
      v-model:episode-id="episodeId"
      filter-field="character_sheet"
      :presets="pagePresets"
      generate-label="Save anchors & settings"
      loading-label="Saving…"
      :generate-loading="saving"
      :generate-disabled="!episodeId"
      :generate-status="saving ? 'Saving continuity config…' : (episodeId ? '' : 'Pick an episode first')"
      @generate="saveConfig"
    />

    <p class="text-muted mt-1 mb-2">
      Lock this episode's look. Pick the Character(s) that anchor every scene
      (their reference images carry the face/wardrobe), or drop in a one-off
      sheet just for this episode. The settings below feed the paced Scene
      Plan and the sequential render.
    </p>

    <div v-if="!episodeId" class="card mt-3">
      <p class="text-muted text-sm">Pick an episode above to set its character anchor + continuity settings.</p>
    </div>

    <template v-else>
      <!-- 1. Anchor characters -->
      <section class="card mt-3">
        <div class="card-header">
          <h3>1. Anchor characters</h3>
          <NuxtLink :to="`/projects/${slug}/characters`" class="btn btn-ghost btn-sm">Manage characters →</NuxtLink>
        </div>
        <p class="text-muted text-sm mt-1">
          Tick who appears in this episode. Their reference images anchor
          every scene. A character with no reference image can still guide the
          text prompt, but won't lock the visual — add a portrait on the
          Characters page (or upload a sheet below).
        </p>

        <div v-if="charsLoading" class="text-muted text-sm mt-2">Loading characters…</div>
        <div v-else-if="!characters.length" class="text-muted text-sm mt-2">
          No characters for this episode yet.
          <NuxtLink :to="`/projects/${slug}/characters`" class="cs-link">Create one →</NuxtLink>
          (make it project-wide, or episode-scoped to this episode).
        </div>
        <div v-else class="cs-char-list mt-2">
          <CharacterCard
            v-for="c in characters"
            :key="c.id"
            :character="c"
            :thumbnail-url="firstImage(c) ? charImageUrl(c, firstImage(c)!) : undefined"
            selectable
            :selected="config.anchor_character_ids.includes(c.id)"
            @toggle="toggleAnchor(c.id)"
          />
        </div>
        <p v-if="anchorsWithoutImages.length" class="cs-warn text-xs mt-2">
          ⚠ {{ anchorsWithoutImages.join(', ') }} {{ anchorsWithoutImages.length === 1 ? 'has' : 'have' }}
          no reference image — won't visually anchor scenes until you add one.
        </p>
      </section>

      <!-- 2. Episode sheet (one-off master reference) -->
      <section class="card mt-3">
        <h3>
          2. Episode sheet
          <span v-if="masterExists" class="cs-saved-badge">✓ Saved</span>
          <span class="text-muted" style="font-weight:400">(optional)</span>
        </h3>
        <p class="text-muted text-sm mt-1">
          A single reference image used as an anchor for <em>every</em> scene in
          just this episode — handy when you don't want a reusable Character.
          Saved as this episode's master img2img reference.
        </p>

        <div class="cs-sheet-row mt-2">
          <div v-if="masterExists" class="cs-sheet-preview">
            <img :src="masterUrl" alt="Episode sheet" />
          </div>
          <div class="cs-sheet-main">
            <ReferenceDropzone :busy="uploadingSheet" @files="onSheetFiles">
              <template #title>{{ masterExists ? 'Replace the episode sheet' : 'Drop the episode sheet here' }}</template>
              <template #hint>— or paste, or click to browse (one image)</template>
            </ReferenceDropzone>
            <div class="cs-sheet-actions">
              <label class="cs-checkbox">
                <input type="checkbox" v-model="config.use_episode_sheet" :disabled="!masterExists" />
                Use this sheet to anchor every scene
              </label>
              <button v-if="masterExists" class="btn btn-ghost btn-sm" :disabled="uploadingSheet" @click="removeSheet">
                Remove sheet
              </button>
            </div>
          </div>
        </div>
      </section>

      <!-- 3. Style reference (look/palette, applied to every scene) -->
      <section class="card mt-3">
        <h3>
          3. Style reference
          <span v-if="styleExists" class="cs-saved-badge">✓ Saved</span>
          <span class="text-muted" style="font-weight:400">(optional)</span>
        </h3>
        <p class="text-muted text-sm mt-1">
          An image whose <em>look</em> — palette, lighting, rendering style — every
          scene should match. Attached to every render alongside the character
          references (great with reference-capable models like GPT Image 2).
          Saved as this episode's <code>style.png</code>.
        </p>

        <div class="cs-sheet-row mt-2">
          <div v-if="styleExists" class="cs-sheet-preview">
            <img :src="styleUrl" alt="Style reference" />
          </div>
          <div class="cs-sheet-main">
            <ReferenceDropzone :busy="uploadingStyle" @files="onStyleFiles">
              <template #title>{{ styleExists ? 'Replace the style reference' : 'Drop a style reference here' }}</template>
              <template #hint>— or paste, or click to browse (one image)</template>
            </ReferenceDropzone>
            <div class="cs-sheet-actions">
              <label class="cs-checkbox">
                <input type="checkbox" v-model="config.references.style" :disabled="!styleExists" />
                Apply this style to every scene
              </label>
              <button v-if="styleExists" class="btn btn-ghost btn-sm" :disabled="uploadingStyle" @click="removeStyle">
                Remove style
              </button>
            </div>
          </div>
        </div>
      </section>

      <!-- 4. Continuity settings -->
      <section class="card mt-3">
        <h3>4. Continuity settings</h3>
        <p class="text-muted text-sm mt-1">
          These drive the next steps: the Scene Plan paces cuts within your
          range, and the sequential render uses the references + strength you
          pick here. (The render itself lands in a later update.)
        </p>

        <div class="cs-settings mt-2">
          <div class="form-group">
            <label>Scene length range (seconds)</label>
            <div class="cs-range-row">
              <input v-model.number="config.pacing.min_sec" type="number" min="1" max="60" class="input input-sm input-inline" />
              <span class="text-muted">to</span>
              <input v-model.number="config.pacing.max_sec" type="number" min="1" max="60" class="input input-sm input-inline" />
            </div>
            <span class="text-muted text-xs">
              The planner cuts more often where the narration is busy, keeping
              each scene inside this band — shorter = more "live".
            </span>
          </div>

          <!-- v1.0.337 — guide appearance density. Project-level (channel
               default), saved instantly + separately from the per-episode
               continuity settings below. -->
          <div class="form-group">
            <label>
              Guide character appearance
              <span class="text-muted text-xs">— channel default, applies to every episode</span>
            </label>
            <div class="cs-density-row">
              <input
                v-model.number="guideDensity"
                type="range" min="0" max="100" step="5"
                class="cs-density-slider"
                :disabled="savingGuideDensity"
                @change="saveGuideDensity"
              />
              <span class="cs-density-readout" :class="{ off: guideDensity === 0 }">{{ guideDensityLabel }}</span>
            </div>
            <span class="text-muted text-xs">
              How often the recurring guide is in the shot — the Scene Planner makes the rest
              event / environment / map / artifact scenes (no guide), so he stays special.
              <strong>0%</strong> = no guide character at all; <strong>100%</strong> = guide in every scene.
              Saves immediately for the whole channel.
            </span>
          </div>

          <div class="form-group">
            <label>Each scene references</label>
            <label class="cs-checkbox">
              <input type="checkbox" v-model="config.references.prev_render" />
              The previous scene's render <span class="text-muted text-xs">— scene-to-scene flow</span>
            </label>
            <label class="cs-checkbox">
              <input type="checkbox" v-model="config.references.sheet" />
              The episode sheet <span class="text-muted text-xs">— locks identity every scene</span>
            </label>
            <label class="cs-checkbox">
              <input type="checkbox" v-model="config.references.characters" />
              The anchor characters' images <span class="text-muted text-xs">— recurring cast</span>
            </label>
            <label class="cs-checkbox">
              <input type="checkbox" v-model="config.references.style" :disabled="!styleExists" />
              The style reference <span class="text-muted text-xs">— matches look/palette (upload above)</span>
            </label>
          </div>

          <div class="form-group">
            <label>Variation per scene (denoise strength): <strong>{{ config.denoise_strength.toFixed(2) }}</strong></label>
            <input v-model.number="config.denoise_strength" type="range" min="0" max="1" step="0.05" class="cs-range" />
            <span class="text-muted text-xs">
              Lower = scenes hug the references (very consistent, can look
              near-identical). Higher = more change between scenes (livelier,
              risks drift). ~0.4–0.6 is a good start.
            </span>
          </div>

          <!-- v1.0.356 — the savable preset moved to the page-level preset row
               at the top (TopActionBar). The built-in style gallery below is a
               quick "starter look" picker; whatever you apply here is captured
               when you save a whole-page Continuity preset. -->
          <!-- v1.0.364 — shared StylePicker (same gallery used on the Scene Plan
               page) so "style" is one concept. Applying a card sets the Style
               Bible + negative prompt below. -->
          <StylePicker
            class="mt-3"
            :slug="slug"
            :image-models="projectConfig?.image_models || {}"
            @apply="onStyleApply"
          />

          <!-- v1.0.243 — render-time Style Bible. Appended to every scene's
               prompt when rendering, so editing it + re-rendering needs no
               re-plan. Complements the style.png image reference above. -->
          <div class="form-group">
            <label>Style Bible <span class="text-muted text-xs">— text style added to every scene at render</span></label>
            <textarea
              v-model="config.style_bible"
              class="textarea"
              rows="3"
              placeholder="e.g. cinematic photoreal, soft golden-hour key light, shallow depth of field, muted earthy palette, fine 35mm film grain, painterly atmosphere"
            />
            <span class="text-muted text-xs">
              This rides alongside the <code>style.png</code> reference and reinforces the look in text —
              especially helpful for models that weight the prompt heavily. Change it and just re-render; no re-plan needed.
            </span>
          </div>

          <!-- v1.0.243 — negative prompt. Forwarded where the provider supports
               it (local Image Studio); cloud providers currently ignore it. -->
          <div class="form-group">
            <label>Negative prompt <span class="text-muted text-xs">— things to avoid</span></label>
            <textarea
              v-model="config.negative_prompt"
              class="textarea"
              rows="2"
              placeholder="e.g. text, watermark, extra fingers, deformed hands, lowres, blurry, oversaturated"
            />
            <span class="text-muted text-xs">
              Applied by the local Image Studio model. Cloud models (kie.ai, OpenAI, OpenRouter) don't accept a
              negative prompt yet and will ignore it.
            </span>
          </div>
        </div>
      </section>

      <!-- 5. Visual Recipe (explainer composition) -->
      <section class="card mt-3">
        <h3>
          5. Visual Recipe
          <span class="text-muted" style="font-weight:400">— explainer composition (optional)</span>
        </h3>
        <p class="text-muted text-sm mt-1">
          Rewrites every scene's image prompt before rendering. Two styles:
          <strong>Explainer with a guide</strong> (subject framed, your character points at it) or
          <strong>Scene-accurate, no character</strong> (each scene shows its real subject; generic
          figures only when a person is involved). Define it here, then <strong>Apply</strong> it on the
          <NuxtLink :to="`/projects/${slug}/scene-plan?episode_id=${episodeId}`" class="cs-link">Scene Plan</NuxtLink> page.
        </p>

        <div class="cs-settings mt-2">
          <label class="cs-checkbox">
            <input type="checkbox" v-model="config.recipe.enabled" />
            Use a Visual Recipe to rewrite every scene's prompt for this episode
          </label>

          <div class="form-group">
            <label>Composition style</label>
            <label class="cs-checkbox">
              <input type="radio" value="guide" v-model="config.recipe.mode" />
              <strong>Explainer with a guide</strong> <span class="text-muted text-xs">— subject framed; a recurring character stands at the side pointing at it, emotion per scene</span>
            </label>
            <label class="cs-checkbox">
              <input type="radio" value="scene" v-model="config.recipe.mode" />
              <strong>Scene-accurate, no character</strong> <span class="text-muted text-xs">— each scene shows its real subject; generic figures only when a person is involved; no recurring character</span>
            </label>
          </div>

          <div class="form-group">
            <label>Composition directive <span class="text-muted text-xs">— natural language; framing, border + art style</span></label>
            <textarea
              v-model="config.recipe.directive"
              class="textarea"
              rows="3"
              :placeholder="config.recipe.mode === 'scene'
                ? 'e.g. frame every image with a clean white border; storybook stick-figure art, soft watercolour, warm earthy palette; show the actual objects/animals/place the narration describes'
                : 'e.g. the subject sits inside an ornate vine-and-cave frame with clean white edges; the guide stands at the right edge, pointing at the framed scene; flat storybook illustration'"
            />
          </div>

          <div v-if="config.recipe.mode === 'guide'" class="form-group">
            <label>Guide character <span class="text-muted text-xs">— who points at the subject</span></label>
            <select v-model="config.recipe.guide_character_id" class="input input-sm">
              <option value="">First anchor character</option>
              <option v-for="c in characters" :key="c.id" :value="c.id">{{ c.name }}</option>
            </select>
          </div>

          <div v-if="config.recipe.mode === 'guide'" class="form-group">
            <label>Guide emotion</label>
            <label class="cs-checkbox">
              <input type="radio" value="auto" v-model="config.recipe.emotion_mode" />
              Auto — match each scene's narration <span class="text-muted text-xs">(overridable per scene)</span>
            </label>
            <label class="cs-checkbox">
              <input type="radio" value="fixed" v-model="config.recipe.emotion_mode" />
              One fixed emotion
            </label>
            <input
              v-if="config.recipe.emotion_mode === 'fixed'"
              v-model="config.recipe.fixed_emotion"
              class="input input-sm mt-1"
              placeholder="e.g. warm curiosity"
            />
          </div>

          <!-- Composition template image -->
          <div class="form-group">
            <label>
              Composition template
              <span v-if="compositionExists" class="cs-saved-badge">✓ Saved</span>
            </label>
            <p class="text-muted text-xs">
              One layout image the renders are structured against (img2img) so the framing stays
              consistent — e.g. an empty framed window / clean white border (plus, for the guide style,
              the guide standing at the side). Upload your own, or generate one. Saved as
              <code>composition.png</code>.
            </p>
            <div class="cs-sheet-row mt-2">
              <div v-if="compositionExists" class="cs-sheet-preview">
                <img :src="compositionUrl" alt="Composition template" />
              </div>
              <div class="cs-sheet-main">
                <ReferenceDropzone :busy="uploadingComposition" @files="onCompositionFiles">
                  <template #title>{{ compositionExists ? 'Replace the template' : 'Drop a composition template here' }}</template>
                  <template #hint>— or paste, or click to browse (one image)</template>
                </ReferenceDropzone>

                <div class="cs-gen-box mt-2">
                  <label class="text-xs text-muted">Or generate one from a prompt</label>
                  <ImageModelPicker
                    v-model="compositionModel"
                    :project-slug="slug"
                    :image-models="projectConfig?.image_models || {}"
                  />
                  <textarea
                    v-model="compositionPrompt"
                    class="textarea mt-1"
                    rows="2"
                    placeholder="Describe the template: e.g. a friendly guide character standing at the right gesturing toward a large empty ornate frame on the left, clean white background, flat storybook style"
                  />
                  <button
                    class="btn btn-secondary btn-sm mt-1"
                    :disabled="generatingComposition || !compositionModel || !compositionPrompt.trim()"
                    @click="generateComposition"
                  >
                    {{ generatingComposition ? 'Generating…' : 'Generate template' }}
                  </button>
                </div>

                <div class="cs-sheet-actions">
                  <label class="cs-checkbox">
                    <input type="checkbox" v-model="config.references.composition" :disabled="!compositionExists" />
                    Use this layout on every scene
                  </label>
                  <button v-if="compositionExists" class="btn btn-ghost btn-sm" :disabled="uploadingComposition" @click="removeComposition">
                    Remove template
                  </button>
                </div>
              </div>
            </div>
          </div>

          <!-- v1.0.356 — the Visual Recipe is now saved as part of the single
               whole-page Continuity preset (top of page), not its own picker. -->
        </div>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import type { Character } from '../../../composables/useCharacters.js'

definePageMeta({ layout: 'dashboard' })
useAppTitle('Character Sheet')

const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { get, put, post, del } = useApi()
const { success, error: showError } = useToast()
const cm = useCharacters(slug)

const episodeId = ref('')

interface VisualRecipe {
  enabled: boolean
  mode: 'guide' | 'scene'
  directive: string
  guide_character_id: string
  emotion_mode: 'auto' | 'fixed'
  fixed_emotion: string
}
interface ContinuityConfig {
  schema_version: 1
  anchor_character_ids: string[]
  use_episode_sheet: boolean
  pacing: { min_sec: number; max_sec: number }
  references: { prev_render: boolean; sheet: boolean; characters: boolean; style: boolean; composition: boolean }
  denoise_strength: number
  style_bible?: string
  negative_prompt?: string
  recipe: VisualRecipe
  updated_at?: string
}
function defaultRecipe(): VisualRecipe {
  return { enabled: false, mode: 'guide', directive: '', guide_character_id: '', emotion_mode: 'auto', fixed_emotion: '' }
}
function defaults(): ContinuityConfig {
  return {
    schema_version: 1,
    anchor_character_ids: [],
    use_episode_sheet: false,
    pacing: { min_sec: 2, max_sec: 8 },
    references: { prev_render: true, sheet: true, characters: true, style: false, composition: false },
    denoise_strength: 0.5,
    style_bible: '',
    negative_prompt: '',
    recipe: defaultRecipe(),
  }
}

const config = ref<ContinuityConfig>(defaults())

// v1.0.356 — ONE whole-page preset for the entire continuity setup. Replaces
// the two fragmented pickers (Style Bible preset + Visual Recipe preset) the
// user had to manage separately. A channel's continuity look (anchors,
// references, pacing, denoise, Style Bible, negative prompt, Visual Recipe) is
// usually the same across episodes, so saving it ONCE and Applying it fills
// the whole page in one click instead of re-picking every attribute. Lives in
// the TopActionBar's preset row (same spot as Scripts/Prompts).
//
// autoApplyOnLoad is OFF: the episode's own continuity.json drives the fields
// on load; the preset is applied only on explicit Apply (then Save anchors &
// settings to persist it into this episode).
//
// Snapshot/apply cover the FULL config minus the transient `updated_at`.
type ContinuityPagePreset = Omit<ContinuityConfig, 'updated_at'>
const pagePresets = usePresets<ContinuityPagePreset>({
  slug: slug.value,
  configKey: 'continuity_page',
  presetType: 'continuity-page',
  autoApplyOnLoad: false,
  snapshot: () => {
    // Deep clone so the stored preset doesn't alias the live config refs.
    const { updated_at: _drop, ...rest } = config.value
    return JSON.parse(JSON.stringify(rest)) as ContinuityPagePreset
  },
  apply: (data) => {
    // Merge over defaults so a preset saved before a field existed still
    // yields a complete, valid config (nested objects get their own merge).
    const d = defaults()
    config.value = {
      ...d,
      ...data,
      schema_version: 1,
      anchor_character_ids: Array.isArray(data.anchor_character_ids) ? [...data.anchor_character_ids] : [],
      pacing: { ...d.pacing, ...(data.pacing || {}) },
      references: { ...d.references, ...(data.references || {}) },
      recipe: { ...defaultRecipe(), ...(data.recipe || {}) },
    }
  },
})

// v1.0.260 — project config (image_models) for the template generator's picker.
const { config: projectConfig } = useProject()

// v1.0.337 — guide cast density (project-level config.json). The channel
// default for how often the recurring guide appears; the Scene Planner +
// continuity renderer key off it. Saved instantly + separately from the
// per-episode continuity.json (so the "Save continuity settings" button is
// unaffected).
const guideDensity = ref(40)
const savingGuideDensity = ref(false)
watch(projectConfig, (c) => {
  const v = (c as any)?.character_density
  if (typeof v === 'number') guideDensity.value = Math.max(0, Math.min(100, Math.round(v)))
}, { immediate: true })
const guideDensityLabel = computed(() =>
  guideDensity.value === 0 ? 'Off — no guide character'
    : guideDensity.value >= 100 ? 'Guide in every scene'
      : `Guide in ~${guideDensity.value}% of scenes`)
async function saveGuideDensity(): Promise<void> {
  savingGuideDensity.value = true
  try {
    await put(`/projects/${slug.value}/settings/config`, { character_density: guideDensity.value })
    success(`Guide appearance saved — ${guideDensityLabel.value.toLowerCase()}`)
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to save guide appearance')
  } finally {
    savingGuideDensity.value = false
  }
}
// v1.0.364 — the shared StylePicker component owns the gallery + preview
// rendering now. Applying a style just writes the look onto the continuity
// config; save a whole-page Continuity preset (top bar) to keep it.
function onStyleApply(data: { style_bible: string; negative_prompt: string }): void {
  config.value.style_bible = data.style_bible || ''
  config.value.negative_prompt = data.negative_prompt || ''
  success('Style applied — Save anchors & settings to keep it for this episode')
}

const characters = ref<Character[]>([])
const charsLoading = ref(false)
const saving = ref(false)

// ── Composition template (v1.0.260 — composition.png) ────────────────
const compositionExists = ref<boolean | null>(null)
const compositionVersion = ref(0)
const uploadingComposition = ref(false)
const compositionUrl = computed(() =>
  `/api/projects/${slug.value}/episodes/${episodeId.value}/img2img-references/file/composition.png?v=${compositionVersion.value}`,
)
const compositionModel = ref('')
const compositionPrompt = ref('')
const generatingComposition = ref(false)

// ── Episode sheet (master img2img reference) ─────────────────────────
const masterExists = ref<boolean | null>(null)
const masterVersion = ref(0)
const uploadingSheet = ref(false)
const masterUrl = computed(() =>
  `/api/projects/${slug.value}/episodes/${episodeId.value}/img2img-references/file/master.png?v=${masterVersion.value}`,
)

// ── Style reference (v1.0.229 — style.png) ───────────────────────────
const styleExists = ref<boolean | null>(null)
const styleVersion = ref(0)
const uploadingStyle = ref(false)
const styleUrl = computed(() =>
  `/api/projects/${slug.value}/episodes/${episodeId.value}/img2img-references/file/style.png?v=${styleVersion.value}`,
)

function firstImage(c: Character): string | null {
  return c.references?.images?.[0] || null
}
function charImageUrl(c: Character, filename: string): string {
  return `/api/projects/${slug.value}/characters/${c.id}/reference-image/${encodeURIComponent(filename)}`
}

const anchorsWithoutImages = computed(() =>
  characters.value
    .filter(c => config.value.anchor_character_ids.includes(c.id) && !firstImage(c))
    .map(c => c.name),
)

function toggleAnchor(id: string): void {
  const ids = config.value.anchor_character_ids
  const i = ids.indexOf(id)
  if (i >= 0) ids.splice(i, 1)
  else ids.push(id)
}

async function loadCharacters(): Promise<void> {
  if (!episodeId.value) { characters.value = []; return }
  charsLoading.value = true
  try {
    characters.value = await cm.listForEpisode(episodeId.value)
  } catch (e: any) {
    if (!e?.__slugRace) showError(e?.data?.detail || 'Failed to load characters')
  } finally {
    charsLoading.value = false
  }
}

async function loadConfig(): Promise<void> {
  if (!episodeId.value) { config.value = defaults(); return }
  try {
    const r = await get<{ exists: boolean; config: ContinuityConfig }>(
      `/projects/${slug.value}/continuity/${episodeId.value}`,
    )
    config.value = {
      ...defaults(), ...r.config,
      pacing: { ...defaults().pacing, ...r.config?.pacing },
      references: { ...defaults().references, ...r.config?.references },
      recipe: { ...defaultRecipe(), ...(r.config as any)?.recipe },
    }
  } catch (e: any) {
    if (!e?.__slugRace) config.value = defaults()
  }
}

async function saveConfig(): Promise<void> {
  if (!episodeId.value) return
  saving.value = true
  try {
    await put(`/projects/${slug.value}/continuity/${episodeId.value}`, config.value)
    success('Continuity settings saved')
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to save continuity settings')
  } finally {
    saving.value = false
  }
}

// ── Episode sheet upload (base64 JSON → existing master route) ───────
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = String(reader.result || '')
      const idx = dataUrl.indexOf('base64,')
      resolve(idx >= 0 ? dataUrl.slice(idx + 'base64,'.length) : dataUrl)
    }
    reader.onerror = () => reject(reader.error || new Error('FileReader failed'))
    reader.readAsDataURL(file)
  })
}

async function onSheetFiles(files: File[]): Promise<void> {
  const file = files[0]
  if (!file) return
  uploadingSheet.value = true
  try {
    const data_base64 = await fileToBase64(file)
    await post(`/projects/${slug.value}/episodes/${episodeId.value}/img2img-references/master`, {
      filename: file.name,
      data_base64,
    })
    masterVersion.value++       // cache-bust the preview
    masterExists.value = true
    config.value.use_episode_sheet = true  // auto-enable once a sheet exists
    success('Episode sheet uploaded')
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to upload episode sheet')
  } finally {
    uploadingSheet.value = false
  }
}

async function removeSheet(): Promise<void> {
  if (!episodeId.value) return
  try {
    await del(`/projects/${slug.value}/episodes/${episodeId.value}/img2img-references/master`)
    masterExists.value = false
    masterVersion.value++
    config.value.use_episode_sheet = false
    success('Episode sheet removed')
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to remove episode sheet')
  }
}

async function onStyleFiles(files: File[]): Promise<void> {
  const file = files[0]
  if (!file) return
  uploadingStyle.value = true
  try {
    const data_base64 = await fileToBase64(file)
    await post(`/projects/${slug.value}/episodes/${episodeId.value}/img2img-references/style`, {
      filename: file.name,
      data_base64,
    })
    styleVersion.value++
    styleExists.value = true
    config.value.references.style = true   // auto-enable once a style ref exists
    success('Style reference uploaded')
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to upload style reference')
  } finally {
    uploadingStyle.value = false
  }
}

async function removeStyle(): Promise<void> {
  if (!episodeId.value) return
  try {
    await del(`/projects/${slug.value}/episodes/${episodeId.value}/img2img-references/style`)
    styleExists.value = false
    styleVersion.value++
    config.value.references.style = false
    success('Style reference removed')
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to remove style reference')
  }
}

// ── Composition template (upload / generate / remove) ────────────────
async function onCompositionFiles(files: File[]): Promise<void> {
  const file = files[0]
  if (!file) return
  uploadingComposition.value = true
  try {
    const data_base64 = await fileToBase64(file)
    await post(`/projects/${slug.value}/episodes/${episodeId.value}/img2img-references/composition`, {
      filename: file.name,
      data_base64,
    })
    compositionVersion.value++
    compositionExists.value = true
    config.value.references.composition = true  // auto-enable once a template exists
    success('Composition template uploaded')
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to upload composition template')
  } finally {
    uploadingComposition.value = false
  }
}

async function removeComposition(): Promise<void> {
  if (!episodeId.value) return
  try {
    await del(`/projects/${slug.value}/episodes/${episodeId.value}/img2img-references/composition`)
    compositionExists.value = false
    compositionVersion.value++
    config.value.references.composition = false
    success('Composition template removed')
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to remove composition template')
  }
}

async function generateComposition(): Promise<void> {
  if (!episodeId.value || !compositionModel.value || !compositionPrompt.value.trim()) return
  generatingComposition.value = true
  // Pin the episode this run is for + the current file size, so we (a) ignore
  // results after the user switches episodes, and (b) detect a NEW render even
  // when replacing an existing template (size changes).
  const ep = episodeId.value
  try {
    const pre = await get<{ composition?: { size_bytes: number } }>(
      `/projects/${slug.value}/episodes/${ep}/img2img-references`,
    ).catch(() => ({} as any))
    const startSize = pre?.composition?.size_bytes ?? -1
    await post(`/projects/${slug.value}/episodes/${ep}/img2img-references/composition/generate`, {
      model: compositionModel.value,
      prompt: compositionPrompt.value.trim(),
      aspect_ratio: '16:9',
    })
    success('Generating composition template… this can take up to a minute.')
    const started = Date.now()
    const poll = async (): Promise<void> => {
      // User moved on — abandon this poll quietly.
      if (episodeId.value !== ep) { generatingComposition.value = false; return }
      if (Date.now() - started > 120_000) {
        generatingComposition.value = false
        showError('Template generation timed out — check the Jobs panel; it may have failed (e.g. the model ran out of memory).')
        return
      }
      try {
        const r = await get<{ composition?: { size_bytes: number } }>(
          `/projects/${slug.value}/episodes/${ep}/img2img-references`,
        )
        if (r.composition && r.composition.size_bytes !== startSize) {
          compositionVersion.value++
          compositionExists.value = true
          config.value.references.composition = true
          generatingComposition.value = false
          success('Composition template generated')
          return
        }
      } catch { /* transient — keep polling */ }
      setTimeout(() => { void poll() }, 2500)
    }
    setTimeout(() => { void poll() }, 2500)
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to start template generation')
    generatingComposition.value = false
  }
}

// v1.0.231 — authoritative existence check for the reference images. The old
// hidden-<img> probe could flip "exists" back to false on a transient load
// error right after an upload (so the user saw no confirmation). This reads
// the references listing instead — reliable, and drives the "✓ Saved" badges.
async function loadRefs(): Promise<void> {
  if (!episodeId.value) { masterExists.value = false; styleExists.value = false; return }
  try {
    const r = await get<{ master?: { url: string }; style?: { url: string }; composition?: { url: string } }>(
      `/projects/${slug.value}/episodes/${episodeId.value}/img2img-references`,
    )
    masterExists.value = !!r.master
    styleExists.value = !!r.style
    compositionExists.value = !!r.composition
  } catch (e: any) {
    if (!e?.__slugRace) { masterExists.value = false; styleExists.value = false; compositionExists.value = false }
  }
}

// Reload everything on episode change.
watch(episodeId, () => {
  masterExists.value = null
  styleExists.value = null
  compositionExists.value = null
  generatingComposition.value = false
  masterVersion.value++
  styleVersion.value++
  compositionVersion.value++
  void loadCharacters()
  void loadConfig()
  void loadRefs()
  void pagePresets.load()
}, { immediate: true })
</script>

<style scoped>
.cs-link, .cs-char-card .cs-link { color: var(--accent); text-decoration: none; }
.cs-link:hover { text-decoration: underline; }

.cs-char-list { display: flex; flex-direction: column; gap: 10px; }
.cs-warn { color: var(--warning, #ca8a04); }

/* v1.0.231 — persistent "saved" indicator for reference uploads, so the user
   isn't left wondering whether the upload stuck after the toast fades. */
.cs-saved-badge {
  display: inline-block;
  margin-left: 6px;
  padding: 2px 9px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  background: rgba(91, 179, 124, 0.16);
  color: rgb(34, 134, 70);
  vertical-align: middle;
}
.cs-sheet-row { display: flex; gap: 16px; align-items: flex-start; flex-wrap: wrap; }
.cs-sheet-main { flex: 1; min-width: 240px; }
.cs-sheet-preview {
  width: 140px; height: 140px; border-radius: 8px; overflow: hidden;
  border: 1px solid var(--border); background: var(--bg-tertiary); flex-shrink: 0;
}
.cs-sheet-preview img { width: 100%; height: 100%; object-fit: cover; }
.cs-sheet-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 8px; }
.cs-gen-box {
  display: flex; flex-direction: column; gap: 4px;
  padding: 10px; border: 1px dashed var(--border); border-radius: 8px;
  background: var(--bg-tertiary);
}

.cs-settings { display: flex; flex-direction: column; gap: 18px; }
.cs-checkbox { display: flex; align-items: center; gap: 8px; font-size: 13px; margin-top: 4px; cursor: pointer; }
.cs-range-row { display: flex; align-items: center; gap: 8px; }
/* v1.0.337 — guide cast density slider */
.cs-density-row { display: flex; align-items: center; gap: 12px; max-width: 420px; }
.cs-density-slider { flex: 1; cursor: pointer; accent-color: #6aa9ff; }
.cs-density-readout { font-size: 13px; font-weight: 600; min-width: 150px; color: var(--text-primary); }
.cs-density-readout.off { color: var(--text-muted); font-weight: 500; }
.input-inline { width: 70px; }
.cs-range { width: 260px; max-width: 100%; }
</style>
