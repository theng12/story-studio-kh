<template>
  <div>
    <div class="page-header">
      <Breadcrumb />
      <h1 class="page-title">Audio Assembly</h1>
    </div>
    <TopActionBar
      :project-slug="slug"
      :presets="mergePresets"
      v-model:episode-id="episodeId"
      filter-field="merged_audio"
      :generate-label="generateLabel"
      loading-label="Merging…"
      :generate-loading="generating"
      :generate-disabled="!chapters.length"
      :generate-status="generating ? `Merging audio for ${selectedEpisode?.title || episodeId}…` : ''"
      @generate="onGenerateClick"
      @episode-selected="onEpisodeSelected"
      @preset-applied="success('Preset applied')"
      @preset-saved="onPresetSaved"
      @preset-deleted="success('Preset deleted')"
    />

    <p class="text-muted mt-1 mb-2">
      Merges chapter narration into a single file, optionally layered with an intro clip, background music, and ambience.
      Mixing order is fixed: <strong>Intro → Narration (with music ducked under) → Ambience layered throughout</strong>.
      Reorder chapters and tune silences below.
    </p>

    <!-- FFmpeg Status -->
    <div class="ffmpeg-status mt-2" v-if="ffmpegStatus">
      <span v-if="ffmpegStatus.installed" class="badge badge-success">
        FFmpeg installed{{ ffmpegStatus.version ? ` (v${ffmpegStatus.version})` : '' }}
      </span>
      <template v-else>
        <span class="badge badge-error">FFmpeg not found</span>
        <!-- Audio merge depends on FFmpeg for the chapter concat + music
             mix step. When it's missing, give the user a one-tap path to
             the Settings → FFmpeg tab where the auto-installer lives,
             instead of leaving them with just an error badge. -->
        <NuxtLink :to="`/projects/${slug}/settings#ffmpeg`" class="btn btn-sm btn-primary" style="margin-left: 8px;">
          Install FFmpeg →
        </NuxtLink>
        <span class="text-muted" style="font-size: 11px; margin-left: 8px;">
          One-click installer in Settings · no admin needed
        </span>
      </template>
    </div>

    <div v-if="scanning" class="card mt-2 scanning-status">
      <span class="gen-label">Scanning audio assets...</span>
      <div class="progress-bar mt-1"><div class="progress-fill" /></div>
    </div>

    <!-- Missing narration audio — can't merge without it. Surface loudly with -->
    <!-- a one-click route to the Audio Generator so the user doesn't have to -->
    <!-- guess the next step. -->
    <div v-if="episodeId && scannedAssets && !scanning && !chapters.length" class="card mt-2 no-audio-warning">
      <div class="warning-icon">⚠️</div>
      <div class="warning-body">
        <h3 class="warning-title">No narration audio for this episode</h3>
        <p class="text-muted mt-1">
          Audio Assembly merges chapter narration with music + ambience. You need to generate the chapter audio first —
          there's nothing to merge yet for {{ selectedEpisode?.title || episodeId }}.
        </p>
        <div class="flex gap-2 mt-2">
          <NuxtLink :to="`/projects/${slug}/audio?episode=${episodeId}`" class="btn btn-primary btn-sm">
            Go to Audio Generator →
          </NuxtLink>
          <button class="btn btn-sm btn-secondary" @click="scanAssets" :disabled="scanning">
            Re-scan
          </button>
        </div>
      </div>
    </div>

    <!-- Chapter Management -->
    <div v-if="scannedAssets && !scanning && chapters.length" class="card mt-2">
      <h3>Narration Chapters</h3>
      <p class="text-muted mt-1">
        Drag the ▲▼ arrows to reorder chapters. The intro clip (if enabled) always plays first — reordering chapters
        doesn't change intro timing. The silence gap below is inserted between every chapter, but not before the first.
      </p>

      <div v-if="chapters.length" class="audio-list-reorder mt-2">
        <div v-for="(ch, i) in chapters" :key="ch.path" class="audio-item-reorder">
          <span class="audio-order-num">{{ i + 1 }}</span>
          <button class="btn-icon play-btn" @click="toggleChapterPreview(ch.path)" :title="playingPath === ch.path ? 'Stop' : 'Play'">
            {{ playingPath === ch.path ? '&#9724;' : '&#9654;' }}
          </button>
          <span class="audio-name" style="flex:1">{{ ch.label || ch.filename }}</span>
          <span class="text-muted" style="font-size: 12px; min-width: 60px; text-align: right;">{{ formatDuration(ch.duration) }}</span>
          <div class="audio-reorder-btns">
            <button class="btn-icon" :disabled="i === 0" @click="moveChapter(i, -1)" title="Move up">&#9650;</button>
            <button class="btn-icon" :disabled="i === chapters.length - 1" @click="moveChapter(i, 1)" title="Move down">&#9660;</button>
          </div>
        </div>
      </div>

      <!-- Gap Duration -->
      <div class="form-group mt-2" style="max-width: 300px;">
        <label>Silence Between Chapters ({{ gapDuration }}s)</label>
        <input v-model.number="gapDuration" type="range" min="0" max="30" step="1" class="slider" />
        <span class="text-muted" style="font-size: 11px;">Inserted between each chapter (Introduction → Ch1 → Ch2 → ...)</span>
      </div>

      <!-- Total Duration -->
      <div class="summary-bar mt-2" v-if="chapters.length">
        Total narration: {{ formatDuration(totalChapterDuration) }} + {{ (chapters.length - 1) * gapDuration }}s gaps = {{ formatDuration(estimatedMergedDuration) }}
      </div>
    </div>

    <!-- Intro Audio -->
    <div v-if="chapters.length" class="card mt-2">
      <div class="flex gap-2" style="align-items: center;">
        <label class="checkbox-label" @click.stop>
          <input type="checkbox" v-model="intro.enabled" />
        </label>
        <h3>Intro Audio</h3>
      </div>
      <p class="text-muted mt-1" style="font-size: 12px;">
        Optional intro clip prepended to the narration (e.g. channel jingle, theme music).
      </p>

      <div v-if="intro.enabled" class="mt-2">
        <div class="flex gap-2">
          <input v-model="intro.file" class="input" placeholder="Path to intro audio file" style="flex:1" />
          <button class="btn btn-sm btn-secondary" @click="browseIntroFile">Browse…</button>
          <button v-if="intro.file"
            :class="['btn btn-sm', playingPath === intro.file ? 'btn-primary' : 'btn-secondary']"
            @click="togglePreview(intro.file)">
            {{ playingPath === intro.file ? 'Stop' : 'Preview' }}
          </button>
        </div>

        <div class="grid-2 mt-2">
          <div class="form-group">
            <label>Volume ({{ intro.volume }}%)</label>
            <input v-model.number="intro.volume" type="range" min="0" max="100" step="1" class="slider" />
          </div>
          <div class="form-group">
            <label>Gap after intro ({{ intro.gap_after }}s)</label>
            <input v-model.number="intro.gap_after" type="range" min="0" max="10" step="0.5" class="slider" />
          </div>
        </div>
      </div>
    </div>

    <!-- Volume Normalization -->
    <div v-if="chapters.length" class="card mt-2">
      <div class="flex gap-2" style="align-items: center;">
        <label class="checkbox-label" @click.stop>
          <input type="checkbox" v-model="normalizeVolume" />
        </label>
        <h3>Volume Normalization</h3>
      </div>
      <p class="text-muted mt-1">
        Equalize volume levels across all chapters using FFmpeg's loudnorm filter (EBU R128 standard).
        This ensures consistent volume throughout the narration.
      </p>
      <p v-if="normalizeVolume" class="text-muted mt-1" style="font-size: 12px;">
        Two-pass normalization: first measures each chapter, then applies corrections. Adds processing time.
      </p>
    </div>

    <!-- Background Music -->
    <div v-if="chapters.length" class="card mt-2">
      <div class="flex gap-2" style="align-items: center;">
        <label class="checkbox-label" @click.stop>
          <input type="checkbox" v-model="music.enabled" />
        </label>
        <h3>Background Music</h3>
      </div>

      <div v-if="music.enabled" class="mt-2">
        <!-- Music File List with Play Buttons -->
        <div v-if="music.files.length" class="music-file-list">
          <div v-for="(file, i) in music.files" :key="i" class="music-file-item">
            <button class="btn-icon play-btn" @click="togglePreview(file)" :title="playingPath === file ? 'Stop' : 'Preview'">
              {{ playingPath === file ? '&#9724;' : '&#9654;' }}
            </button>
            <span class="music-filename">{{ file.split('/').pop() }}</span>
            <button class="btn-icon danger" @click="music.files.splice(i, 1)" title="Remove">&#10005;</button>
          </div>
        </div>
        <p v-else class="text-muted" style="font-size: 12px;">No music files added yet</p>

        <!-- Add music file -->
        <div class="flex gap-2 mt-1">
          <input v-model="newMusicPath" class="input" placeholder="Path to audio file" style="flex:1" />
          <button class="btn btn-sm btn-secondary" @click="browseMusicFile">Browse…</button>
          <button class="btn btn-sm btn-secondary" @click="addMusicFile" :disabled="!newMusicPath">Add</button>
        </div>

        <!-- Quick-add from scanned files -->
        <div v-if="scannedMusicFiles.length" class="quick-add-music mt-1">
          <span class="text-muted" style="font-size: 11px;">Found in project:</span>
          <div class="flex gap-2 mt-1" style="flex-wrap: wrap;">
            <button v-for="mf in scannedMusicFiles" :key="mf.path"
              class="btn btn-sm btn-secondary"
              :disabled="music.files.includes(mf.path)"
              @click="music.files.push(mf.path)">
              + {{ mf.filename }}
            </button>
          </div>
        </div>

        <!-- Volume controls -->
        <div class="grid-2 mt-2">
          <div class="form-group">
            <label>Volume During Narration ({{ music.volume }}%)</label>
            <input v-model.number="music.volume" type="range" min="0" max="100" step="1" class="slider" />
          </div>
          <div class="form-group">
            <label>Volume After Narration ({{ music.post_narration_volume }}%)</label>
            <input v-model.number="music.post_narration_volume" type="range" min="0" max="100" step="1" class="slider" />
          </div>
        </div>
        <div class="grid-2 mt-1">
          <div class="form-group">
            <label>Fade In ({{ music.fade_in }}s)</label>
            <input v-model.number="music.fade_in" type="range" min="0" max="10" step="0.5" class="slider" />
          </div>
          <div class="form-group">
            <label>Fade Out ({{ music.fade_out }}s)</label>
            <input v-model.number="music.fade_out" type="range" min="0" max="10" step="0.5" class="slider" />
          </div>
        </div>
      </div>
    </div>

    <!-- Background Noise -->
    <div v-if="chapters.length" class="card mt-2">
      <div class="flex gap-2" style="align-items: center;">
        <label class="checkbox-label" @click.stop>
          <input type="checkbox" v-model="backgroundNoise.enabled" />
        </label>
        <h3>Background Noise / Ambience</h3>
      </div>

      <div v-if="backgroundNoise.enabled" class="mt-2">
        <div class="flex gap-2 mt-1">
          <button
            :class="['btn btn-sm', backgroundNoise.mode === 'preset' ? 'btn-primary' : 'btn-secondary']"
            @click="backgroundNoise.mode = 'preset'"
          >FFmpeg Presets</button>
          <button
            :class="['btn btn-sm', backgroundNoise.mode === 'custom' ? 'btn-primary' : 'btn-secondary']"
            @click="backgroundNoise.mode = 'custom'"
          >Custom File</button>
        </div>

        <!-- Preset selector -->
        <div v-if="backgroundNoise.mode === 'preset'" class="mt-2">
          <div class="noise-preset-grid">
            <div v-for="np in noisePresets" :key="np.id"
              :class="['noise-preset-card', { active: backgroundNoise.preset === np.id }]"
              @click="backgroundNoise.preset = np.id">
              <span class="np-name">{{ np.label }}</span>
              <span class="np-desc">{{ np.description }}</span>
            </div>
          </div>
        </div>

        <!-- Custom file -->
        <div v-if="backgroundNoise.mode === 'custom'" class="mt-2">
          <div class="flex gap-2">
            <input v-model="backgroundNoise.custom_file" class="input" placeholder="Path to ambience audio file" style="flex:1" />
            <button class="btn btn-sm btn-secondary" @click="browseNoiseFile">Browse…</button>
            <button v-if="backgroundNoise.custom_file"
              :class="['btn btn-sm', playingPath === backgroundNoise.custom_file ? 'btn-primary' : 'btn-secondary']"
              @click="togglePreview(backgroundNoise.custom_file)">
              {{ playingPath === backgroundNoise.custom_file ? 'Stop' : 'Preview' }}
            </button>
          </div>
        </div>

        <!-- Volume -->
        <div class="grid-3 mt-2">
          <div class="form-group">
            <label>Volume ({{ backgroundNoise.volume }}%)</label>
            <input v-model.number="backgroundNoise.volume" type="range" min="0" max="100" step="1" class="slider" />
          </div>
          <div class="form-group">
            <label>Fade In ({{ backgroundNoise.fade_in }}s)</label>
            <input v-model.number="backgroundNoise.fade_in" type="range" min="0" max="10" step="0.5" class="slider" />
          </div>
          <div class="form-group">
            <label>Fade Out ({{ backgroundNoise.fade_out }}s)</label>
            <input v-model.number="backgroundNoise.fade_out" type="range" min="0" max="10" step="0.5" class="slider" />
          </div>
        </div>
      </div>
    </div>

    <!-- Generate -->
    <div v-if="chapters.length" class="card mt-2">
      <h3>Generate Merged Audio</h3>

      <!-- Existing merged audio + write-mode decision (surfaced upfront so -->
      <!-- the user picks before hitting Generate, not in a mid-flow modal). -->
      <div v-if="existingMergedAudio" class="write-mode-panel mt-2">
        <div class="write-mode-header">
          <span class="badge badge-success">Merged audio exists</span>
          <span class="text-muted" style="font-size: 12px;">
            {{ existingMergedAudio.path.split('/').pop() }} ({{ formatDuration(existingMergedAudio.duration) }})
          </span>
          <button class="btn-icon play-btn" @click="togglePreview(existingMergedAudio.path)" :title="playingPath === existingMergedAudio.path ? 'Stop' : 'Preview'">
            {{ playingPath === existingMergedAudio.path ? '&#9724;' : '&#9654;' }}
          </button>
        </div>
        <p class="text-muted mt-1" style="font-size: 12px;">
          Choose what happens when you click Generate:
        </p>
        <div class="write-mode-options mt-1">
          <label :class="['write-mode-option', { active: writeMode === 'new' }]">
            <input type="radio" value="new" v-model="writeMode" />
            <div class="write-mode-content">
              <span class="write-mode-title">Save as new version</span>
              <span class="write-mode-desc">Keeps the existing file. Saved as {{ nextVersionName }} alongside it — safe default.</span>
            </div>
          </label>
          <label :class="['write-mode-option', { active: writeMode === 'overwrite' }]">
            <input type="radio" value="overwrite" v-model="writeMode" />
            <div class="write-mode-content">
              <span class="write-mode-title">Replace existing</span>
              <span class="write-mode-desc">Overwrites {{ existingMergedAudio.path.split('/').pop() }}. Cannot be undone.</span>
            </div>
          </label>
        </div>
      </div>

      <!-- Summary -->
      <div class="summary-panel mt-2">
        <div class="summary-grid">
          <div class="summary-row">
            <span class="text-muted">Chapters</span>
            <span>{{ chapters.length }} ({{ formatDuration(estimatedMergedDuration) }})</span>
          </div>
          <div class="summary-row">
            <span class="text-muted">Silence Gaps</span>
            <span>{{ gapDuration }}s between each chapter</span>
          </div>
          <div class="summary-row">
            <span class="text-muted">Normalize</span>
            <span>{{ normalizeVolume ? 'Yes (EBU R128)' : 'No' }}</span>
          </div>
          <div class="summary-row">
            <span class="text-muted">Music</span>
            <span>{{ music.enabled && music.files.length ? music.files.length + ' file(s), ' + music.volume + '% vol' : 'None' }}</span>
          </div>
          <div class="summary-row">
            <span class="text-muted">Noise</span>
            <span>{{ backgroundNoise.enabled ? (backgroundNoise.mode === 'preset' ? backgroundNoise.preset.replace(/-/g, ' ') : 'Custom') + ', ' + backgroundNoise.volume + '% vol' : 'None' }}</span>
          </div>
        </div>
      </div>

    </div>

    <!-- Merged-audio integrity pill. One merged file per episode, so "missing" -->
    <!-- = no {code}_merged_audio*.mp3 with content. Refresh-only here; use the -->
    <!-- Generate button above to actually create the file. -->
    <div v-if="episodeId" class="card mt-2" aria-labelledby="merge-integrity-heading">
      <h3 id="merge-integrity-heading" style="margin-bottom: 6px;">Merged audio integrity</h3>
      <div v-if="mergeStatus.loading" class="text-muted" style="font-size: 13px;">
        <LoadingSpinner size="sm" /> Checking…
      </div>
      <div v-else-if="mergeStatus.error" class="text-danger" style="font-size: 13px;">
        {{ mergeStatus.error }}
        <button class="btn btn-sm btn-ghost ml-2" @click="refreshMergeStatus">Retry</button>
      </div>
      <div v-else class="flex items-center gap-2" style="flex-wrap: wrap;">
        <span class="integrity-pill" :class="mergeStatus.present ? 'ok' : 'warn'">
          <template v-if="mergeStatus.present">✓ Merged audio present ({{ mergeStatus.file }})</template>
          <template v-else>⚠ Merged audio not yet generated</template>
        </span>
        <button class="btn btn-sm btn-ghost" :disabled="mergeStatus.loading" @click="refreshMergeStatus">
          Refresh
        </button>
      </div>
    </div>

  </div>
