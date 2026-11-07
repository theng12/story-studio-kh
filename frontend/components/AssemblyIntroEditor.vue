<template>
  <!-- Step 2 popup BODY. The host supplies the Modal and mounts this with v-if,
       so closing the dialog unmounts the draft with it. No padding or margin is
       reset here: the host keeps Modal's own spacing. -->
  <div class="assembly-intro-editor">
    <p v-if="!introDraft" class="text-danger text-sm">{{ error }}</p>

    <fieldset v-else class="assembly-intro-fields" :disabled="busy" aria-label="Intro settings">
      <div class="settings-section">
        <div class="flex gap-2 items-center">
          <label class="checkbox-label" @click.stop>
            <input v-model="introDraft.intro.enabled" type="checkbox" aria-label="Enable intro video" />
          </label>
          <h4>Intro Video</h4>
        </div>

        <div v-if="introDraft.intro.enabled" class="mt-2">
          <div class="form-group">
            <label>Intro Video Path <span class="text-muted text-xs">(.mp4, .mov, .mkv, .webm)</span></label>
            <!-- No episodes-root here on purpose: Browse returns the raw pick.
                 Apply adopts only the files this draft actually changed. -->
            <FilePicker
              v-model="introDraft.intro.video_path"
              placeholder="No intro video chosen"
              :filters="VIDEO_FILTERS"
              title="Choose an intro video"
              aria-label="Intro video path"
              clearable
            />
          </div>
          <p class="text-muted text-sm mt-1">The intro video plays before the title image and scenes.</p>
        </div>
      </div>

      <div class="settings-section mt-2">
        <div class="flex items-center justify-between">
          <h4>Channel intro</h4>
          <span v-if="isBoundFromChannel" class="badge badge-subtle text-xs" data-testid="channel-bound-badge">Channel default</span>
        </div>
        <p class="text-muted text-sm mt-1 mb-2">
          The intro music used whenever this episode's audio is rebuilt. Nothing is selected by default.
        </p>
        <ChannelIntroAudioPicker
          :model-value="introDraft.channel_intro"
          :episodes-root="String(episodesRoot || '')"
          :slug="slug"
          @update:model-value="onChannelIntroPickerUpdate"
        />

        <div v-if="introDraft.channel_intro?.file" class="intro-trims-fades mt-2">
          <div class="grid-2">
            <div class="form-group">
              <label>Trim start (s)</label>
              <input
                v-model.number="introDraft.channel_intro.trim_start_sec"
                type="number"
                min="0"
                step="0.5"
                class="form-control"
                placeholder="0"
                aria-label="Intro trim start in seconds"
              />
              <span class="text-muted text-xs">Start playback this many seconds in</span>
            </div>
            <div class="form-group">
              <label>Duration (s)</label>
              <input
                v-model.number="introDraft.channel_intro.duration_sec"
                type="number"
                min="0.1"
                step="0.5"
                class="form-control"
                placeholder="Full track"
                aria-label="Intro play duration in seconds"
              />
              <span class="text-muted text-xs">Leave blank to play the full track</span>
            </div>
          </div>
          <div class="grid-2 mt-2">
            <div class="form-group">
              <label>Fade in (s)</label>
              <input
                v-model.number="introDraft.channel_intro.fade_in_sec"
                type="number"
                min="0"
                step="0.5"
                class="form-control"
                placeholder="0"
                aria-label="Intro fade in duration in seconds"
              />
              <span class="text-muted text-xs">Gradual volume rise</span>
            </div>
            <div class="form-group">
              <label>Fade out (s)</label>
              <input
                v-model.number="introDraft.channel_intro.fade_out_sec"
                type="number"
                min="0"
                step="0.5"
                class="form-control"
                placeholder="0"
                aria-label="Intro fade out duration in seconds"
              />
              <span class="text-muted text-xs">Gradual volume decay</span>
            </div>
          </div>
        </div>
      </div>
    </fieldset>

    <p v-if="audioChanged && introDraft" class="text-muted text-sm mt-2">
      Apply rebuilds this episode’s audio with your saved Audio Assembly preset.
    </p>
    <p v-if="pendingNote && busy" class="text-muted text-sm mt-2" role="status">{{ pendingNote }}</p>
    <p v-if="error && introDraft" class="text-danger text-sm mt-2" role="alert">{{ error }}</p>

    <div class="flex gap-2 mt-3" style="justify-content: flex-end;">
      <button
        type="button"
        class="btn btn-sm btn-secondary"
        data-testid="cancel-intro"
        :disabled="busy"
        @click="cancel"
      >Cancel</button>
      <button
        type="button"
        class="btn btn-sm btn-primary"
        data-testid="apply-intro"
        :disabled="busy || !introDraft"
        @click="apply"
      >{{ applyLabel }}</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { AssemblyStepDraft, AssemblyStepScope } from '~/utils/assembly-step-draft'

