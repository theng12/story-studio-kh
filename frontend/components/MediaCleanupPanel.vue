<template>
  <section id="free-up-space" class="media-cleanup" aria-labelledby="media-cleanup-heading">
    <div class="cleanup-heading">
      <div><h3 id="media-cleanup-heading">Free up space</h3><p>Two one-click actions across every channel on this Mac. Story Studio lists your channels itself, so you never change channels one by one. Nothing is deleted: files move to Story’s Trash (Story → Trash; the space is freed when you empty it), and you review exactly what will move before anything changes.</p></div>
      <div class="cleanup-heading-actions">
        <button class="btn btn-secondary" :disabled="busy || checkingYouTube" title="Asks YouTube about every upload, older ones included, so confirmed uploads can be freed" @click="checkAllUploads">{{ checkingYouTube ? 'Checking with YouTube…' : 'Check All Uploads' }}</button>
      </div>
    </div>
    <p v-if="space" class="cleanup-space">
      Free on this drive: <strong>{{ formatMeasurement(space.free_bytes) }}</strong>
      · This channel in the Trash: <strong>{{ formatMeasurement(space.project_trash_bytes) }}</strong>
      · Whole Trash: <strong>{{ formatMeasurement(space.library_trash_bytes) }}</strong>
      <small>(space comes back when you empty it on <NuxtLink to="/trash">Story → Trash</NuxtLink>)</small>
      · Old app copies from updates: <strong>{{ formatMeasurement(space.app_trash_bytes) }}</strong> <small>(the last 2 versions are kept; older ones go to the Trash)</small>
    </p>
    <p v-if="checkResult" class="cleanup-hint" role="status">{{ checkResult }}</p>
    <p v-if="error" class="cleanup-error" role="alert">{{ error }} <button v-if="operation" class="btn btn-sm" :disabled="polling" @click="pollOperation">Check Progress Again</button></p>
    <div class="cleanup-library-actions">
      <div class="cleanup-library-action">
        <button class="btn btn-secondary" :disabled="busy" @click="startLibraryPreview('shrink_images')">Shrink Images (All Channels)</button>
        <small>Every PNG scene image is re-saved as a smaller JPEG under the same name across all channels. The PNG originals move to the Trash; scene plans, approvals and Video Assembly keep working and nothing is regenerated.</small>
      </div>
      <div class="cleanup-library-action">
        <button class="btn btn-secondary" :disabled="busy" @click="startLibraryPreview('cleanup_all')">Clean Up All Channels</button>
        <small>Uploaded videos older than 7 days of production that YouTube confirmed on their own channel, plus unused leftover files (finished narration quality copies and scratch folders a failed render kept). Nothing is deleted; the space comes back when you empty the Trash.</small>
        <label class="cleanup-auto">
          <input v-model="autoCleanup" type="checkbox" :disabled="retentionSaving" @change="saveAutoCleanup" />
          Run automatically (daily): clears uploaded finals older than 7 days and unused leftovers
        </label>
        <small class="cleanup-auto-status" role="status">{{ autoCleanupStatus }}</small>
        <small v-if="retentionError" class="cleanup-error" role="alert">{{ retentionError }}</small>
      </div>
    </div>
    <div v-if="operation" class="cleanup-progress" role="status" aria-live="polite">
      <strong>{{ operationLabel }}</strong>
      <span v-if="operation.channels_total">{{ operation.channels_done ?? 0 }} / {{ operation.channels_total }} channels</span>
      <span v-if="operation.total">{{ operation.done }} / {{ operation.total }} {{ operation.stage === 'verifying' ? 'final videos' : operation.kind === 'preview' ? 'episodes' : 'files' }}<template v-if="operation.bytes_total"> · {{ formatBytes(operation.bytes_done ?? 0) }} of {{ formatBytes(operation.bytes_total) }}</template></span>
      <progress v-if="busy && (operation.bytes_total || operation.total)" :value="operation.bytes_total ? operation.bytes_done : operation.done" :max="operation.bytes_total || operation.total" aria-label="Storage operation progress" />
      <p v-if="busy && operation.detail" class="cleanup-hint">{{ operation.detail }}</p>
      <p v-if="operation.current" class="cleanup-path">{{ operation.current }}</p>
      <p v-if="busy">You can leave this page; work continues while Story Studio is open. Stop finishes the current file safely.</p>
      <button v-if="busy && operation.status !== 'stopping'" class="btn btn-secondary" :disabled="stopping" @click="stopOperation">{{ stopping ? 'Stopping…' : 'Stop' }}</button>
      <p v-if="operation.error" class="cleanup-error">{{ operation.error }}</p>
      <template v-if="operation.result">
        <p>{{ resultSummary }}</p>
        <details v-if="operation.result.items?.length" class="disclosure"><summary>View file outcomes</summary><ul class="cleanup-files"><li v-for="(item, index) in operation.result.items" :key="index"><span class="cleanup-path">{{ item.path || item.source_path || item.file }}</span> — {{ item.outcome || item.status }}<span v-if="item.reason">: {{ item.reason }}</span></li></ul><p v-if="moreOutcomes" class="cleanup-hint">and {{ moreOutcomes }} more {{ moreOutcomes === 1 ? 'file' : 'files' }} — all of them are counted above.</p></details>
      </template>
    </div>
    <div v-if="preview" class="cleanup-review">
      <h4>{{ libraryPreviewTitle }}</h4>
      <p v-if="!hasLibraryWork" class="cleanup-hint">Nothing to clean up right now: no eligible uploaded videos and no unused leftover files in any channel. Nothing will move.</p>
      <p>Every channel is listed here with its real totals; each channel shows the first of its files. Every file is checked again before it is touched. Files whose channel, upload proof or production date cannot be confirmed are left where they are, with the reason shown.</p>
      <ul v-if="preview.blocked_reasons.length" class="cleanup-warnings"><li v-for="warning in preview.blocked_reasons" :key="warning">{{ warning }}</li></ul>
      <details v-for="channel in preview.channels" :key="channel.slug" class="cleanup-file-group disclosure">
        <summary>{{ channel.name }} · {{ channel.file_count }} files · {{ formatBytes(channel.total_bytes) }}</summary>
        <ul v-if="channel.blocked_reasons.length" class="cleanup-warnings"><li v-for="reason in channel.blocked_reasons" :key="reason">{{ reason }}</li></ul>
        <ul class="cleanup-files"><li v-for="file in channel.files" :key="file.path"><span class="cleanup-path">{{ file.episode_code }} · {{ file.relative_path }}</span><span>{{ formatBytes(file.bytes) }}</span><span v-if="file.production_ms">{{ productionLabel(file.production_ms) }}</span></li></ul>
        <p v-if="channel.file_count > channel.files.length" class="cleanup-hint">and {{ channel.file_count - channel.files.length }} more {{ channel.file_count - channel.files.length === 1 ? 'file' : 'files' }} in this channel — all of them are counted above and checked again before they are touched.</p>
      </details>
      <details v-if="preview.leftovers?.count" class="cleanup-file-group disclosure">
        <summary>Leftover files · {{ preview.leftovers.count }} · {{ formatBytes(preview.leftovers.total_bytes) }}</summary>
        <ul class="cleanup-files"><li v-for="item in preview.leftovers.items" :key="item.path"><span class="cleanup-path">{{ item.channel_name }} · {{ item.episode_code }} · {{ item.kind === 'render_scratch' ? 'Leftover render files' : 'Audio quality copy' }}</span><span>{{ formatBytes(item.bytes) }}</span></li></ul>
      </details>
      <p v-if="preview.estimate" class="cleanup-estimate"><strong>Frees about {{ formatBytes(libraryFreedBytes) }}</strong> once you empty the Trash.</p>
      <div class="cleanup-actions">
        <p v-if="preview.action === 'shrink_images'"><strong>Shrink scene images:</strong> each PNG scene is re-saved as a JPEG under the same name across all listed channels; the PNG originals move to <code class="cleanup-path">{{ libraryTrashText }}</code>.</p>
        <p v-else><strong>Clean up all channels:</strong> verified uploaded videos older than 7 days of production, and unused leftover files, move to <code class="cleanup-path">{{ libraryTrashText }}</code>. Nothing is deleted; space is freed when you empty the Trash.</p>
        <div class="cleanup-action-buttons"><button class="btn btn-secondary" :disabled="busy || confirming" @click="dismissReview">Dismiss Review</button><button class="btn btn-primary" :disabled="busy || confirming || !hasLibraryWork" @click="runLibraryCleanup">{{ confirming ? 'Confirming…' : submitting ? 'Starting…' : preview.action === 'shrink_images' ? 'Shrink Images on All Channels' : 'Clean Up All Channels' }}</button></div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useApi } from '~/composables/useApi'
