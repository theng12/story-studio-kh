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
  <div class="workspace-page character-sheet-workspace">
    <WorkspaceHero
      eyebrow="Continuity · Visual anchors"
      title="Character Sheet"
      description="Choose the Channel Characters and reference images that lock this episode's cast, wardrobe, and visual identity."
    />

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

    <div v-if="!episodeId" class="card mt-3">
      <p class="text-muted text-sm">Pick an episode above to set its character anchor + continuity settings.</p>
    </div>

    <template v-else>
      <!-- 1. Anchor characters -->
      <section class="card mt-3">
        <div class="card-header">
          <h3>1. Anchor characters</h3>
          <NuxtLink :to="{ path: '/character-library', query: { channel: slug } }" class="btn btn-ghost btn-sm">Manage channel characters →</NuxtLink>
        </div>
        <p class="text-muted text-sm mt-1">
          Tick who appears in this episode. Their reference images anchor
          every scene. A character with no reference image can still guide the
          text prompt, but won't lock the visual — add a portrait on the
          Channel Characters workspace (or upload a sheet below).
        </p>

        <div v-if="charsLoading" class="text-muted text-sm mt-2">Loading characters…</div>
        <div v-else-if="!characters.length" class="text-muted text-sm mt-2">
          No Channel Characters are assigned to this channel yet.
          <NuxtLink :to="{ path: '/character-library', query: { channel: slug } }" class="cs-link">Create or assign one →</NuxtLink>
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
            <label>Visual pacing</label>
            <select v-model="pacingPreset" class="select" @change="applyPacingPreset">
              <option v-for="preset in PACING_PRESETS" :key="preset.id" :value="preset.id">{{ preset.label }}</option>
              <option value="custom">Custom range…</option>
            </select>
            <div v-if="pacingPreset === 'custom'" class="cs-range-row mt-1">
              <input v-model.number="config.pacing.min_sec" type="number" min="1" max="60" class="input input-sm input-inline" />
              <span class="text-muted">to</span>
              <input v-model.number="config.pacing.max_sec" type="number" min="1" max="60" class="input input-sm input-inline" />
            </div>
            <span class="text-muted text-xs">
              This is a strict maximum where the narration can be safely split.
              Long subtitle cues are divided at word or sentence boundaries with
              proportional timing; Story Studio never cuts through a word.
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
            :active-style-bible="config.style_bible"
            :show-custom-styles="false"
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

interface ContinuityConfig {
  schema_version: 1
  anchor_character_ids: string[]
  use_episode_sheet: boolean
  pacing: { min_sec: number; max_sec: number }
  references: { prev_render: boolean; sheet: boolean; characters: boolean; style: boolean }
  denoise_strength: number
  style_bible?: string
  negative_prompt?: string
  updated_at?: string
}

const PACING_PRESETS = [
  { id: 'rapid', min: 1, max: 3, label: '1–3 seconds — Rapid & lively' },
  { id: 'lively', min: 1, max: 4, label: '1–4 seconds — Lively storytelling' },
  { id: 'balanced', min: 3, max: 6, label: '3–6 seconds — Balanced narrative' },
  { id: 'cinematic', min: 2, max: 8, label: '2–8 seconds — Cinematic & robust' },
  { id: 'slow', min: 5, max: 10, label: '5–10 seconds — Slow & deliberate' },
  { id: 'contemplative', min: 8, max: 15, label: '8–15 seconds — Contemplative / ambient' },
] as const
function defaults(): ContinuityConfig {
  return {
    schema_version: 1,
    anchor_character_ids: [],
    use_episode_sheet: false,
    pacing: { min_sec: 1, max_sec: 4 },
    references: { prev_render: true, sheet: true, characters: true, style: false },
    denoise_strength: 0.5,
    style_bible: '',
    negative_prompt: '',
  }
}

function normalizeConfig(value?: Partial<ContinuityConfig> | null): ContinuityConfig {
  const d = defaults()
  return {
    ...d,
    schema_version: 1,
    anchor_character_ids: Array.isArray(value?.anchor_character_ids) ? [...value.anchor_character_ids] : [],
    use_episode_sheet: !!value?.use_episode_sheet,
    pacing: { ...d.pacing, ...(value?.pacing || {}) },
    references: {
      prev_render: value?.references?.prev_render ?? d.references.prev_render,
      sheet: value?.references?.sheet ?? d.references.sheet,
      characters: value?.references?.characters ?? d.references.characters,
      style: value?.references?.style ?? d.references.style,
    },
    denoise_strength: typeof value?.denoise_strength === 'number' ? value.denoise_strength : d.denoise_strength,
    style_bible: value?.style_bible || '',
    negative_prompt: value?.negative_prompt || '',
  }
}

const config = ref<ContinuityConfig>(defaults())
const pacingPreset = ref<string>('lively')
function syncPacingPreset(): void {
  pacingPreset.value = PACING_PRESETS.find(preset =>
    preset.min === config.value.pacing.min_sec && preset.max === config.value.pacing.max_sec,
  )?.id || 'custom'
}
function applyPacingPreset(): void {
  const preset = PACING_PRESETS.find(entry => entry.id === pacingPreset.value)
  if (preset) config.value.pacing = { min_sec: preset.min, max_sec: preset.max }
}
watch(() => [config.value.pacing.min_sec, config.value.pacing.max_sec], syncPacingPreset, { immediate: true })

// v1.0.356 — ONE whole-page preset for the entire continuity setup. Replaces
// the fragmented style controls the user had to manage separately. A channel's
// continuity look (anchors, references, pacing, denoise, Style Bible, and
// negative prompt) is usually the same across episodes, so saving it ONCE fills
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
    // Normalize explicitly so retired Visual Recipe/composition fields from
    // older presets cannot silently return to newly saved continuity configs.
    config.value = normalizeConfig(data)
  },
})

// Project config supplies image models to the built-in style gallery.
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
    config.value = normalizeConfig(r.config)
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

// v1.0.231 — authoritative existence check for the reference images. The old
// hidden-<img> probe could flip "exists" back to false on a transient load
// error right after an upload (so the user saw no confirmation). This reads
// the references listing instead — reliable, and drives the "✓ Saved" badges.
async function loadRefs(): Promise<void> {
  if (!episodeId.value) { masterExists.value = false; styleExists.value = false; return }
  try {
    const r = await get<{ master?: { url: string }; style?: { url: string } }>(
      `/projects/${slug.value}/episodes/${episodeId.value}/img2img-references`,
    )
    masterExists.value = !!r.master
    styleExists.value = !!r.style
  } catch (e: any) {
    if (!e?.__slugRace) { masterExists.value = false; styleExists.value = false }
  }
}

// Reload everything on episode change.
watch(episodeId, () => {
  masterExists.value = null
  styleExists.value = null
  masterVersion.value++
  styleVersion.value++
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
  font-size: var(--font-xs);
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
