<template>
  <div>
    <div class="page-header">
      <Breadcrumb />
      <h1 class="page-title">Video Generator</h1>
    </div>

    <!-- v1.0.114 — wrong-pipeline banner for B-Roll formats. The Video
         Generator turns scene images into AI video clips (image-to-video
         via Veo / Sora); broll projects skip image generation entirely,
         so this page has nothing to feed. Banner redirects to B-Roll Video. -->
    <div v-if="isBrollFormat" class="card wrong-pipeline-banner">
      <div class="wpb-icon" aria-hidden="true">🎬</div>
      <div class="wpb-body">
        <div class="wpb-title">This project uses B-Roll, not AI-generated video clips.</div>
        <div class="wpb-text">
          The Video Generator turns scene images into AI video via Veo / Sora —
          but B-Roll formats source video from your stock-footage pool instead.
          Use the <strong>B-Roll Video</strong> page for clip selection and final assembly.
        </div>
        <NuxtLink :to="`/projects/${slug}/broll`" class="btn btn-primary wpb-cta">
          Go to B-Roll Video →
        </NuxtLink>
      </div>
    </div>
    <!-- Live download speed while AI-video clips are streaming back from
         the provider. Veo clips can be hundreds of MB each — this strip
         shows the user where the connection is at. Auto-hides between runs. -->
    <AssetDownloadStrip :job-types="['video', 'video_repair']" />
    <TopActionBar
      :project-slug="slug"
      :presets="videoPresets"
      v-model:episode-id="episodeId"
      filter-field="video"
      generate-label="Generate Videos"
      loading-label="Queuing…"
      :generate-loading="submitting"
      :generate-disabled="!canSubmit"
      :generate-status="videoJobActiveForEpisode ? `Generating video for ${episodeId}…` : scriptGateReason"
      @generate="submitVideo"
      @episode-selected="onEpisodeSelected"
      @preset-applied="success('Preset applied')"
      @preset-saved="success('Preset saved')"
      @preset-deleted="success('Preset deleted')"
    />

    <p class="text-muted mt-1 mb-2">
      Generate AI video clips for your episode. Optional — skip this tab if your episodes are audio-only.
    </p>

    <!-- Model + aspect -->
    <div class="card mt-3">
      <div class="grid-2">
        <div class="form-group">
          <label>Video Model</label>
          <select v-model="form.model" class="select">
            <optgroup v-for="g in videoModelGroups" :key="g.provider" :label="g.label">
              <option v-for="m in g.items" :key="m.id" :value="m.id">
                {{ m.data.label }}
              </option>
            </optgroup>
          </select>
          <span class="text-muted text-xs">
            Supported modes: {{ currentModelModes.join(', ') || '—' }}
          </span>
        </div>
        <div class="form-group">
          <label>Aspect Ratio</label>
          <select v-model="form.aspect_ratio" class="select">
            <option value="landscape">16:9 Landscape</option>
            <option value="portrait">9:16 Portrait</option>
          </select>
        </div>
      </div>

      <div class="grid-2 mt-2">
        <div class="form-group">
          <label>Mode</label>
          <div class="mode-tabs">
            <button
              type="button"
              :class="['mode-tab', { active: form.mode === 'text' }]"
              :disabled="!currentModelModes.includes('text')"
              @click="form.mode = 'text'"
            >Text → Video</button>
            <button
              type="button"
              :class="['mode-tab', { active: form.mode === 'frames' }]"
              :disabled="!currentModelModes.includes('frames')"
              @click="form.mode = 'frames'"
            >Image → Video</button>
          </div>
          <span class="text-muted text-xs">
            Image-to-video uses your generated scene images as the starting frame.
          </span>
        </div>
        <div class="form-group">
          <label>Videos per prompt</label>
          <input v-model.number="form.number_of_videos_per_prompt" type="number" min="1" max="4" class="input input-narrow" />
          <span class="text-muted text-xs">Most models cap at 4.</span>
        </div>
      </div>
    </div>

    <!-- Prompt source -->
    <div class="card mt-2">
      <div class="card-header">
        <h3>Prompt source</h3>
        <p class="text-muted text-sm hint-line">
          <strong>Reuse scene prompts</strong> keeps visual consistency with your stills (best for story cohesion).
          <strong>Dedicated video prompts</strong> adds motion/camera language — more cinematic, less tied to existing scenes.
          <strong>Manual</strong> when you want full control.
        </p>
      </div>

      <div class="source-grid">
        <label class="source-card" :class="{ selected: form.prompt_source === 'scene_prompts' }">
          <input type="radio" v-model="form.prompt_source" value="scene_prompts" />
          <strong>Reuse scene prompts</strong>
          <span>Use the still-image scene prompts already generated for this episode.</span>
        </label>
        <label class="source-card" :class="{ selected: form.prompt_source === 'video_prompts' }">
          <input type="radio" v-model="form.prompt_source" value="video_prompts" />
          <strong>Dedicated video prompts</strong>
          <span>Generate motion/camera-focused prompts tuned for video (separate file).</span>
        </label>
        <label class="source-card" :class="{ selected: form.prompt_source === 'manual' }">
          <input type="radio" v-model="form.prompt_source" value="manual" />
          <strong>Manual prompts</strong>
          <span>Paste your own prompts, one per line.</span>
        </label>
      </div>

      <!-- Dedicated video-prompts generator -->
      <div v-if="form.prompt_source === 'video_prompts'" class="mt-2">
        <div class="flex gap-2 items-center flex-wrap">
          <button class="btn btn-secondary btn-sm" :disabled="!episodeId || generatingPrompts" @click="generateVideoPrompts">
            {{ generatingPrompts ? 'Generating…' : 'Generate video prompts' }}
          </button>
          <input v-model.number="promptsForm.count" type="number" min="1" max="60" class="input input-sm prompt-count-input" title="How many clips" />
          <input v-model="promptsForm.style_hint" class="input input-sm prompt-style-input" placeholder="Style hint (e.g. slow cinematic push-ins)" />
          <div class="prompt-model-select">
            <ModelSelector v-model="promptsForm.model" :project-slug="slug" />
          </div>
        </div>
        <div v-if="generatedPrompts.length" class="prompts-preview mt-2">
          <div v-for="(p, i) in generatedPrompts" :key="i" class="prompt-row">
            <strong>Scene {{ p.number }}: {{ p.title }}</strong>
            <textarea v-model="p.prompt" class="textarea prompt-textarea" />
          </div>
          <button class="btn btn-primary btn-sm mt-2" @click="saveVideoPrompts">💾 Save prompts to episode folder</button>
        </div>
      </div>

      <!-- Manual prompts -->
      <div v-if="form.prompt_source === 'manual'" class="mt-2">
        <label class="section-helper-label">
          One prompt per line. Each line becomes one video.
        </label>

        <!-- Quick-start built-in prompts: curated loopable templates. -->
        <div v-if="builtInVideoPrompts.length" class="flex gap-2 mt-1 mb-2 items-center flex-wrap">
          <span class="text-muted text-xs">Quick-start:</span>
          <button
            v-for="p in builtInVideoPrompts"
            :key="p.id"
            type="button"
            class="btn btn-sm btn-secondary"
            :title="p.hint"
            @click="insertBuiltInPrompt(p)"
          >
            {{ p.label }}
          </button>
        </div>

        <textarea v-model="manualPromptsText" class="textarea manual-prompts-textarea" placeholder="A slow cinematic dolly over a moonlit forest...&#10;A close-up of a hand turning a brass key in an old wooden door..." />
      </div>
    </div>

    <!-- Scene images preview — visible whenever the prompts map 1:1 to -->
    <!-- scene images: image-to-video mode OR text-to-video while reusing -->
    <!-- scene prompts. (Previously hidden in reuse-scene-prompts mode -->
    <!-- even though the mapping is the same.) -->
    <div v-if="form.mode === 'frames' || form.prompt_source === 'scene_prompts'" class="card mt-2">
      <div class="card-header">
        <h3>Scene images</h3>
        <p class="text-muted text-sm">
          {{ sceneImages.length
            ? `${sceneImages.length} image(s) found. Each clip uses the scene image matching its prompt number. Tiles show the scene number; any gaps mean that scene's image is missing and the clip will be skipped.`
            : 'No scene images found. Generate scene images first, or switch to Text → Video mode.' }}
        </p>
      </div>
      <p class="text-muted text-xs scene-images-hint">
        Click the ▶ on any tile to generate <strong>just that scene's clip</strong>, or use
        <strong>Generate Videos</strong> at the top to batch-generate all missing ones (respects the
        concurrency setting in Settings → Performance).
      </p>
      <div v-if="sceneImages.length" class="image-grid">
        <div v-for="img in sceneImages" :key="img.filename" class="image-tile" :title="`Scene ${img.scene_number ?? '?'} — ${img.filename}`">
          <div class="image-thumb">
            <span class="image-scene-num">{{ img.scene_number ?? '?' }}</span>
          </div>
          <span class="image-filename" :title="img.filename">{{ img.filename }}</span>
          <button
            type="button"
            class="btn btn-sm btn-primary scene-gen-btn"
            :disabled="!episodeId || !!sceneJobInFlight[img.filename]"
            :title="sceneJobInFlight[img.filename] ? 'Generating…' : 'Generate this scene only'"
            @click.stop="generateSingleScene(img)"
          >
            <LoadingSpinner v-if="sceneJobInFlight[img.filename]" size="sm" />
            <span v-else aria-hidden="true">▶</span>
            {{ sceneJobInFlight[img.filename] ? 'Queued…' : 'Generate' }}
          </button>
        </div>
      </div>
    </div>

    <!-- Force-regen toggle (primary Generate is in the top banner) -->
    <div class="card mt-2">
      <label class="checkbox-label">
        <input type="checkbox" v-model="form.force" />
        Force regenerate (overwrite existing)
      </label>
    </div>

    <!-- Video integrity pill + Repair. Generators skip existing .mp4s, -->
    <!-- so Repair = re-submit with force=false regenerates only missing. -->
    <div v-if="episodeId" class="card mt-2" aria-labelledby="video-integrity-heading">
      <h3 id="video-integrity-heading" class="integrity-title">Video integrity</h3>
      <p class="text-muted text-sm integrity-blurb">
        Check whether every expected video clip is on disk. <strong>Repair missing</strong>
        queues a job that regenerates only the missing clips (existing clips are skipped).
      </p>

      <div v-if="videoStatus.loading" class="text-muted text-md">
        <LoadingSpinner size="sm" /> Checking…
      </div>
      <div v-else-if="videoStatus.error" class="text-danger text-md">
        {{ videoStatus.error }}
        <button class="btn btn-sm btn-ghost ml-2" @click="refreshVideoStatus">Retry</button>
      </div>
      <div v-else-if="videoStatus.total === 0" class="text-muted text-md">
        No video prompts found for this episode yet. Generate prompts above first.
      </div>
      <div v-else class="flex items-center gap-2 flex-wrap">
        <span class="integrity-pill" :class="videoStatus.missing.length ? 'warn' : 'ok'">
          <template v-if="videoStatus.missing.length === 0">✓ All {{ videoStatus.total }} video clips present</template>
          <template v-else>⚠ {{ videoStatus.missing.length }} of {{ videoStatus.total }} clips missing</template>
        </span>
        <button
          v-if="videoStatus.missing.length > 0"
          class="btn btn-sm btn-secondary"
          :disabled="submitting || videoGenerating || !canSubmit"
          @click="repairMissingVideos"
        >
          Repair missing ({{ videoStatus.missing.length }})
        </button>
        <button class="btn btn-sm btn-ghost" :disabled="videoStatus.loading" @click="refreshVideoStatus">
          Refresh
        </button>
      </div>
      <div v-if="videoStatus.missing.length > 0" class="text-muted text-sm mt-1 missing-list-mono">
        Missing clips: {{ videoStatus.missing.join(', ') }}
      </div>
    </div>

  </div>
