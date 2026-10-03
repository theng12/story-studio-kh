<!--
  v1.4.37 — Music Library: a channel's record collection, and the page that
  builds a music video from it.

  NOT the music panel inside Audio Merge. That one manages the background bed
  that ducks under narration — one track per episode. This is a library a
  music-mix video is BUILT FROM, many tracks at a time. Both stay, per the
  owner's ruling, because they are different jobs.

  THE PAGE IS ORGANISED AROUND WHAT SPENDS MONEY. Exactly one action here buys
  anything, and it says so and shows the cost first. Everything else — previewing
  a mix, building the video — reads the library and buys nothing. That is the
  same lesson as Repair vs Retry: a button that spends as a side effect of doing
  something else is how the owner got charged twice before.
-->
<template>
  <div>
    <div class="page-header">
      <Breadcrumb />
      <h1 class="page-title">Music Library</h1>
    </div>

    <p class="text-muted mt-2 mb-2" style="font-size: 13px;">
      Your channel's songs. Buy them once, use them in as many videos as you like —
      building a video never costs anything. You can also drop audio files straight
      into the folder in Finder and they appear here.
    </p>

    <!-- ── 1. The library ─────────────────────────────────────────── -->
    <section class="card mt-3">
      <div class="ml-head">
        <h3>1. Your songs</h3>
        <span v-if="library" class="text-muted text-sm">
          {{ library.tracks.length }} track(s) ·
          <!-- v1.4.199 — a track whose length could not be measured contributes
               nothing to the total, so the total is a floor. Saying "usable"
               alone presented a silent under-count as the whole answer. -->
          {{ library.unmeasured_enabled_tracks ? 'at least ' : ''
          }}{{ formatMinutes(library.available_seconds) }} usable<template
            v-if="library.unmeasured_enabled_tracks"
          > ({{ library.unmeasured_enabled_tracks }} without a measured length)</template>
        </span>
      </div>

      <div v-if="libraryLoadError" class="error-box mt-2" role="alert">
        {{ libraryLoadError }}
        <button type="button" class="btn btn-sm btn-ghost" :disabled="libraryLoading" @click="load">Retry</button>
      </div>

      <p v-if="!library && libraryLoading" class="text-muted mt-2 text-sm">Loading your songs…</p>
      <p v-if="library && !library.tracks.length" class="text-muted mt-2 text-sm">
        Nothing here yet. Add songs below, or drop audio files into
        <code>{{ library.folder }}</code>.
      </p>

      <div v-if="library && library.tracks.length" class="table-wrap mt-2">
        <table>
          <thead>
            <tr>
              <th>Title</th><th>Length</th><th>Used</th><th>Last used</th><th>On</th><th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="track in library.tracks" :key="track.filename">
              <td>
                <strong>{{ track.title }}</strong>
                <small v-if="track.sibling_group" class="sib" title="Came from the same request as another track — the mix keeps them apart">
                  take {{ track.sibling_index }}
                </small>
              </td>
              <td class="num">{{ track.duration_sec ? formatClock(track.duration_sec) : '—' }}</td>
              <td class="num">{{ track.times_used }}</td>
              <td class="text-muted text-sm">{{ track.last_used_at ? formatDate(track.last_used_at) : 'never' }}</td>
              <td>
                <input
                  type="checkbox"
                  :checked="track.enabled"
                  :aria-label="`Include ${track.title} in mixes`"
                  @change="setEnabled(track, ($event.target as HTMLInputElement).checked)"
                >
              </td>
              <td>
                <button class="btn btn-sm" @click="remove(track)">Remove</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="unmeasured" class="warn mt-2">
        {{ unmeasured }} track(s) have no measured length, so a mix will skip them.
      </p>
    </section>

    <!-- ── 2. Top up — THE ONLY PAID ACTION ───────────────────────── -->
    <section class="card mt-3">
      <h3>2. Add songs <span v-if="musicCost.basis === 'free'" class="free-flag">free</span><span v-else class="cost-flag">may cost credits</span></h3>
      <p class="text-muted text-sm mt-1">
        Describe the sound once. Each song gets its own instruction, so you don't
        get twenty versions of the same thing. Every variation the model returns is kept.
      </p>

      <label class="ml-label mt-2">The sound of this channel</label>
      <textarea
        v-model="brief"
        class="input"
        rows="3"
        placeholder="Warm lo-fi, rainy night, vinyl crackle, 80bpm"
      ></textarea>

      <div class="ml-row mt-2">
        <label class="ml-label">
          How many songs
          <input v-model.number="count" type="number" min="1" max="100" class="input narrow">
        </label>
        <label class="ml-label check">
          <input v-model="instrumental" type="checkbox">
          Instrumental (no singing)
        </label>
        <label v-if="instrumental" class="ml-label">
          Song length (minutes)
          <input v-model.number="trackMinutes" type="number" min="1" max="30" step="0.5" class="input narrow">
        </label>
      </div>
      <p v-if="!instrumental" class="text-muted small">
        With singing, the planner writes the lyrics and each song is as long as its lyrics need
        (about 30 seconds per verse or chorus).
      </p>

      <p v-if="genError" class="error-box mt-2">{{ genError }}</p>

      <!-- The published price of the model this page will actually use, with
           any sale shown AS a sale. Same shape the image picker uses. -->
      <p
        v-if="musicModel"
        class="notice notice-cost"
        :class="`basis-${musicCost.basis}`"
        :title="musicCost.title"
      >
        {{ CREDIT_BASIS_LABEL[musicCost.basis] }}: {{ musicCost.text }} <PriceDetails :cost="musicCost" />
        <span class="text-muted">— {{ musicModel.display_name }}</span>
      </p>

      <div class="ml-actions mt-2">
        <button class="btn btn-primary" :disabled="!brief.trim() || !validCount || generating" @click="topUp">
          {{ generating ? 'Starting…' : `Add ${count} Song(s)` }}
        </button>
        <span class="text-muted text-sm">{{ !brief.trim() ? 'Describe the sound first.' : !validCount ? 'Choose between 1 and 100 songs.' : 'Runs as a job — watch it on the Jobs page.' }}</span>
      </div>
    </section>

    <!-- ── 3. Build a video — FREE ────────────────────────────────── -->
    <section class="card mt-3">
      <h3>3. Build a video <span class="free-flag">free</span></h3>
      <p class="text-muted text-sm mt-1">
        Picks from the songs you already own. Never buys anything — if the library
        is too short it tells you rather than making a shorter video.
      </p>

      <div class="ml-row mt-2">
        <label class="ml-label">
          Episode
          <input v-model="episodeId" class="input narrow" placeholder="EP0001">
        </label>
        <label class="ml-label">
          Length (minutes)
          <input v-model.number="targetMinutes" type="number" min="1" max="600" class="input narrow">
        </label>
        <label class="ml-label">
          Gap between takes
          <input v-model.number="siblingGap" type="number" min="0" max="50" class="input narrow">
        </label>
      </div>

      <label class="ml-label mt-2">Background image or clip</label>
      <FilePicker
        v-model="backgroundPath"
        placeholder="Choose a picture or short clip"
        :filters="[{ name: 'Images and clips', extensions: ['png', 'jpg', 'jpeg', 'webp', 'mp4', 'mov', 'm4v'] }]"
        title="Choose the background for this music video"
        clearable
      />

      <div class="ml-actions mt-2">
        <button class="btn" :disabled="previewing" @click="preview">
          {{ previewing ? 'Checking…' : 'Preview the Tracklist' }}
        </button>
        <button
          class="btn btn-primary"
          :disabled="!episodeId.trim() || !backgroundPath.trim() || rendering"
          @click="render"
        >
          {{ rendering ? 'Starting…' : 'Build the Video' }}
        </button>
        <span v-if="!episodeId.trim() || !backgroundPath.trim()" class="text-muted text-sm">
          {{ !episodeId.trim() ? 'Type the episode code first.' : 'Choose a background first.' }}
        </span>
      </div>

      <p v-if="renderError" class="error-box mt-2">{{ renderError }}</p>

      <div v-if="plan" class="preview mt-3">
        <div class="ml-head">
          <strong>{{ plan.entries.length }} track(s) · {{ formatMinutes(plan.total_sec) }}</strong>
          <span v-if="plan.shortfall_sec > 0" class="warn-inline">
            {{ formatMinutes(plan.shortfall_sec) }} short
          </span>
        </div>
        <p v-for="(note, i) in plan.notes" :key="i" class="text-muted text-sm mt-1">{{ note }}</p>
        <pre v-if="plan.tracklist" class="tracklist mt-2">{{ plan.tracklist }}</pre>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { CREDIT_BASIS_LABEL, describeMusicUnitCost, type PricedMusicModel } from '../../../utils/genstudio-credit-cost.js'
