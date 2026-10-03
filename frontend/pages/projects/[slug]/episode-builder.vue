<!--
  Episode Builder (music channel format, SPEC §4–5, mockup 04).

  Songs from one or more Song Pools + scenes on one timeline. Nothing on this page
  makes or buys a song: a short pool is reported with the exact number missing and a
  link to the Song Pool. Pictures are made on the fleet through the same scene
  renderer Scene Review uses. "Send to Video Assembly" stitches the mix, writes the
  tracklist and the scene plan; Video Assembly then renders it like any episode.
-->
<template>
  <div class="workspace-page eb-page">
    <WorkspaceHero
      :eyebrow="code ? `Episode · ${code}` : 'Episode Builder'"
      :title="episodeTitle || 'Episode Builder'"
      :description="heroDescription"
    >
      <template #aside>
        <div class="eb-hero-actions">
          <div class="eb-btnhint">
            <button type="button" class="btn btn-secondary" :disabled="!code || !!busy" @click="redraw">
              {{ songs.length ? 'Re-draw Unlocked' : 'Draw Songs' }}
            </button>
            <span class="eb-hint">{{ songs.length
              ? (lockedCount ? `Keeps the ${lockedCount} locked song${lockedCount === 1 ? '' : 's'} where they are.` : 'Replaces every song. Lock a song to keep it.')
              : 'Picks songs from the pools to fill the target. Makes nothing new.' }}</span>
          </div>
          <div class="eb-btnhint">
            <button type="button" class="btn btn-primary" :disabled="!canSend" @click="sendToVideoAssembly">
              {{ buildJob && isActive(buildJob) ? 'Stitching…' : 'Send to Video Assembly' }}
            </button>
            <span class="eb-hint">{{ sendHint }}</span>
          </div>
        </div>
      </template>
    </WorkspaceHero>

    <!-- Episode choice -->
    <section class="card workspace-section eb-episode-bar">
      <label class="eb-label" for="eb-episode">Episode</label>
      <select id="eb-episode" v-model="code" class="select eb-episode-select" :disabled="listLoading">
        <option value="" disabled>{{ episodes.length ? 'Pick an episode…' : 'No episodes yet' }}</option>
        <option v-for="ep in episodes" :key="ep.code" :value="ep.code">
          {{ ep.code }} · {{ ep.title }}{{ ep.has_plan ? ` · ${ep.songs} songs` : ' · not built yet' }}
        </option>
      </select>
      <form class="eb-new" @submit.prevent="createEpisode">
        <input v-model="newTitle" class="input" placeholder="New episode title, e.g. Snowy Cabin Evenings" aria-label="New episode title">
        <button type="submit" class="btn btn-secondary" :disabled="!newTitle.trim() || !!busy">New Episode</button>
      </form>
      <p class="eb-hint eb-wide">Each episode gets its own code and folder. Building one never makes or buys songs.</p>
    </section>

    <WorkspaceNotice v-if="listError" tone="error" title="Could not load episodes">{{ listError }}</WorkspaceNotice>
    <WorkspaceNotice v-if="view && !view.music_channel" tone="warning" title="This channel's Series Formula is not a music formula">
      The builder still works, but the sidebar shows the narration flow. Pick a music formula in Settings → Channel to get the music flow.
    </WorkspaceNotice>
    <WorkspaceNotice v-if="viewError" tone="error" title="Could not open this episode">
      {{ viewError }}
      <template #actions><button type="button" class="btn btn-sm btn-secondary" @click="loadView">Retry</button></template>
    </WorkspaceNotice>

    <template v-if="view && code">
      <!-- Settings + timeline -->
      <section class="card workspace-section">
        <div class="eb-controls">
          <div class="eb-field">
            <label class="eb-label" for="eb-target">Target</label>
            <div class="eb-inline"><input id="eb-target" v-model.number="targetMinutes" type="number" min="1" max="360" step="1" class="input eb-num" @change="saveSettings"> <span>min</span></div>
          </div>
          <div class="eb-field">
            <span class="eb-label">Order</span>
            <div class="eb-seg" role="group" aria-label="Order">
              <button v-for="o in ORDER_OPTIONS" :key="o.value" type="button" :class="{ on: settings.order === o.value }" :aria-pressed="settings.order === o.value" @click="setOrder(o.value)">{{ o.label }}</button>
            </div>
          </div>
          <div class="eb-field">
            <span class="eb-label">Scenes</span>
            <div class="eb-seg" role="group" aria-label="Scenes">
              <button v-for="o in SCENE_OPTIONS" :key="o.value" type="button" :class="{ on: settings.scenes.mode === o.value }" :aria-pressed="settings.scenes.mode === o.value" @click="settings.scenes.mode = o.value; saveSettings()">{{ o.label }}</button>
            </div>
            <div v-if="settings.scenes.mode === 'count'" class="eb-inline eb-sub"><input v-model.number="settings.scenes.count" type="number" min="1" max="500" class="input eb-num" aria-label="Number of scenes" @change="saveSettings"> scenes</div>
            <div v-if="settings.scenes.mode === 'every-minutes'" class="eb-inline eb-sub">every <input v-model.number="settings.scenes.minutes" type="number" min="0.5" max="120" step="0.5" class="input eb-num" aria-label="Minutes per scene" @change="saveSettings"> min</div>
          </div>
          <div class="eb-field">
            <label class="eb-label" for="eb-theme">Theme</label>
            <input id="eb-theme" v-model="settings.theme" class="input eb-theme" list="eb-themes" placeholder="Cosy, seasonal, free text…" @change="saveSettings">
            <datalist id="eb-themes"><option v-for="t in view.themes" :key="t" :value="t" /></datalist>
          </div>
          <div class="eb-field">
            <label class="eb-label" for="eb-change">Scene change</label>
            <div class="eb-inline">
              <select id="eb-change" v-model="settings.scene_change.transition" class="select eb-change" @change="saveSettings">
                <option v-for="t in transitionOptions" :key="t.id" :value="t.id">{{ t.label }}</option>
              </select>
              <input v-model.number="settings.scene_change.seconds" type="number" min="0" max="10" step="0.5" class="input eb-num" aria-label="Scene change seconds" @change="saveSettings"> s
            </div>
          </div>
          <div class="eb-meter-box">
            <div class="eb-label">
              {{ clock(view.total_sec) }} of {{ clock(view.target_sec) }}
              <span class="ds-chip" :data-tone="longEnough ? 'success' : 'warning'">{{ longEnough ? 'long enough' : `${clock(view.target_sec - view.total_sec)} short` }}</span>
            </div>
            <div class="eb-meter"><div :style="{ width: `${Math.min(100, (view.total_sec / Math.max(1, view.target_sec)) * 100)}%` }" /></div>
            <div class="eb-hint">The last song plays to its end.</div>
          </div>
        </div>

        <div class="eb-controls eb-controls-2">
          <div class="eb-field">
            <span class="eb-label">Songs from</span>
            <div class="eb-pools">
              <label v-for="pool in allPools" :key="pool.pool_id" class="eb-check">
                <input type="checkbox" :checked="selectedPoolIds.includes(pool.pool_id)" @change="togglePool(pool.pool_id)">
                {{ pool.name }} <small>{{ pool.drawable }} songs</small>
              </label>
              <span v-if="!allPools.length" class="eb-hint">No song pools yet — make songs in the Song Pool first.</span>
            </div>
            <span class="eb-hint">{{ selectedPoolIds.length > 1 ? 'Every ticked pool provides songs; the no-repeat window covers them all.' : 'Tick more pools to draw from several channels.' }}</span>
          </div>
          <div class="eb-field">
            <label class="eb-label" for="eb-window">Don't repeat a song for</label>
            <div class="eb-inline"><input id="eb-window" v-model.number="settings.no_repeat_episodes" type="number" min="0" max="1000" class="input eb-num" @change="saveSettings"> episodes</div>
            <span class="eb-hint">{{ view.free_songs }} songs are free for this episode.</span>
          </div>
          <div class="eb-field">
            <span class="eb-label">Joins between songs</span>
            <div class="eb-inline">
              <div class="eb-seg" role="group" aria-label="Joins between songs">
                <button v-for="o in JOIN_OPTIONS" :key="o.value" type="button" :class="{ on: settings.join.style === o.value }" :aria-pressed="settings.join.style === o.value" @click="setJoin(o.value)">{{ o.label }}</button>
              </div>
              <template v-if="settings.join.style !== 'butt'"><input v-model.number="settings.join.seconds" type="number" min="0.1" max="30" step="0.5" class="input eb-num" aria-label="Join seconds" @change="saveSettings"> s</template>
            </div>
          </div>
          <div class="eb-field">
            <label class="eb-label" for="eb-fps">Frame rate</label>
            <select id="eb-fps" v-model.number="settings.frame_rate" class="select eb-small" @change="saveSettings">
              <option v-for="f in [24, 25, 30, 60]" :key="f" :value="f">{{ f }} fps</option>
            </select>
          </div>
          <div class="eb-field">
            <span class="eb-label">Resolution</span>
            <div class="eb-seg" role="group" aria-label="Resolution">
              <button type="button" :class="{ on: settings.resolution === '720p' }" @click="settings.resolution = '720p'; saveSettings()">720p</button>
              <button type="button" :class="{ on: settings.resolution === '1080p' }" @click="settings.resolution = '1080p'; saveSettings()">Upscale to 1080p</button>
            </div>
          </div>
          <div class="eb-field">
            <span class="eb-label">Loudness</span>
            <div class="eb-inline">
              <input v-model.number="settings.loudness_lufs" type="number" min="-40" max="-5" step="0.5" class="input eb-num" aria-label="Target loudness LUFS" @change="saveSettings"> LUFS
              <input v-model.number="settings.true_peak_db" type="number" min="-9" max="0" step="0.5" class="input eb-num" aria-label="True peak ceiling dBTP" @change="saveSettings"> dBTP
            </div>
          </div>
        </div>

        <WorkspaceNotice v-if="songs.length && view.shortfall_sec > 0" tone="warning" title="The episode is shorter than the target">
          {{ clock(view.shortfall_sec) }} missing — about {{ view.songs_missing }} more song{{ view.songs_missing === 1 ? '' : 's' }}.
          {{ view.free_songs > songs.length ? 'Re-draw to fill it from the free songs, or add songs by hand.' : 'Every free song is already in; nothing was generated.' }}
          <template #actions>
            <NuxtLink class="btn btn-sm btn-secondary" :to="{ path: `/projects/${slug}/song-pool`, query: { generate: String(view.songs_missing) } }">Generate {{ view.songs_missing }} Songs…</NuxtLink>
          </template>
        </WorkspaceNotice>
        <p v-for="note in draw?.notes || []" :key="note" class="eb-hint">{{ note }}</p>
        <p v-if="view.missing_pools.length" class="eb-warn">{{ view.missing_pools.length }} chosen pool(s) no longer exist and were skipped.</p>
        <p v-if="view.unresolved_songs.length" class="eb-warn">{{ view.unresolved_songs.length }} song(s) are no longer in the chosen pools. Swap or remove them before sending.</p>

        <!-- Timeline: scenes over songs -->
        <div v-if="songs.length" class="eb-tl" aria-label="Timeline">
          <div class="eb-tl-scenes">
            <button
              v-for="scene in view.scenes" :key="scene.id" type="button"
              class="eb-tl-scene" :class="{ sel: scene.id === selectedSceneId, missing: scene.image === 'missing' }"
              :style="{ width: pct(scene.end_sec - scene.start_sec), backgroundImage: scene.image === 'missing' ? undefined : `url('${imageUrl(scene)}')` }"
              :title="`Scene ${scene.scene_index}`"
              @click="selectedSceneId = scene.id"
            ><span v-if="scene.image === 'missing'">No picture</span></button>
          </div>
          <div class="eb-tl-songs">
            <div
              v-for="(song, i) in songs" :key="song.song_key" class="eb-tl-song"
              :class="{ lock: song.locked, sel: song.scene_id === selectedSceneId }"
              :style="{ width: pct(songLength(i)) }" :title="song.title"
            >{{ song.title }}</div>
          </div>
          <div v-if="view.target_sec <= timelineSpan" class="eb-tl-target" :class="{ 'label-left': view.target_sec / timelineSpan > 0.85 }" :style="{ left: pct(view.target_sec) }"><span>{{ clock(view.target_sec) }} target</span></div>
          <div class="eb-ruler"><span v-for="tick in ruler" :key="tick">{{ tick }}</span></div>
        </div>
        <p v-if="songs.length" class="eb-hint">{{ orderHint }}</p>
        <p v-else-if="!busy" class="eb-empty">No songs yet. <strong>Draw Songs</strong> picks songs from the ticked pools to fill {{ clock(view.target_sec) }}.</p>
      </section>

      <div v-if="songs.length" class="eb-grid">
        <!-- Songs -->
        <section class="card workspace-section">
          <div class="eb-head">
            <h3>Songs</h3>
            <button type="button" class="btn btn-ghost btn-sm" @click="openAdd">Add a Song…</button>
          </div>
          <div class="table-wrap">
            <table class="eb-songs">
              <thead><tr><th /><th>#</th><th>Starts</th><th>Song</th><th class="num">BPM</th><th>Key</th><th class="num">Length</th><th /></tr></thead>
              <tbody>
                <tr
                  v-for="(song, i) in songs" :key="song.song_key"
                  :class="{ sel: song.scene_id === selectedSceneId, dragging: dragFrom === i }"
                  draggable="true"
                  @dragstart="dragFrom = i" @dragover.prevent @drop="dropOn(i)" @dragend="dragFrom = -1"
                  @click="selectedSceneId = song.scene_id"
                >
                  <td class="eb-handle" title="Drag to reorder">⋮⋮</td>
                  <td>{{ i + 1 }}</td>
                  <td class="eb-muted">{{ clock(song.start_sec) }}</td>
                  <td>
                    <span v-if="song.locked" class="eb-lock" title="Locked: stays where it is on re-draw">🔒</span>
                    {{ song.title }}
                    <small v-if="song.pool_id !== ownPoolId && poolName(song.pool_id)" class="eb-pool">{{ poolName(song.pool_id) }}</small>
                    <small v-if="song.blocked_by" class="eb-warn-chip" :title="`Also in ${song.blocked_by}, inside the no-repeat window`">in {{ song.blocked_by }}</small>
                    <label v-if="settings.scenes.mode === 'manual' && i > 0" class="eb-break" @click.stop>
                      <input type="checkbox" :checked="sceneBreaks.has(song.song_key)" @change="toggleBreak(song.song_key)"> new scene
                    </label>
                  </td>
                  <td class="num">{{ song.tempo_bpm || '—' }}</td>
                  <td>{{ song.key || '—' }}</td>
                  <td class="num">{{ clock(song.duration_s) }}</td>
                  <td class="eb-actions">
                    <button type="button" class="btn btn-ghost btn-sm" :aria-pressed="song.locked" :title="song.locked ? 'Let re-draw replace this song' : 'Keep this song where it is on re-draw'" @click.stop="toggleLock(i)">{{ song.locked ? 'Unlock' : 'Lock' }}</button>
                    <button type="button" class="btn btn-ghost btn-sm" @click.stop="openSwap(i)">Swap</button>
                    <button type="button" class="btn btn-ghost btn-sm" :aria-label="`Remove ${song.title}`" title="Remove from this episode (the song stays in the pool)" @click.stop="removeSong(i)">✕</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p class="eb-hint">Drag ⋮⋮ to reorder · Lock keeps a song (🔒) on re-draw · Swap shows the 5 closest free songs by length and mood · Chapters use these start times.</p>
        </section>

        <!-- Scene panel -->
        <section v-if="selectedScene" class="card workspace-section eb-scene">
          <div class="eb-head">
            <h3>Scene {{ selectedScene.scene_index }} · plays under “{{ firstTitle(selectedScene) }}”</h3>
            <span class="eb-muted">{{ clock(selectedScene.start_sec) }} – {{ clock(selectedScene.end_sec) }}</span>
          </div>
          <div class="eb-preview">
            <img v-if="selectedScene.image !== 'missing'" :src="imageUrl(selectedScene)" :alt="`Scene ${selectedScene.scene_index} picture`">
            <div v-else class="eb-preview-empty">{{ sceneJobActive ? 'Making this picture on the fleet…' : 'No picture yet' }}</div>
          </div>
          <p v-if="selectedScene.image === 'stale'" class="eb-warn">The prompt changed after this picture was made. Regenerate it, or keep this picture.</p>

          <label class="eb-label" for="eb-prompt">Scene prompt</label>
          <textarea id="eb-prompt" v-model="promptDraft" class="input eb-prompt" rows="3" />
          <p class="eb-hint">
            {{ selectedScene.prompt_is_custom ? 'Your own prompt.' : `From the song's scene idea${settings.theme ? ` + theme ${settings.theme}` : ''}.` }}
            {{ view.visual_style ? "The channel's visual style is added when the picture is made." : '' }}
          </p>
          <div class="eb-row">
            <button v-if="promptDraft.trim() !== selectedScene.prompt" type="button" class="btn btn-secondary btn-sm" @click="savePrompt">Save Prompt</button>
            <button v-if="selectedScene.prompt_is_custom" type="button" class="btn btn-ghost btn-sm" @click="resetPrompt">Use the Song's Scene Idea</button>
          </div>

          <div class="eb-row eb-top">
            <div class="eb-btnhint">
              <button type="button" class="btn btn-secondary btn-sm" :disabled="!imageForm.model || sceneJobActive" @click="regenerate(selectedScene)">{{ selectedScene.image === 'missing' ? 'Make Picture' : 'Regenerate Scene' }}</button>
              <span class="eb-hint">{{ selectedScene.image === 'missing' ? 'Made on the fleet with the image model below.' : 'New picture, same prompt. Made on the fleet.' }}</span>
            </div>
            <div class="eb-btnhint">
              <button type="button" class="btn btn-ghost btn-sm" @click="openStillPicker">Use From Pool…</button>
              <span class="eb-hint">Pick a still you already have.</span>
            </div>
            <div v-if="selectedScene.image === 'stale'" class="eb-btnhint">
              <button type="button" class="btn btn-ghost btn-sm" @click="keepPicture(selectedScene)">Keep This Picture</button>
              <span class="eb-hint">Use it with the new prompt.</span>
            </div>
          </div>
          <p class="eb-hint eb-top">
            Effects for this scene, every “{{ settings.theme || 'theme' }}” scene or the whole episode are set in the
            <NuxtLink :to="{ path: `/projects/${slug}/effects-library`, query: { episode: code } }" class="inline-link">Effects Library</NuxtLink>;
            they fade with the scene's crossfade.
          </p>
        </section>
      </div>

      <!-- Pictures -->
      <section v-if="songs.length" class="card workspace-section">
        <div class="eb-head">
          <h3>Scene pictures</h3>
          <span class="eb-muted">{{ readyScenes }} of {{ view.scenes.length }} ready</span>
        </div>
        <div class="eb-pictures">
          <div class="eb-field eb-model">
            <span class="eb-label">Image model</span>
            <ImageModelPicker v-model="imageForm.model" :project-slug="slug" image-mode="text2img" default-label="Pick an image model…" />
          </div>
          <ImageOutputOptionPicker v-if="selectedImageModel" v-model="outputOption" :model="selectedImageModel" @switched="showError" />
          <div class="eb-btnhint">
            <button type="button" class="btn btn-primary" :disabled="!imageForm.model || !missingScenes.length || sceneJobActive" @click="makeMissing">
              {{ sceneJobActive ? 'Making Pictures…' : `Make ${missingScenes.length} Missing Picture${missingScenes.length === 1 ? '' : 's'}` }}
            </button>
            <span class="eb-hint">One picture per scene, shared across the fleet's free Macs. Each one is accepted when it arrives; regenerate any you don't like.</span>
          </div>
        </div>
      </section>

      <WorkspaceNotice v-if="buildJob && buildJob.status === 'done' && view.doc?.built" tone="success" title="Ready for Video Assembly">
        Mix stitched ({{ clock(view.doc.built.total_sec) }}{{ view.doc.built.lufs != null ? `, ${view.doc.built.lufs.toFixed(1)} LUFS` : '' }}), tracklist and scene plan written.
        Video Assembly offers this episode's settings ({{ settings.frame_rate }} fps, {{ settings.resolution }}) in one click.
        <template #actions><NuxtLink class="btn btn-sm btn-primary" :to="{ path: `/projects/${slug}/video-assembly`, query: { episode_id: code } }">Open Video Assembly</NuxtLink></template>
      </WorkspaceNotice>
      <WorkspaceNotice v-else-if="buildJob && buildJob.status === 'error'" tone="error" title="The stitch did not finish">
        {{ buildJob.error || 'See Project Jobs for the log.' }}
      </WorkspaceNotice>
    </template>

    <!-- Swap / add dialog -->
    <Modal :visible="!!picker" size="md" labelledby="eb-picker-title" @close="picker = null">
      <h3 id="eb-picker-title" class="eb-dialog-title">{{ picker?.mode === 'swap' ? `Swap “${songs[picker.index]?.title}”` : 'Add a Song' }}</h3>
      <input v-if="picker?.mode === 'add'" v-model="pickerQuery" class="input" placeholder="Search title, mood, key, ensemble…" aria-label="Search songs" @input="loadAddable">
      <p class="eb-hint">{{ picker?.mode === 'swap' ? 'The 5 closest free songs by length and mood.' : 'Songs not in this episode. Songs inside the no-repeat window are listed last and marked.' }}</p>
      <p v-if="pickerLoading" class="eb-muted">Loading…</p>
      <ul class="eb-pick">
        <li v-for="cand in pickerSongs" :key="cand.song_key">
          <button type="button" class="eb-pick-row" @click="pickSong(cand)">
            <strong>{{ cand.title }}</strong>
            <span class="eb-muted">{{ clock(cand.duration_s) }}{{ cand.mood ? ` · ${cand.mood}` : '' }}{{ cand.tempo_bpm ? ` · ${cand.tempo_bpm} BPM` : '' }}{{ cand.key ? ` · ${cand.key}` : '' }} · played {{ cand.plays }}×</span>
            <small v-if="cand.blocked_by" class="eb-warn-chip">in {{ cand.blocked_by }}</small>
          </button>
        </li>
      </ul>
      <p v-if="!pickerLoading && !pickerSongs.length" class="eb-muted">No free songs match.</p>
      <div class="eb-dialog-actions"><button type="button" class="btn btn-secondary" @click="picker = null">Close</button></div>
    </Modal>

    <!-- Still picker -->
    <Modal :visible="stillPicker" size="lg" labelledby="eb-still-title" @close="stillPicker = false">
      <h3 id="eb-still-title" class="eb-dialog-title">Use a Still From an Image Pool</h3>
      <select v-model="stillPoolId" class="select" aria-label="Image pool" @change="loadStills">
        <option value="" disabled>Pick an image pool…</option>
        <option v-for="p in imagePools" :key="p.id" :value="p.id">{{ p.name }}</option>
      </select>
      <p v-if="!imagePools.length" class="eb-hint">No image pools yet. Register one in the Assets Library.</p>
      <div class="eb-stills">
        <button v-for="clip in stills" :key="clip.filename" type="button" class="eb-still" :title="clip.filename" @click="useStill(clip.filename)">
          <img :src="`/api/broll-pools/${encodeURIComponent(stillPoolId)}/clips/${encodeURIComponent(clip.filename)}/thumbnail`" :alt="clip.filename" loading="lazy">
        </button>
      </div>
      <div class="eb-dialog-actions"><button type="button" class="btn btn-secondary" @click="stillPicker = false">Close</button></div>
    </Modal>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { findGenStudioProduct } from '../../../../electron/server/contracts/genstudio-product-identity'