</template>

<script setup lang="ts">
definePageMeta({ layout: 'dashboard' })
useHead({ title: 'Audio Assembly — Story Studio KH' })

const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { get, post } = useApi()
const { success, error: showError } = useToast()
const { ask } = useConfirm()
const { audioMergeGenerating } = useGenerating()

// ── State ──
const episodeId = ref('')
const selectedEpisode = ref<any>(null)
const ffmpegStatus = ref<{ installed: boolean; version?: string } | null>(null)
const scannedAssets = ref<any>(null)
const scanning = ref(false)
const generating = ref(false)

// ── Merged-audio integrity pill ──
interface MergeStatusState { loading: boolean; error: string; present: boolean; file: string }
const mergeStatus = reactive<MergeStatusState>({
  loading: false, error: '', present: false, file: '',
})

async function refreshMergeStatus() {
  if (!episodeId.value) return
  mergeStatus.loading = true
  mergeStatus.error = ''
  try {
    const r = await get<any>(`/projects/${slug.value}/episodes/${episodeId.value}/audio-merge-status`)
    mergeStatus.present = !!r.present
    mergeStatus.file = r.file || ''
  } catch (e: any) {
    mergeStatus.error = e?.data?.detail || e?.message || 'Could not check merge integrity'
  } finally {
    mergeStatus.loading = false
  }
}

