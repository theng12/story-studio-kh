<template>
  <div class="mp-card">
    <div class="mp-header">
      <div class="mp-title-row">
        <span class="mp-icon" aria-hidden="true">🎵</span>
        <h3 class="mp-title">Music Pool</h3>
        <span class="mp-count" v-if="state">{{ state.tracks.length }} track{{ state.tracks.length === 1 ? '' : 's' }}</span>
      </div>
      <button
        v-if="state"
        type="button"
        class="link-btn mp-folder-link"
        :title="`Copy ${state.folder} to the clipboard`"
        @click="revealFolder"
      >
        Copy folder path
      </button>
    </div>

    <p class="text-muted mp-intro">
      A project-scoped pool of background-music tracks for this channel. Files live in
      <code class="mp-mono">{project}/music/</code> — drop in via Finder OR use Add below.
      Pick a strategy and each new episode auto-cycles to a fresh track.
    </p>

    <div v-if="loading" class="text-muted mp-loading">Loading pool…</div>

    <template v-else-if="state">
      <!-- Strategy + lookback row -->
      <div class="mp-settings">
        <label class="mp-setting">
          <span class="mp-setting-label">Cycling strategy</span>
          <select v-model="strategy" class="select" @change="saveStrategy">
            <option value="sequential">Sequential — track1 → track2 → ... (wraps)</option>
            <option value="random-no-repeat">Random, no repeat in recent episodes</option>
            <option value="manual">Manual — pick per episode</option>
          </select>
        </label>
        <label v-if="strategy === 'random-no-repeat'" class="mp-setting">
          <span class="mp-setting-label">Lookback window</span>
          <input
            v-model.number="lookbackInput"
            type="number"
            class="input mp-lookback-input"
            :min="1"
            :max="50"
            @change="saveLookback"
          />
          <span class="text-muted mp-setting-hint">episodes</span>
        </label>
        <span v-if="strategy === 'sequential' && state.tracks.length > 0" class="text-muted mp-setting-hint">
          Cursor: {{ (state.cursor % enabledCount) + 1 }} / {{ enabledCount }}
          <button
            type="button"
            class="link-btn mp-cursor-reset"
            :disabled="state.cursor === 0"
            @click="resetCursor"
          >reset to 1</button>
        </span>
      </div>

      <!-- Track list -->
      <div v-if="safeTracks.length === 0" class="mp-empty">
        <p>Pool is empty. Drop audio files into <code class="mp-mono">{{ state.folder }}</code>
        via Finder, or click <strong>Add music</strong> below. Accepted: mp3 / wav / m4a / aac / ogg / flac.</p>
      </div>
      <div v-else class="mp-tracks">
        <!-- v1.0.133+ — Iterate `safeTracks` (a computed that filters
             out malformed entries from `state.tracks`) instead of the
             raw array, AND key by `t.path` instead of `t.filename`.
             Two layers of protection against the audio-merge.vue
             episode-change cascade race: a partial/sparse `state` ref
             from a midway-through-load fetch can't produce undefined
             entries here, and even if some other path delivers a track
             without a `filename` the v-for + :key still resolve (path
             is mandatory on PoolTrack, more stable as a unique key —
             user-edited labels rename `filename` semantically but the
             path stays). -->
        <template v-for="t in safeTracks" :key="t.path">
        <div
          class="mp-track"
          :class="{ 'mp-track-disabled': !t.enabled }"
        >
          <label class="mp-track-enable" :title="t.enabled ? 'Enabled — eligible for cycling' : 'Disabled — kept on disk but skipped by the cycler'">
            <input type="checkbox" :checked="t.enabled" @change="toggleEnabled(t)" />
          </label>
          <!-- v1.0.108+ — preview playback. Reuses one shared HTMLAudio -->
          <!-- element so multiple tracks can't play simultaneously (and -->
          <!-- the user doesn't have to find which row is making sound). -->
          <button
            type="button"
            class="btn-icon mp-track-play"
            :title="playingFilename === t.filename ? 'Stop preview' : `Preview ${t.label || t.filename}`"
            @click="togglePreview(t)"
          >
            <span v-if="playingFilename === t.filename">&#9724;</span>
            <span v-else>&#9654;</span>
          </button>
          <div class="mp-track-info">
            <input
              :value="t.label"
              type="text"
              class="mp-track-label"
              :placeholder="t.filename"
              @blur="onLabelBlur(t, ($event.target as HTMLInputElement).value)"
              @keydown.enter="($event.target as HTMLInputElement).blur()"
            />
            <div class="text-muted mp-track-filename" :title="t.path">
              {{ t.filename }}
              <span v-if="t.last_used_at" class="mp-track-last">
                · last used <strong>{{ formatRelative(t.last_used_at) }}</strong>
                <template v-if="t.last_used_episode"> ({{ t.last_used_episode }})</template>
              </span>
              <span v-else class="mp-track-last text-muted">· never used</span>
            </div>
          </div>
          <!-- v1.0.108+ — per-track override drawer toggle. Shows a dot -->
          <!-- when any override is set so the user can spot which tracks -->
          <!-- diverge from the form's globals at a glance. -->
          <button
            type="button"
            class="btn-icon mp-track-overrides-toggle"
            :class="{ 'has-overrides': trackHasOverrides(t) }"
            :title="trackHasOverrides(t)
              ? 'Per-track volume/fade overrides set (click to edit)'
              : 'Add per-track volume/fade overrides (otherwise inherits the merge form)'"
            @click="toggleOverrideDrawer(t.filename)"
          >
            <span v-if="trackHasOverrides(t)">●</span>
            <span v-else>⚙</span>
          </button>
          <button
            type="button"
            class="btn-icon danger mp-track-remove"
            title="Remove from the pool (moves the file to the project's _trash folder)"
            @click="removeTrack(t)"
          >&#10005;</button>
        </div>
        <!-- Override drawer — expandable, one-per-track inline. Edits -->
        <!-- save on blur (no Save button needed); null/empty clears the -->
        <!-- override so the track inherits the merge form's globals. -->
        <div
          v-if="openOverrideDrawer === t.filename"
          class="mp-overrides-drawer"
        >
          <div class="text-muted mp-overrides-hint">
            Per-track overrides apply WHEN this track is the one used in the merge.
            Leave a field blank to inherit the merge form's global value.
          </div>
          <div class="mp-overrides-grid">
            <label class="mp-overrides-field">
              <span class="mp-overrides-label">Volume during narration</span>
              <div class="mp-overrides-input-row">
                <input
                  type="number"
                  class="input"
                  min="0" max="100" step="1"
                  :value="t.volume ?? ''"
                  :placeholder="`Form: ${defaultVolumes.volume}%`"
                  @blur="updateOverride(t.filename, 'volume', ($event.target as HTMLInputElement).value)"
                />
                <span class="text-muted mp-overrides-unit">%</span>
              </div>
            </label>
            <label class="mp-overrides-field">
              <span class="mp-overrides-label">Volume after narration</span>
              <div class="mp-overrides-input-row">
                <input
                  type="number"
                  class="input"
                  min="0" max="100" step="1"
                  :value="t.post_narration_volume ?? ''"
                  :placeholder="`Form: ${defaultVolumes.post_narration_volume}%`"
                  @blur="updateOverride(t.filename, 'post_narration_volume', ($event.target as HTMLInputElement).value)"
                />
                <span class="text-muted mp-overrides-unit">%</span>
              </div>
            </label>
            <label class="mp-overrides-field">
              <span class="mp-overrides-label">Fade in</span>
              <div class="mp-overrides-input-row">
                <input
                  type="number"
                  class="input"
                  min="0" max="10" step="0.5"
                  :value="t.fade_in ?? ''"
                  :placeholder="`Form: ${defaultVolumes.fade_in}s`"
                  @blur="updateOverride(t.filename, 'fade_in', ($event.target as HTMLInputElement).value)"
                />
                <span class="text-muted mp-overrides-unit">s</span>
              </div>
            </label>
            <label class="mp-overrides-field">
              <span class="mp-overrides-label">Fade out</span>
              <div class="mp-overrides-input-row">
                <input
                  type="number"
                  class="input"
                  min="0" max="10" step="0.5"
                  :value="t.fade_out ?? ''"
                  :placeholder="`Form: ${defaultVolumes.fade_out}s`"
                  @blur="updateOverride(t.filename, 'fade_out', ($event.target as HTMLInputElement).value)"
                />
                <span class="text-muted mp-overrides-unit">s</span>
              </div>
            </label>
          </div>
          <button
            v-if="trackHasOverrides(t)"
            type="button"
            class="link-btn mp-overrides-clear"
            @click="clearAllOverrides(t)"
          >Clear all overrides for this track</button>
        </div>
        </template>
      </div>

      <div class="mp-actions">
        <button type="button" class="btn btn-sm btn-secondary" :disabled="adding" @click="addTrack">
          {{ adding ? 'Adding…' : '+ Add music…' }}
        </button>
        <button type="button" class="link-btn" @click="refresh" :disabled="loading">
          ↻ Rescan folder
        </button>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
