<template>
  <section class="backup-panel" aria-labelledby="backup-title">
    <header class="bk-head">
      <h3 id="backup-title">Back up to a drive</h3>
      <p>
        Copies everything Story cannot make again — presets, ideas, scripts, metadata, scene plans, subtitles, upload records,
        Music Pool tracks, logos and intro clips, the character library and your settings — as plain files you can open without Story.
        Scene images, narration, renders and caches are left out because Story can make them again. Passwords, API keys and YouTube
        sign-ins never go on the drive: after a restore you sign in again.
      </p>
    </header>

    <div data-setting="backup-folder">
      <FolderField
        :model-value="settings?.folder || ''"
        label="Backup folder"
        hint="Usually an external drive. Story keeps everything in a “Story Studio Backup” folder inside it."
        picker-title="Choose where to keep your backup"
        picker-button-label="Use This Folder"
        :disabled="busy"
        @change="saveFolder"
      >
        <template #badge>
          <span v-if="settings?.folder && !overview?.drive_present" class="status-chip warn">Not plugged in</span>
        </template>
      </FolderField>
    </div>

    <p v-if="error" class="bk-error" role="alert">{{ error }}</p>

    <div v-if="settings?.folder" class="bk-last" role="status">
      <template v-if="last">
        <p>
          <strong>{{ last.complete ? 'Last backup' : 'Last backup did not finish' }}:</strong>
          {{ formatWhen(last.finished_at) }} · {{ last.files.toLocaleString() }} files · {{ formatBytes(last.bytes) }}
        </p>
        <p v-if="last.interrupted" class="bk-warn">{{ last.interrupted }}</p>
        <p class="bk-hint">
          What changed: {{ last.added }} added, {{ last.updated }} updated, {{ last.removed }} moved to older copies, {{ last.unchanged.toLocaleString() }} unchanged.
        </p>
        <details v-if="last.changes.length" class="disclosure">
          <summary>Show changed files</summary>
          <ul class="bk-rows">
            <li v-for="c in last.changes" :key="c.path"><span class="bk-path">{{ c.path }}</span><span>{{ c.change }}</span></li>
          </ul>
        </details>
      </template>
      <p v-else class="bk-hint">No backup yet.</p>
    </div>

    <div v-if="settings?.folder" class="bk-options" data-setting="backup-extras">
      <p class="bk-label">
        Always included: {{ plan ? formatBytes(plan.sizes.records) : 'records and irreplaceable files' }}.
        Also include:
        <button class="btn btn-ghost btn-sm" :disabled="busy" @click="measure">{{ status?.running && status.kind === 'plan' ? 'Measuring…' : plan ? 'Measure again' : 'Measure sizes' }}</button>
      </p>
      <label v-for="opt in extras" :key="opt.key" class="bk-check">
        <input type="checkbox" :checked="!!settings.options[opt.key]" :disabled="busy" @change="toggleExtra(opt.key, ($event.target as HTMLInputElement).checked)">
        <span>{{ opt.label }}<small v-if="plan"> · {{ formatBytes(plan.sizes[opt.key]) }}</small></span>
      </label>
      <p v-if="plan?.folder_free_bytes != null" class="bk-hint">Free on the backup drive: {{ formatBytes(plan.folder_free_bytes) }}</p>
      <p v-if="plan?.skipped_folders?.length" class="bk-hint">Not channels, so not backed up: {{ plan.skipped_folders.join(', ') }}</p>

      <label class="bk-check" data-setting="backup-auto">
        <input type="checkbox" :checked="settings.auto" :disabled="busy" @change="toggleAuto(($event.target as HTMLInputElement).checked)">
        <span>Back up automatically — once a day, and whenever this drive is plugged in, while Story is not busy</span>
      </label>
    </div>

    <div v-if="status?.running && status.kind !== 'plan'" class="bk-progress" role="status" aria-live="polite">
      <p>
        <strong>{{ taskLabel }}</strong>
        <template v-if="status.progress?.total"> · {{ status.progress.done.toLocaleString() }} of {{ status.progress.total.toLocaleString() }} files</template>
        <template v-if="status.progress?.bytes_total"> · {{ formatBytes(status.progress.bytes_done) }} of {{ formatBytes(status.progress.bytes_total) }}</template>
      </p>
      <progress :value="progressValue" max="1" />
      <p class="bk-path">{{ status.progress?.current }}</p>
    </div>

    <div v-if="settings?.folder" class="bk-actions">
      <button class="btn btn-primary" :disabled="busy || !overview?.drive_present" @click="backUpNow">Back Up Now</button>
      <button class="btn btn-secondary" :disabled="busy || !overview?.drive_present || !overview?.on_drive" @click="checkBackup">Check Backup</button>
      <button v-if="status?.running" class="btn btn-secondary" :disabled="status.stopping" @click="stop">{{ status.stopping ? 'Stopping…' : 'Stop' }}</button>
    </div>

    <div v-if="verify" class="bk-last" role="status">
      <p v-if="!verify.missing.length && !verify.damaged.length">
        <strong>Backup checked:</strong> all {{ verify.checked.toLocaleString() }} files match. {{ formatWhen(verify.finished_at) }}
      </p>
      <template v-else>
        <p class="bk-warn"><strong>{{ verify.missing.length }} missing, {{ verify.damaged.length }} damaged</strong> of {{ verify.checked.toLocaleString() }} files. Back up again to replace them.</p>
        <ul class="bk-rows">
          <li v-for="p in verify.missing.slice(0, 50)" :key="`m${p}`"><span class="bk-path">{{ p }}</span><span>missing</span></li>
          <li v-for="p in verify.damaged.slice(0, 50)" :key="`d${p}`"><span class="bk-path">{{ p }}</span><span>damaged</span></li>
        </ul>
      </template>
    </div>

    <details v-if="overview?.drive_present" class="disclosure bk-versions" data-setting="backup-versions" @toggle="onVersionsToggle">
      <summary>
        <strong>Older copies on the drive</strong>
        <small>{{ versions ? formatBytes(versions.total_bytes) : 'files a later backup replaced or no longer needed' }}</small>
      </summary>
      <p class="bk-hint">A backup never deletes anything on the drive: a file that changed or went away moves here, by date. Only you can delete these.</p>
      <ul v-if="versions?.versions.length" class="bk-rows">
        <li v-for="v in versions.versions" :key="v.stamp">
          <label class="bk-check"><input v-model="pruneChoice" type="checkbox" :value="v.stamp"> <span>{{ v.stamp }}</span></label>
          <span>{{ formatBytes(v.bytes) }}</span>
        </li>
      </ul>
      <p v-else-if="versions" class="bk-hint">None yet.</p>
      <button v-if="versions?.versions.length" class="btn btn-danger btn-sm" :disabled="busy || !pruneChoice.length" @click="prune">Delete Selected…</button>
    </details>

    <section class="bk-restore" data-setting="backup-restore">
      <h4>Restore from a backup</h4>
      <RestoreFromBackup :library-path="libraryPath" />
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useApi } from '~/composables/useApi'
import { useConfirm } from '~/composables/useConfirm'