import type { OutputOptionChoice } from '../../../utils/genstudio-output-options.js'

definePageMeta({ layout: 'dashboard' })

type Order = 'random' | 'smooth' | 'manual'
type SceneMode = 'per-song' | 'count' | 'every-minutes' | 'manual'
type Join = 'crossfade' | 'butt' | 'silence'
interface Settings {
  pools: string[]; target_length_s: number; no_repeat_episodes: number; order: Order
  scenes: { mode: SceneMode; count: number; minutes: number }; theme: string
  join: { style: Join; seconds: number }; scene_change: { transition: string; seconds: number }
  frame_rate: number; resolution: '720p' | '1080p'; loudness_lufs: number; true_peak_db: number
}
interface Song {
  song_key: string; key?: string; pool_id: string; id: string; title: string; duration_s: number; locked: boolean; start_sec: number
  scene_id: string; tempo_bpm?: number; mood?: string; plays: number; blocked_by?: string | null
  [extra: string]: any
}
interface Scene {
  id: string; scene_index: number; start_sec: number; end_sec: number; song_keys: string[]; prompt: string
  prompt_is_custom: boolean; image: 'ready' | 'stale' | 'missing'; image_version: string | null; approved: boolean
}
interface View {
  episode_code: string; music_channel: boolean; doc: any; channel_settings: Settings; themes: string[]
  pools: Array<{ pool_id: string; name: string; project_slug: string; drawable: number }>
  missing_pools: string[]; songs: Song[]; unresolved_songs: string[]; scenes: Scene[]
  total_sec: number; target_sec: number; free_songs: number; window_codes: string[]
  smooth_breaks: { tempo: number; keyAndEnsemble: number }; visual_style: string
  shortfall_sec: number; songs_missing: number
  draw?: { shortfall_sec: number; songs_missing: number; notes: string[] }
}