/**
 * Music-pool management panel (v1.0.107+). Embedded on the Audio
 * Merge page above the music files block. Lets the user:
 *
 *   - Pick a cycling strategy (sequential / random-no-repeat / manual)
 *   - Tune the lookback window for random-no-repeat
 *   - Reset the sequential cursor
 *   - Toggle tracks on/off (kept on disk but skipped by the cycler)
 *   - Rename tracks (label only — filename on disk stays put)
 *   - Add new tracks via native file picker (copies into the project's
 *     music/ folder)
 *   - Remove tracks (moved to the project _trash, never hard-deleted)
 *
 * Auto-pick (the actual "use the cycler's choice on the next merge")
 * lives on the parent page — this component manages the POOL itself,
 * not the per-episode pick. Parent watches `enabled-tracks-changed`
 * to re-fetch the peek when the pool composition changes.
 */
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { useApi } from '~/composables/useApi'
import { useToast } from '~/composables/useToast'
import { pickFile } from '~/composables/usePathPicker'

interface PoolTrack {
  filename: string
  path: string
  enabled: boolean
  label: string
  last_used_at: string | null
  last_used_episode: string | null
  // v1.0.108+ per-track override knobs.
  volume?: number
  post_narration_volume?: number
  fade_in?: number
  fade_out?: number
}
interface PoolState {
  strategy: 'sequential' | 'random-no-repeat' | 'manual'
  cursor: number
  lookback: number
  tracks: PoolTrack[]
  recent_usage: Array<{ filename: string; episode_code: string; used_at: string }>
  folder: string
}

