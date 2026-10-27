<!--
  Duplicate screening (optional) — the switch, the download, and its status.

  Owner, 2026-10-27: the model runs INSIDE Story Studio on this Mac, and it is
  optional extra screening, never required. So this card starts OFF, offers the
  download separately from the switch, and says exactly what is on this disk.
  Turning it on without downloading it is allowed — it simply reports "not
  checked" until the files are there.

  The sizes and the model identity come from the server (which reads the pinned
  contract), so no figure here is a second copy that could drift.
-->
<template>
  <section class="panel duplicate-screening" data-setting="duplicate-screening">
    <div class="row">
      <div class="copy">
        <span class="eyebrow">Optional</span>
        <h4>Duplicate screening</h4>
        <p>
          Story can compare scene images and titles on this Mac, with a small embedding model that
          runs here and nowhere else. It <strong>warns</strong> — it never blocks a render, an upload
          or a save. With it off, or without the model, every check simply reads “not checked”.
        </p>
      </div>
      <label class="toggle">
        <input
          type="checkbox"
          :checked="settings.enabled"
          :disabled="busy === 'toggle'"
          @change="saveEnabled($event.target as HTMLInputElement)"
        />
        <span>Screen this Mac</span>
      </label>
    </div>

    <div class="detail">
      <p class="status">
        <strong>{{ installed ? 'Downloaded' : 'Not downloaded' }}</strong>
        <template v-if="installed"> · {{ formatSize(status.bytes_total) }} on this Mac · {{ modelId }}</template>
        <template v-else-if="partial"> · {{ formatSize(status.bytes_present) }} of {{ formatSize(status.bytes_total) }} already here</template>
        <template v-else> · about {{ formatSize(status.bytes_total) }} to download</template>
      </p>
      <p class="fine">
        {{ license }} · runs locally with no account, no upload, and no Gateway request.
        <template v-if="!installed"> The files are fetched only when you press Download.</template>
      </p>

      <p v-if="installed && settings.enabled" class="hint">
        Off-switch aside, screening stays quiet unless a scene or a title is worth flagging.
      </p>
      <p v-else-if="installed && !settings.enabled" class="hint">
        The model is here and idle. Switch screening on to use it.
      </p>

      <div class="actions">
        <button
          v-if="!installed"
          type="button"
          class="primary"
          :disabled="busy === 'download'"
          @click="startDownload"
        >
          {{ busy === 'download' ? 'Downloading…' : `Download (${formatSize(status.bytes_total)})` }}
        </button>
        <button v-else type="button" :disabled="busy === 'remove'" @click="removeModel">
          {{ busy === 'remove' ? 'Moving to Trash…' : 'Remove from this Mac' }}
        </button>
        <button v-if="installed" type="button" :disabled="busy === 'download'" @click="startDownload">
          Re-check files
        </button>
      </div>

      <div v-if="busy === 'download' && progress" class="progress" role="status">
        <div class="bar"><span :style="{ width: `${progress.percent}%` }" /></div>
        <p class="fine">{{ progress.message }} · {{ progress.percent }}%</p>
      </div>

      <p v-if="result" :class="['result', result.kind]">{{ result.message }}</p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'

interface LocalScreeningSettings {
  enabled: boolean
  compare_recent_episodes: boolean
}
interface LocalModelStatus {
  installed: boolean
  partial: boolean
  bytes_present: number
  bytes_total: number
  missing: string[]
  model_id: string
  license: string
}
interface LocalModelProgress {
  phase: string
  percent: number
  message: string
}
interface ScreeningState {
  settings: LocalScreeningSettings
  status: LocalModelStatus
  progress: LocalModelProgress
  model_id: string
  license: string
}

const { get, put, post } = useApi()

const settings = ref<LocalScreeningSettings>({ enabled: false, compare_recent_episodes: true })
const status = ref<LocalModelStatus>({
  installed: false, partial: false, bytes_present: 0, bytes_total: 0, missing: [], model_id: '', license: 'Apache-2.0',
})
const progress = ref<LocalModelProgress | null>(null)
const modelId = ref('')
const license = ref('')
const busy = ref<'' | 'toggle' | 'download' | 'remove'>('')
const result = ref<{ kind: 'ok' | 'warn' | 'err'; message: string } | null>(null)

let pollTimer: ReturnType<typeof setInterval> | null = null

const installed = computed(() => status.value.installed)
const partial = computed(() => status.value.partial)