import { pickDefaultMusicModel } from '../../../../electron/server/contracts/music-model-choice'
import { UNCONFIRMED_SUBMISSION } from '../../../composables/useFreshGenerationAction'

definePageMeta({ layout: 'dashboard' })
useAppTitle('Music Library')
const route = useRoute()
const slug = computed(() => String(route.params.slug || ''))
const { get, post, patch, del } = useApi()
const freshMusicAction = useFreshGenerationAction()
const { success, error: showError } = useToast()

interface LibraryTrack {
  filename: string
  title: string
  enabled: boolean
  duration_sec?: number
  sibling_group?: string
  sibling_index?: number
  times_used: number
  last_used_at: string | null
}
interface LibraryState { tracks: LibraryTrack[]; folder: string; available_seconds: number; unmeasured_enabled_tracks: number }
interface MixPlan {
  entries: { filename: string; title: string; start_sec: number; duration_sec: number }[]
  total_sec: number
  shortfall_sec: number
  notes: string[]
  tracklist: string
}

const library = ref<LibraryState | null>(null)
const libraryLoadError = ref('')
const libraryLoading = ref(false)
let libraryScopeEpoch = 0
let libraryLoadSequence = 0
const brief = ref('')
const count = ref(10)
const instrumental = ref(true)
// Four minutes unless changed: Stable Audio 3's own default is 30 s, far shorter than a library track.
const trackMinutes = ref(4)
const generating = ref(false)
const genError = ref('')