const props = defineProps<{
  projectSlug: string
  /** v1.0.108+ — the merge form's current global volume/fade values.
   *  Surfaced as placeholders inside the per-track override drawer so
   *  the user sees what they're inheriting. Parent passes a snapshot
   *  of the music reactive object's vol/fade/post_narration_volume. */
  defaultVolumes?: {
    volume: number
    post_narration_volume: number
    fade_in: number
    fade_out: number
  }
}>()

const defaultVolumes = computed(() => props.defaultVolumes || {
  volume: 15,
  post_narration_volume: 40,
  fade_in: 3,
  fade_out: 5,
})

const emit = defineEmits<{
  /** Fired after any change that affects what the cycler would pick
   *  (strategy change, lookback change, cursor reset, track add/remove/
   *  enable toggle). Parent uses this to re-fetch the peek so the
   *  Audio Merge form reflects the new "next track". */
  'pool-changed': []
}>()

const { get, put, post, patch, del } = useApi()
const { success: toastSuccess, error: toastError } = useToast()

const loading = ref(false)
const state = ref<PoolState | null>(null)
const strategy = ref<'sequential' | 'random-no-repeat' | 'manual'>('sequential')
const lookbackInput = ref(5)
const adding = ref(false)

// v1.0.108+ — single-instance preview playback. One audio element, one
// playingFilename ref; clicking another track stops the current one
// before starting the new playback so the panel never produces overlap-
// ping sound. Uses the existing /video-editor/preview-image-style
// static-pass-through endpoint? No — audio files need a real GET path.
// We reuse the audio-merge preview endpoint that already serves bytes
// from any project path the backend can read.
const previewAudio = ref<HTMLAudioElement | null>(null)
const playingFilename = ref('')

