<!--
  Subtitles workshop.

  Dedicated home for CREATING an episode's subtitles, between Audio Assembly
  and Scene Plan (needs the chapter audio). GenStudio KH is the sole AI
  transcription boundary and publishes the selectable model catalog.
  Plus non-transcribe methods (from-chapters, import). All write per-chapter
  SRTs ({code}_{slug}.srt) into the episode's "09 Subtitles Output" folder,
  which Scene Plan stitches and Video Assembly burns in.
-->
<template>
  <div class="workspace-page">
    <WorkspaceHero
      eyebrow="Assembly · Transcript"
      title="Subtitles"
      description="Build narration-aligned subtitle tracks from chapter audio, then hand the verified timeline to Scene Plan and Video Assembly."
    >
      <template #aside>
        <div class="workspace-metrics" aria-label="Subtitle readiness">
          <span class="workspace-metric" :data-tone="coverage.total && coverage.done === coverage.total ? 'success' : 'warning'">
            <strong>{{ coverage.done }}/{{ coverage.total }}</strong> chapters
          </span>
          <span class="workspace-metric" :data-tone="episodeId ? 'info' : 'warning'">
            <strong>{{ episodeId || 'No episode' }}</strong> target
          </span>
        </div>
      </template>
    </WorkspaceHero>

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

    <WorkspaceNotice v-if="!episodeId" tone="info" title="Choose an episode">
      Select an episode above to inspect subtitle coverage and manage its transcription.
    </WorkspaceNotice>

    <template v-else>
      <!-- Status -->
      <WorkspaceSection
        eyebrow="Readiness"
        title="Subtitle coverage"
        description="Every narration section must have a usable subtitle file before the timeline is complete."
      >
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
      </WorkspaceSection>

      <!-- Transcribe -->
      <WorkspaceSection
        eyebrow="Create"
        title="Transcribe chapter audio"
        description="GenStudio KH securely routes every transcription. Completed chapter files are preserved, so retries fill only missing sections."
      >
        <div class="sub-engine-card active mt-2">
          <div class="sub-engine-head">
            <strong>GenStudio KH</strong>
            <span class="sub-engine-tag free">single route</span>
          </div>
          <p class="sub-engine-desc">Story Studio uploads privately to GenStudio. GenStudio handles Studio Hub, worker selection, durable recovery, and the final SRT.</p>
        </div>

        <div class="sub-engine-detail mt-2">
          <div v-if="genstudioModelsLoading" class="text-muted text-sm">
            <LoadingSpinner size="sm" /> Loading GenStudio models…
          </div>
          <p v-else-if="genstudioModelsError" class="validation-msg text-sm">
            ⚠ {{ genstudioModelsError }}
            <NuxtLink :to="`/projects/${slug}/settings#genstudio-settings`" class="inline-link">Open GenStudio settings</NuxtLink>
            or <a href="#" class="inline-link" @click.prevent="loadGenstudioModels">retry</a>.
          </p>
          <div v-else class="form-group">
            <label>Transcription model <span class="text-muted text-xs">· published by GenStudio KH</span></label>
            <ModelMenu
              v-model="genstudioModel"
              :options="genstudioModelOptions"
              media-type="transcription"
              title="Choose a GenStudio transcription model"
              placeholder="Pick a transcription model…"
              search-placeholder="Search GenStudio models…"
              aria-label="GenStudio transcription model options"
            />
          </div>
        </div>

        <label class="flex items-center gap-1 mt-2 text-sm">
          <input type="checkbox" v-model="force" />
          Re-run chapters that already have a verified SRT
        </label>

        <div class="mt-2">
          <button class="btn btn-sm btn-primary" :disabled="!canTranscribe" @click="transcribe">
            {{ transcribeJobActive ? 'Queued — check the Jobs panel' : (coverage.done && !force ? 'Transcribe missing chapters' : 'Transcribe chapters') }}
          </button>
          <span v-if="transcribeJobActive" class="text-muted text-xs ml-1">Running… progress shows in Jobs / the bell.</span>
        </div>
      </WorkspaceSection>

      <!-- Other methods -->
      <WorkspaceSection
        eyebrow="Alternatives"
        title="Other methods"
        description="Create simple chapter-level timing or bring an existing subtitle track into this episode."
      >
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
      </WorkspaceSection>

      <!-- Existing files -->
      <section class="card mt-3">
        <h3>Subtitle files <span v-if="status?.existing_srts?.length" class="text-muted text-sm">({{ status.existing_srts.length }})</span></h3>
        <p v-if="!status?.existing_srts?.length" class="text-muted text-sm mt-1">No subtitle files yet for this episode. Generate some above.</p>
        <ul v-else class="sub-file-list mt-2">
          <li v-for="srt in status.existing_srts" :key="srt.path" class="sub-file-row">
            <span class="sub-file-name">{{ srt.filename }}</span>
            <span v-if="srt.drifts_from_current_merge" class="sub-file-warn" :title="srt.drift_note">⚠ gap drift</span>
            <button
              class="btn-icon"
              :class="{ active: previewFilename === srt.filename }"
              :title="previewFilename === srt.filename ? 'Hide preview' : 'Preview subtitle text'"
              @click="viewSrt(srt.filename)"
            >👁</button>
            <button class="btn-icon" title="Delete this subtitle file" @click="deleteSrt(srt.filename)">✕</button>
          </li>
        </ul>

        <!-- v1.0.494/495 — inline preview of the generated cues so accuracy can
             be verified without opening Finder. Per-chapter files preview here;
             the stitched timeline SRT previews in its own section below. -->
        <SubtitleCuePreview
          v-if="previewFilename && !isStitchedPreview"
          class="mt-3"
          :filename="previewFilename"
          :loading="previewLoading"
          :meta="previewMeta"
          :cues="previewCues"
          :raw="previewRaw"
          @close="closePreview"
        />

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

        <div class="mt-2 flex gap-2 items-center">
          <button class="btn btn-sm btn-primary" :disabled="stitching || !status?.has_merged_audio" @click="stitchSubtitles">
            {{ stitching ? 'Stitching…' : (stitchStatus?.stitched_srt ? 'Re-stitch' : 'Stitch subtitles') }}
          </button>
          <button
            v-if="stitchedSrtFile"
            class="btn btn-sm btn-secondary"
            @click="viewSrt(stitchedSrtFile)"
          >
            {{ previewFilename === stitchedSrtFile ? 'Hide preview' : '👁 Preview stitched' }}
          </button>
        </div>

        <!-- Preview of the stitched timeline SRT — the exact file Scene Plan
             reads and Video Assembly burns in. -->
        <SubtitleCuePreview
          v-if="previewFilename && isStitchedPreview"
          class="mt-3"
          :filename="previewFilename"
          :loading="previewLoading"
          :meta="previewMeta"
          :cues="previewCues"
          :raw="previewRaw"
          @close="closePreview"
        />

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
  existing_srts: ExistingSrt[]
  completion?: {
    complete: boolean
    mode: 'per-section' | 'full-track' | 'none'
    expected_sections: string[]
    completed_sections: string[]
    missing_sections: string[]
    full_track_filename?: string
  }
  subtitles_dir: string
  current_merge_gap_s: number | null
}
interface SectionRow { label: string; slug: string }

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

