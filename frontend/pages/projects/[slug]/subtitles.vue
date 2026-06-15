<!--
  Subtitles workshop (v1.0.216+, local-transcribe v1.0.217+).

  Dedicated home for CREATING an episode's subtitles, between Audio Assembly
  and Scene Plan (needs the chapter audio). Two transcription engines — the
  user PICKS (no silent default):
    - Voice Studio (local)  → the modal's free Whisper STT (/api/transcribe).
    - OpenAI Whisper (paid)  → always-available fallback.
  Plus non-transcribe methods (from-chapters, import). All write per-chapter
  SRTs ({code}_{slug}.srt) into the episode's "09 Subtitles Output" folder,
  which Scene Plan stitches and Video Assembly burns in.
-->
<template>
  <div>
    <div class="page-header">
      <Breadcrumb />
      <h1 class="page-title">Subtitles</h1>
    </div>

    <TopActionBar
      :project-slug="slug"
      :presets="subtitlesPresets"
      v-model:episode-id="episodeId"
      filter-field="subtitles"
      :generate-label="transcribeLabel"
      loading-label="Queuing…"
      :generate-loading="transcribing || transcribeJobActive"
      :generate-disabled="!canTranscribe"
      :generate-status="transcribeJobActive ? `Transcribing ${episodeId}…` : (canTranscribe ? '' : transcribeDisabledReason)"
      @generate="transcribe"
      @preset-applied="success('Preset applied')"
      @preset-saved="success('Preset saved')"
      @preset-deleted="success('Preset deleted')"
    />

    <p class="text-muted mt-1 mb-2">
      Create the subtitle track for an episode. Subtitles are built from the
      <strong>chapter audio</strong>, so generate audio (and Audio Assembly) first.
      The per-chapter SRTs produced here are what <strong>Scene Plan</strong> stitches
      and <strong>Video Assembly</strong> burns in.
    </p>

    <div v-if="!episodeId" class="card mt-3">
      <p class="text-muted">Select an episode above to manage its subtitles.</p>
    </div>

    <template v-else>
      <!-- Status -->
      <section class="card mt-3">
        <h3>Status</h3>
        <div v-if="loading" class="text-muted text-sm mt-1">
          <LoadingSpinner size="sm" /> Checking subtitle status…
        </div>
        <template v-else>
          <p v-if="!status?.has_chapter_audio" class="validation-msg text-sm mt-2">
            ⚠ No chapter audio found for {{ episodeId }}. Generate audio in the
            <NuxtLink :to="`/projects/${slug}/audio`" class="inline-link">Audio Generator</NuxtLink>
            first — subtitles are built from it.
          </p>
          <div v-else class="mt-2 text-sm">
            <div class="sub-coverage">
              <span class="sub-coverage-bar" aria-hidden="true">
                <span class="sub-coverage-fill" :style="{ width: coveragePct + '%' }" />
              </span>
              <span class="text-muted">
                <strong>{{ coverage.done }}/{{ coverage.total }}</strong> chapter(s) transcribed
                <template v-if="coverage.total && coverage.done === coverage.total"> — ready for Scene Plan ✓</template>
              </span>
            </div>
            <ul v-if="sections.length" class="sub-chapter-list mt-2">
              <li v-for="s in sections" :key="s.slug" class="sub-chapter-row">
                <span class="sub-chapter-mark" :class="{ ok: chapterHasSrt(s.slug) }" aria-hidden="true">
                  {{ chapterHasSrt(s.slug) ? '✓' : '○' }}
                </span>
                <span class="sub-chapter-name">{{ s.label }}</span>
                <span class="text-muted text-xs">{{ chapterHasSrt(s.slug) ? 'transcribed' : 'no SRT yet' }}</span>
              </li>
            </ul>
          </div>
        </template>
      </section>

      <!-- Transcribe -->
      <section class="card mt-3">
        <h3>Transcribe</h3>
        <p class="text-muted text-sm mt-1">
          Transcribes each chapter's narration into per-chapter SRTs. Pick an engine:
        </p>

        <!-- Engine chooser — no default; the user picks. -->
        <div class="sub-engine-grid mt-2">
          <button
            type="button"
            class="sub-engine-card"
            :class="{ active: engine === 'voicestudio' }"
            @click="engine = 'voicestudio'"
          >
            <div class="sub-engine-head">
              <strong>Voice Studio (local)</strong>
              <span class="sub-engine-tag free">free</span>
            </div>
            <p class="sub-engine-desc">Runs Whisper on your own Mac via the Voice Studio modal. No API cost, private, no rate limits. Near-perfect on your clean TTS narration.</p>
          </button>
          <button
            type="button"
            class="sub-engine-card"
            :class="{ active: engine === 'openai' }"
            @click="engine = 'openai'"
          >
            <div class="sub-engine-head">
              <strong>OpenAI Whisper</strong>
              <span class="sub-engine-tag paid">paid</span>
            </div>
            <p class="sub-engine-desc">OpenAI's hosted Whisper API (~$0.006/min). The always-available fallback when the local modal is off.</p>
          </button>
        </div>

        <!-- Voice Studio engine details -->
        <div v-if="engine === 'voicestudio'" class="sub-engine-detail mt-2">
          <div v-if="vsAvailLoading" class="text-muted text-sm">
            <LoadingSpinner size="sm" /> Checking Voice Studio…
          </div>
          <template v-else-if="!vsAvail?.available">
            <p class="validation-msg text-sm">
              ⚠ Voice Studio transcription isn't reachable.
              <span v-if="!vsAvail?.configured">Set the URL in
                <NuxtLink :to="`/projects/${slug}/settings#local-tts`" class="inline-link">Settings → This Mac → Local Models</NuxtLink>.</span>
              <span v-else>Start the modal (Pinokio → Start) and update it to v1.4.0+, then</span>
              <a href="#" class="inline-link" @click.prevent="loadVsAvailability">re-check</a>.
            </p>
          </template>
          <template v-else>
            <div class="form-group">
              <label>Whisper model <span class="text-muted text-xs">· on {{ vsAvail.device || 'mps' }}</span></label>
              <select v-model="vsModel" class="select select-sm">
                <option v-for="m in (vsAvail.models || [])" :key="m.repo" :value="m.repo">
                  {{ m.label || m.repo }}{{ m.size_gb ? ` · ${m.size_gb} GB` : '' }}{{ m.recommended ? ' · recommended' : '' }}{{ m.cached ? '' : ' · not downloaded' }}
                </option>
              </select>
            </div>
            <div v-if="selectedVsModel && !selectedVsModel.cached" class="sub-download mt-1">
              <p class="validation-msg text-sm" style="margin:0;">
                "{{ selectedVsModel.label || selectedVsModel.repo }}" isn't downloaded on the modal yet
                ({{ selectedVsModel.size_gb || '?' }} GB).
              </p>
              <button class="btn btn-sm btn-secondary mt-1" :disabled="downloadingModel" @click="downloadModel">
                {{ downloadingModel ? 'Downloading… (re-checking)' : 'Download model' }}
              </button>
            </div>
          </template>
        </div>

        <!-- OpenAI engine details -->
        <div v-else-if="engine === 'openai'" class="sub-engine-detail mt-2">
          <p v-if="status && !status.has_openai_key" class="validation-msg text-sm">
            OpenAI API key not set — add one under
            <NuxtLink :to="`/projects/${slug}/settings#api-keys`" class="inline-link">Settings → API Keys</NuxtLink>,
            or use the Voice Studio engine.
          </p>
          <p v-else class="text-muted text-sm">Uses your OpenAI key. ~$0.006 per minute of audio.</p>
        </div>

        <p v-else class="text-muted text-sm mt-2">Choose an engine above to enable transcription.</p>

        <label v-if="engine" class="flex items-center gap-1 mt-2 text-sm">
          <input type="checkbox" v-model="force" />
          Re-run for chapters that already have an SRT{{ engine === 'openai' ? ' (charges Whisper again)' : '' }}
        </label>

        <div class="mt-2">
          <button class="btn btn-sm btn-primary" :disabled="!canTranscribe" @click="transcribe">
            {{ transcribeJobActive ? 'Queued — check the Jobs panel' : (coverage.done && !force ? 'Transcribe missing chapters' : 'Transcribe chapters') }}
          </button>
          <span v-if="transcribeJobActive" class="text-muted text-xs ml-1">Running… progress shows in Jobs / the bell.</span>
        </div>
      </section>

      <!-- Other methods -->
      <section class="card mt-3">
        <h3>Other methods</h3>
        <div class="sub-method">
          <div>
            <strong class="text-sm">From chapters</strong>
            <p class="text-muted text-xs mt-1">
              One cue per chapter from durations + the audio-merge gap. Fast and free, chapter-level only (no word timing).
            </p>
          </div>
          <button class="btn btn-sm btn-secondary" :disabled="fromChaptersBusy || !status?.has_chapter_audio" @click="fromChapters">
            {{ fromChaptersBusy ? 'Generating…' : 'Generate from chapters' }}
          </button>
        </div>
        <div class="sub-method mt-2">
          <div class="sub-method-import">
            <strong class="text-sm">Import .srt / .vtt</strong>
            <p class="text-muted text-xs mt-1">Bring your own subtitle file — we copy + normalize it into this episode.</p>
            <div class="flex gap-2 mt-1 items-center">
              <FilePicker
                v-model="importPath"
                placeholder="/path/to/subtitles.srt"
                :filters="[{ name: 'Subtitles', extensions: ['srt', 'vtt'] }]"
                title="Choose a subtitle file"
                :output-root="project?.output_root || ''"
                clearable
              />
              <button class="btn btn-sm btn-primary" :disabled="importing || !importPath" @click="importSrt">
                {{ importing ? 'Importing…' : 'Import' }}
              </button>
            </div>
          </div>
        </div>
      </section>

      <!-- Existing files -->
      <section class="card mt-3">
        <h3>Subtitle files <span v-if="status?.existing_srts?.length" class="text-muted text-sm">({{ status.existing_srts.length }})</span></h3>
        <p v-if="!status?.existing_srts?.length" class="text-muted text-sm mt-1">No subtitle files yet for this episode. Generate some above.</p>
        <ul v-else class="sub-file-list mt-2">
          <li v-for="srt in status.existing_srts" :key="srt.path" class="sub-file-row">
            <span class="sub-file-name">{{ srt.filename }}</span>
            <span v-if="srt.drifts_from_current_merge" class="sub-file-warn" :title="srt.drift_note">⚠ gap drift</span>
            <button class="btn-icon" title="Delete this subtitle file" @click="deleteSrt(srt.filename)">✕</button>
          </li>
        </ul>
        <p class="text-muted text-xs mt-2">Folder: <code class="sub-dir">{{ status?.subtitles_dir }}</code></p>
      </section>

      <!-- Stitch into the timeline (v1.0.218 — moved here from Scene Plan so
           subtitles + their stitch live in one workspace). -->
      <section class="card mt-3">
        <h3>Stitch into the timeline</h3>
        <p class="text-muted text-sm mt-1">
          Combine the per-chapter SRTs above into one global-timeline SRT —
          each chapter is offset by its audio duration + the merge gap. This
          stitched SRT is what <strong>Scene Plan</strong> reads and
          <strong>Video Assembly</strong> burns in.
        </p>

        <p v-if="!status?.has_merged_audio" class="validation-msg text-sm mt-2">
          ⚠ Run <NuxtLink :to="`/projects/${slug}/audio-merge`" class="inline-link">Audio Assembly</NuxtLink>
          first — stitching needs the per-section durations + gap.
        </p>
        <p v-else-if="coverage.total && coverage.done < coverage.total" class="validation-msg text-sm mt-2">
          ⚠ Only {{ coverage.done }}/{{ coverage.total }} chapters transcribed. Stitch will skip the
          missing ones — transcribe them all above for complete subtitles.
        </p>

        <div v-if="stitchStatus?.stitched_srt" class="mt-2 text-sm">
          Stitched SRT exists:
          <strong>{{ stitchStatus.stitched_srt.meta?.total_cues ?? '?' }} cues</strong>
          across <strong>{{ stitchStatus.stitched_srt.meta?.sections?.length ?? '?' }} section(s)</strong>,
          <strong>{{ stitchStatus.stitched_srt.meta?.total_duration_sec?.toFixed(1) ?? '?' }}s</strong> total.
          <span v-if="stitchStatus.stitched_srt.drifts_from_current_merge" class="sub-file-warn"> ⚠ gap drift — re-stitch</span>
        </div>
        <p v-else class="text-muted text-sm mt-2">Not stitched yet.</p>

        <div class="mt-2">
          <button class="btn btn-sm btn-primary" :disabled="stitching || !status?.has_merged_audio" @click="stitchSubtitles">
            {{ stitching ? 'Stitching…' : (stitchStatus?.stitched_srt ? 'Re-stitch' : 'Stitch subtitles') }}
          </button>
        </div>

        <div v-if="stitchError" class="validation-msg text-sm mt-2" style="white-space: pre-wrap;">
          ✗ {{ stitchError }}
        </div>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ layout: 'dashboard' })