const ORDER_OPTIONS: Array<{ value: Order; label: string }> = [
  { value: 'random', label: 'Random' }, { value: 'smooth', label: 'Smooth flow' }, { value: 'manual', label: 'Manual' },
]
const SCENE_OPTIONS: Array<{ value: SceneMode; label: string }> = [
  { value: 'per-song', label: 'One per song' }, { value: 'count', label: 'Fixed count' },
  { value: 'every-minutes', label: 'Every N min' }, { value: 'manual', label: 'Manual' },
]
const JOIN_OPTIONS: Array<{ value: Join; label: string }> = [
  { value: 'crossfade', label: 'Crossfade' }, { value: 'butt', label: 'Butt-join' }, { value: 'silence', label: 'Short silence' },
]

const route = useRoute()
const router = useRouter()
const slug = computed(() => String(route.params.slug || ''))
const { get, post, put } = useApi()
const { success, error: showError } = useToast()
const { jobs } = useJobs()

const episodes = ref<Array<{ code: string; title: string; has_plan: boolean; songs: number }>>([])
const allPools = ref<View['pools']>([])
const listLoading = ref(false)
const listError = ref('')
const code = ref(String(route.query.episode_id || '').toUpperCase())
const newTitle = ref('')
const view = ref<View | null>(null)
const viewError = ref('')
const busy = ref('')
const draw = ref<View['draw'] | null>(null)
const selectedSceneId = ref('')
const promptDraft = ref('')
const dragFrom = ref(-1)
const settings = ref<Settings>(blankSettings())
const transitionOptions = ref<Array<{ id: string; label: string }>>([{ id: 'none', label: 'Hard cut' }, { id: 'crossfade', label: 'Crossfade' }])

