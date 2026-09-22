<!--
  v1.0.143+ — Scene Plan page real content.
  Three-stage flow: deterministic timeline, visual prompts, optional motion.

  Surfaces drift detection: if the audio merge gap changed since the
  stitched SRT was built, prompt for re-stitch. If the stitched SRT
  changed since the timeline was built, prompt for deterministic repair.

  v1.0.144's Scene Review page reads the saved scene_plan.json to
  render the per-scene approval grid.
-->
<template>
  <div class="workspace-page scene-plan-workspace">
    <WorkspaceHero
      eyebrow="Narration-timed workflow"
      title="Scene Plan"
      description="Build narration timing without an LLM, then create detailed visual prompts in durable packs and add motion only when the episode needs it."
    >
      <template #aside>
        <div class="workspace-metrics">
          <span class="workspace-metric"><strong>{{ plan?.scenes?.length || 0 }}</strong> scenes</span>
          <span class="workspace-metric" :data-tone="visualPendingCount ? 'warning' : 'success'">
            <strong>{{ visualDoneCount }}/{{ plan?.scenes?.length || 0 }}</strong> visual prompts
          </span>
          <span class="workspace-metric" :data-tone="form.generate_motion_prompts ? 'info' : undefined">
            <strong>{{ form.generate_motion_prompts ? motionDoneCount : 'Off' }}</strong> motion
          </span>
        </div>
      </template>
    </WorkspaceHero>

    <div class="workspace-command-surface">
      <TopActionBar
        :project-slug="slug"
        v-model:episode-id="episodeId"
        filter-field="scene_plan"
        :presets="planPresets"
        :generate-label="headerPrimaryLabel"
        :generate-loading-label="headerPrimaryLoadingLabel"
        :generate-loading="planning || planJobActive"
        :generate-disabled="headerPrimaryDisabled"
        :generate-status="headerPrimaryStatus"
        @generate="runHeaderPrimaryAction"
      >
        <template #actions>
          <button
            v-if="plan?.scenes?.length"
            class="btn btn-secondary"
            :disabled="!canPlan || planning || planJobActive"
            :title="`${timelineBuiltLabel}. Rebuilding clears the current visual and motion prompts and asks for confirmation first.`"
            @click="planScenes"
          >
            1. Rebuild timeline
          </button>
        </template>
      </TopActionBar>
    </div>

    <InheritedLlmLineupNotice :project-slug="slug" />

    <EpisodeVisualSource
      v-if="episodeId"
      :slug="slug"
      :episode-id="episodeId"
      :source="episodeVisualSource"
      @changed="episodeVisualSource = $event"
    />
    <p v-if="visualSourceError" role="alert" class="validation-msg">{{ visualSourceError }}</p>
    <VisualTimingMotion
      v-if="episodeId && episodeVisualSource === 'scene_plan'"
      ref="visualTimingMotion"
      id="visual-timing"
      :episode-id="episodeId"
      :scenes="plan?.scenes || []"
      :plan-pacing="plan?.pacing"
      @saved="applyVisualSettings"
    />
    <p v-if="visualPresetNotice" role="status" class="text-muted text-sm">{{ visualPresetNotice }}</p>
    <p v-if="visualSettingsError" role="alert" class="validation-msg">{{ visualSettingsError }}</p>

    <!-- Step 1: Subtitles (created + stitched in the Subtitles workspace) -->
    <WorkspaceSection
      eyebrow="Prerequisite"
      title="1. Subtitles"
      description="Scene timing consumes the verified global subtitle timeline created in the Subtitles workspace."
    >
      <div v-if="statusLoading" class="text-muted text-sm mt-2">Checking this episode's readiness…</div>
      <div v-else-if="statusLoadError" class="validation-msg text-sm mt-2" role="alert">
        ⚠ Could not check this episode's readiness: {{ statusLoadError }}
        <button type="button" class="btn btn-sm btn-ghost ml-2" @click="retryStatus">Retry</button>
      </div>
      <div v-else-if="!episodeId" class="text-muted text-sm mt-2">Pick an episode to check readiness.</div>
      <div v-else-if="!status" class="validation-msg text-sm mt-2" role="alert">
        ⚠ Episode readiness is unavailable. Retry to check the prerequisites before planning.
        <button type="button" class="btn btn-sm btn-ghost ml-2" @click="retryStatus">Retry</button>
      </div>
      <div v-else-if="!status.audio_merged" class="validation-msg text-sm mt-2">
        ⚠ Audio Assembly hasn't run for this episode yet. It's needed before
        subtitles + stitching (provides per-section durations + the gap).
      </div>
      <div v-else class="mt-2">
        <div class="text-sm text-muted">
          Audio merged with gap = <strong>{{ status.audio_merge_gap_s }}s</strong>.
          <span v-if="status.stitched_srt && subtitleTimelineComplete">
            Stitched SRT ready:
            <strong>{{ status.stitched_srt.meta?.total_cues ?? '?' }} cues</strong>
            across
            <strong>{{ status.stitched_srt.meta?.sections?.length ?? '?' }} section(s)</strong>,
            <strong>{{ status.stitched_srt.meta?.total_duration_sec?.toFixed(1) ?? '?' }}s</strong> total. ✓
          </span>
          <span v-else-if="status.stitched_srt">Stitched SRT is incomplete.</span>
          <span v-else>No stitched SRT yet.</span>
        </div>
        <!-- v1.0.797 — which words the planner will actually read. Whisper
             re-spells names it has never seen and invents words in silence, so
             planning reads a corrected transcript (its timings, your script's
             words) whenever the two demonstrably agree. Shown rather than left
             implicit: a silent correction is one nobody can audit. -->
        <div v-if="status.transcript_source?.corrected" class="text-sm text-muted mt-2">
          Planning reads your script's words on Whisper's timings —
          <strong>{{ status.transcript_source.cues_rewritten ?? 0 }}</strong> cue(s) corrected,
          <strong>{{ status.transcript_source.cues_dropped ?? 0 }}</strong> hallucinated cue(s) dropped,
          <strong>{{ status.transcript_source.cues_out ?? 0 }}</strong> of
          <strong>{{ status.transcript_source.cues_in ?? 0 }}</strong> kept. Timings are unchanged
          and your original transcript is untouched. ✓
        </div>
        <div
          v-if="status.transcript_source?.corrected && (status.transcript_source.refused_chapters?.length || 0) > 0"
          class="validation-msg text-sm mt-2"
        >
          <p v-for="chapter in status.transcript_source.refused_chapters" :key="chapter.slug">
            ⚠ {{ refusedChapterMessage(chapter) }}
          </p>
        </div>
        <div v-if="!status.stitched_srt" class="validation-msg text-sm mt-2">
          ⚠ Stitch the subtitles first —
          <NuxtLink :to="`/projects/${slug}/subtitles`" class="inline-link">open Subtitles → "Stitch into the timeline"</NuxtLink>.
        </div>
        <div v-else-if="missingSubtitleSections.length" class="validation-msg validation-msg-strong text-sm mt-2">
          ⚠ <strong>Do not rebuild or re-plan yet.</strong>
          Audio exists but subtitles are missing for
          <strong>{{ missingSubtitleSections.join(', ') }}</strong>.
          <NuxtLink :to="subtitleLink(missingSubtitleSections[0])" class="inline-link">Open the first affected chapter in Subtitles</NuxtLink>,
          then stitch again. The current long scene crosses narration the app could not see.
        </div>
        <div v-else-if="blockingSubtitleCueGaps.length" class="validation-msg validation-msg-strong text-sm mt-2">
          ⚠ <strong>Do not rebuild or re-plan yet.</strong>
          The stitched timeline has an interval with no subtitle cues
          <template v-if="blockingSubtitleGapSections.length">in <strong>{{ blockingSubtitleGapSections.join(', ') }}</strong>.</template>
          <template v-else>in an unmapped section (such as an Intro).</template>
          <NuxtLink :to="subtitleLink(blockingSubtitleGapSections[0])" class="inline-link">Open Subtitles</NuxtLink>,
          then transcribe or correct it and stitch again.
        </div>
        <div v-else-if="status.stitched_srt?.drifts_from_current_merge" class="validation-msg text-sm mt-2">
          ⚠ Stitched SRT was built with a different gap
          (<strong>{{ status.stitched_srt.meta?.gap_duration_s }}s</strong>)
          than the current merge (<strong>{{ status.audio_merge_gap_s }}s</strong>) —
          <NuxtLink :to="`/projects/${slug}/subtitles`" class="inline-link">re-stitch in Subtitles</NuxtLink>
          to fix scene-timing drift.
        </div>
        <!-- v1.0.250 — content staleness: subtitles re-transcribed after the
             last stitch. Planning now would reuse the OLD timeline. -->
        <div v-else-if="status.stitched_srt?.stale_vs_subtitles" class="validation-msg text-sm mt-2">
          ⚠ Your subtitles were re-transcribed <strong>after</strong> the last stitch — the stitched SRT (and any plan built from it) is out of date.
          <NuxtLink :to="`/projects/${slug}/subtitles`" class="inline-link">re-stitch in Subtitles</NuxtLink>,
          then re-run the plan so it picks up the new audio.
        </div>
        <!-- v1.2.2 — text quality of the exact transcript the planner will read.
             This is the surface where corruption costs money rather than looks:
             Scene Plan feeds each scene's narration verbatim to the model that
             writes the image prompts, so a hallucinated block buys wrong
             pictures. Advisory — planning stays available, because a person may
             judge the lines harmless and proceed. -->
        <SubtitleQualityWarning
          :quality="status.transcript_source?.quality"
          subject="The transcript this plan will be built from"
          consequence="Scene Plan feeds this text to the model that writes your image prompts, so garbled lines can buy wrong pictures."
        >
          <template #actions>
            <NuxtLink :to="`/projects/${slug}/subtitles`" class="btn btn-sm">Review in Subtitles</NuxtLink>
          </template>
        </SubtitleQualityWarning>
      </div>
    </WorkspaceSection>

    <!-- Step 2: Plan options -->
    <WorkspaceSection
      eyebrow="Configuration"
      title="2. Scene workflow settings"
      description="Choose how Story Studio interprets the episode. Timeline construction is deterministic; GenStudio handles prompt batches."
    >
      <div class="scene-workflow-grid mt-2">
        <div class="scene-setting-card scene-setting-model">
          <ModelSelector ref="modelSelector" v-model="form.model" :project-slug="slug" label="Visual & motion prompt model" @model-meta="selectedModelMeta = $event" />
          <!-- Published live per model. An estimate for transparency: token
               budgets are never converted into a character limit, because
               characters per token differ by language (Khmer especially). -->
          <dl class="model-budget">
            <div><dt>Context window</dt><dd>{{ contextWindowLabel }} tokens</dd></div>
            <div><dt>Output allowance</dt><dd>{{ outputAllowanceLabel }} tokens</dd></div>
            <div><dt>Available input budget at this setting</dt><dd>{{ availableInputBudgetLabel }} tokens</dd></div>
          </dl>
          <p class="model-budget-note">Estimated from the limits GenStudio publishes for this model. GenStudio validates every request.</p>
          <label v-if="status?.research_available" class="scene-inline-toggle text-sm">
            <input type="checkbox" v-model="form.use_research" />
            Include <code>research.json</code> as optional context
          </label>
          <span v-else class="text-muted text-xs">Research context is unavailable; prompt generation continues without it.</span>
        </div>

        <div class="scene-setting-card">
          <div class="scene-setting-head">
            <strong>Opening visuals</strong>
            <span>{{ measuredOpeningLabel }}</span>
          </div>
          <p v-if="!measuredOpening" class="scene-setting-help">Measuring your Video Assembly opening clips…</p>
          <p v-else-if="measuredOpening.seconds > 0" class="scene-setting-help">
            Measured from your Video Assembly clips: {{ measuredOpening.breakdown }}. Building the timeline
            reserves exactly this, so the first scene appears the moment the opening ends and every scene
            sits on the narration it was planned against.
          </p>
          <p v-else class="scene-setting-help">
            No opening clip is enabled in Video Assembly, so nothing is reserved — story scenes start at the
            first second.
          </p>
          <p v-if="measuredOpening?.unresolved?.length" class="scene-setting-warn">
            Not counted: {{ measuredOpening.unresolved.join(', ') }}. These will not play on this Mac either,
            so fix them in Video Assembly and build the timeline again.
          </p>
          <p class="scene-setting-help">
            Change the opening in <NuxtLink :to="`/projects/${slug}/video-assembly`">Video Assembly</NuxtLink>,
            then build the timeline again. Nothing to type here — the length comes from the clips themselves.
          </p>
        </div>

        <div class="scene-setting-card">
          <div class="scene-setting-head">
            <strong>Prompt batches</strong>
            <span>Model-aware</span>
          </div>
          <!-- This line used to claim Automatic "uses the selected GenStudio
               model’s published output limit". It did not: a hardcoded 50-scene
               cap sat on top of the derivation and bound for every model
               publishing 20,000 output tokens or more. The cap is gone, and the
               copy now states the two things that actually decide the number. -->
          <p v-if="hasPublishedPromptBudget" class="scene-setting-help">
            Automatic sends this channel’s default of {{ promptBatchSizeDefault }} scenes per request, reduced only if
            the selected GenStudio model cannot return that many complete in one response. Its published output
            limit is the only ceiling — {{ maximumPromptPackSize.toLocaleString() }} scenes on the model chosen now.
          </p>
          <p v-else-if="hasUnpublishedExplicitPromptBudget" class="scene-setting-help">
            This model publishes no output ceiling. Story Studio sends your selected allowance of up to
            {{ effectivePromptTokenBudget.toLocaleString() }} output tokens and sizes this batch from that allowance;
            GenStudio still decides when the response ends.
          </p>
          <p v-else-if="hasSelectedPromptModel" class="scene-setting-help">
            This model publishes no output ceiling. Story Studio omits <code>max_output_tokens</code> and uses your
            configured default of {{ promptBatchSizeDefault }} scenes per request; GenStudio decides when the response ends.
          </p>
          <p v-else class="scene-setting-help">Choose a prompt model to see its published output allowance and batch size.</p>
          <div v-if="hasSelectedPromptModel" class="scene-batch-summary">
            <span><strong>{{ effectivePromptPackSize }} scenes</strong> per request</span>
            <span v-if="hasPublishedPromptBudget">up to {{ effectivePromptTokenBudget.toLocaleString() }} output tokens</span>
            <span v-else-if="hasUnpublishedExplicitPromptBudget">up to {{ effectivePromptTokenBudget.toLocaleString() }} output tokens · user-chosen allowance</span>
            <span v-else>no output-token limit is sent</span>
          </div>
          <!-- Shown when the batch may outlast the request, never when it will
               not. It warns and stops there: the batch is still sent exactly as
               chosen. -->
          <p v-if="promptBatchTimeoutWarning" class="scene-setting-warn">{{ promptBatchTimeoutWarning }}</p>
          <details class="scene-advanced-batches">
            <summary>Advanced batch controls</summary>
            <div class="scene-compact-fields mt-1">
              <div class="form-group">
                <label>Output allowance</label>
                <select v-model="form.prompt_max_tokens" class="select" :disabled="!hasSelectedPromptModel">
                  <option value="auto">{{ hasPublishedPromptBudget ? 'Automatic · model maximum' : hasSelectedPromptModel ? 'Not published · omitted' : 'Choose a model' }}</option>
                  <option v-if="hasUnpublishedExplicitPromptBudget" :value="effectivePromptTokenBudget">User-chosen · {{ effectivePromptTokenBudget.toLocaleString() }} tokens</option>
                  <option v-for="budget in availableOutputBudgets" :key="budget" :value="budget">{{ budget.toLocaleString() }} tokens</option>
                </select>
              </div>
              <div class="form-group">
                <label>Scenes per request</label>
                <select v-model="promptPackPickerValue" class="select" :disabled="!hasSelectedPromptModel">
                  <option value="auto">{{ hasSelectedPromptModel ? `Automatic · ${automaticPromptPackSize} scenes` : 'Choose a model' }}</option>
                  <option v-for="size in availablePromptPackPresets" :key="size" :value="String(size)">{{ size }} scenes</option>
                  <option value="custom">Custom…</option>
                </select>
                <!-- No :max. A typed number is accepted as typed; if the
                     chosen model cannot return it, that is SAID below rather
                     than silently rewritten to a smaller one. -->
                <div v-if="promptPackPickerValue === 'custom'" class="scene-pack-custom">
                  <input v-model.number="customPromptPackSize" class="input" type="number" min="1" step="1" @change="applyCustomPromptPackSize" />
                  <span v-if="hasPublishedPromptBudget" class="text-xs text-muted">Any whole number. This model returns up to {{ maximumPromptPackSize.toLocaleString() }} complete.</span>
                  <span v-else-if="hasUnpublishedExplicitPromptBudget" class="text-xs text-muted">Any whole number. Story Studio sizes this request from your selected {{ effectivePromptTokenBudget.toLocaleString() }} output tokens.</span>
                  <span v-else-if="hasSelectedPromptModel" class="text-xs text-muted">Any whole number. This model publishes no output ceiling, so Story Studio will send no token limit.</span>
                  <span v-else class="text-xs text-muted">Choose a model before checking this batch size.</span>
                </div>
                <p v-if="promptPackReductionNotice" class="scene-setting-warn">{{ promptPackReductionNotice }}</p>
              </div>
            </div>
            <!-- The three numbers behind every figure on this card, saved per
                 channel. Nothing here has a maximum in code: if a future run
                 wants 2,000 scenes in one request and the model can return
                 them, that is the operator’s call to make, not a constant’s. -->
            <div class="scene-compact-fields mt-1">
              <div class="form-group">
                <label>Tokens reserved per scene</label>
                <input v-model.number="promptTokensPerScene" class="input" type="number" min="1" step="1" @change="saveBatchTuning" />
              </div>
              <div class="form-group">
                <label>Safety fraction of the allowance</label>
                <input v-model.number="promptSafetyFraction" class="input" type="number" min="0.01" max="1" step="0.05" @change="saveBatchTuning" />
              </div>
              <div class="form-group">
                <label>Default scenes per request</label>
                <input v-model.number="promptBatchSizeDefault" class="input" type="number" min="1" step="1" @change="saveBatchTuning" />
              </div>
            </div>
            <p class="scene-setting-help mt-1">
              Saved for this channel. Defaults are {{ DEFAULT_TOKENS_PER_SCENE }} tokens per scene, a
              {{ DEFAULT_OUTPUT_SAFETY_FRACTION }} safety fraction and {{ DEFAULT_PROMPT_BATCH_SIZE }} scenes per request.
              {{ DEFAULT_PROMPT_BATCH_SIZE }} is a speed judgement, not a token limit — a request has
              {{ languageTimeoutMinutes }} minutes to come back, and the large models’ real speed has not been
              measured yet. Raise it once it has, or give requests longer in This Mac → Throughput.
              <button type="button" class="btn btn-ghost btn-xs" @click="resetBatchTuning">Reset to defaults</button>
            </p>
            <p v-if="hasSelectedPromptModel" class="scene-setting-help mt-1">Context: {{ selectedModelContextLabel }} · {{ hasPublishedPromptBudget ? 'Output is the response limit, so it—not context—sets the safe batch size.' : hasUnpublishedExplicitPromptBudget ? 'Your selected output allowance, not context, caps the safe batch size.' : 'No output limit is published or selected; the batch is the channel setting, not a model guarantee.' }}</p>
          </details>
        </div>

        <!-- Prompt length. An LLM writes these prompts; a separately chosen
             image model renders them. Every number offered here is GenStudio's
             own published `max_prompt_characters` — no ladder is hardcoded —
             and it is given to the writer as a ceiling, never as a length to
             fill. Nothing is truncated; over-length prompts are flagged amber
             and left exactly as written. -->
        <div class="scene-setting-card">
          <div class="scene-setting-head">
            <strong>Prompt length</strong>
            <span>{{ promptCharCapSummary }}</span>
          </div>
          <div class="form-group">
            <label>Intended image model <span class="text-muted text-xs">— writing hint</span></label>
            <select v-model="form.intended_image_model" class="select">
              <option value="">Not chosen yet — no limit</option>
              <option
                v-for="model in usableImageModels"
                :key="model.id"
                :value="model.id"
                :title="imageModelCapHint(model)"
              >
                {{ model.display_name }} · {{ imageModelCapLabel(model) }}
              </option>
            </select>
            <p class="scene-setting-help">
              Prompts are shaped to suit this model. It only sets the character limit below — you can still render with a
              different model in Scene Review, and this does not change what Scene Review is set to.
            </p>
          </div>
          <div class="form-group">
            <label>Character limit</label>
            <select v-model="promptCharCapPickerValue" class="select">
              <option value="auto">Auto · {{ autoPromptCharCapLabel }}</option>
              <option value="none">No limit</option>
              <option v-for="cap in publishedPromptCharCaps" :key="cap" :value="String(cap)">{{ cap.toLocaleString() }} characters</option>
              <option value="custom">Custom…</option>
            </select>
            <div v-if="promptCharCapPickerValue === 'custom'" class="scene-pack-custom">
              <input v-model.number="customPromptCharCap" class="input" type="number" min="1" step="1" @change="applyCustomPromptCharCap" />
              <span class="text-xs text-muted">characters</span>
            </div>
          </div>
          <p v-if="promptCharCapExceedsModel" class="prompt-cap-notice">
            ⚠ {{ effectivePromptCharCap.toLocaleString() }} characters is above the
            {{ intendedImageModelCap.toLocaleString() }} that {{ intendedImageModel?.display_name }} publishes — prompts written to
            this limit can still be refused at render time.
          </p>
          <p v-if="overCapPromptCount" class="prompt-cap-notice">
            ⚠ {{ overCapPromptCount }} written prompt{{ overCapPromptCount === 1 ? ' is' : 's are' }} over this limit. Every one is
            saved in full — generation is not blocked.
          </p>
          <p class="scene-setting-help">
            A ceiling, not a length to reach: a scene that reads best in 500 characters stays at 500. A smaller limit also
            keeps prompts — and the language bill for writing them — shorter. Nothing is ever shortened for you.
          </p>
        </div>

        <div class="scene-setting-card scene-creative-card">
          <div class="scene-setting-head">
            <strong>Visual interpretation</strong>
            <span>{{ creativeProfileMeta.label }} · {{ creativeProfileMeta.usage }}</span>
          </div>
          <p class="scene-setting-help">Art style stays in Character Sheet. Choose how narration becomes imagery; one strategy is assigned to each scene before existing prompt packs run.</p>
          <div class="creative-profile-grid" role="radiogroup" aria-label="Visual interpretation profile">
            <button
              v-for="profile in CREATIVE_PROFILES"
              :key="profile.id"
              type="button"
              class="creative-profile"
              :class="{ active: form.creative_profile === profile.id }"
              role="radio"
              :aria-checked="form.creative_profile === profile.id"
              @click="selectCreativeProfile(profile.id)"
            >
              <strong>{{ profile.label }}</strong>
              <span>{{ profile.usage }}</span>
            </button>
          </div>
          <div class="scene-creative-controls">
            <fieldset class="form-group intensity-picker">
              <legend>Creative intensity <strong>{{ creativeIntensityLabel }}</strong></legend>
              <div role="radiogroup" aria-label="Creative intensity" class="intensity-options">
                <button v-for="(label, index) in CREATIVE_INTENSITY_LABELS" :key="label" type="button" class="intensity-option" :class="{ active: form.creative_intensity === index + 1 }" role="radio" :aria-checked="form.creative_intensity === index + 1" @click="form.creative_intensity = index + 1">
                  {{ label }}
                </button>
              </div>
            </fieldset>
            <label class="form-group">
              <span>Recurring motifs <span class="text-muted text-xs">optional</span></span>
              <input v-model="form.creative_motifs" class="input" placeholder="e.g. lanterns, paths, gold light, open windows" />
            </label>
            <label class="form-group">
              <span>Avoided imagery <span class="text-muted text-xs">optional</span></span>
              <input v-model="form.creative_avoid_cliches" class="input" placeholder="e.g. stock prayer poses, floating text, repeated doorways" />
            </label>
          </div>
          <template v-if="form.creative_profile === 'custom'">
            <div class="creative-strategy-picker">
              <span class="text-xs text-muted">Choose the strategies this custom profile may use.</span>
              <button
                v-for="strategy in CREATIVE_STRATEGIES"
                :key="strategy.id"
                type="button"
                class="creative-strategy-chip"
                :class="{ active: form.creative_strategies.includes(strategy.id) }"
                :aria-pressed="form.creative_strategies.includes(strategy.id)"
                @click="toggleCreativeStrategy(strategy.id)"
              >{{ strategy.label }}</button>
            </div>
            <label class="form-group">
              <span>Custom direction <span class="text-muted text-xs">optional</span></span>
              <textarea v-model="form.creative_custom_direction" class="textarea" rows="2" placeholder="Describe the visual thinking you want this channel to favor across the episode." />
            </label>
          </template>
        </div>

        <div class="scene-setting-card">
          <div class="scene-setting-head">
            <strong>Avoid readable text in images</strong>
            <label class="scene-switch-label">
              <input v-model="form.avoid_legible_text" type="checkbox" @change="setAvoidLegibleText(form.avoid_legible_text)" />
              {{ form.avoid_legible_text ? 'On' : 'Off' }}
            </label>
          </div>
          <p class="scene-setting-help">
            Fast local models render scrolls, signs, and inscriptions as confident-looking gibberish
            instead of real words. With this on, scene prompts describe that lettering as texture rather
            than specific words, so documents still look right without the garbled text. If this project
            renders scenes on a higher-quality model that gets real words correct, turn it off. Thumbnail
            titles are never affected — they always ask for legible text.
          </p>
        </div>

        <div class="scene-setting-card">
          <div class="scene-setting-head">
            <strong>Style and guidance</strong>
            <NuxtLink :to="`/projects/${slug}/character-sheet`" class="link">Edit Character Sheet</NuxtLink>
          </div>
          <!-- v1.2.6 — the selected look is NAMED here, not just quoted. The
               Character Sheet shows a name, a category and a preview; this page
               used to show the style bible prose alone, so a wall of art
               direction gave no way to tell which style produced it. -->
          <div class="character-style-source">
            <span class="character-style-label">Style from Character Sheet</span>
            <template v-if="characterSheetStyleBible">
              <div class="character-style-identity">
                <strong>{{ episodeStyleIdentity.name }}</strong>
                <span v-if="episodeStyleIdentity.category" class="character-style-tag">{{ episodeStyleIdentity.category }}</span>
              </div>
              <p v-if="episodeStyleIdentity.note" class="character-style-note">{{ episodeStyleIdentity.note }}</p>
              <p>{{ characterSheetStyleBible }}</p>
            </template>
            <template v-else-if="savedDefaultStyleBible">
              <div class="character-style-identity">
                <strong>{{ channelStyleIdentity.name }}</strong>
                <span v-if="channelStyleIdentity.category" class="character-style-tag">{{ channelStyleIdentity.category }}</span>
              </div>
              <p v-if="channelStyleIdentity.note" class="character-style-note">{{ channelStyleIdentity.note }}</p>
              <p class="text-muted">
                This episode has no Style Bible of its own, so the channel default below is used.
              </p>
            </template>
            <p v-else class="text-muted">No Style Bible is set for this episode yet.</p>
          </div>
          <!-- v1.0.795 — the channel's standing look, saved on the project. An
               episode's own Style Bible still wins; this only fills the silence
               that otherwise meant no art direction reached the prompt writer. -->
          <div class="form-group">
            <label>
              Channel default style
              <span class="text-muted text-xs">— used by every episode with no Style Bible of its own</span>
            </label>
            <!-- No maxlength attribute: this page must never carry a static
                 character limit (see modelTokenBudget.test.ts — characters per
                 token differ by language). The ceiling is derived from the
                 SELECTED image model's published `max_prompt_characters` and is
                 shown beside the box; a save that clips says so (owner
                 decision #2, 2026-09-20). -->
            <textarea
              v-model="defaultStyleBible"
              class="textarea"
              rows="4"
              placeholder="e.g. Painterly historical illustration — an aged oil painting, never a photograph. Visible brushwork, muted earth tones, soft edges, warm directional light."
            />
            <div class="default-style-actions">
              <button
                class="btn btn-sm"
                :disabled="savingDefaultStyleBible || defaultStyleBible.trim() === savedDefaultStyleBible"
                @click="saveDefaultStyleBible"
              >
                {{ savingDefaultStyleBible ? 'Saving…' : 'Save channel default' }}
              </button>
              <span
                class="prompt-char-badge"
                :class="`is-${defaultStyleBibleTone}`"
                :title="defaultStyleBibleLength.overCap
                  ? `${defaultStyleBibleLength.overage.toLocaleString()} characters past the ceiling in force. Saving trims the end and tells you it did.`
                  : `${defaultStyleBibleLength.characters.toLocaleString()} characters written.`"
              >{{ defaultStyleBibleLabel }}</span>
              <span v-if="characterSheetStyleBible" class="text-muted text-xs">
                This episode has its own Style Bible, so it uses that instead.
              </span>
            </div>
            <p class="scene-setting-help">{{ defaultStyleBibleCapNote }}</p>
            <p class="scene-setting-help">
              Set this once and every future episode inherits it. With no style at all, prompts carry no art
              direction and the image model falls back to rendering a photograph — which is how modern
              objects reach a historical scene, since photographic references of a historical place are
              modern photographs of it. Naming a medium makes the model compose the picture instead.
            </p>
          </div>
          <div class="form-group">
            <label>Custom instructions <span class="text-muted text-xs">— this episode only</span></label>
            <textarea
              v-model="form.custom_instructions"
              class="textarea"
              rows="2"
              placeholder="e.g. keep the protagonist off-centre and the same red scarf throughout"
            />
            <p v-if="episodeGuidanceNotice" role="status" class="text-muted text-xs">{{ episodeGuidanceNotice }}</p>
          </div>
          <!-- X-06 (owner decision 2026-09-22) — the reusable box. It is
               deliberately a separate field with its own label: this text is
               carried by a Scene Plan preset and may be applied to another
               episode, while the box above belongs to the episode on screen. -->
          <div class="form-group guidance-reusable">
            <label>Reusable guidance <span class="text-muted text-xs">— saved in presets</span></label>
            <textarea
              v-model="form.reusable_guidance"
              class="textarea"
              rows="2"
              placeholder="e.g. one subject per scene; never render legible text"
            />
            <p class="scene-setting-help">
              Saved into a Scene Plan preset and applied only when you apply that preset to an
              episode. Used for this episode alongside the instructions above. It is never written
              to the project settings and never applies on its own.
            </p>
          </div>
        </div>
      </div>

      <!-- v1.0.357 — the Plan preset moved to the page-level preset row at the
           top (TopActionBar), matching every other generator tab. -->
    </WorkspaceSection>

    <WorkspaceSection
      eyebrow="Execution"
      title="3-stage scene workflow"
      description="Run each stage independently. Completed prompts are saved immediately by stable scene ID, so retries only repair unfinished work."
    >
      <div class="stage-grid mt-2">
        <div class="stage-step">
          <strong>1. Timeline</strong>
          <span>{{ plan?.scenes?.length || 0 }} scenes · no LLM</span>
          <span class="stage-built">{{ timelineBuiltLabel }}</span>
          <span v-if="plan?.pacing" class="stage-setting">
            Saved plan: {{ pacingSummary(plan.pacing) }}
          </span>
          <span v-if="continuityPacing" class="stage-setting">
            Next build: {{ pacingSummary(continuityPacing) }}
            <a href="#visual-timing">Change</a>
          </span>
          <button class="btn btn-secondary mt-2" :disabled="!canPlan || planning || planJobActive" @click="planScenes">
            {{ plan?.scenes?.length ? 'Rebuild timeline' : 'Build timeline' }}
          </button>
        </div>
        <div class="stage-step">
          <strong>2. Visual prompts</strong>
          <span>{{ visualDoneCount }}/{{ plan?.scenes?.length || 0 }} ready</span>
          <span class="stage-setting">Full detail · 110–150 words per scene</span>
          <div class="flex gap-1 mt-2 flex-wrap">
            <button v-if="hasSelectedPromptModel" class="btn btn-primary" :disabled="scenePlanGenerationUnavailable || !subtitleTimelineComplete || !form.model || !plan || !visualPendingCount || planning || planJobActive" @click="runPromptStage('visual', effectivePromptPackSize)">Next {{ effectivePromptPackSize }}</button>
            <button class="btn btn-secondary" :disabled="scenePlanGenerationUnavailable || !subtitleTimelineComplete || !form.model || !plan || !visualPendingCount || planning || planJobActive" @click="runPromptStage('visual')">All pending</button>
          </div>
          <small v-if="hasSelectedPromptModel">{{ effectivePromptPackSize }} scenes per GenStudio request. GenStudio queues and distributes eligible requests at your available concurrency.</small>
          <small v-else>Choose a prompt model to see the Next batch size. All pending remains available after a model is selected.</small>
        </div>
        <div class="stage-step" :class="{ optional: true }">
          <strong>3. Motion prompts <em>optional</em></strong>
          <span>{{ motionDoneCount }}/{{ motionTargetCount }} animated · {{ motionStillCount }} held still</span>
          <div v-if="form.generate_motion_prompts" class="flex gap-1 mt-2 flex-wrap">
            <button v-if="hasSelectedPromptModel" class="btn btn-primary" :disabled="scenePlanGenerationUnavailable || !subtitleTimelineComplete || !form.model || !motionPendingCount || planning || planJobActive" @click="runPromptStage('motion', effectivePromptPackSize)">Next {{ effectivePromptPackSize }}</button>
            <button class="btn btn-secondary" :disabled="scenePlanGenerationUnavailable || !subtitleTimelineComplete || !form.model || !motionPendingCount || planning || planJobActive" @click="runPromptStage('motion')">All pending</button>
          </div>
          <small v-if="form.generate_motion_prompts && hasSelectedPromptModel">Uses the same {{ effectivePromptPackSize }}-scene request size saved for visual prompts. Held-still scenes stay valid in final assembly without an image-to-video render.</small>
          <small v-else-if="form.generate_motion_prompts">Choose a prompt model to see a model-backed Next batch size. All pending remains available after a model is selected.</small>
          <small v-else>Skipped for this project. Still images remain valid through assembly.</small>
        </div>
      </div>
    </WorkspaceSection>

    <!-- Step 3: Plan + edit -->
    <section v-if="plan || planning" class="card workspace-section">
      <!-- v1.0.250 — the plan predates the current stitched SRT (you changed
           audio / re-stitched after this plan was generated). Re-run so it
           matches the new timeline. -->
      <!-- v1.4.0 — the remedy named here used to be wrong, and expensively so.
           It offered "Repair long scenes" (which only splits over-long scenes)
           or a full rebuild (which renumbers every scene and orphans the images
           already generated — 124 of them on one real episode). The action that
           actually fixes drifted timing while KEEPING every image, prompt and
           approval is Reconcile timings, and it was the one action the banner
           did not mention. -->
      <div v-if="status?.plan_stale_vs_stitched && !planning" class="validation-msg text-sm mb-2">
        ⚠ This plan is <strong>older than the current stitched subtitles</strong> — it was built from a previous audio/timeline.
        Use <strong>🎯 Reconcile timings</strong> below: it re-times these scenes against the current subtitles and keeps
        every scene's image, prompt and approval. Rebuild the timeline only if you intend to start the scenes over —
        it renumbers them and leaves your generated images unattached.
      </div>
      <div class="flex justify-between items-center">
        <h3>3. Scenes</h3>
        <div v-if="plan" class="flex gap-2 items-center">
          <span class="text-muted text-xs">
            {{ plan.scenes.length }} scene{{ plan.scenes.length === 1 ? '' : 's' }}
            · {{ plan.total_duration_sec?.toFixed(1) ?? '?' }}s total
            <span v-if="plan.research_used">· research used</span>
          </span>
          <button class="btn btn-sm btn-primary" :disabled="saving || !dirty" @click="savePlan">
            {{ saving ? 'Saving…' : (dirty ? 'Save' : 'Saved') }}
          </button>
          <Popover v-if="overlongSceneCount" placement="top">
            <button
              class="btn btn-sm btn-secondary"
              :disabled="repairingLongScenes || !!dirty || !subtitleTimelineComplete"
              :title="!subtitleTimelineComplete
                ? 'Transcribe and stitch every missing subtitle chapter first'
                : dirty ? 'Save your edits first' : 'Split abnormal long scenes against current subtitle cues; then generate only the new pending prompts.'"
              @click="repairLongScenes"
            >
              {{ repairingLongScenes ? 'Repairing…' : `✂ Repair ${overlongSceneCount} out-of-range scene${overlongSceneCount === 1 ? '' : 's'}` }}
            </button>
            <template #content>
              <div class="popover-title">Repair out-of-range scenes</div>
              <p><strong>Use when:</strong> one or more scenes exceed the selected continuity pacing maximum, when explicitly applying a new pace from Visual timing & motion.</p>
              <p><strong>What it does:</strong> splits only those ranges against the verified subtitle text at safe word boundaries. No LLM is used and unaffected prompts, images, and approvals stay in place.</p>
              <p><strong>Next:</strong> run Visual prompts → All pending, then generate the new missing images in Scene Review.</p>
            </template>
          </Popover>
          <Popover placement="top">
            <button
              class="btn btn-sm btn-secondary"
              :disabled="repairingCoverage || !!dirty"
              :title="dirty ? 'Save your edits first' : 'Restore narration ranges with no scene; large narrated gaps become cue-aligned pending scenes, not one frozen hold.'"
              @click="repairCoverage()"
            >
              {{ repairingCoverage ? 'Repairing…' : '🩹 Repair coverage' }}
            </button>
            <template #content>
              <div class="popover-title">Repair coverage</div>
              <p><strong>Use when:</strong> Scene Plan or Video Assembly reports uncovered narration before, between, or after scenes.</p>
              <p><strong>What it does:</strong> closes small timing gaps and restores larger narrated ranges as cue-aligned scenes. Newly restored scenes remain pending instead of repeating one image.</p>
              <p><strong>Next:</strong> generate any pending visual prompts and images. It is not needed when the only problem is timing drift.</p>
            </template>
          </Popover>
          <Popover placement="top">
            <button
              class="btn btn-sm btn-secondary"
              :disabled="reconciling || !!dirty"
              :title="dirty ? 'Save your edits first' : 'Re-anchor existing scenes to current subtitles after audio or subtitle timing changed; preserves scene assets.'"
              @click="reconcileTimings"
            >
              {{ reconciling ? 'Reconciling…' : '🎯 Reconcile timings' }}
            </button>
            <template #content>
              <div class="popover-title">Reconcile timings</div>
              <p><strong>Use when:</strong> audio was regenerated or subtitles were re-stitched and otherwise correct scenes now appear too early or too late.</p>
              <p><strong>What it does:</strong> text-matches each existing scene back to the current subtitles while preserving its ID, prompt, image, and approval.</p>
              <p><strong>Do not use for:</strong> a single long scene or missing prompts. Use the matching repair action instead.</p>
            </template>
          </Popover>
          <button
            class="btn btn-sm btn-danger"
            :disabled="deleting"
            @click="deletePlan"
          >
            {{ deleting ? 'Deleting…' : '✕ Delete plan' }}
          </button>
        </div>
      </div>

      <div v-if="planning" class="text-muted mt-2">
        <LoadingSpinner size="sm" /> LLM is planning — typically 20-60s
        depending on episode length + model speed. Watch the Jobs panel
        for progress.
      </div>

      <template v-else-if="plan">
        <div
          v-if="coverageNeedsRepair"
          class="validation-msg validation-msg-strong text-sm mt-2 coverage-warning"
        >
          <div>
            ⚠ <strong>{{ coverageGapLabel }} of narration has no planned scene.</strong>
            Video Assembly will stop rather than create black or frozen footage.
            <span v-if="coverageInternalGapCount">
              Found {{ coverageInternalGapCount }} gap{{ coverageInternalGapCount === 1 ? '' : 's' }} between scenes.
            </span>
          </div>
          <button
            class="btn btn-sm btn-primary"
            :disabled="repairingCoverage || !!dirty"
            @click="repairCoverage()"
          >
            {{ repairingCoverage ? 'Repairing…' : '🩹 Repair coverage now' }}
          </button>
        </div>
        <!-- The plan skipped the opening and recorded no reason, so this page's
             coverage check waves it through while Video Assembly refuses it.
             Shown here because this is the page that can act on it. -->
        <div
          v-if="uncreditedHeadGapSec"
          class="validation-msg validation-msg-strong text-sm mt-2 coverage-warning"
        >
          <div>
            ⚠ <strong>The first {{ uncreditedHeadGapLabel }} of narration has no planned scene.</strong>
            Scene 1 starts at {{ uncreditedHeadGapLabel }}, so Video Assembly will not render this episode —
            it has nothing to show over the opening. Everything from scene 1 onward is fine.
            <div class="text-muted text-xs mt-1">
              Either hold scene 1 across the opening (one image for {{ uncreditedHeadGapLabel }} — no new images
              needed), add an opening clip that long in Video Assembly Step 2, or re-run Scene Plan with the
              introduction included to plan real scenes for it.
            </div>
          </div>
          <button
            class="btn btn-sm btn-primary"
            :disabled="repairingCoverage || !!dirty"
            :title="dirty ? 'Save your edits first' : `Pull scene 1 back to 0:00 so its image holds for the whole ${uncreditedHeadGapLabel} opening. Every other scene keeps its timing.`"
            @click="repairCoverage(true)"
          >
            {{ repairingCoverage ? 'Covering…' : '⏮ Cover the opening' }}
          </button>
        </div>
        <!-- Plan health surfaces missing prompts and timeline defects without
             reviving the retired LLM scene-boundary planner. -->
        <div v-if="problemScenes.length" class="plan-health mt-2">
          <div class="plan-health-head">
            <span>
              ⚠ {{ problemScenes.length }} scene{{ problemScenes.length === 1 ? '' : 's' }} need attention
              <span class="text-muted text-xs">— missing/duplicated prompt, incomplete narration, or abnormal timing</span>
            </span>
            <div class="bulk-buttons" v-if="emptyPromptCount > 0">
              <button
                class="btn btn-sm btn-primary"
                :disabled="scenePlanGenerationUnavailable || !subtitleTimelineComplete || !form.model || planning || bulkReplan.active"
                :title="!form.model
                  ? 'Pick a model above first'
                  : `Regenerate the ${emptyPromptCount} missing or duplicated visual prompts. Time ranges and transcripts stay unchanged.`"
                @click="regenAllEmptyPrompts"
              >
                ✨ Repair {{ emptyPromptCount }} prompt{{ emptyPromptCount === 1 ? '' : 's' }}
              </button>
            </div>
          </div>

          <!-- Bulk progress strip — visible while the loop is running. -->
          <div v-if="bulkReplan.active" class="bulk-progress">
            <div class="bulk-progress-bar">
              <div
                class="bulk-progress-fill"
                :style="`width: ${bulkReplan.total > 0 ? Math.round((bulkReplan.completed / bulkReplan.total) * 100) : 0}%`"
              ></div>
            </div>
            <div class="bulk-progress-text">
              Repairing {{ bulkReplan.total }} prompt{{ bulkReplan.total === 1 ? '' : 's' }} in durable GenStudio packs ·
              {{ bulkReplan.completed }}/{{ bulkReplan.total }} done
              <button class="link-btn-danger" @click="cancelBulkReplan">Cancel</button>
            </div>
          </div>

          <div class="plan-health-list">
            <button
              v-for="p in problemScenes"
              :key="p.scene.id"
              class="plan-health-chip"
              :title="`Jump to scene #${p.index} — ${p.reasons.join(', ')}`"
              @click="jumpToScene(p.scene.id)"
            >
              #{{ p.index }} <span class="plan-health-why">{{ p.reasons.join(' · ') }}</span>
            </button>
          </div>
          <p class="text-muted text-xs mt-1">
            <template v-if="missingSubtitleSections.length">
              Fix the missing subtitle chapters first. Prompt generation and timeline repair are paused to protect this plan.
            </template>
            <template v-else>
              Use <strong>Prompt only</strong> for missing text prompts, or <strong>Repair long scenes</strong> for abnormal timing. Neither action uses the retired LLM boundary planner.
            </template>
          </p>
        </div>

        <ul class="scene-list mt-2">
          <li
            v-for="(scene, i) in renderedScenes"
            :id="`splan-scene-${scene.id}`"
            :key="scene.id"
            class="scene-row"
            :class="{ 'scene-row-problem': problemIds.has(scene.id) }"
          >
            <div class="scene-row-head">
              <strong>#{{ i + 1 }}</strong>
              <span class="text-muted text-xs">
                {{ scene.start_sec.toFixed(1) }}s → {{ scene.end_sec.toFixed(1) }}s
                ({{ (scene.end_sec - scene.start_sec).toFixed(1) }}s)
              </span>
              <span v-if="scene.boundary_reason" class="text-muted text-xs scene-boundary-reason">
                · {{ scene.boundary_reason }}
              </span>
              <span
                v-if="scene.creative_strategy"
                class="scene-strategy-badge"
                :title="`This scene's prompt uses the ${creativeStrategyLabel(scene.creative_strategy)} visual strategy.`"
              >{{ creativeStrategyLabel(scene.creative_strategy) }}</span>
              <!-- v1.0.336 — continuity only: who/what is in the shot. 'Character'
                   includes the guide; the others render WITHOUT him so he stays
                   selective. Drives the renderer's per-scene reference stack. -->
              <span
                v-if="continuityPacing"
                class="scene-type-pick"
                :class="`st-${scene.scene_type || 'character'}`"
                :title="(scene.scene_type && scene.scene_type !== 'character') || !scene.scene_type
                  ? 'What this scene shows. Only ‘Character’ includes the guide; the rest render without him.'
                  : 'Character scene — the guide appears here.'"
              >
                <select
                  :value="scene.scene_type || 'character'"
                  class="scene-type-select"
                  @change="setSceneType(scene, ($event.target as HTMLSelectElement).value)"
                >
                  <option v-for="t in SCENE_TYPE_OPTIONS" :key="t.value" :value="t.value">{{ t.emoji }} {{ t.label }}</option>
                </select>
                <span v-if="scene.scene_type_locked" class="scene-type-lock" title="You set this — kept during deterministic repairs.">🔒</span>
              </span>
            </div>
            <div class="form-group mt-1">
              <label class="text-xs text-muted">Transcript segment</label>
              <textarea
                v-model="scene.transcript_segment"
                class="textarea scene-textarea"
                rows="2"
                @input="markPlanDirty"
              />
            </div>
            <div class="form-group mt-1">
              <label class="text-xs text-muted prompt-length-label">
                <span>Visual prompt (sent to the image generator)</span>
                <!-- Live count for every prompt, against the ceiling in force.
                     Amber when over — a nudge, never a block. -->
                <span
                  class="prompt-char-badge"
                  :class="`is-${scenePromptLengthTone(scene)}`"
                  :title="scenePromptLength(scene).overCap
                    ? `${scenePromptLength(scene).overage.toLocaleString()} characters over the ${scenePromptLength(scene).cap.toLocaleString()}-character limit. Nothing was shortened — trim it, raise the limit, or render as-is.`
                    : effectivePromptCharCap
                      ? `${scenePromptLength(scene).characters.toLocaleString()} of ${effectivePromptCharCap.toLocaleString()} characters.`
                      : `${scenePromptLength(scene).characters.toLocaleString()} characters — no limit in force.`"
                >{{ scenePromptLengthLabel(scene) }} chars</span>
              </label>
              <textarea
                v-model="scene.visual_prompt"
                class="textarea scene-textarea"
                rows="2"
                @input="markPlanDirty"
              />
              <p v-if="scenePromptLength(scene).overCap" class="prompt-cap-notice">
                ⚠ {{ scenePromptLength(scene).overage.toLocaleString() }} characters over the
                {{ scenePromptLength(scene).cap.toLocaleString() }}-character limit. Saved in full — you can shorten it, raise the
                limit, or render it as-is.
              </p>
            </div>
            <!-- v1.0.468 — per-scene motion prompt (image-to-video instruction).
                 Editable inline; saved via set-motion-prompt; regen via the LLM. -->
            <div class="form-group mt-1">
              <label class="text-xs text-muted">🎬 Motion prompt (how this scene animates)</label>
              <textarea
                v-model="scene.motion_prompt"
                class="textarea scene-textarea"
                rows="2"
                placeholder="e.g. Slow push-in as mist drifts across the valley; the lantern flame flickers gently."
                @input="markPlanDirty"
                @blur="saveMotionPrompt(scene)"
              />
              <button
                class="btn-icon mt-1"
                :disabled="scenePlanGenerationUnavailable || !form.model || regenMotionId === scene.id || planning || !scene.visual_prompt?.trim()"
                :title="!form.model
                  ? 'Pick a model above first'
                  : !scene.visual_prompt?.trim()
                    ? 'Write the visual prompt first — the motion prompt animates that image'
                    : 'Regenerate this scene\'s motion prompt with the LLM (visual prompt + timing untouched)'"
                @click="regenMotionPrompt(scene)"
              >{{ regenMotionId === scene.id ? '⏳ Motion…' : '🎬 Regen motion' }}</button>
            </div>
            <div class="scene-row-actions mt-1">
              <NuxtLink
                v-if="sceneOverlapsMissingSubtitles(scene)"
                :to="subtitleLink(missingSubtitleSectionForScene(scene))"
                class="btn-icon"
                title="This scene crosses audio with no subtitles. Transcribe the named chapters and stitch again before repairing it."
              >Fix subtitles first</NuxtLink>
              <button
                class="btn-icon"
                :disabled="scenePlanGenerationUnavailable || !subtitleTimelineComplete || !form.model || regenPromptId === scene.id || planning || bulkReplan.active || !scene.transcript_segment?.trim()"
                :title="!subtitleTimelineComplete
                  ? 'Complete the subtitle timeline first'
                  : !form.model
                  ? 'Pick a model above first'
                  : !scene.transcript_segment?.trim()
                    ? 'Scene has no transcript_segment — fill that in first'
                    : 'Regenerate only the visual prompt; the deterministic time range and transcript stay unchanged.'"
                @click="regenerateScenePrompt(scene)"
              >{{ regenPromptId === scene.id && !rewordingPrompt ? '⏳ Regenerating…' : '✨ Prompt only' }}</button>
              <button
                class="btn-icon"
                :disabled="scenePlanGenerationUnavailable || !subtitleTimelineComplete || !form.model || regenPromptId === scene.id || planning || bulkReplan.active || !scene.transcript_segment?.trim() || !scene.visual_prompt?.trim()"
                :title="!scene.visual_prompt?.trim()
                  ? 'Nothing to reword yet — write or generate the prompt first.'
                  : !form.model
                    ? 'Pick a model above first'
                    : 'The image provider refused or failed on this prompt? Rewrite it from a different angle on the same beat, describing difficult historical material in ways that render — aftermath over act, period-illustration framing, no age markers. The history is kept; only the framing changes.'"
                @click="rewordScenePrompt(scene)"
              >{{ regenPromptId === scene.id && rewordingPrompt ? '⏳ Rewording…' : '🛡 Reword' }}</button>
              <button
                class="btn-icon"
                :disabled="i === 0"
                title="Merge into previous scene"
                @click="mergeScene(i)"
              >▲ Merge up</button>
              <button
                class="btn-icon"
                :disabled="sceneOverlapsMissingSubtitles(scene) || (scene.end_sec - scene.start_sec) < 6"
                :title="sceneOverlapsMissingSubtitles(scene) ? 'Fix missing subtitles first; splitting now would still have no narration text' : 'Split this scene in half (min 6s)'"
                @click="splitScene(i)"
              >✂ Split</button>
              <button
                class="btn-icon danger"
                title="Remove this scene (the next scene extends to fill the gap)"
                @click="removeScene(i)"
              >✕ Remove</button>
            </div>
          </li>
        </ul>
        <div
          v-if="renderedScenes.length < plan.scenes.length"
          ref="sceneLoadSentinel"
          class="scene-list-more"
        >
          <span>{{ renderedScenes.length }} of {{ plan.scenes.length }} scenes loaded</span>
          <button class="btn btn-sm btn-ghost" @click="loadMoreScenes">Load next {{ SCENE_RENDER_BATCH }}</button>
        </div>
      </template>
    </section>

    <section v-else-if="statusLoading" class="card mt-3">
      <p class="text-muted text-sm">Checking Scene Plan status…</p>
    </section>

    <section v-else-if="statusLoadError" class="card mt-3" role="alert">
      <p class="text-muted text-sm">
        Scene Plan status could not be loaded. Retry to check whether a saved plan exists.
        <button type="button" class="btn btn-sm btn-ghost ml-2" @click="retryStatus">Retry</button>
      </p>
    </section>

    <section v-else-if="episodeId && !status" class="card mt-3" role="alert">
      <p class="text-muted text-sm">
        Scene Plan status is unavailable. Retry to check whether a saved plan exists.
        <button type="button" class="btn btn-sm btn-ghost ml-2" @click="retryStatus">Retry</button>
      </p>
    </section>

    <section v-else class="card mt-3">
      <p class="text-muted text-sm">
        <span v-if="!episodeId">Pick an episode first.</span>
        <span v-else-if="!status?.stitched_srt">Stitch subtitles first (step 1).</span>
        <span v-else>No plan yet. Build the timeline to split this episode's stitched subtitles into narrated scenes.</span>
      </p>
      <button
        v-if="episodeId && status?.stitched_srt"
        type="button"
        class="btn btn-sm btn-secondary mt-2"
        :disabled="!canPlan || planning || planJobActive"
        @click="planScenes"
      >
        Build the plan
      </button>
    </section>

    <!-- v1.0.286 — back-to-top floating button. Appears after the scrollable
         page-content has been pushed past ~800px so users on long plans
         (50+ scenes, easily 5000+ px tall) don't have to grind back up. -->
    <button
      v-if="showBackToTop"
      class="back-to-top"
      title="Back to top"
      aria-label="Scroll to top of page"
      @click="scrollToTop"
    >
      ↑
    </button>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import {
  availableInputTokens,
  batchTimeoutWarning,
  clampOutputAllowance,
  contextWindowTokens,
  formatTokenCount,
  isModelTokenLimitError,
  maxOutputTokens as publishedMaxOutputTokens,
  outputAllowanceOptions,
  type ModelTokenLimits,
} from '../../../utils/model-token-budget.js'
import {
  normalizePromptCharCapSetting,
  promptCharCapAboveModel,
  promptCharCapOptions,
  promptLengthLabel,
  promptLengthState,
  promptLengthTone,
  publishedPromptCharCap,
  resolvePromptCharCap,
  type PromptCharCapSetting,
} from '../../../utils/prompt-char-cap.js'
import { readRememberedImageModelId } from '../../../utils/project-image-model.js'
import { composeScenePlanGuidance } from '../../../utils/scene-plan-guidance.js'
import { DEFAULT_EXCLUDE_KEYS } from '~/composables/usePresets'
import { useVisualStyleCatalog } from '~/composables/useVisualStyleCatalog'
import { pacingBandAt, type ScenePacing } from '@shared/pacing'
import { resolveMotionScope, type MotionScope } from '@shared/motion-scope'
import type { ContinuityConfig } from '~/composables/useContinuityConfig'
import type { SubtitleQualityReport } from '~/types/subtitle-quality'

definePageMeta({ layout: 'dashboard', key: route => `scene-plan-${route.params.slug}` })
useAppTitle('Scene Plan')

const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { get, post, put, del } = useApi()
const freshScenePromptAction = useFreshGenerationAction()
const { success, error: showError } = useToast()
const { ask } = useConfirm()
const { revalidate: revalidateEpisodes } = useEpisodes(slug)
// Project-level prompt defaults; timing and motion remain per episode.
const { config: projectConfig } = useProject()

// ── Opening visuals: measured, not typed (v1.3.1) ────────────────────────
//
// This page used to offer a mode dropdown and a "reserve N seconds" box, both
// saved to the project config and both overridable by a Scene Plan preset. The
// owner ended up with three disagreeing answers — a preset saying "from first
// second, 15s", a project config saying "branded opening, 10s", and a 10.0s
// file on disk — and the preset won, so every plan reserved nothing and every
// scene landed ~10s after the narration it was planned against.
//
// A length is now read off the clips themselves, at build time, by the
// backend. Nothing here is editable, because there is nothing left to decide:
// showing an input that the planner ignores would be worse than showing none.
interface MeasuredOpening { seconds: number; breakdown: string; unresolved: string[] }
const measuredOpening = ref<MeasuredOpening | null>(null)
const measuredOpeningLabel = computed(() => {
  if (!measuredOpening.value) return 'Measuring…'
  return measuredOpening.value.seconds > 0
    ? `${measuredOpening.value.seconds.toFixed(2)}s reserved`
    : 'From first second'
})
async function refreshMeasuredOpening() {
  try {
    const data = await get<MeasuredOpening>(`/projects/${slug.value}/scene-plan-opening`)
    measuredOpening.value = {
      seconds: Number(data?.seconds) || 0,
      breakdown: String(data?.breakdown || ''),
      unresolved: Array.isArray(data?.unresolved) ? data.unresolved : [],
    }
  } catch {
    // A failed measurement must not read as "no opening" — leave the card in
    // its "measuring" state rather than asserting a zero we did not measure.
    measuredOpening.value = null
  }
}

const episodeMotionScope = ref<MotionScope>({ mode: 'off' })
const visualSettingsError = ref('')
const episodeVisualSource = ref<'scene_plan' | 'image_pool' | null>(null)
const visualSourceError = ref('')
let visualSourceLoadSequence = 0
async function loadVisualSource(): Promise<void> {
  const sequence = ++visualSourceLoadSequence
  const ep = episodeId.value
  const project = slug.value
  episodeVisualSource.value = null
  visualSourceError.value = ''
  if (!ep) return
  try {
    const result = await get<{ source: 'scene_plan' | 'image_pool' }>(`/projects/${project}/video-editor/visual-source/${encodeURIComponent(ep)}`)
    if (sequence !== visualSourceLoadSequence || ep !== episodeId.value || project !== slug.value) return
    if (result.source !== 'scene_plan' && result.source !== 'image_pool') throw new Error('Saved visual source is unavailable')
    episodeVisualSource.value = result.source
  } catch (error: any) {
    if (sequence !== visualSourceLoadSequence || ep !== episodeId.value || project !== slug.value) return
    visualSourceError.value = error?.data?.detail || error?.message || 'Could not load visual source'
  }
}

const scopedMotionIds = computed(() => {
  try { return new Set(resolveMotionScope(plan.value?.scenes || [], episodeMotionScope.value).scene_ids) }
  catch { return new Set<string>() }
})
function applyVisualSettings(config: ContinuityConfig) {
  // A panel Save supersedes any older page-level continuity read still in flight.
  ++continuityLoadSequence
  continuityPacing.value = config.pacing
  episodeMotionScope.value = config.motion_scope
  form.value.generate_motion_prompts = config.motion_scope.mode !== 'off'
  form.value.motion_level = config.motion_level ?? 2
  characterSheetStyleBible.value = (config.style_bible || '').trim()
  visualSettingsError.value = ''
}

// v1.0.794 — "Avoid readable text in images", SCENE prompts only (never
// Thumbnail Prompts — a thumbnail's whole job is a legible in-image title).
// Optional and persisted per project, same pattern as motion above. Default
// ON: a project that has never touched this setting reads undefined here,
// and undefined resolves to on (matches resolveAvoidLegibleText on the
// backend) because the local fleet's fast model — the primary scene
// renderer — is the one that garbles lettering. A project whose scenes
// render on a higher-quality model (GPT Image 2, Nano Banana Pro) that gets
// real words right can turn this off below.
const avoidLegibleText = ref<boolean>(((projectConfig.value as any)?.avoid_legible_text_in_scenes) !== false)
watch(projectConfig, (c) => {
  avoidLegibleText.value = ((c as any)?.avoid_legible_text_in_scenes) !== false
  form.value.avoid_legible_text = avoidLegibleText.value
})
async function setAvoidLegibleText(v: boolean) {
  // Kept in sync with form.value.avoid_legible_text (the checkbox's actual
  // v-model, matching the Motion Prompts card above) so a failed save can
  // revert what the user is actually looking at, not just this shadow ref.
  avoidLegibleText.value = v
  form.value.avoid_legible_text = v
  try {
    await put(`/projects/${slug.value}/settings/config`, { avoid_legible_text_in_scenes: v })
    if (projectConfig.value) (projectConfig.value as any).avoid_legible_text_in_scenes = v
    success(v
      ? 'Scene prompts will describe lettering as texture instead of readable words.'
      : 'Scene prompts may write specific readable words again. Thumbnails were never affected.')
  } catch (e: any) {
    avoidLegibleText.value = !v
    form.value.avoid_legible_text = !v
    showError(e?.data?.detail || e?.message || 'Could not save the setting')
  }
}

// v1.0.795 — the channel's standing Style Bible (config.json
// `default_style_bible`). Persisted per project through the same
// /settings/config endpoint as the toggles above. This is a FALLBACK for the
// per-episode Style Bible on the Character Sheet, not a second style field:
// an episode with its own Style Bible ignores this entirely. Empty means the
// project has no default, which is how every project behaved before this
// existed.
const savedDefaultStyleBible = ref<string>((((projectConfig.value as any)?.default_style_bible) || '').trim())
const defaultStyleBible = ref<string>(savedDefaultStyleBible.value)
const savingDefaultStyleBible = ref(false)
watch(projectConfig, (c) => {
  const next = (((c as any)?.default_style_bible) || '').trim()
  // Don't stomp an edit in progress — only follow the config when the box is
  // still showing the last saved value.
  if (defaultStyleBible.value.trim() === savedDefaultStyleBible.value) defaultStyleBible.value = next
  savedDefaultStyleBible.value = next
})
async function saveDefaultStyleBible() {
  // Owner decision #2, 2026-09-20 — the ceiling is NOT a Story Studio number.
  // It is what the SELECTED image model publishes for a prompt right now, and
  // when it clips the save the customer is told (a limit that is enforced must
  // also be shown; a silent trim is the §1 lie the audit found). A model that
  // publishes nothing means no ceiling, so the text is saved in full rather
  // than being cut to an invented figure.
  const entered = defaultStyleBible.value.trim()
  const cap = defaultStyleBibleCap.value
  const clipped = !!cap && entered.length > cap
  const next = clipped ? entered.slice(0, cap) : entered
  const previous = savedDefaultStyleBible.value
  savingDefaultStyleBible.value = true
  try {
    await put(`/projects/${slug.value}/settings/config`, { default_style_bible: next })
    if (projectConfig.value) (projectConfig.value as any).default_style_bible = next
    savedDefaultStyleBible.value = next
    defaultStyleBible.value = next
    const modelName = intendedImageModel.value?.display_name || 'the selected image model'
    if (clipped) {
      success(
        `Saved, trimmed to ${cap.toLocaleString()} characters — the limit ${modelName} publishes. `
        + `${(entered.length - cap).toLocaleString()} characters at the end were dropped.`,
      )
    } else {
      success(next
        ? 'Saved. Every episode without its own Style Bible now uses this style.'
        : 'Channel default style cleared. Episodes without a Style Bible get no art direction.')
    }
  } catch (e: any) {
    savedDefaultStyleBible.value = previous
    showError(e?.data?.detail || e?.message || 'Could not save the channel default style')
  } finally {
    savingDefaultStyleBible.value = false
  }
}

// ── v1.2.6 — naming the selected art style ──────────────────────────────
// The owner: "style and guidance doesn't tell the name of the selected art
// style. it only shows the prompts and description."
//
// The Character Sheet does not persist a style id: `StylePicker` stores the
// chosen look as its style-bible PROSE and identifies the active style by
// matching that prose back against the shared catalog. This page resolves the
// name exactly the same way, through `useVisualStyleCatalog` — the single
// source of truth (AGENTS.md) — so the two pages can never disagree and no
// style list, label or category is duplicated here.
const {
  styles: visualStyles,
  loading: visualStylesLoading,
  error: visualStylesError,
  refresh: refreshVisualStyles,
} = useVisualStyleCatalog()
void refreshVisualStyles()

interface StyleIdentity { name: string; category: string; note: string }

/**
 * Name a Style Bible. A miss is never rendered blank and never guessed: the
 * catalog has to be the real, fully-loaded one before Story Studio is entitled
 * to call an unmatched look "custom", because an unnamed shipped style and a
 * hand-written one are indistinguishable from a catalog that failed to load.
 */
function identifyStyle(bible: string): StyleIdentity {
  const text = (bible || '').trim()
  if (!text) return { name: '', category: '', note: '' }
  const match = visualStyles.value.find(style => style.data.style_bible.trim() === text)
  if (match) return { name: match.name, category: match.category, note: '' }
  if (visualStylesLoading.value) {
    return { name: 'Naming this style…', category: '', note: 'Story Studio is loading the visual style library to identify this look.' }
  }
  if (visualStylesError.value) {
    return {
      name: 'Style name unavailable',
      category: '',
      note: `The visual style library could not be loaded, so Story Studio cannot say which look this is. ${visualStylesError.value}`,
    }
  }
  return {
    name: 'Custom style',
    category: '',
    note: 'This art direction is not one of the installed looks, so it has no style name — it was written or edited by hand.',
  }
}

const channelStyleIdentity = computed(() => identifyStyle(savedDefaultStyleBible.value))

const initialEpisodeId = typeof route.query.episode_id === 'string'
  ? route.query.episode_id
  : typeof route.query.episode === 'string'
    ? route.query.episode
    : ''
const episodeId = ref(initialEpisodeId)

// ── Status payload (matches GET /scene-plan/:ep response) ───────────
interface ScenePlanStatus {
  stitched_srt: {
    path: string
    meta: {
      gap_duration_s?: number
      total_cues?: number
      total_duration_sec?: number
      complete?: boolean
      missing_sections?: string[]
      sections?: Array<{
        slug: string
        source_srt?: string
        cues_added: number
        offset_sec: number
        duration_sec: number
      }>
    } | null
    drifts_from_current_merge: boolean
    stale_vs_subtitles?: boolean
    incomplete_sections?: string[]
  } | null
  /** v1.0.797 — the transcript the planner will actually read: the corrected
   *  one (ASR timings, script words) when the script and audio agree, else the
   *  raw stitch. */
  transcript_source?: {
    path: string
    corrected: boolean
    cues_in: number | null
    cues_out: number | null
    cues_dropped: number | null
    cues_rewritten: number | null
    chapters_corrected: number | null
    chapters_refused: number | null
    warnings: string[]
    skipped_reason: string | null
    refused_chapters?: Array<{
      slug: string
      reason_code: 'unmapped_section' | 'script_missing' | 'script_unreadable' | 'script_audio_mismatch' | 'unknown'
    }>
    /** v1.2.2 — advisory text-quality report for this exact transcript. */
    quality?: SubtitleQualityReport | null
  }
  timeline_integrity?: {
    complete: boolean
    missing_sections: string[]
    blocking_cue_gaps?: Array<{
      section_slugs: string[]
      previous_end_sec: number
      next_start_sec: number
      gap_sec: number
    }>
  } | null
  scene_plan: ScenePlan | null
  plan_stale_vs_stitched?: boolean
  audio_merged: boolean
  audio_merge_gap_s: number | null
  research_available: boolean
  coverage_integrity: {
    authoritative: boolean
    complete: boolean
    headCovered: boolean
    blockingUncoveredSec: number
    coverage: {
      headGapSec: number
      internalGaps: Array<{ afterSceneId: string; afterIndex: number; gapSec: number }>
      internalGapTotalSec: number
      tailGapSec: number
      uncoveredTotalSec: number
    } | null
    reason?: 'missing-duration' | 'invalid-timing' | 'coverage-gap'
  } | null
}
interface ScenePlanEntry {
  id: string
  scene_index: number
  start_sec: number
  end_sec: number
  transcript_segment: string
  visual_prompt: string
  approved?: boolean
  image_path?: string
  boundary_reason?: string
  // v1.0.468 — image-to-video motion instruction for this scene.
  motion_prompt?: string
  motion_mode?: 'still' | 'gentle' | 'limited'
  motion_choice?: 'still' | 'clip'
  // v1.0.336 — continuity: what the scene depicts. 'character' includes the
  // guide; the rest render without him. Unset → treated as 'character'.
  scene_type?: SceneType
  scene_type_locked?: boolean
  creative_strategy?: CreativeStrategy
}
type SceneType = 'character' | 'event' | 'environment' | 'map' | 'artifact'
type CreativeProfile = 'narrative' | 'balanced' | 'editorial' | 'spiritual' | 'abstract' | 'custom'
type CreativeStrategy =
  | 'literal-narrative' | 'documentary' | 'editorial-metaphor' | 'symbolic'
  | 'poetic-environment' | 'character-psychology' | 'spiritual-allegory' | 'surreal'
  | 'conceptual-collage' | 'minimal-graphic'
interface CreativeDirection {
  profile: CreativeProfile
  intensity: 1 | 2 | 3 | 4
  strategies: CreativeStrategy[]
  recurring_motifs?: string
  avoid_cliches?: string
  custom_direction?: string
}
const CREATIVE_PROFILES: Array<{ id: CreativeProfile; label: string; usage: string }> = [
  { id: 'narrative', label: 'Narrative', usage: 'Stories, history, biography, explanations' },
  { id: 'balanced', label: 'Balanced', usage: 'Education with occasional visual metaphor' },
  { id: 'editorial', label: 'Editorial', usage: 'Psychology, culture, commentary, business' },
  { id: 'spiritual', label: 'Spiritual', usage: 'Faith, prayer, hope, reflection, devotion' },
  { id: 'abstract', label: 'Abstract', usage: 'Artistic essays, dreamlike and conceptual work' },
  { id: 'custom', label: 'Custom', usage: 'Your own selected mix of visual strategies' },
]
const CREATIVE_STRATEGIES: Array<{ id: CreativeStrategy; label: string }> = [
  { id: 'literal-narrative', label: 'Literal narrative' },
  { id: 'documentary', label: 'Documentary' },
  { id: 'editorial-metaphor', label: 'Editorial metaphor' },
  { id: 'symbolic', label: 'Symbolic' },
  { id: 'poetic-environment', label: 'Poetic environment' },
  { id: 'character-psychology', label: 'Character psychology' },
  { id: 'spiritual-allegory', label: 'Spiritual allegory' },
  { id: 'surreal', label: 'Surreal' },
  { id: 'conceptual-collage', label: 'Conceptual collage' },
  { id: 'minimal-graphic', label: 'Minimal graphic' },
]
const CREATIVE_INTENSITY_LABELS = ['Faithful', 'Balanced', 'Expressive', 'Experimental']
const CREATIVE_STRATEGY_LABELS = Object.fromEntries(CREATIVE_STRATEGIES.map(strategy => [strategy.id, strategy.label])) as Record<CreativeStrategy, string>
const SCENE_TYPE_OPTIONS: Array<{ value: SceneType; emoji: string; label: string }> = [
  { value: 'character', emoji: '🧒', label: 'Character' },
  { value: 'event', emoji: '⚔️', label: 'Event' },
  { value: 'environment', emoji: '🏛️', label: 'Environment' },
  { value: 'map', emoji: '🗺️', label: 'Map' },
  { value: 'artifact', emoji: '📜', label: 'Artifact' },
]
interface ScenePlan {
  pacing?: ScenePacing
  schema_version: 1
  generated_at: string
  timeline_built_at?: string
  planner_model?: string
  source_stitched_srt?: string
  total_duration_sec: number
  research_used: boolean
  scenes: ScenePlanEntry[]
  planning_stage?: 'timeline' | 'visual' | 'motion'
  opening_mode?: 'branded-opening' | 'from-start'
  opening_reserved_sec?: number
  visual_prompt_batch_id?: string
  motion_prompt_batch_id?: string
  creative_direction?: CreativeDirection
}

const status = ref<ScenePlanStatus | null>(null)
const statusLoading = ref(false)
const statusLoadError = ref('')
const plan = ref<ScenePlan | null>(null)
const dirty = ref(false)
const SCENE_RENDER_BATCH = 60
const renderedSceneLimit = ref(SCENE_RENDER_BATCH)
const sceneLoadSentinel = ref<HTMLElement | null>(null)
const renderedScenes = computed(() => (plan.value?.scenes || []).slice(0, renderedSceneLimit.value))
let sceneLoadObserver: IntersectionObserver | null = null
let loadedPlanEpisode = ''
let statusLoadSequence = 0
let continuityLoadSequence = 0

function markPlanDirty(): void {
  if (plan.value) dirty.value = true
}

function loadMoreScenes(): void {
  renderedSceneLimit.value = Math.min(
    plan.value?.scenes.length || 0,
    renderedSceneLimit.value + SCENE_RENDER_BATCH,
  )
}
const missingSubtitleSections = computed(() => {
  const stitched = status.value?.stitched_srt
  if (!stitched) return []
  const reported = [
    ...(stitched.incomplete_sections || []),
    ...(stitched.meta?.missing_sections || []),
  ]
  const derived = (stitched.meta?.sections || [])
    .filter(section => !section.source_srt || section.cues_added <= 0)
    .map(section => section.slug)
  return Array.from(new Set([...reported, ...derived]))
})
const blockingSubtitleCueGaps = computed(() => status.value?.timeline_integrity?.blocking_cue_gaps || [])
const blockingSubtitleGapSections = computed(() => Array.from(new Set(
  blockingSubtitleCueGaps.value.flatMap(gap => gap.section_slugs),
)))
const subtitleTimelineComplete = computed(() =>
  !!status.value?.stitched_srt
  && missingSubtitleSections.value.length === 0
  && status.value?.timeline_integrity?.complete !== false,
)
/** Uncovered narration that "Repair coverage" can actually close: gaps between
 *  scenes, and a tail. A head gap is deliberately NOT counted — repair declines
 *  those unless explicitly asked, so counting one here offered a button that
 *  promised a fix it would never perform. The head has its own action below. */
const coverageRepairableSec = computed(() => {
  const c = status.value?.coverage_integrity?.coverage
  return (c?.internalGapTotalSec || 0) + (c?.tailGapSec || 0)
})
const coverageNeedsRepair = computed(() => {
  const ci = status.value?.coverage_integrity
  if (ci?.authoritative !== true || ci.complete !== false) return false
  // Timings too broken to measure at all — still say so rather than fall silent.
  if (!ci.coverage) return true
  return coverageRepairableSec.value > 0
})
const coverageGapLabel = computed(() => {
  const ci = status.value?.coverage_integrity
  const sec = ci?.coverage ? coverageRepairableSec.value : (ci?.blockingUncoveredSec || 0)
  return `${sec.toFixed(1)}s`
})
const coverageInternalGapCount = computed(() =>
  status.value?.coverage_integrity?.coverage?.internalGaps?.length || 0,
)
/**
 * Narration before scene 1 that nothing is credited with covering.
 *
 * The head is credited only by a branded opening WITH a reserve — the identical
 * test the render applies (`generators/video.ts`, search `openingReserved`), so
 * the two pages cannot disagree about whether the opening is spoken for.
 *
 * Shown whether or not the coverage check passed. Plans written before the
 * planner recorded its opening mode state nothing about it, so that check falls
 * back to a legacy guess ("no mode recorded + a large head gap → probably an old
 * branded opening") and waves the hole through, while the render refuses it.
 * Those plans read "✓ ready" here and "not ready" there; surfacing the seconds
 * on the page that can act on them is what ends the contradiction for episodes
 * planned before the fix.
 */
const uncreditedHeadGapSec = computed(() => {
  const head = status.value?.coverage_integrity?.coverage?.headGapSec || 0
  const plan = status.value?.scene_plan as any
  const credited = plan?.opening_mode === 'branded-opening'
    && (Number(plan?.opening_reserved_sec) || 0) > 0
  return head > 2 && !credited ? head : 0
})
const uncreditedHeadGapLabel = computed(() => {
  const total = Math.round(uncreditedHeadGapSec.value)
  if (total < 60) return `${total}s`
  const m = Math.floor(total / 60)
  const s = total % 60
  return s ? `${m}m ${s}s` : `${m}m`
})
const missingSubtitleRanges = computed(() =>
  (status.value?.stitched_srt?.meta?.sections || [])
    .filter(section => missingSubtitleSections.value.includes(section.slug))
    .map(section => ({
      slug: section.slug,
      start: section.offset_sec,
      end: section.offset_sec + section.duration_sec,
    })),
)
function missingSubtitleSectionForScene(scene: ScenePlanEntry): string | undefined {
  return missingSubtitleRanges.value.find(range =>
    scene.end_sec > range.start + 0.01 && scene.start_sec < range.end - 0.01,
  )?.slug
}
function sceneOverlapsMissingSubtitles(scene: ScenePlanEntry): boolean {
  return !!missingSubtitleSectionForScene(scene)
}
function subtitleLink(section?: string): string {
  const query = new URLSearchParams({ episode_id: episodeId.value })
  if (section) query.set('section', section)
  return `/projects/${slug.value}/subtitles?${query.toString()}`
}
function refusedChapterMessage(chapter: NonNullable<NonNullable<ScenePlanStatus['transcript_source']>['refused_chapters']>[number]): string {
  if (chapter.reason_code === 'unmapped_section') {
    return `${chapter.slug} could not be mapped to a numbered script chapter; it keeps Whisper's words.`
  }
  if (chapter.reason_code === 'script_audio_mismatch') {
    return `${chapter.slug} script and audio did not agree closely enough to correct safely; it keeps Whisper's words.`
  }
  if (chapter.reason_code === 'script_missing') return `${chapter.slug} has no matching script chapter; it keeps Whisper's words.`
  return `${chapter.slug} could not be corrected safely; it keeps Whisper's words.`
}
// v1.0.272 — per-episode in-flight flags. A plan run holds its flag
// through a long poll; keying it to the episode means switching episodes
// mid-job doesn't disable the newly-selected episode's buttons. (See
// auto-memory: per-episode-inflight-gating.md.)
const planningEpisode = ref<string | null>(null)
const planning = computed(() => planningEpisode.value === episodeId.value)
// v1.0.307 — also reflect a scene_plan_run already queued/running for this
// episode, so the button stays greyed even after a page reload (the local
// `planning` ref doesn't survive one). See useJobs.isJobActiveFor.
const { isJobActiveFor } = useJobs()
const planJobActive = computed(() => isJobActiveFor(episodeId.value, ['scene_plan_run']))
const saving = ref(false)
const deleting = ref(false)

// v1.0.193 — continuity-chain density-pacing indicator. When this project is
// continuity-chain, surface the active scene-length band (set on the Character
// Sheet page) so the user knows the planner paces for a "live" feel.
const continuityPacing = ref<ScenePacing | null>(null)
// For continuity-chain the canonical look is the Character Sheet's continuity
// Style Bible. Scene Plan displays it read-only so there is no competing style
// editor or chance for the two steps to drift.
const characterSheetStyleBible = ref('')
// v1.2.6 — see identifyStyle() above; declared here because it reads the ref.
const episodeStyleIdentity = computed(() => identifyStyle(characterSheetStyleBible.value))

async function loadContinuity(): Promise<void> {
  const ep = episodeId.value
  const requestSequence = ++continuityLoadSequence
  continuityPacing.value = null
  episodeMotionScope.value = { mode: 'off' }
  form.value.generate_motion_prompts = false
  visualSettingsError.value = ''
  characterSheetStyleBible.value = ''
  if (!ep) return
  try {
    const r = await get<{ exists: boolean; config: ContinuityConfig }>(`/projects/${slug.value}/continuity/${ep}`)
    if (requestSequence !== continuityLoadSequence || episodeId.value !== ep) return
    applyVisualSettings(r.config)
  } catch (error: any) {
    if (requestSequence !== continuityLoadSequence || episodeId.value !== ep) return
    visualSettingsError.value = error?.data?.detail || 'Could not load this episode’s visual settings.'
  }
}

/** Set a scene's type and lock it so deterministic repairs keep the choice. The
 *  `dirty` computed picks up the mutation; the user saves with the Save button. */
function setSceneType(scene: ScenePlanEntry, value: string): void {
  scene.scene_type = value as SceneType
  scene.scene_type_locked = true
  markPlanDirty()
}

type PromptPackSetting = 'auto' | number
/** 'auto' = this product's published maximum. A number is an explicit
 *  allowance, always clamped to that same published maximum. */
type PromptTokenSetting = 'auto' | number
type SelectedModelMeta = ModelTokenLimits & { id: string }
const PROMPT_PACK_PRESETS = [1, 5, 10, 25, 50, 100, 250, 500] as const
const PROMPT_PACK_MIN = 1
/**
 * THERE IS NO `PROMPT_PACK_MAX` HERE, AND THERE MUST NOT BE ONE.
 *
 * This page used to carry its own `PROMPT_PACK_MAX = 50` — a duplicate of a
 * backend constant, applied with the same formula, so both ends independently
 * threw away a correct model-aware derivation. The presets above are shortcuts,
 * not limits: "Custom…" accepts any whole number, and the only ceiling shown
 * anywhere is `maximumPromptPackSize`, which is derived from the SELECTED
 * model's published output allowance and the channel's own tuning below.
 */
/**
 * Defaults only — mirrors `services/scene-prompt-batching.ts`. Each is
 * overridden by the channel's own saved value (`scene_prompt_*` in project
 * config, edited under Advanced batch controls) and the backend performs the
 * same arithmetic from the same saved numbers.
 *
 * 250 is a WALL-CLOCK judgement, not a token limit: the token maths alone
 * permits ~960 scenes on a 384,000-token model, but a request only has so long
 * to come back and the large models' sustained throughput is not yet measured.
 * How long it has is `languageTimeoutMinutes` below — the owner's own setting,
 * read from the backend, deliberately not repeated as a number in this comment.
 */
const DEFAULT_TOKENS_PER_SCENE = 300
const DEFAULT_OUTPUT_SAFETY_FRACTION = 0.75
const DEFAULT_PROMPT_BATCH_SIZE = 250

// ── Scene Plan batch tuning, per channel ────────────────────────────────────
// The owner's two-field pattern: an allowance he edits, and a dial with no
// code maximum. These three numbers replaced a hardcoded 50-scene cap that
// silently overrode the model-aware derivation, so the one thing they must
// never grow is an upper bound. Persisted through the same /settings/config
// endpoint as the toggles above; the backend reads the identical keys and
// performs the identical arithmetic.
const promptTokensPerScene = ref<number>(
  Number((projectConfig.value as any)?.scene_prompt_tokens_per_scene) || DEFAULT_TOKENS_PER_SCENE,
)
const promptSafetyFraction = ref<number>(
  Number((projectConfig.value as any)?.scene_prompt_output_safety_fraction) || DEFAULT_OUTPUT_SAFETY_FRACTION,
)
const promptBatchSizeDefault = ref<number>(
  Number((projectConfig.value as any)?.scene_prompt_batch_size) || DEFAULT_PROMPT_BATCH_SIZE,
)
watch(projectConfig, (c) => {
  promptTokensPerScene.value = Number((c as any)?.scene_prompt_tokens_per_scene) || DEFAULT_TOKENS_PER_SCENE
  promptSafetyFraction.value = Number((c as any)?.scene_prompt_output_safety_fraction) || DEFAULT_OUTPUT_SAFETY_FRACTION
  promptBatchSizeDefault.value = Number((c as any)?.scene_prompt_batch_size) || DEFAULT_PROMPT_BATCH_SIZE
})
async function saveBatchTuning(): Promise<void> {
  const payload = {
    scene_prompt_tokens_per_scene: Math.max(1, Math.round(Number(promptTokensPerScene.value) || DEFAULT_TOKENS_PER_SCENE)),
    scene_prompt_output_safety_fraction: Math.min(1, Math.max(0.01, Number(promptSafetyFraction.value) || DEFAULT_OUTPUT_SAFETY_FRACTION)),
    scene_prompt_batch_size: Math.max(1, Math.round(Number(promptBatchSizeDefault.value) || DEFAULT_PROMPT_BATCH_SIZE)),
  }
  try {
    await put(`/projects/${slug.value}/settings/config`, payload)
    if (projectConfig.value) Object.assign(projectConfig.value as any, payload)
    promptTokensPerScene.value = payload.scene_prompt_tokens_per_scene
    promptSafetyFraction.value = payload.scene_prompt_output_safety_fraction
    promptBatchSizeDefault.value = payload.scene_prompt_batch_size
    success('Batch tuning saved for this channel.')
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Could not save the batch tuning')
  }
}
function resetBatchTuning(): void {
  promptTokensPerScene.value = DEFAULT_TOKENS_PER_SCENE
  promptSafetyFraction.value = DEFAULT_OUTPUT_SAFETY_FRACTION
  promptBatchSizeDefault.value = DEFAULT_PROMPT_BATCH_SIZE
  void saveBatchTuning()
}

const selectedModelMeta = ref<SelectedModelMeta | null>(null)
const modelSelector = ref<{ reloadCatalog: () => Promise<void> } | null>(null)

/**
 * GenStudio is the FINAL validator of context and output limits, and its
 * catalogue can change under a page that has been open a while.
 *
 * When it rejects a request for exceeding one, do three things and nothing
 * else: re-read the published catalogue, clamp the selected allowance to what
 * the model publishes NOW, and show GenStudio's own message. Never invent a
 * smaller number locally — that would replace the server's answer with a guess.
 */
async function reportGenerationError(error: any, fallback: string): Promise<void> {
  const message = error?.data?.detail || error?.message || fallback
  showError(message)
  if (!isModelTokenLimitError(message)) return
  await modelSelector.value?.reloadCatalog().catch(() => {})
  const maximum = publishedMaxOutput.value
  if (maximum) form.value.prompt_max_tokens = clampOutputAllowance(form.value.prompt_max_tokens, maximum)
}

const form = ref({
  model: '',  // ModelSelector auto-picks first usable
  use_research: true,
  prompt_pack_size: 'auto' as PromptPackSetting,
  prompt_max_tokens: 'auto' as PromptTokenSetting,
  // Which image model these prompts are being WRITTEN for. A prompt-writing
  // hint only: it drives the Auto character ceiling and nothing else, and it
  // never changes the model Scene Review actually renders with.
  intended_image_model: '',
  // 'auto' follows that model's published `max_prompt_characters`; 'none' means
  // no limit; a number is an explicit ceiling (a smaller one is a cost control).
  prompt_char_cap: 'auto' as PromptCharCapSetting,
  // v1.0.468 — image-to-video motion prompt: whether to generate one per scene,
  // and how lively the motion is (1=Still … 4=Lively). 2 = Gentle (sleep-tuned).
  generate_motion_prompts: false,
  motion_level: 2,
  // v1.0.794 — SCENE prompts only; see avoidLegibleText above. Default ON.
  avoid_legible_text: ((projectConfig.value as any)?.avoid_legible_text_in_scenes) !== false,
  // Visual interpretation is separate from the Character Sheet Style Bible.
  // Narrative is the compatibility-safe default for existing story channels.
  creative_profile: 'narrative' as CreativeProfile,
  creative_intensity: 2,
  creative_strategies: ['literal-narrative', 'editorial-metaphor', 'symbolic', 'poetic-environment'] as CreativeStrategy[],
  creative_motifs: '',
  creative_avoid_cliches: '',
  creative_custom_direction: '',
  // Episode-specific guidance is optional. The visual style always comes from
  // the Character Sheet continuity Style Bible.
  custom_instructions: '',
  // X-06 (owner decision 2026-09-22) — reusable guidance. Unlike the box above,
  // this text IS carried by a Scene Plan preset and is meant to be applied to
  // another episode. It is never written to project config and never applies
  // itself; the durable copy lives inside the preset the customer saved.
  reusable_guidance: '',
})
const customPromptPackSize = ref(12)
/** Shape check only. No upper bound: what is too large for the CHOSEN model is
 *  shown as a warning next to the field, never swapped for a smaller number. */
function normalizePromptPackSetting(value: unknown): PromptPackSetting {
  if (value === 'auto' || value == null || value === '') return 'auto'
  const size = Number(value)
  return Number.isInteger(size) && size >= PROMPT_PACK_MIN ? size : 'auto'
}
/** Shape check only — 'auto' or a positive whole number. What is LEGAL is the
 *  selected product's business, so no fixed option list is consulted here. */
function normalizePromptTokenSetting(value: unknown): PromptTokenSetting {
  if (value === 'auto' || value == null || value === '') return 'auto'
  const budget = Number(value)
  return Number.isInteger(budget) && budget >= 1 ? budget : 'auto'
}
function setPromptPackSetting(value: unknown): void {
  const normalized = normalizePromptPackSetting(value)
  form.value.prompt_pack_size = normalized
  if (normalized !== 'auto' && !PROMPT_PACK_PRESETS.includes(normalized as typeof PROMPT_PACK_PRESETS[number])) {
    customPromptPackSize.value = normalized
  }
}
const promptPackPickerValue = computed<string>({
  get: () => {
    const value = normalizePromptPackSetting(form.value.prompt_pack_size)
    if (value === 'auto') return 'auto'
    return PROMPT_PACK_PRESETS.includes(value as typeof PROMPT_PACK_PRESETS[number]) ? String(value) : 'custom'
  },
  set: (value) => {
    if (value === 'custom') {
      setPromptPackSetting(customPromptPackSize.value)
      return
    }
    setPromptPackSetting(value)
  },
})
function applyCustomPromptPackSize(): void {
  setPromptPackSetting(customPromptPackSize.value)
}
// v1.0.259 — remember plan settings per-Mac across reloads (an active plan
// preset still auto-applies on top).
useRememberedForm('scene-plan', slug, form)
setPromptPackSetting(form.value.prompt_pack_size)
// A remembered allowance is only checked for SHAPE here. Its legality belongs
// to the selected product, so the clamp happens against the live catalogue
// once the model's published limits arrive (see the publishedMaxOutput watch).
form.value.prompt_max_tokens = normalizePromptTokenSetting(form.value.prompt_max_tokens)
if (!CREATIVE_PROFILES.some(profile => profile.id === form.value.creative_profile)) {
  form.value.creative_profile = 'narrative'
}
form.value.creative_intensity = Math.max(1, Math.min(4, Math.round(Number(form.value.creative_intensity) || 2)))
form.value.creative_strategies = form.value.creative_strategies.filter(strategy => CREATIVE_STRATEGIES.some(option => option.id === strategy))
if (!form.value.creative_strategies.length) {
  form.value.creative_strategies = ['literal-narrative', 'editorial-metaphor', 'symbolic', 'poetic-environment']
}

const creativeProfileMeta = computed(() => CREATIVE_PROFILES.find(profile => profile.id === form.value.creative_profile) || CREATIVE_PROFILES[0]!)
const creativeIntensityLabel = computed(() => CREATIVE_INTENSITY_LABELS[Math.max(0, Math.min(3, form.value.creative_intensity - 1))])
const creativeDirectionPayload = computed<CreativeDirection>(() => ({
  profile: form.value.creative_profile,
  intensity: Math.max(1, Math.min(4, Math.round(Number(form.value.creative_intensity) || 2))) as CreativeDirection['intensity'],
  strategies: [...form.value.creative_strategies],
  recurring_motifs: form.value.creative_motifs.trim() || undefined,
  avoid_cliches: form.value.creative_avoid_cliches.trim() || undefined,
  custom_direction: form.value.creative_custom_direction.trim() || undefined,
}))
function selectCreativeProfile(profile: CreativeProfile): void {
  form.value.creative_profile = profile
}
function toggleCreativeStrategy(strategy: CreativeStrategy): void {
  const index = form.value.creative_strategies.indexOf(strategy)
  if (index >= 0) {
    // A custom profile must always retain one usable strategy.
    if (form.value.creative_strategies.length > 1) form.value.creative_strategies.splice(index, 1)
  } else {
    form.value.creative_strategies.push(strategy)
  }
}
function creativeStrategyLabel(strategy?: CreativeStrategy): string {
  return strategy ? CREATIVE_STRATEGY_LABELS[strategy] : ''
}

/** The catalogue entry for the CURRENTLY selected model, or null while the
 *  picker and the emitted metadata disagree (mid-switch). */
const liveModelLimits = computed<SelectedModelMeta | null>(() =>
  selectedModelMeta.value?.id === form.value.model ? selectedModelMeta.value : null,
)
/** Published `max_output_tokens`. No local ceiling: a product publishing
 *  128,000 is offered 128,000. */
const publishedMaxOutput = computed(() => publishedMaxOutputTokens(liveModelLimits.value))
const selectedModelMaxOutput = computed(() => publishedMaxOutput.value || 0)
const hasSelectedPromptModel = computed(() => !!form.value.model && !!liveModelLimits.value)
const hasPublishedPromptBudget = computed(() => !!form.value.model && selectedModelMaxOutput.value > 0)
/** Published `context_window_tokens`, falling back to the deprecated
 *  `context_limit_tokens` alias only when the current field is absent. */
const selectedModelContextWindow = computed(() => contextWindowTokens(liveModelLimits.value))
const selectedModelContextLabel = computed(() =>
  selectedModelContextWindow.value
    ? `${selectedModelContextWindow.value.toLocaleString()} tokens`
    : 'published by GenStudio when available',
)
const contextWindowLabel = computed(() => formatTokenCount(selectedModelContextWindow.value))
const outputAllowanceLabel = computed(() => formatTokenCount(publishedMaxOutput.value))
/** available_input_tokens = max(0, context_window - selected_max_output).
 *  An ESTIMATE for transparency — never turned into a character limit. */
const availableInputBudget = computed(() =>
  availableInputTokens(selectedModelContextWindow.value, effectivePromptTokenBudget.value),
)
const availableInputBudgetLabel = computed(() =>
  selectedModelContextWindow.value && effectivePromptTokenBudget.value
    ? availableInputBudget.value.toLocaleString()
    : 'not published',
)
const automaticTokenBudget = computed<number>(() => selectedModelMaxOutput.value)
const effectivePromptTokenBudget = computed<number>(() => {
  if (!hasSelectedPromptModel.value) return 0
  const requested = form.value.prompt_max_tokens === 'auto'
    ? automaticTokenBudget.value : Number(form.value.prompt_max_tokens)
  if (!selectedModelMaxOutput.value) return Number.isInteger(requested) && requested >= 1 ? requested : 0
  return Math.min(selectedModelMaxOutput.value, Math.max(1, requested))
})
const hasUnpublishedExplicitPromptBudget = computed(() =>
  !hasPublishedPromptBudget.value && effectivePromptTokenBudget.value > 0,
)
/** A published output ceiling, or the operator's explicit allowance, can bound
 *  complete scenes at this channel's own tuning. Auto with no published ceiling
 *  has no numeric budget, so it keeps the configured batch size instead. */
const maximumPromptPackSize = computed<number>(() => {
  if (!effectivePromptTokenBudget.value) return 0
  const scenes = Math.floor((effectivePromptTokenBudget.value * promptSafetyFraction.value) / promptTokensPerScene.value)
  return Math.max(PROMPT_PACK_MIN, scenes)
})
/** "Automatic" = the channel's default batch, or the model's derived maximum
 *  when the model cannot return even that much. */
const automaticPromptPackSize = computed<number>(() =>
  !hasSelectedPromptModel.value
    ? 0
    : maximumPromptPackSize.value
      ? Math.min(promptBatchSizeDefault.value, maximumPromptPackSize.value)
      : promptBatchSizeDefault.value,
)
const effectivePromptPackSize = computed<number>(() => {
  if (!hasSelectedPromptModel.value) return 0
  const requested = form.value.prompt_pack_size === 'auto'
    ? automaticPromptPackSize.value : Number(form.value.prompt_pack_size)
  return maximumPromptPackSize.value
    ? Math.min(Math.max(PROMPT_PACK_MIN, requested), maximumPromptPackSize.value)
    : Math.max(PROMPT_PACK_MIN, requested)
})
/** Said out loud when an explicit choice cannot be honoured by the chosen
 *  model. The number is never silently rewritten behind the operator's back. */
const promptPackReductionNotice = computed<string>(() => {
  if (!maximumPromptPackSize.value) return ''
  if (form.value.prompt_pack_size === 'auto') return ''
  const requested = Number(form.value.prompt_pack_size)
  if (!Number.isFinite(requested) || requested <= maximumPromptPackSize.value) return ''
  const allowance = hasPublishedPromptBudget.value
    ? 'This model can only return'
    : `Your selected ${effectivePromptTokenBudget.value.toLocaleString()} output tokens can return`
  return `${allowance} ${maximumPromptPackSize.value} scenes complete in one response, `
    + `so ${requested} would be reduced to ${maximumPromptPackSize.value}. `
    + (hasPublishedPromptBudget.value
      ? 'Pick a larger model or a smaller batch.'
      : 'Choose Automatic to omit the allowance or a smaller batch.')
})
// ── Will this batch finish in time? ─────────────────────────────────────────
// Token maths says what the model can RETURN. It says nothing about whether
// the answer arrives before the request is cut off, and a request cut off
// part-way is charged for and lost — that is the EP0067 failure, repeated at
// a bigger batch size. Every number in the sum is now a real value rather than
// an assumption baked into a comment: how long a request may run, the hard
// speed floor it is measured against, and the preferred speed the sentence
// mentions are all the owner's own settings, read from the backend. Not one of
// them is copied here — he revised the floor within a day of setting it.
//
// Non-blocking, always. He may knowingly send a batch that cannot finish at
// floor speed — most providers are faster. The panel's job is to say so before
// the click, not to refuse.
const languageTimeoutMinutes = ref<number>(30)
const floorTokensPerSecond = ref<number>(25)
const preferredTokensPerSecond = ref<number>(50)
async function loadRequestTimeout(): Promise<void> {
  try {
    const r: any = await get('/app-settings/concurrency')
    // An unreadable setting must leave the shipped default showing, never 0 —
    // a 0 here would make the warning fire on every batch, forever.
    const minutes = Number(r?.genstudio_language_timeout_minutes)
    if (Number.isFinite(minutes) && minutes > 0) languageTimeoutMinutes.value = minutes
    const floor = Number(r?.language_floor_tokens_per_second)
    if (Number.isFinite(floor) && floor > 0) floorTokensPerSecond.value = floor
    const preferred = Number(r?.language_preferred_tokens_per_second)
    if (Number.isFinite(preferred) && preferred > 0) preferredTokensPerSecond.value = preferred
  } catch { /* the warning goes quiet; nothing else on the page depends on it */ }
}
// The arithmetic itself lives in utils/model-token-budget.ts beside the rest
// of this page's derivations, so it can be tested directly rather than through
// a rendered component.
const promptBatchTimeoutWarning = computed<string>(() => batchTimeoutWarning({
  packSize: hasSelectedPromptModel.value ? effectivePromptPackSize.value : 0,
  tokensPerScene: promptTokensPerScene.value,
  timeoutMinutes: languageTimeoutMinutes.value,
  floorTokensPerSecond: floorTokensPerSecond.value,
  preferredTokensPerSecond: preferredTokensPerSecond.value,
}))
const availablePromptPackPresets = computed(() => maximumPromptPackSize.value
  ? PROMPT_PACK_PRESETS.filter(size => size <= maximumPromptPackSize.value)
  : hasSelectedPromptModel.value ? PROMPT_PACK_PRESETS : [])
/** Derived from the SELECTED product's published `max_output_tokens`, never
 *  from a fixed list. The product's own maximum is always the top option. */
const availableOutputBudgets = computed(() => outputAllowanceOptions(selectedModelMaxOutput.value))

function pacingSummary(pacing: ScenePacing): string {
  if (pacing.mode === 'variable') {
    return `Variable · ${pacing.periods.length} period${pacing.periods.length === 1 ? '' : 's'} · ${pacing.periods.map(period => `${period.min_sec}–${period.max_sec}s`).join(' → ')}`
  }
  return `Uniform · ${pacing.min_sec}–${pacing.max_sec}s`
}

// ── Prompt character ceiling ────────────────────────────────────────────────
// An LLM writes these prompts; a separately chosen image model renders them.
// The ceiling comes from GenStudio's published `max_prompt_characters` for the
// image model the user intends to render with — never from a list kept here —
// and is handed to the writer as a limit, not as a length to fill. Nothing is
// ever truncated: an over-ceiling prompt is counted, flagged amber, and left
// exactly as written.
const { models: genStudioImageModels, refresh: refreshGenStudioImageModels } = useGenStudioImageModels()
/** Only models this account can actually submit to are worth writing for. */
const usableImageModels = computed(() =>
  genStudioImageModels.value.filter(model => model.available !== false && model.qualification_only !== true),
)
const intendedImageModel = computed(() =>
  usableImageModels.value.find(model => model.id === form.value.intended_image_model) || null,
)
/** What that model publishes right now, or 0 when it publishes nothing. */
const intendedImageModelCap = computed(() => publishedPromptCharCap(intendedImageModel.value))
/** Derived from the DISTINCT caps usable models publish — never a fixed ladder. */
const publishedPromptCharCaps = computed(() => promptCharCapOptions(usableImageModels.value))
const customPromptCharCap = ref(2000)
function setPromptCharCapSetting(value: unknown): void {
  const normalized = normalizePromptCharCapSetting(value)
  form.value.prompt_char_cap = normalized
  if (typeof normalized === 'number' && !publishedPromptCharCaps.value.includes(normalized)) {
    customPromptCharCap.value = normalized
  }
}
const promptCharCapPickerValue = computed<string>({
  get: () => {
    const value = normalizePromptCharCapSetting(form.value.prompt_char_cap)
    if (value === 'auto' || value === 'none') return value
    return publishedPromptCharCaps.value.includes(value) ? String(value) : 'custom'
  },
  set: (value) => {
    if (value === 'custom') {
      setPromptCharCapSetting(customPromptCharCap.value)
      return
    }
    setPromptCharCapSetting(value)
  },
})
function applyCustomPromptCharCap(): void {
  setPromptCharCapSetting(customPromptCharCap.value)
}
/** The number in force. 0 = no ceiling, so no instruction and no warning. */
const effectivePromptCharCap = computed(() =>
  resolvePromptCharCap(normalizePromptCharCapSetting(form.value.prompt_char_cap), intendedImageModelCap.value),
)
/**
 * What one image model publishes, shown AT THE POINT OF CHOOSING so models can
 * be compared at a glance — a longer limit means room for more detailed (and
 * more expensive to write) prompts. A model that publishes nothing says so;
 * no default is ever displayed as if the model had stated it.
 */
function imageModelCapLabel(model: { max_prompt_characters?: number }): string {
  const cap = publishedPromptCharCap(model)
  return cap ? `up to ${cap.toLocaleString()} characters` : 'prompt limit not published'
}
function imageModelCapHint(model: { display_name?: string; max_prompt_characters?: number }): string {
  const cap = publishedPromptCharCap(model)
  const name = model.display_name || 'This model'
  return cap
    ? `${name} accepts prompts up to ${cap.toLocaleString()} characters. Picking it sets the Auto limit to that figure.`
    : `${name} publishes no prompt-character limit, so Auto leaves prompts unlimited. GenStudio still validates every render.`
}
const autoPromptCharCapLabel = computed(() => {
  if (!form.value.intended_image_model) return 'no image model chosen — no limit'
  if (!intendedImageModelCap.value) return `${intendedImageModel.value?.display_name || 'this model'} publishes no limit`
  return `${intendedImageModelCap.value.toLocaleString()} characters`
})
const promptCharCapSummary = computed(() =>
  effectivePromptCharCap.value ? `${effectivePromptCharCap.value.toLocaleString()} char ceiling` : 'No limit',
)
/** The only combination that still ends in a render-time refusal. */
const promptCharCapExceedsModel = computed(() =>
  promptCharCapAboveModel(effectivePromptCharCap.value, intendedImageModelCap.value),
)

// ── The channel default Style Bible's ceiling (owner decision #2) ───────────
//
// The ceiling is what the SELECTED image model publishes for a prompt
// (`max_prompt_characters`), read live — never a fixed 2,000 kept here. A model
// that publishes nothing yields 0 = no ceiling, and the save then stores the
// whole text rather than cutting it to an invented number. The figure is shown
// beside the box and a clipping save says so: §1, a limit that is enforced must
// also be shown. The Style Bible is art direction spliced into the prompt, so
// the model's own published prompt budget is the only honest bound for it.
const defaultStyleBibleCap = computed(() => intendedImageModelCap.value)
const defaultStyleBibleLength = computed(() =>
  promptLengthState(defaultStyleBible.value, defaultStyleBibleCap.value),
)
const defaultStyleBibleLabel = computed(() => promptLengthLabel(defaultStyleBibleLength.value))
const defaultStyleBibleTone = computed(() => promptLengthTone(defaultStyleBibleLength.value))
const defaultStyleBibleCapNote = computed(() => {
  if (!form.value.intended_image_model) {
    return 'No image model is chosen, so Story Studio applies no ceiling here and saves the whole text.'
  }
  const modelName = intendedImageModel.value?.display_name || 'The selected image model'
  if (!defaultStyleBibleCap.value) {
    return `${modelName} publishes no prompt-character limit, so Story Studio applies no ceiling here and saves the whole text.`
  }
  return `Ceiling: ${defaultStyleBibleCap.value.toLocaleString()} characters — what ${modelName} publishes for a prompt. A longer entry is trimmed on save, and Story Studio says so.`
})

function scenePromptLength(scene: { visual_prompt?: string }) {
  return promptLengthState(scene.visual_prompt, effectivePromptCharCap.value)
}
function scenePromptLengthLabel(scene: { visual_prompt?: string }): string {
  return promptLengthLabel(scenePromptLength(scene))
}
function scenePromptLengthTone(scene: { visual_prompt?: string }): string {
  return promptLengthTone(scenePromptLength(scene))
}
/** How many written prompts are over the ceiling. Advisory — never blocking. */
const overCapPromptCount = computed(() => {
  if (!effectivePromptCharCap.value) return 0
  return (plan.value?.scenes || []).filter(scene => scenePromptLength(scene).overCap).length
})
// Auto has to follow SOMETHING, so the intended model is seeded from whatever
// this project already renders scene images with. Seeding only — it is never
// written back, so Scene Review's own render setting is left alone, and an
// empty result stays empty (no limit, no warning) rather than picking a model.
if (!form.value.intended_image_model && typeof window !== 'undefined') {
  form.value.intended_image_model = readRememberedImageModelId(slug.value, window.localStorage)
}
setPromptCharCapSetting(form.value.prompt_char_cap)

/**
 * Recompute the moment the model changes: an allowance too large for the newly
 * selected product is clamped DOWN to what that product publishes. 'auto'
 * always survives — it means "this product's maximum" and so is correct for
 * every product by construction.
 */
watch(publishedMaxOutput, (maximum) => {
  if (!maximum) return
  form.value.prompt_max_tokens = clampOutputAllowance(form.value.prompt_max_tokens, maximum)
})

const scenePlanGenerationUnavailable = computed(() => episodeVisualSource.value !== 'scene_plan')
const subtitleTimelineBlocker = computed(() => {
  if (statusLoading.value) return 'Checking episode readiness…'
  if (statusLoadError.value) return 'Episode readiness could not be checked. Retry to continue.'
  if (!status.value) return 'Episode readiness is unavailable. Retry to continue.'
  if (!status.value?.audio_merged) return 'Generate and assemble audio first'
  if (!status.value?.stitched_srt) return 'Stitch subtitles first (step 1)'
  if (subtitleTimelineComplete.value) return ''
  return missingSubtitleSections.value.length
    ? `Transcribe missing subtitles: ${missingSubtitleSections.value.join(', ')}`
    : 'Repair and re-stitch the subtitle timeline first'
})
const canPlan = computed(() => {
  if (!episodeId.value || episodeVisualSource.value !== 'scene_plan' || visualSettingsError.value) return false
  return !subtitleTimelineBlocker.value
})
const planDisabledReason = computed(() => {
  if (!episodeId.value) return 'Pick an episode first'
  if (statusLoading.value) return 'Checking episode readiness…'
  if (statusLoadError.value) return 'Episode readiness could not be checked. Retry to continue.'
  if (!status.value) return 'Episode readiness is unavailable. Retry to continue.'
  if (episodeVisualSource.value !== 'scene_plan') return visualSourceError.value || 'Choose Scene Plan as this episode’s visual source to build a timeline'
  if (visualSettingsError.value) return visualSettingsError.value
  return subtitleTimelineBlocker.value
})
const sceneDiagnostics = computed(() => {
  const scenes = plan.value?.scenes || []
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const scene of scenes) {
    const normalized = scene.visual_prompt?.trim().replace(/\s+/g, ' ').toLocaleLowerCase() || ''
    if (!normalized) continue
    if (seen.has(normalized)) duplicates.add(scene.id)
    else seen.add(normalized)
  }
  let visualDone = 0
  let motionDone = 0
  let motionPending = 0
  let motionStill = 0
  let overlong = 0
  const problems: Array<{ scene: ScenePlanEntry; index: number; reasons: string[] }> = []
  const problemIds = new Set<string>()
  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i]!
    const visualReady = !!scene.visual_prompt?.trim() && !duplicates.has(scene.id)
    if (visualReady) visualDone++
    if (visualReady && (!scopedMotionIds.value.has(scene.id) || scene.motion_choice === 'still')) motionStill++
    else if (visualReady && scene.motion_prompt?.trim()) motionDone++
    else if (visualReady) motionPending++
    const duration = scene.end_sec - scene.start_sec
    const scenePacingMax = plan.value?.pacing ? pacingBandAt(plan.value.pacing, scene.start_sec).max_sec : Infinity
    if (duration > scenePacingMax + 0.001) overlong++
    const reasons: string[] = []
    if (!scene.visual_prompt?.trim()) reasons.push('no prompt')
    else if (duplicates.has(scene.id)) reasons.push('duplicate prompt')
    if (sceneOverlapsMissingSubtitles(scene)) reasons.push('missing subtitle narration')
    else if (duration > scenePacingMax + 0.001) reasons.push(`${duration.toFixed(0)}s exceeds pace`)
    if (reasons.length) {
      problems.push({ scene, index: i + 1, reasons })
      problemIds.add(scene.id)
    }
  }
  return { duplicates, visualDone, motionDone, motionPending, motionStill, overlong, problems, problemIds }
})
const duplicateVisualPromptIds = computed(() => sceneDiagnostics.value.duplicates)
const visualDoneCount = computed(() => sceneDiagnostics.value.visualDone)
const visualPendingCount = computed(() => Math.max(0, (plan.value?.scenes.length || 0) - visualDoneCount.value))
const motionDoneCount = computed(() => sceneDiagnostics.value.motionDone)
const motionPendingCount = computed(() => sceneDiagnostics.value.motionPending)
const motionStillCount = computed(() => sceneDiagnostics.value.motionStill)
const motionTargetCount = computed(() => Math.max(0, visualDoneCount.value - motionStillCount.value))
const timelineBuiltLabel = computed(() => {
  if (!plan.value?.scenes?.length) return 'Not built yet'
  const estimated = !plan.value.timeline_built_at && visualDoneCount.value === 0
  const builtIso = plan.value.timeline_built_at || (estimated ? plan.value.generated_at : '')
  if (!builtIso) return 'Built before timestamp tracking'
  const built = new Date(builtIso)
  if (Number.isNaN(built.getTime())) return 'Build time unavailable'
  const suffix = estimated ? ' (estimated)' : ''
  return `Last built ${built.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}${suffix}`
})