useAppTitle('Subtitles')

interface ExistingSrt { path: string; filename: string; mtime: number; drifts_from_current_merge?: boolean; drift_note?: string }
interface SubtitleStatus {
  has_libass: boolean
  has_merged_audio: boolean
  has_chapter_audio: boolean
  has_openai_key: boolean
  existing_srts: ExistingSrt[]
  subtitles_dir: string
  current_merge_gap_s: number | null
}
interface SectionRow { label: string; slug: string }
interface VsModel { repo: string; label?: string; size_gb?: number; recommended?: boolean; cached?: boolean; note?: string }
interface VsAvailability { available: boolean; configured?: boolean; device?: string; default_model?: string; models?: VsModel[]; error?: string }

const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { get, post, del } = useApi()
const { success, error: showError, info: showInfo } = useToast()
const { jobs } = useJobs()
const { project } = useProject()

const episodeId = ref('')
const status = ref<SubtitleStatus | null>(null)
const sections = ref<SectionRow[]>([])
const loading = ref(false)

// Engine choice — NO default; the user picks. Persisted per project.
const engine = ref<'' | 'voicestudio' | 'openai'>('')
const force = ref(false)
const transcribing = ref(false)

// Voice Studio transcribe availability + model selection.
const vsAvail = ref<VsAvailability | null>(null)
const vsAvailLoading = ref(false)
const vsModel = ref<string>('')
const downloadingModel = ref(false)

