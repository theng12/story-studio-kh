<template>
 <div class="scene-import workspace-page">
 <WorkspaceHero
 eyebrow="External import"
 title="Scene Import"
 description="Import clips and images generated outside Story Studio (Google Flow, Veo, etc.). Match files to scenes, convert once, keep originals."
 >
 <template #aside>
 <div class="import-hero-route" aria-label="Import workflow">
 <span class="is-complete">1</span><b>Plan</b><i />
 <span class="is-current">2</span><b>Import</b><i />
 <span>3</span><b>Motion</b>
 </div>
 </template>
 </WorkspaceHero>

 <div class="import-command-bar workspace-command-surface">
 <TopActionBar
 :project-slug="slug"
 v-model:episode-id="episodeId"
 filter-field="scene_review"
 generate-label="Load Hand-off Data"
 :generate-loading="loading"
 :generate-disabled="!canLoad"
 :generate-status="loadStatus"
 @generate="loadHandoff"
 />
 </div>

 <WorkspaceSection
 v-if="handoff"
 eyebrow="Scenes needing assets"
 title="Import checklist"
 description="Copy each prompt into your external tool, save with the suggested filename, then drop the files here."
 class="import-checklist"
 >
 <div class="import-preset-selector">
 <label>Clip preset:
 <select v-model="selectedPreset" class="select" @change="loadHandoff">
 <option value="flow">Google Flow (8s)</option>
 <option value="flow_extended">Google Flow Extended (8/16/24s)</option>
 <option value="veo">Veo (8s)</option>
 </select>
 </label>
 </div>

 <div v-if="handoff.scenes_needing_clips.length" class="import-clips-section">
 <h3>Clips needed: {{ handoff.scenes_needing_clips.length }}</h3>
 <div class="import-asset-list">
 <div
 v-for="clip in handoff.scenes_needing_clips"
 :key="clip.scene_id"
 class="import-asset-row"
 :class="{ 'import-warning': clip.exceeds_max }"
 >
 <div class="import-asset-meta">
 <span class="import-scene-index">Scene {{ clip.scene_index }}</span>
 <span class="import-duration">{{ clip.duration_seconds }}s</span>
 <span v-if="clip.exceeds_max" class="import-warn">⚠ exceeds max {{ clip.clip_seconds }}s</span>
 </div>
 <div class="import-asset-prompt">
 <label>Motion prompt (copy):</label>
 <textarea
 :value="clip.motion_prompt"
 readonly
 class="import-prompt-text"
 rows="2"
 @click="selectOnFocus"
 ></textarea>
 <button class="btn btn-sm btn-ghost" @click="copyToClipboard(clip.motion_prompt)">Copy</button>
 </div>
 <div class="import-asset-filename">
 <label>Save as:</label>
 <code class="import-filename">{{ clip.suggested_filename }}</code>
 <button class="btn btn-sm btn-ghost" @click="copyToClipboard(clip.suggested_filename)">Copy</button>
 </div>
 </div>
 </div>
 </div>

 <div v-if="handoff.scenes_needing_images.length" class="import-images-section">
 <h3>Images needed: {{ handoff.scenes_needing_images.length }}</h3>
 <div class="import-asset-list">
 <div
 v-for="img in handoff.scenes_needing_images"
 :key="img.scene_id"
 class="import-asset-row"
 >
 <div class="import-asset-meta">
 <span class="import-scene-index">Scene {{ img.scene_index }}</span>
 </div>
 <div class="import-asset-prompt">
 <label>Visual prompt (copy):</label>
 <textarea
 :value="img.visual_prompt"
 readonly
 class="import-prompt-text"
 rows="2"
 @click="selectOnFocus"
 ></textarea>
 <button class="btn btn-sm btn-ghost" @click="copyToClipboard(img.visual_prompt)">Copy</button>
 </div>
 <div class="import-asset-filename">
 <label>Save as:</label>
 <code class="import-filename">{{ img.suggested_filename }}</code>
 <button class="btn btn-sm btn-ghost" @click="copyToClipboard(img.suggested_filename)">Copy</button>
 </div>
 </div>
 </div>
 </div>
 </WorkspaceSection>

 <WorkspaceSection
 v-if="episodeId"
 eyebrow="File import"
 title="Drop zone"
 description="Drop files here or click to select. Files are matched to scenes by name (scene ID or scene index) or by order."
 class="import-drop-zone"
 >
 <div
 class="drop-zone-area"
 :class="{ 'drop-zone-active': dragOver }"
 @dragover.prevent="dragOver = true"
 @dragleave="dragOver = false"
 @drop.prevent="handleDrop"
 @click="triggerFileInput"
 >
 <p v-if="!selectedFiles.length">Drop files here or click to select</p>
 <p v-else>{{ selectedFiles.length }} file(s) selected</p>
 <input
 ref="fileInput"
 type="file"
 multiple
 accept="video/*,image/*,.mp4,.mov,.webm,.mkv,.jpg,.jpeg,.png,.webp"
 class="sr-only"
 @change="handleFileSelect"
 />
 </div>

 <div v-if="matchResult" class="match-results">
 <h4>Match results:</h4>
 <div v-if="matchResult.matched.length" class="match-section">
 <h5>Matched: {{ matchResult.matched.length }}</h5>
 <ul>
 <li v-for="m in matchResult.matched" :key="m.scene_id">
 {{ m.file.name }} → Scene {{ m.scene_index }} ({{ m.scene_id }})
 </li>
 </ul>
 </div>
 <div v-if="matchResult.unmatched.length" class="match-section match-warning">
 <h5>Unmatched: {{ matchResult.unmatched.length }}</h5>
 <ul>
 <li v-for="u in matchResult.unmatched" :key="u.name">{{ u.name }}</li>
 </ul>
 </div>
 <div v-if="matchResult.ambiguous.length" class="match-section match-warning">
 <h5>Ambiguous: {{ matchResult.ambiguous.length }}</h5>
 <ul>
 <li v-for="a in matchResult.ambiguous" :key="a.file.name">
 {{ a.file.name }} could match:
 <span v-for="c in a.candidates" :key="c.id" class="candidate">
 Scene {{ c.scene_index }} ({{ c.id }})
 </span>
 </li>
 </ul>
 </div>
 <button
 v-if="matchResult.matched.length"
 class="btn btn-primary"
 :disabled="importing"
 @click="confirmImport"
 >
 {{ importing ? 'Importing...' : `Import ${matchResult.matched.length} file(s)` }}
 </button>
 </div>
 </WorkspaceSection>

 <WorkspaceNotice v-if="importSuccess" tone="success" title="Import complete">
 {{ importSuccess }}
 <template #actions>
 <NuxtLink :to="`/projects/${slug}/motion-review?episode_id=${encodeURIComponent(episodeId)}`" class="btn btn-sm btn-secondary">
 Open Motion Review
 </NuxtLink>
 </template>
 </WorkspaceNotice>
 </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import WorkspaceHero from '~/components/WorkspaceHero.vue'