function blankSettings(): Settings {
  return {
    pools: [], target_length_s: 3900, no_repeat_episodes: 30, order: 'smooth',
    scenes: { mode: 'per-song', count: 12, minutes: 5 }, theme: '', join: { style: 'crossfade', seconds: 3 },
    scene_change: { transition: 'crossfade', seconds: 4 }, frame_rate: 24, resolution: '720p', loudness_lufs: -14, true_peak_db: -1,
  }
}

const songs = computed(() => view.value?.songs || [])
const lockedCount = computed(() => songs.value.filter(s => s.locked).length)
const episodeTitle = computed(() => episodes.value.find(e => e.code === code.value)?.title || '')
const ownPoolId = computed(() => allPools.value.find(p => p.project_slug === slug.value)?.pool_id || '')
const selectedPoolIds = computed(() => settings.value.pools.length ? settings.value.pools : (ownPoolId.value ? [ownPoolId.value] : []))
const longEnough = computed(() => !!view.value && view.value.total_sec >= view.value.target_sec)
const timelineSpan = computed(() => Math.max(view.value?.total_sec || 0, view.value?.target_sec || 0, 1))
const sceneBreaks = computed(() => new Set<string>(view.value?.doc?.scene_breaks || []))
const selectedScene = computed(() => view.value?.scenes.find(s => s.id === selectedSceneId.value) || view.value?.scenes[0] || null)
const missingScenes = computed(() => (view.value?.scenes || []).filter(s => s.image === 'missing'))
const readyScenes = computed(() => (view.value?.scenes || []).filter(s => s.image === 'ready' && s.approved).length)
const targetMinutes = computed({
  get: () => Math.round(settings.value.target_length_s / 60),
  set: (minutes: number) => { settings.value.target_length_s = Math.max(1, Number(minutes) || 1) * 60 },
})

