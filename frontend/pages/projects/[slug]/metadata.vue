<template>
  <div class="workspace-page creation-workspace metadata-workspace">
    <WorkspaceHero
      eyebrow="Publish · Finalize"
      title="YouTube Finalizer"
      :description="isMusic
        ? 'Build one upload-ready YouTube package for this music episode: the writing model you pick writes the words from the channel formula, the episode theme and the tracklist; chapters come from the tracklist.'
        : 'Build one upload-ready YouTube package after narration timing and subtitles are available.'"
    >
      <template #aside>
        <div class="workspace-metrics" aria-label="Metadata workspace context">
          <span class="workspace-metric" :data-tone="episodeId ? 'success' : 'warning'"><strong>{{ episodeId || 'No episode' }}</strong> target</span>
          <span class="workspace-metric" :data-tone="finalizationStatus?.audio_assembly_ready ? 'success' : 'warning'"><strong>{{ finalizationStatus?.audio_assembly_ready ? 'Ready' : 'Needed' }}</strong> timing</span>
          <span v-if="!isMusic" class="workspace-metric" :data-tone="finalizationStatus?.subtitle_complete ? 'success' : 'warning'"><strong>{{ finalizationStatus?.subtitle_complete ? 'Verified' : 'Warning' }}</strong> subtitles</span>
          <span v-if="metadataBusy" class="workspace-metric" data-tone="info"><strong>Active</strong> generation</span>
        </div>
      </template>
    </WorkspaceHero>
    <div class="workspace-command-surface creation-command-surface">
      <TopActionBar
      :project-slug="slug"
      :presets="metadataPresets"
      v-model:episode-id="episodeId"
      filter-field="metadata"
      generate-label="Finalize YouTube Package"
      :generate-loading="metadataBusy"
      :generate-disabled="!episodeId || (!scriptReady && !isMusic) || !finalizationStatus?.audio_assembly_ready"
      :generate-status="metadataBusy ? `Finalizing the YouTube package for ${episodeId}…` : finalizerGateReason"
      @generate="generateAll"
      @episode-selected="onEpisodeSelected"
      />
      <p class="workspace-command-copy">
        <template v-if="isMusic">One package for this music episode: title, description and tags from the model you pick, plus one chapter per song from the tracklist.</template>
        <template v-else>One Formula-led package: title, description, tags, approved chapter names, measured timestamps, and selected research sources.</template>
        <NuxtLink :to="`/projects/${slug}/metadata-template`" class="meta-template-link">Configure publishing profile →</NuxtLink>
      </p>
    </div>

    <p v-if="episodeId && statusKnown && !scriptReady && !isMusic && !finalizationChecking" class="workspace-command-copy">
      No finished script yet for <strong>{{ episodeId }}</strong>. If some chapters are still unwritten, finish them first.
      <NuxtLink :to="`/projects/${slug}/scripts?episode_id=${encodeURIComponent(episodeId)}`" class="btn btn-secondary btn-sm">Open Script Generator</NuxtLink>
    </p>


    <!-- v1.0.298 — persistent generation feedback. The button spinner covers
         "is it running"; this row covers "is it done, and did it work" AFTER
         the spinner clears + the transient toast fades. Running → live status;
         done → success/error/cancelled that stays put until the next run or an
         episode switch. -->
    <div v-if="metadataBusy" class="meta-result meta-result-running">
      <LoadingSpinner size="sm" />
      <span>Finalizing the YouTube package for <strong>{{ episodeId }}</strong>… you can switch episodes; it keeps running in the background.</span>
      <span v-if="pollNotice" class="text-muted text-xs">{{ pollNotice }}</span>
    </div>
    <div
      v-else-if="lastGenResult"
      :class="['meta-result', `meta-result-${lastGenResult.kind}`]"
    >
      <span class="meta-result-icon" aria-hidden="true">{{ lastGenResult.kind === 'success' ? '✓' : lastGenResult.kind === 'cancelled' ? '⊘' : '✗' }}</span>
      <span>{{ lastGenResult.message }}</span>
      <NuxtLink
        v-if="lastGenResult.kind === 'success' && episodeId"
        :to="`/projects/${slug}/upload/publish?episode_id=${encodeURIComponent(episodeId)}`"
        class="meta-template-link"
      >Continue to Publish →</NuxtLink>
      <button type="button" class="btn btn-link btn-xs meta-result-dismiss" @click="lastGenResult = null">Dismiss</button>
    </div>

    <div v-if="episodeId" class="card workspace-section finalizer-readiness">
      <div class="finalizer-readiness-head">
        <div>
          <span class="settings-section-kicker">Final package inputs</span>
          <h3>Timing and evidence readiness</h3>
        </div>
        <span v-if="finalizationChecking" class="text-muted text-xs">Checking…</span>
      </div>
      <div v-if="finalizationError" class="finalizer-warning">
        <strong>Couldn't check whether this episode is ready</strong>
        <p class="text-xs">Story Studio couldn't read the Audio Assembly and subtitle status for {{ episodeId }}.</p>
        <button type="button" class="btn btn-secondary btn-sm" :disabled="finalizationChecking" @click="loadFinalizationStatus">Retry</button>
      </div>
      <div v-if="finalizationStatus" class="finalizer-readiness-grid">
        <div :data-tone="finalizationStatus.audio_assembly_ready ? 'success' : 'warning'">
          <strong>{{ finalizationStatus.audio_assembly_ready ? 'Ready' : 'Missing' }}</strong>
          <span>{{ isMusic ? 'Stitched tracklist' : 'Audio Assembly timing' }}</span>
        </div>
        <div v-if="isMusic" data-tone="info">
          <strong>{{ finalizationStatus.music_episode?.songs ?? 0 }}</strong>
          <span>songs</span>
        </div>
        <div v-else :data-tone="finalizationStatus.subtitle_complete ? 'success' : 'warning'">
          <strong>{{ finalizationStatus.subtitle_complete ? 'Verified' : 'Not verified' }}</strong>
          <span>Subtitle coverage</span>
        </div>
        <div data-tone="info">
          <strong>{{ finalizationStatus.chapter_count }}</strong>
          <span>chapter markers</span>
        </div>
        <div v-if="!isMusic" data-tone="info">
          <strong>{{ finalizationStatus.source_count }}</strong>
          <span>selected sources</span>
        </div>
      </div>
      <p v-if="isMusic && !finalizationStatus?.audio_assembly_ready" class="finalizer-warning">
        Send this episode to Video Assembly in Episode Builder first; its chapters come from the stitched tracklist.
        <NuxtLink :to="`/projects/${slug}/episode-builder?episode_id=${encodeURIComponent(episodeId)}`" class="meta-template-link">Open Episode Builder →</NuxtLink>
      </p>
      <p v-else-if="finalizationStatus && !finalizationStatus.audio_assembly_ready" class="finalizer-warning">
        Run Audio Assembly first so the final description can use measured chapter timing.
        <NuxtLink :to="`/projects/${slug}/audio-merge?episode_id=${encodeURIComponent(episodeId)}`" class="meta-template-link">Open Audio Assembly →</NuxtLink>
      </p>
      <div v-if="finalizationStatus?.warnings.length" class="finalizer-warning">
        <strong>Package can still be generated with warnings</strong>
        <ul>
          <li v-for="warning in finalizationStatus.warnings" :key="warning">{{ warning }}</li>
        </ul>
      </div>
      <p v-else-if="finalizationStatus && isMusic" class="finalizer-ready-copy">
        One chapter per song from the tracklist (first at 0:00, at least three, each 10 s or longer). The writing model you pick below writes the title, description and tags.
      </p>
      <p v-else-if="finalizationStatus" class="finalizer-ready-copy">
        Audio timing and subtitle coverage agree. Finalization will use approved outline titles and the sources you selected during Research.
      </p>
      <p v-if="finalizationStatus && !isMusic" class="text-muted text-xs finalizer-source-link">
        Source inclusion is owned by the
        <NuxtLink :to="`/projects/${slug}/research`" class="meta-template-link">Research step →</NuxtLink>
      </p>
    </div>

    <!-- Channel "what worked" inspiration. Auto-included server-side in
         the title generator's LLM prompt; this card surfaces the titles
         being used as a vibe reference. Hides silently when no analytics
         data is available. -->
    <TopPerformersInspiration :slug="slug" class="mt-3" />

    <!-- AI model used to write the title, description and tags in the one -->
    <!-- YouTube package. -->
    <div class="card workspace-section shared-settings">
      <div class="shared-settings-label">
        <span>AI Model</span>
        <span class="text-muted text-xs font-normal">writes the whole YouTube package</span>
      </div>
      <div class="form-group shared-settings-control">
        <ModelSelector v-model="model" :project-slug="slug" writing-step />
      </div>
    </div>

    <div class="card workspace-section metadata-blueprint">
      <div class="blueprint-heading">
        <div>
          <span class="settings-section-kicker">Formula publishing blueprint</span>
          <h3>{{ formulaMetadataProfile.label }}</h3>
          <p class="text-muted">{{ formulaMetadataProfile.description }}</p>
        </div>
        <NuxtLink :to="`/projects/${slug}/settings#identity`" class="btn btn-secondary btn-sm">View Channel Identity</NuxtLink>
      </div>
      <div class="blueprint-flow" aria-label="Formula metadata structure">
        <span v-for="(label, index) in formulaSectionLabels" :key="label" class="blueprint-step">
          {{ label }}<i v-if="index < formulaSectionLabels.length - 1" aria-hidden="true">→</i>
        </span>
      </div>
      <div class="blueprint-meta">
        <span>Title: use approved idea</span><span>{{ formulaMetadataProfile.tagCount }} YouTube tags</span><span>{{ formulaMetadataProfile.descriptionMaxChars.toLocaleString() }}-character description cap</span>
        <span v-if="publishingProfileActive" class="blueprint-active">Publishing profile active</span>
      </div>
      <p class="text-muted text-xs mt-2">
        Reusable links, CTAs, credits, disclosures, and title wrappers live once in the channel publishing profile—not in every episode.
      </p>
    </div>

    <!-- v2026-08-27 — description formula override. Distinct from the Series
         Formula blueprint above: this picks a "metadata formula" (section
         architecture + title/tag/tone shaping) for THIS episode's run only.
         Default state sends nothing so the channel default (set on the
         publishing profile page) applies server-side. -->
    <div class="card workspace-section metadata-formula-override">
      <div class="blueprint-heading">
        <div>
          <span class="settings-section-kicker">Description formula override</span>
          <h3>This episode's description formula</h3>
          <p class="text-muted">Optional — overrides the channel default for this run only.</p>
        </div>
      </div>
      <div class="form-group mt-1">
        <select v-model="metadataFormulaSelection" class="select" :disabled="metadataFormulasLoading">
          <option :value="CHANNEL_DEFAULT_FORMULA">Use channel default ({{ channelDefaultFormulaLabel }})</option>
          <option value="">None for this episode</option>
          <option v-for="f in metadataFormulas" :key="f.id" :value="f.id">{{ f.name }}</option>
        </select>
      </div>
      <div v-if="selectedOverrideFormula" class="blueprint-flow" aria-label="Selected formula outline">
        <span v-for="(item, index) in selectedOverrideFormula.outline" :key="item.id" class="blueprint-step">
          {{ item.id }}: {{ item.header ? `“${item.header}”` : 'no header' }}<i v-if="index < selectedOverrideFormula.outline.length - 1" aria-hidden="true">→</i>
        </span>
      </div>
      <p v-if="effectiveFormula" class="text-muted text-xs mt-2">
        <strong>{{ effectiveFormula.name }}</strong> supplies this run's description sections, lengths and counts.
        Choose &ldquo;None for this episode&rdquo; to use the default sections, lengths and counts instead.
      </p>
      <p v-if="metadataFormulasError" class="text-muted text-xs mt-2">Could not load description formulas: {{ metadataFormulasError }}</p>
    </div>

    <!-- ═══════ Preview ═══════ -->
    <div v-if="metadataLoadError" class="meta-result meta-result-error">
      <span class="meta-result-icon" aria-hidden="true">✗</span>
      <span>Couldn't load saved metadata for <strong>{{ metadataLoadError }}</strong>. Nothing was changed — the saved version is still on disk.</span>
      <button type="button" class="btn btn-secondary btn-sm meta-result-dismiss" @click="retryLoadMetadata">Retry</button>
    </div>
    <div class="card mt-2">
      <div class="card-header">
        <h3>Preview</h3>
        <div class="flex gap-2 items-center">
          <SaveIndicator :state="autoSave.state.value" :saved-at="autoSave.savedAt.value" :error-message="autoSave.errorMessage.value" />
          <span class="text-muted text-xs">
            <template v-if="sessionVersion">Editing v{{ sessionVersion }} (auto-saving)</template>
            <template v-else-if="versions.length">Loaded v{{ selectedVersion }} — first edit creates v{{ nextVersionNumber }}</template>
            <template v-else>First save will create v1</template>
          </span>
          <div v-if="versions.length" class="form-group history-picker">
            <label class="text-muted history-label">History</label>
            <select v-model.number="selectedVersion" @change="loadVersion" class="select select-sm" :title="`${versions.length} version(s) on disk`">
              <option v-for="v in versions" :key="v.version" :value="v.version">
                v{{ v.version }}{{ v.savedAt ? ` — ${formatDate(v.savedAt)}` : '' }}
              </option>
            </select>
          </div>
          <button
            class="btn btn-sm btn-secondary"
            :title="'Save what is on screen as a new version right now (otherwise autosave handles this)'"
            :disabled="!episodeId"
            @click="forkToNewVersion"
          >
            Save as new version (v{{ nextVersionNumber }})
          </button>
        </div>
      </div>

      <div class="form-group mt-1">
        <label>
          Title
          <span class="char-count" :class="{ 'over-limit': preview.title.length > titleConfig.maxLength }">
            {{ preview.title.length }} / {{ titleConfig.maxLength }}
          </span>
          <button class="btn-icon" @click="copy(preview.title, 'Title')" title="Copy title">📋</button>
        </label>
        <input v-model="preview.title" class="input" :disabled="!episodeId" placeholder="SEO video title" />
      </div>

      <div class="form-group mt-1">
        <label>
          Description
          <span class="char-count" :class="{ 'over-limit': preview.description.length > descConfig.maxChars }">
            {{ preview.description.length }} / {{ descConfig.maxChars }}
          </span>
          <button class="btn-icon" @click="copy(preview.description, 'Description')" title="Copy description">📋</button>
        </label>
        <textarea v-model="preview.description" class="textarea preview-textarea" :disabled="!episodeId" placeholder="Generated description will appear here" />
      </div>

      <div class="form-group mt-1">
        <label>
          Tags
          <span class="char-count">{{ preview.tags.length }} tags</span>
          <button class="btn-icon" @click="copy(tagsAsString, 'Tags')" title="Copy tags as comma-separated string">📋</button>
        </label>
        <textarea v-model="tagsAsString" class="textarea tags-textarea" :disabled="!episodeId" :placeholder="tagsPlaceholder" />
      </div>
    </div>

  </div>