import WorkspaceSection from '~/components/WorkspaceSection.vue'
import WorkspaceNotice from '~/components/WorkspaceNotice.vue'
import TopActionBar from '~/components/TopActionBar.vue'

const route = useRoute()
const { success: showSuccess, error: showError } = useToast()
const slug = computed(() => route.params.slug as string)
const episodeId = ref(route.query.episode_id as string || '')

const loading = ref(false)
const loadStatus = ref('')
const handoff = ref<any>(null)
const selectedPreset = ref('flow')
const dragOver = ref(false)
const selectedFiles = ref<File[]>([])
const matchResult = ref<any>(null)
const importing = ref(false)
const importSuccess = ref('')
const fileInput = ref<HTMLInputElement | null>(null)

const canLoad = computed(() => !!episodeId.value)

async function loadHandoff() {
 if (!episodeId.value) return
 loading.value = true
 loadStatus.value = 'Loading...'
 try {
 const response = await fetch(`/api/projects/${slug.value}/scene-review/${episodeId.value}/import-handoff?preset=${selectedPreset.value}`)
 if (!response.ok) {
 const detail = await response.json().catch(() => ({}))
 throw new Error(detail.detail || `Failed to load hand-off data (${response.status})`)
 }
 handoff.value = await response.json()
 loadStatus.value = `Loaded ${handoff.value.scenes_needing_clips.length} clips, ${handoff.value.scenes_needing_images.length} images`
 } catch (error: any) {
 loadStatus.value = error.message || 'Failed to load'
 showError(error.message)
 } finally {
 loading.value = false
 }
}