type HeaderPrimaryStage = 'timeline' | 'visual' | 'motion' | 'ready'
const headerPrimaryStage = computed<HeaderPrimaryStage>(() => {
  if (!plan.value?.scenes?.length) return 'timeline'
  if (visualPendingCount.value > 0) return 'visual'
  if (form.value.generate_motion_prompts && motionPendingCount.value > 0) return 'motion'
  return 'ready'
})
const headerPrimaryLabel = computed(() => {
  if (headerPrimaryStage.value === 'timeline') return '1. Build timeline'
  if (headerPrimaryStage.value === 'visual') {
    return `2. Generate ${visualPendingCount.value} visual prompt${visualPendingCount.value === 1 ? '' : 's'}`
  }
  if (headerPrimaryStage.value === 'motion') {
    return `3. Generate ${motionPendingCount.value} motion prompt${motionPendingCount.value === 1 ? '' : 's'}`
  }
  return '✓ Scene plan ready'
})
const headerPrimaryLoadingLabel = computed(() => {
  if (headerPrimaryStage.value === 'timeline') return 'Building timeline…'
  if (headerPrimaryStage.value === 'motion') return 'Generating motion prompts…'
  return 'Generating visual prompts…'
})
const headerPrimaryDisabled = computed(() => {
  if (episodeVisualSource.value !== 'scene_plan') return true
  if (headerPrimaryStage.value !== 'visual' && visualSettingsError.value) return true
  if (headerPrimaryStage.value === 'ready') return true
  if (headerPrimaryStage.value === 'timeline') return !canPlan.value
  return !!subtitleTimelineBlocker.value || !form.value.model || !plan.value
})
const headerPrimaryStatus = computed(() => {
  if (!episodeId.value) return 'Pick an episode first'
  if (statusLoading.value) return 'Checking episode readiness…'
  if (statusLoadError.value) return 'Episode readiness could not be checked. Retry to continue.'
  if (!status.value) return 'Episode readiness is unavailable. Retry to continue.'
  if (episodeVisualSource.value !== 'scene_plan') return visualSourceError.value || 'Image Pool visuals are configured in Video Assembly. Saved Scene Plan assets remain here.'
  if (planning.value || planJobActive.value) return `Scene Plan is working on ${episodeId.value}…`
  if (headerPrimaryStage.value === 'timeline') return canPlan.value ? '' : planDisabledReason.value
  if (subtitleTimelineBlocker.value) return subtitleTimelineBlocker.value
  if (!form.value.model) return 'Choose the visual and motion prompt model first'
  if (headerPrimaryStage.value === 'visual') return `${visualPendingCount.value} scene prompts still need to be generated`
  if (headerPrimaryStage.value === 'motion') return `${motionPendingCount.value} optional motion prompts still need to be generated`
  return form.value.generate_motion_prompts
    ? 'All visual and motion prompts are ready'
    : 'All visual prompts are ready; optional motion prompts are switched off'
})