interface LegacyIntro {
  enabled: boolean
  video_path: string
}

interface ChannelIntroSelection {
  file: string
  volume: number
  gap_after: number
  trim_start_sec?: number
  duration_sec?: number | null
  fade_in_sec?: number
  fade_out_sec?: number
}

interface IntroDraft {
  intro: LegacyIntro
  channel_intro: ChannelIntroSelection | null
}

const props = defineProps<{
  slug: string
  episodeId: string
  /**
   * The full Video Assembly snapshot this popup was opened on. It is a
   * baseline to seed the episode's own saved entry, never an object written
   * back: this editor owns only its intro fields.
   */
  fullsettings?: Record<string, any> | null
}>()

const emit = defineEmits<{
  applied: [value: { intro: LegacyIntro; channel_intro: ChannelIntroSelection | null; merged_audio?: string }]
  refresh: []
  cancel: []
}>()

const { get, post, put } = useApi()
const { jobs } = useJobs()
const { episodesRoot } = useProject()

const VIDEO_FILTERS = [{ name: 'Videos', extensions: ['mp4', 'mov', 'mkv', 'webm'] }]
const LAST_USED_CONFIG_KEY = 'video_assembly_last_used'
const PORTABLE_PATH = /^\$\{(?:CHANNEL|PROJECT|ASSET|BACKGROUND)\}(?:\/.*)?$/

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function basename(value: string): string {
  return String(value || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''
}

function isPortablePath(value: string): boolean {
  return PORTABLE_PATH.test(String(value || '').trim())
}

function normalizeLegacyIntro(raw: any): LegacyIntro {
  return {
    enabled: raw?.enabled === true,
    video_path: String(raw?.video_path || ''),
  }
}

function normalizeChannelIntro(raw: any): ChannelIntroSelection | null {
  if (!raw || typeof raw !== 'object') return null
  const file = String(raw.file || '').trim()
  if (!file) return null
  const volume = Number(raw.volume)
  const gap = Number(raw.gap_after)
  const trimStart = Number(raw.trim_start_sec)
  const duration = raw.duration_sec != null ? Number(raw.duration_sec) : null
  const fadeIn = Number(raw.fade_in_sec)
  const fadeOut = Number(raw.fade_out_sec)
  return {
    file,
    // The picker works in linear gain (0–1). Preserve a value it actually
    // sent; a missing one starts at full volume, never silently re-decided.
    volume: Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 1,
    gap_after: Number.isFinite(gap) ? Math.max(0, gap) : 0,
    trim_start_sec: Number.isFinite(trimStart) ? Math.max(0, trimStart) : 0,
    duration_sec: duration !== null && Number.isFinite(duration) && duration > 0 ? duration : null,
    fade_in_sec: Number.isFinite(fadeIn) ? Math.max(0, fadeIn) : 0,
    fade_out_sec: Number.isFinite(fadeOut) ? Math.max(0, fadeOut) : 0,
  }
}

/** `channel_intro` is the new sibling; an older snapshot may nest it inside intro. Automatic binding resolves channel_intro_music if episode has none. */
function readChannelIntro(full: any): ChannelIntroSelection | null {
  if (full && Object.prototype.hasOwnProperty.call(full, 'channel_intro')) {
    return normalizeChannelIntro(full.channel_intro)
  }
  if (full?.intro && Object.prototype.hasOwnProperty.call(full.intro, 'channel_intro')) {
    return normalizeChannelIntro(full.intro.channel_intro)
  }
  if (full && Object.prototype.hasOwnProperty.call(full, 'channel_intro_music')) {
    return normalizeChannelIntro(full.channel_intro_music)
  }
  return null
}

function sameChannelIntro(a: ChannelIntroSelection | null, b: ChannelIntroSelection | null): boolean {
  if (!a || !b) return a === b
  return a.file === b.file
    && a.volume === b.volume
    && a.gap_after === b.gap_after
    && (a.trim_start_sec ?? 0) === (b.trim_start_sec ?? 0)
    && (a.duration_sec ?? null) === (b.duration_sec ?? null)
    && (a.fade_in_sec ?? 0) === (b.fade_in_sec ?? 0)
    && (a.fade_out_sec ?? 0) === (b.fade_out_sec ?? 0)
}

/** Identity of one normalized channel-intro choice; a different choice means a real rebuild. */
function channelIntroKey(value: ChannelIntroSelection | null): string {
  const normalized = normalizeChannelIntro(value)
  return normalized
    ? `${normalized.file}\u0000${normalized.volume}\u0000${normalized.gap_after}\u0000${normalized.trim_start_sec ?? 0}\u0000${normalized.duration_sec ?? 'full'}\u0000${normalized.fade_in_sec ?? 0}\u0000${normalized.fade_out_sec ?? 0}`
    : 'null'
}

function plainError(cause: any, fallback: string): string {
  return String(cause?.data?.detail || cause?.message || cause || fallback)
}

const baselineIntro = normalizeLegacyIntro(props.fullsettings?.intro)
const baselineChannelIntro = readChannelIntro(props.fullsettings)
const baselineSettings: Record<string, any> = clone(props.fullsettings || {})

const draftState = ref<AssemblyStepDraft<IntroDraft> | null>(null)
const error = ref('')
try {
  if (!String(props.slug || '').trim() || !String(props.episodeId || '').trim()) {
    throw new Error('Open this editor from an episode.')
  }
  draftState.value = beginAssemblyStepDraft<IntroDraft>({
    intro: clone(baselineIntro),
    channel_intro: clone(baselineChannelIntro),
  }, { channel: props.slug, episode: props.episodeId })
} catch (cause) {
  error.value = cause instanceof Error ? cause.message : String(cause)
}

const applying = ref(false)
const pendingJobId = ref<string | null>(null)
const pendingNote = ref('')
// A merge that reached `done` for one normalized selection. A retry after a
// failed pin/verify/save finishes that same job instead of rebuilding.
const completedMerge = ref<{ key: string; jobId: string } | null>(null)
const busy = computed(() => applying.value || !!pendingJobId.value)
const applyLabel = computed(() => pendingJobId.value
  ? 'Rebuilding audio…'
  : applying.value ? 'Applying…' : 'Apply')
const introDraft = computed(() => draftState.value?.value || null)
const isBoundFromChannel = computed(() => {
  if (!props.fullsettings) return false
  const hasEpisodeIntro = Object.prototype.hasOwnProperty.call(props.fullsettings, 'channel_intro')
    || Object.prototype.hasOwnProperty.call(props.fullsettings?.intro || {}, 'channel_intro')
  return !hasEpisodeIntro && Object.prototype.hasOwnProperty.call(props.fullsettings, 'channel_intro_music')
})

function onChannelIntroPickerUpdate(picked: any): void {
  if (!introDraft.value) return
  if (!picked) {
    introDraft.value.channel_intro = null
    return
  }
  const current = introDraft.value.channel_intro
  introDraft.value.channel_intro = {
    ...picked,
    trim_start_sec: current?.trim_start_sec ?? 0,
    duration_sec: current?.duration_sec ?? null,
    fade_in_sec: current?.fade_in_sec ?? 0,
    fade_out_sec: current?.fade_out_sec ?? 0,
  }
}

const audioChanged = computed(() => {
  const current = draftState.value?.value.channel_intro ?? null
  const completed = completedMerge.value
  // Once a merge completed, its selection is what is pinned; reverting to the
  // baseline is a rebuild, not "no change".
  if (completed) return channelIntroKey(current) !== completed.key
  return !sameChannelIntro(current, baselineChannelIntro)
})

let unmounted = false
let abortWaiting: (() => void) | null = null

/**
 * Adopt only a path this draft CHANGED from its baseline. Browse never adopts;
 * an untouched or already-portable path is left exactly as it was.
 */
async function adoptChanged(raw: string, original: string, project: string, root: string): Promise<string> {
  const path = String(raw || '').trim()
  if (!path || path === String(original || '').trim() || isPortablePath(path)) return path
  if (!root) throw new Error('This channel is still loading — reopen this editor in a moment.')
  const result = await post<{ output?: string }>('/system/resolve-asset-path', {
    path,
    output_root: root,
    mode: 'adopt',
  })
  const output = String(result?.output || '').trim()
  if (!output || !isPortablePath(output) || output === path) {
    throw new Error(`${basename(path)} could not be saved into ${project}. Pick it again, or choose a file on this Mac.`)
  }
  return output
}

/** Wait on the existing jobs stream, not a new poller or a second endpoint. */
function waitForJob(jobId: string): Promise<{ status: 'done' | 'error' | 'cancelled'; error?: string }> {
  return new Promise((resolve) => {
    let stop = () => {}
    let settled = false
    const finish = (status: 'done' | 'error' | 'cancelled', message?: string) => {
      if (settled) return
      settled = true
      stop()
      if (abortWaiting === abort) abortWaiting = null
      resolve({ status, error: message })
    }
    const abort = () => finish('cancelled', 'The editor closed before Audio Assembly finished.')
    abortWaiting = abort
    stop = watch(jobs, (list) => {
      const job = list.find(entry => entry.job_id === jobId)
      if (!job) return
      if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') {
        finish(job.status, job.error || '')
      }
    }, { immediate: true })
    // A terminal record seen during the immediate run resolved before `stop`
    // was assigned; stop the watcher that was just created.
    if (settled) stop()
  })
}