const force = ref(false)
const transcribing = ref(false)
const {
  modelId: genstudioModel,
  options: genstudioModelOptions,
  loading: genstudioModelsLoading,
  error: genstudioModelsError,
  ready: genstudioModelReady,
  load: loadGenstudioModels,
} = useGenStudioTranscriptionModels()

// Non-transcribe methods.
const fromChaptersBusy = ref(false)
const importPath = ref('')
const importing = ref(false)

// ── Subtitle preview (v1.0.494) — read a file's cues so accuracy can be
// verified in-app. Inline panel toggled per file. ─────────────────────────
interface SrtCuePreview { index: number; start_sec: number; end_sec: number; text: string }
interface SubtitleContent {
  filename: string; is_ass: boolean; cue_count: number; truncated: boolean;
  total_duration_sec: number; cues: SrtCuePreview[]; raw?: string
}
const previewFilename = ref('')
const previewCues = ref<SrtCuePreview[]>([])
const previewRaw = ref('')
const previewMeta = ref<SubtitleContent | null>(null)
const previewLoading = ref(false)

// The stitched timeline SRT (<code>_stitched.srt) as listed by the status
// endpoint — used for the dedicated preview in the Stitch section. Matched by
// suffix so episode-code casing doesn't matter.
const stitchedSrtFile = computed(() =>
  (status.value?.existing_srts || []).find(s => /_stitched\.srt$/i.test(s.filename))?.filename || '',
)
// Whether the open preview is the stitched file — decides which section renders
// the panel so it appears next to the button that opened it.
const isStitchedPreview = computed(() => /_stitched\.srt$/i.test(previewFilename.value))

function closePreview(): void {
  previewFilename.value = ''
  previewCues.value = []
  previewRaw.value = ''
  previewMeta.value = null
  previewLoading.value = false
}