async function runHeaderPrimaryAction(): Promise<void> {
  if (headerPrimaryStage.value === 'timeline') await planScenes()
  else if (headerPrimaryStage.value === 'visual') await runPromptStage('visual')
  else if (headerPrimaryStage.value === 'motion') await runPromptStage('motion')
}

async function loadStatus(): Promise<void> {
  const ep = episodeId.value
  const project = slug.value
  const requestSequence = ++statusLoadSequence
  if (!ep) {
    statusLoading.value = false
    statusLoadError.value = ''
    status.value = null
    plan.value = null
    dirty.value = false
    return
  }
  statusLoading.value = true
  statusLoadError.value = ''
  try {
    const r = await get<ScenePlanStatus>(`/projects/${project}/scene-plan/${ep}`)
    if (requestSequence !== statusLoadSequence || episodeId.value !== ep || slug.value !== project) return
    status.value = r
    statusLoadError.value = ''
    if (r.scene_plan) {
      plan.value = r.scene_plan
      dirty.value = false
      if (loadedPlanEpisode !== ep) {
        loadedPlanEpisode = ep
        renderedSceneLimit.value = SCENE_RENDER_BATCH
      }
    } else {
      plan.value = null
      dirty.value = false
      loadedPlanEpisode = ep
      renderedSceneLimit.value = SCENE_RENDER_BATCH
    }
  } catch (e: any) {
    if (requestSequence !== statusLoadSequence || episodeId.value !== ep || slug.value !== project) return
    if (e?.__slugRace) return
    status.value = null
    plan.value = null
    statusLoadError.value = e?.data?.detail || e?.message || 'Could not load this episode’s scene plan'
    showError(statusLoadError.value)
  } finally {
    if (requestSequence === statusLoadSequence && episodeId.value === ep && slug.value === project) {
      statusLoading.value = false
    }
  }
}