</template>

<script setup lang="ts">
definePageMeta({ layout: 'dashboard' })
useAppTitle('Video Generator')

const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { get, post } = useApi()
const { success, error: showError } = useToast()
const { config } = useProject()
const { videoGenerating } = useGenerating()
const { jobs } = useJobs()

const episodeId = ref('')
const submitting = ref(false)
const generatingPrompts = ref(false)

// v1.0.115+ — per-episode "is a video job in flight" computed. The
// global `videoGenerating` (from useGenerating) stays true as long as
// ANY video job is queued/running in the app, so it was leaking the
// "Generating video for [current ep]…" status into pages where the
// current episode wasn't the one actually generating. This narrows it
// to the episode currently selected on THIS page.
const videoJobActiveForEpisode = computed(() => {
  if (!episodeId.value) return false
  return jobs.value.some((j: any) =>
    j.episode_id === episodeId.value &&
    j.project_slug === slug.value &&
    j.type === 'video' &&
    (j.status === 'queued' || j.status === 'running'),
  )
})

// Defensive — clear `submitting` if the user swaps episodes while a POST
// is still in flight (rare; the POST is fast). Matches the symmetrical
// reset in video-assembly.vue / audio-merge.vue / image-prompts.vue.
watch(episodeId, (newEp, oldEp) => {
  if (newEp !== oldEp) submitting.value = false
})
const manualPromptsText = ref('')
const generatedPrompts = ref<Array<{ number: number; title: string; prompt: string }>>([])