/** The authoritative output name from the job's own final line, when the status read cannot name it. */
function jobOutputName(jobId: string): string {
  const job = jobs.value.find(entry => entry.job_id === jobId)
  const line = [...(job?.output_lines || [])]
    .reverse()
    .find(entry => /^Output:\s*\S+/.test(entry))
  return line ? basename(line.replace(/^Output:\s*/, '').trim()) : ''
}

/** A successful job names its own output; status must verify that same track after selection. */
async function pinMergedAudio(project: string, episode: string, jobId: string): Promise<string> {
  const filename = jobOutputName(jobId)
  if (!filename) {
    throw new Error('Audio Assembly finished, but Story could not name the new merged track. Nothing was pinned.')
  }
  const pinned = await put<any>(
    `/projects/${project}/video-editor/merged-audio/select/${episode}`,
    { filename },
  )
  if (String(pinned?.selected_merged_audio || '') !== filename) {
    throw new Error(`The new audio was built, but Story could not pin ${filename} for this episode.`)
  }
  // Before the pin, status may describe the previous track. Read it fresh only
  // after membership validation selects this job's output.
  const status = await get<any>(
    `/projects/${project}/episodes/${episode}/audio-merge-status`,
    { cache: 'no-store' },
  )
  if (!status?.present || basename(String(status.file || '')) !== filename) {
    throw new Error(`Audio Assembly selected ${filename}, but could not verify it: ${status?.reason || 'the new track is unavailable'}. The intro settings were not saved.`)
  }
  return filename
}

