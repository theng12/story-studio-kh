<template>
  <div>
    <div class="page-header">
      <Breadcrumb />
      <h1 class="page-title">Audio Generator</h1>
    </div>
    <!-- Live TTS download speed while voice bytes are streaming back from
         ElevenLabs / fal / GenAIPro. Auto-hides between runs. -->
    <AssetDownloadStrip :job-types="['audio']" />
    <TopActionBar
      :project-slug="slug"
      :presets="audioPresets"
      v-model:episode-id="form.episode_id"
      filter-field="audio"
      generate-label="Generate Audio"
      loading-label="Queuing…"
      :generate-loading="submitting || audioJobActiveForEpisode"
      :generate-disabled="!form.episode_id || !scriptReady || !form.voice"
      :generate-status="audioJobActiveForEpisode ? `Generating audio for ${form.episode_id}…` : (scriptGateReason || (!form.voice ? 'Pick a voice first — there is no default.' : ''))"
      @generate="submit"
      @preset-applied="success('Preset applied')"
      @preset-saved="success('Preset saved')"
      @preset-deleted="success('Preset deleted')"
    >
      <template #actions>
        <EpisodeImportButton
          :slug="slug"
          :episode-code="form.episode_id"
          default-tab="audio"
          @imported="refreshAudioStatus"
        />
      </template>
    </TopActionBar>

    <!-- v1.0.78 — inline "Rescan from disk" affordance.
         Surfaces only when an episode is selected but scriptReady is false,
         which happens after iCloud delivers the script docx without the
         parent folder's mtime bumping (cache stays stale). One click fires
         a full project rescan and re-fetches the episode's status. -->
    <div v-if="form.episode_id && statusKnown && !scriptReady" class="rescan-hint mt-1">
      <span class="text-muted text-xs">
        No script detected for <strong>{{ form.episode_id }}</strong> —
        if it's actually on disk (e.g. just delivered by iCloud), force a re-check:
      </span>
      <button
        type="button"
        class="btn btn-link btn-xs"
        :disabled="rescanning"
        title="Wipe this project's status cache and re-stat every episode folder. Fixes the iCloud case where a synced docx didn't bump the parent folder's mtime."
        @click="onRescan"
      >
        {{ rescanning ? '↻ Rescanning…' : '↻ Rescan from disk' }}
      </button>
    </div>

    <p class="text-muted mt-1 mb-2">Generate TTS narration audio via fal.ai (ElevenLabs) or GenAIPro.</p>

    <div class="card mt-3">
      <div class="grid-2">
        <div class="form-group">
          <label>TTS Model <span class="required" aria-hidden="true">*</span></label>
          <select v-model="form.model" class="select">
            <optgroup v-for="g in audioModelGroups" :key="g.provider" :label="g.label">
              <option v-for="m in g.items" :key="m.id" :value="m.id">
                {{ m.data.label }} {{ m.data.cost_per_1k_chars > 0 ? `($${m.data.cost_per_1k_chars}/1K chars)` : '(Free · local)' }}
              </option>
            </optgroup>
          </select>
        </div>
      </div>

      <div class="form-group">
        <label>Voice</label>
        <div class="voice-row">
          <!-- Fish Audio has no curated voice catalogue — voices are
               reference_ids (your cloned voice, or any model id from
               fish.audio), so we surface a free-text field instead of the
               ElevenLabs-style picker. -->
          <input
            v-if="currentAudioProvider === 'fishaudio'"
            v-model.trim="form.voice"
            type="text"
            class="input voice-picker-flex"
            placeholder="Fish reference ID — e.g. c332dba836014c85903124a522991138"
            spellcheck="false"
            autocapitalize="off"
            autocorrect="off"
          />
          <VoicePicker
            v-else
            v-model="form.voice"
            :project-slug="slug"
            :custom-voices="config?.voice_presets || []"
            :audio-model-provider="currentAudioProvider"
            :audio-model-id="form.model"
            require-selection
            class="voice-picker-flex"
            @preview="previewVoiceId"
            @voice-saved="refreshConfig(slug)"
          />
          <button
            v-if="currentAudioProvider === 'fishaudio'"
            type="button"
            class="btn btn-sm btn-ghost"
            :disabled="!form.voice || previewing"
            :title="!form.voice ? 'Paste a reference ID first' : 'Preview this voice'"
            @click="previewVoiceId()"
          >
            {{ previewing ? '…' : '▶ Preview' }}
          </button>
          <button
            v-if="previewAudio"
            type="button"
            class="btn btn-sm btn-ghost"
            aria-label="Stop preview"
            @click="stopPreview"
          >
            ■ Stop
          </button>
        </div>
        <span class="text-muted text-xs">
          <template v-if="currentAudioProvider === 'fishaudio'">
            Paste a Fish Audio <strong>reference ID</strong> — your cloned voice, or any model id from
            <a href="https://fish.audio" target="_blank" rel="noopener">fish.audio</a>.
            Speed maps to Fish prosody; Stability / Similarity don’t apply.
          </template>
          <template v-else>
            Click ▶ next to any voice for a 1-sentence preview. ★ to pin favourites to the top (per-project).
            Hit <strong>Refresh</strong> inside the picker to pull the latest voices from ElevenLabs.
          </template>
        </span>
      </div>

      <!-- Section selector replaces the old free-text "Sections" input.
           Status pills + duplicate prevention live inside the component.
           `allow-duplicates` is now derived from `generation_mode` instead
           of being its own toggle (M6 unification). -->
      <AudioChapterSelector
        v-if="form.episode_id"
        :project-slug="slug"
        :episode-id="form.episode_id"
        v-model:selected="form.sections"
        :allow-duplicates="form.generation_mode !== 'skip'"
        :refresh-key="audioStatus.total"
        @update:effective-selected="onEffectiveSelectionChange"
      />

      <div class="grid-3">
        <div class="form-group">
          <label>Speed ({{ form.speed.toFixed(2) }}) <span class="field-hint">Playback pace</span></label>
          <SliderWithNumber v-model="form.speed" :min="0.5" :max="2" :step="0.01" :decimals="2" />
          <p class="text-muted text-xs hint-line">
            ElevenLabs recommends <strong>0.95–1.05</strong> for natural narration. Below 0.9 can sound sluggish; above 1.1 rushes the delivery.
          </p>
        </div>
        <div class="form-group">
          <label>Stability ({{ form.stability.toFixed(2) }}) <span class="field-hint">Higher = less variation</span></label>
          <SliderWithNumber v-model="form.stability" :min="0" :max="1" :step="0.01" :decimals="2" />
          <p class="text-muted text-xs hint-line">
            Sleep-story default <strong>0.50–0.65</strong>. Higher = more consistent tone; lower = more expressive but risk of drift on long reads.
          </p>
        </div>
        <div class="form-group">
          <label>Similarity ({{ form.similarity.toFixed(2) }}) <span class="field-hint">Voice cloning closeness</span></label>
          <SliderWithNumber v-model="form.similarity" :min="0" :max="1" :step="0.01" :decimals="2" />
          <p class="text-muted text-xs hint-line">
            Default <strong>0.75</strong>. Higher sticks closer to the reference voice; too high (&gt;0.9) amplifies background artifacts in the original sample.
          </p>
        </div>
      </div>

      <!-- v1.0.314 — Chunk size: read-only display for ALL providers. The cap
           controls how a long section is split into per-API-call chunks (then
           re-stitched). The per-model value is set in Settings → Audio Models
           so the Audio Generator can never accidentally ship a wrong value
           (which was the v1.0.313 bug — a hidden local-only override leaking
           into cloud runs). Cloud + local both surface it the same way now. -->
      <div v-if="form.model" class="form-group mb-2">
        <label>Chunk size <span class="field-hint">— characters per TTS call</span></label>
        <div class="chunk-display" :title="chunkSizeTooltip">
          <span class="chunk-value">
            <template v-if="resolvedChunkCap">
              {{ resolvedChunkCap.toLocaleString() }} chars
              <span class="text-muted text-xs"> · ≈ {{ formatChunkSeconds(resolvedChunkCap) }} of audio</span>
            </template>
            <template v-else>
              <span class="text-muted">auto</span>
              <span class="text-muted text-xs"> · chunker default ≈4,800 chars (≈5 min)</span>
            </template>
          </span>
          <NuxtLink :to="`/projects/${slug}/settings#audio-models`" class="link-btn chunk-link" title="Open Settings → Audio Models to configure the per-model chunk cap.">
            Configure in Settings ↗
          </NuxtLink>
        </div>
        <p class="text-muted text-xs hint-line">
          The script is split at sentence boundaries within this cap, then the
          per-chunk audio files are re-stitched. Suggested per provider:
          ElevenLabs / GenAIPro / fal ≈ 3,000–4,800;
          Kokoro 3,000+;
          VoxCPM2 500–600 (cloned voice drifts after ~30s);
          Chatterbox 1,000.
        </p>
      </div>

      <!-- Generation Mode (M6): single tri-state replaces the previous
           pair of `force` + `no_overwrite` checkboxes. The form still
           sends those booleans to the backend (translated at submit
           time) so generators/audio.ts is unchanged. -->
      <div class="form-group mb-2">
        <label>Generation Mode</label>
        <div class="generation-mode-row">
          <label class="generation-mode-option">
            <input type="radio" value="skip" v-model="form.generation_mode" />
            <div>
              <strong>Skip existing</strong>
              <span class="text-muted">Don't regenerate sections that already have audio on disk.</span>
            </div>
          </label>
          <label class="generation-mode-option">
            <input type="radio" value="regenerate" v-model="form.generation_mode" />
            <div>
              <strong>Regenerate</strong>
              <span class="text-muted">Overwrite existing chunks in place.</span>
            </div>
          </label>
          <label class="generation-mode-option">
            <input type="radio" value="new_version" v-model="form.generation_mode" />
            <div>
              <strong>New version</strong>
              <span class="text-muted">Keep previous chunks; write fresh ones as _v2, _v3…</span>
            </div>
          </label>
        </div>
      </div>

    </div>

    <!-- Asset reconciliation: status pill + Repair button (per-episode). -->
    <!-- Only shown once an episode is selected. `Repair` scans GenAIPro's -->
    <!-- task history for completed tasks whose audio never made it back -->
    <!-- to disk (usually due to client-side timeouts). GenAIPro keeps -->
    <!-- history for ~1 day so this is time-sensitive after a failed batch. -->
    <div v-if="form.episode_id" class="card mt-2" aria-labelledby="audio-integrity-heading">
      <h3 id="audio-integrity-heading" class="integrity-title">Audio integrity</h3>
      <p class="text-muted text-sm integrity-blurb">
        Check whether every expected audio chunk is on disk. If GenAIPro
        completed tasks but the download was lost (e.g. 5-minute client
        timeout), <strong>Repair missing</strong> re-fetches them from
        GenAIPro's task history.
      </p>

      <div v-if="audioStatus.loading" class="text-muted text-md">
        <LoadingSpinner size="sm" /> Checking…
      </div>

      <div v-else-if="audioStatus.error" class="text-danger text-md">
        {{ audioStatus.error }}
        <button class="btn btn-sm btn-ghost ml-2" @click="refreshAudioStatus">Retry</button>
      </div>

      <div v-else-if="audioStatus.total === 0" class="text-muted text-md">
        No audio chunks expected for this episode yet. Generate the script first,
        then the system will know what to check.
      </div>

      <div v-else class="flex items-center gap-2 flex-wrap">
        <span
          class="integrity-pill"
          :class="audioStatus.missing === 0 ? 'ok' : 'warn'"
        >
          <template v-if="audioStatus.missing === 0">
            ✓ All {{ audioStatus.total }} audio chunks present
          </template>
          <template v-else>
            ⚠ {{ audioStatus.missing }} of {{ audioStatus.total }} chunks missing
          </template>
        </span>

        <button
          v-if="audioStatus.missing > 0"
          class="btn btn-sm btn-secondary"
          :disabled="repairing"
          @click="runRepair"
        >
          <LoadingSpinner v-if="repairing" size="sm" />
          {{ repairing ? 'Repairing…' : `Repair missing (${audioStatus.missing})` }}
        </button>

        <button class="btn btn-sm btn-ghost" :disabled="audioStatus.loading || repairing" @click="refreshAudioStatus">
          Refresh
        </button>
      </div>

      <!-- Result summary after a repair run. Surface logs so the user can -->
      <!-- see exactly which files were recovered vs still missing. -->
      <div v-if="repairResult" class="repair-result mt-2">
        <div class="repair-summary" :class="repairResult.still_missing === 0 ? 'ok' : 'warn'">
          Recovered <strong>{{ repairResult.recovered }}</strong> /
          {{ repairResult.recovered + repairResult.still_missing }} missing chunk(s).
          <span v-if="repairResult.still_missing > 0">
            {{ repairResult.still_missing }} still missing — they may be outside
            GenAIPro's 1-day history window, or were generated with a different
            provider. You'll need to re-generate those manually.
          </span>
        </div>
        <details class="mt-1">
          <summary class="repair-details-summary">Details ({{ repairResult.logs.length }} log lines)</summary>
          <pre class="repair-log">{{ repairResult.logs.join('\n') }}</pre>
        </details>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ layout: 'dashboard' })