type Extra = 'final_videos' | 'narration_audio' | 'all_thumbnails'
interface Result { complete: boolean; interrupted: string; finished_at: string; files: number; bytes: number; added: number; updated: number; removed: number; unchanged: number; changes: Array<{ path: string; change: string }> }
interface Verify { checked: number; missing: string[]; damaged: string[]; finished_at: string }
interface Settings { folder: string; auto: boolean; options: Partial<Record<Extra, boolean>>; last: Result | null; last_verify: Verify | null }
interface Status { running: boolean; kind: 'plan' | 'backup' | 'verify' | 'restore' | null; progress: { stage: string; done: number; total: number; bytes_done: number; bytes_total: number; current: string } | null; stopping: boolean; result: any; error: string }
interface Overview { settings: Settings; drive_present: boolean; on_drive: unknown; status: Status }

defineProps<{ libraryPath?: string }>()
const { get, post, put } = useApi()
const { ask } = useConfirm()

const overview = ref<Overview | null>(null)
const status = ref<Status | null>(null)
const plan = ref<{ sizes: Record<'records' | Extra, number>; folder_free_bytes: number | null; skipped_folders: string[] } | null>(null)
const versions = ref<{ total_bytes: number; versions: Array<{ stamp: string; bytes: number }> } | null>(null)
const pruneChoice = ref<string[]>([])
const error = ref('')
let timer: ReturnType<typeof setInterval> | null = null

const settings = computed(() => overview.value?.settings ?? null)
const last = computed(() => settings.value?.last ?? null)
const verify = computed(() => settings.value?.last_verify ?? null)
const busy = computed(() => !!status.value?.running)
const extras: Array<{ key: Extra; label: string }> = [
  { key: 'final_videos', label: 'Finished videos' },
  { key: 'narration_audio', label: 'Narration audio' },
  { key: 'all_thumbnails', label: 'Every thumbnail (not only the one chosen for upload)' },
]
const taskLabel = computed(() => ({ backup: 'Backing up', verify: 'Checking the backup', restore: 'Restoring', plan: 'Measuring' }[status.value?.kind || 'backup']))
const progressValue = computed(() => {
  const p = status.value?.progress
  if (!p) return 0
  if (p.bytes_total) return p.bytes_done / p.bytes_total
  return p.total ? p.done / p.total : 0
})