function retryStatus(): void {
  if (!episodeId.value || statusLoading.value) return
  void loadStatus()
}

// v1.0.218 — stitching moved to the Subtitles workspace; this page only
// reads the stitched-SRT status now (see Step 1 → Subtitles link).

async function planScenes(): Promise<void> {
  if (!canPlan.value) return
  if (plan.value?.scenes?.length) {
    const ok = await ask({
      title: 'Rebuild the scene timeline?',
      message: `${timelineBuiltLabel.value}. This recalculates all ${plan.value.scenes.length} scene windows from the stitched subtitles and clears their current visual and motion prompts. Existing image files are not deleted, but changed scene IDs may no longer match them.`,
      confirmLabel: 'Rebuild timeline',
    })
    if (!ok) return
  }
  const ep = episodeId.value
  planningEpisode.value = ep
  try {
    // No opening fields travel with the request any more — the backend probes
    // the project's real opening clips instead. See `refreshMeasuredOpening`.
    await post(`/projects/${slug.value}/scene-plan/${ep}/run`, { stage: 'timeline' })
    success('Timeline build queued — no LLM call is needed')
    await pollUntilPlanLanded(ep)
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to start planner')
  } finally {
    if (planningEpisode.value === ep) planningEpisode.value = null
  }
}

async function runPromptStage(stage: 'visual' | 'motion', promptLimit?: number): Promise<void> {
  if (scenePlanGenerationUnavailable.value || (stage === 'motion' && visualSettingsError.value)) return
  if (subtitleTimelineBlocker.value) {
    showError(subtitleTimelineBlocker.value)
    return
  }
  if (!form.value.model || !plan.value) return
  const ep = episodeId.value
  planningEpisode.value = ep
  const previousGeneratedAt = plan.value.generated_at || null
  try {
    const job = await post<{ job_id?: string }>(`/projects/${slug.value}/scene-plan/${ep}/run`, {
      model: form.value.model,
      stage,
      prompt_limit: promptLimit,
      prompt_pack_size: form.value.prompt_pack_size,
      use_research: form.value.use_research,
      prompt_max_tokens: stage === 'visual' ? form.value.prompt_max_tokens : undefined,
      // The RESOLVED ceiling: the workspace is the only place that knows which
      // image model these prompts are for. 0 → undefined → no limit is sent.
      prompt_char_cap: stage === 'visual' ? (effectivePromptCharCap.value || undefined) : undefined,
      detail_level: 4,
      motion_level: form.value.motion_level,
      creative_direction: creativeDirectionPayload.value,
      // X-06 — the episode box plus the preset-carried reusable text, composed
      // into the one guidance input the backend accepts.
      custom_instructions: composeScenePlanGuidance(form.value.custom_instructions, form.value.reusable_guidance),
      avoid_legible_text: form.value.avoid_legible_text,
    })
    success(`${stage === 'visual' ? 'Visual' : 'Motion'} prompt packs queued — watch progress in Jobs.`)
    await pollUntilPlanLanded(ep, { previousGeneratedAt, timeoutMs: 3_600_000, trackJobId: job?.job_id || null })
  } catch (e: any) {
    await reportGenerationError(e, `Failed to start ${stage} prompt stage`)
  } finally {
    if (planningEpisode.value === ep) planningEpisode.value = null
  }
}

