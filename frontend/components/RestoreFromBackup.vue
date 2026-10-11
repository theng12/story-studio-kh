<template>
  <div class="restore">
    <p>
      Brings back channels, their presets, ideas, records and upload history from a Story Studio backup. Numbering and schedules carry on
      where they stopped, and episodes already on YouTube stay marked as uploaded. Nothing already here is overwritten unless you say so for that channel.
    </p>

    <FolderField
      :model-value="source"
      label="Backup to restore from"
      hint="The drive or folder that holds “Story Studio Backup”."
      picker-title="Choose the backup drive or folder"
      picker-button-label="Use This Backup"
      :disabled="running"
      @change="chooseSource"
    />

    <FolderField
      :model-value="target"
      :label="firstRun ? 'New Library folder' : 'Restore into'"
      :hint="firstRun
        ? 'Story Studio will keep your work here from now on.'
        : (switching ? 'A new Library: once restored, Story Studio switches to it. Your current Library is left exactly as it is.' : 'Your current Library.')"
      picker-title="Choose the Library to restore into"
      picker-button-label="Use This Folder"
      :disabled="running"
      @change="chooseTarget"
    />

    <p v-if="error" class="rs-error" role="alert">{{ error }}</p>

    <div v-if="preview" class="rs-preview">
      <p>
        Backup from <strong>{{ preview.machine }}</strong>, {{ new Date(preview.updated_at).toLocaleString() }} · Story {{ preview.story_version }}
        <span v-if="!preview.complete" class="rs-warn"> · that backup did not finish, so some files may be missing</span>
      </p>
      <ul class="rs-rows">
        <li v-for="ch in preview.channels" :key="ch.slug">
          <label class="rs-check">
            <input v-model="picked" type="checkbox" :value="ch.slug" :disabled="running">
            <span><strong>{{ ch.name }}</strong> · {{ ch.episodes }} episodes ({{ ch.uploaded_episodes }} uploaded) · {{ formatBytes(ch.restore_bytes) }}</span>
          </label>
          <label v-if="ch.exists_in_target && picked.includes(ch.slug)" class="rs-check rs-warn">
            <input v-model="replace" type="checkbox" :value="ch.slug" :disabled="running">
            <span>Already in this Library — replace it (the current folder moves to Story's Trash)</span>
          </label>
        </li>
      </ul>
      <label class="rs-check">
        <input v-model="withApp" type="checkbox" :disabled="running">
        <span>Also restore app-wide things: settings, voice presets, content packs, which YouTube channel each project uses · {{ formatBytes(preview.app.bytes) }}</span>
      </label>
      <p class="rs-hint">Shared files ({{ formatBytes(preview.shared.bytes) }}) — the character library, series formulas, templates and <code>_Project Assets</code> — come back too; anything already here is kept.</p>
      <div class="rs-actions">
        <button class="btn btn-primary" :disabled="running || !canRestore" @click="restore">{{ running ? 'Restoring…' : `Restore ${picked.length} ${picked.length === 1 ? 'Channel' : 'Channels'}` }}</button>
        <button v-if="running" class="btn btn-secondary" @click="stop">Stop</button>
      </div>
    </div>

    <div v-if="running && progress" class="rs-progress" role="status" aria-live="polite">
      <progress :value="progress.bytes_total ? progress.bytes_done / progress.bytes_total : 0" max="1" />
      <p class="rs-hint">{{ progress.done.toLocaleString() }} of {{ progress.total.toLocaleString() }} files · {{ progress.current }}</p>
    </div>

    <div v-if="result" class="rs-result" role="status">
      <p v-if="result.interrupted" class="rs-warn">{{ result.interrupted }}</p>
      <p v-else>
        <strong>Restored</strong> {{ result.channels.length }} {{ result.channels.length === 1 ? 'channel' : 'channels' }}: {{ result.files.toLocaleString() }} files, {{ formatBytes(result.bytes) }}.
        <template v-if="result.kept_existing_count"> {{ result.kept_existing_count }} files already here were kept as they are.</template>
        Sign in to YouTube and the Gateway again in Settings → Connections.
      </p>
      <ul v-if="result.damaged.length" class="rs-warn"><li v-for="d in result.damaged" :key="d">{{ d }}</li></ul>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useApi } from '~/composables/useApi'
import { useConfirm } from '~/composables/useConfirm'

interface ChannelRow { slug: string; name: string; episodes: number; uploaded_episodes: number; restore_bytes: number; exists_in_target: boolean }
interface Preview { machine: string; updated_at: string; story_version: string; complete: boolean; app: { bytes: number }; shared: { bytes: number }; channels: ChannelRow[] }
interface Progress { done: number; total: number; bytes_done: number; bytes_total: number; current: string }