</template>

<script setup lang="ts">
definePageMeta({ layout: 'dashboard' })
useAppTitle('YouTube Finalizer')
const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { get, post, put } = useApi()
const freshMetadataAction = useFreshGenerationAction()
const { success, error: showError } = useToast()
const { metaGenerating } = useGenerating()

const episodeId = ref('')
let metadataScopeEpoch = 0
// A live GenStudio catalog picker chooses the first usable model. Never seed
// a retired direct-provider id into saved metadata settings.
const model = ref('')

// Source-of-truth gating: every metadata generator (descriptions, titles,
// tags, "Generate All") reads narration context from the script docx, so
// we disable the buttons until episode.status.script flips true. Refetches
// when a script-only job lands so the page enables itself live without a
// reload.
const { selectedEpisode, scriptReady, statusKnown } = useEpisodeStatus(episodeId, slug, {
  refetchOnJobTypes: ['audio_merge', 'subtitles_transcribe'],
})
const noScriptTooltip = "No finished script yet — finish this episode's script in Script Generator first."
// v1.0.296 — gate copy distinguishes "still checking" from "confirmed missing".
const scriptGateReason = computed(() => {
  if (!episodeId.value || scriptReady.value) return ''
  return statusKnown.value ? noScriptTooltip : 'Checking script status…'
})

