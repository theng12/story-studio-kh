<template>
  <div class="workspace-page">
    <WorkspaceHero
      eyebrow="Generator · Narration"
      title="Audio Generator"
      description="Turn approved scripts into chapter narration through your GenStudio voice catalog."
    >
      <template #aside>
        <div class="workspace-metrics" aria-label="Audio generator context">
          <span class="workspace-metric" data-tone="info"><strong>{{ selectedProviderName || 'GenStudio KH' }}</strong> provider</span>
          <span class="workspace-metric" :data-tone="form.episode_id ? 'success' : 'warning'">
            <strong>{{ form.episode_id || 'No episode' }}</strong> target
          </span>
        </div>
      </template>
    </WorkspaceHero>
    <!-- Live TTS download speed while GenStudio audio bytes stream back. -->
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
      :generate-status="audioJobActiveForEpisode ? `Generating audio for ${form.episode_id}…` : (scriptGateReason || (!form.voice ? 'Pick a voice first — there is no default.' : (!selectedVoiceCompatible ? 'This voice cannot be generated with right now.' : '')))"
      @generate="submit"
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
          <label>TTS service <span class="required" aria-hidden="true">*</span></label>
          <ModelMenu
            v-model="form.model"
            :options="audioModelOptions"
            media-type="tts"
            title="Choose a voice model"
            placeholder="Pick a GenStudio voice model…"
            search-placeholder="Search voice models…"
            aria-label="GenStudio TTS model options"
            :catalog-notice="genstudioPlanNotice"
            catalog-notice-href="/usage"
          />
          <p v-if="ttsModelsError" class="text-muted text-xs hint-line">{{ ttsModelsError }}</p>
          <p v-else-if="ttsModelsLoading && !audioModelOptions.length" class="text-muted text-xs hint-line">
            Loading voice models from GenStudio KH…
          </p>
          <p v-else-if="selectedTtsModel" class="text-muted text-xs hint-line">
            Served by <strong>{{ selectedTtsModel.provider_name || 'GenStudio KH' }}</strong>.
            <span :title="modelRate.title">{{ modelRate.text }}</span>,
            minimum {{ formatCredits(selectedTtsModel.minimum_credits) }} per request.
            <template v-if="selectedTtsModel.supports_voice_cloning"> Supports voice cloning.</template>
          </p>
        </div>
      </div>

      <div class="form-group">
        <label>Voice</label>
        <div class="voice-row">
          <VoicePicker
            v-model="form.voice"
            :project-slug="slug"
            :audio-model-provider="currentAudioProvider"
            :tts-model-id="form.model"
            :tts-model-name="selectedTtsModel?.display_name || ''"
            :model-credits-per1000-characters="selectedTtsModel?.credits_per_1000_characters ?? null"
            require-selection
            class="voice-picker-flex"
            @preview="previewVoiceId"
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
          <template v-if="selectedTtsModel">
            Voices GenStudio KH serves on <strong>{{ selectedTtsModel.display_name }}</strong>. Save one with ★ to keep it in
            your GenStudio account, or browse the provider libraries from inside the picker.
          </template>
          <template v-else>
            Pick a voice model above — voices are listed for the model that serves them.
          </template>
        </span>
        <p v-if="selectedVoice" class="text-muted text-xs hint-line">
          <template v-if="selectedVoice.language">{{ selectedVoice.language }} · </template>
          <template v-if="selectedVoiceProviderText">{{ selectedVoiceProviderText }} · </template>
          <template v-if="voiceRateDiffers">
            This voice is priced at {{ formatCredits(selectedVoice.credits_per_1000_characters!) }} / 1,000 characters —
            different from the model's rate.
          </template>
          <template v-else>Priced at the model's rate.</template>
          <template v-if="selectedVoice.preview_notice"> {{ selectedVoice.preview_notice }}</template>
        </p>
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
        <!-- GenStudio publishes `supports_speed` per model. A model that does
             not take a speed control does not get one. -->
        <div v-if="supportsSpeed" class="form-group">
          <label>Speed ({{ form.speed.toFixed(2) }}) <span class="field-hint">Playback pace</span></label>
          <SliderWithNumber v-model="form.speed" :min="0.5" :max="2" :step="0.01" :decimals="2" />
          <p class="text-muted text-xs hint-line">
            <strong>0.95–1.05</strong> reads most naturally for narration. Below 0.9 can sound sluggish; above 1.1 rushes the delivery.
          </p>
        </div>
        <div v-else-if="selectedTtsModel" class="form-group">
          <label>Speed <span class="field-hint">Not available on this model</span></label>
          <p class="text-muted text-xs hint-line">
            GenStudio does not publish a speed control for <strong>{{ selectedTtsModel.display_name }}</strong>, so Story Studio
            sends none. Choose a model that supports speed to change the pace.
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

      <!-- The enforced request boundary, shown because it is enforced
           (AGENTS.md). It is the selected model's published
           `maximum_input_characters`, never a Story Studio constant. -->
      <div v-if="resolvedChunkCap" class="form-group mb-2">
        <label>Request boundary <span class="field-hint">— characters per TTS call</span></label>
        <div class="chunk-display" :title="chunkSizeTooltip">
          <span class="chunk-value">
            {{ resolvedChunkCap.toLocaleString() }} chars
            <span class="text-muted text-xs"> · ≈ {{ formatChunkSeconds(resolvedChunkCap) }} of audio</span>
          </span>
        </div>
        <p class="text-muted text-xs hint-line">
          GenStudio publishes this limit for <strong>{{ selectedTtsModel?.display_name }}</strong>. Longer sections are split at
          sentence boundaries within it. It is not a project setting.
        </p>
      </div>

      <!-- Cost: the model's published rate until there is real text, then
           GenStudio's own quotes — ONE PER TTS JOB this narration will actually
           be submitted as — listed and added up. Never an estimate. -->
      <div v-if="selectedTtsModel" class="form-group mb-2">
        <label>Cost <span class="field-hint">— GenStudio's figures</span></label>
        <div class="chunk-display" :title="quotedCost ? quotedCost.title : modelRate.title">
          <span class="chunk-value">
            <template v-if="quotedCost">
              {{ CREDIT_BASIS_LABEL[quotedCost.basis] }}: {{ quotedCost.text }}
              <span class="text-muted text-xs">
                · {{ (narrationQuote?.total_billable_characters || 0).toLocaleString() }} billable characters
                <template v-if="!narrationQuote?.chargeable"> · GenStudio marks these requests non-chargeable</template>
              </span>
            </template>
            <template v-else>
              {{ modelRate.text }}
              <span class="text-muted text-xs"> · rate, not a total</span>
            </template>
          </span>
          <button
            type="button"
            class="btn btn-sm btn-secondary"
            :disabled="!quoteEligible || !form.episode_id || quoting"
            :title="quoteEligible ? 'Ask GenStudio to price every TTS job this narration will be submitted as' : 'GenStudio does not offer a quote for this voice'"
            @click="refreshQuote"
          >{{ quoting ? 'Asking…' : 'Get quote' }}</button>
        </div>

        <!-- The parts, shown because they are real: each row is a separate
             GenStudio job, separately submitted, separately billed, and
             separately subject to the model's published per-job minimum. -->
        <ul v-if="quotedParts.length" class="quote-parts">
          <li v-for="(part, index) in quotedParts" :key="index" class="quote-part text-xs">
            <span class="quote-part-name">
              {{ part.section_label }}<template v-if="part.part_count > 1"> · part {{ part.part }} of {{ part.part_count }}</template>
            </span>
            <span class="text-muted">
              {{ part.characters.toLocaleString() }} chars submitted ·
              {{ formatCredits(part.credits) }} ({{ part.billable_characters.toLocaleString() }} billable)
            </span>
          </li>
        </ul>

        <p v-if="quoteError" class="text-muted text-xs hint-line">{{ quoteError }}</p>
        <p v-else-if="quoteUnavailableNote" class="text-muted text-xs hint-line">{{ quoteUnavailableNote }}</p>
        <p v-else-if="narrationQuote && narrationQuote.part_count > 1" class="text-muted text-xs hint-line">
          This narration is generated in <strong>{{ narrationQuote.part_count.toLocaleString() }} parts</strong> across
          {{ narrationQuote.section_count.toLocaleString() }} section(s), because
          <strong>{{ selectedTtsModel.display_name }}</strong> accepts
          {{ narrationQuote.maximum_input_characters.toLocaleString() }} characters per request. Each part is its own
          GenStudio job, carrying that model's published minimum of
          {{ formatCredits(narrationQuote.minimum_credits) }} in its own right — so GenStudio was asked to price every
          one of them, and the total above is the sum of those {{ narrationQuote.part_count }} quotes. Nothing was
          calculated here. GenStudio reports the actual charge on each finished job.
        </p>
        <p v-else class="text-muted text-xs hint-line">
          A quote is GenStudio's own figure for the requests about to be sent, not a Story Studio estimate.
          GenStudio reports the actual charge on each finished job.
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

    <!-- Asset reconciliation: status pill + Repair button (per episode). -->
    <div v-if="form.episode_id" class="card mt-2" aria-labelledby="audio-integrity-heading">
      <h3 id="audio-integrity-heading" class="integrity-title">Audio integrity</h3>
      <p class="text-muted text-sm integrity-blurb">
        Check whether every expected audio file is on disk. If a completed
        GenStudio download was interrupted, <strong>Repair missing</strong>
        reconnects to the accepted job without submitting or charging twice.
        Regenerate only when GenStudio no longer has a recoverable result.
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
import type { GenStudioTtsModel, GenStudioVoice, GenStudioNarrationQuote } from '~/composables/useGenStudioVoices'
import { voiceIsGenerable } from '~/composables/useGenStudioVoices'
import { CREDIT_BASIS_LABEL, describeVoiceRate, describeQuotedTotal, formatCredits } from '~/utils/genstudio-credit-cost'

