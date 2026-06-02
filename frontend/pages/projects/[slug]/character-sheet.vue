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
      filter-field="script"
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
  updated_at?: string
}
function defaults(): ContinuityConfig {
  return {
    schema_version: 1,
    anchor_character_ids: [],
    use_episode_sheet: false,
    pacing: { min_sec: 2, max_sec: 8 },
    references: { prev_render: true, sheet: true, characters: true, style: false },
    denoise_strength: 0.5,
  }
}

const config = ref<ContinuityConfig>(defaults())
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
    config.value = { ...defaults(), ...r.config, pacing: { ...defaults().pacing, ...r.config?.pacing }, references: { ...defaults().references, ...r.config?.references } }
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

.cs-settings { display: flex; flex-direction: column; gap: 18px; }
.cs-checkbox { display: flex; align-items: center; gap: 8px; font-size: 13px; margin-top: 4px; cursor: pointer; }
.cs-range-row { display: flex; align-items: center; gap: 8px; }
.input-inline { width: 70px; }
.cs-range { width: 260px; max-width: 100%; }
</style>