useAppTitle('Audio Generator')
const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { post, get } = useApi()
const { project, config, refreshConfig } = useProject()

// v1.0.203+ — which Voice Studio engines the live modal can actually run.
// Every voicestudio-* model is registered in the catalog so generation +
// preview work, but we only SHOW the ones the modal reports available — so
// the dropdown is dynamic: spin up Chatterbox/Qwen3 on the modal and it
// appears here with zero app changes. `null` = not probed yet; `ok:false`
// = modal offline → we fall back to showing every registered engine.
const vsAvailable = ref<{ ok: boolean; ids: Set<string> } | null>(null)
async function loadVoicestudioModels() {
  try {
    const data = await get<{ ok: boolean; models: { id: string }[] }>(`/voicestudio/models`)
    vsAvailable.value = { ok: !!data.ok, ids: new Set((data.models || []).map(m => m.id)) }
  } catch {
    vsAvailable.value = { ok: false, ids: new Set() }
  }
}

// The audio_models catalog with unavailable Voice Studio engines hidden.
// Cloud models are never touched. Only filters when we have a definitive
// OK probe; otherwise everything shows (never strand the user with an
// empty/short dropdown because the modal blipped).
const visibleAudioModels = computed<Record<string, any>>(() => {
  const all = (config.value?.audio_models || {}) as Record<string, any>
  const probe = vsAvailable.value
  // Show everything when the probe isn't definitive (not run / modal offline)
  // OR when it reports ZERO ready engines. v1.0.275 — the empty case used to
  // hide the WHOLE Voice Studio provider (a reachable modal that reports no
  // engine "ready" → local TTS vanished from the dropdown). Hiding the entire
  // provider never helps; only narrow down when the modal positively lists a
  // non-empty ready set (then trust it and hide the rest).
  if (!probe || !probe.ok || probe.ids.size === 0) return all
  const out: Record<string, any> = {}
  for (const [id, m] of Object.entries(all)) {
    const isVoiceStudio = resolveAudioProvider(id, m) === 'voicestudio'
    if (isVoiceStudio && !probe.ids.has(id)) continue
    out[id] = m
  }
  return out
})