function togglePreview(t: PoolTrack) {
  // Same track playing → stop. Different track → swap source, play.
  // Filesystem path → audio-editor preview URL (auth + range-supported).
  if (playingFilename.value === t.filename) {
    previewAudio.value?.pause()
    previewAudio.value = null
    playingFilename.value = ''
    return
  }
  if (previewAudio.value) {
    previewAudio.value.pause()
    previewAudio.value = null
  }
  const url = `/api/projects/${props.projectSlug}/audio-editor/preview-audio?path=${encodeURIComponent(t.path)}`
  const audio = new Audio(url)
  audio.addEventListener('ended', () => {
    if (playingFilename.value === t.filename) {
      playingFilename.value = ''
      previewAudio.value = null
    }
  })
  audio.addEventListener('error', () => {
    toastError(`Could not preview ${t.filename} — check that the file is readable.`)
    if (playingFilename.value === t.filename) {
      playingFilename.value = ''
      previewAudio.value = null
    }
  })
  previewAudio.value = audio
  playingFilename.value = t.filename
  void audio.play().catch(() => {
    // Autoplay may be blocked in some contexts; the catch lets the
    // browser surface its own error UX rather than us swallowing it.
    if (playingFilename.value === t.filename) {
      playingFilename.value = ''
      previewAudio.value = null
    }
  })
}

// Stop any preview when the component unmounts so audio doesn't bleed
// into the next page.
onBeforeUnmount(() => {
  previewAudio.value?.pause()
  previewAudio.value = null
})

const enabledCount = computed(() => state.value?.tracks.filter(t => t.enabled).length || 0)

// v1.0.133+ — Defensive filter for the template v-for. The audio-merge
// page's episode-change cascade fans out reactive triggers fast enough
// that the v-for can render against a transient `state` where one or
// more `tracks[i]` is undefined or missing required fields (e.g. mid-
// fetch overwrite, sparse-array edge from a malformed backend response,
// or two concurrent refresh()es from the parent's `refreshPoolPeek()` +
// this panel's own onMounted refresh()). Without this guard, the v-for
// hits `t.filename` (now `t.path`) on undefined and the render throws
// "Cannot read properties of undefined (reading …)" — visible in
// DevTools, doesn't crash the page but spams the console on every
// episode switch.
//
// Strict filter: must be an object with BOTH a non-empty path and a
// filename. Drops sparse / partial entries without surfacing an error
// (the user doesn't need to see "1 malformed track skipped" — the
// missing entry is a backend bug, not an operator concern).
const safeTracks = computed(() => {
  const raw = state.value?.tracks
  if (!Array.isArray(raw)) return []
  return raw.filter(t => t && typeof t.path === 'string' && t.path && typeof t.filename === 'string')
})

async function refresh() {
  loading.value = true
  try {
    const r = await get<PoolState>(`/projects/${props.projectSlug}/music-pool`)
    state.value = r
    strategy.value = r.strategy
    lookbackInput.value = r.lookback
  } catch (e: any) {
    toastError(e?.data?.detail || 'Could not load music pool')
  } finally {
    loading.value = false
  }
}

async function saveStrategy() {
  try {
    await put(`/projects/${props.projectSlug}/music-pool`, { strategy: strategy.value })
    await refresh()
    emit('pool-changed')
  } catch (e: any) {
    toastError(e?.data?.detail || 'Could not save strategy')
  }
}

async function saveLookback() {
  const v = Number(lookbackInput.value)
  if (!Number.isFinite(v) || v <= 0) return
  try {
    await put(`/projects/${props.projectSlug}/music-pool`, { lookback: v })
    await refresh()
    emit('pool-changed')
  } catch (e: any) {
    toastError(e?.data?.detail || 'Could not save lookback')
  }
}

async function resetCursor() {
  try {
    await put(`/projects/${props.projectSlug}/music-pool`, { cursor: 0 })
    await refresh()
    emit('pool-changed')
    toastSuccess('Sequential cursor reset to 1')
  } catch (e: any) {
    toastError(e?.data?.detail || 'Could not reset cursor')
  }
}

async function toggleEnabled(t: PoolTrack) {
  try {
    await patch(`/projects/${props.projectSlug}/music-pool/tracks/${encodeURIComponent(t.filename)}`, {
      enabled: !t.enabled,
    })
    await refresh()
    emit('pool-changed')
  } catch (e: any) {
    toastError(e?.data?.detail || 'Could not toggle track')
  }
}

// v1.0.108+ — per-track override drawer state. Only ONE drawer open
// at a time keeps the panel compact even with a 10-track pool.
const openOverrideDrawer = ref('')