const episodeId = ref(typeof route.query.episode_id === 'string' ? route.query.episode_id : '')
const targetMinutes = ref(60)
const siblingGap = ref(5)
const backgroundPath = ref('')
const plan = ref<MixPlan | null>(null)
const previewing = ref(false)
const rendering = ref(false)
const renderError = ref('')

const validCount = computed(() => Number.isInteger(count.value) && count.value >= 1 && count.value <= 100)
const unmeasured = computed(() =>
  (library.value?.tracks || []).filter(t => !t.duration_sec).length)

/**
 * The price of adding a song, shown before the customer spends anything.
 *
 * WHICH MODEL. This page sends no model id, and `generators/music-generate.ts`
 * therefore falls back to the first entry of the published catalogue. So the
 * first entry is the model the customer will actually be charged for, and it
 * is the one priced here — the name is printed beside the figure so the price
 * is never attached to an unnamed model.
 *
 * WHY A PRICE AT ALL. The section carried a static "costs credits" badge and
 * no number, so a music sale was invisible: a customer paying a discounted
 * rate could not tell it was discounted, and one paying list could not tell
 * they had missed a sale. The owner's ruling is to show the full price with a
 * discount tag on it, which is what `describeMusicUnitCost` renders.
 */
const musicModels = ref<PricedMusicModel[]>([])
// The model the backend will charge for: the first published row that can make a lyric-less
// track (a vocal-only model such as YuE2 cannot), chosen by the same function it uses.
const musicModel = computed(() =>
  pickDefaultMusicModel(musicModels.value, { instrumental: instrumental.value, hasLyrics: false }) || null)
const musicCost = computed(() => describeMusicUnitCost(musicModel.value))

async function loadMusicModels() {
  try {
    const r = await get<{ models: PricedMusicModel[] }>('/app-settings/genstudio/music-models')
    musicModels.value = Array.isArray(r.models) ? r.models : []
  } catch {
    // No key, offline, or GenStudio down. The page still works; it simply
    // shows no price rather than inventing one.
    musicModels.value = []
  }
}

function formatClock(seconds: number): string {
  const s = Math.floor(seconds)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
function formatMinutes(seconds: number): string {
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
}
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString()
}

async function load() {
  const projectSlug = slug.value
  const scopeEpoch = libraryScopeEpoch
  const request = ++libraryLoadSequence
  const current = () => request === libraryLoadSequence && scopeEpoch === libraryScopeEpoch && slug.value === projectSlug
  libraryLoading.value = true
  libraryLoadError.value = ''
  try {
    const data = await get<LibraryState>(`/projects/${projectSlug}/music-library`)
    if (!current()) return
    library.value = data
  } catch (e: any) {
    if (current()) libraryLoadError.value = e?.data?.detail || e?.message || 'Could not load the music library.'
  } finally {
    if (current()) libraryLoading.value = false
  }
}