// Group the audio model catalog by TTS provider for the dropdown.
const audioModelGroups = computed(() =>
  groupModels<any>(visibleAudioModels.value, (id, m) => resolveAudioProvider(id, m)),
)

// v1.0.157 — `currentAudioProvider` computed + the cross-source voice
// reset watcher moved BELOW the `form = reactive({...})` declaration
// further down. v1.0.150 placed them here and v1.0.151-156 piled
// further changes on top, but neither version actually touched the
// audio page — the TDZ error stayed latent. `watch(currentAudioProvider, …)`
// triggers Vue's dependency tracker, which calls the computed getter
// once at setup() to register the source — and the getter reads
// `form.model`, which throws ReferenceError because `form` (a `const`)
// isn't initialized yet at this point in the script-setup body. Entire
// setup() unwinds → blank Audio Generator page.

const { success, info: showInfo, error: showError } = useToast()
const { audioGenerating } = useGenerating()
const { confirmGeneration } = useConfirmation()
const { jobs } = useJobs()
const submitting = ref(false)

const form = reactive({
  episode_id: '',
  model: 'turbo-v2.5',
  voice: null as string | null,
  // Empty by default — AudioChapterSelector auto-fills with missing sections
  // once an episode is picked. submit() falls back to 'all' if nothing is
  // selected, preserving the original one-click flow.
  sections: '',
  speed: 0.93,
  stability: 1.0,
  similarity: 1.0,
  // v1.0.314 — the per-job chunk override field is gone. The chunk cap is
  // configured per-model in Settings → Audio Models (tts_soft_max_chars) and
  // surfaced read-only on this page so it can't be tweaked here. Kept as a
  // null field so legacy presets / remembered-form entries that still carry
  // it don't crash — it just never gets a value into payload (always stripped
  // at submit). Safe to remove this line once no v1.0.313-or-older presets
  // remain in the wild.
  max_chunk_chars: null as number | null,
  // Unified Generation Mode (M6). Submit translates this into the backend's
  // existing { force, no_overwrite } pair. Default 'skip' matches the old
  // default behaviour (force=false, no_overwrite=false).
  generation_mode: 'skip' as 'skip' | 'regenerate' | 'new_version',
})