interface FinalizationStatus {
  audio_assembly_ready: boolean
  subtitle_complete: boolean
  subtitle_mode: 'per-section' | 'full-track' | 'none'
  subtitle_missing_sections: string[]
  outline_title_count: number
  chapter_count: number
  source_count: number
  lead_in_seconds: number
  warnings: string[]
  music_episode?: { songs: number; tracklist_ready: boolean }
}
const finalizationStatus = ref<FinalizationStatus | null>(null)
/** An Episode Builder (music) episode: no script, no narration timing, chapters from its tracklist. */
const isMusic = computed(() => !!finalizationStatus.value?.music_episode)
const finalizationChecking = ref(false)
const finalizationError = ref(false)
let finalizationLoadSequence = 0
const finalizerGateReason = computed(() => {
  if (scriptGateReason.value && !isMusic.value && !finalizationChecking.value) return scriptGateReason.value
  if (!episodeId.value) return ''
  if (finalizationError.value) return "Couldn't check whether this episode is ready."
  if (finalizationChecking.value || !finalizationStatus.value) return 'Checking Audio Assembly timing…'
  if (!finalizationStatus.value.audio_assembly_ready) {
    return isMusic.value
      ? (finalizationStatus.value.warnings[0] || 'Send this episode to Video Assembly in Episode Builder first.')
      : 'Run Audio Assembly first (link below) so the final description can use measured chapter timing.'
  }
  if (isMusic.value && !model.value) return 'Pick the writing model below; Story Studio does not pick one for you.'
  return finalizationStatus.value.subtitle_complete
    ? ''
    : 'Subtitle verification is incomplete. You can still finalize; Story Studio will keep the warning visible.'
})

async function loadFinalizationStatus() {
  const requestSequence = ++finalizationLoadSequence
  const scopeEpoch = metadataScopeEpoch
  const projectSlug = slug.value
  if (!episodeId.value) {
    finalizationStatus.value = null
    finalizationError.value = false
    return
  }
  finalizationChecking.value = true
  finalizationError.value = false
  const code = episodeId.value
  try {
    const status = await get<FinalizationStatus>(
      `/projects/${projectSlug}/episodes/${encodeURIComponent(code)}/youtube-finalization-status`,
    )
    if (requestSequence === finalizationLoadSequence && metadataScopeEpoch === scopeEpoch && slug.value === projectSlug && episodeId.value === code) finalizationStatus.value = status
  } catch {
    if (requestSequence === finalizationLoadSequence && metadataScopeEpoch === scopeEpoch && slug.value === projectSlug && episodeId.value === code) {
      finalizationStatus.value = null
      finalizationError.value = true
    }
  } finally {
    if (requestSequence === finalizationLoadSequence && metadataScopeEpoch === scopeEpoch && slug.value === projectSlug && episodeId.value === code) finalizationChecking.value = false
  }
}

const genAll = ref(false)
let metadataGenerationSequence = 0

// v1.0.115+ — per-episode "is a metadata job in flight" computed. The
// existing `genAll` ref stays true through the whole job (waitForJob
// blocks until done), but when the user swaps episodes mid-render it
// kept the new episode's TopActionBar stuck in "Generating metadata for
// [new ep]…" loading state even though the job belongs to the OLD ep.
// Derive from the jobs list instead so the UI reflects whichever
// episode the user is currently looking at.
const { jobs: metaJobs } = useJobs()
const finalizerInputJobSignal = computed(() =>
  metaJobs.value
    .filter((job: any) =>
      job.project_slug === slug.value
      && job.episode_id === episodeId.value
      && ['audio_merge', 'subtitles_transcribe'].includes(job.type),
    )
    .map((job: any) => `${job.job_id}:${job.status}`)
    .sort()
    .join('|'),
)
watch(finalizerInputJobSignal, () => {
  if (episodeId.value) void loadFinalizationStatus()
})
const metadataJobActiveForEpisode = computed(() => {
  if (!episodeId.value) return false
  return metaJobs.value.some((j: any) =>
    j.episode_id === episodeId.value &&
    j.project_slug === slug.value &&
    j.type === 'metadata' &&
    (j.status === 'queued' || j.status === 'running'),
  )
})

// v1.0.298 — the button + status must reflect the user's OWN in-flight click
// IMMEDIATELY, not wait for the job to propagate through the SSE/poll stream.
// `genAll` flips true synchronously on click; `metadataJobActiveForEpisode`
// (jobs-derived) covers the "switched away and came back" case. OR them so
// there's never a dead window where a generation is running but nothing shows.
const metadataBusy = computed(() => genAll.value || metadataJobActiveForEpisode.value)

// v1.0.298 — persistent outcome of the last "Generate Metadata" run. The
// transient toast fades in 5s; this stays until the next run or an episode
// switch, so the user always has a durable "did it work?" signal.
const lastGenResult = ref<null | { kind: 'success' | 'error' | 'cancelled'; message: string }>(null)

// Defensive — clear genAll on episode swap. The original waitForJob
// is still tracking the OLD episode's job in the background; this just
// stops it from gating the new episode's UI. Also clear the stale result
// banner — it belonged to the episode we just left.
watch([slug, episodeId], ([projectSlug, newEp], [previousSlug, oldEp]) => {
  if (projectSlug !== previousSlug || newEp !== oldEp) {
    metadataGenerationSequence++
    genAll.value = false
    lastGenResult.value = null
    // Override is per-episode-run only — never carry one episode's explicit
    // pick onto the next episode's generation.
    metadataFormulaSelection.value = CHANNEL_DEFAULT_FORMULA
    // The generated title alternatives belong to the episode that produced
    // them. Blanked here as well as in `applyVersion` so the window before the
    // new episode's version loads cannot submit the old episode's titles.
    titleOptions.value = []
    // v1.4.194 — the finalization status belongs to one episode too. It was
    // replaced only when a load SUCCEEDED, so between the episode change and
    // the new status arriving `finalizerGateReason` kept answering from the
    // previous episode's readiness — and after a failed load it kept answering
    // from it indefinitely. Bumping the sequence discards any response already
    // in flight for the episode that is no longer open.
    finalizationStatus.value = null
    finalizationChecking.value = false
    finalizationError.value = false
    finalizationLoadSequence++
  }
})

// Section configs
const titleConfig = reactive({
  preset: 'Universal',
  maxLength: 100,
  count: 5,
  includeScriptContext: true,
  /**
   * v1.0.90+: default flipped from 'paraphrase' to 'use_idea_title' so
   * the title the user picked at Ideas Generator time stays the title
   * by default. Paraphrase is now opt-in for the "generate me 5 SEO
   * variants" workflow.
   *
   * 'use_idea_title' (default) — copy the episode's idea title verbatim.
   * 'paraphrase'                — LLM-rewrite into N SEO variants.
   * 'manual'                    — use `manualTitle` verbatim.
   * For the fixed modes (idea / manual) the project's saved channel
   * `prefix` is prepended and `suffix` appended. Fixed modes always
   * emit one title; the count slider applies only to paraphrase.
   */
  mode: 'use_idea_title' as 'paraphrase' | 'use_idea_title' | 'manual',
  /** Channel-level prefix locked in front of every title. Persisted on
   *  the project config so re-running metadata generation uses the same
   *  value without re-typing. */
  prefix: '',
  suffix: '',
  manualTitle: '',
})
const descConfig = reactive({ maxChars: 5000 })
const tagConfig = reactive({ count: 15 })
type FormulaMetadataProfile = {
  id: string
  label: string
  description: string
  descriptionSectionIds: string[]
  titleMode: 'use_idea_title' | 'paraphrase'
  descriptionMaxChars: number
  titleMaxLength: number
  tagCount: number
}
const formulaMetadataProfile = ref<FormulaMetadataProfile>({
  id: 'youtube-direct', label: 'Direct YouTube package',
  description: 'A focused episode summary, reusable channel details, and discoverability information.',
  descriptionSectionIds: ['hook', 'cta', 'ai-disclosure', 'hashtags'],
  titleMode: 'use_idea_title', descriptionMaxChars: 4000, titleMaxLength: 100, tagCount: 15,
})
const publishingProfileActive = ref(false)

// ── Metadata formulas (2026-08-27) ──────────────────────────────────────────
// A DIFFERENT concept from the Series Formula blueprint above
// (`formulaMetadataProfile`, niche-driven script/title context). A metadata
// formula owns the description's section ARCHITECTURE (ordered sections,
// each with its own instruction/header/length) plus title shaping, tag
// guidance and tone. The channel picks a default on the publishing profile
// page (`metadata-template.vue`); here the user may override it for one
// episode's run. `CHANNEL_DEFAULT_FORMULA` is a UI-only sentinel — it is
// never sent to the backend. Selecting it means "omit metadata_formula_id
// entirely", which is how the backend's channel-default fallback triggers.
const CHANNEL_DEFAULT_FORMULA = '__channel_default__'
interface MetadataFormula {
  id: string
  name: string
  description: string
  architecture: string
  source: 'built-in' | 'pack'
  pack_id: string | null
  section_count: number
  description_max_chars: number
  title_count: number
  tag_count: number
  outline: Array<{ id: string; header: string }>
}
const metadataFormulas = ref<MetadataFormula[]>([])
const channelDefaultFormulaId = ref('')
const metadataFormulaSelection = ref<string>(CHANNEL_DEFAULT_FORMULA)
const metadataFormulasLoading = ref(false)
const metadataFormulasError = ref('')