function toggleOverrideDrawer(filename: string) {
  openOverrideDrawer.value = openOverrideDrawer.value === filename ? '' : filename
}

function trackHasOverrides(t: PoolTrack): boolean {
  return typeof t.volume === 'number'
    || typeof t.post_narration_volume === 'number'
    || typeof t.fade_in === 'number'
    || typeof t.fade_out === 'number'
}

/** Save a per-track override. Empty/blank input clears the override
 *  (track inherits the merge form's global). */
async function updateOverride(
  filename: string,
  key: 'volume' | 'post_narration_volume' | 'fade_in' | 'fade_out',
  raw: string,
) {
  const trimmed = (raw || '').trim()
  // Empty input = clear the override (PATCH with null tells the backend
  // to delete the field; see updateTrackMeta in music-pool.ts).
  let value: number | null
  if (trimmed === '') {
    value = null
  } else {
    const n = Number(trimmed)
    if (!Number.isFinite(n) || n < 0) return
    value = n
  }
  try {
    await patch(`/projects/${props.projectSlug}/music-pool/tracks/${encodeURIComponent(filename)}`, {
      [key]: value,
    })
    await refresh()
    emit('pool-changed')
  } catch (e: any) {
    toastError(e?.data?.detail || 'Could not save override')
  }
}

async function clearAllOverrides(t: PoolTrack) {
  try {
    await patch(`/projects/${props.projectSlug}/music-pool/tracks/${encodeURIComponent(t.filename)}`, {
      volume: null,
      post_narration_volume: null,
      fade_in: null,
      fade_out: null,
    })
    await refresh()
    emit('pool-changed')
    toastSuccess(`Cleared all overrides for "${t.label || t.filename}"`)
  } catch (e: any) {
    toastError(e?.data?.detail || 'Could not clear overrides')
  }
}

async function onLabelBlur(t: PoolTrack, newLabel: string) {
  const trimmed = newLabel.trim()
  if (trimmed === t.label) return
  try {
    await patch(`/projects/${props.projectSlug}/music-pool/tracks/${encodeURIComponent(t.filename)}`, {
      label: trimmed,
    })
    await refresh()
  } catch (e: any) {
    toastError(e?.data?.detail || 'Could not save label')
  }
}

async function removeTrack(t: PoolTrack) {
  const { ask } = useConfirm()
  if (!await ask({ title: 'Remove music track?', message: `Remove "${t.filename}" from the music pool? The file moves to this project's _trash folder, so you can put it back from Finder.`, confirmLabel: 'Remove', danger: true })) return
  try {
    await del(`/projects/${props.projectSlug}/music-pool/tracks/${encodeURIComponent(t.filename)}`)
    await refresh()
    emit('pool-changed')
    toastSuccess(`Removed ${t.filename}`)
  } catch (e: any) {
    toastError(e?.data?.detail || 'Could not remove track')
  }
}

async function addTrack() {
  if (adding.value) return
  const picked = await pickFile({
    title: 'Pick a music file to add to the pool',
    extensions: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'],
  })
  if (!picked) return
  adding.value = true
  try {
    const r = await post<{ filename: string }>(`/projects/${props.projectSlug}/music-pool/tracks`, {
      source_path: picked,
    })
    await refresh()
    emit('pool-changed')
    toastSuccess(`Added ${r.filename}`)
  } catch (e: any) {
    toastError(e?.data?.detail || 'Could not add track')
  } finally {
    adding.value = false
  }
}

function revealFolder() {
  // Best-effort: the system pick-folder endpoint can open a folder;
  // for now we just toast the path so the user can open it manually.
  if (!state.value?.folder) return
  // Copy to clipboard for convenience.
  try {
    navigator.clipboard?.writeText(state.value.folder)
    toastSuccess(`Folder path copied: ${state.value.folder}`)
  } catch {
    toastSuccess(state.value.folder)
  }
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime()
  const now = Date.now()
  const diffMs = now - then
  const mins = Math.floor(diffMs / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 14) return `${days}d ago`
  return new Date(iso).toLocaleDateString()
}

onMounted(refresh)
watch(() => props.projectSlug, refresh)

// Expose a refresh method for the parent to call after a merge job
// completes (so last_used_at + cursor update without a full reload).
defineExpose({ refresh })
</script>