// v1.0.259 — remember the voice + tuning across reloads. `sections` is
// episode-specific (auto-filled with that episode's missing sections), so it's
// left out of the allowlist. A restored voice that's incompatible with the
// restored model is reconciled by VoicePicker on load.
useRememberedForm('audio', slug, form, {
  // v1.0.314 — max_chunk_chars removed from the allowlist. It's no longer
  // user-settable on this page (per-model cap lives in Settings), so there's
  // nothing to remember.
  include: ['model', 'voice', 'speed', 'stability', 'similarity', 'generation_mode'],
})

// v1.0.150+ — resolve the provider of the currently-picked audio model so
// the VoicePicker can surface the right voice section. Cloud providers
// (elevenlabs / fal / genaipro) all share the ElevenLabs voice id space;
// 'voicestudio' has its own UUID space, so the picker uses this signal
// to gate which voices are compatible. Empty string means "no model yet"
// → picker shows everything.
//
// v1.0.157 — moved BELOW the `form = reactive({...})` declaration. See
// the placeholder comment above where this used to live (line ~250).
const currentAudioProvider = computed<string>(() => {
  if (!form.model) return ''
  const entry = config.value?.audio_models?.[form.model] as any
  return resolveAudioProvider(form.model, entry || {})
})

// v1.0.314 — the per-model chunk cap (Settings → Audio Models → Max chunk
// chars). Null = use the chunker default (~4800). Surfaced read-only in the
// form so the user knows exactly what's about to be sent to the TTS API.
const resolvedChunkCap = computed<number | null>(() => {
  if (!form.model) return null
  const entry = config.value?.audio_models?.[form.model] as any
  const cap = Number(entry?.tts_soft_max_chars)
  return Number.isFinite(cap) && cap > 0 ? Math.round(cap) : null
})
function formatChunkSeconds(chars: number): string {
  // ~15 chars/sec narration pace (English audiobook average).
  const sec = Math.round(chars / 15)
  if (sec < 90) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return s ? `${m}m ${s}s` : `${m} min`
}
const chunkSizeTooltip = computed(() => resolvedChunkCap.value
  ? `Set per-model in Settings → Audio Models. The script is split at sentence boundaries within ${resolvedChunkCap.value.toLocaleString()} chars per TTS call.`
  : 'No per-model cap set — the chunker uses its ~4,800-char default. Set a value in Settings → Audio Models to make the chunk size explicit.')