const form = reactive({
  model: 'kie-veo3-fast',
  mode: 'text' as 'text' | 'frames',
  aspect_ratio: 'landscape' as 'landscape' | 'portrait',
  number_of_videos_per_prompt: 1,
  prompt_source: 'scene_prompts' as 'scene_prompts' | 'video_prompts' | 'manual',
  force: false,
})

const promptsForm = reactive({
  count: 20,
  style_hint: '',
  model: 'gpt-4o',
})

// Presets for video generation config. Consistent with the other
// generator pages; usePresets auto-excludes episode_id so the preset
// never overwrites whichever episode the user currently has selected.
const videoPresets = usePresets<any>({
  slug: slug.value,
  configKey: 'video_generator',
  snapshot: () => ({ form: { ...form }, promptsForm: { ...promptsForm } }),
  apply: (data) => {
    if (data?.form) Object.assign(form, data.form)
    if (data?.promptsForm) Object.assign(promptsForm, data.promptsForm)
  },
})
/**
 * Format-aware seeding of aspect_ratio BEFORE preset loaders run. The
 * page default 'landscape' is sleep-story / listicle shape (16:9 channels);
 * vertical Shorts-format channels would want 'portrait'. Format JSON
 * declares `script.videoDefaults.aspectRatio` ('landscape' | 'portrait' |
 * 'square'); 'square' has no UI option here and is ignored at the page
 * level (Veo / Sora can't render square anyway today).
 *
 * Saved presets still override these — preset.load() runs after seeding.
 */