const heroDescription = computed(() => {
  const v = view.value
  if (!code.value) return 'Pick an episode or start a new one. Songs come from your Song Pools; nothing new is made here.'
  if (!v) return 'Loading…'
  if (!songs.value.length) return `No songs drawn yet. ${v.free_songs} free songs in ${selectedPoolIds.value.length || 0} pool(s).`
  const window = settings.value.no_repeat_episodes
  return `${songs.value.length} songs · ${clock(v.total_sec)} · ${v.scenes.length} scenes${settings.value.theme ? ` · theme ${settings.value.theme}` : ''}. `
    + `Drawn from ${v.free_songs} free songs${window ? ` (none used in the last ${window} episodes)` : ''}.`
})

const orderHint = computed(() => {
  const o = settings.value.order
  if (o === 'smooth') {
    const b = view.value?.smooth_breaks
    const issues = b && (b.tempo || b.keyAndEnsemble)
      ? ` ${b.tempo ? `${b.tempo} step(s) jump more than 12 BPM` : ''}${b.tempo && b.keyAndEnsemble ? ', ' : ''}${b.keyAndEnsemble ? `${b.keyAndEnsemble} neighbour pair(s) share key and ensemble` : ''} — the pool has no closer song.`
      : ''
    return `Smooth flow: tempo changes at most 12 BPM per step, no two neighbours share key and ensemble, energy settles toward the end.${issues} 🔒 = locked.`
  }
  if (o === 'random') return 'Random order, the same every time for this episode until you re-draw. 🔒 = locked.'
  return 'Manual order: drag songs to place them. 🔒 = locked.'
})

const buildJob = computed(() => [...jobs.value as any[]]
  .filter(j => j.type === 'music_episode_build' && String(j.episode_id).toUpperCase() === code.value)
  .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))[0] || null)
const sceneJob = computed(() => (jobs.value as any[]).find(j =>
  ['continuity_render', 'scene_image_generate'].includes(j.type) && String(j.episode_id).toUpperCase() === code.value && isActive(j)) || null)
const sceneJobActive = computed(() => !!sceneJob.value)
const canSend = computed(() => !!code.value && songs.value.length > 0 && !busy.value && !(buildJob.value && isActive(buildJob.value)) && !view.value?.unresolved_songs.length)
const sendHint = computed(() => {
  if (!songs.value.length) return 'Draw songs first.'
  if (missingScenes.value.length) return `Writes the scene plan, the stitched mix and the tracklist. ${missingScenes.value.length} scene(s) still need a picture before Video Assembly can render.`
  return 'Writes the scene plan, the stitched mix and the tracklist.'
})
const ruler = computed(() => {
  const span = timelineSpan.value
  const step = span > 3600 ? 600 : span > 900 ? 300 : 60
  const ticks: string[] = []
  for (let t = 0; t < span - step / 2; t += step) ticks.push(clock(t))
  ticks.push(clock(span))
  return ticks
})