watch(() => episodeId.value, (v) => { if (v) refreshMergeStatus() }, { immediate: true })

const gapDuration = ref(5)
const normalizeVolume = ref(false)

const chapters = ref<Array<{ filename: string; path: string; label: string; duration?: number }>>([])

const music = reactive({
  enabled: false,
  files: [] as string[],
  volume: 15,
  post_narration_volume: 40,
  fade_in: 3,
  fade_out: 5,
})
const newMusicPath = ref('')

const backgroundNoise = reactive({
  enabled: false,
  mode: 'preset' as 'preset' | 'custom',
  preset: 'brown-noise' as string,
  custom_file: '',
  volume: 15,
  fade_in: 3,
  fade_out: 5,
})

const intro = reactive({
  enabled: false,
  file: '',
  volume: 100,
  gap_after: 2,
})

// ── Presets ───────────────────────────────────────────────────────────────
// Unified preset wiring (matches every other generator page). A one-time
// migration in onMounted moves the old flat-shape `audio_merge_presets`
// entries into the `{id, name, data}` shape usePresets expects.
const mergePresets = usePresets<any>({
  slug: slug.value,
  configKey: 'audio_merge',
  snapshot: () => ({
    intro: JSON.parse(JSON.stringify(intro)),
    music: JSON.parse(JSON.stringify(music)),
    background_noise: JSON.parse(JSON.stringify(backgroundNoise)),
    gap_duration: gapDuration.value,
    normalize_volume: normalizeVolume.value,
  }),
  apply: (data) => {
    if (!data) return
    if (data.intro) Object.assign(intro, data.intro)
    if (data.music) Object.assign(music, data.music, { files: [...(data.music.files || [])] })
    if (data.background_noise) Object.assign(backgroundNoise, data.background_noise)
    if (typeof data.gap_duration === 'number') gapDuration.value = data.gap_duration
    if (typeof data.normalize_volume === 'boolean') normalizeVolume.value = data.normalize_volume
  },
})