<style scoped>
.mp-card {
  margin-top: 8px;
  padding: 14px 16px;
  background: var(--bg-tertiary, #1d1d22);
  border-radius: var(--radius-md, 8px);
  border-left: 3px solid #b39dff;
  font-size: 13px;
  color: var(--text-primary, #e8e8ea);
}
.mp-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 6px;
}
.mp-title-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.mp-icon {
  font-size: 14px;
}
.mp-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
.mp-count {
  font-size: var(--font-xs);
  color: var(--text-secondary, #b3b3bb);
}
.mp-folder-link {
  font-size: var(--font-xs);
}
.mp-intro {
  margin: 0 0 12px;
  font-size: 12px;
  line-height: 1.5;
}
.mp-mono {
  background: rgba(255, 255, 255, 0.06);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: var(--font-xs);
  font-family: var(--mono, ui-monospace, SFMono-Regular, monospace);
}
.mp-loading {
  padding: 12px 0;
  text-align: center;
  font-size: 12px;
}

/* Strategy + lookback row */
.mp-settings {
  display: flex;
  align-items: flex-end;
  gap: 16px;
  flex-wrap: wrap;
  padding: 10px 12px;
  background: rgba(255, 255, 255, 0.02);
  border-radius: 6px;
  margin-bottom: 10px;
}
.mp-setting {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.mp-setting-label {
  font-size: var(--font-xs);
  color: var(--text-secondary, #b3b3bb);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.mp-setting-hint {
  font-size: var(--font-xs);
}
.mp-lookback-input {
  width: 80px;
}
.mp-cursor-reset {
  margin-left: 8px;
  font-size: var(--font-xs);
}

/* Empty state */
.mp-empty {
  padding: 16px;
  background: rgba(255, 255, 255, 0.02);
  border-radius: 6px;
  text-align: center;
}
.mp-empty p {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-secondary, #b3b3bb);
}

/* Track list */
.mp-tracks {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.mp-track {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  background: rgba(255, 255, 255, 0.02);
  border-radius: 6px;
  border: 1px solid transparent;
  transition: background 0.1s;
}
.mp-track:hover {
  background: rgba(255, 255, 255, 0.04);
}
.mp-track-disabled {
  opacity: 0.55;
}
.mp-track-enable input {
  width: 16px;
  height: 16px;
  cursor: pointer;
}
.mp-track-play {
  flex-shrink: 0;
}
.mp-track-overrides-toggle {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--text-secondary);
}
.mp-track-overrides-toggle.has-overrides {
  color: #b39dff;
}
.mp-overrides-drawer {
  margin: 6px 0 10px 28px;
  padding: 10px 12px;
  background: rgba(255, 255, 255, 0.03);
  border-radius: 6px;
  border-left: 2px solid rgba(179, 157, 255, 0.4);
}
.mp-overrides-hint {
  font-size: var(--font-xs);
  line-height: 1.45;
  margin-bottom: 8px;
}
.mp-overrides-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 8px 12px;
}
.mp-overrides-field {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.mp-overrides-label {
  font-size: var(--font-xs);
  color: var(--text-secondary);
}
.mp-overrides-input-row {
  display: flex;
  align-items: center;
  gap: 4px;
}
.mp-overrides-input-row input {
  width: 70px;
  font-size: 12px;
  padding: 2px 6px;
}
.mp-overrides-unit {
  font-size: var(--font-xs);
}
.mp-overrides-clear {
  display: inline-block;
  margin-top: 8px;
  font-size: var(--font-xs);
}
.mp-track-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.mp-track-label {
  background: transparent;
  border: 1px solid transparent;
  padding: 2px 6px;
  font-size: 13px;
  color: var(--text-primary, #e8e8ea);
  border-radius: 4px;
  width: 100%;
}
.mp-track-label:hover,
.mp-track-label:focus {
  background: rgba(255, 255, 255, 0.04);
  border-color: rgba(255, 255, 255, 0.12);
  outline: none;
}
.mp-track-filename {
  font-size: var(--font-xs);
  font-family: var(--mono, ui-monospace, SFMono-Regular, monospace);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding-left: 6px;
}
.mp-track-last {
  font-style: normal;
}
.mp-track-remove {
  flex-shrink: 0;
}

.mp-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 12px;
}
</style>