// v1.0.114 — wrong-pipeline banner. The Video Generator page generates
// AI video clips from scene images (image-to-video via Veo / Sora). For
// broll formats there are no scene images to feed it — this page would
// just sit empty / fail. Set in applyVideoFormatDefaultsIfNoPreset to
// piggyback on the existing format roundtrip.
const isBrollFormat = ref<boolean>(false)

async function applyVideoFormatDefaultsIfNoPreset() {
  try {
    const f = await get<any>(`/projects/${slug.value}/effective-format`)
    isBrollFormat.value = f?.visualSource === 'broll'
    const v = f?.script?.videoDefaults
    const ar = v?.aspectRatio
    if (ar === 'landscape' || ar === 'portrait') form.aspect_ratio = ar
  } catch {
    // Format endpoint unavailable — keep 'landscape'. Non-fatal.
  }
}

onMounted(async () => {
  await applyVideoFormatDefaultsIfNoPreset()
  await videoPresets.load()
  void loadBuiltInPrompts()
})

// ── Built-in Quick-start prompt presets (e.g. Cozy Campfire Loop) ────────
interface BuiltInVideoPrompt { id: string; label: string; hint: string; prompt: string; category: string }
const builtInVideoPrompts = ref<BuiltInVideoPrompt[]>([])

async function loadBuiltInPrompts() {
  try {
    const data = await get<{ prompts: BuiltInVideoPrompt[] }>(`/projects/${slug.value}/video-prompts/catalog`)
    builtInVideoPrompts.value = data.prompts || []
  } catch { /* tolerate — feature just hides if backend is older */ }
}

function insertBuiltInPrompt(p: BuiltInVideoPrompt) {
  const existing = manualPromptsText.value.trim()
  manualPromptsText.value = existing ? `${existing}\n${p.prompt}` : p.prompt
  success(`Inserted: ${p.label}`)
}