// Non-transcribe methods.
const fromChaptersBusy = ref(false)
const importPath = ref('')
const importing = ref(false)

const codeUpper = computed(() => episodeId.value.toUpperCase())
const srtNames = computed(() => new Set((status.value?.existing_srts || []).map(s => s.filename.toLowerCase())))
function chapterHasSrt(secSlug: string): boolean {
  return srtNames.value.has(`${codeUpper.value}_${secSlug}.srt`.toLowerCase())
}
const coverage = computed(() => {
  const total = sections.value.length
  const done = sections.value.filter(s => chapterHasSrt(s.slug)).length
  return { total, done }
})
const coveragePct = computed(() => coverage.value.total ? Math.round((coverage.value.done / coverage.value.total) * 100) : 0)

const selectedVsModel = computed<VsModel | undefined>(() =>
  (vsAvail.value?.models || []).find(m => m.repo === vsModel.value),
)

const transcribeJobActive = computed(() =>
  (jobs.value as any[]).some(j =>
    j.type === 'subtitles_transcribe' && j.episode_id === episodeId.value &&
    j.project_slug === slug.value && (j.status === 'queued' || j.status === 'running'),
  ),
)

const transcribeLabel = computed(() =>
  engine.value === 'voicestudio' ? 'Transcribe (local)' :
  engine.value === 'openai' ? 'Transcribe (OpenAI)' : 'Transcribe',
)

