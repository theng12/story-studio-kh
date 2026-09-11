<!--
  v1.0.189 (CC2) — Character Sheet page (continuity-chain).

  The compact visual-setup step: select Channel Characters, optionally store
  one episode visual anchor, choose the shared Style Library look, and set the
  episode pacing. The config persists to <episode_dir>/continuity.json and
  Scene Plan consumes its pacing guardrail.

  Only reachable for continuity-chain projects (sidebar gates on
  isContinuityChain).
-->
<template>
  <div class="workspace-page character-sheet-workspace">
    <WorkspaceHero
      eyebrow="Continuity · Visual anchors"
      title="Character Sheet"
      description="Choose the recurring cast, an optional episode visual anchor, and the channel look for this episode."
    />

    <TopActionBar
      :project-slug="slug"
      v-model:episode-id="episodeId"
      filter-field="character_sheet"
      :presets="pagePresets"
      generate-label="Save visual setup"
      loading-label="Saving…"
      :generate-loading="saving"
      :generate-disabled="!episodeId"
      :generate-status="saving ? 'Saving visual setup…' : (episodeId ? '' : 'Pick an episode first')"
      @generate="saveConfig"
    />

    <div v-if="!episodeId" class="card mt-3">
      <p class="text-muted text-sm">Pick an episode above to configure its visual anchors, channel look, and scene rhythm.</p>
    </div>

    <template v-else>
      <section class="card mt-3 cs-visual-setup">
        <header class="cs-section-head">
          <div>
            <span class="cs-kicker">Episode-specific</span>
            <h3>Visual anchors</h3>
            <p class="text-muted text-sm">Pick the recurring cast and, if useful, add one visual anchor for this episode.</p>
          </div>
          <NuxtLink :to="{ path: '/character-library', query: { channel: slug, project: slug } }" class="btn btn-ghost btn-sm">Manage channel characters →</NuxtLink>
        </header>

        <div class="cs-anchor-layout">
          <div class="cs-anchor-characters">
            <div class="cs-field-head">
              <strong>Channel characters</strong>
              <span>{{ config.anchor_character_ids.length }} selected</span>
            </div>
            <div v-if="charsLoading" class="text-muted text-sm">Loading characters…</div>
            <div v-else-if="!characters.length" class="cs-empty-inline text-muted text-sm">
              No Channel Characters are assigned yet.
              <NuxtLink :to="{ path: '/character-library', query: { channel: slug, project: slug } }" class="cs-link">Create or assign one →</NuxtLink>
            </div>
            <div v-else class="cs-character-grid">
              <button
                v-for="character in characters"
                :key="character.id"
                type="button"
                :class="['cs-character-tile', { selected: config.anchor_character_ids.includes(character.id), missing: !firstImage(character) }]"
                :aria-pressed="config.anchor_character_ids.includes(character.id)"
                @click="toggleAnchor(character.id)"
              >
                <img v-if="firstImage(character)" :src="charImageUrl(character, firstImage(character)!)" :alt="character.name" />
                <span v-else class="cs-character-placeholder" aria-hidden="true">{{ character.name.slice(0, 1) }}</span>
                <span class="cs-character-name">{{ character.name }}</span>
                <span class="cs-character-state">{{ firstImage(character) ? (config.anchor_character_ids.includes(character.id) ? 'Anchored' : 'Select') : 'Needs image' }}</span>
              </button>
            </div>
            <p v-if="anchorsWithoutImages.length" class="cs-warn text-xs">
              {{ anchorsWithoutImages.join(', ') }} {{ anchorsWithoutImages.length === 1 ? 'needs' : 'need' }} a portrait before it can visually anchor a render.
            </p>
          </div>

          <div class="cs-episode-anchor">
            <div class="cs-field-head">
              <strong>Episode visual anchor</strong>
              <span v-if="masterExists" class="cs-saved-badge">Saved</span>
              <span v-else>Optional</span>
            </div>
            <p class="text-muted text-xs">One image reserved for this episode's reference-guided visual setup.</p>
            <div v-if="masterExists" class="cs-reference-card">
              <a :href="masterUrl" target="_blank" rel="noopener" class="cs-reference-preview" title="Open full-size episode visual anchor">
                <img :src="masterUrl" alt="Episode visual anchor" />
              </a>
              <div class="cs-reference-actions">
                <ReferenceDropzone class="cs-reference-dropzone" :busy="uploadingSheet" @files="onSheetFiles">
                  <template #title>Replace image</template>
                  <template #hint>Paste, drop, or browse</template>
                </ReferenceDropzone>
                <div class="cs-reference-action-row">
                  <label class="cs-checkbox">
                    <input v-model="episodeAnchorEnabled" type="checkbox" />
                    Use episode anchor
                  </label>
                  <a :href="masterUrl" target="_blank" rel="noopener" class="cs-link text-xs">View full size</a>
                  <button class="btn btn-ghost btn-sm" :disabled="uploadingSheet" @click="removeSheet">Remove</button>
                </div>
              </div>
            </div>
            <ReferenceDropzone v-else class="cs-reference-dropzone cs-reference-dropzone-empty" :busy="uploadingSheet" @files="onSheetFiles">
              <template #title>Drop an episode visual anchor</template>
              <template #hint>Paste, drop, or browse one image</template>
            </ReferenceDropzone>

            <!-- Composition template. Restored 2026-08-27 at the owner's
                 direction. The backend for this never went away — the route,
                 the generator, the job type and the config flag all stayed
                 live; only the control was missing, which made the whole
                 feature unreachable. -->
            <div class="cs-composition-block">
              <div class="cs-field-head">
                <strong>Composition template</strong>
                <span v-if="compositionExists" class="cs-saved-badge">Saved</span>
                <span v-else>Optional</span>
              </div>
              <p class="text-muted text-xs">The layout every scene is structured against. Drop one in, or describe it and have an image model draw it.</p>

              <div v-if="compositionExists" class="cs-reference-card">
                <a :href="compositionUrl" target="_blank" rel="noopener" class="cs-reference-preview" title="Open full-size composition template">
                  <img :src="compositionUrl" alt="Composition template" />
                </a>
                <div class="cs-reference-actions">
                  <ReferenceDropzone class="cs-reference-dropzone" :busy="uploadingComposition" @files="onCompositionFiles">
                    <template #title>Replace image</template>
                    <template #hint>Paste, drop, or browse</template>
                  </ReferenceDropzone>
                  <div class="cs-reference-action-row">
                    <label class="cs-checkbox">
                      <input v-model="config.references.composition" type="checkbox" />
                      Use composition template
                    </label>
                    <a :href="compositionUrl" target="_blank" rel="noopener" class="cs-link text-xs">View full size</a>
                    <button class="btn btn-ghost btn-sm" :disabled="uploadingComposition" @click="removeComposition">Remove</button>
                  </div>
                </div>
              </div>
              <ReferenceDropzone v-else class="cs-reference-dropzone cs-reference-dropzone-empty" :busy="uploadingComposition" @files="onCompositionFiles">
                <template #title>Drop a composition template</template>
                <template #hint>Paste, drop, or browse one image</template>
              </ReferenceDropzone>

              <details class="cs-composition-generate">
                <summary>Or describe the layout and generate it</summary>
                <textarea
                  v-model="compositionPrompt"
                  class="input mt-2"
                  rows="3"
                  placeholder="e.g. wide 16:9 frame, subject centred as the focal object, guide character standing at the right edge, plenty of clear space above for a caption"
                ></textarea>
                <ImageModelPicker v-model="compositionModel" :project-slug="slug" class="mt-2" />
                <button
                  class="btn btn-primary btn-sm mt-2"
                  :disabled="!compositionPrompt.trim() || !compositionModel || generatingComposition"
                  @click="generateComposition"
                >
                  {{ generatingComposition ? 'Starting…' : 'Generate template' }}
                </button>
                <p class="text-muted text-xs mt-1">Runs as a job — watch it on the Jobs page, then reload this page to see it.</p>
              </details>
            </div>
          </div>
        </div>
      </section>

      <section class="card mt-3 cs-look-card">
        <header class="cs-section-head">
          <div>
            <span class="cs-kicker">Channel look</span>
            <h3>Visual art style</h3>
            <p class="text-muted text-sm">Choose one reusable channel look. Its render guidance is handled automatically.</p>
          </div>
        </header>
        <StylePicker
          :slug="slug"
          :active-style-bible="config.style_bible"
          :show-custom-styles="false"
          @apply="onStyleApply"
        />
      </section>

      <section class="card mt-3 cs-rhythm-card">
        <header class="cs-section-head">
          <div>
            <h3>Visual timing & motion</h3>
            <p class="text-muted text-sm">{{ pacingSummary }} Scene Plan owns the saved episode timing and motion scope.</p>
          </div>
          <NuxtLink :to="{ path: `/projects/${slug}/scene-plan`, query: { episode_id: episodeId }, hash: '#visual-timing' }" class="btn btn-secondary btn-sm">Open Scene Plan →</NuxtLink>
        </header>

        <WorkspaceNotice
          v-if="pacingPresetNotice"
          class="cs-rhythm-notice"
          :tone="pacingPresetNotice.applied ? 'success' : 'info'"
          :title="pacingPresetNotice.applied ? 'The preset set this episode\'s scene rhythm' : 'That preset has no saved scene rhythm'"
        >
          <template v-if="pacingPresetNotice.applied">
            It stores {{ pacingPresetNotice.band }}, and this episode now uses that. Save visual setup to keep it.
          </template>
          <template v-else>
            It was saved while presets did not record rhythm, so this episode stays on
            {{ pacingPresetNotice.band }} — nothing was reset. Choose the rhythm you want, then
            save over the preset to capture it for next time.
          </template>
        </WorkspaceNotice>
      </section>

    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import type { Character } from '../../../composables/useCharacters.js'