const videoModels = computed(() => (config.value as any)?.video_models || {})
const videoModelGroups = computed(() => groupModels(videoModels.value, (_id, m: any) => m.provider || 'other'))
const currentModelModes = computed<string[]>(() => {
  const m = videoModels.value[form.model]
  return m?.modes || []
})

watch(() => form.model, () => {
  const modes = currentModelModes.value
  if (!modes.includes(form.mode)) form.mode = (modes[0] as any) || 'text'
})

const sceneImages = ref<Array<{ filename: string; scene_number: number | null; path: string }>>([])
async function loadSceneImages() {
  if (!episodeId.value) return
  try {
    const r = await get<{ images: any[] }>(`/projects/${slug.value}/${episodeId.value}/scene-images`)
    sceneImages.value = r.images || []
  } catch {
    sceneImages.value = []
  }
}
watch(() => episodeId.value, loadSceneImages, { immediate: true })

// Video generation reads scene prompts (which require the script first
// for narrative context) AND can pull narration text directly when prompt
// generation is run. Either way the script docx is the upstream
// dependency, so source-of-truth gate via episode.status.script.
const { selectedEpisode, scriptReady, statusKnown } = useEpisodeStatus(episodeId, slug, {
  refetchOnJobTypes: ['script-only'],
})
const noScriptTooltip = 'Generate the script first to unlock this generator.'
// v1.0.296 — gate copy distinguishes "still checking" from "confirmed missing".
const scriptGateReason = computed(() => {
  if (!episodeId.value || scriptReady.value) return ''
  return statusKnown.value ? noScriptTooltip : 'Checking script status…'
})

const canSubmit = computed(() => {
  if (!episodeId.value) return false
  if (!scriptReady.value) return false
  if (form.prompt_source === 'manual' && !manualPromptsText.value.trim()) return false
  if (form.mode === 'frames' && !sceneImages.value.length && form.prompt_source !== 'manual') return false
  return true
})

// Synchronous fast-path so loadSceneImages and other selectedEpisode-
// dependent code see the picked episode before the composable's async
// fetch lands.
function onEpisodeSelected(ep: any) { selectedEpisode.value = ep }

async function generateVideoPrompts() {
  if (!episodeId.value) return
  generatingPrompts.value = true
  try {
    const r = await post<{ scenes: any[] }>(`/projects/${slug.value}/generate/video-prompts`, {
      episode_id: episodeId.value,
      title: selectedEpisode.value?.title || '',
      model: promptsForm.model,
      count: promptsForm.count,
      style_hint: promptsForm.style_hint,
      aspect_ratio: form.aspect_ratio,
    })
    generatedPrompts.value = r.scenes || []
    if (!generatedPrompts.value.length) showError('No prompts returned — try a different model.')
  } catch (e: any) {
    console.error('[video] generate video prompts failed:', e)
    showError(e.data?.detail || `Failed to generate video prompts (model=${promptsForm.model})`)
  } finally {
    generatingPrompts.value = false
  }
}

async function saveVideoPrompts() {
  try {
    await post(`/projects/${slug.value}/generate/video-prompts/save`, {
      episode_id: episodeId.value,
      title: selectedEpisode.value?.title || '',
      prompts: { scenes: generatedPrompts.value },
    })
    success('Video prompts saved!')
  } catch (e: any) {
    console.error('[video] save video prompts failed:', e)
    showError(e.data?.detail || 'Failed to save video prompts to disk')
  }
}

// ── Video integrity pill ────────────────────────────────────────────────
interface VideoStatusState {
  loading: boolean
  error: string
  total: number
  present: number
  missing: number[]
}
const videoStatus = reactive<VideoStatusState>({
  loading: false, error: '', total: 0, present: 0, missing: [],
})

async function refreshVideoStatus() {
  if (!episodeId.value) return
  videoStatus.loading = true
  videoStatus.error = ''
  try {
    const r = await get<any>(`/projects/${slug.value}/episodes/${episodeId.value}/video-status`)
    videoStatus.total = r.total ?? 0
    videoStatus.present = r.present ?? 0
    videoStatus.missing = r.missing ?? []
  } catch (e: any) {
    videoStatus.error = e?.data?.detail || e?.message || 'Could not check video integrity'
  } finally {
    videoStatus.loading = false
  }
}