const canTranscribe = computed(() => {
  if (!episodeId.value || !status.value?.has_chapter_audio) return false
  if (transcribing.value || transcribeJobActive.value) return false
  if (engine.value === 'openai') return !!status.value?.has_openai_key
  if (engine.value === 'voicestudio') return !!vsAvail.value?.available && !!selectedVsModel.value?.cached
  return false
})
const transcribeDisabledReason = computed(() => {
  if (!episodeId.value) return 'Pick an episode first'
  if (!status.value?.has_chapter_audio) return 'No chapter audio — generate audio first'
  if (!engine.value) return 'Choose a transcription engine'
  if (engine.value === 'openai' && !status.value?.has_openai_key) return 'Add an OpenAI API key in Settings'
  if (engine.value === 'voicestudio' && !vsAvail.value?.available) return 'Voice Studio not reachable'
  if (engine.value === 'voicestudio' && !selectedVsModel.value?.cached) return 'Download the Whisper model first'
  return ''
})

// v1.0.360 — race token so out-of-order responses from rapid episode switches
// can't clobber the current episode's status or leave `loading` stuck true
// (the "switch episode → still shows Checking subtitle status…" bug).
let loadToken = 0
async function loadStatus(): Promise<void> {
  const myToken = ++loadToken
  if (!episodeId.value) { status.value = null; sections.value = []; loading.value = false; return }
  loading.value = true
  try {
    const [st, secs] = await Promise.all([
      get<SubtitleStatus>(`/projects/${slug.value}/video-editor/subtitles/status/${episodeId.value}`),
      get<{ sections: any[] }>(`/projects/${slug.value}/episodes/${episodeId.value}/audio-sections`).catch(() => ({ sections: [] })),
    ])
    if (myToken !== loadToken) return   // a newer load (episode switch) superseded this one
    status.value = st
    sections.value = (secs.sections || []).map((s: any) => ({ label: s.label, slug: s.slug }))
    void loadStitchStatus()
  } catch (e: any) {
    if (myToken === loadToken && !e?.__slugRace) showError(e?.data?.detail || e?.message || 'Could not load subtitle status')
  } finally {
    if (myToken === loadToken) loading.value = false
  }
}
// v1.0.360 — on episode switch, clear the transient queue flag so a slow/
// in-flight transcribe POST on the PREVIOUS episode doesn't leave the new
// episode's Transcribe button stuck on "Queuing…" / disabled.
watch(episodeId, () => {
  transcribing.value = false
  void loadStatus()
})