// v1.0.207+ — voice/model compatibility reconciliation now lives inside
// VoicePicker (it has the catalogue + Voice Studio voice lists to judge
// against). On a model change it keeps the voice if it's still usable and
// clears + toasts only when it genuinely isn't — so loading a saved preset
// no longer silently wipes a Voice Studio voice (the old coarse cloud↔local
// watcher here did exactly that).

// v1.0.115+ — per-episode "is an audio job in flight" computed. The
// global `audioGenerating` (from useGenerating) stays true as long as
// ANY audio job is queued/running in the app, so its status text was
// leaking into pages where the current episode wasn't the one actually
// generating. This narrows it to the episode currently selected here.
const audioJobActiveForEpisode = computed(() => {
  if (!form.episode_id) return false
  return jobs.value.some((j: any) =>
    j.episode_id === form.episode_id &&
    j.project_slug === slug.value &&
    j.type === 'audio' &&
    (j.status === 'queued' || j.status === 'running'),
  )
})

// Defensive — clear `submitting` on episode swap.
watch(() => form.episode_id, (newEp, oldEp) => {
  if (newEp !== oldEp) submitting.value = false
})

// Audio generation parses the narration .docx to know what sections to
// chunk. No script → nothing to generate. Source-of-truth gating via
// episode.status.script (refetched whenever a script-only job finishes).
// v1.0.78 — pull `refetch` too so the inline "Rescan from disk" handler
// can re-pull the episode's status after wiping the project cache.
const { scriptReady, statusKnown, refetch: refetchEpisodeStatus } = useEpisodeStatus(
  computed(() => form.episode_id),
  slug,
  { refetchOnJobTypes: ['script-only'] },
)
// v1.0.296 — gate copy distinguishes "still checking" from "confirmed missing".
const scriptGateReason = computed(() => {
  if (!form.episode_id || scriptReady.value) return ''
  return statusKnown.value ? noScriptTooltip : 'Checking script status…'
})