import {
  CONTINUITY_PRESET_EXCLUDE_KEYS,
  applyContinuityPagePreset,
  continuityDefaults,
  normalizeContinuityConfig,
  storedPresetPacing,
} from '../../../composables/useContinuityConfig.js'
import type { ContinuityConfig, ContinuityPagePreset } from '../../../composables/useContinuityConfig.js'

definePageMeta({ layout: 'dashboard' })
useAppTitle('Character Sheet')

const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { get, put, post, del } = useApi()
const { success, error: showError } = useToast()
const cm = useCharacters(slug)

const episodeId = ref('')

// Config shape, defaults, and the preset boundary live in the composable so
// they are importable by tests — see composables/useContinuityConfig.ts.
const config = ref<ContinuityConfig>(continuityDefaults())
const pacingSummary = computed(() => config.value.pacing.mode === 'variable'
  ? `Draft: ${config.value.pacing.periods.length} ordered pacing periods.`
  : `Draft: uniform ${config.value.pacing.min_sec}–${config.value.pacing.max_sec} second scenes.`)

// v1.2.5 — a Character Sheet preset carries the scene rhythm again (AGENTS.md,
// Preset Boundaries; the owner's reversal of 2026-08-03, made 2026-08-18).
// Presets saved during the exclusion window store NO rhythm, so applying one
// correctly leaves the episode's rhythm alone — which looks exactly like a
// feature that does not work. Say which of the two happened, every time.
const pacingPresetNotice = ref<{ applied: boolean; band: string } | null>(null)
function pacingBandLabel(pacing: ContinuityConfig['pacing']): string {
  return pacing.mode === 'variable'
    ? `${pacing.periods.length} ordered pacing periods`
    : `${pacing.min_sec}–${pacing.max_sec} seconds`
}
/** Any hand edit of the rhythm supersedes what the last applied preset said. */
function onPacingEdited(): void { pacingPresetNotice.value = null }

