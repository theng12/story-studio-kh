<template>
  <div class="channel-youtube-settings">
    <header class="settings-header">
      <div class="header-titles">
        <span class="eyebrow">YouTube Channel Settings</span>
        <h3>Playlists &amp; End-Screen Plan</h3>
        <p>
          Choose the default playlist for new uploads, and record the end-screen plan you will
          apply by hand in YouTube Studio.
        </p>
      </div>
      <div class="header-actions">
        <button
          class="btn btn-sm"
          type="button"
          :disabled="loading || busy !== ''"
          @click="loadSettings(true)"
          title="Refresh playlists and settings from cache or remote"
        >
          <span v-if="busy === 'refresh'">Refreshing…</span>
          <span v-else>↻ Refresh Playlists</span>
        </button>
      </div>
    </header>

    <div v-if="loading" class="panel loading-state">
      <p class="hint">Loading YouTube channel settings…</p>
    </div>

    <div v-else-if="loadError" class="panel recovery" role="alert">
      <p class="result err">{{ loadError }}</p>
      <div class="field-row">
        <button class="btn btn-sm btn-primary" type="button" @click="loadSettings(false)">
          Try Again
        </button>
      </div>
    </div>

    <template v-else>
      <!-- ── Section 1: Playlist Inventory & Default Assignment ──────────────── -->
      <section class="panel playlist-inventory-panel">
        <div class="panel-head">
          <div>
            <span class="eyebrow">Remote Integration</span>
            <h4>Playlist Series Inventory</h4>
            <p class="hint">
              YouTube Data API v3 supports playlist inventory and adding uploaded videos to a playlist.
              Select a default playlist to automatically assign new uploads.
            </p>
          </div>
          <div v-if="inventory.cached_at" class="cache-pill">
            Cached {{ formatCacheAge(inventory.cached_at) }}
          </div>
        </div>

        <div v-if="!inventory.has_connected_account" class="unconnected-state">
          <p class="notice">
            No YouTube channel is currently assigned to this project. Connect an account in
            <strong>This Mac &rarr; Connections</strong> and assign it under
            <strong>Publishing</strong> to load live playlist inventory.
          </p>
        </div>

        <div v-else class="inventory-content">
          <!-- Default Playlist Selector -->
          <div class="default-playlist-box">
            <label for="default-playlist-select" class="field-label">
              Default Upload Playlist
            </label>
            <div class="field-row">
              <select
                id="default-playlist-select"
                v-model="defaultPlaylistDraft"
                class="input"
                aria-label="Default Upload Playlist"
              >
                <option value="">None (Do not auto-add to a playlist)</option>
                <option
                  v-for="pl in inventory.playlists"
                  :key="pl.id"
                  :value="pl.id"
                >
                  {{ pl.title }} ({{ pl.itemCount }} {{ pl.itemCount === 1 ? 'video' : 'videos' }})
                </option>
              </select>
              <button
                class="btn btn-sm btn-primary"
                type="button"
                :disabled="busy !== '' || defaultPlaylistDraft === inventory.default_playlist_id"
                @click="saveDefaultPlaylist"
              >
                {{ busy === 'playlist' ? 'Saving…' : 'Set Default' }}
              </button>
            </div>
            <p class="field-hint">
              When an episode completes upload, Story Studio adds it to this playlist automatically.
            </p>
          </div>

          <!-- Playlists List -->
          <div class="playlists-list-container">
            <div class="list-summary-bar">
              <span class="list-count">
                {{ inventory.playlists.length }} {{ inventory.playlists.length === 1 ? 'Playlist' : 'Playlists' }} Found
              </span>
              <span class="quota-note">Quota-efficient: cached 60s</span>
            </div>

            <div v-if="inventory.playlists.length === 0" class="empty-playlists">
              <p class="hint">No playlists found on the connected YouTube channel.</p>
            </div>

            <ul v-else class="playlist-cards" role="list">
              <li
                v-for="pl in inventory.playlists"
                :key="pl.id"
                class="playlist-card"
                :class="{ 'is-default': pl.id === inventory.default_playlist_id }"
              >
                <div class="card-main">
                  <div class="card-title-row">
                    <strong class="playlist-title">{{ pl.title }}</strong>
                    <span v-if="pl.id === inventory.default_playlist_id" class="badge badge-default">
                      Default Playlist
                    </span>
                    <span :class="['badge', `badge-${pl.privacyStatus}`]">
                      {{ pl.privacyStatus }}
                    </span>
                  </div>
                  <p v-if="pl.description" class="playlist-desc">{{ pl.description }}</p>
                  <div class="card-meta">
                    <span class="item-count">{{ pl.itemCount }} {{ pl.itemCount === 1 ? 'item' : 'items' }}</span>
                    <code class="playlist-id">{{ pl.id }}</code>
                  </div>
                </div>
                <div class="card-actions">
                  <button
                    v-if="pl.id !== inventory.default_playlist_id"
                    class="btn btn-xs"
                    type="button"
                    :disabled="busy !== ''"
                    @click="setDefaultPlaylistFromCard(pl.id)"
                  >
                    Make Default
                  </button>
                </div>
              </li>
            </ul>
          </div>
        </div>
      </section>

      <!-- ── Section 2: End-Screen Setup Plan (manual, no API write) ──────────── -->
      <section class="panel end-screen-panel">
        <div class="panel-head">
          <div>
            <span class="eyebrow">Manual Plan</span>
            <h4>End-Screen Setup Plan</h4>
            <p class="hint">
              Story Studio saves your plan and writes out the steps to follow in YouTube Studio's
              editor. Nothing is sent to YouTube from here.
            </p>
          </div>
        </div>

        <!-- Honest capability callout -->
        <div class="capability-callout" role="note">
          <div class="callout-header">
            <span class="status-indicator"></span>
            <strong>Not supported by the YouTube API — manual plan only</strong>
          </div>
          <p>
            YouTube Data API v3 has no official endpoint for end screens, so Story Studio never
            writes one. The settings below are your plan; the steps underneath are what you apply
            by hand in YouTube Studio &rarr; Video details &rarr; Editor &rarr; End screen.
          </p>
        </div>

        <div class="plan-body">
          <!-- Window setting -->
          <div class="control-group">
            <div class="group-label-row">
              <label for="plan-window-slider" class="field-label">
                End-screen window (last seconds of the video)
              </label>
              <span class="duration-display">
                <strong>{{ endScreenDraft.duration_seconds }}s</strong>
                <span class="sub-duration">({{ formatSecondsToTimestamp(endScreenDraft.duration_seconds) }})</span>
              </span>
            </div>
            <input
              id="plan-window-slider"
              type="range"
              min="5"
              max="20"
              step="1"
              v-model.number="endScreenDraft.duration_seconds"
              class="slider"
              aria-label="End-screen window in seconds at the end of the video"
            />
            <div class="range-bounds">
              <span>5s (YouTube minimum)</span>
              <span>20s (YouTube maximum)</span>
            </div>
            <p class="field-hint">
              Bounds from YouTube Help, “Add end screens to videos”: the last 5–20 seconds, and the
              video must be at least 25 seconds long.
            </p>
          </div>

          <!-- Template Presets -->
          <div class="control-group">
            <label class="field-label">Layout Template</label>
            <div class="template-grid">
              <button
                v-for="(tpl, key) in END_SCREEN_TEMPLATES"
                :key="key"
                type="button"
                class="template-card"
                :class="{ 'is-selected': endScreenDraft.template === key }"
                @click="applyTemplate(key)"
              >
                <div class="template-card-title">{{ tpl.label }}</div>
                <div class="template-card-desc">{{ tpl.description }}</div>
              </button>
            </div>
          </div>

          <!-- Planned Elements List -->
          <div class="control-group">
            <div class="group-label-row">
              <label class="field-label">Planned Elements (max 4)</label>
              <span class="count-badge">{{ endScreenDraft.elements.length }}/4 Slots</span>
            </div>

            <div class="elements-list">
              <div
                v-for="(elem, idx) in endScreenDraft.elements"
                :key="elem.id"
                class="element-row"
              >
                <span class="element-slot">Slot {{ idx + 1 }}</span>

                <select
                  v-model="elem.type"
                  class="input input-sm element-type-select"
                  @change="onElementTypeChanged(elem)"
                >
                  <option value="subscribe">Subscribe Button</option>
                  <option value="playlist">Playlist Card</option>
                  <option value="best_for_viewer">Video: Best for Viewer</option>
                  <option value="latest_upload">Video: Most Recent Upload</option>
                  <option value="specific_video">Specific Video</option>
                </select>

                <!-- If Playlist, allow picking from inventory -->
                <select
                  v-if="elem.type === 'playlist'"
                  v-model="elem.playlist_id"
                  class="input input-sm element-playlist-select"
                >
                  <option value="">Default Channel Playlist</option>
                  <option
                    v-for="pl in inventory.playlists"
                    :key="pl.id"
                    :value="pl.id"
                  >
                    {{ pl.title }}
                  </option>
                </select>

                <!-- If Specific Video, provide input -->
                <input
                  v-else-if="elem.type === 'specific_video'"
                  v-model="elem.custom_video_id"
                  type="text"
                  placeholder="Video ID or URL"
                  class="input input-sm element-video-input"
                />

                <input
                  v-model="elem.label"
                  type="text"
                  placeholder="Element Label"
                  class="input input-sm element-label-input"
                />

                <button
                  type="button"
                  class="btn btn-ghost btn-xs btn-remove"
                  :disabled="endScreenDraft.elements.length <= 1"
                  @click="removeElement(idx)"
                  title="Remove slot"
                >
                  ✕
                </button>
              </div>

              <button
                v-if="endScreenDraft.elements.length < 4"
                type="button"
                class="btn btn-sm btn-ghost btn-add-element"
                @click="addElement"
              >
                + Add End-Screen Element Slot
              </button>
            </div>
            <p class="field-hint">
              YouTube allows up to four elements on standard 16:9 videos; other aspect ratios may
              allow fewer.
            </p>
          </div>

          <!-- Manual instructions -->
          <div class="guidance-box">
            <div class="guidance-head">
              <span class="guidance-title">Steps to apply in YouTube Studio</span>
              <button
                type="button"
                class="btn btn-xs"
                @click="copyStudioGuidance"
              >
                {{ copied ? '✓ Copied' : 'Copy Instructions' }}
              </button>
            </div>
            <pre class="guidance-text">{{ studioGuidance }}</pre>
          </div>
        </div>
      </section>

      <!-- ── Footer Action Bar ──────────────────────────────────────────────── -->
      <footer class="settings-footer">
        <div class="footer-left">
          <p v-if="saveResult" :class="['result', saveResult.kind]">
            {{ saveResult.message }}
          </p>
        </div>
        <div class="footer-right">
          <button
            class="btn btn-sm"
            type="button"
            :disabled="busy !== ''"
            @click="resetDrafts"
          >
            Reset
          </button>
          <button
            class="btn btn-sm btn-primary"
            type="button"
            :disabled="busy !== ''"
            @click="saveAllSettings"
          >
            {{ busy === 'save-all' ? 'Saving…' : 'Save Settings' }}
          </button>
        </div>
      </footer>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import {
  type PlaylistInventoryState,
  type EndScreenConfig,
  type EndScreenElement,
  type EndScreenTemplateId,
  END_SCREEN_TEMPLATES,
  createDefaultEndScreenConfig,
  normalizeEndScreenConfig,
  buildYouTubeStudioGuidance,
  formatSecondsToTimestamp,
} from '../../electron/server/contracts/youtube-channel-settings.js'