const channelDefaultFormulaLabel = computed(() => {
  if (!channelDefaultFormulaId.value) return 'none'
  return metadataFormulas.value.find(f => f.id === channelDefaultFormulaId.value)?.name || channelDefaultFormulaId.value
})
/**
 * The formula that will actually shape this run: the episode override when the
 * user picked one, otherwise the channel's default. Empty string = none, and
 * then this page behaves exactly as it did before formulas existed.
 */
const effectiveFormulaId = computed(() => (
  metadataFormulaSelection.value === CHANNEL_DEFAULT_FORMULA
    ? channelDefaultFormulaId.value
    : metadataFormulaSelection.value
))
const effectiveFormula = computed<MetadataFormula | null>(() => (
  effectiveFormulaId.value
    ? metadataFormulas.value.find(f => f.id === effectiveFormulaId.value) || null
    : null
))
const selectedOverrideFormula = computed<MetadataFormula | null>(() => {
  if (metadataFormulaSelection.value === CHANNEL_DEFAULT_FORMULA || !metadataFormulaSelection.value) return null
  return metadataFormulas.value.find(f => f.id === metadataFormulaSelection.value) || null
})

async function loadMetadataFormulas(): Promise<void> {
  metadataFormulasLoading.value = true
  metadataFormulasError.value = ''
  try {
    const data = await get<{ channel_default_id: string; formulas: MetadataFormula[] }>(
      `/projects/${slug.value}/metadata/formulas`,
    )
    metadataFormulas.value = Array.isArray(data?.formulas) ? data.formulas : []
    channelDefaultFormulaId.value = data?.channel_default_id || ''
  } catch (e: any) {
    metadataFormulasError.value = e?.data?.detail || e?.message || 'unknown'
  } finally {
    metadataFormulasLoading.value = false
  }
}

// v1.0.259 — remember the title settings across reloads. prefix / suffix /
// manualTitle are excluded: prefix+suffix already persist on the project config
// (channel-level), and manualTitle is per-episode content.
useRememberedForm('metadata', slug, titleConfig, {
  include: ['preset', 'maxLength', 'count', 'includeScriptContext', 'mode'],
})
// `model` is a standalone ref bound to <ModelSelector v-model="model">. Bridge
// it through a 1-field reactive so the picked LLM is remembered too; on load we
// push the restored value into the ref once, then mirror ref→memo so later
// picks persist. An invalid restored model self-heals via ModelSelector.
const modelMemo = reactive({ model: model.value })
useRememberedForm('metadata-model', slug, modelMemo, { include: ['model'] })
if (modelMemo.model) model.value = modelMemo.model
watch(model, (m) => { modelMemo.model = m })

// Results / preview
const titleOptions = ref<string[]>([])
const preview = reactive({
  title: '',
  description: '',
  tags: [] as string[],
})
const versions = ref<Array<{ version: number; title: string; title_options?: string[]; description: string; tags: string[]; savedAt: string | null }>>([])
const selectedVersion = ref<number>(1)

// Section builder
interface SectionConfig { [key: string]: any }
interface Section { id: string; label: string; type: 'builtin' | 'custom'; enabled: boolean; config: SectionConfig }

// New section schema (Apr 2026 refactor):
//   - hook       — characters + optional starting_format prefix
//                  (was: number-of-sentences; sentences was too coarse for
//                  YouTube's snippet truncation which is character-based)
//   - narrator   — name (split out from old monolithic 'metadata' section)
//   - music      — title + link + disclaimer (NEW dedicated section)
//   - channels   — array of channels with optional kind=own|recommended
//                  (was: single channel inside 'metadata'; user now wants
//                  to recommend other channels too — same UX as 'videos')
//   - videos     — unchanged
//   - playlists  — unchanged
//   - cta        — subscribe/like only (split out from old conflated 'cta')
//   - support    — array of platforms (Patreon, Ko-fi, BMC, YT Members, custom)
//                  (was: Patreon-only field on the old 'cta' section)
//   - affiliate / ai-disclosure / hashtags — unchanged
//
// Old sections ('metadata', old-shape 'cta') are auto-migrated by the
// `apply` function in usePresets so existing presets transparently upgrade.
// Neutral compatibility baseline for old saved presets. New sessions are
// immediately replaced by the selected Formula's publishing blueprint.
const NEUTRAL_AI_DISCLOSURE = 'Created with the help of AI tools and reviewed before publishing.'
const defaultSections: Section[] = [
  { id: 'hook', label: 'Hook / Intro Paragraph', type: 'builtin', enabled: true, config: { characters: 220, starting_format: '' } },
  { id: 'narrator', label: 'Narrator Credit', type: 'builtin', enabled: false, config: { name: '' } },
  { id: 'music', label: 'Music Credit', type: 'builtin', enabled: false, config: { title: '', link: '', disclaimer: 'Music used with permission. See link above for full credit.' } },
  { id: 'channels', label: 'Channel Mentions', type: 'builtin', enabled: false, config: { channels: [{ name: '', url: '', kind: 'own' as 'own' | 'recommended' }] } },
  { id: 'videos', label: 'Video Recommendations', type: 'builtin', enabled: false, config: { videos: [{ name: '', url: '' }] } },
  { id: 'playlists', label: 'Playlists', type: 'builtin', enabled: false, config: { playlists: [{ name: '', url: '' }] } },
  { id: 'cta', label: 'Subscribe / Like CTA', type: 'builtin', enabled: true, config: { custom_lines: [] as string[] } },
  { id: 'support', label: 'Support / Membership', type: 'builtin', enabled: false, config: { platforms: [] as Array<{ kind: string; url: string; label?: string }> } },
  { id: 'affiliate', label: 'Affiliate Disclaimer', type: 'builtin', enabled: false, config: { text: 'As an Amazon Associate we earn from qualifying purchases.' } },
  { id: 'ai-disclosure', label: 'AI Disclosure', type: 'builtin', enabled: true, config: { text: NEUTRAL_AI_DISCLOSURE } },
  { id: 'hashtags', label: 'Hashtags (inside description)', type: 'builtin', enabled: true, config: { count: 15 } },
]

/**
 * Migrate a sections[] array from the pre-Apr-2026 schema to the new
 * shape. Idempotent: running on already-new sections is a no-op.
 *
 * Mappings:
 *   hook { sentences } → hook { characters: sentences * 80, starting_format: '' }
 *     (~80 chars per sentence is a reasonable rule of thumb for prose;
 *      keeps the user's existing length intent even though the unit
 *      changed)
 *   metadata { narrator_*, music, channel_* } → split into narrator + music + channels
 *   cta { patreon_url, custom_text } → split into cta + support
 *
 * Returns { migrated, didMigrate } so the caller can show a one-time
 * toast when something actually changed.
 */