// v1.0.356 — ONE whole-page preset for the entire continuity setup. Replaces
// the fragmented style controls the user had to manage separately. A channel's
// continuity LOOK (anchors, references, denoise, Style Bible, and negative
// prompt) is usually the same across episodes, so saving it ONCE fills the
// whole page in one click instead of re-picking every attribute. Lives in
// the TopActionBar's preset row (same spot as Scripts/Prompts).
//
// autoApplyOnLoad is OFF: the episode's own continuity.json drives the fields
// on load; the preset is applied only on explicit Apply (then Save anchors &
// settings to persist it into this episode).
//
// Snapshot/apply cover the FULL config minus the transient `updated_at` and
// minus the episode's own anchor toggle — the look/episode-state boundary is
// documented on CONTINUITY_PRESET_EXCLUDE_KEYS / applyContinuityPagePreset.
// Scene rhythm is part of a preset again as of v1.2.5.
const pagePresets = usePresets<ContinuityPagePreset>({
  slug: slug.value,
  configKey: 'continuity_page',
  presetType: 'continuity-page',
  autoApplyOnLoad: false,
  excludeKeys: CONTINUITY_PRESET_EXCLUDE_KEYS,
  snapshot: () => {
    // Deep clone so the stored preset doesn't alias the live config refs.
    const { updated_at: _drop, ...rest } = config.value
    return JSON.parse(JSON.stringify(rest)) as ContinuityPagePreset
  },
  apply: (data) => {
    // Read the stored rhythm BEFORE the fold, because after it the live and
    // preset values are indistinguishable when the two happen to agree.
    const applied = storedPresetPacing(data) !== null
    config.value = applyContinuityPagePreset(config.value, data)
    pacingPresetNotice.value = { applied, band: pacingBandLabel(config.value.pacing) }
  },
})