// ── Stitch into the global timeline (v1.0.218 — moved here from Scene Plan
// so subtitle creation + stitching live in one workspace). Reads/writes the
// same stitched SRT the Scene Plan page consumes. ─────────────────────────
interface StitchedMeta { total_cues?: number; total_duration_sec?: number; gap_duration_s?: number; sections?: any[] }
interface StitchStatus {
  stitched_srt: { meta: StitchedMeta | null; drifts_from_current_merge: boolean } | null
  audio_merged: boolean
  audio_merge_gap_s: number | null
}
const stitchStatus = ref<StitchStatus | null>(null)
const stitching = ref(false)
const stitchError = ref('')

async function loadStitchStatus(): Promise<void> {
  if (!episodeId.value) { stitchStatus.value = null; return }
  try {
    stitchStatus.value = await get<StitchStatus>(`/projects/${slug.value}/scene-plan/${episodeId.value}`)
  } catch { stitchStatus.value = null }
}

async function stitchSubtitles(): Promise<void> {
  if (!episodeId.value) return
  stitching.value = true
  stitchError.value = ''
  try {
    const r = await post<{ total_cues: number; total_duration_sec: number; sections: any[] }>(
      `/projects/${slug.value}/scene-plan/${episodeId.value}/stitch-subtitles`, {},
    )
    success(`Stitched ${r.total_cues} cue(s) across ${r.sections?.length ?? '?'} section(s) — ready for Scene Plan.`)
    await loadStitchStatus()
  } catch (e: any) {
    // The stitcher now fails loudly with a diagnostic message (e.g. which
    // section slugs had no matching SRT) instead of writing a blank file.
    stitchError.value = e?.data?.detail || e?.message || 'Subtitle stitching failed'
    showError('Stitch failed — see the details under "Stitch into the timeline".')
  } finally {
    stitching.value = false
  }
}