// Audio preview
const previewAudio = ref<HTMLAudioElement | null>(null)
const playingPath = ref('')

const noisePresets = [
  { id: 'brown-noise', label: 'Brown Noise', description: 'Deep, rumbling — best for sleep' },
  { id: 'pink-noise', label: 'Pink Noise', description: 'Balanced, natural sounding' },
  { id: 'white-noise', label: 'White Noise', description: 'Even frequencies, static-like' },
]

// ── Computed ──
const totalChapterDuration = computed(() => {
  return chapters.value.reduce((sum, ch) => sum + (ch.duration || 0), 0)
})

const estimatedMergedDuration = computed(() => {
  const gaps = (chapters.value.length - 1) * gapDuration.value
  return totalChapterDuration.value + gaps
})

const scannedMusicFiles = computed(() => {
  return scannedAssets.value?.music_files || []
})

const existingMergedAudio = computed(() => {
  const files = scannedAssets.value?.merged_files
  return files?.length ? files[0] : null
})

// ── Functions ──
function formatDuration(seconds: number | undefined): string {
  if (!seconds || seconds <= 0) return '0s'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.round(seconds % 60)
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m === 0) return `${s}s`
  return `${m}m ${s}s`
}

function moveChapter(index: number, direction: -1 | 1) {
  const newIndex = index + direction
  if (newIndex < 0 || newIndex >= chapters.value.length) return
  const a = chapters.value[index]
  const b = chapters.value[newIndex]
  if (!a || !b) return
  chapters.value[index] = b
  chapters.value[newIndex] = a
}