// Image model: remembered per page, picked here, never assigned by a formula.
const imageForm = ref({ model: '' })
useRememberedForm('episode-builder-images', slug, imageForm)
const { models: imageModels } = useGenStudioImageModels()
const selectedImageModel = computed(() => findGenStudioProduct(imageModels.value, imageForm.value.model))
const outputOption = ref<OutputOptionChoice | null>(null)

function isActive(job: any): boolean { return job && ['queued', 'running', 'paused'].includes(job.status) }
function clock(sec: number): string {
  const s = Math.max(0, Math.round(Number(sec) || 0))
  const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const r = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`
}
function pct(sec: number): string { return `${(Math.max(0, sec) / timelineSpan.value) * 100}%` }
function songLength(i: number): number {
  const next = songs.value[i + 1]
  return (next ? next.start_sec : (view.value?.total_sec || 0)) - songs.value[i]!.start_sec
}
function poolName(id: string): string { return allPools.value.find(p => p.pool_id === id)?.name || '' }
function firstTitle(scene: Scene): string { return songs.value.find(s => s.song_key === scene.song_keys[0])?.title || '' }
function imageUrl(scene: Scene): string {
  return `/api/projects/${encodeURIComponent(slug.value)}/scene-review/${encodeURIComponent(code.value)}/image/${encodeURIComponent(scene.id)}?v=${encodeURIComponent(scene.image_version || scene.image)}`
}
function refs(list: Song[]) { return list.map(s => ({ pool_id: s.pool_id, song_id: s.id, ...(s.locked ? { locked: true } : {}) })) }

function applyView(next: View) {
  view.value = next
  if (next.draw) draw.value = next.draw
  settings.value = JSON.parse(JSON.stringify(next.doc?.settings || next.channel_settings || blankSettings()))
  if (!next.scenes.some(s => s.id === selectedSceneId.value)) selectedSceneId.value = next.scenes[0]?.id || ''
}

async function loadList() {
  listLoading.value = true
  listError.value = ''
  try {
    const res = await get<{ episodes: typeof episodes.value; pools: View['pools'] }>(`/projects/${slug.value}/music-episodes`)
    episodes.value = res.episodes
    allPools.value = res.pools
    if (!code.value) code.value = (res.episodes.find(e => e.has_plan) || res.episodes[0])?.code || ''
  } catch (e: any) {
    listError.value = e?.data?.detail || e?.message || 'Unknown error'
  } finally {
    listLoading.value = false
  }
}

async function loadView() {
  if (!code.value) { view.value = null; return }
  viewError.value = ''
  try {
    applyView(await get<View>(`/projects/${slug.value}/music-episodes/${code.value}`))
  } catch (e: any) {
    viewError.value = e?.data?.detail || e?.message || 'Unknown error'
  }
}

async function act(label: string, fn: () => Promise<View | void>) {
  busy.value = label
  try {
    const next = await fn()
    if (next) applyView(next)
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || `${label} failed`)
    await loadView()
  } finally {
    busy.value = ''
  }
}

const saveSettings = () => act('Saving', () => put<View>(`/projects/${slug.value}/music-episodes/${code.value}`, { settings: settings.value }))
const saveSongs = (list: Song[], extra: Record<string, unknown> = {}) =>
  act('Saving', () => put<View>(`/projects/${slug.value}/music-episodes/${code.value}`, { songs: refs(list), ...extra }))

async function redraw() {
  await act('Drawing', async () => {
    draw.value = null
    const next = await post<View>(`/projects/${slug.value}/music-episodes/${code.value}/draw`, { settings: settings.value })
    if (next.draw && !next.draw.shortfall_sec) success(`${next.songs.length} songs drawn — ${clock(next.total_sec)}.`)
    return next
  })
  void loadList()
}

function setOrder(order: Order) {
  settings.value.order = order
  void act('Ordering', () => post<View>(`/projects/${slug.value}/music-episodes/${code.value}/order`, { settings: settings.value }))
}
function setJoin(style: Join) {
  settings.value.join = { style, seconds: style === 'silence' ? 1.5 : style === 'crossfade' ? 3 : settings.value.join.seconds }
  void saveSettings()
}
function togglePool(id: string) {
  const current = new Set(selectedPoolIds.value)
  if (current.has(id)) current.delete(id); else current.add(id)
  if (!current.size) { showError('Keep at least one pool ticked.'); return }
  settings.value.pools = [...current]
  void saveSettings()
}
function toggleLock(i: number) {
  const list = songs.value.map(s => ({ ...s }))
  list[i]!.locked = !list[i]!.locked
  void saveSongs(list)
}
function removeSong(i: number) { void saveSongs(songs.value.filter((_, at) => at !== i)) }
function dropOn(to: number) {
  const from = dragFrom.value
  dragFrom.value = -1
  if (from < 0 || from === to) return
  const list = [...songs.value]
  const [moved] = list.splice(from, 1)
  list.splice(to, 0, moved!)
  if (settings.value.order !== 'manual') {
    settings.value.order = 'manual'
    success('Order is now Manual, because you moved a song.')
    void saveSongs(list, { settings: settings.value })
  } else {
    void saveSongs(list)
  }
}
function toggleBreak(key: string) {
  const next = new Set(sceneBreaks.value)
  if (next.has(key)) next.delete(key); else next.add(key)
  void act('Saving', () => put<View>(`/projects/${slug.value}/music-episodes/${code.value}`, { scene_breaks: [...next] }))
}

// Swap / add
const picker = ref<{ mode: 'swap' | 'add'; index: number } | null>(null)
const pickerSongs = ref<Song[]>([])
const pickerLoading = ref(false)
const pickerQuery = ref('')
async function openSwap(i: number) {
  picker.value = { mode: 'swap', index: i }
  pickerLoading.value = true
  pickerSongs.value = []
  try {
    pickerSongs.value = (await get<{ candidates: Song[] }>(`/projects/${slug.value}/music-episodes/${code.value}/swap?song_key=${encodeURIComponent(songs.value[i]!.song_key)}`)).candidates
  } catch (e: any) { showError(e?.data?.detail || e?.message || 'Could not find songs') } finally { pickerLoading.value = false }
}
async function loadAddable() {
  pickerLoading.value = true
  try {
    pickerSongs.value = (await get<{ songs: Song[] }>(`/projects/${slug.value}/music-episodes/${code.value}/songs?q=${encodeURIComponent(pickerQuery.value)}`)).songs
  } catch (e: any) { showError(e?.data?.detail || e?.message || 'Could not list songs') } finally { pickerLoading.value = false }
}
function openAdd() { picker.value = { mode: 'add', index: -1 }; pickerQuery.value = ''; void loadAddable() }
function pickSong(cand: Song) {
  const p = picker.value
  picker.value = null
  if (!p) return
  const entry = { ...cand, locked: false } as Song
  const list = [...songs.value]
  if (p.mode === 'swap') list.splice(p.index, 1, { ...entry, locked: songs.value[p.index]!.locked })
  else list.push(entry)
  void saveSongs(list)
}

// Prompts
watch(selectedScene, scene => { promptDraft.value = scene?.prompt || '' }, { immediate: true })
function savePrompt() {
  const scene = selectedScene.value
  if (!scene) return
  void act('Saving', () => put<View>(`/projects/${slug.value}/music-episodes/${code.value}`, { prompt_overrides: { [scene.id]: promptDraft.value } }))
}
function resetPrompt() {
  const scene = selectedScene.value
  if (!scene) return
  void act('Saving', () => put<View>(`/projects/${slug.value}/music-episodes/${code.value}`, { prompt_overrides: { [scene.id]: '' } }))
}

// Pictures (fleet, through the Scene Review renderer)
function renderBody() {
  return {
    model: imageForm.value.model,
    aspect_ratio: outputOption.value?.aspect_ratio || '16:9',
    ...(outputOption.value?.resolution ? { resolution: outputOption.value.resolution } : {}),
    auto_approve_generated: true,
  }
}
async function makeMissing() {
  const ids = missingScenes.value.map(s => s.id)
  await act('Pictures', async () => {
    await post(`/projects/${slug.value}/scene-review/${code.value}/continuity-render`, { ...renderBody(), scene_ids: ids, missing_only: true })
    success(`Making ${ids.length} picture(s) on the fleet — each appears here as it finishes.`)
  })
}
async function regenerate(scene: Scene) {
  const replacing = scene.image !== 'missing'
  await act('Pictures', async () => {
    await post(`/projects/${slug.value}/scene-review/${code.value}/continuity-render`, {
      ...renderBody(), single_scene_id: scene.id, force: replacing,
      ...(replacing ? { operation_id: crypto.randomUUID() } : {}),
    })
    success(`${replacing ? 'New picture' : 'Picture'} for scene ${scene.scene_index} is being made on the fleet.`)
  })
}
const keepPicture = (scene: Scene) => act('Saving', () => post<View>(`/projects/${slug.value}/music-episodes/${code.value}/scenes/${scene.id}/keep`))

// Stills from an Image Pool
const { pools: brollPools, loadPools } = useBrollPools()
const imagePools = computed(() => brollPools.value.filter((p: any) => p.media === 'image'))
const stillPicker = ref(false)
const stillPoolId = ref('')
const stills = ref<Array<{ filename: string }>>([])
async function openStillPicker() { stillPicker.value = true; await loadPools().catch(() => {}) }
async function loadStills() {
  stills.value = []
  try { stills.value = (await get<any>(`/broll-pools/${encodeURIComponent(stillPoolId.value)}/clips`)).clips || [] } catch (e: any) { showError(e?.data?.detail || e?.message || 'Could not list stills') }
}
async function useStill(filename: string) {
  const scene = selectedScene.value
  if (!scene) return
  stillPicker.value = false
  await act('Saving', () => post<View>(`/projects/${slug.value}/music-episodes/${code.value}/scenes/${scene.id}/use-still`, { pool_id: stillPoolId.value, filename }))
}

// Episodes + hand-off
async function createEpisode() {
  await act('Creating', async () => {
    const res = await post<{ code: string; effects?: { seeded: boolean; added: number; unknown: string[] } }>(`/projects/${slug.value}/music-episodes`, { title: newTitle.value })
    newTitle.value = ''
    await loadList()
    code.value = res.code
    const fx = res.effects
    success(`${res.code} created${fx?.seeded ? ` with the channel's effects look (${fx.added} effect${fx.added === 1 ? '' : 's'})` : ''}. Draw songs to start.`)
    if (fx?.unknown.length) showError(`The channel's effects look names ${fx.unknown.length} unknown preset(s): ${fx.unknown.join(', ')}. Fix it on the Music Formula page.`)
  })
}
async function sendToVideoAssembly() {
  await act('Sending', async () => {
    await post(`/projects/${slug.value}/music-episodes/${code.value}/build`)
    success('Stitching the mix — it takes about a minute for an hour of music. Nothing is generated or bought.')
  })
}