async function loadVsAvailability(): Promise<void> {
  vsAvailLoading.value = true
  try {
    const a = await get<VsAvailability>('/voicestudio/transcribe-availability')
    vsAvail.value = a
    // Resolve the selected model. Prefer a model that's actually DOWNLOADED so
    // the user can transcribe immediately with what they have; only fall back
    // to the (possibly un-cached) default — which makes the UI prompt a
    // download — when nothing is cached. Keeps the user's persisted choice if
    // it's still a known model.
    const models = a.models || []
    const cached = new Set(models.filter(m => m.cached).map(m => m.repo))
    const pick =
      (vsModel.value && models.some(m => m.repo === vsModel.value)) ? vsModel.value :
      (a.default_model && cached.has(a.default_model)) ? a.default_model! :
      (models.find(m => m.recommended && m.cached)?.repo) ||
      (models.find(m => m.cached)?.repo) ||
      (a.default_model && models.some(m => m.repo === a.default_model) ? a.default_model! : '') ||
      (models.find(m => m.recommended)?.repo) ||
      (models[0]?.repo) || ''
    if (pick) vsModel.value = pick
  } catch {
    vsAvail.value = { available: false }
  } finally {
    vsAvailLoading.value = false
  }
}

async function downloadModel(): Promise<void> {
  if (downloadingModel.value || !vsModel.value) return
  downloadingModel.value = true
  try {
    await post('/voicestudio/download-model', { repo: vsModel.value })
    showInfo('Model download started on Voice Studio — this can take a few minutes. Re-checking…')
    // Poll availability until the model reports cached (cap ~10 min).
    const deadline = Date.now() + 10 * 60_000
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 4000))
      await loadVsAvailability()
      if (selectedVsModel.value?.cached) { success('Model downloaded — ready to transcribe.'); break }
    }
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Could not start model download')
  } finally {
    downloadingModel.value = false
  }
}

async function transcribe(): Promise<void> {
  if (!canTranscribe.value) return
  transcribing.value = true
  try {
    await post(`/projects/${slug.value}/video-editor/subtitles/transcribe/${episodeId.value}`, {
      per_chapter: true,
      engine: engine.value,
      model: engine.value === 'voicestudio' ? vsModel.value : undefined,
      language: 'en',
      force: force.value,
    })
    showInfo('Per-chapter transcription queued — progress shows in Jobs / the bell.')
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Could not start transcription')
  } finally {
    transcribing.value = false
  }
}

// v1.0.360 — reload + toast ONLY when a transcribe job actually reaches 'done'
// for the current episode. The old `watch(transcribeJobActive)` fired on its
// true→false transition, which ALSO happens when you switch away from an
// episode whose job is still running — producing a false "Transcription
// finished" toast and an unnecessary reload. Tracking job ids keyed off a
// shallow signal (not a deep watch) avoids that and the UI-thread churn.
const seenDoneTranscribes = new Set<string>()
const transcribeJobSignal = computed(() =>
  (jobs.value as any[])
    .filter(j => j.type === 'subtitles_transcribe' && j.project_slug === slug.value)
    .map(j => `${j.job_id}:${j.status}`)
    .join('|'),
)
watch(transcribeJobSignal, () => {
  for (const j of jobs.value as any[]) {
    if (j.type === 'subtitles_transcribe' && j.status === 'done'
        && j.project_slug === slug.value && !seenDoneTranscribes.has(j.job_id)) {
      seenDoneTranscribes.add(j.job_id)
      if (j.episode_id === episodeId.value) {
        void loadStatus()
        success('Transcription finished — subtitle status updated.')
      }
    }
  }
})

async function fromChapters(): Promise<void> {
  if (fromChaptersBusy.value || !episodeId.value) return
  fromChaptersBusy.value = true
  try {
    const r = await post<{ cues: number }>(`/projects/${slug.value}/video-editor/subtitles/from-chapters/${episodeId.value}`, {})
    success(`Built chapter-marker SRT (${r.cues} cue${r.cues === 1 ? '' : 's'}).`)
    await loadStatus()
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Could not derive subtitles from chapters')
  } finally {
    fromChaptersBusy.value = false
  }
}

async function importSrt(): Promise<void> {
  if (importing.value || !importPath.value || !episodeId.value) return
  importing.value = true
  try {
    const r = await post<{ cues: number }>(`/projects/${slug.value}/video-editor/subtitles/import/${episodeId.value}`, { source_path: importPath.value })
    success(`Imported subtitle (${r.cues} cue${r.cues === 1 ? '' : 's'}).`)
    importPath.value = ''
    await loadStatus()
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Import failed')
  } finally {
    importing.value = false
  }
}

