<template>
  <section id="free-up-space" class="media-cleanup" aria-labelledby="media-cleanup-heading">
    <div class="cleanup-heading">
      <div><h3 id="media-cleanup-heading">Free up space</h3><p>For episodes already uploaded to YouTube: scene images are shrunk to smaller JPEGs, and motion clips, chapter narration and the final video move to this project’s own <code>_trash</code> folder. You do not choose a folder. Nothing is deleted — you empty <code>_trash</code> yourself, and space is freed then. Thumbnails, merged narration, subtitles, scripts and prompts stay. Episodes without a verified upload are never touched.</p></div>
      <button class="btn btn-secondary" :disabled="busy || loading" @click="loadEpisodes">{{ loading ? 'Checking uploads…' : episodes === null ? 'Find uploaded episodes' : 'Refresh uploads' }}</button>
    </div>
    <p v-if="error" class="cleanup-error" role="alert">{{ error }} <button v-if="operation" class="btn btn-sm" :disabled="polling" @click="pollOperation">Check progress again</button></p>
    <ul v-if="listWarnings.length" class="cleanup-warnings"><li v-for="warning in listWarnings" :key="warning">{{ warning }}</li></ul>
    <template v-if="episodes !== null">
      <p v-if="!episodes.length">No episodes have a verified ready upload for this project’s current YouTube channel. Upload or reconcile the episode first.</p>
      <template v-else>
        <div class="cleanup-selection"><strong>{{ selected.length }} {{ selected.length === 1 ? 'episode' : 'episodes' }} selected</strong><button class="btn btn-sm" :disabled="busy" @click="selected = episodes.map(ep => ep.episode_code)">Select all uploaded</button><button class="btn btn-sm" :disabled="busy || !notArchived.length" @click="selected = notArchived">Select all uploaded and not yet freed</button><button class="btn btn-sm" :disabled="busy || !selected.length" @click="selected = []">Clear selection</button></div>
        <div class="cleanup-episodes">
          <label v-for="ep in episodes" :key="ep.episode_code" class="cleanup-episode">
            <input v-model="selected" type="checkbox" :value="ep.episode_code" :disabled="busy" />
            <span><strong>{{ ep.episode_code }}</strong> {{ ep.title }}<small>{{ localStatus(ep.local_media_status?.state) }}</small></span>
            <a :href="`https://www.youtube.com/watch?v=${encodeURIComponent(ep.video_id)}`" target="_blank" rel="noopener noreferrer">View upload</a>
          </label>
        </div>
        <div class="cleanup-preset"><button class="btn btn-primary" :disabled="busy || !selected.length" @click="startPreview(true)">Free up space for {{ selected.length }} selected</button><p class="cleanup-hint">You will see how much space it frees and where the files go before anything changes.</p></div>
        <details class="cleanup-advanced disclosure">
          <summary>Advanced: pick exactly which media to review</summary>
          <fieldset :disabled="busy" class="cleanup-categories"><legend>Media to review</legend><label v-for="item in categoryOptions" :key="item.id"><input v-model="categories" type="checkbox" :value="item.id" />{{ item.label }}</label></fieldset>
          <p class="cleanup-hint">Active jobs and shared assets are excluded. You will review exact files before anything changes. Restoring removed media may require paid generation.</p>
          <button class="btn btn-secondary" :disabled="busy || !selected.length || !categories.length" @click="startPreview()">Review selected files</button>
        </details>
      </template>
    </template>
    <div v-if="operation" class="cleanup-progress" role="status" aria-live="polite">
      <strong>{{ operationLabel }}</strong>
      <span v-if="operation.total">{{ operation.done }} / {{ operation.total }} {{ operation.kind === 'preview' ? 'episodes' : 'files' }}</span>
      <progress v-if="busy && operation.total" :value="operation.done" :max="operation.total" aria-label="Storage operation progress" />
      <p v-if="operation.current" class="cleanup-path">{{ operation.current }}</p>
      <p v-if="busy">You can leave this page; work continues while Story Studio is open. Stop finishes the current file safely.</p>
      <button v-if="busy && operation.status !== 'stopping'" class="btn btn-secondary" :disabled="stopping" @click="stopOperation">{{ stopping ? 'Stopping…' : 'Stop' }}</button>
      <p v-if="operation.error" class="cleanup-error">{{ operation.error }}</p>
      <template v-if="operation.result">
        <p>{{ resultSummary }}</p>
        <details v-if="operation.result.items?.length" class="disclosure"><summary>View file outcomes</summary><ul class="cleanup-files"><li v-for="(item, index) in operation.result.items" :key="index"><span class="cleanup-path">{{ item.path || item.source_path || item.file }}</span> — {{ item.outcome || item.status }}<span v-if="item.reason">: {{ item.reason }}</span></li></ul></details>
      </template>
    </div>
    <div v-if="preview" class="cleanup-review">
      <h4>Review {{ preview.files.length }} files · {{ formatBytes(preview.total_bytes) }}</h4>
      <p>Only this reviewed selection can be changed. Files are checked again before each action.</p>
      <ul v-if="previewWarnings.length" class="cleanup-warnings"><li v-for="warning in previewWarnings" :key="warning">{{ warning }}</li></ul>
      <details v-for="ep in preview.episodes" :key="ep.episode_code" class="cleanup-file-group disclosure">
        <summary>{{ ep.episode_code }} · {{ ep.files.length }} files · {{ formatBytes(ep.files.reduce((n, f) => n + f.bytes, 0)) }}</summary>
        <ul v-if="ep.excluded?.length" class="cleanup-warnings"><li v-for="item in ep.excluded" :key="item.path"><span class="cleanup-path">{{ item.path }}</span> — {{ item.reason }}</li></ul>
        <ul class="cleanup-files"><li v-for="file in ep.files" :key="file.path"><span class="cleanup-path">{{ file.relative_path }}</span><span>{{ formatBytes(file.bytes) }}</span></li></ul>
      </details>
      <p v-if="preview.estimate && preview.preset" class="cleanup-estimate"><strong>Frees about {{ formatBytes(freedBytes) }}</strong> once you empty _trash. {{ estimateText }}</p>
      <div class="cleanup-actions">
        <p v-if="preview.preset"><strong>Free up space:</strong> images are shrunk in place, everything else listed moves to <code class="cleanup-path">{{ trashText }}</code>.</p>
        <fieldset v-else :disabled="busy"><legend>What should happen to these files?</legend><label><input v-model="mode" type="radio" value="remove" /> Move local files to _trash (default)</label><label><input v-model="mode" type="radio" value="archive" /> Advanced: copy to another folder, then remove</label></fieldset>
        <div v-if="!preview.preset && mode === 'archive'" class="cleanup-destination"><label for="cleanup-destination">Archive folder</label><input id="cleanup-destination" v-model="destination" class="input" :disabled="busy || picking" placeholder="Choose a folder on your external drive" /><button class="btn btn-secondary" :disabled="busy || picking" @click="browse">{{ picking ? 'Opening…' : 'Browse' }}</button></div>
        <p>{{ preview.preset ? 'Originals go to the _trash folder on the same drive. Space is freed when you empty _trash; until then you can put anything back.' : mode === 'archive' ? 'Each copy is verified before its original is removed. Choose another drive to free space on this drive.' : `Removed files move to ${trashText} on the same drive. Nothing is deleted; space is freed when you empty _trash.` }}</p>
        <div class="cleanup-action-buttons"><button class="btn btn-secondary" :disabled="busy" @click="dismissReview">Dismiss review</button><button class="btn btn-primary" :disabled="busy || picking || !preview.files.length || (!preview.preset && mode === 'archive' && !destination.trim())" @click="runCleanup">{{ submitting ? 'Starting…' : preview.preset ? 'Free up space' : mode === 'archive' ? 'Archive reviewed files' : 'Move reviewed files to _trash' }}</button></div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useApi } from '~/composables/useApi'