function migrateSections(input: Section[]): { migrated: Section[]; didMigrate: boolean } {
  let didMigrate = false
  const out: Section[] = []
  let injectedNarrator = false, injectedMusic = false, injectedChannels = false, injectedSupport = false

  for (const s of input) {
    // Old monolithic metadata section → split
    if (s.id === 'metadata') {
      didMigrate = true
      const cfg = s.config || {}
      out.push({ id: 'narrator', label: 'Narrator Credit', type: 'builtin', enabled: cfg.narrator_enabled !== false, config: { name: cfg.narrator_name || '' } })
      out.push({ id: 'music', label: 'Music Credit', type: 'builtin', enabled: !!cfg.music, config: { title: '', link: '', disclaimer: 'Music used with permission. See link above for full credit.' } })
      out.push({
        id: 'channels', label: 'Channel Mentions', type: 'builtin',
        enabled: cfg.channel_enabled !== false,
        config: {
          channels: cfg.channel_name
            ? [{ name: cfg.channel_name, url: '', kind: 'own' }]
            : [{ name: '', url: '', kind: 'own' }],
        },
      })
      injectedNarrator = injectedMusic = injectedChannels = true
      continue
    }

    // Old cta with patreon_url → split into cta + support
    if (s.id === 'cta' && s.config && ('patreon_url' in s.config || 'custom_text' in s.config)) {
      didMigrate = true
      const cfg = s.config || {}
      out.push({
        id: 'cta', label: 'Subscribe / Like CTA', type: 'builtin', enabled: s.enabled,
        config: { custom_lines: cfg.custom_text ? [cfg.custom_text] : [] },
      })
      out.push({
        id: 'support', label: 'Support / Membership', type: 'builtin', enabled: s.enabled,
        config: {
          platforms: cfg.patreon_url
            ? [{ kind: 'patreon', url: cfg.patreon_url }]
            : [],
        },
      })
      injectedSupport = true
      continue
    }

    // hook { sentences } → hook { characters }
    if (s.id === 'hook' && s.config && 'sentences' in s.config && !('characters' in s.config)) {
      didMigrate = true
      const sentences = Number(s.config.sentences) || 3
      out.push({
        ...s,
        config: { characters: Math.max(120, Math.min(500, sentences * 80)), starting_format: '' },
      })
      continue
    }

    out.push(s)
  }

  // If presets were saved before the new sections existed, inject defaults
  // for any new section the migration didn't already produce. Order is
  // best-effort.
  const have = new Set(out.map(s => s.id))
  if (!have.has('narrator') && !injectedNarrator) {
    out.push({ id: 'narrator', label: 'Narrator Credit', type: 'builtin', enabled: false, config: { name: '' } })
    didMigrate = true
  }
  if (!have.has('music') && !injectedMusic) {
    out.push({ id: 'music', label: 'Music Credit', type: 'builtin', enabled: false, config: { title: '', link: '', disclaimer: 'Music used with permission. See link above for full credit.' } })
    didMigrate = true
  }
  if (!have.has('channels') && !injectedChannels) {
    out.push({ id: 'channels', label: 'Channel Mentions', type: 'builtin', enabled: false, config: { channels: [{ name: '', url: '', kind: 'own' }] } })
    didMigrate = true
  }
  if (!have.has('support') && !injectedSupport) {
    out.push({ id: 'support', label: 'Support / Membership', type: 'builtin', enabled: false, config: { platforms: [] } })
    didMigrate = true
  }

  return { migrated: out, didMigrate }
}

const sections = ref<Section[]>(JSON.parse(JSON.stringify(defaultSections)))

// ── Section catalog (mirrors the backend registry) ─────────────────────────
// The description section types and their default config. The Formula's
// publishing blueprint picks which of these make up the description.
interface CatalogEntry { id: string; label: string; defaultConfig: () => SectionConfig }
const SECTION_CATALOG: CatalogEntry[] = [
  { id: 'hook',          label: 'Hook / Intro Paragraph',        defaultConfig: () => ({ characters: 220, starting_format: '' }) },
  { id: 'narrator',      label: 'Narrator Credit',               defaultConfig: () => ({ name: '' }) },
  { id: 'music',         label: 'Music Credit',                  defaultConfig: () => ({ title: '', link: '', disclaimer: 'Music used with permission. See link above for full credit.' }) },
  { id: 'channels',      label: 'Channel Mentions',              defaultConfig: () => ({ channels: [{ name: '', url: '', kind: 'own' }] }) },
  { id: 'videos',        label: 'Video Recommendations',         defaultConfig: () => ({ videos: [{ name: '', url: '' }] }) },
  { id: 'playlists',     label: 'Playlists',                     defaultConfig: () => ({ playlists: [{ name: '', url: '' }] }) },
  { id: 'sources',       label: '📚 Sources',                    defaultConfig: () => ({}) },
  { id: 'cta',           label: 'Subscribe / Like CTA',          defaultConfig: () => ({ custom_lines: [] }) },
  { id: 'support',       label: 'Support / Membership',          defaultConfig: () => ({ platforms: [] }) },
  { id: 'affiliate',     label: 'Affiliate Disclaimer',          defaultConfig: () => ({ text: 'As an Amazon Associate we earn from qualifying purchases.' }) },
  { id: 'ai-disclosure', label: 'AI Disclosure',                 defaultConfig: () => ({ text: NEUTRAL_AI_DISCLOSURE }) },
  { id: 'hashtags',      label: 'Hashtags (inside description)',  defaultConfig: () => ({ count: 15 }) },
]
const catalogById = (id: string) => SECTION_CATALOG.find(c => c.id === id)
const formulaSectionLabels = computed(() => formulaMetadataProfile.value.descriptionSectionIds
  .map(id => catalogById(id)?.label.replace(/^📚\s*/, '') || id)
)

function sectionsForFormulaProfile(profile: FormulaMetadataProfile): Section[] {
  return profile.descriptionSectionIds.map<Section | null>((id) => {
    const entry = catalogById(id)
    if (!entry) return null
    const config = entry.defaultConfig()
    if (id === 'hashtags') config.count = profile.tagCount
    return { id: entry.id, label: entry.label, type: 'builtin' as const, enabled: true, config }
  }).filter((section): section is Section => section !== null)
}

async function loadFormulaMetadataProfile(): Promise<void> {
  try {
    const [effective, config] = await Promise.all([
      get<{ niche: { metadataProfile?: FormulaMetadataProfile } | null }>(`/projects/${slug.value}/effective-niche`),
      get<{ metadata_template?: { title?: string; description?: string; tags?: string[] } }>(`/projects/${slug.value}/settings/config`),
    ])
    const profile = effective?.niche?.metadataProfile
    if (profile?.descriptionSectionIds?.length) {
      formulaMetadataProfile.value = profile
      sections.value = sectionsForFormulaProfile(profile)
      titleConfig.mode = profile.titleMode
      titleConfig.count = profile.titleMode === 'paraphrase' ? 3 : 1
      titleConfig.maxLength = profile.titleMaxLength
      descConfig.maxChars = profile.descriptionMaxChars
      tagConfig.count = profile.tagCount
    }
    const template = config?.metadata_template
    publishingProfileActive.value = Boolean(template && (template.title || template.description || template.tags?.length))
  } catch {
    // A project without a Formula remains usable with the direct YouTube fallback.
  }
}
// ── Unified preset wiring ──────────────────────────────────────────────────
// Swapped off the custom youtube_templates schema onto the same usePresets
// composable every other generator page uses. One-time migration below
// converts pre-existing youtube_templates into the unified preset store
// so the user never loses their saved layouts.
interface MetadataPresetSnapshot {
  sections: Section[]
  /** Shared LLM used by title, description, and tag generation. */
  model?: string
  /**
   * Title-generation config. Persisted alongside sections so picking a
   * preset restores BOTH the description layout AND the title strategy
   * (eg "Use idea title + cozy-sleep suffix"). Optional in the snapshot
   * shape so older presets without this field still apply cleanly.
   */
  titleConfig?: {
    preset?: string
    maxLength?: number
    count?: number
    includeScriptContext?: boolean
    mode?: 'paraphrase' | 'use_idea_title' | 'manual'
    /** Channel-level title prefix locked across every episode (v1.0.90+). */
    prefix?: string
    suffix?: string
    manualTitle?: string
  }
}

const metadataPresets = usePresets<MetadataPresetSnapshot>({
  slug: slug.value,
  configKey: 'metadata',
  snapshot: () => ({
    sections: JSON.parse(JSON.stringify(sections.value)),
    model: model.value,
    titleConfig: {
      preset: titleConfig.preset,
      maxLength: titleConfig.maxLength,
      count: titleConfig.count,
      includeScriptContext: titleConfig.includeScriptContext,
      mode: titleConfig.mode,
      prefix: titleConfig.prefix,
      suffix: titleConfig.suffix,
      manualTitle: titleConfig.manualTitle,
    },
  }),
  apply: (data) => {
    if (!data?.sections) return
    // Run the schema migration before assigning. This handles any preset
    // saved before the Apr 2026 section split (old `metadata` /
    // `cta`-with-patreon shape) so the user's existing presets stay
    // usable without manual re-creation. The flag below ensures the
    // info toast fires once per migrated preset (keyed in localStorage).
    const { migrated, didMigrate } = migrateSections(JSON.parse(JSON.stringify(data.sections)))
    sections.value = migrated
    if (typeof data.model === 'string' && data.model.trim()) {
      model.value = data.model
    }
    // Apply titleConfig if the preset has it (older presets won't —
    // leave the user's current settings alone in that case).
    const tc = data.titleConfig
    if (tc) {
      if (tc.preset !== undefined) titleConfig.preset = tc.preset
      if (typeof tc.maxLength === 'number') titleConfig.maxLength = tc.maxLength
      if (typeof tc.count === 'number') titleConfig.count = tc.count
      if (typeof tc.includeScriptContext === 'boolean') titleConfig.includeScriptContext = tc.includeScriptContext
      if (tc.mode === 'paraphrase' || tc.mode === 'use_idea_title' || tc.mode === 'manual') {
        titleConfig.mode = tc.mode
      }
      if (typeof tc.prefix === 'string') titleConfig.prefix = tc.prefix
      if (typeof tc.suffix === 'string') titleConfig.suffix = tc.suffix
      if (typeof tc.manualTitle === 'string') titleConfig.manualTitle = tc.manualTitle
    }
    if (didMigrate) {
      const presetId = metadataPresets.activeId.value || 'unknown'
      const flagKey = `metadata-migration-toast-shown:${slug.value}:${presetId}`
      if (typeof window !== 'undefined' && !window.localStorage.getItem(flagKey)) {
        // Defer the toast so it shows AFTER the page mounts (calling
        // success() during component setup can be swallowed by Toast's
        // mount guard).
        nextTick(() => success('Your metadata preset was upgraded — review the new sections.'))
        try { window.localStorage.setItem(flagKey, '1') } catch { /* localStorage disabled — fine */ }
      }
    }
  },
})