async function deleteSrt(filename: string): Promise<void> {
  try {
    const r = await del<{ existing_srts: ExistingSrt[] }>(`/projects/${slug.value}/video-editor/subtitles/${episodeId.value}/${encodeURIComponent(filename)}`)
    if (status.value) status.value.existing_srts = r.existing_srts || []
    success(`Deleted ${filename}`)
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Delete failed')
  }
}

// ── Presets ─────────────────────────────────────────────────────────────────
// Engine + model + re-run flag are saved as named presets via the top bar,
// same pattern as the other generator tabs — so the user's pick persists and
// is shareable, instead of a hidden per-machine localStorage value. Distinct
// configKey from Video Assembly's 'subtitles' (subtitle-STYLE) presets.
const subtitlesPresets = usePresets<{ engine?: string; vsModel?: string; force?: boolean }>({
  slug: slug.value,
  configKey: 'subtitles_generator',
  snapshot: () => ({ engine: engine.value, vsModel: vsModel.value, force: force.value }),
  apply: (d) => {
    if (d?.engine === 'voicestudio' || d?.engine === 'openai') engine.value = d.engine
    if (typeof d?.vsModel === 'string' && d.vsModel) vsModel.value = d.vsModel
    if (typeof d?.force === 'boolean') force.value = d.force
  },
})

// Fetch local availability when the user switches to the Voice Studio engine.
watch(engine, (v) => { if (v === 'voicestudio' && !vsAvail.value) void loadVsAvailability() })

onMounted(async () => {
  // Auto-applies the active preset (sets engine / model / re-run) if saved.
  await subtitlesPresets.load()
  // Prefetch local availability so the engine card is ready; keeps a
  // preset-applied model when it's known to the modal, else picks a cached one.
  if (!vsAvail.value) await loadVsAvailability()
})
</script>

<style scoped>
.inline-link { color: var(--accent); text-decoration: underline; }
.inline-link:hover { text-decoration: none; }

.sub-coverage { display: flex; align-items: center; gap: 10px; }
.sub-coverage-bar { flex: 0 0 140px; height: 8px; border-radius: 999px; background: var(--bg-tertiary); overflow: hidden; }
.sub-coverage-fill { display: block; height: 100%; background: rgb(74, 222, 128); transition: width 0.2s; }

.sub-chapter-list, .sub-file-list { list-style: none; margin: 0; padding: 0; }
.sub-chapter-row, .sub-file-row { display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-bottom: 1px solid var(--border); font-size: 13px; }
.sub-chapter-row:last-child, .sub-file-row:last-child { border-bottom: none; }
.sub-chapter-mark { width: 16px; text-align: center; color: var(--text-muted); }
.sub-chapter-mark.ok { color: rgb(34, 197, 94); }
.sub-chapter-name { flex: 1; color: var(--text-primary); }

/* Engine chooser */
.sub-engine-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
@media (max-width: 720px) { .sub-engine-grid { grid-template-columns: 1fr; } }
.sub-engine-card {
  text-align: left;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 10px 12px;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.sub-engine-card:hover { border-color: var(--text-secondary); }
.sub-engine-card.active { border-color: var(--accent); background: var(--accent-dim); }
.sub-engine-head { display: flex; align-items: center; gap: 8px; }
.sub-engine-tag { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; padding: 1px 6px; border-radius: 999px; }
.sub-engine-tag.free { background: rgba(74, 222, 128, 0.15); color: rgb(22, 163, 74); }
.sub-engine-tag.paid { background: rgba(245, 158, 11, 0.16); color: rgb(180, 83, 9); }
.sub-engine-desc { margin: 4px 0 0; font-size: 11.5px; line-height: 1.45; color: var(--text-muted); }

.sub-engine-detail { border-left: 2px solid var(--border); padding-left: 10px; }
.sub-download { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; }

.sub-method { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; padding: 10px 0; border-top: 1px solid var(--border); }
.sub-method:first-of-type { border-top: none; }
.sub-method-import { flex: 1; }

.sub-file-name { flex: 1; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.sub-file-warn { font-size: 11px; color: rgb(180, 83, 9); }
.sub-dir { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; word-break: break-all; }
</style>