async function pollUntilPlanLanded(
  ep: string,
  opts?: { previousGeneratedAt?: string | null; timeoutMs?: number; trackJobId?: string | null },
): Promise<void> {
  const start = Date.now()
  // v1.0.458 — bulk parallel regen is one long job, so callers can extend the
  // deadline past the 120s default; trackJobId drives the progress bar and
  // detects a terminal (error/cancelled) job so we don't wait out the timeout.
  const timeoutMs = opts?.timeoutMs ?? 120_000
  const trackJobId = opts?.trackJobId ?? null
  // v1.0.287 — `previousGeneratedAt` lets callers wait specifically for a
  // NEW plan to land, not any-existing-recent plan. An old serial repair loop
  // hit this: on iteration 2+, the previous job's generated_at was still
  // < 120s old, so the legacy "is generated_at recent?" check returned
  // immediately — the second job hadn't even started running yet. The loop
  // then raced ahead, hit isDuplicate 409s on every subsequent POST, and
  // only ONE scene actually got repaired out of (e.g.) 77 placeholders.
  // Now: when previousGeneratedAt is supplied we keep polling until the
  // server's generated_at differs from it. Legacy callers (no opts) keep
  // the old "any-recent" behaviour for backwards compat.
  const prev = opts?.previousGeneratedAt ?? null
  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 3000))
    if (episodeId.value !== ep) return  // switched away — stop; the new episode's own load owns its state
    // v1.0.458 — drive the bulk progress bar from the job's % and bail early
    // if the job terminated (error/cancelled) instead of waiting for the
    // generated_at advance that will never come.
    if (trackJobId) {
      try {
        const j = await get<{ status: string; progress?: number }>(`/projects/${slug.value}/jobs/${trackJobId}`)
        if (j && typeof j.progress === 'number' && bulkReplan.value.active && bulkReplan.value.total > 0) {
          const frac = Math.max(0, Math.min(1, (j.progress - 10) / 85))
          bulkReplan.value.completed = Math.round(bulkReplan.value.total * frac)
        }
        if (j && (j.status === 'done' || j.status === 'error' || j.status === 'cancelled')) {
          await loadStatus()
          return
        }
      } catch { /* transient job-poll error — keep waiting on generated_at */ }
    }
    await loadStatus()
    // A tracked staged job persists every completed Hub pack immediately, so
    // generated_at may advance long before the full batch is terminal. Keep
    // polling the Story job; only untracked legacy calls use timestamp change.
    if (!trackJobId && plan.value && plan.value.generated_at) {
      if (prev !== null) {
        // Wait specifically for generated_at to advance past `prev`.
        if (plan.value.generated_at !== prev) return
      } else {
        const generated = new Date(plan.value.generated_at).getTime()
        if (Date.now() - generated < timeoutMs) return
      }
    }
  }
  if (episodeId.value === ep) showError('Scene planner taking longer than expected — check the Jobs panel.')
}

