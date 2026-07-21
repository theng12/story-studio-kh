<template>
  <div class="workspace-page">
    <WorkspaceHero
      eyebrow="Generator · Narration"
      title="Audio Generator"
      description="Turn approved scripts into chapter narration using a compatible cloud voice or your local Voice Studio fleet."
    >
      <template #aside>
        <div class="workspace-metrics" aria-label="Audio generator context">
          <span class="workspace-metric" data-tone="info"><strong>{{ currentAudioProviderLabel }}</strong> provider</span>
          <span class="workspace-metric" :data-tone="form.episode_id ? 'success' : 'warning'">
            <strong>{{ form.episode_id || 'No episode' }}</strong> target
          </span>
        </div>
      </template>
    </WorkspaceHero>
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
      :generate-disabled="!form.episode_id || !scriptReady || !form.voice || !selectedVoiceCompatible"
      :generate-status="audioJobActiveForEpisode ? `Generating audio for ${form.episode_id}…` : (scriptGateReason || (!form.voice ? 'Pick a voice first — there is no default.' : (!selectedVoiceCompatible ? `This voice is not labelled for ${currentAudioProviderLabel}.` : '')))"
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
    <WorkspaceNotice
      v-if="form.episode_id && statusKnown && !scriptReady"
      tone="warning"
      title="Script not detected"
    >
      No script was found for {{ form.episode_id }}. If iCloud just delivered it, rescan the episode folders.
      <template #actions>
        <button
          type="button"
          class="btn btn-secondary btn-sm"
          :disabled="rescanning"
          title="Wipe this project's status cache and re-stat every episode folder."
          @click="onRescan"
        >
          {{ rescanning ? 'Rescanning…' : 'Rescan from disk' }}
        </button>
      </template>
    </WorkspaceNotice>

    <div class="card mt-3">
      <div class="grid-2">
        <div class="form-group">
          <label>TTS Model <span class="required" aria-hidden="true">*</span></label>
          <ModelMenu
            v-model="form.model"
            :options="audioModelOptions"
            media-type="tts"
            title="Choose a TTS model"
            placeholder="Pick a voice model…"
            search-placeholder="Search model or provider…"
            aria-label="TTS model options"
          />
        </div>
      </div>

      <div class="form-group">
        <label>Voice</label>
        <div class="voice-row">
          <VoicePicker
            v-model="form.voice"
            :project-slug="slug"
            :custom-voices="config?.voice_presets || []"
            :custom-voices-loaded="!!config"
            :audio-model-provider="currentAudioProvider"
            :audio-model-id="form.model"
            require-selection
            class="voice-picker-flex"
            @preview="previewVoiceId"
            @voice-saved="refreshConfig(slug)"
            @catalog-updated="onVoiceCatalogUpdated"
          />
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
          <template v-if="currentAudioProvider === 'genstudio'">
            Voices are fetched securely from your live <strong>GenStudio KH</strong> catalog. Each request supports up to <strong>15,000 characters</strong>; VoiceStudio handles its own internal chunks and returns one completed result.
          </template>
          <template v-else>
            Only voices labelled for <strong>{{ currentAudioProviderLabel }}</strong> are shown. Add one in the picker, or manage multi-provider labels in
            <NuxtLink :to="`/projects/${slug}/settings#voices`">Settings → Voices</NuxtLink>.
          </template>
          <template v-if="isFish"> Speed maps to Fish prosody; Stability and Similarity do not apply.</template>
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
        :inline-generate-disabled="inlineGenerateDisabled"
        :inline-generate-disabled-reason="inlineGenerateDisabledReason"
        @update:effective-selected="onEffectiveSelectionChange"
        @generate-section="submitSection"
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
        <label>{{ currentAudioProvider === 'genstudio' ? 'GenStudio request boundary' : 'Chunk size' }} <span class="field-hint">— characters per TTS call</span></label>
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
          Story Studio splits at sentence boundaries within this outer cap.
          Suggested per provider:
          ElevenLabs / GenAIPro / fal ≈ 3,000–4,800;
          Kokoro 3,000+;
          Qwen3 Base, VoxCPM2, and Chatterbox 15,000 (Voice Studio safely
          splits, verifies, and joins their smaller internal sections).
        </p>
      </div>

      <!-- Delivery controls — expressiveness (Fish only) + auto-pacing
           (tag-capable models: Fish S2-Pro + ElevenLabs v3). Fixes the
           "monotone + rushes through periods" feel. -->
      <div v-if="isFish || isTagCapable" class="form-group mb-2">
        <label>Delivery <span class="field-hint">— voice pacing &amp; expressiveness</span></label>
        <div v-if="isFish" class="form-group">
          <label>Expressiveness ({{ form.fish_temperature.toFixed(2) }}) <span class="field-hint">Higher = less monotone</span></label>
          <SliderWithNumber v-model="form.fish_temperature" :min="0" :max="1" :step="0.05" :decimals="2" />
          <p class="text-muted text-xs hint-line">
            Fish's own default is <strong>0.70</strong>; we start at <strong>0.80</strong> for livelier delivery.
            Raise toward <strong>0.90</strong> for more varied intonation; lower toward 0.70 for a steadier read. (Very high can wobble.)
          </p>
        </div>
        <label v-if="isTagCapable" class="checkbox-label" title="Inserts pause tags at sentence + paragraph breaks so the voice does not rush through full stops.">
          <input type="checkbox" v-model="form.fish_autopace" />
          <span>Auto-pause at sentence breaks <span class="field-hint">— adds breathing room</span></span>
        </label>
        <p v-if="isTagCapable" class="text-muted text-xs hint-line">
          Inserts pauses at paragraph + sentence breaks so the read isn't rushed. Works on plain narration and
          layers on top of Expression markup (pauses won't double up).
          <template v-if="!isFishS2Pro"> On ElevenLabs v3 this adds paragraph pauses (it paces sentences naturally).</template>
        </p>
      </div>

      <!-- Expression markup — tag-capable models (Fish S2-Pro + ElevenLabs v3).
           Draft + review a tagged "expressive script" the audio renders when on;
           untagged sections are auto-tagged at render time. -->
      <div v-if="isTagCapable" class="form-group mb-2">
        <label>Expression <span class="field-hint">— emotion &amp; performance tags</span></label>
        <FishExpressionPanel
          v-model="form.use_expression"
          v-model:expression-model="form.expression_model"
          :project-slug="slug"
          :episode-id="form.episode_id || null"
          :audio-model="form.model"
        />
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
        Check whether every expected audio chunk is on disk. If a cloud gateway
        (GenAIPro, kie.ai, or fal.ai) completed a task but the download was lost
        (e.g. a network blip or timeout), <strong>Repair missing</strong>
        re-fetches it from that provider's task history — no credits re-spent.
        Chunks made with a streaming provider (direct ElevenLabs, Fish, Voice
        Studio, macOS) have no re-fetchable task — regenerate those instead.
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
            {{ repairResult.still_missing }} still missing — the task may have
            aged out of the provider's history, failed on the provider side, or
            was made with a streaming provider (no re-fetchable task).
            Re-generate those (Skip existing will remake only the missing ones).
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
import {
  normalizeSavedVoices,
  voiceProviderLabel,
  voiceSupportsProvider,
  type SavedVoice,
  type VoiceProviderId,
} from '~/utils/voice-providers'

definePageMeta({ layout: 'dashboard' })
useAppTitle('Audio Generator')
const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { post, get } = useApi()
const { project, config, refreshConfig } = useProject()
const {
  voiceModels: genStudioVoiceModels,
  refresh: refreshGenStudioMediaModels,
} = useGenStudioMediaModels()

function genStudioCharacterLimit(model: any): number {
  const limits = model?.limits || {}
  const candidates = [limits.max_characters, limits.max_text_characters, limits.max_chars]
  const value = candidates.map(Number).find(number => Number.isFinite(number) && number > 0)
  return value ? Math.round(value) : 15_000
}

const runtimeAudioModels = computed<Record<string, any>>(() => {
  const models = { ...((config.value?.audio_models || {}) as Record<string, any>) }
  for (const model of genStudioVoiceModels.value) {
    models[model.id] = {
      label: `${model.display_name} [GenStudio KH]`,
      description: model.description || 'Voice model published by GenStudio KH.',
      provider: 'genstudio',
      cost_per_1k_chars: 0,
      tts_soft_max_chars: genStudioCharacterLimit(model),
      available: model.available,
      qualification_only: model.qualification_only,
      pricing_unit: model.pricing_unit,
    }
  }
  return models
})

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
  const all = runtimeAudioModels.value
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
const audioModelOptions = computed(() => audioModelGroups.value.flatMap(group =>
  group.items.map(({ id, data }) => {
    const isPaid = Number(data.cost_per_1k_chars || 0) > 0
    return {
      id,
      label: data.label || id,
      group: group.label,
      provider: group.label,
      meta: resolveAudioProvider(id, data) === 'genstudio'
        ? (data.pricing_unit || 'GenStudio account credits')
        : isPaid ? `$${data.cost_per_1k_chars}/1K characters` : 'Free · local processing',
      description: data.description || data.hint || '',
      disabled: data.available === false,
      disabledReason: data.available === false ? 'This voice model is not currently available in GenStudio KH.' : undefined,
      badges: [{
        label: resolveAudioProvider(id, data) === 'genstudio' ? 'GenStudio' : isPaid ? 'paid' : 'local',
        tone: resolveAudioProvider(id, data) === 'genstudio' ? 'info' as const : isPaid ? 'paid' as const : 'local' as const,
      }],
    }
  }),
))

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
  // Fish Audio S2-Pro only — render the saved expressive (tagged) narration.
  use_expression: false,
  // Text LLM used to insert emotion/performance tags. Saved with the audio
  // preset so unattended Pipeline runs use the same local/cloud choice.
  expression_model: 'deepseek-v4-flash',
  // Fish Audio delivery controls. 0.8 starts a touch above Fish's own 0.7
  // default for livelier (less monotone) delivery; autopace inserts pause tags
  // so the voice doesn't rush through periods.
  fish_temperature: 0.8,
  fish_autopace: false,
})