async function repairMissingVideos() {
  // Calls the dedicated repair endpoint (not the generation endpoint).
  // The reconciler downloads from already-paid-for provider task records
  // and never re-submits the prompt — zero credit cost.
  //
  // Clips without a stored task id (generated before recordTask was wired
  // up, or never generated at all) come back as `no_manifest` in the job
  // log, telling the user to click Generate for those specific items
  // instead of silently re-billing them.
  submitting.value = true
  try {
    await post(`/projects/${slug.value}/generate/video-repair`, { episode_id: episodeId.value })
    success(`Repair job queued — recovers from provider history (no credit cost). Check the Jobs tab.`)
    videoGenerating.value = true
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to queue repair')
  } finally {
    submitting.value = false
  }
}

watch(() => episodeId.value, (v) => { if (v) refreshVideoStatus() }, { immediate: true })

async function submitVideo() {
  if (!canSubmit.value) return
  submitting.value = true
  try {
    const body: any = {
      episode_id: episodeId.value,
      title: selectedEpisode.value?.title || '',
      model: form.model,
      mode: form.mode,
      aspect_ratio: form.aspect_ratio,
      number_of_videos_per_prompt: form.number_of_videos_per_prompt,
      prompt_source: form.prompt_source,
      force: form.force,
    }
    if (form.prompt_source === 'manual') {
      body.manual_prompts = manualPromptsText.value.split('\n').map(s => s.trim()).filter(Boolean)
    }
    await post(`/projects/${slug.value}/generate/video`, body)
    success('Queued! Follow progress in the Jobs tab.')
    videoGenerating.value = true
  } catch (e: any) {
    // Surface which prompt-source path broke — debugging "video failed"
    // is otherwise a guessing game when the backend's path branches on
    // scene_prompts vs video_prompts vs manual.
    const sourceLabel = form.prompt_source === 'scene_prompts' ? 'scene prompts'
      : form.prompt_source === 'video_prompts' ? 'video prompts'
      : 'manual prompts'
    console.error(`[video] queue failed (source=${form.prompt_source}):`, e)
    showError(e.data?.detail || `Failed to queue video generation (${sourceLabel})`)
  } finally {
    submitting.value = false
  }
}

// ── Per-scene generation (pain-point: force-all was the only option) ─────
// Uses the existing `scene_image_filenames` filter on GenerateVideoRequest
// to constrain the batch to one prompt. Zero backend changes required.
const sceneJobInFlight = reactive<Record<string, boolean>>({})
async function generateSingleScene(img: { filename: string; path: string; scene_number: number | null }) {
  if (!episodeId.value) {
    showError('Pick an episode first')
    return
  }
  if (sceneJobInFlight[img.filename]) return
  sceneJobInFlight[img.filename] = true
  try {
    const body: any = {
      episode_id: episodeId.value,
      title: selectedEpisode.value?.title || '',
      model: form.model,
      mode: form.mode,
      aspect_ratio: form.aspect_ratio,
      number_of_videos_per_prompt: form.number_of_videos_per_prompt,
      prompt_source: form.prompt_source,
      force: form.force,
      // Backend filter that short-circuits the loop to just this scene.
      scene_image_filenames: [img.filename],
    }
    if (form.prompt_source === 'manual') {
      body.manual_prompts = manualPromptsText.value.split('\n').map(s => s.trim()).filter(Boolean)
    }
    await post(`/projects/${slug.value}/generate/video`, body)
    success(`Queued scene ${img.scene_number ?? img.filename}`)
    videoGenerating.value = true
    // Keep the spinner up for a beat so the UX feels responsive; the jobs
    // SSE stream will flip the overall videoGenerating state once the job
    // actually starts running.
    setTimeout(() => { sceneJobInFlight[img.filename] = false }, 2000)
  } catch (e: any) {
    showError(e.data?.detail || 'Failed to queue single-scene generation')
    sceneJobInFlight[img.filename] = false
  }
}
</script>

