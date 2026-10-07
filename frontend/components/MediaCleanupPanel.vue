<template>
  <section id="free-up-space" class="media-cleanup" aria-labelledby="media-cleanup-heading">
    <div class="cleanup-heading">
      <div><h3 id="media-cleanup-heading">Free up space</h3><p>Only episodes whose upload YouTube confirmed are touched — except narration parts and converting PNG scenes to JPEG, which any episode can use — and nothing is lost: files go to this project’s <code>_trash</code> folder (the space is freed when you empty it) or to a drive you choose.</p></div>
      <div class="cleanup-heading-actions">
        <button class="btn btn-secondary" :disabled="busy || loading" @click="loadEpisodes">{{ loading ? 'Checking Uploads…' : episodes === null ? 'Find Uploaded Episodes' : 'Refresh Uploads' }}</button>
        <button class="btn btn-secondary" :disabled="busy || loading || checkingYouTube" title="Asks YouTube about every upload, older ones included, so confirmed uploads can be freed" @click="checkAllUploads">{{ checkingYouTube ? 'Checking with YouTube…' : 'Check All Uploads' }}</button>
      </div>
    </div>
    <p v-if="space" class="cleanup-space">
      Free on this drive: <strong>{{ space.free_bytes === null ? 'could not be measured' : formatBytes(space.free_bytes) }}</strong>
      · Waiting in this project’s <code>_trash</code>: <strong>{{ formatBytes(space.project_trash_bytes) }}</strong>
      · In every project’s <code>_trash</code>: <strong>{{ formatBytes(space.library_trash_bytes) }}</strong>
      <small>(space comes back when you empty <code>_trash</code>)</small>
    </p>
    <p v-if="checkResult" class="cleanup-hint" role="status">{{ checkResult }}</p>
    <p v-if="error" class="cleanup-error" role="alert">{{ error }} <button v-if="operation" class="btn btn-sm" :disabled="polling" @click="pollOperation">Check Progress Again</button></p>
    <ul v-if="listWarnings.length" class="cleanup-warnings"><li v-for="warning in listWarnings" :key="warning">{{ warning }}</li></ul>
    <h4 class="space-option-title">Recommended: shrink and tidy uploaded episodes</h4>
    <p class="cleanup-hint">Scene images are re-saved as smaller JPEGs; motion clips, chapter narration (with its kept narration parts) and the final video move to <code>_trash</code>. Thumbnails, merged narration, subtitles, scripts and prompts stay. You see what it frees before anything changes.</p>
    <template v-if="episodes !== null">
      <p v-if="!episodes.length">Nothing can be freed here yet.{{ listWarnings.length ? ' The reasons are listed above.' : ' No episode has a YouTube upload confirmed on this project’s channel, or narration parts to free.' }}</p>
      <template v-else>
        <div class="cleanup-selection"><strong>{{ selected.length }} {{ selected.length === 1 ? 'episode' : 'episodes' }} selected</strong><button class="btn btn-sm" :disabled="busy" @click="selected = uploaded">Select All Uploaded</button><button class="btn btn-sm" :disabled="busy || !notArchived.length" @click="selected = notArchived">Select All Not Yet Freed</button><button class="btn btn-sm" :disabled="busy || !selected.length" @click="selected = []">Clear Selection</button></div>
        <div class="cleanup-episodes">
          <label v-for="ep in episodes" :key="ep.episode_code" class="cleanup-episode">
            <input v-model="selected" type="checkbox" :value="ep.episode_code" :disabled="busy" />
            <span><strong>{{ ep.episode_code }}</strong> {{ ep.title }}<small>{{ ep.video_id ? localStatus(ep.local_media_status?.state) : 'Not uploaded · only Narration parts can be freed' }}</small></span>
            <a v-if="ep.video_id" :href="`https://www.youtube.com/watch?v=${encodeURIComponent(ep.video_id)}`" target="_blank" rel="noopener noreferrer">View upload</a>
          </label>
        </div>
        <div class="cleanup-preset"><button class="btn btn-primary" :disabled="busy || !selected.length" @click="startPreview(true)">Free Up Space for {{ selected.length }} Selected</button></div>
      </template>
    </template>
    <details v-if="notOffered.length" class="disclosure cleanup-not-offered">
      <summary>{{ notOffered.length }} uploaded {{ notOffered.length === 1 ? 'episode is' : 'episodes are' }} not offered — see why</summary>
      <ul class="cleanup-files"><li v-for="row in notOffered" :key="row.episode_code"><strong>{{ row.episode_code }}</strong> {{ row.title }} — {{ row.reason }}</li></ul>
    </details>
    <h4 class="space-option-title">Other ways</h4>
    <details class="disclosure space-option" data-setting="convert-png">
      <summary><strong>Convert PNG scenes to JPEG</strong><small>Any episode, uploaded or not. The same picture under the same name, usually about 88% smaller, so scene plans, approvals and Video Assembly keep working and nothing is regenerated. The PNG originals move to <code>_trash</code>. You see the saving before anything changes.</small></summary>
      <div class="space-option-body cleanup-convert">
        <select v-model="convertCode" class="input" aria-label="Episode to convert" :disabled="busy"><option value="">Choose an episode…</option><option v-for="ep in allEpisodes" :key="ep.episode_code" :value="ep.episode_code">{{ ep.episode_code }} {{ ep.title }}</option></select>
        <button class="btn btn-secondary" :disabled="busy || !convertCode" @click="startConvert([convertCode])">Check This Episode</button>
        <button class="btn btn-secondary" :disabled="busy || !allEpisodes.length" @click="convertAll">Check All {{ allEpisodes.length }} Episodes</button>
      </div>
    </details>
    <details class="disclosure space-option" data-setting="leftover-files">
      <summary><strong>Leftover files</strong><small>Copies made by narration quality checks and repairs that are finished, and the scratch folders failed video renders keep. Nothing uses them; they move to <code>_trash</code>.</small></summary>
      <div class="space-option-body">
        <button class="btn btn-secondary" :disabled="busy || leftoverBusy" @click="loadLeftovers">{{ leftovers === null ? 'Find Leftover Files' : 'Look Again' }}</button>
        <p v-if="leftovers && !leftovers.length">No leftover files in this project.</p>
        <ul v-if="leftovers?.length" class="cleanup-files"><li v-for="item in leftovers" :key="item.path"><strong>{{ item.episode_code }}</strong> {{ item.kind === 'render_scratch' ? 'Leftover render files' : 'Audio quality copy' }} · {{ formatBytes(item.bytes) }} <span class="cleanup-path">{{ item.path }}</span></li></ul>
        <button v-if="leftovers?.length" class="btn btn-primary" :disabled="busy || leftoverBusy" @click="trashLeftovers">Move {{ leftovers.length }} to _trash ({{ formatBytes(leftoverBytes) }})</button>
        <p v-if="leftoverResult" class="cleanup-hint" role="status">{{ leftoverResult }}</p>
      </div>
    </details>
    <details v-if="episodes?.length" class="disclosure space-option">
      <summary><strong>Choose exactly which files</strong><small>Pick kinds of media for the selected episodes. They move to <code>_trash</code>, or are copied to a folder you choose and then removed here.</small></summary>
      <div class="space-option-body">
        <fieldset :disabled="busy" class="cleanup-categories"><legend>Media to review</legend><label v-for="item in categoryOptions" :key="item.id"><input v-model="categories" type="checkbox" :value="item.id" />{{ item.label }}</label></fieldset>
        <p class="cleanup-hint">Active jobs and shared assets are excluded. You review the exact files before anything changes. Restoring removed media may require paid generation.</p>
        <div><button class="btn btn-secondary" :disabled="busy || !selected.length || !categories.length" @click="startPreview()">Review Selected Files</button></div>
      </div>
    </details>
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
        <p v-if="preview.preset === 'convert_png'"><strong>Convert to JPEG:</strong> each PNG scene is re-saved as a JPEG under the same name; the PNG originals move to <code class="cleanup-path">{{ trashText }}</code>.</p>
        <p v-else-if="preview.preset"><strong>Free up space:</strong> images are shrunk in place, everything else listed moves to <code class="cleanup-path">{{ trashText }}</code>.</p>
        <fieldset v-else :disabled="busy"><legend>What should happen to these files?</legend><label><input v-model="mode" type="radio" value="remove" /> Move local files to _trash (default)</label><label><input v-model="mode" type="radio" value="archive" /> Copy to a folder you choose, then remove here</label></fieldset>
        <div v-if="!preview.preset && mode === 'archive'" class="cleanup-destination"><label for="cleanup-destination">Archive folder</label><input id="cleanup-destination" v-model="destination" class="input" :disabled="busy || picking" placeholder="Choose a folder on your external drive" /><button class="btn btn-secondary" :disabled="busy || picking" @click="browse">{{ picking ? 'Opening…' : 'Browse…' }}</button></div>
        <p>{{ preview.preset ? 'Originals go to the _trash folder on the same drive. Space is freed when you empty _trash; until then you can put anything back.' : mode === 'archive' ? 'Each copy is verified before its original is removed. Choose another drive to free space on this drive.' : `Removed files move to ${trashText} on the same drive. Nothing is deleted; space is freed when you empty _trash.` }}</p>
        <div class="cleanup-action-buttons"><button class="btn btn-secondary" :disabled="busy" @click="dismissReview">Dismiss Review</button><button class="btn btn-primary" :disabled="busy || picking || !preview.files.length || (!preview.preset && mode === 'archive' && !destination.trim())" @click="runCleanup">{{ submitting ? 'Starting…' : preview.preset === 'convert_png' ? 'Convert to JPEG' : preview.preset ? 'Free Up Space' : mode === 'archive' ? 'Archive Reviewed Files' : 'Move Reviewed Files to _trash' }}</button></div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useApi } from '~/composables/useApi'