// v1.0.78 — inline rescan-from-disk affordance. Hits the existing
// /episodes?rescan=1 server-side path which calls
// episodeStatusCache.wipeProject(slug) — drops in-memory + on-disk cache,
// then re-stats every episode. After the rescan, re-fetch THIS episode's
// status so the disabled Generate button enables without a page refresh.
const rescanning = ref(false)
async function onRescan() {
  if (rescanning.value || !form.episode_id) return
  rescanning.value = true
  try {
    await get(`/projects/${slug.value}/episodes?rescan=1`)
    await refetchEpisodeStatus()
    if (scriptReady.value) {
      success(`Script detected for ${form.episode_id} — you can generate audio now.`)
    } else {
      showInfo(`Still no script for ${form.episode_id}. Generate it in the Scripts page first.`)
    }
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Rescan failed')
  } finally {
    rescanning.value = false
  }
}
const noScriptTooltip = 'Generate the script first to unlock this generator.'

// ── Presets ─────────────────────────────────────────────────────────────
const audioPresets = usePresets<any>({
  slug: slug.value,
  configKey: 'audio_generator',
  snapshot: () => ({ form: { ...form } }),
  apply: (data) => { if (data?.form) Object.assign(form, data.form) },
})

/**
 * Format-aware seeding of TTS knobs BEFORE preset loaders run. Defaults
 * shipped with the page (0.93× / 1.0 / 1.0) are sleep-story-flavoured —
 * fine for the original use case, wrong for listicle / explainer channels
 * where a 1.0× pace and looser stability/similarity reads more naturally.
 * Format JSON declares `script.audioDefaults`; absent → fall through to the
 * existing hardcoded values, so formats that haven't opted in see no change.
 *
 * Saved presets still override these — preset.load() runs after, so users
 * with their own presets keep their own values. The seeding only matters
 * for fresh projects with no preset applied yet.
 */
async function applyAudioFormatDefaultsIfNoPreset() {
  try {
    const f = await get<any>(`/projects/${slug.value}/effective-format`)
    const a = f?.script?.audioDefaults
    if (!a) return
    if (typeof a.speed === 'number' && a.speed > 0) form.speed = a.speed
    if (typeof a.stability === 'number' && a.stability >= 0 && a.stability <= 1) {
      form.stability = a.stability
    }
    if (typeof a.similarity === 'number' && a.similarity >= 0 && a.similarity <= 1) {
      form.similarity = a.similarity
    }
  } catch {
    // Format endpoint unavailable / project missing — keep the legacy
    // hardcoded sleep-story values. Non-fatal.
  }
}

onMounted(async () => {
  await applyAudioFormatDefaultsIfNoPreset()
  await audioPresets.load()
  void loadVoicestudioModels()
})

// Effective section list = what the AudioChapterSelector says to actually
// queue (selection minus already-generated when duplicate override is off).
// We submit this instead of `form.sections` so the duplicate-prevention
// promise the UI makes is honoured at the request boundary.
const effectiveSections = ref<string[]>([])
function onEffectiveSelectionChange(slugs: string[]) {
  effectiveSections.value = slugs
}

// ── Voice preview ──────────────────────────────────────────────────────
const previewing = ref(false)
const previewAudio = ref<HTMLAudioElement | null>(null)

/**
 * Previews an arbitrary voice id. Called both from the VoicePicker's
 * per-row ▶ button (with `voiceId` passed in) and from any legacy code
 * that wants to preview the currently-selected voice (no argument).
 */
async function previewVoiceId(voiceId?: string) {
  const id = voiceId || form.voice
  if (!id) {
    showError('Select a voice first')
    return
  }
  stopPreview()
  previewing.value = true
  try {
    const resp = await post<any>(`/projects/${slug.value}/preview-voice`, {
      voice_id: id,
      model: form.model,
      speed: form.speed,
      stability: form.stability,
      similarity: form.similarity,
    })
    if (resp?.audio_url) {
      const audio = new Audio(resp.audio_url)
      previewAudio.value = audio
      audio.addEventListener('ended', () => { previewAudio.value = null })
      await audio.play()
    }
  } catch (e: any) {
    console.error(`[audio] voice preview failed (voice=${id}, model=${form.model}):`, e)
    showError(e.data?.detail || `Voice preview failed for ${id}. Check your TTS provider key in Settings.`)
  } finally {
    previewing.value = false
  }
}

function stopPreview() {
  if (previewAudio.value) {
    previewAudio.value.pause()
    previewAudio.value.currentTime = 0
    previewAudio.value = null
  }
}

onUnmounted(() => { stopPreview() })

// ── Audio integrity (status pill + Repair) ─────────────────────────────
// Fetches the asset-status endpoint whenever the selected episode changes.
// Separate from the main generation flow so the user can run Repair
// without queuing a new job.
interface AudioStatusState {
  loading: boolean
  error: string
  total: number
  present: number
  missing: number
  missing_files: string[]
}
interface RepairOutcome { filename: string; status: string; task_id?: string; reason?: string }
interface RepairResult {
  total_expected: number
  present_before: number
  recovered: number
  still_missing: number
  outcomes: RepairOutcome[]
  logs: string[]
}