async function setEnabled(track: LibraryTrack, enabled: boolean) {
  try { library.value = await patch(`/projects/${slug.value}/music-library/tracks/${encodeURIComponent(track.filename)}`, { enabled }) }
  catch (e: any) { showError(e?.data?.detail || 'Could not update the track') }
}

async function remove(track: LibraryTrack) {
  if (!await useConfirm().ask({ title: 'Remove music track?', message: `Remove "${track.title}" from the library? The file moves to this project's _trash folder, so you can put it back from Finder.`, confirmLabel: 'Remove', danger: true })) return
  try {
    library.value = await del(`/projects/${slug.value}/music-library/tracks/${encodeURIComponent(track.filename)}`)
    success(`Removed ${track.title}`)
  } catch (e: any) { showError(e?.data?.detail || 'Could not remove the track') }
}

async function topUp() {
  generating.value = true
  genError.value = ''
  const payload = {
    brief: brief.value, count: count.value, instrumental: instrumental.value,
    ...(instrumental.value && trackMinutes.value > 0 ? { duration_seconds: Math.round(trackMinutes.value * 60) } : {}),
  }
  const operationId = freshMusicAction.begin(payload)
  try {
    await post(`/projects/${slug.value}/music-library/generate`, {
      ...payload,
      operation_id: operationId,
    })
    freshMusicAction.complete(operationId)
    success(`Adding ${count.value} song(s). Watch it on the Jobs page; the library fills as they arrive.`)
  } catch (e: any) {
    genError.value = e?.data?.detail || e?.message || UNCONFIRMED_SUBMISSION
  } finally { generating.value = false }
}

async function preview() {
  previewing.value = true
  renderError.value = ''
  try {
    plan.value = await post(`/projects/${slug.value}/music-library/preview-mix`, {
      target_seconds: targetMinutes.value * 60,
      episode_id: episodeId.value || 'preview',
      sibling_gap_tracks: siblingGap.value,
    })
  } catch (e: any) {
    renderError.value = e?.data?.detail || 'Could not plan the mix'
  } finally { previewing.value = false }
}

async function render() {
  rendering.value = true
  renderError.value = ''
  try {
    await post(`/projects/${slug.value}/music-library/render`, {
      episode_id: episodeId.value,
      target_seconds: targetMinutes.value * 60,
      background_path: backgroundPath.value,
      sibling_gap_tracks: siblingGap.value,
    })
    success(`Building the video for ${episodeId.value}. Nothing was charged.`)
  } catch (e: any) {
    renderError.value = e?.data?.detail || 'Could not start the video'
  } finally { rendering.value = false }
}

watch(() => [slug.value, route.query.episode_id], () => {
  episodeId.value = typeof route.query.episode_id === 'string' ? route.query.episode_id : ''
})

watch(slug, () => {
  libraryScopeEpoch++
  library.value = null
  libraryLoadError.value = ''
  libraryLoading.value = false
  void load()
}, { flush: 'sync' })

onMounted(() => { void load(); void loadMusicModels() })
</script>

<style scoped>
.ml-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.ml-row { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-end; }
.ml-label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
.ml-label.check { flex-direction: row; align-items: center; gap: 6px; }
.ml-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.input.narrow { width: 110px; }
.table-wrap { overflow-x: auto; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.sib { margin-left: 6px; opacity: .65; font-size: 12px; }
.cost-flag, .free-flag {
  font-size: 12px; padding: 2px 8px; border-radius: 3px; margin-left: 8px; vertical-align: middle;
}
.cost-flag { background: rgba(220, 150, 60, .16); color: #c2803a; }
/* Same shape as ImageModelPicker's price line, so a price reads the same
   wherever in the app it appears. */
.notice { margin: 10px 0 0; color: var(--warning, #d97706); font-size: var(--font-xs); line-height: 1.4; }
.notice-cost { color: var(--text); }
.notice-cost.basis-unpublished { color: var(--warning, #d97706); }
.notice-cost.basis-free { color: var(--success, #16a34a); }
.free-flag { background: rgba(80, 160, 120, .16); color: #3f8f68; }
.warn, .warn-inline { color: #c2803a; font-size: 13px; }
.tracklist {
  white-space: pre-wrap; font-size: 13px; line-height: 1.6; max-height: 320px; overflow-y: auto;
  padding: 12px; border-radius: 4px; background: rgba(127, 127, 127, .08);
}
.preview { border-top: 1px solid rgba(127, 127, 127, .25); padding-top: 12px; }
</style>
