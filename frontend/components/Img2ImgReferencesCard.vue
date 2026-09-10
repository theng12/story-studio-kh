<!--
  Image-to-image reference sources card for /projects/:slug/images.
  Visible only when the user picks the "Image → Image" mode tab.

  Four independently-toggleable sources, all stack additively:

    1. Master ref       — one PNG for the whole episode.
    2. Per-scene ref    — one PNG per scene (drop-zone per row).
    3. Auto characters  — Phase 8 character-name detection, on by default.
    4. Chain mode       — scene N's render becomes scene N+1's reference.

  Refs persist on disk under <episode_dir>/img2img-references/. Toggles
  persist via the form (saved with image-prompts presets).
-->
<template>
  <div class="card mt-2 i2i">
    <div class="i2i-head">
      <h3 class="i2i-title">🖼️ {{ kind === 'thumbnail' ? 'Reference Thumbnail' : 'Reference Images (img2img sources)' }}</h3>
      <span class="text-muted text-xs">
        {{ kind === 'thumbnail'
          ? 'Replicate its visual grammar while adapting the content to this episode.'
          : 'Reference sources can stack — toggle each one independently.' }}
      </span>
    </div>

    <template v-if="kind === 'thumbnail'">
      <div class="i2i-section">
        <label class="i2i-toggle">
          <input type="checkbox" :checked="value.thumbnail" @change="setSource('thumbnail', ($event.target as HTMLInputElement).checked)" />
          <span class="i2i-toggle-label">
            <strong>Use external thumbnail as reference</strong> — borrow composition, palette, hierarchy, lighting, and title-safe spacing
          </span>
        </label>
        <div v-if="value.thumbnail" class="i2i-section-body">
          <div class="i2i-dropzone" :class="{ 'has-file': thumbnailUrl }">
            <img v-if="thumbnailUrl" :src="thumbnailUrl" alt="Reference thumbnail" class="i2i-thumb" />
            <div class="i2i-dropzone-controls">
              <button type="button" class="btn btn-sm btn-secondary" :disabled="thumbnailUploading" @click="pickThumbnail">
                <LoadingSpinner v-if="thumbnailUploading" size="sm" />
                {{ thumbnailUrl ? 'Replace thumbnail…' : 'Pick thumbnail…' }}
              </button>
              <button v-if="thumbnailUrl" type="button" class="btn btn-sm btn-ghost" :disabled="thumbnailUploading" @click="removeThumbnail">
                Remove
              </button>
            </div>
          </div>
          <div class="i2i-strength mt-2">
            <label>Reference influence</label>
            <select
              :value="referenceStrength"
              class="select"
              @change="$emit('update:referenceStrength', ($event.target as HTMLSelectElement).value as ReferenceStrength)"
            >
              <option value="loose">Loose inspiration — mood, palette, and energy</option>
              <option value="balanced">Balanced adaptation — composition and hierarchy</option>
              <option value="strong">Strong structure — closely follow layout and framing</option>
            </select>
            <p class="text-muted text-xs i2i-hint">
              The episode subject, characters, title, branding, and story details are always replaced. The reference is guidance, not content to copy.
            </p>
          </div>
        </div>
      </div>

      <div class="i2i-section">
        <label class="i2i-toggle">
          <input type="checkbox" :checked="value.characters" @change="setSource('characters', ($event.target as HTMLInputElement).checked)" />
          <span class="i2i-toggle-label">
            <strong>Auto character references</strong> — attach matching project-character images when their names appear in the thumbnail prompt
          </span>
        </label>
      </div>
    </template>

    <template v-else>
    <!-- ── Master reference ───────────────────────────────────────── -->
    <div class="i2i-section">
      <label class="i2i-toggle">
        <input type="checkbox" :checked="value.master" @change="setSource('master', ($event.target as HTMLInputElement).checked)" />
        <span class="i2i-toggle-label"><strong>Master reference</strong> — one image used for every scene</span>
      </label>
      <div v-if="value.master" class="i2i-section-body">
        <div class="i2i-dropzone" :class="{ 'has-file': masterUrl }">
          <img v-if="masterUrl" :src="masterUrl" alt="Master reference" class="i2i-thumb" />
          <div class="i2i-dropzone-controls">
            <button type="button" class="btn btn-sm btn-secondary" :disabled="masterUploading"
                    @click="pickMaster">
              <LoadingSpinner v-if="masterUploading" size="sm" />
              {{ masterUrl ? 'Replace…' : 'Pick image…' }}
            </button>
            <button v-if="masterUrl" type="button" class="btn btn-sm btn-ghost"
                    :disabled="masterUploading" @click="removeMaster">Remove</button>
          </div>
        </div>
      </div>
    </div>

    <!-- ── Per-scene references ──────────────────────────────────── -->
    <div class="i2i-section">
      <label class="i2i-toggle">
        <input type="checkbox" :checked="value.per_scene" @change="setSource('per_scene', ($event.target as HTMLInputElement).checked)" />
        <span class="i2i-toggle-label"><strong>Per-scene references</strong> — drop one image per scene</span>
      </label>
      <div v-if="value.per_scene" class="i2i-section-body">
        <div v-if="loadingScenes" class="text-muted text-md">
          <LoadingSpinner size="sm" /> Loading scene list…
        </div>
        <div v-else-if="!scenes.length" class="text-muted text-md">
          No planned scene prompts found yet. Build them in
          <NuxtLink :to="`/projects/${projectSlug}/scene-plan`">Scene Plan</NuxtLink> first.
        </div>
        <ul v-else class="i2i-scene-list" role="list">
          <li v-for="s in scenes" :key="s.number" class="i2i-scene-row">
            <span class="i2i-scene-num">{{ String(s.number).padStart(2, '0') }}</span>
            <span class="i2i-scene-title" :title="s.title">{{ s.title }}</span>
            <img v-if="sceneRefMap[s.number]" :src="sceneRefMap[s.number]"
                 alt="Scene reference" class="i2i-thumb-sm" />
            <button type="button" class="btn btn-sm btn-secondary"
                    :disabled="sceneUploading.has(s.number)"
                    @click="pickScene(s.number)">
              <LoadingSpinner v-if="sceneUploading.has(s.number)" size="sm" />
              {{ sceneRefMap[s.number] ? 'Replace…' : 'Pick…' }}
            </button>
            <button v-if="sceneRefMap[s.number]" type="button" class="btn btn-sm btn-ghost"
                    :disabled="sceneUploading.has(s.number)" @click="removeScene(s.number)">
              ✕
            </button>
          </li>
        </ul>
      </div>
    </div>

    <!-- ── Auto character references ─────────────────────────────── -->
    <div class="i2i-section">
      <label class="i2i-toggle">
        <input type="checkbox" :checked="value.characters" @change="setSource('characters', ($event.target as HTMLInputElement).checked)" />
        <span class="i2i-toggle-label">
          <strong>Auto character references</strong> — when a scene mentions a character by name, attach that character's library images
        </span>
      </label>
      <div v-if="value.characters" class="i2i-section-body">
        <p class="text-muted text-sm i2i-hint">
          Already-wired Phase 8 logic. Characters live under your
          <NuxtLink :to="`/projects/${projectSlug}/characters`">project's Characters</NuxtLink>
          page (or the shared <NuxtLink :to="{ path: '/character-library', query: { channel: projectSlug, project: projectSlug } }">Channel Characters</NuxtLink> workspace).
          When a scene's prompt text mentions a character by name, that character's
          uploaded reference images get attached automatically.
        </p>
      </div>
    </div>

    <!-- ── Chain mode ─────────────────────────────────────────────── -->
    <div class="i2i-section">
      <label class="i2i-toggle">
        <input type="checkbox" :checked="value.chain" @change="setSource('chain', ($event.target as HTMLInputElement).checked)" />
        <span class="i2i-toggle-label">
          <strong>Chain mode</strong> — use scene N's render as a reference for scene N+1 (continuity)
        </span>
      </label>
      <div v-if="value.chain" class="i2i-section-body">
        <p class="text-muted text-sm i2i-hint">
          Scenes generate <strong>serially</strong> in chapter order — each
          scene's rendered output is fed as a reference image for the next.
          Slower than parallel mode but produces consistent character / setting
          continuity across scenes.
        </p>
      </div>
    </div>
    </template>

    <!-- Hidden file input — programmatically clicked from the buttons above. -->
    <input ref="fileInputEl" type="file" accept="image/png,image/jpeg" class="i2i-file-input"
           @change="onFilePicked" />
  </div>