// ── Plan health + deterministic repair guidance ─────────────────────────
// Flag scenes that look broken so they're findable without scrolling. An exact
// duplicate is pending work, not a valid prompt for another scene.
const problemScenes = computed(() => sceneDiagnostics.value.problems)
const problemIds = computed(() => sceneDiagnostics.value.problemIds)
const overlongSceneCount = computed(() => sceneDiagnostics.value.overlong)

// Missing and duplicated prompts can be regenerated without changing bounds.
const emptyPromptCount = computed(() => Math.max(0, (plan.value?.scenes.length || 0) - visualDoneCount.value))

async function jumpToScene(id: string): Promise<void> {
  if (typeof document === 'undefined') return
  const sceneIndex = plan.value?.scenes.findIndex(scene => scene.id === id) ?? -1
  if (sceneIndex >= renderedSceneLimit.value) {
    renderedSceneLimit.value = sceneIndex + 1
    await nextTick()
  }
  const el = document.getElementById(`splan-scene-${id}`)
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.classList.add('scene-row-flash')
    setTimeout(() => el.classList.remove('scene-row-flash'), 1500)
  }
}

// Prompt-only regeneration never changes deterministic timeline boundaries.
const regenPromptId = ref<string | null>(null)
// Distinguishes the two buttons that share `regenPromptId` so only the one that
// was pressed shows its busy label.
const rewordingPrompt = ref(false)
async function regenerateScenePrompt(scene: ScenePlanEntry, opts: { reword?: boolean } = {}): Promise<void> {
  if (scenePlanGenerationUnavailable.value) return
  if (!subtitleTimelineComplete.value) { showError('Complete and stitch every subtitle chapter first.'); return }
  if (!form.value.model) { showError('Pick a model above first'); return }
  if (!scene.transcript_segment?.trim()) { showError('Scene has no transcript_segment to base a prompt on.'); return }
  if (opts.reword && !scene.visual_prompt?.trim()) {
    showError('Nothing to reword yet — write or generate this scene\'s prompt first.')
    return
  }
  const ep = episodeId.value
  regenPromptId.value = scene.id
  rewordingPrompt.value = opts.reword === true
  const previousGeneratedAt = plan.value?.generated_at || null
  const payload = {
    scene_id: scene.id,
    model: form.value.model,
    detail_level: 4,
    prompt_char_cap: effectivePromptCharCap.value || undefined,
    creative_direction: creativeDirectionPayload.value,
    custom_instructions: composeScenePlanGuidance(form.value.custom_instructions, form.value.reusable_guidance),
    avoid_legible_text: form.value.avoid_legible_text,
    ...(opts.reword ? { reword_prompt: true } : {}),
  }
  const operationId = freshScenePromptAction.begin(payload, `visual:${scene.id}`)
  try {
    await post(`/projects/${slug.value}/scene-plan/${ep}/regenerate-prompt`, {
      ...payload,
      operation_id: operationId,
    })
    freshScenePromptAction.complete(operationId)
    success(opts.reword
      ? 'Reword queued — the same beat from a different angle; the prompt updates when it lands.'
      : 'Regen queued — watch the Jobs panel; the prompt updates when it lands.')
    await pollUntilPlanLanded(ep, { previousGeneratedAt })
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || `Failed to start prompt ${opts.reword ? 'reword' : 'regen'}`)
  } finally {
    regenPromptId.value = null
    rewordingPrompt.value = false
  }
}