// v1.0.259 — remember the voice + tuning across reloads. `sections` is
// episode-specific (auto-filled with that episode's missing sections), so it's
// left out of the allowlist. A restored voice that's incompatible with the
// restored model is reconciled by VoicePicker on load.
useRememberedForm('audio', slug, form, {
  // v1.0.314 — max_chunk_chars removed from the allowlist. It's no longer
  // user-settable on this page (per-model cap lives in Settings), so there's
  // nothing to remember.
  include: ['model', 'voice', 'speed', 'stability', 'similarity', 'generation_mode', 'fish_temperature', 'fish_autopace', 'expression_model'],
})

// Resolve the selected model's provider so VoicePicker can enforce the
// provider labels attached to each saved cloud voice. Voice Studio and macOS
// remain separate live voice sources.
//
// v1.0.157 — moved BELOW the `form = reactive({...})` declaration. See
// the placeholder comment above where this used to live (line ~250).
const currentAudioProvider = computed<string>(() => {
  if (!form.model) return ''
  const entry = visibleAudioModels.value[form.model] as any
  return resolveAudioProvider(form.model, entry || {})
})

const CLOUD_VOICE_PROVIDERS = new Set(['elevenlabs', 'fal', 'genaipro', 'kie', 'fishaudio', 'genstudio'])
const discoveredProviderVoices = ref<SavedVoice[]>([])
function onVoiceCatalogUpdated(voices: SavedVoice[]) {
  discoveredProviderVoices.value = voices
}
const currentAudioProviderLabel = computed(() => {
  const provider = currentAudioProvider.value
  return CLOUD_VOICE_PROVIDERS.has(provider)
    ? voiceProviderLabel(provider as VoiceProviderId)
    : provider === 'voicestudio' ? 'Voice Studio' : provider === 'macos' ? 'macOS' : 'the selected provider'
})
const selectedVoiceCompatible = computed(() => {
  if (!form.voice) return false
  const provider = currentAudioProvider.value
  if (!CLOUD_VOICE_PROVIDERS.has(provider)) return true
  return normalizeSavedVoices([
    ...(config.value?.voice_presets || []),
    ...discoveredProviderVoices.value,
  ]).some(voice =>
    voice.voice_id === form.voice && voiceSupportsProvider(voice, provider))
})