/**
 * Merge only this editor's intro fields into the CAPTURED episode's own
 * `video_assembly_last_used` entry. The channel starting point and every
 * preset stay exactly as they were (AGENTS §4/§5).
 */
async function persistOwnIntro(
  project: string,
  episode: string,
  intro: LegacyIntro,
  channelIntro: ChannelIntroSelection | null,
): Promise<void> {
  const code = String(episode || '').trim().toUpperCase()
  if (!project || !code) throw new Error('This editor needs a channel and an episode to save into.')
  const config = await get<any>(`/projects/${project}/settings/config`, { cache: 'no-store' })
  const store = (config?.[LAST_USED_CONFIG_KEY] || {}) as any
  const own = store.episodes?.[code]?.settings
  // A first per-episode Apply must not turn a full channel fallback into a
  // PARTIAL own entry, so seed missing slots from the snapshot taken on open.
  const base: Record<string, any> = own && typeof own === 'object'
    ? { ...own }
    : clone(baselineSettings)
  for (const slot of ['intro', 'timeline', 'effects', 'subtitles', 'export']) {
    if (base[slot] === undefined && baselineSettings?.[slot] !== undefined) {
      base[slot] = clone(baselineSettings[slot])
    }
  }
  base.intro = { ...(base.intro || {}), enabled: intro.enabled, video_path: intro.video_path }
  base.channel_intro = channelIntro ? { ...channelIntro } : null

  await put(`/projects/${project}/settings/config`, {
    [LAST_USED_CONFIG_KEY]: {
      ...store,
      episodes: {
        ...(store.episodes || {}),
        [code]: { episode_id: code, saved_at: new Date().toISOString(), settings: base },
      },
    },
  })
}