import { useConfirm } from '~/composables/useConfirm'
import { pickFolder } from '~/composables/usePathPicker'

type Category = 'images' | 'chapter_audio' | 'narration_parts' | 'merged_audio' | 'motion_clips' | 'final_video'
/** `video_id` null: not uploaded, listed only because it has kept narration parts. */
interface CleanupEpisode { episode_code: string; title: string; video_id: string | null; local_media_status?: { state: string; preset_archived_at?: string | null } }
interface ReviewedFile { path: string; relative_path: string; bytes: number; category: Category }
interface Estimate { compress_files: number; compress_bytes_before: number; compress_bytes_after: number; already_jpeg_files: number; trash_files: number; trash_bytes: number }
interface Preview { preview_id: string; project_slug: string; total_bytes: number; preset?: 'archive_episode' | 'convert_png'; trash_roots?: string[]; estimate?: Estimate; files: ReviewedFile[]; blocked_reasons: string[]; episodes: { episode_code: string; files: ReviewedFile[]; excluded?: { path: string; reason: string }[]; blocked_reasons: string[] }[] }
interface Operation { id: string; project_slug: string; kind: 'preview' | 'run'; status: string; stage: string | null; done: number; total: number; current: string; error?: string; preview?: Preview; result?: { items?: Array<{ path?: string; source_path?: string; file?: string; status?: string; outcome?: string; reason?: string }>; bytes_reclaimed?: number; bytes_freed?: number; bytes_moved?: number; bytes_trashed?: number; bytes_after?: number } }
interface Space { free_bytes: number | null; project_trash_bytes: number; library_trash_bytes: number }
interface Leftover { kind: 'audio_quality_copy' | 'render_scratch'; episode_code: string; path: string; bytes: number }
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
const space = ref<Space | null>(null)
const notOffered = ref<{ episode_code: string; title: string; reason: string }[]>([])
const allEpisodes = ref<{ episode_code: string; title: string }[]>([])
const convertCode = ref('')
const checkingYouTube = ref(false)
const checkResult = ref('')
const leftovers = ref<Leftover[] | null>(null)
const leftoverBusy = ref(false)
const leftoverResult = ref('')
const leftoverBytes = computed(() => (leftovers.value || []).reduce((n, item) => n + item.bytes, 0))
let generation = 0
let disposed = false
let timer: ReturnType<typeof setTimeout> | undefined
const categoryOptions: { id: Category; label: string }[] = [
  { id: 'images', label: 'Scene images (thumbnails are never touched)' }, { id: 'chapter_audio', label: 'Chapter audio' },
  { id: 'narration_parts', label: 'Narration parts (kept per-part takes; only where the joined chapter is there, any episode)' },
  { id: 'merged_audio', label: 'Merged audio' }, { id: 'motion_clips', label: 'Motion clips' }, { id: 'final_video', label: 'Final video' },
]
const uploaded = computed(() => (episodes.value || []).filter(ep => ep.video_id).map(ep => ep.episode_code))
const notArchived = computed(() => (episodes.value || []).filter(ep => ep.video_id && !ep.local_media_status?.preset_archived_at).map(ep => ep.episode_code))
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
    const result = await get<{ episodes: CleanupEpisode[]; blocked_reasons: string[]; not_offered?: { episode_code: string; title: string; reason: string }[]; all_episodes?: { episode_code: string; title: string }[] }>(`/projects/${slug}/media-cleanup/episodes`)
    if (!current(version)) return
    episodes.value = result.episodes; listWarnings.value = result.blocked_reasons || []
    notOffered.value = result.not_offered || []; allEpisodes.value = result.all_episodes || []
    void loadSpace()
    selected.value = selected.value.filter(code => result.episodes.some(ep => ep.episode_code === code))
    if (!selected.value.length) selected.value = result.episodes.filter(ep => ep.video_id && !ep.local_media_status?.preset_archived_at).map(ep => ep.episode_code)
  } catch (e) { if (current(version)) error.value = message(e) }
  finally { if (current(version)) loading.value = false }
}
/** Free disk and _trash sizes; a failed read just leaves the line out. */
async function loadSpace() {
  const version = generation, slug = props.slug
  try {
    const result = await get<Space>(`/projects/${slug}/media-cleanup/space`)
    if (current(version) && result && typeof result.project_trash_bytes === 'number') space.value = result
  } catch { /* the figures are a convenience, not a gate */ }
}
async function checkAllUploads() {
  if (checkingYouTube.value) return
  const version = generation, slug = props.slug
  checkingYouTube.value = true; checkResult.value = ''; error.value = ''
  try {
    const result = await post<{ checked: number; outcome: string; legacy?: { checked: number; processed: number; not_found: number } }>(`/projects/${slug}/youtube/sync`, {})
    if (!current(version)) return
    checkResult.value = result.outcome === 'failed'
      ? 'YouTube could not be checked just now; nothing changed. Try again in a few minutes.'
      : `YouTube checked ${result.checked} ${result.checked === 1 ? 'upload' : 'uploads'}${result.legacy?.not_found ? ` (${result.legacy.not_found} no longer on YouTube)` : ''}.${result.outcome === 'partial' ? ' Some could not be checked; try again later.' : ''}`
  } catch (e) { if (current(version)) error.value = message(e) }
  finally { if (current(version)) checkingYouTube.value = false }
  if (current(version)) await loadEpisodes()
}
async function startConvert(codes: string[]) {
  if (busy.value || !codes.length) return
  const version = generation, slug = props.slug
  submitting.value = true; error.value = ''; preview.value = null
  try {
    const result = await post<{ operation_id: string }>(`/projects/${slug}/media-cleanup/preview`, { episode_codes: [...codes], preset: 'convert_png' })
    remember(slug, result.operation_id)
    if (!current(version)) return
    operation.value = { id: result.operation_id, project_slug: slug, kind: 'preview', status: 'queued', stage: 'checking', done: 0, total: 0, current: '' }
    void pollOperation()
  } catch (e) { if (current(version)) error.value = message(e) }
  finally { if (current(version)) submitting.value = false }
}
async function convertAll() {
  const codes = allEpisodes.value.map(ep => ep.episode_code)
  if (busy.value || !codes.length) return
  const approved = await ask({ title: `Check all ${codes.length} episodes for PNG scenes?`, message: `Story Studio reads every scene image of the ${codes.length} episodes in ${props.slug} and shows how much converting them to JPEG saves. Nothing changes until you confirm that review. Reading large channels can take several minutes.`, confirmLabel: 'Check All Episodes', danger: false })
  if (approved) await startConvert(codes)
}
async function loadLeftovers() {
  if (leftoverBusy.value) return
  const version = generation, slug = props.slug
  leftoverBusy.value = true; leftoverResult.value = ''
  try {
    const result = await get<{ leftovers: Leftover[] }>(`/projects/${slug}/media-cleanup/leftovers`)
    if (current(version)) leftovers.value = result.leftovers || []
  } catch (e) { if (current(version)) leftoverResult.value = message(e) }
  finally { if (current(version)) leftoverBusy.value = false }
}
async function trashLeftovers() {
  const items = leftovers.value || []
  if (leftoverBusy.value || !items.length) return
  const version = generation, slug = props.slug
  const approved = await ask({ title: 'Move leftover files to _trash?', message: `${items.length} leftover ${items.length === 1 ? 'folder' : 'folders'} (${formatBytes(leftoverBytes.value)}) move to this project’s _trash. Nothing is deleted; space comes back when you empty _trash.`, confirmLabel: 'Move to _trash', danger: false })
  if (!approved || !current(version)) return
  leftoverBusy.value = true
  try {
    const result = await post<{ moved: { bytes: number }[]; left: { path: string; reason: string }[] }>(`/projects/${slug}/media-cleanup/leftovers/trash`, { paths: items.map(item => item.path) })
    if (!current(version)) return
    leftoverResult.value = `${result.moved.length} moved to _trash (${formatBytes(result.moved.reduce((n, item) => n + item.bytes, 0))}).${result.left.length ? ` ${result.left.length} left where they are: ${result.left.map(item => item.reason).join(' ')}` : ''}`
    leftovers.value = null
    void loadSpace()
  } catch (e) { if (current(version)) leftoverResult.value = message(e) }
  finally { if (current(version)) leftoverBusy.value = false }
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
    const converting = reviewed.preset === 'convert_png'
    const approved = await ask(converting ? { title: 'Convert PNG scenes to JPEG?', message: `${reviewed.files.length} PNG scene ${reviewed.files.length === 1 ? 'image' : 'images'} (${formatBytes(reviewed.total_bytes)}) from ${reviewed.episodes.filter(ep => ep.files.length).length} episodes in ${slug} are re-saved as JPEG under the same names, saving about ${formatBytes(freedBytes.value)}. The PNG originals move to ${trashText.value}; scene plans, approvals and Video Assembly keep working.`, confirmLabel: 'Convert to JPEG', danger: false } : { title: chosenMode === 'archive' ? 'Archive reviewed media?' : chosenMode === 'compress' ? 'Free up space?' : 'Move reviewed media to _trash?', message: `${reviewed.files.length} reviewed files (${formatBytes(reviewed.total_bytes)}) from ${reviewed.episodes.filter(ep => ep.files.length).length} episodes in ${slug}. ${chosenMode === 'archive' ? `Copy to ${folder}, verify, then remove the originals.` : chosenMode === 'compress' ? `This frees about ${formatBytes(freedBytes.value)}. Scene images are re-saved as smaller JPEGs under the same names; the originals, clips, chapter narration and final video move to ${trashText.value}.` : `These files move to ${trashText.value}; nothing is deleted.`} Upload records, scripts, prompts, subtitles and thumbnails stay. Restore from _trash if you need anything back; space is freed when you empty it.`, confirmLabel: chosenMode === 'archive' ? 'Archive Files' : chosenMode === 'compress' ? 'Free Up Space' : 'Move to _trash', danger: false })
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
  try { const folder = await pickFolder({ title: 'Archive episode media', button_label: 'Use This Folder' }); if (folder && current(version)) destination.value = folder }
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
  space.value = null; notOffered.value = []; allEpisodes.value = []; convertCode.value = ''; checkResult.value = ''; leftovers.value = null; leftoverResult.value = ''
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
.cleanup-heading-actions { display: flex; gap: 8px; flex-wrap: wrap; flex-shrink: 0; }
.cleanup-space { font-size: var(--font-sm); }
.cleanup-space small { display: block; color: var(--text-muted); }
.cleanup-convert { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.cleanup-convert .input { flex: 1; min-width: 200px; }
.cleanup-not-offered { margin: 8px 0 12px; }
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
/* The options of the one Free Up Space card. settings.vue repeats the .space-option rules for the options it adds below this panel. */
.space-option-title { margin: 20px 0 4px; font-size: 13px; }
.space-option { border-top: 1px solid var(--border); padding: 12px 0; }
.space-option > summary small { display: block; margin: 2px 0 0 18px; color: var(--text-muted); font-size: 12px; line-height: 1.5; }
.space-option-body { padding: 4px 0 0 18px; }
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