definePageMeta({ layout: 'dashboard' })
useAppTitle('Audio Generator')
const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { post, get } = useApi()
const { project, config, refreshConfig } = useProject()
const {
  planNotice: genstudioPlanNotice,
  badgeFor: genstudioUnlimitedBadge,
  refresh: refreshGenstudioAccess,
} = useGenStudioAccess()

const {
  models: ttsModels,
  modelsLoading: ttsModelsLoading,
  modelsError: ttsModelsError,
  loadModels: loadTtsModels,
  quoteNarration,
} = useGenStudioVoices()

/**
 * The voice-model picker. Every line comes from `GET /v1/tts/models`: the
 * provider serving the model (AGENTS.md → Provider Transparency), the rate it
 * charges, its minimum, and the request boundary it enforces. `generation_enabled`
 * is respected — a model GenStudio has switched off cannot be chosen.
 */
const audioModelOptions = computed(() => ttsModels.value.map((model) => {
  const unlimited = genstudioUnlimitedBadge(false)
  return {
    id: model.id,
    label: model.display_name,
    group: model.provider_name || 'GenStudio KH',
    provider: model.provider_name || '',
    meta: [
      `${formatCredits(model.credits_per_1000_characters)} / 1,000 characters`,
      `min ${formatCredits(model.minimum_credits)}`,
      `up to ${model.maximum_input_characters.toLocaleString()} characters per request`,
    ].join(' · '),
    description: model.description,
    disabled: !model.generation_enabled,
    disabledReason: model.generation_enabled ? '' : 'GenStudio has generation turned off for this model.',
    badges: [
      ...(model.provider_name ? [{ label: model.provider_name, tone: 'info' as const }] : []),
      ...(model.supports_voice_cloning ? [{ label: 'Voice cloning', tone: 'info' as const }] : []),
      ...(model.generation_enabled ? [] : [{ label: 'Unavailable', tone: 'paid' as const }]),
      ...(unlimited ? [unlimited] : []),
    ],
  }
}))