const audioStatus = reactive<AudioStatusState>({
  loading: false, error: '', total: 0, present: 0, missing: 0, missing_files: [],
})
const repairing = ref(false)
const repairResult = ref<RepairResult | null>(null)

async function refreshAudioStatus() {
  if (!form.episode_id) return
  audioStatus.loading = true
  audioStatus.error = ''
  try {
    const r = await get<any>(`/projects/${slug.value}/episodes/${form.episode_id}/audio-status`)
    audioStatus.total = r.total ?? 0
    audioStatus.present = r.present ?? 0
    audioStatus.missing = r.missing ?? 0
    audioStatus.missing_files = r.missing_files ?? []
  } catch (e: any) {
    // The endpoint errors when the narration.docx doesn't exist yet — treat
    // that as "nothing expected" rather than a real error the user has to act on.
    // Backend now flags this case with `code: 'NARRATION_MISSING'`; we also
    // keep the legacy message regex as a fallback so older bundled backends
    // (pre-2026-05-02) still hit the soft-fail branch.
    const code = e?.data?.code || ''
    const msg = e?.data?.detail || e?.message || ''
    const isNarrationMissing =
      code === 'NARRATION_MISSING'
      || /Could not find .*_Script_Narration\.docx/i.test(msg)
    if (isNarrationMissing) {
      audioStatus.total = 0; audioStatus.present = 0; audioStatus.missing = 0
      audioStatus.missing_files = []
    } else {
      audioStatus.error = msg || 'Could not check audio integrity'
    }
  } finally {
    audioStatus.loading = false
  }
}

async function runRepair() {
  if (!form.episode_id) return
  repairing.value = true
  repairResult.value = null
  try {
    const r = await post<RepairResult>(
      `/projects/${slug.value}/episodes/${form.episode_id}/audio-repair`,
      { provider: 'genaipro' },
    )
    repairResult.value = r
    if (r.recovered > 0) {
      success(`Recovered ${r.recovered} chunk(s)`)
    } else if (r.still_missing === 0) {
      success('Nothing to repair — all chunks already present')
    }
    await refreshAudioStatus()
  } catch (e: any) {
    console.error('[audio] repair failed:', e)
    showError(e?.data?.detail || 'Audio repair failed — GenAIPro task history may have aged out (1-day window).')
  } finally {
    repairing.value = false
  }
}

// Auto-refresh status when the selected episode changes. Also clear any
// prior section selection so AudioChapterSelector re-applies its
// "auto-select missing" default for the new episode.
watch(() => form.episode_id, (v) => {
  repairResult.value = null
  form.sections = ''
  effectiveSections.value = []
  if (v) refreshAudioStatus()
}, { immediate: true })