</template>

<script setup lang="ts">
import { ref, watch, computed } from 'vue'

interface ReferenceSources {
  master: boolean
  per_scene: boolean
  characters: boolean
  chain: boolean
  thumbnail: boolean
}
type ReferenceStrength = 'loose' | 'balanced' | 'strong'
interface SceneRow { number: number; title: string }

const props = defineProps<{
  projectSlug: string
  episodeId: string
  /** Episode title — required by resolveEpisodePaths backend-side. */
  title?: string
  kind?: 'scene' | 'thumbnail'
  /** v-model bound four-source toggle state. */
  value: ReferenceSources
  referenceStrength?: ReferenceStrength
}>()
const emit = defineEmits<{
  (e: 'update:value', v: ReferenceSources): void
  (e: 'update:referenceStrength', v: ReferenceStrength): void
}>()

const { get, post, del } = useApi()
const { error: showError, success } = useToast()

function setSource(key: keyof ReferenceSources, v: boolean): void {
  emit('update:value', { ...props.value, [key]: v })
}

// ── Master + per-scene file state ───────────────────────────────────────
const masterUrl = ref<string | null>(null)
const masterUploading = ref(false)
const thumbnailUrl = ref<string | null>(null)
const thumbnailUploading = ref(false)
const sceneRefMap = ref<Record<number, string>>({})
const sceneUploading = ref<Set<number>>(new Set())