/** The one model every published figure on this page is read from. */
const selectedTtsModel = computed<GenStudioTtsModel | null>(() =>
  ttsModels.value.find(model => model.id === form.model) || null)

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
  // A GenStudio TTS model id from the live `/v1/tts/models` catalogue. Empty
  // until either a remembered selection restores or the catalogue loads — the
  // page never invents a model id, and never falls back to one.
  model: '',
  voice: null as string | null,
  // Empty by default — AudioChapterSelector auto-fills with missing sections
  // once an episode is picked. submit() falls back to 'all' if nothing is
  // selected, preserving the original one-click flow.
  sections: '',
  speed: 0.93,
  stability: 1.0,
  similarity: 1.0,
  // Unified Generation Mode (M6). Submit translates this into the backend's
  // existing { force, no_overwrite } pair. Default 'skip' matches the old
  // default behaviour (force=false, no_overwrite=false).
  generation_mode: 'skip' as 'skip' | 'regenerate' | 'new_version',
  // Fish Audio S2-Pro only — render the saved expressive (tagged) narration.
  use_expression: false,
  // Kept empty until the GenStudio-only expression surface selects a live
  // chat model. Never retain a retired direct-provider id in audio presets.
  expression_model: '',
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
  include: ['model', 'voice', 'speed', 'stability', 'similarity', 'generation_mode', 'fish_temperature', 'fish_autopace', 'expression_model'],
})
/**
 * A remembered selection is a SELECTION, never a remembered capability. Once
 * the catalogue is in, drop a model GenStudio no longer publishes rather than
 * carrying it into a request that would fail.
 */