async function viewSrt(filename: string): Promise<void> {
  // Clicking the open file's eye toggles the panel closed.
  if (previewFilename.value === filename) { closePreview(); return }
  previewFilename.value = filename
  previewLoading.value = true
  previewCues.value = []
  previewRaw.value = ''
  previewMeta.value = null
  try {
    const r = await get<SubtitleContent>(
      `/projects/${slug.value}/video-editor/subtitles/content/${episodeId.value}/${encodeURIComponent(filename)}`,
    )
    // Guard against a fast toggle/episode-switch superseding this fetch.
    if (previewFilename.value !== filename) return
    previewMeta.value = r
    previewCues.value = r.cues || []
    previewRaw.value = r.raw || ''
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Could not load subtitle content')
    closePreview()
  } finally {
    if (previewFilename.value === filename) previewLoading.value = false
  }
}

const codeUpper = computed(() => episodeId.value.toUpperCase())
const srtNames = computed(() => new Set((status.value?.existing_srts || []).map(s => s.filename.toLowerCase())))
function chapterHasSrt(secSlug: string): boolean {
  if (status.value?.completion?.mode === 'full-track') return true
  if (status.value?.completion) {
    const normalized = secSlug.toLowerCase().replace(/[^a-z0-9]/g, '')
    return status.value.completion.completed_sections.some(
      section => section.toLowerCase().replace(/[^a-z0-9]/g, '') === normalized,
    )
  }
  return srtNames.value.has(`${codeUpper.value}_${secSlug}.srt`.toLowerCase())
}
const coverage = computed(() => {
  const total = sections.value.length
  const done = sections.value.filter(s => chapterHasSrt(s.slug)).length
  return { total, done }
})
const coveragePct = computed(() => coverage.value.total ? Math.round((coverage.value.done / coverage.value.total) * 100) : 0)

const transcribeJobActive = computed(() =>
  (jobs.value as any[]).some(j =>
    j.type === 'subtitles_transcribe' && j.episode_id === episodeId.value &&
    j.project_slug === slug.value && (j.status === 'queued' || j.status === 'running'),
  ),
)

const transcribeLabel = computed(() => 'Transcribe (GenStudio)')

const canTranscribe = computed(() => {
  if (!episodeId.value || !status.value?.has_chapter_audio) return false
  if (transcribing.value || transcribeJobActive.value) return false
  return genstudioModelReady.value
})
const transcribeDisabledReason = computed(() => {
  if (!episodeId.value) return 'Pick an episode first'
  if (!status.value?.has_chapter_audio) return 'No chapter audio — generate audio first'
  if (genstudioModelsLoading.value) return 'Loading GenStudio transcription models'
  if (genstudioModelsError.value) return genstudioModelsError.value
  if (!genstudioModel.value) return 'GenStudio KH did not publish a transcription model'
  if (!genstudioModelReady.value) return 'The selected GenStudio transcription model has no ready workers'
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
  closePreview()   // don't show the previous episode's cues under a new episode
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
    const r = await post<{ total_cues: number; total_duration_sec: number; lead_in_sec: number; sections: any[] }>(
      `/projects/${slug.value}/scene-plan/${episodeId.value}/stitch-subtitles`, {},
    )
    success(
      `Stitched ${r.total_cues} cue(s) across ${r.sections?.length ?? '?'} section(s)` +
      `${r.lead_in_sec > 0 ? ` with ${r.lead_in_sec.toFixed(1)}s intro offset` : ''} — ready for Scene Plan.`,
    )
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

async function transcribe(): Promise<void> {
  if (!canTranscribe.value) return
  transcribing.value = true
  try {
    await post(`/projects/${slug.value}/video-editor/subtitles/transcribe/${episodeId.value}`, {
      per_chapter: true,
      engine: 'genstudio',
      model: genstudioModel.value,
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
    if (previewFilename.value === filename) closePreview()
    success(`Deleted ${filename}`)
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Delete failed')
  }
}

// ── Presets ─────────────────────────────────────────────────────────────────
// GenStudio model + re-run flag are saved as named presets via the top bar,
// same pattern as the other generator tabs — so the user's pick persists and
// is shareable, instead of a hidden per-machine localStorage value. Distinct
// configKey from Video Assembly's 'subtitles' (subtitle-STYLE) presets.
const subtitlesPresets = usePresets<{ model?: string; force?: boolean }>({
  slug: slug.value,
  configKey: 'subtitles_generator',
  snapshot: () => ({ model: genstudioModel.value, force: force.value }),
  apply: (d) => {
    if (typeof d?.model === 'string' && d.model) genstudioModel.value = d.model
    if (typeof d?.force === 'boolean') force.value = d.force
  },
})

onMounted(async () => {
  // Auto-apply the model/re-run preset, then heal retired model IDs against the
  // authoritative GenStudio catalog.
  await subtitlesPresets.load()
  await loadGenstudioModels()
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

/* Subtitle cue preview (v1.0.494/495) — panel styles live in SubtitleCuePreview.vue. */
.btn-icon.active { color: var(--accent); }
</style>