/**
 * The one write. A channel-intro change is a real rebuild through the existing
 * Audio Assembly preset — never a defaulted preset and never a renderer-side
 * soundtrack parameter. A video-only change writes the episode's own settings.
 */
async function saveIntro(
  value: IntroDraft,
  scope: AssemblyStepScope,
): Promise<{ merged?: string }> {
  try {
    return await saveIntroInner(value, scope)
  } catch (cause) {
    // applyAssemblyStepDraft keeps only an Error's message; carry the API's
    // plain detail across before that boundary.
    throw new Error(plainError(cause, 'Could not apply these intro settings.'))
  }
}

async function saveIntroInner(
  value: IntroDraft,
  scope: AssemblyStepScope,
): Promise<{ merged?: string }> {
  const project = String(scope.channel || '')
  const episode = String(scope.episode || '')
  const root = String(episodesRoot.value || '')
  const nextIntro: LegacyIntro = {
    enabled: value.intro.enabled === true,
    video_path: String(value.intro.video_path || '').trim(),
  }
  let nextChannelIntro = normalizeChannelIntro(value.channel_intro)

  nextIntro.video_path = await adoptChanged(
    nextIntro.video_path,
    baselineIntro.video_path,
    project,
    root,
  )

  const completedKey = completedMerge.value?.key
  const audioChanged = completedKey
    ? completedKey !== channelIntroKey(nextChannelIntro)
    : !sameChannelIntro(nextChannelIntro, baselineChannelIntro)
  // A completed merge is authoritative: a matching choice finishes pin/verify/
  // save, and any other choice (including reverting to the baseline) rebuilds.
  if (!completedKey && !audioChanged) {
    value.intro.video_path = nextIntro.video_path
    value.channel_intro = nextChannelIntro ? { ...nextChannelIntro } : null
    await persistOwnIntro(project, episode, nextIntro, nextChannelIntro)
    return {}
  }

  if (nextChannelIntro) {
    nextChannelIntro = {
      ...nextChannelIntro,
      file: await adoptChanged(nextChannelIntro.file, baselineChannelIntro?.file || '', project, root),
    }
    if (!isPortablePath(nextChannelIntro.file)) {
      throw new Error('This intro file could not be saved into the channel. Pick it again, or choose a file on this Mac.')
    }
  }
  // Show the portable paths the save actually used, never the raw picks.
  value.intro.video_path = nextIntro.video_path
  value.channel_intro = nextChannelIntro ? { ...nextChannelIntro } : null

  const mergeKey = channelIntroKey(nextChannelIntro)
  let jobId: string
  if (completedMerge.value?.key === mergeKey) {
    jobId = completedMerge.value.jobId
    pendingNote.value = 'Finishing this episode’s audio… Keep this window open until it finishes.'
  } else {
    const queued = await post<any>(`/projects/${project}/generate/audio-merge`, {
      episode_id: episode,
      reuse_saved_settings: true,
      // An explicit clear is `null`, never an absent key: the backend refuses an
      // unstated choice instead of defaulting one.
      channel_intro: nextChannelIntro
        ? {
            enabled: true,
            file: nextChannelIntro.file,
            volume: nextChannelIntro.volume,
            gap_after: nextChannelIntro.gap_after,
            trim_start_sec: nextChannelIntro.trim_start_sec ?? 0,
            duration_sec: nextChannelIntro.duration_sec ?? null,
            fade_in_sec: nextChannelIntro.fade_in_sec ?? 0,
            fade_out_sec: nextChannelIntro.fade_out_sec ?? 0,
          }
        : null,
      write_mode: 'new',
    })
    if (!queued?.job_id) throw new Error('Audio Assembly did not return a job to track.')
    jobId = String(queued.job_id)

    pendingJobId.value = jobId
    pendingNote.value = 'Rebuilding this episode’s audio with your saved Audio Assembly preset… Keep this window open until it finishes.'
    const terminal = await waitForJob(jobId)
    if (terminal.status !== 'done') {
      throw new Error(terminal.status === 'cancelled'
        ? 'Audio Assembly was cancelled. Nothing was changed for this episode.'
        : `Audio Assembly failed: ${terminal.error || 'see the job on the Jobs page for the reason.'}`)
    }
    // Only a terminal `done` is reusable; failed or cancelled jobs are never cached.
    completedMerge.value = { key: mergeKey, jobId }
  }

  const merged = await pinMergedAudio(project, episode, jobId)
  await persistOwnIntro(project, episode, nextIntro, nextChannelIntro)
  pendingNote.value = `Audio rebuilt and ${merged} pinned for this episode.`
  return { merged }
}