watch([ttsModels, () => form.model], () => {
  if (!ttsModels.value.length) return
  if (form.model && ttsModels.value.some(model => model.id === form.model)) return
  if (form.model) {
    form.model = ''
    form.voice = null
    showInfo('That voice model is no longer in your GenStudio KH catalogue. Choose a current one.')
  }
})

const currentAudioProvider = computed<string>(() => 'genstudio')
const discoveredProviderVoices = ref<GenStudioVoice[]>([])
function onVoiceCatalogUpdated(voices: GenStudioVoice[]) {
  discoveredProviderVoices.value = voices
}
const selectedVoice = computed<GenStudioVoice | null>(() =>
  discoveredProviderVoices.value.find(voice => voice.id === form.voice) || null)
const selectedVoiceCompatible = computed(() => !!selectedVoice.value && voiceIsGenerable(selectedVoice.value))

/**
 * Provider identity exactly as GenStudio published it, for display. Story
 * Studio neither infers it nor sends it (AGENTS.md → Provider Transparency).
 */
const selectedProviderName = computed(() => selectedTtsModel.value?.provider_name || '')
const selectedVoiceProviderText = computed(() => {
  const voice = selectedVoice.value
  if (!voice) return ''
  return [...new Set([voice.provider, voice.engine_name].filter(Boolean) as string[])].join(' · ')
})

/** The model's published rate, shown before there is any text to quote. */
const modelRate = computed(() => describeVoiceRate(selectedTtsModel.value))
/** The voice's own rate, shown only when GenStudio prices it differently. */
const voiceRateDiffers = computed(() => {
  const voiceRate = selectedVoice.value?.credits_per_1000_characters
  return typeof voiceRate === 'number'
    && selectedTtsModel.value !== null
    && voiceRate !== selectedTtsModel.value.credits_per_1000_characters
})