// Scene list for the per-scene drop-zones — fetched from the same
// /image-prompts endpoint the Preview card uses.
const scenes = ref<SceneRow[]>([])
const loadingScenes = ref(false)

async function loadScenes(): Promise<void> {
  if (!props.episodeId || !props.projectSlug) return
  loadingScenes.value = true
  try {
    const titleParam = props.title ? `?title=${encodeURIComponent(props.title)}` : ''
    const data = await get<{ scenes: SceneRow[] }>(
      `/projects/${props.projectSlug}/episodes/${props.episodeId}/image-prompts${titleParam}`,
    )
    scenes.value = (data?.scenes || []).map(s => ({ number: s.number, title: s.title }))
  } catch {
    scenes.value = []
  } finally {
    loadingScenes.value = false
  }
}

async function loadRefs(): Promise<void> {
  if (!props.episodeId || !props.projectSlug) return
  try {
    const titleParam = props.title ? `?title=${encodeURIComponent(props.title)}` : ''
    const data = await get<{
      master?: { url: string }; thumbnail?: { url: string }; scenes: { number: number; url: string }[]
    }>(`/projects/${props.projectSlug}/episodes/${props.episodeId}/img2img-references${titleParam}`)
    masterUrl.value = data?.master?.url ? data.master.url : null
    thumbnailUrl.value = data?.thumbnail?.url ? data.thumbnail.url : null
    const map: Record<number, string> = {}
    for (const s of (data?.scenes || [])) map[s.number] = s.url
    sceneRefMap.value = map
  } catch {
    masterUrl.value = null
    thumbnailUrl.value = null
    sceneRefMap.value = {}
  }
}

// ── File picker plumbing ────────────────────────────────────────────────
const fileInputEl = ref<HTMLInputElement | null>(null)
type PickTarget = { kind: 'master' } | { kind: 'thumbnail' } | { kind: 'scene'; number: number }
let pendingTarget: PickTarget | null = null

function pickMaster(): void {
  pendingTarget = { kind: 'master' }
  fileInputEl.value?.click()
}
function pickThumbnail(): void {
  pendingTarget = { kind: 'thumbnail' }
  fileInputEl.value?.click()
}
function pickScene(n: number): void {
  pendingTarget = { kind: 'scene', number: n }
  fileInputEl.value?.click()
}

async function onFilePicked(ev: Event): Promise<void> {
  const target = pendingTarget
  pendingTarget = null
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  // Reset the input so picking the SAME file twice in a row still fires @change.
  input.value = ''
  if (!file || !target) return
  try {
    const data_base64 = await fileToBase64(file)
    if (target.kind === 'master') {
      masterUploading.value = true
      try {
        const r = await post<{ url: string }>(
          `/projects/${props.projectSlug}/episodes/${props.episodeId}/img2img-references/master`,
          { filename: file.name, data_base64, title: props.title || '' },
        )
        masterUrl.value = r.url
        success('Master reference uploaded')
      } finally { masterUploading.value = false }
    } else if (target.kind === 'thumbnail') {
      thumbnailUploading.value = true
      try {
        const r = await post<{ url: string }>(
          `/projects/${props.projectSlug}/episodes/${props.episodeId}/img2img-references/thumbnail`,
          { filename: file.name, data_base64, title: props.title || '' },
        )
        thumbnailUrl.value = r.url
        success('Reference thumbnail uploaded')
      } finally { thumbnailUploading.value = false }
    } else {
      sceneUploading.value = new Set([...sceneUploading.value, target.number])
      try {
        const r = await post<{ url: string; number: number }>(
          `/projects/${props.projectSlug}/episodes/${props.episodeId}/img2img-references/scene/${target.number}`,
          { filename: file.name, data_base64, title: props.title || '' },
        )
        sceneRefMap.value = { ...sceneRefMap.value, [r.number]: r.url }
        success(`Scene ${target.number} reference uploaded`)
      } finally {
        const next = new Set(sceneUploading.value)
        next.delete(target.number)
        sceneUploading.value = next
      }
    }
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Upload failed')
  }
}