// ── Computed ───────────────────────────────────────────────────────────────

const tagsAsString = computed({
  get: () => preview.tags.join(', '),
  set: (val: string) => { preview.tags = val.split(',').map(t => t.trim()).filter(Boolean) },
})

const nextVersionNumber = computed(() => {
  if (!versions.value.length) return 1
  return Math.max(...versions.value.map(v => v.version)) + 1
})

// ── Episode selection + preview load ──────────────────────────────────────

// Synchronous fast-path: drop the EpisodeSelector's payload straight into
// `selectedEpisode` so loadExistingMetadata (triggered by the episodeId
// watch) can read the title immediately. The useEpisodeStatus composable
// will subsequently refetch and overwrite with the API row that carries
// status.* — same data, just guaranteed-fresh.
function onEpisodeSelected(ep: any) {
  selectedEpisode.value = ep
}

// AGENTS.md §4: an episode's text must never stay on screen for another one.
// The page's saved-metadata fields all go blank together.
function blankPreview() {
  preview.title = ''
  preview.description = ''
  preview.tags = []
  titleOptions.value = []
}

// Episode code whose saved metadata could not be read ('' = no problem).
const metadataLoadError = ref('')

let metadataLoadSequence = 0
// `keepOnError`: the post-save dropdown refresh must not wipe what the user
// is looking at when only the refresh failed.
async function loadExistingMetadata(opts: { keepOnError?: boolean } = {}) {
  const requestSequence = ++metadataLoadSequence
  const scopeEpoch = metadataScopeEpoch
  const projectSlug = slug.value
  const code = episodeId.value
  if (!code) {
    blankPreview()
    versions.value = []
    metadataLoadError.value = ''
    return
  }
  try {
    const title = selectedEpisode.value?.title || ''
    const data = await get<{ versions: typeof versions.value }>(
      `/projects/${projectSlug}/episodes/${code}/metadata?title=${encodeURIComponent(title)}`
    )
    if (requestSequence !== metadataLoadSequence || metadataScopeEpoch !== scopeEpoch || slug.value !== projectSlug || episodeId.value !== code) return
    versions.value = data.versions || []
    metadataLoadError.value = ''
    if (versions.value.length) {
      const latest = versions.value[versions.value.length - 1]!
      selectedVersion.value = latest.version
      applyVersion(latest)
    } else {
      selectedVersion.value = 1
      blankPreview()
    }
  } catch {
    if (requestSequence !== metadataLoadSequence || metadataScopeEpoch !== scopeEpoch || slug.value !== projectSlug || episodeId.value !== code) return
    if (opts.keepOnError) return
    versions.value = []
    blankPreview()
    metadataLoadError.value = code
  }
}

async function retryLoadMetadata() {
  sessionVersion.value = null
  await suppressAutoSaveDuring(() => loadExistingMetadata())
}

function applyVersion(v: { title: string; title_options?: string[]; description: string; tags: string[] }) {
  preview.title = v.title || ''
  preview.description = v.description || ''
  preview.tags = Array.isArray(v.tags) ? [...v.tags] : []
  // Restore the AI-generated title alternatives if the saved version
  // includes them (pipeline runs always do; on-page runs do too if the
  // user hasn't cleared them). Lets the user pick a different title
  // later without re-running generation.
  //
  // REPLACED unconditionally, including with an empty list. This used to be
  // `if (Array.isArray(v.title_options) && v.title_options.length) { … }` with
  // no else, and `titleOptions` is written nowhere else — so an episode whose
  // saved version had no alternatives silently kept the PREVIOUS episode's and
  // then sent them as its own (`title_options: titleOptions.value` at the
  // existing-package generate and at save). AGENTS.md §4's exact shape: an
  // episode change must REPLACE the field or blank it, never leave the previous
  // episode's value standing.
  titleOptions.value = Array.isArray(v.title_options) ? [...v.title_options] : []
}

function loadVersion() {
  const v = versions.value.find(x => x.version === selectedVersion.value)
  if (v) suppressAutoSaveDuring(() => applyVersion(v))
}

// ── Generation ─────────────────────────────────────────────────────────────

async function generateAll() {
  if (!episodeId.value || (!scriptReady.value && !isMusic.value) || !finalizationStatus.value?.audio_assembly_ready) return
  // Capture the episode the user kicked off — if they switch mid-job we want
  // to apply the on-disk result to the ORIGINAL episode, not whatever they
  // navigated to. The EpisodeSelector confirm dialog already prompts the
  // user before the swap (it sees the queued/running 'metadata' job), but
  // they're still allowed to switch on confirm.
  const projectSlug = slug.value
  const startedEpisodeId = episodeId.value
  const generationSequence = ++metadataGenerationSequence
  const startedTitle = selectedEpisode.value?.title || ''
  genAll.value = true
  metaGenerating.value = true
  lastGenResult.value = null   // clear any prior outcome while this run is live
  try {
    // Queue via the job queue (parallel to /generate/script-only,
    // /generate/audio, etc.) so navigating away no longer cancels the
    // perceived work — the executor keeps running, writes the metadata
    // sidecar on completion, and useJobs() streams status updates.
    const payload = {
        episode_id: startedEpisodeId,
        title: startedTitle,
        model: model.value,
        title_platform_preset: titleConfig.preset,
        // Channel-level wrapping, never a formula's business — always sent.
        title_prefix: titleConfig.prefix,
        title_suffix: titleConfig.suffix,
        manual_title: titleConfig.manualTitle,
        // The backend rule is that an explicit request field beats the formula.
        // This page would otherwise assert ALL of these on every run, which
        // would leave a picked formula unable to change the one thing it exists
        // to change. So when a formula is in effect it owns them, and when none
        // is, every field is sent exactly as before.
        ...(effectiveFormulaId.value ? {} : {
          sections: sections.value.filter(s => s.enabled),
          max_chars: descConfig.maxChars,
          title_count: titleConfig.count,
          title_max_length: titleConfig.maxLength,
          title_mode: titleConfig.mode,
          tag_count: tagConfig.count,
        }),
        // Only present when the user actively overrode the formula for this
        // episode — omitted entirely (not even as "") so the backend falls
        // back to the channel default. See CHANNEL_DEFAULT_FORMULA above.
        ...(metadataFormulaSelection.value !== CHANNEL_DEFAULT_FORMULA
          ? { metadata_formula_id: metadataFormulaSelection.value }
          : {}),
        existing_package: preview.title.trim() && preview.description.trim() && preview.tags.length
          ? {
              title: preview.title,
              title_options: titleOptions.value,
              description: preview.description,
              tags: preview.tags,
            }
          : undefined,
      }
    const operationId = freshMetadataAction.begin(payload)
    const job = await post<{ job_id: string }>(
      `/projects/${projectSlug}/generate/metadata`,
      { ...payload, operation_id: operationId },
    )
    freshMetadataAction.complete(operationId)
    success(`Metadata queued. You can switch episodes; we'll keep generating in the background.`)
    const completed = await waitForJob(projectSlug, job.job_id)
    if (!completed) return   // page closed — the job keeps running in the background
    if (generationSequence !== metadataGenerationSequence || slug.value !== projectSlug || episodeId.value !== startedEpisodeId) return
    if (completed.status === 'cancelled') {
      lastGenResult.value = { kind: 'cancelled', message: `YouTube finalization cancelled for ${startedEpisodeId}.` }
      showError('YouTube finalization cancelled')
      return
    }
    if (completed.status === 'error') {
      throw new Error(completed.error || 'YouTube finalization failed. Open Jobs to see what went wrong.')
    }
    // Job done — re-load the latest version from disk. If the user is still
    // looking at the same episode they kicked off, refresh the preview;
    // otherwise just leave their current view alone (the new version is on
    // disk and they'll see it when they navigate back).
    if (slug.value === projectSlug && episodeId.value === startedEpisodeId) {
      sessionVersion.value = null
      await suppressAutoSaveDuring(() => loadExistingMetadata())
      await loadFinalizationStatus()
      lastGenResult.value = { kind: 'success', message: `YouTube package finalized for ${startedEpisodeId} — latest version applied below.` }
      success('YouTube package finalized — latest version applied.')
    } else {
      lastGenResult.value = { kind: 'success', message: `YouTube package finalized for ${startedEpisodeId} — switch back to that episode to view it.` }
      success(`YouTube package for ${startedEpisodeId} finalized — switch back to view.`)
    }
  } catch (e: any) {
    if (generationSequence !== metadataGenerationSequence || slug.value !== projectSlug || episodeId.value !== startedEpisodeId) return
    console.error('[metadata] generate all failed:', e)
    const msg = e.data?.detail || e?.message || 'Failed to finalize the YouTube package. Open Jobs to see what went wrong.'
    lastGenResult.value = { kind: 'error', message: msg }
    showError(msg)
  } finally {
    if (generationSequence === metadataGenerationSequence
      && slug.value === projectSlug && episodeId.value === startedEpisodeId) {
      pollNotice.value = ''
      genAll.value = false
      metaGenerating.value = false
    }
  }
}