// Fish S2-Pro is the only model with inline expression tags — gate the
// expression panel + the use_expression flag to it. (S1 would read an unknown
// tag aloud, so it's deliberately excluded.)
const isFish = computed(() => false)
const isFishS2Pro = computed(() => false)
// Models that take inline emotion/pause tags: Fish S2-Pro + ElevenLabs v3
// (via fal / GenAIPro). Expressiveness (temperature) stays Fish-only.
const isTagCapable = computed(() => false)
watch(isTagCapable, (on) => { if (!on) { form.use_expression = false; form.fish_autopace = false } })

/**
 * The request boundary in force, read from the selected model's published
 * `maximum_input_characters`. AGENTS.md requires an enforced limit to be shown,
 * so this is rendered at the point of choosing. There is no fallback: with no
 * model selected there is no boundary to state.
 */
const resolvedChunkCap = computed<number | null>(() => selectedTtsModel.value?.maximum_input_characters ?? null)
function formatChunkSeconds(chars: number): string {
  // ~15 chars/sec narration pace (English audiobook average).
  const sec = Math.round(chars / 15)
  if (sec < 90) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return s ? `${m}m ${s}s` : `${m} min`
}
const chunkSizeTooltip = computed(() => resolvedChunkCap.value
  ? `GenStudio publishes ${resolvedChunkCap.value.toLocaleString()} characters per request for `
    + `${selectedTtsModel.value?.display_name || 'this model'}. Story Studio splits longer sections at sentence `
    + 'boundaries within that limit.'
  : 'Choose a voice model to see the request boundary GenStudio publishes for it.')

/** GenStudio publishes whether a model takes a speed control. Gate on it. */
const supportsSpeed = computed(() => selectedTtsModel.value?.supports_speed === true)

// Effective section list = what the AudioChapterSelector says to actually
// queue (selection minus already-generated when duplicate override is off).
// We submit this instead of `form.sections` so the duplicate-prevention
// promise the UI makes is honoured at the request boundary.
const effectiveSections = ref<string[]>([])
function onEffectiveSelectionChange(slugs: string[]) {
  effectiveSections.value = slugs
}

// ── Quote ──────────────────────────────────────────────────────────────
// A long narration is NOT one TTS request. Story Studio splits each section at
// the selected model's published `maximum_input_characters` and submits one job
// per piece — `_part1.mp3`, `_part2.mp3`, … — every one of them separately
// billed and separately subject to the model's per-job `minimum_credits`.
//
// So the page does not quote a joined script; it asks the backend, which
// re-derives the exact requests the generator will submit through the one
// shared planner and gets GenStudio to price each of them. What is shown is
// every part's own returned figure plus their sum, labelled as a sum of quotes.
// The model's published rate stands in until there is a quote.
const narrationQuote = ref<GenStudioNarrationQuote | null>(null)
const quoting = ref(false)
const quoteError = ref('')
const quotedParts = computed(() => narrationQuote.value?.quotable ? narrationQuote.value.parts : [])
const quotedCost = computed(() =>
  quotedParts.value.length ? describeQuotedTotal(quotedParts.value, 'this narration') : null)
const quoteEligible = computed(() =>
  !!selectedTtsModel.value && !!form.voice && selectedVoice.value?.quote_enabled !== false)

/**
 * Why there is no quote, in GenStudio's own terms.
 *
 * `generation_unit_rejected` is the one that matters: GenStudio's quote
 * endpoint refused a request body its own TTS model publishes as acceptable.
 * Story Studio does NOT sub-split to make the quote succeed — that would price
 * units nobody is ever billed for — so it says the quote is unavailable for
 * this model and leaves the published rate standing.
 */