const props = defineProps<{
  slug: string
  accountId?: string
}>()

const emit = defineEmits<{
  (e: 'saved', settings: { defaultPlaylistId: string; endScreenPlan: EndScreenConfig }): void
}>()

const { get, put } = useApi()

const loading = ref(true)
const loadError = ref('')
const busy = ref('')
const copied = ref(false)

const inventory = ref<PlaylistInventoryState>({
  account_id: '',
  playlists: [],
  default_playlist_id: '',
  cached_at: null,
  count: 0,
  has_connected_account: false,
})

const defaultPlaylistDraft = ref('')
const endScreenDraft = ref<EndScreenConfig>(createDefaultEndScreenConfig())
const saveResult = ref<{ kind: 'ok' | 'warn' | 'err'; message: string } | null>(null)

function formatCacheAge(timestamp: number | null): string {
  if (!timestamp) return 'recently'
  const seconds = Math.floor((Date.now() - timestamp) / 1000)
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ago`
}

const studioGuidance = computed(() => {
  const defaultPl = inventory.value.playlists.find(
    (p) => p.id === (defaultPlaylistDraft.value || inventory.value.default_playlist_id),
  )
  return buildYouTubeStudioGuidance(
    endScreenDraft.value,
    undefined,
    defaultPl?.title,
  )
})

async function copyStudioGuidance(): Promise<void> {
  try {
    await navigator.clipboard.writeText(studioGuidance.value)
    copied.value = true
    setTimeout(() => {
      copied.value = false
    }, 2500)
  } catch {
    saveResult.value = { kind: 'warn', message: 'Could not copy to clipboard automatically.' }
  }
}

function applyTemplate(key: EndScreenTemplateId): void {
  endScreenDraft.value.template = key
  const defaultPlId = defaultPlaylistDraft.value || inventory.value.default_playlist_id
  endScreenDraft.value.elements = END_SCREEN_TEMPLATES[key].elements(defaultPlId)
}

function onElementTypeChanged(elem: EndScreenElement): void {
  if (elem.type === 'playlist') {
    elem.label = 'Series Playlist'
    elem.playlist_id = defaultPlaylistDraft.value || inventory.value.default_playlist_id || ''
  } else if (elem.type === 'subscribe') {
    elem.label = 'Subscribe'
    elem.playlist_id = undefined
  } else if (elem.type === 'best_for_viewer') {
    elem.label = 'Best for viewer'
    elem.playlist_id = undefined
  } else if (elem.type === 'latest_upload') {
    elem.label = 'Latest upload'
    elem.playlist_id = undefined
  } else if (elem.type === 'specific_video') {
    elem.label = 'Specific Video'
    elem.playlist_id = undefined
  }
}

function addElement(): void {
  if (endScreenDraft.value.elements.length >= 4) return
  const nextIdx = endScreenDraft.value.elements.length + 1
  endScreenDraft.value.elements.push({
    id: `elem_${Date.now()}_${nextIdx}`,
    type: 'subscribe',
    label: 'Subscribe',
  })
}

function removeElement(idx: number): void {
  if (endScreenDraft.value.elements.length <= 1) return
  endScreenDraft.value.elements.splice(idx, 1)
}

async function loadSettings(force = false): Promise<void> {
  loading.value = true
  loadError.value = ''
  saveResult.value = null
  if (force) busy.value = 'refresh'

  try {
    // 1. Load playlists from upload playlists endpoint
    const params = new URLSearchParams()
    if (force) params.set('force', '1')
    if (props.accountId) params.set('account_id', props.accountId)
    const qs = params.toString()
    let plData: any = null
    try {
      plData = await get<any>(`/projects/${props.slug}/upload/playlists${qs ? `?${qs}` : ''}`)
    } catch {
      // Channel may not be assigned yet
      plData = null
    }

    if (plData) {
      inventory.value = {
        account_id: plData.account_id || '',
        playlists: Array.isArray(plData.playlists) ? plData.playlists : [],
        default_playlist_id: plData.default_playlist_id || '',
        cached_at: Date.now(),
        count: Array.isArray(plData.playlists) ? plData.playlists.length : 0,
        has_connected_account: Boolean(plData.account_id),
      }
      defaultPlaylistDraft.value = plData.default_playlist_id || ''
    } else {
      inventory.value = {
        account_id: '',
        playlists: [],
        default_playlist_id: '',
        cached_at: null,
        count: 0,
        has_connected_account: false,
      }
      defaultPlaylistDraft.value = ''
    }

    // 2. Load project configuration for the end-screen plan and playlist default
    const config = await get<any>(`/projects/${props.slug}/settings/config`)
    if (config?.youtube_end_screen) {
      endScreenDraft.value = normalizeEndScreenConfig(
        config.youtube_end_screen,
        defaultPlaylistDraft.value,
      )
    } else {
      endScreenDraft.value = createDefaultEndScreenConfig(defaultPlaylistDraft.value)
    }

    if (
      !defaultPlaylistDraft.value &&
      config?.youtube_default_playlist &&
      inventory.value.account_id
    ) {
      defaultPlaylistDraft.value = config.youtube_default_playlist[inventory.value.account_id] || ''
    }
  } catch (error: any) {
    loadError.value = messageOf(error, 'Could not load YouTube channel settings.')
  } finally {
    loading.value = false
    busy.value = ''
  }
}

function messageOf(error: any, fallback: string): string {
  return error?.data?.detail || error?.data?.message || error?.message || fallback
}

async function setDefaultPlaylistFromCard(playlistId: string): Promise<void> {
  defaultPlaylistDraft.value = playlistId
  await saveDefaultPlaylist()
}

async function saveDefaultPlaylist(): Promise<void> {
  const accountId = inventory.value.account_id
  if (!accountId) {
    saveResult.value = { kind: 'warn', message: 'No YouTube channel is connected.' }
    return
  }

  busy.value = 'playlist'
  saveResult.value = null
  try {
    const config = (await get<any>(`/projects/${props.slug}/settings/config`)) || {}
    const existingMap = { ...(config.youtube_default_playlist || {}) }
    if (defaultPlaylistDraft.value) {
      existingMap[accountId] = defaultPlaylistDraft.value
    } else {
      delete existingMap[accountId]
    }

    await put(`/projects/${props.slug}/settings/config`, {
      youtube_default_playlist: existingMap,
    })

    inventory.value.default_playlist_id = defaultPlaylistDraft.value
    saveResult.value = { kind: 'ok', message: 'Default playlist saved.' }
  } catch (error: any) {
    saveResult.value = { kind: 'err', message: messageOf(error, 'Failed to save default playlist.') }
  } finally {
    busy.value = ''
  }
}

async function saveAllSettings(): Promise<void> {
  busy.value = 'save-all'
  saveResult.value = null
  try {
    const accountId = inventory.value.account_id
    const config = (await get<any>(`/projects/${props.slug}/settings/config`)) || {}

    const payload: Record<string, any> = {
      youtube_end_screen: normalizeEndScreenConfig(
        endScreenDraft.value,
        defaultPlaylistDraft.value,
      ),
    }

    if (accountId) {
      const existingMap = { ...(config.youtube_default_playlist || {}) }
      if (defaultPlaylistDraft.value) {
        existingMap[accountId] = defaultPlaylistDraft.value
      } else {
        delete existingMap[accountId]
      }
      payload.youtube_default_playlist = existingMap
    }

    await put(`/projects/${props.slug}/settings/config`, payload)

    inventory.value.default_playlist_id = defaultPlaylistDraft.value
    endScreenDraft.value = payload.youtube_end_screen

    saveResult.value = { kind: 'ok', message: 'Settings saved.' }
    emit('saved', {
      defaultPlaylistId: defaultPlaylistDraft.value,
      endScreenPlan: endScreenDraft.value,
    })
  } catch (error: any) {
    saveResult.value = { kind: 'err', message: messageOf(error, 'Failed to save settings.') }
  } finally {
    busy.value = ''
  }
}

function resetDrafts(): void {
  defaultPlaylistDraft.value = inventory.value.default_playlist_id
  loadSettings(false)
}

onMounted(() => {
  loadSettings(false)
})
</script>

<style scoped>
.channel-youtube-settings {
  display: grid;
  gap: 16px;
  min-width: 0;
  color: var(--text-primary);
}

.settings-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
}

.header-titles h3 {
  margin: 4px 0 2px;
  font-size: 16px;
  font-weight: 700;
}

.header-titles p {
  margin: 0;
  font-size: var(--font-xs);
  color: var(--text-muted);
  line-height: 1.45;
}

.eyebrow {
  display: inline-block;
  color: var(--accent);
  font-size: var(--font-xs);
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.panel {
  display: grid;
  gap: 14px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 12px);
  background: var(--bg-secondary);
}

.panel-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
}

.panel-head h4 {
  margin: 3px 0 2px;
  font-size: 14px;
  font-weight: 600;
}

.hint {
  margin: 0;
  font-size: var(--font-xs);
  color: var(--text-muted);
  line-height: 1.4;
}

.cache-pill {
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 999px;
  background: var(--bg-tertiary);
  color: var(--text-muted);
  white-space: nowrap;
}

.unconnected-state {
  padding: 12px;
  border-radius: var(--radius-sm, 8px);
  background: var(--bg-tertiary);
}

.notice {
  margin: 0;
  font-size: var(--font-xs);
  color: var(--text-secondary);
  line-height: 1.45;
}

.default-playlist-box {
  display: grid;
  gap: 6px;
  padding: 12px;
  border-radius: var(--radius-sm, 8px);
  background: var(--bg-tertiary);
}

.field-label {
  font-size: var(--font-xs);
  font-weight: 700;
  color: var(--text-secondary);
}

.field-hint {
  margin: 0;
  font-size: 11px;
  color: var(--text-muted);
}

.field-row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.field-row .input {
  flex: 1;
}

.playlists-list-container {
  display: grid;
  gap: 8px;
}

.list-summary-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: var(--font-xs);
  color: var(--text-muted);
}

.list-count {
  font-weight: 600;
  color: var(--text-secondary);
}

.playlist-cards {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.playlist-card {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 8px);
  background: var(--bg-tertiary);
  transition: border-color 0.15s ease;
}

.playlist-card.is-default {
  border-color: var(--accent);
  background: rgba(var(--accent-rgb, 80, 140, 255), 0.05);
}

.card-main {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.card-title-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.playlist-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.playlist-desc {
  margin: 0;
  font-size: 11px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--text-muted);
}

.playlist-id {
  font-family: monospace;
  font-size: 10px;
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--bg-secondary);
}

.badge {
  font-size: 10px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 4px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.badge-default {
  background: var(--accent);
  color: #fff;
}

.badge-public {
  background: rgba(34, 197, 94, 0.15);
  color: rgb(34, 197, 94);
}

.badge-unlisted {
  background: rgba(234, 179, 8, 0.15);
  color: rgb(234, 179, 8);
}

.badge-private {
  background: rgba(148, 163, 184, 0.2);
  color: var(--text-muted);
}

.capability-callout {
  display: grid;
  gap: 4px;
  padding: 10px 12px;
  border-left: 3px solid var(--accent);
  border-radius: var(--radius-sm, 6px);
  background: var(--bg-tertiary);
  font-size: var(--font-xs);
  line-height: 1.45;
}

.callout-header {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--accent);
  font-weight: 600;
}

.status-indicator {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
}

.plan-body {
  display: grid;
  gap: 14px;
}

.control-group {
  display: grid;
  gap: 6px;
}

.group-label-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}

.duration-display {
  font-size: 13px;
  color: var(--accent);
}

.sub-duration {
  font-size: 11px;
  color: var(--text-muted);
  margin-left: 4px;
}

.slider {
  width: 100%;
  cursor: pointer;
}

.range-bounds {
  display: flex;
  justify-content: space-between;
  font-size: 10px;
  color: var(--text-muted);
}

.template-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 8px;
}

.template-card {
  display: grid;
  gap: 4px;
  padding: 10px;
  text-align: left;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 8px);
  background: var(--bg-tertiary);
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
}

.template-card:hover {
  border-color: var(--accent);
}

.template-card.is-selected {
  border-color: var(--accent);
  background: rgba(var(--accent-rgb, 80, 140, 255), 0.08);
}

.template-card-title {
  font-size: 12px;
  font-weight: 700;
  color: var(--text-primary);
}

.template-card-desc {
  font-size: 10px;
  color: var(--text-muted);
  line-height: 1.35;
}

.elements-list {
  display: grid;
  gap: 6px;
}

.element-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: var(--radius-sm, 6px);
  background: var(--bg-tertiary);
}

.element-slot {
  font-size: 11px;
  font-weight: 700;
  color: var(--text-muted);
  width: 48px;
  flex-shrink: 0;
}

.element-type-select {
  flex: 1;
}

.element-playlist-select,
.element-video-input {
  flex: 1;
}

.element-label-input {
  width: 130px;
}

.btn-remove {
  color: var(--text-muted);
}

.btn-add-element {
  justify-self: start;
  margin-top: 4px;
}

.count-badge {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
}

.guidance-box {
  display: grid;
  gap: 6px;
  padding: 12px;
  border-radius: var(--radius-sm, 8px);
  background: var(--bg-tertiary);
  border: 1px dashed var(--border);
}

.guidance-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.guidance-title {
  font-size: var(--font-xs);
  font-weight: 700;
  color: var(--text-secondary);
}

.guidance-text {
  margin: 0;
  font-family: monospace;
  font-size: 11px;
  color: var(--text-secondary);
  background: var(--bg-secondary);
  padding: 10px;
  border-radius: 6px;
  white-space: pre-wrap;
  word-break: break-word;
}

.settings-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding-top: 8px;
  border-top: 1px solid var(--border);
}

.footer-right {
  display: flex;
  gap: 8px;
}

.result {
  margin: 0;
  font-size: var(--font-xs);
  font-weight: 600;
}

.result.ok {
  color: rgb(34, 197, 94);
}

.result.warn {
  color: rgb(234, 179, 8);
}

.result.err {
  color: rgb(239, 68, 68);
}
</style>
