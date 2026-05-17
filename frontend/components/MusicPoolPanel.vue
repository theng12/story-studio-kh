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
        :title="`Open ${state.folder} in Finder`"
        @click="revealFolder"
      >
        Show folder in Finder ↗
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
      <div v-if="state.tracks.length === 0" class="mp-empty">
        <p>Pool is empty. Drop audio files into <code class="mp-mono">{{ state.folder }}</code>
        via Finder, or click <strong>Add music</strong> below. Accepted: mp3 / wav / m4a / aac / ogg / flac.</p>
      </div>
      <div v-else class="mp-tracks">
        <div
          v-for="t in state.tracks"
          :key="t.filename"
          class="mp-track"
          :class="{ 'mp-track-disabled': !t.enabled }"
        >
          <label class="mp-track-enable" :title="t.enabled ? 'Enabled — eligible for cycling' : 'Disabled — kept on disk but skipped by the cycler'">
            <input type="checkbox" :checked="t.enabled" @change="toggleEnabled(t)" />
          </label>
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
          <button
            type="button"
            class="btn-icon danger mp-track-remove"
            title="Remove from disk"
            @click="removeTrack(t)"
          >&#10005;</button>
        </div>
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
 *   - Remove tracks (deletes from disk)
 *
 * Auto-pick (the actual "use the cycler's choice on the next merge")
 * lives on the parent page — this component manages the POOL itself,
 * not the per-episode pick. Parent watches `enabled-tracks-changed`
 * to re-fetch the peek when the pool composition changes.
 */
import { ref, computed, onMounted, watch } from 'vue'
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
}>()

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

const enabledCount = computed(() => state.value?.tracks.filter(t => t.enabled).length || 0)

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
  if (!confirm(`Delete "${t.filename}" from the music pool? This removes the file from disk.`)) return
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
  font-size: 11px;
  color: var(--text-secondary, #b3b3bb);
}
.mp-folder-link {
  font-size: 11px;
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
  font-size: 11px;
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
  font-size: 11px;
  color: var(--text-secondary, #b3b3bb);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.mp-setting-hint {
  font-size: 11px;
}
.mp-lookback-input {
  width: 80px;
}
.mp-cursor-reset {
  margin-left: 8px;
  font-size: 11px;
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
  font-size: 11px;
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