// ── Main generation ────────────────────────────────────────────────────
async function submit() {
  // A voice MUST be explicitly picked — there is no default. This guards the
  // programmatic path; the Generate button is also disabled until a voice is
  // set. Prevents the silent "generated with the default voice" failure mode.
  if (!form.voice) {
    showError('Pick a voice first — audio generation needs an explicit voice (no default).')
    return
  }
  // Build the actual payload. If the user picked specific sections in the
  // selector, we send them as the comma-joined `sections` string the backend
  // already understands. If nothing is selected and they hit Generate, treat
  // that as "all" so the original one-click flow still works.
  const sections = effectiveSections.value.length
    ? effectiveSections.value.join(',')
    : 'all'

  // Translate the unified `generation_mode` into the backend's existing
  // (force, no_overwrite) booleans. Backend untouched — generators/audio.ts
  // still reads these two flags.
  const force = form.generation_mode !== 'skip'
  const no_overwrite = form.generation_mode === 'new_version'
  const { generation_mode: _gm, ...rest } = form
  const payload: any = { ...rest, sections, force, no_overwrite }
  // v1.0.314 — always strip max_chunk_chars from the payload. The Audio
  // Generator no longer exposes the per-job override — the cap is set per
  // model in Settings → Audio Models. A legacy preset or remembered form may
  // still carry the field; stripping it unconditionally means the backend
  // falls back to the per-model cap (or the chunker default) in every case.
  delete payload.max_chunk_chars

  if (form.episode_id && effectiveSections.value.length === 0 && form.sections) {
    // User selected items but every one was filtered out as already-generated.
    showError('Every selected section already has audio. Switch Generation Mode to "Regenerate" or "New version" to overwrite, or pick different sections.')
    return
  }

  if (!await confirmGeneration(slug.value, 'audio', payload)) return

  submitting.value = true
  audioGenerating.value = true
  try {
    await post(`/projects/${slug.value}/generate/audio`, payload)
    success(`Audio generation queued for ${sections === 'all' ? 'all sections' : effectiveSections.value.length + ' section(s)'}`)
  } catch (e: any) {
    console.error('[audio] queue failed:', e, 'payload:', payload)
    showError(e.data?.detail || `Failed to queue audio generation (model=${form.model}, voice=${form.voice || 'unset'}). Check the TTS provider key in Settings.`)
    audioGenerating.value = false
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
/* Helper line that hangs directly under an input. */
.hint-line { margin-top: 4px; }

/* v1.0.291 — Max-chunk-size row on the audio form. Input + secondary
   hint + reset link all on one line so the user can scan the current
   value, see what that means in seconds, and clear it back to the
   engine default in one motion. */
/* v1.0.314 — read-only chunk-size display. Pill-style so it reads as
   informational, not interactive (the per-model cap is set in Settings). */
.chunk-display {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 7px 12px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 13px;
}
.chunk-value { display: inline-flex; align-items: baseline; gap: 4px; }
.chunk-link { font-size: 12px; margin-left: auto; white-space: nowrap; }

/* v1.0.78 — inline "Rescan from disk" hint under the TopActionBar.
   Compact, low-contrast so it doesn't compete with the disabled button
   above; the button-link inside is the actual call to action. */
.rescan-hint {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: var(--bg-tertiary);
  border-left: 3px solid var(--accent);
  border-radius: 4px;
  font-size: 12px;
}
.rescan-hint .btn-link {
  background: transparent;
  border: none;
  color: var(--accent);
  cursor: pointer;
  padding: 0;
  font-size: 12px;
  text-decoration: none;
}
.rescan-hint .btn-link:hover { color: var(--accent-hover); text-decoration: underline; }
.rescan-hint .btn-link:disabled { opacity: 0.6; cursor: not-allowed; }

/* Integrity card title and blurb (mirrors images/video). */
.integrity-title { margin-bottom: 6px; }
.integrity-blurb { margin-bottom: 10px; }

/* Repair-result <details> summary. */
.repair-details-summary { cursor: pointer; font-size: 12px; }

.required { color: var(--error); margin-left: 2px; }
.field-hint { color: var(--text-muted); font-size: 11px; font-weight: 400; margin-left: 4px; }

/* Generation Mode (M6) — three-up radio cards. Stacks on narrow viewports. */
.generation-mode-row {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  margin-top: 4px;
}
@media (max-width: 720px) {
  .generation-mode-row { grid-template-columns: 1fr; }
}
.generation-mode-option {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-tertiary);
  cursor: pointer;
  transition: border-color 0.12s, background 0.12s;
}
.generation-mode-option:has(input:checked) {
  border-color: var(--accent);
  background: rgba(96, 165, 250, 0.08);
}
.generation-mode-option input { margin-top: 2px; }
.generation-mode-option strong { display: block; font-size: 13px; color: var(--text-primary); }
.generation-mode-option .text-muted { display: block; font-size: 11px; color: var(--text-muted); margin-top: 2px; }

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
.repair-result {
  border-radius: 6px;
  padding: 8px 10px;
  background: var(--surface-2, rgba(0,0,0,0.03));
  font-size: 13px;
}
.repair-summary.ok { color: rgb(22, 163, 74); }
.repair-summary.warn { color: rgb(180, 83, 9); }
.repair-log {
  margin-top: 6px;
  padding: 8px 10px;
  background: var(--surface-3, rgba(0,0,0,0.05));
  border-radius: 4px;
  font-size: 12px;
  line-height: 1.5;
  max-height: 280px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}

.voice-row { display: flex; gap: 6px; align-items: stretch; }
.voice-row .select { flex: 1; }
.voice-picker-flex { flex: 1; min-width: 0; }
.preview-btn { white-space: nowrap; display: inline-flex; align-items: center; gap: 4px; }

.generating-status { display: flex; align-items: center; gap: 8px; color: var(--accent); }
.gen-label { font-size: 12px; }

.checkbox-label {
  display: flex; align-items: center; gap: 6px;
  font-size: 14px; cursor: pointer; color: var(--text-secondary);
}

.slider { width: 100%; accent-color: var(--accent); }
</style>