watch(code, value => {
  draw.value = null
  if (value && route.query.episode_id !== value) router.replace({ query: { ...route.query, episode_id: value } })
  void loadView()
})
watch(() => buildJob.value?.status, (now, before) => { if (before && now === 'done') void loadView() })
// Pictures arrive one by one while a render job runs.
let pictureTimer: ReturnType<typeof setInterval> | null = null
watch(sceneJobActive, active => {
  if (pictureTimer) { clearInterval(pictureTimer); pictureTimer = null }
  if (active) pictureTimer = setInterval(() => { void loadView() }, 8000)
  else void loadView()
})
onBeforeUnmount(() => { if (pictureTimer) clearInterval(pictureTimer) })

onMounted(async () => {
  await loadList()
  await loadView()
  try {
    const r = await get<{ transitions: Array<{ id: string; label: string }> }>(`/projects/${slug.value}/video-editor/transitions/catalog`)
    if (r.transitions?.length) transitionOptions.value = [{ id: 'none', label: 'Hard cut' }, ...r.transitions.map(t => ({ id: t.id, label: t.label }))]
  } catch { /* keep Crossfade */ }
})
</script>

<style scoped>
.eb-page { display: flex; flex-direction: column; gap: 14px; }
.eb-hero-actions { display: flex; gap: 12px; align-items: flex-start; flex-wrap: wrap; justify-content: flex-end; }
.eb-btnhint { display: flex; flex-direction: column; gap: 4px; max-width: 260px; }
.eb-wide { flex-basis: 100%; }
.eb-warn { color: color-mix(in srgb, var(--warning) 70%, var(--text-primary)); font-size: 12px; margin-top: 6px; }
.eb-pool { margin-left: 6px; padding: 0 6px; border-radius: 999px; font-size: var(--font-xs); border: 1px solid var(--border); color: var(--text-secondary); }
.eb-episode-bar { display: flex; flex-wrap: wrap; gap: 10px 14px; align-items: center; }
.eb-episode-select { min-width: 280px; max-width: 460px; }
.eb-new { display: flex; gap: 8px; flex: 1 1 360px; }
.eb-new .input { flex: 1; }
.eb-label { display: block; font-weight: 600; font-size: 13px; margin-bottom: 6px; color: var(--text-primary); }
.eb-controls { display: flex; flex-wrap: wrap; gap: 14px 22px; align-items: flex-start; }
.eb-controls-2 { margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--border); }
.eb-field { display: flex; flex-direction: column; min-width: 0; }
.eb-inline { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-secondary); }
.eb-sub { margin-top: 6px; }
.eb-num { width: 74px; }
.eb-small { width: 110px; }
.eb-theme { width: 200px; }
.eb-change { width: 170px; }
.eb-seg { display: inline-flex; border: 1px solid var(--border); border-radius: var(--radius-sm, 6px); overflow: hidden; }
.eb-seg button { padding: 6px 12px; font-size: 13px; background: transparent; border: 0; border-right: 1px solid var(--border); color: var(--text-secondary); cursor: pointer; }
.eb-seg button:last-child { border-right: 0; }
.eb-seg button.on { background: var(--accent); color: var(--accent-contrast, #1a1406); font-weight: 600; }
.eb-meter-box { margin-left: auto; min-width: 220px; }
.eb-meter { height: 5px; border-radius: 3px; background: var(--bg-tertiary); overflow: hidden; margin: 2px 0 4px; }
.eb-meter div { height: 100%; background: var(--accent); }
.eb-pools { display: flex; flex-wrap: wrap; gap: 6px 14px; max-width: 440px; }
.eb-check { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; }
.eb-check small { color: var(--text-muted); }
.eb-tl { position: relative; margin-top: 16px; }
.eb-tl-scenes, .eb-tl-songs { display: flex; }
.eb-tl-scene { height: 64px; padding: 0; border: 0; border-right: 2px solid var(--bg-secondary); background: var(--bg-tertiary) center / cover no-repeat; cursor: pointer; color: var(--text-muted); font-size: var(--font-xs); overflow: hidden; }
.eb-tl-scene.sel { outline: 2px solid var(--accent); outline-offset: -2px; position: relative; z-index: 1; }
.eb-tl-song { height: 28px; border-right: 2px solid var(--bg-secondary); background: color-mix(in srgb, var(--accent) 16%, var(--bg-tertiary)); font-size: var(--font-xs); padding: 4px 5px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--text-secondary); }
.eb-tl-song.lock { background: color-mix(in srgb, var(--info) 22%, var(--bg-tertiary)); }
.eb-tl-song.sel { background: color-mix(in srgb, var(--accent) 38%, var(--bg-tertiary)); color: var(--text-primary); }
.eb-tl-target { position: absolute; top: -6px; bottom: 18px; border-left: 2px dashed var(--warning); }
.eb-tl-target span { position: absolute; top: -16px; left: 4px; font-size: var(--font-xs); color: var(--warning); white-space: nowrap; }
.eb-tl-target.label-left span { left: auto; right: 4px; }
.eb-ruler { display: flex; justify-content: space-between; font-size: var(--font-xs); color: var(--text-muted); margin-top: 4px; }
.eb-empty { margin-top: 14px; color: var(--text-secondary); }
.eb-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(360px, 520px); gap: 14px; align-items: start; }
/* The sidebar takes ~220 px: below ~1500 px there is no room for the table beside the scene panel. */
@media (max-width: 1500px) { .eb-grid { grid-template-columns: minmax(0, 1fr); } .eb-scene .eb-preview { max-width: 640px; } }
.eb-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
.eb-head h3 { font-size: 15px; margin: 0; }
.eb-songs { width: 100%; }
.eb-songs td { padding: 6px 8px; vertical-align: middle; }
.eb-songs tr.sel td { background: var(--bg-hover); }
.eb-songs tr.dragging { opacity: 0.5; }
.eb-songs .num { text-align: right; font-variant-numeric: tabular-nums; }
.eb-handle { cursor: grab; color: var(--text-muted); user-select: none; }
.eb-lock { padding-right: 4px; font-size: 12px; }
.eb-break { margin-left: 8px; font-size: var(--font-xs); color: var(--text-secondary); white-space: nowrap; }
.eb-actions { white-space: nowrap; text-align: right; }
.eb-preview { aspect-ratio: 16 / 9; border-radius: var(--radius-md, 8px); overflow: hidden; background: var(--bg-tertiary); margin-bottom: 10px; }
.eb-preview img { width: 100%; height: 100%; object-fit: cover; display: block; }
.eb-preview-empty { height: 100%; display: flex; align-items: center; justify-content: center; color: var(--text-muted); font-size: 13px; }
.eb-prompt { width: 100%; resize: vertical; font-size: 13px; line-height: 1.5; }
.eb-row { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-start; margin-top: 6px; }
.eb-top { margin-top: 12px; }
.eb-pictures { display: flex; flex-wrap: wrap; gap: 14px 22px; align-items: flex-start; }
.eb-model { min-width: 280px; flex: 0 1 380px; }
</style>