function togglePreview(filePath: string) {
  if (playingPath.value === filePath) {
    previewAudio.value?.pause()
    previewAudio.value = null
    playingPath.value = ''
    return
  }
  previewAudio.value?.pause()
  const url = `/api/projects/${slug.value}/audio-editor/preview-audio?path=${encodeURIComponent(filePath)}`
  const audio = new Audio(url)
  audio.onended = () => { playingPath.value = ''; previewAudio.value = null }
  audio.play()
  previewAudio.value = audio
  playingPath.value = filePath
}

function toggleChapterPreview(filePath: string) {
  togglePreview(filePath)
}

function addMusicFile() {
  if (newMusicPath.value && !music.files.includes(newMusicPath.value)) {
    music.files.push(newMusicPath.value)
    newMusicPath.value = ''
  }
}

const AUDIO_FILTERS = [
  { name: 'Audio', extensions: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'] },
  { name: 'All Files', extensions: ['*'] },
]

async function browseMusicFile() {
  try {
    const r = await post<{ path: string | null }>('/system/pick-file', {
      title: 'Choose a music file',
      buttonLabel: 'Add Music',
      filters: AUDIO_FILTERS,
    })
    if (r.path && !music.files.includes(r.path)) music.files.push(r.path)
  } catch (e: any) {
    showError(`Music file picker failed — ${e.data?.detail || e.message || 'unknown error'}`)
  }
}

async function browseNoiseFile() {
  try {
    const r = await post<{ path: string | null }>('/system/pick-file', {
      title: 'Choose an ambience file',
      buttonLabel: 'Use This File',
      filters: AUDIO_FILTERS,
    })
    if (r.path) backgroundNoise.custom_file = r.path
  } catch (e: any) {
    showError(`Ambience file picker failed — ${e.data?.detail || e.message || 'unknown error'}`)
  }
}

async function browseIntroFile() {
  try {
    const r = await post<{ path: string | null }>('/system/pick-file', {
      title: 'Choose an intro audio file',
      buttonLabel: 'Use This File',
      filters: AUDIO_FILTERS,
    })
    if (r.path) intro.file = r.path
  } catch (e: any) {
    showError(`Intro file picker failed — ${e.data?.detail || e.message || 'unknown error'}`)
  }
}

// ── Toast for save — names the preset so the user has unambiguous feedback
// that the save worked AND that the preset is now the active selection.
function onPresetSaved() {
  const activeId = mergePresets.activeId.value
  const p = mergePresets.presets.value.find(x => x.id === activeId)
  success(p ? `Saved: ${p.name} (now active)` : 'Preset saved')
}

async function checkFfmpeg() {
  try {
    ffmpegStatus.value = await get<any>(`/projects/${slug.value}/audio-editor/check-ffmpeg`)
  } catch {
    ffmpegStatus.value = { installed: false }
  }
}

async function scanAssets() {
  if (!episodeId.value) return
  scanning.value = true
  scannedAssets.value = null
  chapters.value = []
  try {
    scannedAssets.value = await get(`/projects/${slug.value}/audio-editor/scan/${episodeId.value}`)
    if (scannedAssets.value?.chapters?.length) {
      chapters.value = [...scannedAssets.value.chapters]
    }
  } catch (e: any) {
    showError(e.data?.detail || 'Failed to scan assets')
  } finally {
    scanning.value = false
  }
}

function onEpisodeSelected(ep: any) {
  selectedEpisode.value = ep
  scanAssets()
}

// Write-mode radio choice lives inline in the Generate card (see template).
// Default is 'new' so first-time Generate with an existing file doesn't
// silently clobber. When no prior merge exists, the choice is hidden and
// the mode is effectively 'overwrite' (an empty slot — nothing to replace).
const writeMode = ref<'overwrite' | 'new'>('new')

watch(existingMergedAudio, (cur) => {
  // No prior file → there's nothing to save-as-new against, default to
  // 'overwrite' so the Generate button reads naturally. When a file appears
  // (after a generation completes), flip back to the safe 'new' default.
  writeMode.value = cur ? 'new' : 'overwrite'
}, { immediate: true })

const nextVersionName = computed(() => {
  const cur = existingMergedAudio.value?.path?.split('/').pop() || ''
  const m = cur.match(/_v(\d+)\.mp3$/)
  const nextV = m ? parseInt(m[1], 10) + 1 : 2
  return cur.replace(/(_v\d+)?\.mp3$/, `_v${nextV}.mp3`)
})

const generateLabel = computed(() => {
  if (!existingMergedAudio.value) return 'Generate Merged Audio'
  return writeMode.value === 'overwrite' ? 'Replace Existing Merge' : `Save as ${nextVersionName.value.split('/').pop()}`
})

function onGenerateClick() {
  generateMergedAudio(writeMode.value)
}

async function generateMergedAudio(writeMode: 'overwrite' | 'new' = 'overwrite') {
  const payload: Record<string, any> = {
    episode_id: episodeId.value,
    chapters: chapters.value.map(ch => ch.path),
    gap_duration: gapDuration.value,
    normalize_volume: normalizeVolume.value,
    narration_volume: 1.0,
    write_mode: writeMode,
  }

  if (intro.enabled && intro.file) {
    payload.intro = {
      enabled: true,
      file: intro.file,
      volume: intro.volume / 100,
      gap_after: intro.gap_after,
    }
  }

  if (music.enabled && music.files.length) {
    payload.music = {
      enabled: true,
      files: music.files,
      volume: music.volume / 100,
      post_narration_volume: music.post_narration_volume / 100,
      fade_in: music.fade_in,
      fade_out: music.fade_out,
    }
  }

  if (backgroundNoise.enabled) {
    payload.background_noise = {
      enabled: true,
      mode: backgroundNoise.mode,
      preset: backgroundNoise.preset,
      custom_file: backgroundNoise.mode === 'custom' ? backgroundNoise.custom_file : undefined,
      volume: backgroundNoise.volume / 100,
      fade_in: backgroundNoise.fade_in,
      fade_out: backgroundNoise.fade_out,
    }
  }

  generating.value = true
  audioMergeGenerating.value = true

  try {
    await post<any>(`/projects/${slug.value}/generate/audio-merge`, payload)
    success('Audio merge queued!')
  } catch (e: any) {
    showError(e.data?.detail || 'Failed to start audio merge')
    audioMergeGenerating.value = false
  } finally {
    generating.value = false
  }
}

// ── Lifecycle ──
onMounted(async () => {
  checkFfmpeg()
  await mergePresets.load()
})

onUnmounted(() => {
  previewAudio.value?.pause()
  previewAudio.value = null
})
</script>

<style scoped>
.integrity-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 500;
  border: 1px solid transparent;
}
.integrity-pill.ok {
  background: rgba(34, 197, 94, 0.12);
  color: rgb(22, 163, 74);
  border-color: rgba(34, 197, 94, 0.3);
}
.integrity-pill.warn {
  background: rgba(245, 158, 11, 0.14);
  color: rgb(180, 83, 9);
  border-color: rgba(245, 158, 11, 0.35);
}