// The shared Style Library owns all customer-visible style selection. Its
// prompt data remains an internal render detail, saved with the episode.
function onStyleApply(data: { style_bible: string; negative_prompt: string }): void {
  config.value.style_bible = data.style_bible || ''
  config.value.negative_prompt = data.negative_prompt || ''
  success('Style applied — Save visual setup to keep it for this episode')
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

const episodeAnchorEnabled = computed({
  get: () => config.value.use_episode_sheet,
  set: (enabled: boolean) => {
    // Older continuity files carried two sheet switches. Keep both in sync so
    // saved presets and the renderer have one clear customer choice without
    // breaking old episode data.
    //
    // This switch is no longer decorative. `generators/continuity-render.ts`
    // reads it (as the same OR of both names) and, when it is on, attaches the
    // episode's one reference image to every character scene of a Scene Review
    // render — `img2img-references/composition.png` if a composition template
    // was generated, otherwise the anchor uploaded here.
    config.value.use_episode_sheet = enabled
    config.value.references.sheet = enabled
  },
})

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
  config.value.references.characters = ids.length > 0
}

let characterScopeSequence = 0

async function loadCharacters(): Promise<void> {
  const ep = episodeId.value
  const project = slug.value
  const scope = characterScopeSequence
  const current = () => scope === characterScopeSequence && project === slug.value && ep === episodeId.value
  if (!ep) { characters.value = []; return }
  charsLoading.value = true
  try {
    const loaded = await cm.listForEpisode(ep)
    if (!current()) return
    characters.value = loaded
  } catch (e: any) {
    if (current() && !e?.__slugRace) showError(e?.data?.detail || 'Failed to load characters')
  } finally {
    if (current()) charsLoading.value = false
  }
}

async function loadConfig(): Promise<void> {
  const ep = episodeId.value
  const project = slug.value
  const scope = characterScopeSequence
  const current = () => scope === characterScopeSequence && project === slug.value && ep === episodeId.value
  if (!ep) { config.value = continuityDefaults(); return }
  try {
    const r = await get<{ exists: boolean; config: ContinuityConfig }>(`/projects/${project}/continuity/${ep}`)
    if (!current()) return
    config.value = r.exists ? normalizeContinuityConfig(r.config) : continuityDefaults()
  } catch (e: any) {
    if (current() && !e?.__slugRace) config.value = continuityDefaults()
  }
}