import { useConfirm } from '~/composables/useConfirm'

interface ReviewedFile { path: string; relative_path: string; bytes: number; category: string }
interface Estimate { compress_files: number; compress_bytes_before: number; compress_bytes_after: number; already_jpeg_files: number; trash_files: number; trash_bytes: number }
/**
 * The two all-channel actions this screen offers. `cleanup_all` is the merged
 * sweep: the verified-and-older-than-7-days finals of `clear_uploaded_finals`
 * plus the unused leftovers `storage-leftovers` already offers.
 */
type LibraryAction = 'shrink_images' | 'cleanup_all'
interface LibraryFile extends ReviewedFile { project_slug: string; channel_name: string; episode_code: string; production_ms: number | null }
interface LibraryChannel { slug: string; name: string; files: LibraryFile[]; file_count: number; total_bytes: number; blocked_reasons: string[] }
interface LibraryLeftover { project_slug: string; channel_name: string; kind: 'audio_quality_copy' | 'render_scratch'; episode_code: string; path: string; bytes: number }
/**
 * What the backend sends for an all-channel review: real totals and, per
 * channel, the first 50 files only (`file_count` is the real number). The whole
 * list stays on the server — a channel can hold tens of thousands of files, and
 * sending them all made the review read minutes long.
 */
interface LibraryPreview { preview_id: string; action: LibraryAction; created_at: string; expires_at: string; channels: LibraryChannel[]; file_count: number; total_bytes: number; blocked_reasons: string[]; trash_roots: string[]; estimate: Estimate; leftovers?: { count: number; total_bytes: number; items: LibraryLeftover[] } }
interface Operation { id: string; project_slug: string; kind: 'preview' | 'run'; status: string; stage: string | null; done: number; total: number; bytes_done?: number; bytes_total?: number; current: string; detail?: string; error?: string; library?: boolean; library_action?: LibraryAction; library_preview?: LibraryPreview; channels_done?: number; channels_total?: number; result?: { items?: Array<{ path?: string; source_path?: string; file?: string; status?: string; outcome?: string; reason?: string }>; item_count?: number; removed_count?: number; archived_count?: number; compressed_count?: number; deleted_count?: number; skipped_count?: number; failed_count?: number; pending_count?: number; bytes_reclaimed?: number; bytes_freed?: number; bytes_moved?: number; bytes_trashed?: number; bytes_after?: number; leftovers_moved?: number; leftovers_bytes_moved?: number; leftovers_left?: number } }
interface Space { free_bytes: number | null; project_trash_bytes: number | null; library_trash_bytes: number | null; app_trash_bytes: number | null }
/** The one automatic-retention setting (Story → Trash shows the same switch); `last_auto_cleanup` is what this panel reports back. */
interface RetentionRun { at: string; status: 'completed' | 'failed' | 'skipped'; detail: string; moved?: number; bytes?: number }
interface Retention { auto_cleanup_enabled: boolean; last_auto_cleanup: RetentionRun | null }
const props = defineProps<{ slug: string }>()
const { get, post, put } = useApi()
const { ask } = useConfirm()
const preview = ref<LibraryPreview | null>(null)
const operation = ref<Operation | null>(null)
const error = ref('')
const submitting = ref(false)
/** A confirmation is on screen for the reviewed run, but nothing has been accepted yet. */
const confirming = ref(false)
const stopping = ref(false)
const polling = ref(false)
const checkingYouTube = ref(false)
const checkResult = ref('')
const space = ref<Space | null>(null)
const autoCleanup = ref(true)
const retention = ref<Retention | null>(null)
const retentionSaving = ref(false)
const retentionError = ref('')
let generation = 0
let disposed = false
let timer: ReturnType<typeof setTimeout> | undefined
/** The one operation id whose Stop the backend accepted and the panel has not yet seen. */
let stopRequestedId: string | null = null
/** One machine-wide operation id (never channel-owned), so a run survives a page or channel change. */
const LIBRARY_OPERATION_KEY = 'media-cleanup:library'
/** True between restore() and its first poll answer, so a restored already-finished operation never reopens the review. */
let resuming = false
const busy = computed(() => submitting.value || !!operation.value && ['queued', 'running', 'stopping'].includes(operation.value.status))
const DAY_MS = 24 * 60 * 60 * 1000
/** The daily check's own schedule: at most one run a day, so the next one is a day after the last. */
const nextRunText = computed(() => {
  const last = retention.value?.last_auto_cleanup
  const at = last ? Date.parse(last.at) : NaN
  return Number.isFinite(at) ? `Next run about ${new Date(at + DAY_MS).toLocaleString()}.` : 'Next run at the next hourly check.'
})
const autoCleanupStatus = computed(() => {
  if (!autoCleanup.value) return `Off. The two buttons above still work; turn this on to let Story run Clean Up All Channels by itself each day.`
  const last = retention.value?.last_auto_cleanup
  if (!last) return `On. It has not run yet. ${nextRunText.value}`
  return `Last run ${new Date(last.at).toLocaleString()} — ${last.status}: ${last.detail} ${nextRunText.value}`
})
const hasLibraryWork = computed(() => !!preview.value && (preview.value.file_count > 0 || (preview.value.leftovers?.count || 0) > 0))
const libraryPreviewTitle = computed(() => {
  const value = preview.value
  if (!value) return ''
  const channels = value.channels.length
  if (value.action === 'shrink_images') {
    return `Shrink ${value.file_count} ${value.file_count === 1 ? 'file' : 'files'} across ${channels} ${channels === 1 ? 'channel' : 'channels'} · ${formatBytes(value.total_bytes)}`
  }
  const finals = `${value.file_count} uploaded ${value.file_count === 1 ? 'video' : 'videos'} (${formatBytes(value.total_bytes)})`
  const leftoverCount = value.leftovers?.count || 0
  const leftovers = `${leftoverCount} leftover ${leftoverCount === 1 ? 'folder' : 'folders'} (${formatBytes(value.leftovers?.total_bytes || 0)})`
  return `Clean up all channels · ${finals} + ${leftovers}`
})
const libraryFreedBytes = computed(() => {
  const value = preview.value
  if (!value) return 0
  const e = value.estimate
  const finals = e ? (value.action === 'shrink_images' ? e.compress_bytes_before - e.compress_bytes_after : e.trash_bytes + e.compress_bytes_before - e.compress_bytes_after) : 0
  return finals + (value.leftovers?.total_bytes || 0)
})
const libraryTrashText = computed(() => preview.value?.trash_roots?.length ? `Story’s Trash (${preview.value.trash_roots.join(' and ')})` : 'Story’s Trash')
const operationLabel = computed(() => {
  const op = operation.value
  if (!op) return ''
  if (op.status === 'completed') return op.kind === 'preview' ? 'File review ready' : 'Storage operation complete'
  if (op.status === 'stopped') return op.kind === 'preview' ? 'Scan stopped — no files changed. Start a new review when ready.' : 'Stopped — review the file outcomes below'
  if (op.status === 'failed') return 'Storage operation could not finish — the reason is below; nothing that was not checked was moved'
  if (op.status === 'stopping') return 'Stopping after the current file…'
  return op.stage === 'compressing' ? 'Shrinking images and moving media to the Trash…' : op.stage === 'archiving' ? 'Archiving verified files…' : op.stage === 'removing' ? 'Moving reviewed files to the Trash…' : op.stage === 'verifying' ? 'Matching final videos with their YouTube uploads…' : 'Listing files and upload evidence…'
})
/** Outcomes the run produced beyond the capped sample the operation carries. */
const moreOutcomes = computed(() => Math.max(0, (operation.value?.result?.item_count ?? 0) - (operation.value?.result?.items?.length ?? 0)))
const resultSummary = computed(() => {
  const result = operation.value?.result
  const items = result?.items || []
  // `items` is a capped sample and `item_count` is the real number, so a run
  // over thousands of files must be counted from the outcome counters the
  // backend sends, never from the sample. A result without `item_count` is a
  // shape written before the cap: count its (whole) list as before.
  const total = result?.item_count ?? items.length
  const counted = result?.item_count !== undefined
  const pending = counted
    ? (result?.pending_count || 0)
    : items.filter(item => (item.outcome || item.status) === 'pending').length
  const changed = counted
    ? (result?.removed_count || 0) + (result?.archived_count || 0) + (result?.compressed_count || 0) + (result?.deleted_count || 0)
    : items.filter(item => ['removed', 'archived', 'compressed', 'deleted'].includes(item.outcome || item.status || '')).length
  const leftoversMoved = result?.leftovers_moved || 0
  const leftoversLeft = result?.leftovers_left || 0
  const skipped = total - changed - pending
  const changedText = `${changed} ${changed === 1 ? 'file' : 'files'} changed`
  const leftoverText = leftoversMoved ? `${leftoversMoved} leftover ${leftoversMoved === 1 ? 'folder' : 'folders'} moved` : ''
  // A run that moved only leftover folders must not read as "0 files changed".
  const head = changed ? (leftoverText ? `${changedText} and ${leftoverText}` : changedText) : (leftoverText || changedText)
  const trashed = result?.bytes_trashed ? ` ${formatBytes(result.bytes_trashed)} moved to the Trash${result.bytes_after ? ` (${formatBytes(result.bytes_after)} of it replaced by smaller JPEGs)` : ''} — space is freed when you empty the Trash.` : ''
  const leftoverBytes = leftoversMoved ? ` ${formatBytes(result?.leftovers_bytes_moved || 0)} of leftover files also moved to the Trash.` : ''
  // Leftovers that could not move are said out loud, so a partial sweep never reads as "all moved".
  const leftoverLeftText = leftoversLeft ? ` ${leftoversLeft} leftover ${leftoversLeft === 1 ? 'folder' : 'folders'} could not be moved and stayed in place.` : ''
  return `${head}; ${skipped} skipped or could not finish.${pending ? ` ${pending} need review after interruption.` : ''} ${formatBytes(result?.bytes_reclaimed ?? result?.bytes_freed ?? 0)} reclaimed on the source drive.${result?.bytes_moved ? ` ${formatBytes(result.bytes_moved)} archived.` : ''}${trashed}${leftoverBytes}${leftoverLeftText}`
})
function formatBytes(bytes: number) { return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB` }
function productionLabel(ms: number) { return `produced ${new Date(ms).toLocaleDateString()}` }
function formatMeasurement(bytes: number | null) { return bytes === null ? 'could not be measured' : formatBytes(bytes) }
function isSpace(value: any): value is Space {
  return value && ['free_bytes', 'project_trash_bytes', 'library_trash_bytes', 'app_trash_bytes']
    .every(key => value[key] === null || typeof value[key] === 'number')
}
function message(e: any) { return e?.data?.detail || e?.message || 'Storage request failed. Check again.' }
function current(version: number) { return !disposed && version === generation }
/** Remember only an operation the backend actually accepted, so a stale click never persists. */
function remember(id: string) { try { localStorage.setItem(LIBRARY_OPERATION_KEY, id) } catch { /* Work continues if browser storage is unavailable. */ } }
function forget() { try { localStorage.removeItem(LIBRARY_OPERATION_KEY) } catch { /* Nothing to forget. */ } }
/** Bring back an in-flight operation's progress and Stop after a page or channel change — never a re-run or a re-confirm. */
function restore() {
  let id: string | null = null
  try { id = localStorage.getItem(LIBRARY_OPERATION_KEY) } catch { /* No saved operation. */ }
  if (!id) return
  resuming = true
  operation.value = { id, project_slug: '*', kind: 'run', status: 'queued', stage: 'checking', done: 0, total: 0, current: '' }
  void pollOperation()
}
/** Free disk and _trash sizes; a failed read just leaves the line out. */
async function loadSpace() {
  const version = generation, slug = props.slug
  try {
    const result = await get<Space>(`/projects/${slug}/media-cleanup/space`)
    if (current(version) && isSpace(result)) space.value = result
  } catch { /* the figures are a convenience, not a gate */ }
}
/** The switch is the same setting Story → Trash's "Automatic cleanup" shows, so there is one state. */
async function loadRetention() {
  try {
    const saved = await get<Retention>('/trash/retention')
    retention.value = saved
    autoCleanup.value = saved.auto_cleanup_enabled
    retentionError.value = ''
  } catch (e) { retentionError.value = message(e) }
}
/** Writes on the switch itself: the owner asked for an automatic switch, not a second Save button. */
async function saveAutoCleanup() {
  if (retentionSaving.value) return
  const wanted = autoCleanup.value
  retentionSaving.value = true; retentionError.value = ''
  try {
    const saved = await put<Retention>('/trash/retention', { auto_cleanup_enabled: wanted })
    retention.value = { ...retention.value, ...saved }
    autoCleanup.value = saved.auto_cleanup_enabled
  } catch (e) {
    // A refused save must not leave the switch claiming a state the app did not take.
    autoCleanup.value = !wanted
    retentionError.value = message(e)
  } finally { retentionSaving.value = false }
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
}
async function pollOperation() {
  if (polling.value || !operation.value) return
  if (timer) clearTimeout(timer)
  const version = generation, id = operation.value.id
  polling.value = true
  try {
    const result = await get<Operation>(`/library/media-cleanup/operations/${id}`)
    if (!current(version) || operation.value?.id !== id) return
    // A Stop press wins over a stale read. A progress read already in flight when
    // Stop was clicked can come back `running` after the backend has accepted the
    // stop; painting it would flip the panel back to a live Stop — the "Stop did
    // nothing" look the owner reported. Until a read confirms `stopping` (the
    // server's own state from the moment the stop was accepted) or a terminal
    // status, keep the stop state the owner was promised. At most one read can be
    // stale: after the POST, every new read returns `stopping` from the server.
    if (stopRequestedId === id && ['queued', 'running'].includes(result.status)) {
      operation.value = { ...result, status: 'stopping' }
      error.value = ''
      resuming = false
      timer = setTimeout(() => void pollOperation(), 1000)
      return
    }
    stopRequestedId = null
    operation.value = result; error.value = ''
    if (['queued', 'running', 'stopping'].includes(result.status)) {
      resuming = false // it is genuinely in flight; progress and Stop keep updating
      timer = setTimeout(() => void pollOperation(), 1000)
    } else {
      // Terminal: the saved id has served its purpose.
      forget()
      // A review opens only from a scan the user is watching; a restored, already-finished operation must not reopen the confirm.
      if (result.status === 'completed' && result.library_preview && !resuming) preview.value = result.library_preview
      if (resuming) operation.value = null
      resuming = false
    }
  } catch (e: any) {
    if (current(version)) {
      const note = message(e)
      if (e?.statusCode === 404 || e?.status === 404) {
        forget()
        resuming = false
        operation.value = null
        error.value = 'This operation is no longer running, possibly after an app restart. Start a new review; completed cleanup records are retained.'
      } else {
        // One missed read (the engine busy for a moment) used to freeze the progress and leave
        // every button disabled. Keep following the operation; it carries on regardless.
        error.value = `${note} Checking again…`
        timer = setTimeout(() => void pollOperation(), 3000)
      }
    }
  } finally { if (current(version)) polling.value = false }
}
async function startLibraryPreview(action: LibraryAction) {
  if (busy.value) return
  const version = generation
  submitting.value = true; error.value = ''; preview.value = null
  try {
    const result = await post<{ operation_id: string }>('/library/media-cleanup/preview', { action })
    if (!current(version)) return
    remember(result.operation_id)
    operation.value = { id: result.operation_id, project_slug: '*', kind: 'preview', status: 'queued', stage: 'checking', done: 0, total: 0, current: '' }
    void pollOperation()
  } catch (e) { if (current(version)) error.value = message(e) }
  finally { if (current(version)) submitting.value = false }
}
async function runLibraryCleanup() {
  const reviewed = preview.value
  if (busy.value || confirming.value || !reviewed || !hasLibraryWork.value) return
  const version = generation
  const shrink = reviewed.action === 'shrink_images'
  let approved = false
  confirming.value = true; error.value = ''
  try {
    const channels = reviewed.channels.length
    const leftoverCount = reviewed.leftovers?.count || 0
    approved = await ask(shrink
      ? { title: `Shrink scene images on ${channels} ${channels === 1 ? 'channel' : 'channels'}?`, message: `${reviewed.file_count} PNG scene ${reviewed.file_count === 1 ? 'image' : 'images'} (${formatBytes(reviewed.total_bytes)}) across ${channels} ${channels === 1 ? 'channel' : 'channels'} are re-saved as JPEG under the same names, saving about ${formatBytes(libraryFreedBytes.value)}. The PNG originals move to ${libraryTrashText.value}; scene plans, approvals and Video Assembly keep working. Nothing is regenerated.`, confirmLabel: 'Shrink Images', danger: false }
      : { title: 'Clean up all channels?', message: `${reviewed.file_count} uploaded final ${reviewed.file_count === 1 ? 'video' : 'videos'} (${formatBytes(reviewed.total_bytes)}) older than 7 days of production, each checked against its own channel’s YouTube upload, and ${leftoverCount} unused leftover ${leftoverCount === 1 ? 'folder' : 'folders'} (${formatBytes(reviewed.leftovers?.total_bytes || 0)}) move to ${libraryTrashText.value}. Nothing is deleted; the space is freed when you empty the Trash. Anything that cannot be confirmed stays where it is.`, confirmLabel: 'Clean Up', danger: false })
  } finally { confirming.value = false }
  // Nothing is claimed as started until the user accepts: the review stays exactly as it was
  // while the confirmation is on screen, so approving it — not the click that opened it — is the
  // change the owner sees. Only then does the panel lock and read Starting…, and one accepted
  // review id is posted once (confirming guards a second dialog, busy/submitting a second run).
  if (!approved || !current(version)) return
  submitting.value = true
  try {
    const result = await post<{ operation_id: string }>('/library/media-cleanup/run', { preview_id: reviewed.preview_id })
    if (!current(version)) return
    remember(result.operation_id)
    preview.value = null
    operation.value = { id: result.operation_id, project_slug: '*', kind: 'run', status: 'queued', stage: 'checking', done: 0, total: reviewed.file_count + (reviewed.leftovers?.count || 0), current: '' }
    void pollOperation()
  } catch (e) { if (current(version)) error.value = message(e) }
  finally { if (current(version)) submitting.value = false }
}
async function stopOperation() {
  if (!operation.value || stopping.value) return
  const version = generation, id = operation.value.id
  stopping.value = true
  // Claim "Stopping…" immediately: the POST answer already said the backend took
  // the stop, so the owner must not keep seeing a live Stop button (or have to
  // press again) while the poller still shows an older `running` snapshot.
  try {
    await post(`/library/media-cleanup/operations/${id}/stop`, {})
    if (current(version)) {
      stopRequestedId = id
      operation.value = { ...operation.value!, status: 'stopping' }
      void pollOperation()
    }
  }
  catch (e) { if (current(version)) error.value = message(e) }
  finally { if (current(version)) stopping.value = false }
}
function dismissReview() {
  preview.value = null
  if (operation.value?.kind === 'preview') operation.value = null
}
watch(() => props.slug, () => {
  generation++; if (timer) clearTimeout(timer)
  preview.value = null; operation.value = null; error.value = ''; checkResult.value = ''
  space.value = null; checkingYouTube.value = false
  submitting.value = false; confirming.value = false; stopping.value = false; polling.value = false
  stopRequestedId = null
  resuming = false
  void loadSpace()
  void loadRetention()
  restore()
})
onMounted(() => { void loadSpace(); void loadRetention(); restore() })
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
.cleanup-library-actions { display: flex; gap: 16px; flex-wrap: wrap; margin: 16px 0; }
.cleanup-library-action { flex: 1 1 260px; min-width: 240px; display: flex; flex-direction: column; gap: 8px; padding: 14px; border: 1px solid var(--border); border-radius: 10px; }
.cleanup-library-action small { color: var(--text-muted); line-height: 1.5; font-size: var(--font-sm); }
/* The switch sits with the button it automates. Two classes deep on purpose: `.cleanup-library-action small`
   above is more specific than `.cleanup-error`, so a plain class would render the failure in muted grey. */
.cleanup-auto { display: flex; align-items: flex-start; gap: 8px; font-size: var(--font-sm); line-height: 1.5; cursor: pointer; }
.cleanup-auto input { margin: 3px 0 0; flex: none; }
.cleanup-library-action small.cleanup-auto-status { color: var(--text-secondary); }
.cleanup-library-action small.cleanup-error { color: var(--error, #ff9696); }
.cleanup-action-buttons { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin: 16px 0; }
.cleanup-files { max-height: 320px; overflow: auto; }
.cleanup-hint { font-size: var(--font-sm); }
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
.cleanup-action-buttons { justify-content: flex-end; margin-bottom: 0; }
:where(button, input, a, summary):focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
@media (max-width: 700px) { .cleanup-heading { flex-direction: column; } .cleanup-library-actions { flex-direction: column; } .cleanup-actions { position: static; } }
</style>