async function removeThumbnail(): Promise<void> {
  thumbnailUploading.value = true
  try {
    const titleParam = props.title ? `?title=${encodeURIComponent(props.title)}` : ''
    await del(`/projects/${props.projectSlug}/episodes/${props.episodeId}/img2img-references/thumbnail${titleParam}`)
    thumbnailUrl.value = null
    success('Reference thumbnail removed')
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to remove reference thumbnail')
  } finally { thumbnailUploading.value = false }
}

async function removeMaster(): Promise<void> {
  if (!confirm('Remove master reference image?')) return
  masterUploading.value = true
  try {
    const titleParam = props.title ? `?title=${encodeURIComponent(props.title)}` : ''
    await del(`/projects/${props.projectSlug}/episodes/${props.episodeId}/img2img-references/master${titleParam}`)
    masterUrl.value = null
    success('Master reference removed')
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to remove master reference')
  } finally { masterUploading.value = false }
}

async function removeScene(n: number): Promise<void> {
  sceneUploading.value = new Set([...sceneUploading.value, n])
  try {
    const titleParam = props.title ? `?title=${encodeURIComponent(props.title)}` : ''
    await del(`/projects/${props.projectSlug}/episodes/${props.episodeId}/img2img-references/scene/${n}${titleParam}`)
    const next = { ...sceneRefMap.value }
    delete next[n]
    sceneRefMap.value = next
    success(`Scene ${n} reference removed`)
  } catch (e: any) {
    showError(e?.data?.detail || `Failed to remove scene ${n} reference`)
  } finally {
    const next = new Set(sceneUploading.value)
    next.delete(n)
    sceneUploading.value = next
  }
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      if (typeof result !== 'string') return reject(new Error('Bad FileReader result'))
      const i = result.indexOf(',')
      resolve(i >= 0 ? result.slice(i + 1) : result)
    }
    reader.onerror = () => reject(reader.error || new Error('Read failed'))
    reader.readAsDataURL(file)
  })
}

// Reload when the episode changes — refs and scene list both belong to
// the picked episode.
watch(() => [props.episodeId, props.title], () => {
  if (props.episodeId) {
    void loadRefs()
    void loadScenes()
  } else {
    masterUrl.value = null
    thumbnailUrl.value = null
    sceneRefMap.value = {}
    scenes.value = []
  }
}, { immediate: true })
</script>

<style scoped>
.i2i { padding: 12px 14px; }
.i2i-head {
  display: flex; align-items: baseline; justify-content: space-between;
  gap: 8px; flex-wrap: wrap; margin-bottom: 10px;
}
.i2i-title {
  margin: 0;
  font-size: 14px; font-weight: 600;
  color: var(--text-primary);
}

.i2i-section {
  border-top: 1px solid var(--border);
  padding: 10px 0;
}
.i2i-section:first-of-type { border-top: none; padding-top: 0; }
.i2i-toggle {
  display: flex; align-items: center; gap: 8px;
  cursor: pointer;
  font-size: 13px; color: var(--text-primary);
}
.i2i-toggle-label { line-height: 1.4; }
.i2i-section-body { margin-top: 8px; padding-left: 24px; }
.i2i-hint { margin: 0; }

.i2i-dropzone {
  display: flex; align-items: center; gap: 12px;
  flex-wrap: wrap;
}
.i2i-dropzone-controls { display: flex; align-items: center; gap: 8px; }

.i2i-thumb {
  width: 120px; height: 120px;
  object-fit: cover;
  border-radius: var(--radius-md);
  border: 1px solid var(--border);
}
.i2i-thumb-sm {
  width: 48px; height: 48px;
  object-fit: cover;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
}

.i2i-scene-list {
  list-style: none; margin: 0; padding: 0;
  display: flex; flex-direction: column; gap: 6px;
}
.i2i-scene-row {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 8px;
  background: var(--bg-tertiary);
  border-radius: var(--radius-sm);
}
.i2i-scene-num {
  font-family: var(--font-mono, monospace);
  font-size: var(--font-xs); color: var(--text-muted); font-weight: 600;
  min-width: 24px;
}
.i2i-scene-title {
  flex: 1 1 auto; min-width: 0;
  font-size: 12px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

.i2i-file-input { display: none; }
</style>