<style scoped>
/* v1.0.114 — Wrong-pipeline banner (same visual treatment as video-assembly.vue). */
.wrong-pipeline-banner {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  margin: 12px 0 16px;
  padding: 14px 16px;
  border-left: 3px solid #6ea8fe;
  background: rgba(110, 168, 254, 0.08);
}
.wpb-icon { font-size: 22px; line-height: 1; padding-top: 2px; }
.wpb-body { flex: 1; min-width: 0; }
.wpb-title { font-weight: 600; font-size: 14px; margin-bottom: 4px; }
.wpb-text { font-size: 13px; line-height: 1.5; color: var(--text-secondary, #b3b3bb); margin-bottom: 10px; }
.wpb-text strong { color: var(--text-primary, #e8e8ea); }
.wpb-cta { font-size: 13px; }

/* Form-field width tokens. */
.input-narrow { max-width: 120px; }

/* Helper line that hangs directly under an input. */
.hint-line { margin-top: 4px; }

/* "section helper" small label above an array of inputs. */
.section-helper-label {
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 8px;
  display: block;
}

/* Inline form for the "Generate video prompts" row. */
.prompt-count-input { max-width: 90px; }
.prompt-style-input { flex: 1; min-width: 200px; }
.prompt-model-select { max-width: 220px; }

/* Per-prompt textarea (one row per generated scene prompt). */
.prompt-textarea { min-height: 60px; font-size: 12px; }

/* Manual-prompts paste box. */
.manual-prompts-textarea { min-height: 140px; font-size: 13px; }

/* Hint paragraph immediately above the scene-image grid. */
.scene-images-hint { margin: 4px 0 10px; }

/* Integrity card title and blurb (mirrors images.vue). */
.integrity-title { margin-bottom: 6px; }
.integrity-blurb { margin-bottom: 10px; }

/* Monospace listing of missing clip filenames. */
.missing-list-mono { font-family: var(--font-mono, monospace); }

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

.mode-tabs {
  display: flex;
  gap: 4px;
  background: var(--bg-tertiary);
  border-radius: var(--radius-sm);
  padding: 3px;
}
.mode-tab {
  flex: 1;
  padding: 8px 14px;
  background: transparent;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-family: inherit;
  font-size: 13px;
  border-radius: var(--radius-sm);
  transition: all 0.15s;
}
.mode-tab.active {
  background: var(--accent);
  color: #0f1117;
  font-weight: 500;
}
.mode-tab:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.source-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}
.source-card {
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 14px;
  cursor: pointer;
  transition: all 0.15s;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.source-card:hover { border-color: var(--border-light); }
.source-card.selected {
  border-color: var(--accent);
  background: var(--accent-dim);
}
.source-card input[type="radio"] { display: none; }
.source-card strong { font-size: 13px; color: var(--text-primary); }
.source-card span { font-size: 11px; color: var(--text-muted); line-height: 1.4; }
@media (max-width: 900px) {
  .source-grid { grid-template-columns: 1fr; }
}

.prompts-preview { display: flex; flex-direction: column; gap: 10px; }
.prompt-row {
  background: var(--bg-tertiary);
  border-radius: var(--radius-sm);
  padding: 10px;
}
.prompt-row strong { font-size: 12px; color: var(--accent); display: block; margin-bottom: 4px; }

.image-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 10px;
}
.image-tile { display: flex; flex-direction: column; gap: 4px; align-items: stretch; }
.scene-gen-btn { padding: 4px 8px; font-size: 11px; justify-content: center; }
.image-thumb {
  aspect-ratio: 16 / 9;
  background: #1a1d27;
  border-radius: var(--radius-sm);
  display: flex;
  align-items: center;
  justify-content: center;
}
.image-scene-num {
  font-size: 20px;
  color: var(--accent);
  font-weight: 600;
}
.image-filename {
  font-size: 10px;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.checkbox-label { display: flex; align-items: center; gap: 6px; font-size: 13px; cursor: pointer; color: var(--text-muted); }

.generating-status { display: flex; flex-direction: column; gap: 4px; }
.gen-label { font-size: 12px; color: var(--accent); }
.progress-bar { height: 3px; background: var(--bg-tertiary); border-radius: 2px; overflow: hidden; }
.progress-fill { height: 100%; background: var(--accent); border-radius: 2px; animation: progressIndeterminate 1.5s ease-in-out infinite; }
@keyframes progressIndeterminate { 0% { width: 0%; margin-left: 0; } 50% { width: 60%; margin-left: 20%; } 100% { width: 0%; margin-left: 100%; } }

.input-sm { padding: 6px 10px; font-size: 13px; }
</style>