function formatWhen(iso: string): string {
  return iso ? new Date(iso).toLocaleString() : ''
}

async function load(): Promise<void> {
  try {
    overview.value = await get<Overview>('/backup')
    status.value = overview.value.status
    if (status.value.running) poll()
  } catch (e: any) {
    error.value = e?.data?.detail || e?.message || 'Could not read the backup settings.'
  }
}

function poll(): void {
  if (timer) return
  timer = setInterval(async () => {
    try {
      status.value = await get<Status>('/backup/status')
      if (!status.value.running) {
        clearInterval(timer!)
        timer = null
        if (status.value.error) error.value = status.value.error
        if (status.value.kind === 'plan' && status.value.result) plan.value = status.value.result
        await load()
      }
    } catch { /* the next tick tries again */ }
  }, 1000)
}

async function act(fn: () => Promise<unknown>, fallback: string): Promise<void> {
  error.value = ''
  try {
    await fn()
    status.value = await get<Status>('/backup/status')
    poll()
  } catch (e: any) {
    error.value = e?.data?.detail || e?.message || fallback
  }
}

async function saveSettings(patch: Record<string, unknown>): Promise<void> {
  error.value = ''
  try {
    await put('/backup/settings', patch)
    await load()
  } catch (e: any) {
    error.value = e?.data?.detail || e?.message || 'Could not save.'
  }
}

const saveFolder = (folder: string) => saveSettings({ folder })
const toggleAuto = (auto: boolean) => saveSettings({ auto })
const toggleExtra = (key: Extra, on: boolean) => saveSettings({ options: { ...settings.value?.options, [key]: on } })
const measure = () => act(() => post('/backup/plan', {}), 'Could not measure.')
const backUpNow = () => act(() => post('/backup/run', {}), 'Could not start the backup.')
const checkBackup = () => act(() => post('/backup/verify', {}), 'Could not check the backup.')
const stop = () => act(() => post('/backup/stop', {}), 'Could not stop.')

async function loadVersions(): Promise<void> {
  try { versions.value = await get('/backup/versions') } catch (e: any) { error.value = e?.data?.detail || e?.message || 'Could not measure older copies.' }
}

function onVersionsToggle(event: Event): void {
  if ((event.target as HTMLDetailsElement).open) void loadVersions()
}

async function prune(): Promise<void> {
  const chosen = versions.value?.versions.filter(v => pruneChoice.value.includes(v.stamp)) ?? []
  const bytes = chosen.reduce((n, v) => n + v.bytes, 0)
  const ok = await ask({
    title: 'Delete older copies for good?',
    message: `This permanently deletes ${chosen.length} dated ${chosen.length === 1 ? 'folder' : 'folders'} of older copies (${formatBytes(bytes)}) from the backup drive. Your latest backup is not touched. This cannot be undone.`,
    confirmLabel: 'Delete Permanently',
    danger: true,
  })
  if (!ok) return
  try {
    await post('/backup/versions/prune', { stamps: pruneChoice.value, confirm: true })
    pruneChoice.value = []
    await loadVersions()
  } catch (e: any) {
    error.value = e?.data?.detail || e?.message || 'Could not delete the older copies.'
  }
}

onMounted(load)
onBeforeUnmount(() => { if (timer) clearInterval(timer) })
</script>

<style scoped>
.backup-panel { padding: 4px 0; }
.bk-head h3 { margin: 0 0 8px; }
p { color: var(--text-secondary); line-height: 1.5; margin: 8px 0; max-width: 72ch; }
.bk-hint { font-size: var(--font-sm); }
.bk-label { color: var(--text-primary); }
.bk-warn { color: var(--warning, #b26a00); }
.bk-error { color: var(--danger, #c0392b); }
.bk-last, .bk-options, .bk-progress { margin-top: 14px; }
.bk-check { display: flex; gap: 8px; align-items: flex-start; padding: 4px 0; min-width: 0; }
.bk-check span { overflow-wrap: anywhere; }
.bk-check small { color: var(--text-secondary); }
.bk-progress progress { width: 100%; }
.bk-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
.bk-rows { list-style: none; padding: 0; margin: 8px 0; max-height: 280px; overflow: auto; }
.bk-rows li { display: flex; justify-content: space-between; gap: 12px; padding: 4px 0; border-bottom: 1px solid var(--border); min-width: 0; }
.bk-path { font-family: var(--font-mono, monospace); font-size: var(--font-sm); overflow-wrap: anywhere; min-width: 0; }
.bk-versions { margin-top: 16px; }
.bk-versions summary small { margin-left: 8px; color: var(--text-secondary); }
.bk-restore { margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--border); }
.bk-restore h4 { margin: 0 0 8px; }
</style>