/** Select the whole prompt on click so one Copy gets all of it. */
function selectOnFocus(event: MouseEvent) {
 const target = event.currentTarget as HTMLTextAreaElement | null
 target?.select?.()
}

function copyToClipboard(text: string) {
 navigator.clipboard.writeText(text).then(() => {
 showSuccess('Copied to clipboard')
 }).catch(() => {
 showError('Failed to copy')
 })
}

function triggerFileInput() {
 fileInput.value?.click()
}

function handleFileSelect(event: Event) {
 const input = event.target as HTMLInputElement
 if (input.files) {
 selectedFiles.value = Array.from(input.files)
 matchFiles()
 }
}

function handleDrop(event: DragEvent) {
 dragOver.value = false
 if (event.dataTransfer?.files) {
 selectedFiles.value = Array.from(event.dataTransfer.files)
 matchFiles()
 }
}

async function matchFiles() {
 if (!selectedFiles.value.length || !episodeId.value) return
 loading.value = true
 try {
 const files = selectedFiles.value.map(f => ({ name: f.name }))
 const response = await fetch(`/api/projects/${slug.value}/scene-review/${episodeId.value}/match-import-files`, {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({ files })
 })
 if (!response.ok) {
 const detail = await response.json().catch(() => ({}))
 throw new Error(detail.detail || `Failed to match files (${response.status})`)
 }
 matchResult.value = await response.json()
 } catch (error: any) {
 showError(error.message)
 } finally {
 loading.value = false
 }
}

async function confirmImport() {
 if (!matchResult.value?.matched.length) return
 importing.value = true
 try {
 const results = []
 for (const match of matchResult.value.matched) {
 const file = selectedFiles.value.find(f => f.name === match.file.name)
 if (!file) continue

 const isVideo = file.type.startsWith('video/') || /\.(mp4|mov|webm|mkv|avi)$/i.test(file.name)
 const endpoint = isVideo ? 'upload-clip' : 'upload-image'
 const url = `/api/projects/${slug.value}/scene-review/${episodeId.value}/${endpoint}/${match.scene_id}`

 const response = await fetch(url, {
 method: 'POST',
 headers: {
 'Content-Type': file.type || 'application/octet-stream',
 'X-File-Name': encodeURIComponent(file.name)
 },
 body: file
 })

 if (!response.ok) {
 const detail = await response.json().catch(() => ({}))
 throw new Error(`Failed to import ${file.name}: ${detail.detail || response.status}`)
 }
 results.push(await response.json())
 }

 importSuccess.value = `Imported ${results.length} file(s) successfully`
 selectedFiles.value = []
 matchResult.value = null
 if (fileInput.value) fileInput.value.value = ''

 // Reload handoff to show updated status
 await loadHandoff()
 } catch (error: any) {
 showError(error.message)
 } finally {
 importing.value = false
 }
}





onMounted(() => {
 if (episodeId.value) {
 loadHandoff()
 }
})
</script>

<style scoped>
.scene-import {
 max-width: 1200px;
 margin: 0 auto;
 padding: 2rem;
}

.import-hero-route {
 display: flex;
 align-items: center;
 gap: 0.5rem;
 font-size: 0.875rem;
}

.import-hero-route span {
 width: 24px;
 height: 24px;
 border-radius: 50%;
 background: var(--color-surface-alt);
 display: flex;
 align-items: center;
 justify-content: center;
 font-weight: 600;
}

.import-hero-route span.is-complete {
 background: var(--color-success);
 color: white;
}

.import-hero-route span.is-current {
 background: var(--color-primary);
 color: white;
}

.import-hero-route b {
 font-weight: 600;
}

.import-hero-route i {
 width: 24px;
 height: 1px;
 background: var(--color-border);
}

.import-preset-selector {
 margin-bottom: 1.5rem;
}

.import-preset-selector label {
 display: flex;
 align-items: center;
 gap: 0.5rem;
 font-weight: 600;
}

.import-asset-list {
 display: flex;
 flex-direction: column;
 gap: 1rem;
}