<style>
/* Unscoped: the swap/add and still dialogs are teleported and carry no scope id (see Modal.vue). */
.eb-hint { color: var(--text-muted); font-size: var(--font-xs, 12px); line-height: 1.4; }
.eb-muted { color: var(--text-muted); font-size: 12px; }
.eb-warn-chip { margin-left: 6px; padding: 0 6px; border-radius: 999px; font-size: var(--font-xs); border: 1px solid color-mix(in srgb, var(--warning) 40%, transparent); color: color-mix(in srgb, var(--warning) 70%, var(--text-primary)); }
.eb-pick { list-style: none; padding: 0; margin: 8px 0 0; max-height: 50vh; overflow: auto; }
.eb-pick-row { width: 100%; display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm, 6px); background: var(--bg-primary); margin-bottom: 6px; cursor: pointer; text-align: left; }
.eb-pick-row:hover { background: var(--bg-hover); }
.eb-stills { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 8px; margin-top: 10px; max-height: 55vh; overflow: auto; }
.eb-still { padding: 0; border: 1px solid var(--border); border-radius: var(--radius-sm, 6px); overflow: hidden; cursor: pointer; aspect-ratio: 16 / 9; background: var(--bg-tertiary); }
.eb-still img { width: 100%; height: 100%; object-fit: cover; display: block; }
.eb-dialog-title { font-size: 15px; margin: 0 0 8px; }
.eb-dialog-actions { display: flex; justify-content: flex-end; margin-top: 12px; }
</style>