/** `libraryPath`: the current Library; absent on first run, when the restore makes a new one. */
const props = defineProps<{ libraryPath?: string; suggested?: string }>()
const emit = defineEmits<{ restored: [libraryPath: string] }>()
const { get, post } = useApi()
const { ask } = useConfirm()

const firstRun = computed(() => !props.libraryPath)
const source = ref('')
const target = ref(props.libraryPath || props.suggested || '')
const preview = ref<Preview | null>(null)
const picked = ref<string[]>([])
const replace = ref<string[]>([])
const withApp = ref(true)
const running = ref(false)
const progress = ref<Progress | null>(null)
const result = ref<any>(null)
const error = ref('')
let timer: ReturnType<typeof setInterval> | null = null

watch(() => props.libraryPath || props.suggested, v => { if (!target.value && v) target.value = v })
const switching = computed(() => !!target.value && target.value !== props.libraryPath)
const canRestore = computed(() => picked.value.length > 0
  && picked.value.every(slug => !preview.value?.channels.find(c => c.slug === slug)?.exists_in_target || replace.value.includes(slug)))

async function loadPreview(): Promise<void> {
  error.value = ''
  preview.value = null
  result.value = null
  if (!source.value) return
  try {
    preview.value = await post<Preview>('/backup/restore/preview', { source: source.value, target: target.value || undefined })
    picked.value = preview.value.channels.filter(c => !c.exists_in_target).map(c => c.slug)
    replace.value = []
    // On an existing Mac, settings already set up here stay; on a new one they come back.
    withApp.value = firstRun.value || switching.value
  } catch (e: any) {
    error.value = e?.data?.detail || e?.message || 'Could not read that backup.'
  }
}

function chooseSource(path: string): void { source.value = path; void loadPreview() }
function chooseTarget(path: string): void { target.value = path; void loadPreview() }

async function restore(): Promise<void> {
  if (!preview.value) return
  const replacing = replace.value.filter(s => picked.value.includes(s))
  const ok = await ask({
    title: 'Restore from this backup?',
    message: `Restore ${picked.value.length} channels into ${target.value}.`
      + (replacing.length ? ` ${replacing.length} existing ${replacing.length === 1 ? 'channel is' : 'channels are'} moved to Story's Trash first and replaced: ${replacing.join(', ')}.` : ' Nothing already there is overwritten.')
      + (switching.value ? ' Story Studio then uses that folder as your Library.' : ''),
    confirmLabel: 'Restore',
    danger: replacing.length > 0,
  })
  if (!ok) return
  error.value = ''
  try {
    await post('/backup/restore/run', {
      source: source.value,
      target: target.value,
      channels: picked.value.map(slug => ({ slug, replace: replacing.includes(slug) })),
      app: withApp.value,
      use_as_library: switching.value,
    })
    running.value = true
    timer = setInterval(async () => {
      const s = await get<any>('/backup/status').catch(() => null)
      if (!s) return
      progress.value = s.progress
      if (s.running) return
      clearInterval(timer!)
      timer = null
      running.value = false
      if (s.error) error.value = s.error
      result.value = s.result
      if (s.result && !s.result.interrupted) emit('restored', target.value)
    }, 1000)
  } catch (e: any) {
    error.value = e?.data?.detail || e?.message || 'Could not start the restore.'
  }
}

async function stop(): Promise<void> {
  await post('/backup/stop', {}).catch(() => {})
}

onBeforeUnmount(() => { if (timer) clearInterval(timer) })
</script>

<style scoped>
.restore { display: grid; gap: 12px; min-width: 0; }
p { color: var(--text-secondary); line-height: 1.5; margin: 0; max-width: 72ch; }
.rs-hint { font-size: var(--font-sm); }
.rs-warn { color: var(--warning, #b26a00); }
.rs-error { color: var(--danger, #c0392b); }
.rs-rows { list-style: none; padding: 0; margin: 8px 0; max-height: 360px; overflow: auto; }
.rs-rows li { padding: 6px 0; border-bottom: 1px solid var(--border); min-width: 0; }
.rs-check { display: flex; gap: 8px; align-items: flex-start; padding: 2px 0; min-width: 0; }
.rs-check span { overflow-wrap: anywhere; }
.rs-preview, .rs-result { display: grid; gap: 8px; }
.rs-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.rs-progress progress { width: 100%; }
</style>