.import-asset-row {
 padding: 1rem;
 border: 1px solid var(--color-border);
 border-radius: 8px;
 background: var(--color-surface);
}

.import-asset-row.import-warning {
 border-color: var(--color-warning);
 background: var(--color-warning-bg, rgba(255, 165, 0, 0.05));
}

.import-asset-meta {
 display: flex;
 gap: 1rem;
 margin-bottom: 0.75rem;
 font-weight: 600;
}

.import-scene-index {
 color: var(--color-primary);
}

.import-duration {
 color: var(--color-text-secondary);
}

.import-warn {
 color: var(--color-warning);
 font-weight: 700;
}

.import-asset-prompt,
.import-asset-filename {
 margin-bottom: 0.75rem;
}

.import-asset-prompt label,
.import-asset-filename label {
 display: block;
 font-size: 0.875rem;
 font-weight: 600;
 margin-bottom: 0.25rem;
 color: var(--color-text-secondary);
}

.import-prompt-text {
 width: 100%;
 font-family: monospace;
 font-size: 0.875rem;
 padding: 0.5rem;
 border: 1px solid var(--color-border);
 border-radius: 4px;
 background: var(--color-surface-alt);
 resize: vertical;
 margin-bottom: 0.5rem;
}

.import-filename {
 display: inline-block;
 padding: 0.25rem 0.5rem;
 background: var(--color-surface-alt);
 border-radius: 4px;
 font-family: monospace;
 font-size: 0.875rem;
 margin-right: 0.5rem;
}

.drop-zone-area {
 border: 2px dashed var(--color-border);
 border-radius: 8px;
 padding: 3rem;
 text-align: center;
 cursor: pointer;
 transition: all 0.2s;
}

.drop-zone-area:hover,
.drop-zone-area.drop-zone-active {
 border-color: var(--color-primary);
 background: var(--color-primary-bg, rgba(0, 123, 255, 0.05));
}

.drop-zone-area p {
 margin: 0;
 color: var(--color-text-secondary);
}

.sr-only {
 position: absolute;
 width: 1px;
 height: 1px;
 padding: 0;
 margin: -1px;
 overflow: hidden;
 clip: rect(0, 0, 0, 0);
 white-space: nowrap;
 border-width: 0;
}

.match-results {
 margin-top: 1.5rem;
}

.match-results h4 {
 margin-bottom: 1rem;
}

.match-section {
 margin-bottom: 1rem;
 padding: 1rem;
 border-radius: 8px;
 background: var(--color-surface);
}

.match-section h5 {
 margin-bottom: 0.5rem;
 font-size: 0.875rem;
 font-weight: 700;
}

.match-section ul {
 margin: 0;
 padding-left: 1.5rem;
}

.match-section li {
 margin-bottom: 0.25rem;
 font-size: 0.875rem;
}

.match-warning {
 border-left: 3px solid var(--color-warning);
}

.candidate {
 display: inline-block;
 margin-right: 0.5rem;
 padding: 0.125rem 0.5rem;
 background: var(--color-surface-alt);
 border-radius: 4px;
 font-size: 0.75rem;
}

.btn {
 padding: 0.5rem 1rem;
 border-radius: 6px;
 font-weight: 600;
 cursor: pointer;
 border: none;
 transition: all 0.2s;
}

.btn-sm {
 padding: 0.25rem 0.75rem;
 font-size: 0.875rem;
}

.btn-primary {
 background: var(--color-primary);
 color: white;
}

.btn-primary:hover:not(:disabled) {
 background: var(--color-primary-dark);
}

.btn-primary:disabled {
 opacity: 0.5;
 cursor: not-allowed;
}

.btn-secondary {
 background: var(--color-surface-alt);
 color: var(--color-text);
 border: 1px solid var(--color-border);
}

.btn-secondary:hover {
 background: var(--color-border);
}

.btn-ghost {
 background: transparent;
 color: var(--color-text-secondary);
}

.btn-ghost:hover {
 background: var(--color-surface-alt);
 color: var(--color-text);
}

.select {
 padding: 0.5rem;
 border: 1px solid var(--color-border);
 border-radius: 6px;
 background: var(--color-surface);
 font-size: 0.875rem;
}
</style>