async function apply(): Promise<void> {
  if (!draftState.value || busy.value) return
  const currentScope = { channel: props.slug, episode: props.episodeId }
  applying.value = true
  error.value = ''
  let merged: string | undefined
  try {
    const result = await applyAssemblyStepDraft(
      draftState.value,
      currentScope,
      async (value, scope) => {
        const saved = await saveIntro(value, scope)
        merged = saved.merged
      },
    )
    if (result.ok === false) {
      error.value = result.error
      return
    }
    // The save is correct for the captured episode. If another episode is open
    // now, its form must not receive this one's selection (AGENTS §4).
    if (unmounted) return
    const captured = draftState.value.scope
    if (!sameAssemblyStepScope(captured, { channel: props.slug, episode: props.episodeId })) return
    const appliedIntro = {
      intro: { ...draftState.value.value.intro },
      channel_intro: normalizeChannelIntro(draftState.value.value.channel_intro),
      ...(merged ? { merged_audio: merged } : {}),
    }
    emit('applied', appliedIntro)
    emit('refresh')
  } catch (cause) {
    error.value = plainError(cause, 'Could not apply these intro settings.')
  } finally {
    pendingJobId.value = null
    abortWaiting = null
    applying.value = false
  }
}

function cancel(): void {
  if (busy.value) return
  if (draftState.value) cancelAssemblyStepDraft(draftState.value)
  emit('cancel')
}

onBeforeUnmount(() => {
  unmounted = true
  abortWaiting?.()
  if (draftState.value) cancelAssemblyStepDraft(draftState.value)
})
</script>

<style scoped>
/* Only a reset for the disabled-lock wrapper; the host's Modal keeps its padding. */
.assembly-intro-fields {
  border: 0;
  margin: 0;
  padding: 0;
  min-width: 0;
}

.assembly-intro-fields:disabled {
  opacity: 0.72;
}

.intro-trims-fades {
  padding-top: 0.25rem;
  border-top: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
}

.badge-subtle {
  font-size: 0.7rem;
  padding: 0.15rem 0.45rem;
  border-radius: 4px;
  background: var(--bg-surface-elevated, rgba(255, 255, 255, 0.08));
  color: var(--text-muted, #888);
}
</style>