async function saveConfig(): Promise<void> {
  const ep = episodeId.value
  const project = slug.value
  const scope = characterScopeSequence
  const current = () => scope === characterScopeSequence && project === slug.value && ep === episodeId.value
  if (!ep) return
  saving.value = true
  try {
    const saved = await put<{ ok: true; config: ContinuityConfig }>(`/projects/${project}/continuity/${ep}`, JSON.parse(JSON.stringify(config.value)))
    if (!current()) return
    config.value = normalizeContinuityConfig(saved.config)
    success('Visual setup saved')
  } catch (e: any) {
    if (current()) showError(e?.data?.detail || 'Failed to save continuity settings')
  } finally {
    if (current()) saving.value = false
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
  const ep = episodeId.value
  const project = slug.value
  const scope = characterScopeSequence
  const current = () => scope === characterScopeSequence && project === slug.value && ep === episodeId.value
  if (!file || !ep) return
  uploadingSheet.value = true
  try {
    const data_base64 = await fileToBase64(file)
    if (!current()) return
    await post(`/projects/${project}/episodes/${ep}/img2img-references/master`, {
      filename: file.name,
      data_base64,
    })
    if (!current()) return
    masterVersion.value++       // cache-bust the preview
    masterExists.value = true
    episodeAnchorEnabled.value = true
    success('Episode visual anchor uploaded')
  } catch (e: any) {
    if (current()) showError(e?.data?.detail || 'Failed to upload episode sheet')
  } finally {
    if (current()) uploadingSheet.value = false
  }
}

// ── Composition template (img2img-references/composition.png) ─────────
const compositionExists = ref<boolean | null>(null)
const compositionVersion = ref(0)
const uploadingComposition = ref(false)
const generatingComposition = ref(false)
const compositionPrompt = ref('')
const compositionModel = ref('')
const compositionUrl = computed(() =>
  `/api/projects/${slug.value}/episodes/${episodeId.value}/img2img-references/file/composition.png?v=${compositionVersion.value}`,
)

async function onCompositionFiles(files: File[]): Promise<void> {
  const file = files[0]
  const ep = episodeId.value
  const project = slug.value
  const scope = characterScopeSequence
  const current = () => scope === characterScopeSequence && project === slug.value && ep === episodeId.value
  if (!file || !ep) return
  uploadingComposition.value = true
  try {
    const data_base64 = await fileToBase64(file)
    if (!current()) return
    await post(`/projects/${project}/episodes/${ep}/img2img-references/composition`, {
      filename: file.name,
      data_base64,
    })
    if (!current()) return
    compositionVersion.value++
    compositionExists.value = true
    // Uploading one is the customer saying they want it used. The flag is
    // still theirs to turn back off with the checkbox beside the preview.
    config.value.references.composition = true
    success('Composition template uploaded')
  } catch (e: any) {
    if (current()) showError(e?.data?.detail || 'Failed to upload composition template')
  } finally {
    if (current()) uploadingComposition.value = false
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
  if (!episodeId.value || !compositionPrompt.value.trim() || !compositionModel.value) return
  generatingComposition.value = true
  try {
    await post(`/projects/${slug.value}/episodes/${episodeId.value}/img2img-references/composition/generate`, {
      prompt: compositionPrompt.value.trim(),
      model: compositionModel.value,
    })
    success('Generating the composition template — watch it on the Jobs page')
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to start composition template generation')
  } finally {
    generatingComposition.value = false
  }
}

async function removeSheet(): Promise<void> {
  if (!episodeId.value) return
  try {
    await del(`/projects/${slug.value}/episodes/${episodeId.value}/img2img-references/master`)
    masterExists.value = false
    masterVersion.value++
    episodeAnchorEnabled.value = false
    success('Episode visual anchor removed')
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to remove episode sheet')
  }
}

// Authoritative existence check for the episode visual anchor. This avoids a
// fragile hidden-image probe and keeps the compact preview truthful.
async function loadRefs(): Promise<void> {
  const ep = episodeId.value
  const project = slug.value
  const scope = characterScopeSequence
  const current = () => scope === characterScopeSequence && project === slug.value && ep === episodeId.value
  if (!ep) { masterExists.value = false; compositionExists.value = false; return }
  try {
    const r = await get<{ master?: { url: string }; composition?: { url: string } }>(
      `/projects/${project}/episodes/${ep}/img2img-references`,
    )
    if (!current()) return
    masterExists.value = !!r.master
    compositionExists.value = !!r.composition
  } catch (e: any) {
    if (current() && !e?.__slugRace) { masterExists.value = false; compositionExists.value = false }
  }
}

// Reload everything on episode change.
watch([slug, episodeId], () => {
  characterScopeSequence++
  masterExists.value = null
  masterVersion.value++
  compositionExists.value = null
  compositionVersion.value++
  charsLoading.value = false
  saving.value = false
  uploadingSheet.value = false
  uploadingComposition.value = false
  onPacingEdited()   // the last apply said nothing about the episode now open
  void loadCharacters()
  void loadConfig()
  void loadRefs()
  void pagePresets.load()
}, { immediate: true, flush: 'sync' })
</script>

<style scoped>
.cs-link, .cs-char-card .cs-link { color: var(--accent); text-decoration: none; }
.cs-link:hover { text-decoration: underline; }
.cs-section-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; }
.cs-section-head h3 { margin: 3px 0 0; }
.cs-section-head p { margin: 4px 0 0; }
.cs-kicker { color: var(--accent); font-size: var(--font-xs); font-weight: 800; letter-spacing: .1em; text-transform: uppercase; }
.cs-anchor-layout { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(330px, .75fr); gap: 20px; margin-top: 16px; }
.cs-anchor-characters, .cs-episode-anchor { min-width: 0; }
.cs-composition-block { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--border); }
.cs-composition-generate { margin-top: 12px; }
.cs-composition-generate > summary { cursor: pointer; font-size: var(--font-xs); color: var(--text-muted); }
.cs-composition-generate > summary:hover { color: var(--text-primary); }
.cs-episode-anchor { padding-left: 20px; border-left: 1px solid var(--border); }
.cs-field-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 13px; }
.cs-field-head > span { color: var(--text-muted); font-size: var(--font-xs); }
.cs-character-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(112px, 1fr)); gap: 9px; margin-top: 10px; }
.cs-character-tile { position: relative; min-width: 0; overflow: hidden; padding: 0 0 8px; border: 1px solid var(--border); border-radius: 9px; background: var(--bg-secondary); color: var(--text-primary); cursor: pointer; text-align: left; transition: border-color .15s, background .15s, transform .15s; }
.cs-character-tile:hover { border-color: var(--accent); transform: translateY(-1px); }
.cs-character-tile:focus-visible { outline: none; border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-dim); }
.cs-character-tile.selected { border-color: var(--accent); background: var(--accent-dim); }
.cs-character-tile.missing { border-style: dashed; }
.cs-character-tile img, .cs-character-placeholder { display: grid; width: 100%; height: 76px; object-fit: cover; place-items: center; background: var(--bg-tertiary); color: var(--text-muted); font-size: 24px; }
.cs-character-name, .cs-character-state { display: block; overflow: hidden; padding: 0 8px; text-overflow: ellipsis; white-space: nowrap; }
.cs-character-name { margin-top: 8px; font-size: 12px; font-weight: 700; }
.cs-character-state { margin-top: 2px; color: var(--text-muted); font-size: var(--font-xs); }
.cs-character-tile.selected .cs-character-state { color: var(--accent); }
.cs-empty-inline { margin-top: 12px; padding: 12px; border: 1px dashed var(--border); border-radius: 8px; }
.cs-warn { margin: 9px 0 0; color: var(--warning, #ca8a04); }
.cs-saved-badge {
  display: inline-block;
  padding: 3px 8px;
  border-radius: 999px;
  font-size: var(--font-xs);
  font-weight: 600;
  background: rgba(91, 179, 124, 0.16);
  color: rgb(34, 134, 70);
}
.cs-reference-card { display: grid; grid-template-columns: minmax(170px, 250px) minmax(0, 1fr); gap: 12px; align-items: stretch; margin-top: 10px; }
.cs-reference-preview { display: grid; min-height: 155px; overflow: hidden; place-items: center; border: 1px solid var(--border); border-radius: 9px; background: var(--bg-tertiary); }
.cs-reference-preview img { width: 100%; height: 100%; max-height: 210px; object-fit: contain; }
.cs-reference-actions { display: flex; min-width: 0; flex-direction: column; justify-content: space-between; gap: 9px; }
.cs-reference-action-row { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
.cs-reference-action-row .btn { margin-left: auto; }
.cs-reference-dropzone { margin-top: 8px; }
.cs-reference-actions .cs-reference-dropzone { margin-top: 0; }
:deep(.cs-reference-dropzone.ref-dropzone) { min-height: 82px; padding: 11px 12px; }
:deep(.cs-reference-dropzone .ref-dropzone-icon) { font-size: 17px; }
:deep(.cs-reference-dropzone-empty.ref-dropzone) { min-height: 118px; }
.cs-checkbox { display: flex; align-items: center; gap: 8px; font-size: 13px; margin-top: 4px; cursor: pointer; }
.cs-range-row { display: flex; align-items: center; gap: 8px; }
.input-inline { width: 70px; }
.cs-look-card :deep(.style-picker) { margin-top: 14px; }
.cs-rhythm-control { max-width: 560px; margin-top: 14px; }
.cs-rhythm-notice { max-width: 560px; margin-top: 14px; }
@media (max-width: 900px) {
  .cs-anchor-layout { grid-template-columns: 1fr; }
  .cs-episode-anchor { padding: 18px 0 0; border-top: 1px solid var(--border); border-left: 0; }
}
@media (max-width: 620px) {
  .cs-section-head { flex-direction: column; gap: 8px; }
  .cs-section-head .btn { width: 100%; }
  .cs-reference-card { grid-template-columns: 1fr; }
  .cs-reference-preview { min-height: 190px; }
}
</style>