function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`
  return `${Math.round(bytes / 1e3)} KB`
}

function apply(state: ScreeningState): void {
  settings.value = state.settings
  status.value = state.status
  progress.value = state.progress
  modelId.value = state.model_id || state.status.model_id
  license.value = state.license || state.status.license || ''
}

async function load(): Promise<void> {
  try {
    apply(await get<ScreeningState>('/local-screening'))
  } catch {
    // Leave the stated defaults (off, not downloaded): a failed read must never
    // look like a setting that was turned on.
    result.value = { kind: 'err', message: 'Could not read the duplicate-screening status.' }
  }
}

async function saveEnabled(box: HTMLInputElement): Promise<void> {
  const next = box.checked
  busy.value = 'toggle'
  result.value = null
  try {
    const saved = await put<{ settings: LocalScreeningSettings }>('/local-screening', { enabled: next })
    settings.value = saved.settings
    result.value = next
      ? {
          kind: installed.value ? 'ok' : 'warn',
          message: installed.value
            ? 'Screening is on for this Mac.'
            : 'Screening is on, but the model is not downloaded yet, so every check will read “not checked” until it is.',
        }
      : { kind: 'ok', message: 'Screening is off. Every check reads “not checked”.' }
  } catch (error: any) {
    box.checked = !next
    result.value = { kind: 'err', message: error?.data?.detail || error?.message || 'Could not save that.' }
  } finally {
    busy.value = ''
  }
}

function startPolling(): void {
  if (pollTimer) return
  pollTimer = setInterval(async () => {
    try {
      const current = await get<LocalModelProgress>('/local-screening/download-progress')
      progress.value = current
      if (current.phase === 'done' || current.phase === 'error') {
        stopPolling()
        busy.value = ''
        await load()
        result.value = current.phase === 'done'
          ? { kind: 'ok', message: 'The screening model is downloaded and checked.' }
          : { kind: 'err', message: current.message || 'The download did not finish.' }
      }
    } catch {
      // A poll that fails is not the download failing; the next tick retries.
    }
  }, 600)
}

function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

async function startDownload(): Promise<void> {
  busy.value = 'download'
  result.value = null
  progress.value = { phase: 'downloading', percent: 0, message: 'Starting…' }
  startPolling()
  try {
    const response = await post<{ status: LocalModelStatus }>('/local-screening/download', {})
    status.value = response.status
    stopPolling()
    busy.value = ''
    result.value = response.status.installed
      ? { kind: 'ok', message: 'The screening model is downloaded and checked.' }
      : { kind: 'err', message: 'The download finished but some files did not verify. Press Download again to retry.' }
  } catch (error: any) {
    stopPolling()
    busy.value = ''
    // A partial download is kept and will resume; say so rather than implying
    // the whole thing must start over.
    result.value = {
      kind: 'err',
      message: `${error?.data?.detail || error?.message || 'The download failed.'} Any files that arrived are kept, and pressing Download again resumes from there.`,
    }
  }
}

async function removeModel(): Promise<void> {
  busy.value = 'remove'
  result.value = null
  try {
    const response = await post<{ problems: string[]; trash_dir: string; status: LocalModelStatus }>('/local-screening/remove', {})
    status.value = response.status
    result.value = response.problems.length
      ? { kind: 'warn', message: response.problems.join(' ') }
      : { kind: 'ok', message: `The model files were moved to Story Studio’s Trash, under ${response.trash_dir}. Nothing was deleted outright.` }
  } catch (error: any) {
    result.value = { kind: 'err', message: error?.data?.detail || error?.message || 'Could not remove the model files.' }
  } finally {
    busy.value = ''
  }
}

onMounted(load)
onBeforeUnmount(stopPolling)
</script>

<style scoped>
.duplicate-screening {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.row {
  display: flex;
  gap: 18px;
  align-items: flex-start;
  justify-content: space-between;
  flex-wrap: wrap;
}
.copy {
  max-width: 62ch;
}
.copy h4 {
  margin: 4px 0 6px;
}
.copy p {
  margin: 0;
  line-height: 1.5;
}
.eyebrow {
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  opacity: 0.7;
}
.toggle {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
}
.detail {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-top: 1px solid var(--border, rgba(128, 128, 128, 0.25));
  padding-top: 12px;
}
.status {
  margin: 0;
}
.fine {
  margin: 0;
  font-size: 12px;
  opacity: 0.75;
  line-height: 1.5;
}
.hint {
  margin: 0;
  font-size: 13px;
  opacity: 0.85;
}
.actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.progress {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.bar {
  height: 6px;
  border-radius: 3px;
  background: rgba(128, 128, 128, 0.25);
  overflow: hidden;
}
.bar span {
  display: block;
  height: 100%;
  background: currentColor;
  transition: width 200ms linear;
}
.result {
  margin: 0;
  font-size: 13px;
}
.result.ok { color: var(--ok, #2e7d32); }
.result.warn { color: var(--warn, #b26a00); }
.result.err { color: var(--err, #c62828); }
</style>