// Poll a single job until it reaches a terminal state. Same pattern the
// ImageGeneratorPanel uses — useJobs() also streams updates globally, but a
// direct poll is the simplest way to await one specific job.
const JOB_POLL_INTERVAL_MS = 1500
const JOB_POLL_MAX_FAILURES = 4
const pollNotice = ref('')
let pageUnmounted = false
onBeforeUnmount(() => { pageUnmounted = true })
// Returns null when the page was closed (the job itself keeps running). A few
// consecutive network errors only show a note; the job is never reported as
// failed just because the poll could not reach the server.
async function waitForJob(projectSlug: string, jobId: string): Promise<any> {
  let failures = 0
  while (!pageUnmounted) {
    try {
      const job: any = await get(`/projects/${projectSlug}/jobs/${jobId}`)
      failures = 0
      pollNotice.value = ''
      if (job?.status === 'done' || job?.status === 'error' || job?.status === 'cancelled') return job
    } catch {
      failures++
      if (failures >= JOB_POLL_MAX_FAILURES) {
        pollNotice.value = ''
        throw new Error('Lost contact with Story Studio. The job may still be running — open Jobs to see its progress.')
      }
      pollNotice.value = 'Lost contact, still checking…'
    }
    await new Promise(r => setTimeout(r, JOB_POLL_INTERVAL_MS))
  }
  return null
}

// ── Save ───────────────────────────────────────────────────────────────────

// Manual escape hatch: snapshot current edits as a fresh version on disk
// even mid-session. After forking, the autosave session adopts that new
// version so further keystrokes accumulate into it.
async function forkToNewVersion() {
  sessionVersion.value = null
  await autoSave.flush()
}

// ── Copy helpers ───────────────────────────────────────────────────────────

async function copy(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text)
    success(`${label} copied`)
  } catch {
    showError('Copy failed')
  }
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch {
    return iso
  }
}

// ── One-time migration + preset load ───────────────────────────────────────
// If this project still carries the legacy `youtube_templates` config key
// and has no `metadata_presets` yet, convert once and persist under the new
// keys so `usePresets` can take over. Old keys are left in place as a
// safety net — removed in a later release.
async function migrateLegacyMetadataTemplates() {
  try {
    const config = await get<any>(`/projects/${slug.value}/settings/config`)
    const alreadyMigrated = Array.isArray(config.metadata_presets) && config.metadata_presets.length
    const hasLegacy = Array.isArray(config.youtube_templates) && config.youtube_templates.length
    if (alreadyMigrated || !hasLegacy) return

    // Legacy shape: { id, name, sections? }. New shape: { id, name, data: { sections } }.
    const migrated = config.youtube_templates
      .filter((t: any) => t && t.id && t.name)
      .map((t: any) => ({
        id: t.id,
        name: t.name,
        data: { sections: Array.isArray(t.sections) ? t.sections : [] },
      }))

    await put(`/projects/${slug.value}/settings/config`, {
      metadata_presets: migrated,
      metadata_last_preset: config.youtube_last_template || (migrated[0]?.id ?? ''),
    })
  } catch {
    // Migration failures are non-fatal — user can still use the defaults and
    // save new presets from scratch.
  }
}

// ── Auto-save (debounced, true autosave with silent versioning) ────────────
//
// Behaviour: the FIRST debounced save in an editing "session" creates a new
// version on disk. All subsequent saves in the same session overwrite that
// version in place. A new session starts when the episode changes, a
// different version is loaded, or generation runs (any of which calls
// `resetAutoSaveSession`). This keeps version history meaningful — one
// version per editing session — instead of one version per keystroke.

const sessionVersion = ref<number | null>(null)

function resetAutoSaveSession() {
  sessionVersion.value = null
  autoSave.reset()
}

// The episode an edit was made in, captured when the edit is scheduled so a
// save that fires (or is flushed) after an episode switch still writes to the
// episode the text belongs to.
let scheduledTarget: { slug: string; code: string; title: string } | null = null

const autoSave = useAutoSave({
  debounceMs: 800,
  save: async () => {
    const target = scheduledTarget ?? { slug: slug.value, code: episodeId.value, title: selectedEpisode.value?.title || '' }
    scheduledTarget = null
    if (!target.code) return
    // Skip if there's nothing meaningful to persist yet
    if (!preview.title && !preview.description && !preview.tags.length) return
    const projectSlug = target.slug
    const code = target.code
    const scopeEpoch = metadataScopeEpoch
    const writingTo = sessionVersion.value
    const data = await post<{ version: number }>(`/projects/${projectSlug}/generate/metadata/save`, {
      episode_id: code,
      title: target.title,
      metadata_title: preview.title,
      // Round-trip the AI-generated title alternatives so an overwrite save
      // doesn't wipe the alternates the pipeline saved. The backend defaults
      // to a single-entry list if we don't send anything.
      title_options: titleOptions.value,
      description: preview.description,
      tags: preview.tags,
      // First save in a session → new version. Re-saves in the same session
      // overwrite the version we just created so a paragraph of typing
      // doesn't fan out to v7..v12 silently.
      save_mode: writingTo == null ? 'new' : 'overwrite',
      version: writingTo ?? undefined,
    })
    if (metadataScopeEpoch !== scopeEpoch || slug.value !== projectSlug || episodeId.value !== code) return
    sessionVersion.value = data.version
    // Refresh the version dropdown without re-triggering autosave.
    await suppressAutoSaveDuring(() => loadExistingMetadata({ keepOnError: true }))
    if (metadataScopeEpoch !== scopeEpoch || slug.value !== projectSlug || episodeId.value !== code) return
    selectedVersion.value = data.version
  },
})

let suppressAutoSave = false

async function suppressAutoSaveDuring<T>(fn: () => Promise<T> | T): Promise<T> {
  suppressAutoSave = true
  try { return await fn() } finally {
    // Release on next tick so the watchers triggered by the operation don't fire saves
    await nextTick()
    suppressAutoSave = false
  }
}

watch([() => preview.title, () => preview.description, () => preview.tags], () => {
  if (suppressAutoSave || !episodeId.value) return
  scheduledTarget = { slug: slug.value, code: episodeId.value, title: selectedEpisode.value?.title || '' }
  autoSave.scheduleSave()
}, { deep: true })

// ── Watchers ───────────────────────────────────────────────────────────────

watch([slug, episodeId], async ([projectSlug, code]) => {
  // A pending debounced save belongs to the episode we just left. This runs
  // before the preview is replaced, so flush it now (against its captured
  // episode) instead of letting it fire later and write into the new one.
  if (autoSave.state.value === 'dirty' && scheduledTarget) void autoSave.flush()
  scheduledTarget = null
  sessionVersion.value = null
  metadataScopeEpoch++
  await suppressAutoSaveDuring(async () => {
    blankPreview()
    metadataLoadError.value = ''
    await loadExistingMetadata()
  })
  if (slug.value !== projectSlug || episodeId.value !== code) return
  resetAutoSaveSession()
  void loadFinalizationStatus()
})