// Fish S2-Pro is the only model with inline expression tags — gate the
// expression panel + the use_expression flag to it. (S1 would read an unknown
// tag aloud, so it's deliberately excluded.)
const isFish = computed(() => currentAudioProvider.value === 'fishaudio')
const isFishS2Pro = computed(() => isFish.value && form.model === 'fishaudio-s2-pro')
// Models that take inline emotion/pause tags: Fish S2-Pro + ElevenLabs v3
// (via fal / GenAIPro). Expressiveness (temperature) stays Fish-only.
const isTagCapable = computed(() => ['fishaudio-s2-pro', 'eleven-v3', 'genaipro-v3'].includes(form.model))
watch(isTagCapable, (on) => { if (!on) { form.use_expression = false; form.fish_autopace = false } })

// v1.0.314 — the per-model chunk cap (Settings → Audio Models → Max chunk
// chars). Null = use the chunker default (~4800). Surfaced read-only in the
// form so the user knows exactly what's about to be sent to the TTS API.
const resolvedChunkCap = computed<number | null>(() => {
  if (!form.model) return null
  const entry = visibleAudioModels.value[form.model] as any
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
  ? currentAudioProvider.value === 'genstudio'
    ? `GenStudio accepts one logical request up to ${resolvedChunkCap.value.toLocaleString()} characters. Story Studio splits only above this public API boundary; VoiceStudio handles smaller internal model chunks, joining, and final speed.`
    : `Set per-model in Settings → Audio Models. The script is split at sentence boundaries within ${resolvedChunkCap.value.toLocaleString()} chars per TTS call.`
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
const inlineGenerateDisabled = computed(() =>
  !scriptReady.value
  || !form.voice
  || !selectedVoiceCompatible.value
  || submitting.value
  || audioJobActiveForEpisode.value,
)
const inlineGenerateDisabledReason = computed(() => {
  if (!scriptReady.value) return scriptGateReason.value || 'Generate the script first.'
  if (!form.voice) return 'Pick a voice first.'
  if (!selectedVoiceCompatible.value) return `Pick a voice labelled for ${currentAudioProviderLabel.value}.`
  if (submitting.value) return 'The audio request is being queued.'
  if (audioJobActiveForEpisode.value) return 'Another audio job for this episode is already queued or running.'
  return ''
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
  // Section selection belongs to the current episode, never to a reusable
  // voice/model preset. This also strips stale `sections` from old presets
  // before apply, so the selector can auto-pick every missing section.
  excludeKeys: ['episode_id', 'episodeId', 'episode', 'title', 'sections'],
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
  void refreshGenStudioMediaModels()
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
  await queueAudio()
}

async function submitSection(sectionSlug: string) {
  await queueAudio(sectionSlug)
}

async function queueAudio(sectionOverride?: string) {
  // A voice MUST be explicitly picked — there is no default. This guards the
  // programmatic path; the Generate button is also disabled until a voice is
  // set. Prevents the silent "generated with the default voice" failure mode.
  if (!form.voice) {
    showError('Pick a voice first — audio generation needs an explicit voice (no default).')
    return
  }
  if (!selectedVoiceCompatible.value) {
    showError(`The selected voice is not labelled for ${currentAudioProviderLabel.value}. Pick a compatible voice or update it in Settings → Voices.`)
    return
  }
  // Build the actual payload. If the user picked specific sections in the
  // selector, we send them as the comma-joined `sections` string the backend
  // already understands. If nothing is selected and they hit Generate, treat
  // that as "all" so the original one-click flow still works.
  const sections = sectionOverride || (effectiveSections.value.length
    ? effectiveSections.value.join(',')
    : 'all')

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

  if (!sectionOverride && form.episode_id && effectiveSections.value.length === 0 && form.sections) {
    // User selected items but every one was filtered out as already-generated.
    showError('Every selected section already has audio. Switch Generation Mode to "Regenerate" or "New version" to overwrite, or pick different sections.')
    return
  }

  if (!await confirmGeneration(slug.value, 'audio', payload)) return

  submitting.value = true
  audioGenerating.value = true
  try {
    await post(`/projects/${slug.value}/generate/audio`, payload)
    success(sectionOverride
      ? `${sectionOverride.replaceAll('_', ' ')} queued by itself.`
      : `Audio generation queued for ${sections === 'all' ? 'all sections' : effectiveSections.value.length + ' section(s)'}`)
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