/**
 * Manual "this prompt did not render — reword it". Rewrites this one prompt
 * from a different angle on the same narrative beat, with the difficult-
 * subjects guidance applied (aftermath over act, period-illustration framing,
 * no age markers), keeping the historical substance intact.
 *
 * Deliberately manual: Story Studio cannot today tell a provider content
 * refusal from any other failure, so nothing triggers this automatically.
 */
function rewordScenePrompt(scene: ScenePlanEntry): Promise<void> {
  return regenerateScenePrompt(scene, { reword: true })
}

// v1.0.468 — motion-prompt: inline save (on blur) + LLM regen for one scene.
const regenMotionId = ref<string | null>(null)
async function saveMotionPrompt(scene: ScenePlanEntry): Promise<void> {
  const ep = episodeId.value
  if (!ep) return
  try {
    await post(`/projects/${slug.value}/scene-plan/${ep}/set-motion-prompt`, {
      scene_id: scene.id,
      motion_prompt: (scene.motion_prompt || '').trim(),
    })
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to save motion prompt')
  }
}
async function regenMotionPrompt(scene: ScenePlanEntry): Promise<void> {
  if (scenePlanGenerationUnavailable.value) return
  if (!form.value.model) { showError('Pick a model above first'); return }
  if (!scene.visual_prompt?.trim()) { showError('Write the visual prompt first — the motion prompt animates that image.'); return }
  const ep = episodeId.value
  regenMotionId.value = scene.id
  const previousGeneratedAt = plan.value?.generated_at || null
  const payload = {
    scene_id: scene.id,
    model: form.value.model,
    motion_level: form.value.motion_level,
  }
  const operationId = freshScenePromptAction.begin(payload, `motion:${scene.id}`)
  try {
    await post(`/projects/${slug.value}/scene-plan/${ep}/regenerate-motion-prompt`, {
      ...payload,
      operation_id: operationId,
    })
    freshScenePromptAction.complete(operationId)
    success('Motion regen queued — the prompt updates when the job lands.')
    await pollUntilPlanLanded(ep, { previousGeneratedAt })
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to start motion regen')
  } finally {
    regenMotionId.value = null
  }
}

/** Repair every missing or duplicated prompt in bounded GenStudio packs. */
async function regenAllEmptyPrompts(): Promise<void> {
  if (scenePlanGenerationUnavailable.value) return
  if (!form.value.model) { showError('Pick a model above first'); return }
  if (bulkReplan.value.active) return
  const empty = (plan.value?.scenes || []).filter(
    s => (!s.visual_prompt || !s.visual_prompt.trim() || duplicateVisualPromptIds.value.has(s.id))
      && (s.transcript_segment && s.transcript_segment.trim()),
  )
  if (!empty.length) {
    success('No repairable scenes — every narrated scene already has a unique prompt.')
    return
  }
  const ep = episodeId.value
  const ok = await ask({
    title: `Repair ${empty.length} visual prompt${empty.length === 1 ? '' : 's'}?`,
    message:
      `Rewrites only missing or duplicated visual prompts in packs of up to ${effectivePromptPackSize.value} scenes per GenStudio request. `
      + `Time boundaries, transcripts, and completed prompts stay exactly as-is.`
      + `${dirty.value ? ' Unsaved edits to the plan will be discarded first.' : ''}`,
    confirmLabel: `Repair all ${empty.length}`,
  })
  if (!ok) return

  bulkReplan.value = {
    active: true, completed: 0, total: empty.length,
    currentSceneIndex: null, cancelRequested: false, jobId: null,
  }

  const previousGeneratedAt = plan.value?.generated_at || null
  try {
    const job = await post<{ job_id?: string }>(`/projects/${slug.value}/scene-plan/${ep}/regenerate-empty-prompts`, {
      model: form.value.model,
      detail_level: 4,
      prompt_pack_size: form.value.prompt_pack_size,
      prompt_max_tokens: form.value.prompt_max_tokens,
      prompt_char_cap: effectivePromptCharCap.value || undefined,
      use_research: form.value.use_research,
      creative_direction: creativeDirectionPayload.value,
      // X-06 — the episode box plus the preset-carried reusable text, composed
      // into the one guidance input the backend accepts.
      custom_instructions: composeScenePlanGuidance(form.value.custom_instructions, form.value.reusable_guidance),
      avoid_legible_text: form.value.avoid_legible_text,
    })
    bulkReplan.value.jobId = job?.job_id || null
    success('Prompt repair queued in durable GenStudio packs. Watch the Jobs panel for detail.')
    // One long job: extend the deadline well past the 120s default and let the
    // job's % drive the progress bar.
    await pollUntilPlanLanded(ep, { previousGeneratedAt, timeoutMs: 1_800_000, trackJobId: job?.job_id || null })
    if (episodeId.value !== ep) return  // user switched episodes mid-run

    const stillEmpty = (plan.value?.scenes || []).filter(
      s => (!s.visual_prompt || !s.visual_prompt.trim()) && (s.transcript_segment && s.transcript_segment.trim()),
    ).length
    const filled = Math.max(0, empty.length - stillEmpty)
    if (bulkReplan.value.cancelRequested) {
      success(`Bulk regen cancelled. Filled ${filled} of ${empty.length} before stopping.`)
    } else if (stillEmpty > 0 && filled > 0) {
      success(`Bulk regen finished. Filled ${filled}, ${stillEmpty} still empty. Re-run the button to retry, or fill the rest in manually.`)
    } else if (stillEmpty > 0 && filled === 0) {
      showError('Bulk regen finished with 0 prompts filled. Choose another available GenStudio model and retry.')
    } else {
      success(`Regenerated ${filled} visual prompt${filled === 1 ? '' : 's'} across your pool.`)
    }
  } catch (e: any) {
    await reportGenerationError(e, 'Failed to start bulk regen')
  } finally {
    bulkReplan.value = { active: false, completed: 0, total: 0, currentSceneIndex: null, cancelRequested: false, jobId: null }
  }
}

// Bulk prompt regeneration state. Timeline boundaries never change here.
const bulkReplan = ref<{
  active: boolean
  completed: number
  total: number
  currentSceneIndex: number | null
  cancelRequested: boolean
  /** Backend job id for the packed repair, so Cancel can stop it. */
  jobId?: string | null
}>({ active: false, completed: 0, total: 0, currentSceneIndex: null, cancelRequested: false })

function cancelBulkReplan(): void {
  if (!bulkReplan.value.active) return
  bulkReplan.value.cancelRequested = true
  // The packed repair is one backend job. Cancelling the frontend poll alone
  // would leave it running, so tell the server to stop between packs.
  const jobId = bulkReplan.value.jobId
  if (jobId) {
    void del(`/projects/${slug.value}/jobs/${jobId}`).catch(() => { /* already finished — harmless */ })
  }
}

// Back-to-top tracks the dashboard's real scroll container. The previous
// selector targeted .page-content from another layout, so the button could
// never appear on project pages even after scrolling through 100+ scenes.
const showBackToTop = ref(false)
const SCROLL_THRESHOLD = 800   // px before the button surfaces

function getScrollContainer(): HTMLElement | null {
  if (typeof document === 'undefined') return null
  return document.querySelector('.main-content') as HTMLElement | null
}
function onScroll(): void {
  const el = getScrollContainer()
  if (!el) return
  showBackToTop.value = el.scrollTop > SCROLL_THRESHOLD
}
function scrollToTop(): void {
  const el = getScrollContainer()
  if (!el) return
  el.scrollTo({ top: 0, behavior: 'smooth' })
}

onMounted(() => {
  const el = getScrollContainer()
  if (el) {
    el.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
  }
  if (typeof IntersectionObserver !== 'undefined') {
    sceneLoadObserver = new IntersectionObserver((entries) => {
      if (entries.some(entry => entry.isIntersecting)) loadMoreScenes()
    }, { root: el, rootMargin: '500px 0px' })
    if (sceneLoadSentinel.value) sceneLoadObserver.observe(sceneLoadSentinel.value)
  }
})
watch(sceneLoadSentinel, (next, previous) => {
  if (!sceneLoadObserver) return
  if (previous) sceneLoadObserver.unobserve(previous)
  if (next) sceneLoadObserver.observe(next)
})
onUnmounted(() => {
  const el = getScrollContainer()
  if (el) el.removeEventListener('scroll', onScroll)
  sceneLoadObserver?.disconnect()
  sceneLoadObserver = null
})

const repairingLongScenes = ref(false)
async function repairLongScenes(): Promise<void> {
  if (!episodeId.value || repairingLongScenes.value || !subtitleTimelineComplete.value) return
  const ok = await ask({
    title: `Repair ${overlongSceneCount.value} out-of-range scene${overlongSceneCount.value === 1 ? '' : 's'}?`,
    message: `Uses the subtitle text to split only scenes beyond their saved plan pacing. Plans without saved pacing use the existing repair threshold. No LLM is used. Every unaffected scene, prompt, image, and approval stays in place; newly uncovered scenes will need visual prompts and images.`,
    confirmLabel: 'Repair scenes',
  })
  if (!ok) return
  repairingLongScenes.value = true
  try {
    const result = await post<{ repairedCount: number; addedCount: number }>(
      `/projects/${slug.value}/scene-plan/${episodeId.value}/repair-long-scenes`,
      {},
    )
    await loadStatus()
    await revalidateEpisodes()
    success(`Repaired ${result.repairedCount} long scene${result.repairedCount === 1 ? '' : 's'} and restored ${result.addedCount} cue-aligned scene${result.addedCount === 1 ? '' : 's'}. Generate prompts only for the new scenes.`)
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to repair long scenes')
  } finally {
    repairingLongScenes.value = false
  }
}

// Heal full audio coverage from the verified subtitle cues. Large narrated
// gaps become new pending scenes instead of one extended frozen image.
const repairingCoverage = ref(false)
/** Seconds of narration before scene 1 that the last repair deliberately left
 *  alone, because closing it is an editorial choice rather than a repair.
 *  Drives the "Cover the opening" offer. */
const headGapLeftSec = ref(0)
async function repairCoverage(holdHeadScene = false): Promise<void> {
  if (!episodeId.value || repairingCoverage.value) return
  repairingCoverage.value = true
  try {
    const r = await post<{
      ok: boolean
      audio_duration_sec: number
      changes: string[]
      coverage_after: { uncoveredTotalSec: number }
      repaired_long_scene_count: number
      added_scene_count: number
      head_gap_left_sec?: number
    }>(`/projects/${slug.value}/scene-plan/${episodeId.value}/repair-coverage`,
      holdHeadScene ? { hold_head_scene: true } : {})
    headGapLeftSec.value = r.head_gap_left_sec || 0
    if (r.changes?.length) {
      success(`Coverage repaired — plan now covers ${r.audio_duration_sec.toFixed(1)}s of audio. ${r.changes.join(' ')}`)
    } else if (headGapLeftSec.value > 0) {
      // The one case where "nothing to repair" was a lie: everything from scene
      // 1 onward is fine, and the opening before it is untouched on purpose.
      // Say so, and say what each way forward costs.
      showError(
        `Nothing else to repair, but the first ${headGapLeftSec.value.toFixed(0)}s of narration still has no scene. `
        + 'Use "Cover the opening" to hold scene 1 across it, or re-run Scene Plan with the introduction included '
        + 'to plan real scenes for it (that needs new prompts and images).',
      )
    } else {
      success(`Plan already covers the full audio (${r.audio_duration_sec.toFixed(1)}s) — nothing to repair.`)
    }
    await loadStatus()
    await revalidateEpisodes()
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to repair coverage')
  } finally {
    repairingCoverage.value = false
  }
}

// v1.0.523 — re-anchor scene timings to the CURRENT stitched subtitles.
// Use after re-generating audio / re-stitching subtitles, when the plan's
// timings drifted out of sync with the voice. Keeps every scene image.
const reconciling = ref(false)
async function reconcileTimings(): Promise<void> {
  if (!episodeId.value || reconciling.value) return
  reconciling.value = true
  try {
    const r = await post<{
      matched: number
      total: number
      unmatched_ids: string[]
      median_shift_sec: number
      changes: string[]
    }>(`/projects/${slug.value}/scene-plan/${episodeId.value}/reconcile-timings`, {})
    const warn = r.unmatched_ids.length ? ` (${r.unmatched_ids.length} interpolated — spot-check them)` : ''
    success(`Re-anchored ${r.matched}/${r.total} scene(s) to the subtitles${warn}. ${r.changes.join(' ')}`)
    await loadStatus()
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to reconcile timings')
  } finally {
    reconciling.value = false
  }
}

async function savePlan(): Promise<void> {
  if (!plan.value || !episodeId.value) return
  // Recompute scene_index from current order before save.
  plan.value.scenes.forEach((s, i) => { s.scene_index = i + 1 })
  saving.value = true
  try {
    await put(`/projects/${slug.value}/scene-plan/${episodeId.value}`, plan.value)
    dirty.value = false
    success('Scene plan saved')
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to save scene plan')
  } finally {
    saving.value = false
  }
}

async function deletePlan(): Promise<void> {
  if (!episodeId.value) return
  const ok = await ask({
    title: 'Delete scene plan?',
    message: 'Removes scene_plan.json from the "03 Scene Prompts" folder. Generated images are NOT deleted — only the planning data.',
    confirmLabel: 'Delete',
    danger: true,
  })
  if (!ok) return
  deleting.value = true
  try {
    await del(`/projects/${slug.value}/scene-plan/${episodeId.value}`)
    plan.value = null
    dirty.value = false
    success('Scene plan deleted')
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to delete scene plan')
  } finally {
    deleting.value = false
  }
}