import { useConfirm } from '~/composables/useConfirm'
import { pickFolder } from '~/composables/usePathPicker'

type Category = 'images' | 'chapter_audio' | 'merged_audio' | 'motion_clips' | 'final_video'
interface CleanupEpisode { episode_code: string; title: string; video_id: string; local_media_status?: { state: string; preset_archived_at?: string | null } }
interface ReviewedFile { path: string; relative_path: string; bytes: number; category: Category }
interface Estimate { compress_files: number; compress_bytes_before: number; compress_bytes_after: number; already_jpeg_files: number; trash_files: number; trash_bytes: number }
interface Preview { preview_id: string; project_slug: string; total_bytes: number; preset?: 'archive_episode'; trash_roots?: string[]; estimate?: Estimate; files: ReviewedFile[]; blocked_reasons: string[]; episodes: { episode_code: string; files: ReviewedFile[]; excluded?: { path: string; reason: string }[]; blocked_reasons: string[] }[] }
interface Operation { id: string; project_slug: string; kind: 'preview' | 'run'; status: string; stage: string | null; done: number; total: number; current: string; error?: string; preview?: Preview; result?: { items?: Array<{ path?: string; source_path?: string; file?: string; status?: string; outcome?: string; reason?: string }>; bytes_reclaimed?: number; bytes_freed?: number; bytes_moved?: number; bytes_trashed?: number; bytes_after?: number } }
const props = defineProps<{ slug: string }>()
const { get, post } = useApi()
const { ask } = useConfirm()
const episodes = ref<CleanupEpisode[] | null>(null)
const selected = ref<string[]>([])
const categories = ref<Category[]>([])
const listWarnings = ref<string[]>([])
const error = ref('')
const loading = ref(false)
const submitting = ref(false)
const stopping = ref(false)
const picking = ref(false)
const polling = ref(false)
const preview = ref<Preview | null>(null)
const operation = ref<Operation | null>(null)
const mode = ref<'archive' | 'remove'>('remove')
const destination = ref('')
let generation = 0
let disposed = false
let timer: ReturnType<typeof setTimeout> | undefined
const categoryOptions: { id: Category; label: string }[] = [
  { id: 'images', label: 'Scene images (thumbnails are never touched)' }, { id: 'chapter_audio', label: 'Chapter audio' },
  { id: 'merged_audio', label: 'Merged audio' }, { id: 'motion_clips', label: 'Motion clips' }, { id: 'final_video', label: 'Final video' },
]
const notArchived = computed(() => (episodes.value || []).filter(ep => !ep.local_media_status?.preset_archived_at).map(ep => ep.episode_code))
const trashText = computed(() => preview.value?.trash_roots?.length ? preview.value.trash_roots.join(' and ') : 'the project’s _trash folder')
const freedBytes = computed(() => { const e = preview.value?.estimate; return e ? e.trash_bytes + e.compress_bytes_before - e.compress_bytes_after : 0 })
const estimateText = computed(() => {
  const e = preview.value?.estimate
  if (!e) return ''
  const moved = e.trash_bytes
  return `${e.compress_files} ${e.compress_files === 1 ? 'image' : 'images'} ${formatBytes(e.compress_bytes_before)} → ~${formatBytes(e.compress_bytes_after)}${e.already_jpeg_files ? ` (${e.already_jpeg_files} already JPEG)` : ''}; ${formatBytes(moved + e.compress_bytes_before)} moved to _trash — space is freed when you empty _trash.`
})
const busy = computed(() => submitting.value || !!operation.value && ['queued', 'running', 'stopping'].includes(operation.value.status))
const previewWarnings = computed(() => [...new Set([...(preview.value?.blocked_reasons || []), ...(preview.value?.episodes.flatMap(ep => ep.blocked_reasons.map(reason => `${ep.episode_code}: ${reason}`)) || [])])])
const operationLabel = computed(() => {
  const op = operation.value
  if (!op) return ''
  if (op.status === 'completed') return op.kind === 'preview' ? 'File review ready' : 'Storage operation complete'
  if (op.status === 'stopped') return op.kind === 'preview' ? 'Scan stopped — no files changed. Start a new review when ready.' : 'Stopped — review the file outcomes below'
  if (op.status === 'failed') return 'Storage operation could not finish'
  if (op.status === 'stopping') return 'Stopping after the current file…'
  return op.stage === 'compressing' ? 'Shrinking images and moving media to _trash…' : op.stage === 'archiving' ? 'Archiving verified files…' : op.stage === 'removing' ? 'Removing reviewed files…' : 'Checking files and upload evidence…'
})
const resultSummary = computed(() => {
  const result = operation.value?.result
  const items = result?.items || []
  const pending = items.filter(item => (item.outcome || item.status) === 'pending').length
  const changed = items.filter(item => ['removed', 'archived', 'compressed'].includes(item.outcome || item.status || '')).length
  const trashed = result?.bytes_trashed ? ` ${formatBytes(result.bytes_trashed)} moved to _trash${result.bytes_after ? ` (${formatBytes(result.bytes_after)} of it replaced by smaller JPEGs)` : ''} — space is freed when you empty _trash.` : ''
  return `${changed} files changed; ${items.length - changed - pending} skipped or could not finish.${pending ? ` ${pending} need review after interruption.` : ''} ${formatBytes(result?.bytes_reclaimed ?? result?.bytes_freed ?? 0)} reclaimed on the source drive.${result?.bytes_moved ? ` ${formatBytes(result.bytes_moved)} archived.` : ''}${trashed}`
})
function formatBytes(bytes: number) { return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB` }
function localStatus(state?: string) { return state === 'archived' ? 'Uploaded · space freed' : state === 'removed' ? 'Uploaded · local sources removed' : state === 'partially_removed' ? 'Uploaded · some local media removed' : 'Uploaded' }
function message(e: any) { return e?.data?.detail || e?.message || 'Storage request failed. Check again.' }
function current(version: number) { return !disposed && version === generation }
function remember(slug: string, id: string) { try { localStorage.setItem(`media-cleanup:${slug}`, id) } catch { /* Operation continues if browser storage is unavailable. */ } }
function forget(slug: string) { try { localStorage.removeItem(`media-cleanup:${slug}`) } catch { /* Nothing to persist. */ } }
async function loadEpisodes() {
  if (loading.value || busy.value) return
  const version = generation, slug = props.slug
  loading.value = true; error.value = ''
  try {
    const result = await get<{ episodes: CleanupEpisode[]; blocked_reasons: string[] }>(`/projects/${slug}/media-cleanup/episodes`)
    if (!current(version)) return
    episodes.value = result.episodes; listWarnings.value = result.blocked_reasons || []
    selected.value = selected.value.filter(code => result.episodes.some(ep => ep.episode_code === code))
    if (!selected.value.length) selected.value = result.episodes.filter(ep => !ep.local_media_status?.preset_archived_at).map(ep => ep.episode_code)
  } catch (e) { if (current(version)) error.value = message(e) }
  finally { if (current(version)) loading.value = false }
}
async function pollOperation() {
  if (polling.value || !operation.value) return
  if (timer) clearTimeout(timer)
  const version = generation, slug = props.slug, id = operation.value.id
  polling.value = true
  try {
    const result = await get<Operation>(`/projects/${slug}/media-cleanup/operations/${id}`)
    if (!current(version) || operation.value?.id !== id) return
    operation.value = result; error.value = ''
    if (result.status === 'completed' && result.preview) preview.value = result.preview
    if (['queued', 'running', 'stopping'].includes(result.status)) timer = setTimeout(() => void pollOperation(), 1000)
  } catch (e: any) {
    if (current(version)) {
      error.value = message(e)
      if (e?.statusCode === 404 || e?.status === 404) {
        forget(slug); operation.value = null
        error.value = 'This operation is no longer running, possibly after an app restart. Refresh uploads and review the files again; completed cleanup records are retained.'
      } else {
        // One missed read (the engine busy for a moment) used to freeze the progress and leave
        // every button disabled. Keep following the operation; it carries on regardless.
        error.value = `${message(e)} Checking again…`
        timer = setTimeout(() => void pollOperation(), 3000)
      }
    }
  } finally { if (current(version)) polling.value = false }
}
async function startPreview(preset = false) {
  if (busy.value || !selected.value.length || (!preset && !categories.value.length)) return
  const version = generation, slug = props.slug
  submitting.value = true; error.value = ''; preview.value = null
  try {
    const result = await post<{ operation_id: string }>(`/projects/${slug}/media-cleanup/preview`, preset ? { episode_codes: [...selected.value], preset: 'archive_episode' } : { episode_codes: [...selected.value], categories: [...categories.value] })
    remember(slug, result.operation_id)
    if (!current(version)) return
    operation.value = { id: result.operation_id, project_slug: slug, kind: 'preview', status: 'queued', stage: 'checking', done: 0, total: 0, current: '' }
    void pollOperation()
  } catch (e) { if (current(version)) error.value = message(e) }
  finally { if (current(version)) submitting.value = false }
}
async function runCleanup() {
  const reviewed0 = preview.value
  const chosen0 = reviewed0?.preset ? 'compress' : mode.value
  if (busy.value || picking.value || !reviewed0?.files.length || (chosen0 === 'archive' && !destination.value.trim())) return
  const version = generation, slug = props.slug, reviewed = reviewed0, chosenMode = chosen0, folder = destination.value.trim()
  submitting.value = true; error.value = ''
  try {
    const approved = await ask({ title: chosenMode === 'archive' ? 'Archive reviewed media?' : chosenMode === 'compress' ? 'Free up space?' : 'Move reviewed media to _trash?', message: `${reviewed.files.length} reviewed files (${formatBytes(reviewed.total_bytes)}) from ${reviewed.episodes.filter(ep => ep.files.length).length} episodes in ${slug}. ${chosenMode === 'archive' ? `Copy to ${folder}, verify, then remove the originals.` : chosenMode === 'compress' ? `This frees about ${formatBytes(freedBytes.value)}. Scene images are re-saved as smaller JPEGs under the same names; the originals, clips, chapter narration and final video move to ${trashText.value}.` : `These files move to ${trashText.value}; nothing is deleted.`} Upload records, scripts, prompts, subtitles and thumbnails stay. Restore from _trash if you need anything back; space is freed when you empty it.`, confirmLabel: chosenMode === 'archive' ? 'Archive files' : chosenMode === 'compress' ? 'Free up space' : 'Move to _trash', danger: false })
    if (!approved || !current(version)) return
    const result = await post<{ operation_id: string }>(`/projects/${slug}/media-cleanup/run`, { preview_id: reviewed.preview_id, mode: chosenMode, ...(chosenMode === 'archive' ? { destination: folder } : {}) })
    remember(slug, result.operation_id)
    if (!current(version)) return
    preview.value = null
    operation.value = { id: result.operation_id, project_slug: slug, kind: 'run', status: 'queued', stage: 'checking', done: 0, total: reviewed.files.length, current: '' }
    void pollOperation()
  } catch (e) { if (current(version)) error.value = message(e) }
  finally { if (current(version)) submitting.value = false }
}
async function stopOperation() {
  if (!operation.value || stopping.value) return
  const version = generation, slug = props.slug, id = operation.value.id
  stopping.value = true
  try { await post(`/projects/${slug}/media-cleanup/operations/${id}/stop`, {}); if (current(version)) void pollOperation() }
  catch (e) { if (current(version)) error.value = message(e) }
  finally { if (current(version)) stopping.value = false }
}
async function browse() {
  if (busy.value || picking.value) return
  const version = generation
  picking.value = true
  try { const folder = await pickFolder({ title: 'Archive episode media', button_label: 'Use this folder' }); if (folder && current(version)) destination.value = folder }
  catch (e) { if (current(version)) error.value = message(e) }
  finally { if (current(version)) picking.value = false }
}
function dismissReview() {
  preview.value = null
  if (operation.value?.kind === 'preview') { forget(props.slug); operation.value = null }
}
function restore() {
  let id: string | null = null
  try { id = localStorage.getItem(`media-cleanup:${props.slug}`) } catch { /* No saved operation. */ }
  if (id) { operation.value = { id, project_slug: props.slug, kind: 'run', status: 'queued', stage: 'checking', done: 0, total: 0, current: '' }; void pollOperation() }
}
watch([selected, categories], () => { if (!busy.value) dismissReview() }, { deep: true })
watch(() => props.slug, () => {
  generation++; if (timer) clearTimeout(timer)
  episodes.value = null; selected.value = []; categories.value = []; preview.value = null; operation.value = null; error.value = ''; listWarnings.value = []; destination.value = ''; mode.value = 'remove'
  loading.value = false; submitting.value = false; picking.value = false; polling.value = false; stopping.value = false
  void loadEpisodes().then(restore)
})
onMounted(() => { void loadEpisodes().then(restore) })
onBeforeUnmount(() => { disposed = true; generation++; if (timer) clearTimeout(timer) })
</script>

<style scoped>
.media-cleanup { padding: 20px 0; scroll-margin-top: 24px; }
.cleanup-heading { display: flex; justify-content: space-between; align-items: start; gap: 16px; }
.cleanup-heading h3 { margin: 0 0 8px; }
p { color: var(--text-secondary); line-height: 1.5; margin: 8px 0 12px; }
.cleanup-heading p { max-width: 72ch; }
.cleanup-heading > button { flex-shrink: 0; }
.cleanup-selection, .cleanup-action-buttons { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin: 16px 0; }
.cleanup-episodes, .cleanup-files { max-height: 320px; overflow: auto; }
.cleanup-episode { display: flex; gap: 12px; align-items: center; padding: 12px 4px; border-bottom: 1px solid var(--border); }
.cleanup-episode > span { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.cleanup-episode small { display: block; color: var(--text-secondary); margin-top: 4px; }
.cleanup-episode a { flex-shrink: 0; }
input[type=checkbox], input[type=radio] { width: 18px; height: 18px; flex-shrink: 0; accent-color: var(--accent); }
fieldset { border: 0; padding: 0; margin: 20px 0 12px; display: flex; gap: 16px; flex-wrap: wrap; }
legend { font-weight: 600; margin-bottom: 12px; }
fieldset label { display: inline-flex; gap: 8px; align-items: center; }
.cleanup-hint { font-size: var(--font-sm); }
.cleanup-advanced { margin-top: 16px; }
.cleanup-advanced > summary { color: var(--text-secondary); font-size: var(--font-sm); }
.cleanup-error, .cleanup-warnings { color: var(--error, #ff9696); line-height: 1.5; overflow-wrap: anywhere; }
.cleanup-progress, .cleanup-review { border-top: 1px solid var(--border); margin-top: 22px; padding-top: 18px; }
.cleanup-progress > span { margin-left: 12px; }
progress { display: block; width: 100%; margin: 12px 0; accent-color: var(--accent); }
.cleanup-path { overflow-wrap: anywhere; min-width: 0; }
.cleanup-file-group { border-bottom: 1px solid var(--border); padding: 12px 0; }
summary { cursor: pointer; }
.cleanup-files { padding: 0 0 0 20px; }
.cleanup-files li { padding: 8px 0; }
.cleanup-files li > span + span { margin-left: 12px; white-space: nowrap; }
.cleanup-actions { position: sticky; bottom: 0; background: var(--bg-secondary); padding: 12px 0; border-top: 1px solid var(--border); margin-top: 16px; z-index: 2; }
.cleanup-destination { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.cleanup-destination .input { flex: 1; min-width: 180px; }
.cleanup-action-buttons { justify-content: flex-end; margin-bottom: 0; }
:where(button, input, a, summary):focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
@media (max-width: 700px) { .cleanup-heading { flex-direction: column; } .cleanup-episode { flex-wrap: wrap; } .cleanup-episode a { margin-left: 30px; } .cleanup-actions { position: static; } .cleanup-destination { align-items: stretch; } .cleanup-destination label { flex-basis: 100%; } }
</style>