// Loading a different version explicitly should also start a new editing
// session, otherwise autosave would silently overwrite the version the
// user just opened with their next keystroke.
watch(selectedVersion, () => {
  sessionVersion.value = null
})

/**
 * v1.0.71+: seed titleConfig / descConfig / tagConfig defaults from the
 * project's effective Format BEFORE preset.load() runs. Out-of-the-box
 * the page hardcoded sleep-story numbers (5000-char description, 5
 * titles, 100-char title cap, 15 tags) — for listicle / educational /
 * kids projects those were wrong but the user had no obvious cue. By
 * pulling format.metadata.defaultMaxChars / defaultTitleCount /
 * defaultTitleMaxLength / defaultTagCount when present, every new
 * project gets sensible starting values without needing to load a
 * saved preset first.
 *
 * If a preset is later applied, its saved values override these
 * format defaults — no behaviour change for users with their own
 * presets. Format-blind formats (custom JSONs that predate the
 * defaults block) fall through to the legacy hardcoded numbers.
 */
async function applyFormatDefaultsIfNoPreset() {
  try {
    const f = await get<any>(`/projects/${slug.value}/effective-format`)
    const meta = f?.metadata
    if (!meta) return
    if (typeof meta.defaultMaxChars === 'number' && meta.defaultMaxChars > 0) {
      descConfig.maxChars = meta.defaultMaxChars
    }
    if (typeof meta.defaultTitleCount === 'number' && meta.defaultTitleCount > 0) {
      titleConfig.count = meta.defaultTitleCount
    }
    if (typeof meta.defaultTitleMaxLength === 'number' && meta.defaultTitleMaxLength > 0) {
      titleConfig.maxLength = meta.defaultTitleMaxLength
    }
    if (typeof meta.defaultTagCount === 'number' && meta.defaultTagCount > 0) {
      tagConfig.count = meta.defaultTagCount
    }
    // v1.0.102+ — hydrate the format's broadKeywords for the Tags
    // placeholder so prayer / motivation / educational channels don't
    // see "sleep story, bedtime story, relaxation" as the example.
    if (Array.isArray(meta.broadKeywords) && meta.broadKeywords.length > 0) {
      formatBroadKeywords.value = meta.broadKeywords.slice(0, 5)
    }
  } catch {
    // Format endpoint unavailable / project missing — keep the legacy
    // hardcoded values (5000 / 5 / 100 / 15). Non-fatal.
  }
}

// v1.0.102+ — format-driven Tags placeholder. Populated from
// format.metadata.broadKeywords; empty array falls back to a generic
// hint.
const formatBroadKeywords = ref<string[]>([])
const tagsPlaceholder = computed<string>(() => {
  if (formatBroadKeywords.value.length > 0) {
    return `Comma-separated tags (e.g. ${formatBroadKeywords.value.join(', ')})`
  }
  return 'Comma-separated tags'
})

// Leaving the page inside the debounce window must not drop the last edit.
onBeforeUnmount(() => {
  if (autoSave.state.value === 'dirty') void autoSave.flush()
})

onMounted(async () => {
  await migrateLegacyMetadataTemplates()
  // Format-aware seeding runs BEFORE preset load. If the user has an
  // active preset, its values override these — but the format defaults
  // are the right starting point for projects with no saved preset yet.
  await applyFormatDefaultsIfNoPreset()
  await metadataPresets.load()
  // Formula defaults intentionally win over historical format/preset
  // templates. They are the channel's publishing contract, not a per-run
  // preference; saved presets remain available for model selection.
  await loadFormulaMetadataProfile()
  await loadMetadataFormulas()
})
</script>

<style scoped>
/* v1.0.298 — generation feedback row (running / success / error / cancelled). */
.meta-result {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  padding: 8px 12px;
  border-radius: var(--radius-md, 6px);
  font-size: 13px;
  border-left: 3px solid var(--border, #444);
  background: var(--bg-tertiary);
}
.meta-result-icon { font-weight: 700; }
.meta-result-running { border-left-color: var(--accent); }
.meta-result-success { border-left-color: var(--success, #5fb37a); }
.meta-result-success .meta-result-icon { color: var(--success, #5fb37a); }
.meta-result-error { border-left-color: var(--danger, #e06c75); }
.meta-result-error .meta-result-icon { color: var(--danger, #e06c75); }
.meta-result-cancelled { border-left-color: var(--warning, #f0c674); }
.meta-result-cancelled .meta-result-icon { color: var(--warning, #f0c674); }
.meta-result-dismiss { margin-left: auto; flex: 0 0 auto; }

.shared-settings { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; padding: 12px 16px; }

.metadata-blueprint { padding: 18px 20px; border-color: color-mix(in srgb, var(--accent) 28%, transparent); background: linear-gradient(120deg, color-mix(in srgb, var(--accent) 9%, transparent), rgba(69, 153, 210, .04)); }
.blueprint-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; }
.blueprint-heading h3 { margin: 3px 0 5px; font-size: 17px; }
.blueprint-heading p { margin: 0; max-width: 720px; line-height: 1.5; }
.blueprint-flow { display: flex; flex-wrap: wrap; gap: 7px; align-items: center; margin-top: 16px; }
.blueprint-step { display: inline-flex; align-items: center; gap: 7px; padding: 6px 10px; border-radius: 999px; color: var(--text-secondary); border: 1px solid var(--border); background: var(--bg-tertiary); font-size: 12px; }
.blueprint-step i { font-style: normal; color: var(--accent); margin-left: 2px; }
.blueprint-meta { display: flex; flex-wrap: wrap; gap: 8px 16px; margin-top: 13px; font-size: 12px; color: var(--text-muted); }
.blueprint-active { color: var(--success, #5fb37a); font-weight: 600; }
@media (max-width: 640px) { .blueprint-heading { flex-direction: column; } }

.shared-settings-label { display: flex; flex-direction: column; gap: 2px; font-size: 13px; font-weight: 600; color: var(--text-secondary); min-width: 110px; }
.shared-settings-control { max-width: 420px; margin: 0; }

.finalizer-readiness { display: flex; flex-direction: column; gap: 12px; }
.finalizer-readiness-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
}
.finalizer-readiness-head h3 { margin: 3px 0 0; }
.finalizer-readiness-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}
.finalizer-readiness-grid > div {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-tertiary);
}
.finalizer-readiness-grid > div[data-tone="success"] strong { color: var(--success); }
.finalizer-readiness-grid > div[data-tone="warning"] strong { color: var(--warning); }
.finalizer-readiness-grid > div[data-tone="info"] strong { color: var(--accent); }
.finalizer-readiness-grid span { color: var(--text-muted); font-size: 12px; }
.finalizer-warning {
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--warning) 42%, transparent);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--warning) 9%, transparent);
  color: var(--text-secondary);
  font-size: 12px;
}
.finalizer-warning strong { color: var(--warning); }
.finalizer-warning ul { margin: 6px 0 0 18px; padding: 0; }
.finalizer-warning li + li { margin-top: 3px; }
.finalizer-ready-copy { margin: 0; color: var(--text-muted); font-size: 12px; }
@media (max-width: 900px) {
  .finalizer-readiness-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

/* Description-area version history dropdown. */
.history-picker { margin-bottom: 0; }
.history-picker .history-label {
  font-size: var(--font-xs);
  display: block;
  margin-bottom: 2px;
}

.card-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; }

/* Char count badge */
.char-count {
  font-size: var(--font-xs);
  color: var(--text-muted);
  font-weight: 400;
  margin-left: 8px;
  font-family: 'SF Mono', monospace;
}
.char-count.over-limit { color: var(--error); font-weight: 600; }

/* Preview */
.preview-textarea {
  width: 100%;
  min-height: 350px;
  font-family: 'SF Mono', Monaco, monospace;
  font-size: 13px;
  line-height: 1.6;
  resize: vertical;
}
.tags-textarea {
  width: 100%;
  min-height: 80px;
  font-size: 13px;
  resize: vertical;
}

.btn-icon {
  background: none; border: none; color: var(--text-muted);
  cursor: pointer; font-size: 14px; padding: 4px 8px; border-radius: 4px;
}
.btn-icon:hover { background: var(--bg-hover); color: var(--text-primary); }
.select-sm { padding: 4px 8px; font-size: 12px; }

</style>