.badge { display: inline-flex; align-items: center; padding: 4px 10px; border-radius: 12px; font-size: 12px; font-weight: 500; }
.badge-success { background: rgba(74, 222, 128, 0.15); color: var(--success); border: 1px solid rgba(74, 222, 128, 0.3); }
.badge-error { background: rgba(239, 68, 68, 0.15); color: var(--error); border: 1px solid rgba(239, 68, 68, 0.3); }

.audio-list-reorder { display: flex; flex-direction: column; gap: 3px; }
.audio-item-reorder { display: flex; align-items: center; gap: 8px; padding: 8px 10px; background: var(--bg-tertiary); border-radius: var(--radius-sm); font-size: 13px; border: 1px solid var(--border); }
.audio-order-num { width: 22px; height: 22px; border-radius: 50%; background: var(--accent-dim); color: var(--accent); font-size: 11px; font-weight: 600; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.audio-reorder-btns { display: flex; flex-direction: column; gap: 0; flex-shrink: 0; }
.audio-reorder-btns .btn-icon { font-size: 10px; padding: 1px 4px; line-height: 1; }
.audio-reorder-btns .btn-icon:disabled { opacity: 0.2; cursor: default; }
.audio-name { color: var(--text-secondary); }

.btn-icon { background: none; border: none; cursor: pointer; font-size: 14px; color: var(--text-muted); padding: 4px; line-height: 1; }
.btn-icon:hover { color: var(--text-primary); }
.btn-icon.danger:hover { color: var(--error); }
.play-btn { color: var(--accent); font-size: 12px; }

.checkbox-label { display: flex; align-items: center; gap: 6px; font-size: 13px; cursor: pointer; color: var(--text-secondary); }

.music-file-list { display: flex; flex-direction: column; gap: 4px; }
.music-file-item { display: flex; align-items: center; gap: 8px; padding: 6px 10px; background: var(--bg-primary); border-radius: var(--radius-sm); border: 1px solid var(--border); font-size: 13px; }
.music-filename { color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }

.quick-add-music { padding: 8px; background: var(--bg-primary); border-radius: var(--radius-sm); border: 1px dashed var(--border); }

.noise-preset-grid { display: flex; gap: 10px; flex-wrap: wrap; }
.noise-preset-card { padding: 12px 16px; border-radius: var(--radius-md); background: var(--bg-primary); border: 2px solid var(--border); cursor: pointer; transition: all 0.15s; min-width: 140px; display: flex; flex-direction: column; gap: 4px; }
.noise-preset-card:hover { border-color: var(--text-secondary); }
.noise-preset-card.active { border-color: var(--accent); background: var(--accent-dim); }
.np-name { font-size: 13px; font-weight: 600; color: var(--text-primary); }
.np-desc { font-size: 11px; color: var(--text-muted); }

.summary-bar { padding: 10px 14px; background: var(--accent-dim); border-radius: var(--radius-sm); font-size: 13px; color: var(--accent); font-weight: 500; border: 1px solid rgba(240, 198, 116, 0.2); }

.summary-panel { padding: 16px; background: var(--bg-tertiary); border-radius: var(--radius-md); border: 1px solid var(--border); }
.summary-grid { display: flex; flex-direction: column; gap: 6px; }
.summary-row { display: flex; justify-content: space-between; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
.summary-row:last-child { border-bottom: none; }
.summary-row .text-muted { min-width: 100px; }

.no-audio-warning { display: flex; gap: 14px; align-items: flex-start; border-left: 3px solid rgba(245, 158, 11, 0.6); }
.warning-icon { font-size: 22px; line-height: 1; flex-shrink: 0; padding-top: 2px; }
.warning-body { flex: 1; min-width: 0; }
.warning-title { margin: 0; font-size: 15px; color: var(--text-primary); }

.write-mode-panel { padding: 14px; background: var(--bg-tertiary); border-radius: var(--radius-md); border: 1px solid var(--border); }
.write-mode-header { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.write-mode-options { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
@media (max-width: 640px) { .write-mode-options { grid-template-columns: 1fr; } }
.write-mode-option { display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px; border-radius: var(--radius-sm); background: var(--bg-primary); border: 2px solid var(--border); cursor: pointer; transition: all 0.15s; }
.write-mode-option:hover { border-color: var(--text-secondary); }
.write-mode-option.active { border-color: var(--accent); background: var(--accent-dim); }
.write-mode-option input[type="radio"] { margin-top: 3px; flex-shrink: 0; }
.write-mode-content { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.write-mode-title { font-size: 13px; font-weight: 600; color: var(--text-primary); }
.write-mode-desc { font-size: 11px; color: var(--text-muted); line-height: 1.4; word-break: break-word; }

.btn-lg { padding: 12px 40px; font-size: 16px; font-weight: 600; }

.generating-status { display: flex; flex-direction: column; gap: 6px; }
.gen-label { font-size: 13px; color: var(--accent); }
.progress-bar { height: 3px; background: var(--bg-tertiary); border-radius: 2px; overflow: hidden; }
.progress-fill { height: 100%; background: var(--accent); border-radius: 2px; animation: progressIndeterminate 1.5s ease-in-out infinite; }
@keyframes progressIndeterminate { 0% { width: 0%; margin-left: 0; } 50% { width: 60%; margin-left: 20%; } 100% { width: 0%; margin-left: 100%; } }

.scanning-status { display: flex; flex-direction: column; gap: 4px; }
.slider { width: 100%; }
</style>