const quoteUnavailableNote = computed(() => {
  const result = narrationQuote.value
  if (!result || result.quotable) return ''
  const said = result.unavailable_detail ? ` GenStudio said: “${result.unavailable_detail}”.` : ''
  if (result.unavailable_reason === 'quote_disabled') {
    return `GenStudio publishes this voice as not quotable, so there is no quote to show. `
      + `The published rate above is ${modelRate.value.text}; GenStudio reports the actual charge on each finished job.`
  }
  if (result.unavailable_reason === 'generation_unit_rejected') {
    return 'No quote is available for this model. GenStudio\'s quote endpoint refused a '
      + `${(result.unquotable_characters || 0).toLocaleString()}-character request that ${result.model_name} itself `
      + `publishes as valid — it accepts ${result.maximum_input_characters.toLocaleString()} characters per request — `
      + 'so the requests Story Studio will actually submit cannot be priced. They are not sub-split to force a quote, '
      + `because that would price work nobody is billed for. The published rate above stands: ${modelRate.value.text}, `
      + `with a minimum of ${formatCredits(result.minimum_credits)} per job.${said}`
  }
  return `GenStudio could not quote this narration.${said}`
})

async function refreshQuote() {
  narrationQuote.value = null
  quoteError.value = ''
  if (!quoteEligible.value || !form.episode_id) return
  quoting.value = true
  try {
    // Quote exactly what Generate would send: this episode, this model, this
    // voice, this speed, these sections. The split happens where generation's
    // split happens, so the parts priced are the parts billed.
    narrationQuote.value = await quoteNarration(slug.value, form.episode_id, {
      model: form.model,
      voice: form.voice!,
      sections: effectiveSections.value.length ? effectiveSections.value.join(',') : 'all',
      // Exactly what submit() sends: a model publishing no speed control is
      // generated at 1, so it must be quoted at 1 too.
      speed: supportsSpeed.value ? form.speed : 1,
    })
  } catch (e: any) {
    quoteError.value = e?.data?.detail || e?.message || 'GenStudio could not quote this narration.'
  } finally {
    quoting.value = false
  }
}
// A quote belongs to one exact (model, voice, speed, episode, selection). Any
// change voids the WHOLE quote — every part — never just the part that moved.
watch([() => form.model, () => form.voice, () => form.speed, () => form.episode_id, effectiveSections], () => {
  narrationQuote.value = null
  quoteError.value = ''
})

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
  if (!selectedVoiceCompatible.value) return 'Pick a voice this model can currently generate with.'
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
  apply: (data) => {
    if (!data?.form) return
    Object.assign(form, data.form)
    // A preset restores a SELECTION. The catalogue watcher above clears it if
    // GenStudio no longer publishes that model, and VoicePicker clears a voice
    // the model does not serve.
  },
  // Section selection belongs to the current episode, never to a reusable
  // voice/model preset. This also strips stale `sections` from old presets
  // before apply, so the selector can auto-pick every missing section.
  excludeKeys: ['episode_id', 'episodeId', 'episode', 'title', 'sections', 'max_chunk_chars'],
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
  await Promise.all([
    applyAudioFormatDefaultsIfNoPreset(),
    audioPresets.load(),
    loadTtsModels(),
    refreshGenstudioAccess(),
  ])
})


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
    showError(e?.data?.detail || 'Audio repair failed — GenStudio no longer has a recoverable result for this job.')
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
    showError('GenStudio cannot currently generate with the selected voice. Pick another from the voice list.')
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
  // A model that publishes no speed control gets none. Sending a pace it never
  // advertised would be Story Studio asserting a capability GenStudio did not.
  if (!supportsSpeed.value) payload.speed = 1
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

/* One row per TTS job GenStudio quoted. The list is the point: it shows the
   narration is submitted — and billed — in parts, not as one request. */
.quote-parts {
  list-style: none;
  margin: 6px 0 0;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
}
.quote-part {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 4px 12px;
  padding: 5px 12px;
}
.quote-part + .quote-part { border-top: 1px solid var(--border); }
.quote-part-name { font-weight: 500; }

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
.field-hint { color: var(--text-muted); font-size: var(--font-xs); font-weight: 400; margin-left: 4px; }

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
.generation-mode-option .text-muted { display: block; font-size: var(--font-xs); color: var(--text-muted); margin-top: 2px; }

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