function freshSceneId(): string {
  return `scene_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function mergeScene(i: number): void {
  if (!plan.value || i === 0) return
  const prev = plan.value.scenes[i - 1]!
  const cur = plan.value.scenes[i]!
  prev.end_sec = cur.end_sec
  prev.transcript_segment = `${prev.transcript_segment} ${cur.transcript_segment}`.trim()
  prev.visual_prompt = `${prev.visual_prompt} (merged with: ${cur.visual_prompt})`
  plan.value.scenes.splice(i, 1)
  markPlanDirty()
}

function splitScene(i: number): void {
  if (!plan.value) return
  const cur = plan.value.scenes[i]!
  const midpoint = (cur.start_sec + cur.end_sec) / 2
  const newScene: ScenePlanEntry = {
    id: freshSceneId(),
    scene_index: 0,  // re-stamped on save
    start_sec: midpoint,
    end_sec: cur.end_sec,
    transcript_segment: '(split — paste the second half here)',
    visual_prompt: cur.visual_prompt,
    approved: false,
  }
  cur.end_sec = midpoint
  plan.value.scenes.splice(i + 1, 0, newScene)
  markPlanDirty()
}

function removeScene(i: number): void {
  if (!plan.value || plan.value.scenes.length <= 1) return
  // The next scene extends to fill the gap so the timeline stays contiguous.
  const cur = plan.value.scenes[i]!
  const next = plan.value.scenes[i + 1]
  if (next) {
    next.start_sec = cur.start_sec
  } else {
    // Removing the last scene — the previous one extends to its end.
    const prev = plan.value.scenes[i - 1]
    if (prev) prev.end_sec = cur.end_sec
  }
  plan.value.scenes.splice(i, 1)
  markPlanDirty()
}

const visualTimingMotion = ref<{
  snapshotPreset: () => Record<string, unknown>
  applyPreset: (data: any) => void
} | null>(null)
const visualPresetNotice = ref('')
// X-06 (owner decision 2026-09-22) — set when an episode change drops written
// episode guidance, so the clear is announced rather than silent (AGENTS.md §4).
const episodeGuidanceNotice = ref('')

function snapshotVisualPreset(): Record<string, unknown> {
  if (visualTimingMotion.value) return visualTimingMotion.value.snapshotPreset()
  if (episodeId.value && episodeVisualSource.value !== 'image_pool') {
    throw new Error('Visual timing is still loading. Wait for the panel before saving a preset.')
  }
  return {}
}

// Restoring remembered prompt settings on mount must not apply a rhythm to
// an episode. Only the explicit preset Apply action reaches the timing panel.
function applyPromptPreset(data: any): void {
  // Retired presets may contain a per-plan style. Ignore it so Character
  // Sheet remains the single authoritative style source.
  const activeData = { ...(data || {}) }
  delete activeData.style_prompt
  // Episode timing and motion belong to the panel, never the prompt form.
  delete activeData.pacing
  delete activeData.motion_scope
  delete activeData.generate_motion_prompts
  delete activeData.motion_level
  // v1.3.1 — presets saved before this release carry a stale opening length.
  // Drop it on read so it cannot reach `form.value` and cannot be re-saved;
  // the file on disk is left exactly as it is (AGENTS.md: stored presets are
  // never rewritten).
  delete activeData.opening_mode
  delete activeData.opening_reserved_sec
  const savedCreative = activeData.creative_direction as Partial<CreativeDirection> | undefined
  delete activeData.creative_direction
  Object.assign(form.value, activeData)
  if (savedCreative) {
    if (CREATIVE_PROFILES.some(profile => profile.id === savedCreative.profile)) {
      form.value.creative_profile = savedCreative.profile as CreativeProfile
    }
    form.value.creative_intensity = Math.max(1, Math.min(4, Math.round(Number(savedCreative.intensity) || 2)))
    if (Array.isArray(savedCreative.strategies)) {
      const usable = savedCreative.strategies.filter(strategy => CREATIVE_STRATEGIES.some(option => option.id === strategy))
      if (usable.length) form.value.creative_strategies = usable
    }
    form.value.creative_motifs = savedCreative.recurring_motifs || ''
    form.value.creative_avoid_cliches = savedCreative.avoid_cliches || ''
    form.value.creative_custom_direction = savedCreative.custom_direction || ''
  }
  setPromptPackSetting(form.value.prompt_pack_size)
  // Restores the SELECTION only. A custom ceiling is NOT raised to the
  // model's published cap — a smaller one is a deliberate cost control — and
  // an unknown intended model simply resolves to "no limit".
  setPromptCharCapSetting(form.value.prompt_char_cap)
  // A preset stores the SELECTION, never a copied catalogue limit. Clamp the
  // restored allowance against what the model publishes right now.
  form.value.prompt_max_tokens = clampOutputAllowance(
    normalizePromptTokenSetting(form.value.prompt_max_tokens),
    publishedMaxOutput.value,
  )
}

// v1.0.242 — savable presets for the plan settings (model, research toggle,
// output budget, episode timing draft, portable motion, and instructions). Mirrors the
// same local PresetPicker pattern used on Ideas / Scripts. Stored under
// config.scene_plan_presets; episode_id/title are stripped automatically.
const planPresets = usePresets<any>({
  slug: slug.value,
  configKey: 'scene_plan',
  presetType: 'scene-plan',
  autoApplyOnLoad: false,
  // Owner decision #9, 2026-09-20. `custom_instructions` is written for ONE
  // episode ("this episode only" is the field's own label), so a preset must not
  // carry it onto another episode. The cast and the reusable look still travel.
  // Spread the shared list — `excludeKeys` REPLACES the default rather than
  // extending it, so restating the four identity strings here is exactly the
  // duplication that drifts and re-opens the §4 episode-identity leak.
  //
  // X-06 (owner decision 2026-09-22) — `reusable_guidance` is NOT excluded: the
  // whole point of the second box is that it travels with the preset and is
  // applied deliberately. It is never written to project config, so this preset
  // entry is its only durable home; and because `apply` reads through the same
  // exclusion list, excluding it here would silently discard it on the way back
  // in as well (AGENTS.md §5's two-way trap).
  excludeKeys: [...DEFAULT_EXCLUDE_KEYS, 'custom_instructions'],
  snapshot: () => ({
    model: form.value.model,
    use_research: form.value.use_research,
    // v1.3.1 — `opening_mode` / `opening_reserved_sec` are no longer saved.
    // The opening's length is a measurable property of the project's clips,
    // not a reusable creative choice, so a preset has no business asserting
    // it. Presets already on disk keep the two stale keys and are never
    // rewritten; `apply` below simply ignores them.
    prompt_pack_size: form.value.prompt_pack_size,
    prompt_max_tokens: form.value.prompt_max_tokens,
    // The SELECTION travels, never a resolved catalogue number: GenStudio may
    // publish a different `max_prompt_characters` tomorrow.
    intended_image_model: form.value.intended_image_model,
    prompt_char_cap: form.value.prompt_char_cap,
    creative_direction: creativeDirectionPayload.value,
    detail_level: 4,
    custom_instructions: form.value.custom_instructions,
    reusable_guidance: form.value.reusable_guidance,
    avoid_legible_text: form.value.avoid_legible_text,
    ...snapshotVisualPreset(),
  }),
  apply: (data) => {
    // Apply synchronously before prompt fields: a loading/invalid panel must
    // report a failed Apply rather than quietly applying half the preset.
    if (visualTimingMotion.value) visualTimingMotion.value.applyPreset(data)
    else if (episodeId.value && episodeVisualSource.value !== 'image_pool') {
      throw new Error('Visual timing is still loading. Wait for the panel, then apply the preset.')
    }
    applyPromptPreset(data)
    visualPresetNotice.value = visualTimingMotion.value
      ? ''
      : 'Prompt settings applied. Select a Scene Plan episode and click Apply to use this preset’s timing and motion.'
  },
})

watch([slug, episodeId], () => {
  visualPresetNotice.value = ''
  // X-06 (owner decision 2026-09-22) — the box above is labelled "this episode
  // only", so written guidance must not follow the customer to the next one and
  // silently steer its prompts (AGENTS.md §4). The reusable box is deliberately
  // NOT cleared: it is not owned by an episode, and its durable copy lives in
  // the customer's presets.
  episodeGuidanceNotice.value = form.value.custom_instructions.trim()
    ? 'Episode-specific guidance was cleared because the episode changed. Reusable guidance was kept.'
    : ''
  form.value.custom_instructions = ''
  status.value = null
  plan.value = null
  dirty.value = false
  statusLoadError.value = ''
  statusLoading.value = Boolean(episodeId.value)
  void Promise.all([loadStatus(), loadContinuity(), loadVisualSource()])
}, { immediate: true, flush: 'sync' })
// The announcement has done its job once the customer writes new guidance for
// the episode now on screen.
watch(() => form.value.custom_instructions, (value) => {
  if (value.trim()) episodeGuidanceNotice.value = ''
})
watch(() => [route.query.episode_id, route.query.episode], ([episodeFromId, episodeFromAlias]) => {
  const nextEpisodeId = typeof episodeFromId === 'string'
    ? episodeFromId
    : typeof episodeFromAlias === 'string'
      ? episodeFromAlias
      : ''
  if (nextEpisodeId !== episodeId.value) episodeId.value = nextEpisodeId
})
onMounted(() => {
  void planPresets.load().then(() => {
    const preset = planPresets.presets.value.find(p => p.id === planPresets.activeId.value)
    if (preset) applyPromptPreset(preset.data)
  })
  // The character ceiling is only as honest as the catalogue behind it.
  void refreshGenStudioImageModels().catch(() => {})
  void loadRequestTimeout()
})
// Re-measure whenever the customer comes back to this page or switches
// project: he may have just changed the intro clip in Video Assembly, and a
// stale figure here would be exactly the remembered-number problem again.
watch(slug, () => { void refreshMeasuredOpening() }, { immediate: true })
</script>

<style scoped>
.scene-plan-workspace :deep(.workspace-command-surface .top-action-bar) {
  margin: 0;
  border: 0;
  background: transparent;
  box-shadow: none;
}

.scene-workflow-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.scene-setting-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: color-mix(in srgb, var(--bg-secondary) 88%, transparent);
}
.scene-setting-model { grid-column: 1 / -1; }
/* Per-prompt character counter. Amber — never red — when a prompt is over the
   ceiling: the prompt is intact, generation succeeded, and the user may still
   render it. Nothing here disables a control. */
.prompt-length-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.prompt-char-badge {
  flex: 0 0 auto;
  padding: 1px 6px;
  border: 1px solid var(--border);
  border-radius: 999px;
  font-size: var(--font-xs);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.prompt-char-badge.is-neutral { background: var(--bg-tertiary); color: var(--text-muted); }
.prompt-char-badge.is-ok {
  background: color-mix(in srgb, var(--bg-tertiary) 80%, transparent);
  color: var(--text-muted);
}
.prompt-char-badge.is-warn {
  background: color-mix(in srgb, var(--warning) 16%, transparent);
  border-color: color-mix(in srgb, var(--warning) 55%, transparent);
  color: var(--warning);
  font-weight: 600;
}
.prompt-cap-notice {
  margin: 6px 0 0;
  padding: 6px 8px;
  border: 1px solid color-mix(in srgb, var(--warning) 50%, transparent);
  border-left-width: 3px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--warning) 12%, transparent);
  color: var(--warning);
  font-size: var(--font-xs);
  line-height: 1.5;
}
.scene-setting-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.scene-setting-head > span {
  color: var(--text-muted);
  font-size: var(--font-xs);
}
.scene-setting-head em {
  color: var(--text-muted);
  font-size: var(--font-xs);
  font-style: normal;
  letter-spacing: .08em;
  text-transform: uppercase;
}
.scene-inline-toggle,
.scene-switch-label,
.scene-inline-field {
  display: flex;
  align-items: center;
  gap: 8px;
}
.scene-switch-label {
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 600;
}
.scene-inline-field .input { width: 90px; }
.scene-pack-custom {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}
.scene-pack-custom .input { width: 88px; }
.scene-compact-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.scene-batch-summary {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 11px;
  border: 1px solid color-mix(in srgb, var(--accent) 28%, var(--border));
  border-radius: 8px;
  color: var(--text-secondary);
  background: color-mix(in srgb, var(--accent) 7%, var(--bg-tertiary));
  font-size: 12px;
}
.scene-batch-summary strong { color: var(--text-primary); font-size: 14px; }
.model-budget {
  display: grid;
  gap: 4px;
  margin: 10px 0 0;
  padding: 9px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-tertiary);
}
.model-budget > div {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}
.model-budget dt { color: var(--text-muted); font-size: var(--font-xs); }
.model-budget dd { margin: 0; color: var(--text-primary); font-size: var(--font-xs); font-weight: 600; }
.model-budget-note {
  margin: 6px 0 0;
  color: var(--text-muted);
  font-size: var(--font-xs);
  line-height: 1.45;
}
.scene-advanced-batches { color: var(--text-secondary); }
.scene-advanced-batches summary { color: var(--accent); font-size: 12px; font-weight: 600; cursor: pointer; }
.scene-advanced-batches[open] summary { margin-bottom: 8px; }
.scene-setting-help {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--font-xs);
  line-height: 1.45;
}

/* An opening clip the plan could NOT count. Muted grey would read as ordinary
   help text; this is a thing the customer has to fix before the render. */
.scene-setting-warn {
  margin: 0;
  color: var(--warning);
  font-size: var(--font-xs);
  line-height: 1.45;
}
.scene-motion-controls {
  transition: opacity .15s ease;
}
.scene-motion-controls.is-disabled { opacity: .52; }
.default-style-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 6px;
}
.character-style-source {
  padding: 9px 10px;
  border: 1px solid color-mix(in srgb, var(--accent) 28%, var(--border));
  border-radius: 8px;
  background: color-mix(in srgb, var(--accent) 6%, var(--bg-secondary));
}
.character-style-label {
  display: block;
  margin-bottom: 4px;
  color: var(--accent);
  font-size: var(--font-xs);
  font-weight: 700;
  letter-spacing: .07em;
  text-transform: uppercase;
}
/* v1.2.6 — the selected style's name, so the prose below it is attributable. */
.character-style-identity {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
  margin-bottom: 4px;
}
.character-style-identity > strong {
  font-size: var(--font-sm);
  line-height: 1.3;
}
.character-style-tag {
  flex: 0 0 auto;
  padding: 1px 7px;
  border: 1px solid color-mix(in srgb, var(--accent) 34%, var(--border));
  border-radius: 999px;
  color: var(--accent);
  font-size: var(--font-xs);
  font-weight: 700;
  letter-spacing: .05em;
  text-transform: uppercase;
}
.character-style-source p.character-style-note {
  display: block;
  margin-bottom: 5px;
  color: var(--text-muted);
  -webkit-line-clamp: none;
}
.character-style-source p {
  display: -webkit-box;
  margin: 0;
  overflow: hidden;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.5;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}
@media (max-width: 900px) {
  .scene-workflow-grid { grid-template-columns: 1fr; }
  .scene-setting-model { grid-column: auto; }
}
@media (max-width: 620px) {
  .scene-compact-fields { grid-template-columns: 1fr; }
  .scene-setting-head { align-items: flex-start; }
}
.coverage-warning {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.coverage-warning .btn { flex: 0 0 auto; }
@media (max-width: 720px) {
  .coverage-warning { align-items: stretch; flex-direction: column; }
}
.stage-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}
.stage-step {
  display: flex;
  flex-direction: column;
  min-height: 150px;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: linear-gradient(145deg, rgba(240, 198, 116, 0.08), var(--bg-secondary));
}
.stage-step > span { margin-top: 6px; color: var(--text-secondary); font-size: 13px; }
.stage-step .stage-built { color: var(--text-muted); font-size: 12px; }
.stage-step .stage-setting {
  padding: 6px 8px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--accent) 8%, transparent);
  color: var(--text-secondary);
}
.stage-setting a { float: right; color: var(--accent); text-decoration: none; }
.stage-setting a:hover { text-decoration: underline; }
.stage-step small { margin-top: auto; padding-top: 12px; color: var(--text-muted); line-height: 1.45; }
.stage-step em {
  color: var(--text-muted);
  font-size: var(--font-xs);
  font-style: normal;
  text-transform: uppercase;
  letter-spacing: .08em;
}
@media (max-width: 900px) { .stage-grid { grid-template-columns: 1fr; } }
.link { color: var(--accent, #6c8fff); text-decoration: underline; cursor: pointer; }
.mb-1 { margin-bottom: 4px; }
/* Bulk prompt action group. */
.bulk-buttons {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

/* Plan-health head wraps actions on narrow windows. */
.plan-health-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

/* Bulk prompt-regeneration progress strip. */
.bulk-progress {
  margin: 10px 0 6px;
  display: flex; flex-direction: column; gap: 6px;
}
.bulk-progress-bar {
  height: 6px;
  background: rgba(255, 255, 255, 0.06);
  border-radius: 3px;
  overflow: hidden;
}
.bulk-progress-fill {
  height: 100%;
  background: var(--accent, #6c8fff);
  transition: width 0.3s ease;
}
.bulk-progress-text {
  display: flex; justify-content: space-between; gap: 12px;
  font-size: 12px; color: var(--text-secondary, #ccc);
}
.link-btn-danger {
  background: none; border: none; color: #d4564a; cursor: pointer;
  padding: 0; font-size: inherit;
}
.link-btn-danger:hover { text-decoration: underline; }

/* Back-to-top floats above the dashboard chrome and stays clear of row actions. */
.back-to-top {
  position: fixed;
  bottom: 24px;
  right: 24px;
  width: 42px;
  height: 42px;
  border-radius: 50%;
  border: 1px solid var(--border, #444);
  background: var(--bg-secondary, #1c1c1f);
  color: var(--text-primary, #eee);
  font-size: 18px;
  font-weight: 600;
  cursor: pointer;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.35);
  z-index: 100;
  transition: transform 0.15s ease, background 0.15s ease;
}
.back-to-top:hover {
  background: var(--accent, #6c8fff);
  color: #0f1117;
  transform: translateY(-2px);
}

/* v1.0.242 — visual-detail slider. */
.detail-pill {
  display: inline-block;
  margin-left: 8px;
  padding: 1px 10px;
  font-size: var(--font-xs); font-weight: 600;
  color: var(--accent);
  background: rgba(240, 198, 116, 0.12);
  border: 1px solid rgba(240, 198, 116, 0.25);
  border-radius: 999px;
}
.intensity-picker { min-width: 0; }
.intensity-picker > span, .intensity-picker legend {
  display: block;
  margin: 0 0 7px;
  padding: 0;
  color: var(--text-secondary);
  font-size: 13px;
}
.intensity-picker strong { margin-left: 5px; color: var(--accent); }
.formula-motion-profile {
  padding: 9px 10px;
  border: 1px solid color-mix(in srgb, var(--accent) 42%, var(--border));
  border-radius: 8px;
  background: color-mix(in srgb, var(--accent) 9%, var(--bg-tertiary));
}
.formula-motion-profile > strong { display: block; color: var(--text-primary); font-size: 13px; }
.formula-motion-profile p { margin: 4px 0 0; color: var(--text-secondary); font-size: 12px; line-height: 1.4; }
.formula-motion-kicker { display: block; margin-bottom: 4px; color: var(--accent); font-size: var(--font-xs); font-weight: 700; letter-spacing: .07em; text-transform: uppercase; }
.formula-motion-mix { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 8px; color: var(--text-muted); font-size: var(--font-xs); }
.intensity-options { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; }
.intensity-option {
  min-width: 0;
  min-height: 34px;
  padding: 6px 7px;
  overflow: hidden;
  color: var(--text-muted);
  text-overflow: ellipsis;
  white-space: nowrap;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: 7px;
  font-size: 12px;
  cursor: pointer;
}
.intensity-option:hover:not(:disabled) { color: var(--text-primary); border-color: color-mix(in srgb, var(--accent) 60%, var(--border)); }
.intensity-option.active { color: var(--text-primary); border-color: var(--accent); background: color-mix(in srgb, var(--accent) 14%, var(--bg-tertiary)); }
.intensity-option:disabled { cursor: default; }

/* Creative direction changes visual interpretation, never the Style Bible. */
.scene-creative-card { border-color: color-mix(in srgb, var(--accent) 28%, var(--border)); }
.creative-profile-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin-top: 10px;
}
.creative-profile {
  min-width: 0;
  padding: 9px 10px;
  text-align: left;
  color: var(--text-secondary);
  background: var(--bg-tertiary, rgba(255, 255, 255, 0.035));
  border: 1px solid var(--border);
  border-radius: 8px;
  cursor: pointer;
  transition: border-color .16s ease, background .16s ease, transform .16s ease;
}
.creative-profile:hover { border-color: color-mix(in srgb, var(--accent) 62%, var(--border)); transform: translateY(-1px); }
.creative-profile.active {
  color: var(--text-primary);
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 13%, var(--bg-tertiary));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 22%, transparent);
}
.creative-profile strong, .creative-profile span { display: block; }
.creative-profile strong { font-size: 12px; }
.creative-profile span { margin-top: 3px; font-size: var(--font-xs); line-height: 1.35; color: var(--text-muted); }
.scene-creative-controls {
  display: grid;
  /* DS-12/F-15a — this grid demanded 680px (three 220px minimums) while the creative
     card is only ~509px wide inside the two-column workspace at a 1440 window, so the
     third control was laid out past its card and past the viewport and clipped by
     main.main-content's hidden overflow. Two columns of the card's own width keep every
     control inside it. The intensity picker spans the row on purpose: its four labels
     need ~360px, which no third of this card provides at any realistic window width. */
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  align-items: end;
  margin-top: 10px;
}
/* A grid item's automatic minimum size would otherwise stop its track from shrinking. */
.scene-creative-controls > * { min-width: 0; }
.scene-creative-controls > :first-child { grid-column: 1 / -1; }
.scene-creative-controls .form-group { margin: 0; }
.creative-strategy-picker { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 12px 0; }
.creative-strategy-picker > span { flex-basis: 100%; margin-bottom: 2px; }
.creative-strategy-chip {
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  font-size: var(--font-xs);
  cursor: pointer;
}
.creative-strategy-chip.active { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, var(--bg-tertiary)); color: var(--text-primary); }
.scene-strategy-badge {
  padding: 2px 7px;
  border: 1px solid color-mix(in srgb, var(--accent) 42%, var(--border));
  border-radius: 999px;
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 8%, transparent);
  font-size: var(--font-xs);
  font-weight: 600;
  line-height: 1.2;
}
@media (max-width: 1100px) {
  .creative-profile-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 680px) {
  .creative-profile-grid, .scene-creative-controls { grid-template-columns: 1fr; }
  .scene-creative-controls > :first-child { grid-column: auto; }
  .intensity-options { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

.validation-msg {
  color: #c97a4a;
  background: rgba(201, 122, 74, 0.08);
  border: 1px solid rgba(201, 122, 74, 0.25);
  border-radius: 4px;
  padding: 6px 10px;
}
.scene-list { list-style: none; padding: 0; margin: 6px 0 0; display: flex; flex-direction: column; gap: 8px; }
.scene-list-more {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 14px;
  color: var(--text-muted);
  font-size: 12px;
}
.scene-row {
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-secondary);
  content-visibility: auto;
  contain-intrinsic-size: auto 360px;
}
.scene-row-problem { border-left: 3px solid #e0a23a; }
.scene-row-flash { animation: scene-flash 1.4s ease; }
@keyframes scene-flash {
  0%, 100% { box-shadow: 0 0 0 0 rgba(240, 180, 41, 0); }
  20% { box-shadow: 0 0 0 3px rgba(240, 180, 41, 0.55); }
}
/* v1.0.245 — Plan-health banner. */
.plan-health {
  padding: 10px 12px;
  border: 1px solid rgba(224, 162, 58, 0.4);
  border-left: 3px solid #e0a23a;
  background: rgba(224, 162, 58, 0.08);
  border-radius: 8px;
}
.plan-health-head { font-size: 13px; font-weight: 600; color: var(--text-primary); }
.plan-health-list { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.plan-health-chip {
  font-size: var(--font-xs);
  padding: 3px 9px;
  border-radius: 999px;
  border: 1px solid rgba(224, 162, 58, 0.45);
  background: rgba(224, 162, 58, 0.1);
  color: var(--text-primary);
  cursor: pointer;
}
.plan-health-chip:hover { border-color: #e0a23a; background: rgba(224, 162, 58, 0.2); }
.plan-health-why { color: var(--text-muted); }
.scene-row-head { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.scene-boundary-reason { font-style: italic; }
/* v1.0.336 — per-scene type picker (continuity). Colour-tinted so the cast
   mix is scannable down the list at a glance. */
.scene-type-pick { display: inline-flex; align-items: center; gap: 4px; margin-left: auto; }
.scene-type-select {
  font-size: var(--font-xs); padding: 1px 4px; border-radius: 4px; cursor: pointer;
  border: 1px solid var(--border); background: var(--bg-subtle); color: var(--text-primary);
}
.scene-type-lock { font-size: var(--font-xs); }
.scene-type-pick.st-character .scene-type-select { border-color: #6aa9ff; background: rgba(106, 169, 255, 0.14); }
.scene-type-pick.st-event     .scene-type-select { border-color: #e0795a; background: rgba(224, 121, 90, 0.14); }
.scene-type-pick.st-environment .scene-type-select { border-color: #5ab47a; background: rgba(90, 180, 122, 0.14); }
.scene-type-pick.st-map       .scene-type-select { border-color: #c79a4e; background: rgba(199, 154, 78, 0.14); }
.scene-type-pick.st-artifact  .scene-type-select { border-color: #a98cd0; background: rgba(169, 140, 208, 0.14); }
.scene-textarea {
  font-size: 12px;
  font-family: ui-sans-serif, system-ui, sans-serif;
  width: 100%;
}
.scene-row-actions { display: flex; gap: 6px; }
.scene-row-actions .btn-icon {
  font-size: var(--font-xs);
  padding: 3px 8px;
  border-radius: 3px;
  background: transparent;
  border: 1px solid var(--border);
  color: var(--text-muted);
  cursor: pointer;
}
.scene-row-actions .btn-icon:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--text-primary);
}
.scene-row-actions .btn-icon.danger:hover:not(:disabled) {
  border-color: #e25c5c;
  color: #e25c5c;
}
.scene-row-actions .btn-icon:disabled { opacity: 0.4; cursor: default; }
</style>
