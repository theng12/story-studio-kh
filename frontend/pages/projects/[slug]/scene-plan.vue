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
        :loading-label="headerPrimaryLoadingLabel"
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

    <!-- Step 1: Subtitles (created + stitched in the Subtitles workspace) -->
    <WorkspaceSection
      eyebrow="Prerequisite"
      title="1. Subtitles"
      description="Scene timing consumes the verified global subtitle timeline created in the Subtitles workspace."
    >
      <div v-if="!status?.audio_merged" class="validation-msg text-sm mt-2">
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
        <div v-if="!status.stitched_srt" class="validation-msg text-sm mt-2">
          ⚠ Stitch the subtitles first —
          <NuxtLink :to="`/projects/${slug}/subtitles`" class="inline-link">open Subtitles → "Stitch into the timeline"</NuxtLink>.
        </div>
        <div v-else-if="missingSubtitleSections.length" class="validation-msg validation-msg-strong text-sm mt-2">
          ⚠ <strong>Do not rebuild or re-plan yet.</strong>
          Audio exists but subtitles are missing for
          <strong>{{ missingSubtitleSections.join(', ') }}</strong>.
          <NuxtLink :to="`/projects/${slug}/subtitles`" class="inline-link">Open Subtitles and transcribe those chapters</NuxtLink>,
          then stitch again. The current long scene crosses narration the app could not see.
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
      </div>
    </WorkspaceSection>

    <!-- Step 2: Plan options -->
    <WorkspaceSection
      eyebrow="Configuration"
      title="2. Scene workflow settings"
      description="Choose the prompt model, opening behavior, pack size, motion pass, and episode guidance. Timeline construction itself uses no LLM."
    >
      <div class="scene-workflow-grid mt-2">
        <div class="scene-setting-card scene-setting-model">
          <ModelSelector v-model="form.model" :project-slug="slug" label="Visual & motion prompt model" @model-meta="selectedModelMeta = $event" />
          <label v-if="status?.research_available" class="scene-inline-toggle text-sm">
            <input type="checkbox" v-model="form.use_research" />
            Include <code>research.json</code> as optional context
          </label>
          <span v-else class="text-muted text-xs">Research context is unavailable; prompt generation continues without it.</span>
        </div>

        <div class="scene-setting-card">
          <div class="scene-setting-head">
            <strong>Opening visuals</strong>
            <span>{{ openingMode === 'branded-opening' ? `${openingReservedSec}s reserved` : 'From first second' }}</span>
          </div>
          <select v-model="openingMode" class="select" @change="saveOpeningSettings">
            <option value="branded-opening">Branded opening, then story scenes</option>
            <option value="from-start">Story scenes from the first second</option>
          </select>
          <div v-if="openingMode === 'branded-opening'" class="scene-inline-field">
            <label class="text-sm">Reserve</label>
            <input v-model.number="openingReservedSec" class="input" type="number" min="1" max="120" step="0.5" @change="saveOpeningSettings" />
            <span class="text-xs text-muted">seconds</span>
          </div>
          <p class="scene-setting-help">Remaining introduction narration receives story-focused scenes.</p>
        </div>

        <div class="scene-setting-card">
          <div class="scene-setting-head">
            <strong>Prompt packs</strong>
            <span>Full-detail output</span>
          </div>
          <div class="scene-compact-fields">
            <div class="form-group">
              <label>Output budget</label>
              <select v-model="form.prompt_max_tokens" class="select">
                <option value="auto">Auto · {{ automaticTokenBudget.toLocaleString() }}</option>
                <option :value="4096">4,096 tokens</option>
                <option :value="6144">6,144 tokens</option>
                <option :value="8192">8,192 tokens</option>
              </select>
            </div>
            <div class="form-group">
              <label>Scenes per pack</label>
              <select v-model="form.prompt_pack_size" class="select">
                <option value="auto">Auto · {{ automaticPromptPackSize }} scenes</option>
                <option :value="5">5 scenes</option>
                <option :value="10">10 scenes</option>
                <option :value="20" :disabled="selectedModelCostTier !== 'paid'">20 · paid cloud</option>
                <option :value="30" :disabled="selectedModelCostTier !== 'paid'">30 · paid cloud max</option>
              </select>
            </div>
          </div>
          <p class="scene-setting-help">
            {{ effectivePromptPackSize }} scenes · {{ effectivePromptTokenBudget.toLocaleString() }} tokens per {{ selectedModelTierLabel }} pack. Local and free-cloud models cap at 10 scenes.
            The output budget is separate from the model's larger input/context window; supported cloud providers use JSON mode without paid reasoning for these packs.
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
            <label class="form-group">
              <span>Creative intensity <strong>{{ creativeIntensityLabel }}</strong></span>
              <input v-model.number="form.creative_intensity" type="range" min="1" max="4" step="1" class="detail-slider" list="creative-intensity-stops" />
              <datalist id="creative-intensity-stops">
                <option value="1" label="Faithful"></option>
                <option value="2" label="Balanced"></option>
                <option value="3" label="Expressive"></option>
                <option value="4" label="Experimental"></option>
              </datalist>
              <span class="detail-ticks"><span>Faithful</span><span>Balanced</span><span>Expressive</span><span>Experimental</span></span>
            </label>
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
            <strong>Motion prompts <em>optional</em></strong>
            <label class="scene-switch-label">
              <input v-model="form.generate_motion_prompts" type="checkbox" @change="setMotionEnabled(form.generate_motion_prompts)" />
              {{ form.generate_motion_prompts ? 'On' : 'Off' }}
            </label>
          </div>
          <div class="scene-motion-controls" :class="{ 'is-disabled': !form.generate_motion_prompts }">
            <label>
              Motion intensity
              <span class="detail-pill">{{ motionMeta?.label }}</span>
            </label>
            <input
              v-model.number="form.motion_level"
              type="range"
              min="1"
              max="4"
              step="1"
              class="detail-slider"
              list="motion-stops"
              :disabled="!form.generate_motion_prompts"
              @change="setMotionLevel(form.motion_level)"
            />
            <datalist id="motion-stops">
              <option value="1" label="Still"></option>
              <option value="2" label="Gentle"></option>
              <option value="3" label="Moderate"></option>
              <option value="4" label="Lively"></option>
            </datalist>
            <div class="detail-ticks">
              <span :class="{ on: form.motion_level === 1 }">Still</span>
              <span :class="{ on: form.motion_level === 2 }">Gentle</span>
              <span :class="{ on: form.motion_level === 3 }">Moderate</span>
              <span :class="{ on: form.motion_level === 4 }">Lively</span>
            </div>
            <p class="scene-setting-help">{{ form.generate_motion_prompts ? motionMeta?.hint : 'Enable motion prompts to use this intensity.' }}</p>
          </div>
        </div>

        <div class="scene-setting-card">
          <div class="scene-setting-head">
            <strong>Style and guidance</strong>
            <NuxtLink :to="`/projects/${slug}/character-sheet`" class="link">Edit Character Sheet</NuxtLink>
          </div>
          <div class="character-style-source">
            <span class="character-style-label">Style from Character Sheet</span>
            <p v-if="characterSheetStyleBible">{{ characterSheetStyleBible }}</p>
            <p v-else class="text-muted">No Style Bible is set for this episode yet.</p>
          </div>
          <div class="form-group">
            <label>Custom instructions <span class="text-muted text-xs">— optional</span></label>
            <textarea
              v-model="form.custom_instructions"
              class="textarea"
              rows="2"
              placeholder="e.g. keep the protagonist off-centre and the same red scarf throughout"
            />
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
          <span v-if="continuityPacing" class="stage-setting">
            Pacing: {{ continuityPacing.min_sec }}–{{ continuityPacing.max_sec }} seconds
            <NuxtLink :to="`/projects/${slug}/character-sheet`">Change</NuxtLink>
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
            <button class="btn btn-primary" :disabled="!subtitleTimelineComplete || !form.model || !plan || !visualPendingCount || planning || planJobActive" @click="runPromptStage('visual', effectivePromptPackSize)">Next {{ effectivePromptPackSize }}</button>
            <button class="btn btn-secondary" :disabled="!subtitleTimelineComplete || !form.model || !plan || !visualPendingCount || planning || planJobActive" @click="runPromptStage('visual')">All pending</button>
          </div>
          <small>{{ effectivePromptPackSize }} scenes per {{ selectedModelTierLabel }} pack. Studio Hub distributes as many packs in parallel as the available compatible servers can handle.</small>
        </div>
        <div class="stage-step" :class="{ optional: true }">
          <strong>3. Motion prompts <em>optional</em></strong>
          <span>{{ motionDoneCount }}/{{ visualDoneCount }} ready</span>
          <div v-if="form.generate_motion_prompts" class="flex gap-1 mt-2 flex-wrap">
            <button class="btn btn-primary" :disabled="!subtitleTimelineComplete || !form.model || !motionPendingCount || planning || planJobActive" @click="runPromptStage('motion', effectivePromptPackSize)">Next {{ effectivePromptPackSize }}</button>
            <button class="btn btn-secondary" :disabled="!subtitleTimelineComplete || !form.model || !motionPendingCount || planning || planJobActive" @click="runPromptStage('motion')">All pending</button>
          </div>
          <small v-else>Skipped for this project. Still images remain valid through assembly.</small>
        </div>
      </div>
      <p v-if="plan?.visual_prompt_batch_id || plan?.motion_prompt_batch_id" class="text-muted text-xs mt-2">
        Last Hub task: <code>{{ plan.motion_prompt_batch_id || plan.visual_prompt_batch_id }}</code>
      </p>
    </WorkspaceSection>

    <!-- Step 3: Plan + edit -->
    <section v-if="status?.scene_plan || planning" class="card workspace-section">
      <!-- v1.0.250 — the plan predates the current stitched SRT (you changed
           audio / re-stitched after this plan was generated). Re-run so it
           matches the new timeline. -->
      <div v-if="status?.plan_stale_vs_stitched && !planning" class="validation-msg text-sm mb-2">
        ⚠ This plan is <strong>older than the current stitched subtitles</strong> — it was built from a previous audio/timeline.
        Use <strong>Repair long scenes</strong> for isolated gaps; rebuild the timeline only when the whole episode timing changed.
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
          <button
            v-if="overlongSceneCount"
            class="btn btn-sm btn-secondary"
            :disabled="repairingLongScenes || !!dirty || !subtitleTimelineComplete"
            :title="!subtitleTimelineComplete
              ? 'Transcribe and stitch every missing subtitle chapter first'
              : dirty ? 'Save your edits first' : 'Split only abnormal long scenes against the current subtitle cues. No LLM; unaffected prompts and images are preserved.'"
            @click="repairLongScenes"
          >
            {{ repairingLongScenes ? 'Repairing…' : `✂ Repair ${overlongSceneCount} long scene${overlongSceneCount === 1 ? '' : 's'}` }}
          </button>
          <button
            class="btn btn-sm btn-secondary"
            :disabled="repairingCoverage || !!dirty"
            :title="dirty ? 'Save your edits first' : 'Close gaps between scenes and extend the last scene to the real audio end, so every second of narration has a scene'"
            @click="repairCoverage"
          >
            {{ repairingCoverage ? 'Repairing…' : '🩹 Repair coverage' }}
          </button>
          <button
            class="btn btn-sm btn-secondary"
            :disabled="reconciling || !!dirty"
            :title="dirty ? 'Save your edits first' : 'Re-anchor every scene’s timing to the CURRENT subtitles (use after re-generating audio / re-stitching). Keeps all scene images; fixes a plan that drifted out of sync.'"
            @click="reconcileTimings"
          >
            {{ reconciling ? 'Reconciling…' : '🎯 Reconcile timings' }}
          </button>
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
            @click="repairCoverage"
          >
            {{ repairingCoverage ? 'Repairing…' : '🩹 Repair coverage now' }}
          </button>
        </div>
        <!-- v1.0.260 — Visual Recipe bar: rewrite every scene into the explainer
             composition (guide-at-side + framed subject), or revert. -->
        <div v-if="recipeEnabled" class="recipe-bar mt-2">
          <div class="recipe-bar-main">
            <strong>🎬 Visual Recipe</strong>
            <span class="text-muted text-xs">
              {{ recipeComposedCount }}/{{ plan.scenes.length }} scene{{ plan.scenes.length === 1 ? '' : 's' }} composed into the explainer layout
            </span>
          </div>
          <div class="recipe-bar-actions">
            <button
              class="btn btn-sm btn-primary"
              :disabled="applyingRecipe || !form.model || planning || revertingRecipe"
              :title="!form.model ? 'Pick a model above first' : 'Rewrite every scene into the guide-at-side + framed-subject composition'"
              @click="applyRecipe"
            >
              {{ applyingRecipe ? 'Composing…' : (recipeComposedCount ? '↻ Re-apply recipe' : '🎬 Apply Visual Recipe') }}
            </button>
            <button
              v-if="recipeComposedCount"
              class="btn btn-sm btn-ghost"
              :disabled="revertingRecipe || applyingRecipe"
              @click="revertRecipe"
            >
              {{ revertingRecipe ? 'Reverting…' : 'Revert to planner prompts' }}
            </button>
          </div>
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
                :disabled="!subtitleTimelineComplete || !form.model || planning || bulkReplan.active"
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
              Regenerating {{ bulkReplan.total }} prompt{{ bulkReplan.total === 1 ? '' : 's' }} in parallel across your model pool ·
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
              <label class="text-xs text-muted">
                {{ scene.visual_prompt_raw ? 'Composed prompt (explainer layout — sent to the image generator)' : 'Visual prompt (sent to the image generator)' }}
              </label>
              <textarea
                v-model="scene.visual_prompt"
                class="textarea scene-textarea"
                rows="2"
                @input="markPlanDirty"
              />
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
                :disabled="!form.model || regenMotionId === scene.id || planning || !scene.visual_prompt?.trim()"
                :title="!form.model
                  ? 'Pick a model above first'
                  : !scene.visual_prompt?.trim()
                    ? 'Write the visual prompt first — the motion prompt animates that image'
                    : 'Regenerate this scene\'s motion prompt with the LLM (visual prompt + timing untouched)'"
                @click="regenMotionPrompt(scene)"
              >{{ regenMotionId === scene.id ? '⏳ Motion…' : '🎬 Regen motion' }}</button>
            </div>
            <!-- v1.0.260 — when the recipe composed this scene, show the planner's
                 original as the source + an overridable guide emotion. -->
            <div v-if="scene.visual_prompt_raw" class="scene-raw mt-1">
              <span class="text-xs text-muted">Planner original:</span>
              <span class="scene-raw-text">{{ scene.visual_prompt_raw }}</span>
            </div>
            <div v-if="recipeEnabled && recipeMode === 'guide'" class="scene-emotion mt-1">
              <label class="text-xs text-muted">Guide emotion</label>
              <input
                v-model="scene.emotion"
                class="input input-sm input-inline"
                placeholder="auto"
                @input="markEmotionEdited(scene)"
              />
              <button
                class="btn-icon"
                :title="scene.emotion_locked ? 'Locked — kept on re-apply. Click to unlock (auto re-derive).' : 'Auto — re-derived on apply. Click to lock this value.'"
                @click="toggleEmotionLock(scene)"
              >{{ scene.emotion_locked ? '🔒 locked' : '🔓 auto' }}</button>
            </div>
            <div class="scene-row-actions mt-1">
              <NuxtLink
                v-if="sceneOverlapsMissingSubtitles(scene)"
                :to="`/projects/${slug}/subtitles`"
                class="btn-icon"
                title="This scene crosses audio with no subtitles. Transcribe the named chapters and stitch again before repairing it."
              >Fix subtitles first</NuxtLink>
              <button
                class="btn-icon"
                :disabled="!subtitleTimelineComplete || !form.model || regenPromptId === scene.id || planning || bulkReplan.active || !scene.transcript_segment?.trim()"
                :title="!subtitleTimelineComplete
                  ? 'Complete the subtitle timeline first'
                  : !form.model
                  ? 'Pick a model above first'
                  : !scene.transcript_segment?.trim()
                    ? 'Scene has no transcript_segment — fill that in first'
                    : 'Regenerate only the visual prompt; the deterministic time range and transcript stay unchanged.'"
                @click="regenerateScenePrompt(scene)"
              >{{ regenPromptId === scene.id ? '⏳ Regenerating…' : '✨ Prompt only' }}</button>
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

    <section v-else class="card mt-3">
      <p class="text-muted text-sm">
        <span v-if="!status?.stitched_srt">Stitch subtitles first (step 1).</span>
        <span v-else>No plan yet. Pick a model + click <strong>Plan scenes</strong> in the action bar to start.</span>
      </p>
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

definePageMeta({ layout: 'dashboard' })
useAppTitle('Scene Plan')

const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { get, post, put, del } = useApi()
const { success, error: showError } = useToast()
const { ask } = useConfirm()
const { revalidate: revalidateEpisodes } = useEpisodes(slug)
// Project-level defaults for opening behavior, prompt batching, and motion.
const { config: projectConfig } = useProject()

const openingMode = ref<'branded-opening' | 'from-start'>(
  (projectConfig.value as any)?.visual_opening_mode === 'branded-opening'
    || ((projectConfig.value as any)?.visual_opening_mode == null && (projectConfig.value as any)?.skip_intro_scenes === true)
    ? 'branded-opening' : 'from-start',
)
const openingReservedSec = ref<number>(Number((projectConfig.value as any)?.branded_opening_duration_sec) || 15)
// Once a preset supplies opening controls, keep those values authoritative.
// The project-config watcher is only the fallback for legacy presets.
const openingPresetControlsActive = ref(false)
watch(projectConfig, (c) => {
  if (openingPresetControlsActive.value) return
  openingMode.value = (c as any)?.visual_opening_mode === 'branded-opening'
    || ((c as any)?.visual_opening_mode == null && (c as any)?.skip_intro_scenes === true)
    ? 'branded-opening' : 'from-start'
  openingReservedSec.value = Number((c as any)?.branded_opening_duration_sec) || 15
})
async function saveOpeningSettings() {
  openingPresetControlsActive.value = false
  const duration = Math.max(1, Math.min(120, Number(openingReservedSec.value) || 15))
  openingReservedSec.value = duration
  try {
    await put(`/projects/${slug.value}/settings/config`, {
      visual_opening_mode: openingMode.value,
      branded_opening_duration_sec: duration,
      skip_intro_scenes: false,
    })
    if (projectConfig.value) {
      ;(projectConfig.value as any).visual_opening_mode = openingMode.value
      ;(projectConfig.value as any).branded_opening_duration_sec = duration
      ;(projectConfig.value as any).skip_intro_scenes = false
    }
    success(openingMode.value === 'branded-opening'
      ? `Branded opening reserved for ${duration}s; story scenes continue through the remaining Introduction narration.`
      : 'Story scenes will begin at the first second.')
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Could not save the setting')
  }
}

// Image-to-video prompt settings are optional and persisted per project.
const motionEnabled = ref<boolean>(((projectConfig.value as any)?.motion_prompts_enabled) === true)
const motionLevel = ref<number>(Number((projectConfig.value as any)?.default_motion_level) || 2)
watch(projectConfig, (c) => {
  motionEnabled.value = ((c as any)?.motion_prompts_enabled) === true
  motionLevel.value = Number((c as any)?.default_motion_level) || 2
  form.value.generate_motion_prompts = motionEnabled.value
  form.value.motion_level = motionLevel.value
})
async function setMotionEnabled(v: boolean) {
  motionEnabled.value = v
  try {
    await put(`/projects/${slug.value}/settings/config`, { motion_prompts_enabled: v })
    if (projectConfig.value) (projectConfig.value as any).motion_prompts_enabled = v
    success(v ? 'Motion prompts will be generated for new scene plans.' : 'Motion prompts are off for this project.')
  } catch (e: any) {
    motionEnabled.value = !v
    showError(e?.data?.detail || e?.message || 'Could not save the setting')
  }
}
async function setMotionLevel(v: number) {
  const lvl = Math.max(1, Math.min(4, Math.round(v) || 2))
  const prev = motionLevel.value
  motionLevel.value = lvl
  try {
    await put(`/projects/${slug.value}/settings/config`, { default_motion_level: lvl })
    if (projectConfig.value) (projectConfig.value as any).default_motion_level = lvl
    success(`Motion level set to ${lvl}.`)
  } catch (e: any) {
    motionLevel.value = prev
    showError(e?.data?.detail || e?.message || 'Could not save the setting')
  }
}

const episodeId = ref('')

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
  // v1.0.260 — Visual Recipe fields.
  visual_prompt_raw?: string
  emotion?: string
  emotion_locked?: boolean
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
  { id: 'editorial', label: 'Editorial', usage: 'Psychology, culture, commentary, Capi' },
  { id: 'spiritual', label: 'Spiritual', usage: 'Faith, prayer, hope, reflection, Abiding Faith' },
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
const subtitleTimelineComplete = computed(() =>
  !!status.value?.stitched_srt && missingSubtitleSections.value.length === 0,
)
const coverageNeedsRepair = computed(() =>
  status.value?.coverage_integrity?.authoritative === true
  && status.value.coverage_integrity.complete === false,
)
const coverageGapLabel = computed(() =>
  `${(status.value?.coverage_integrity?.blockingUncoveredSec || 0).toFixed(1)}s`,
)
const coverageInternalGapCount = computed(() =>
  status.value?.coverage_integrity?.coverage?.internalGaps?.length || 0,
)
const missingSubtitleRanges = computed(() =>
  (status.value?.stitched_srt?.meta?.sections || [])
    .filter(section => missingSubtitleSections.value.includes(section.slug))
    .map(section => ({
      start: section.offset_sec,
      end: section.offset_sec + section.duration_sec,
    })),
)
function sceneOverlapsMissingSubtitles(scene: ScenePlanEntry): boolean {
  return missingSubtitleRanges.value.some(range =>
    scene.end_sec > range.start + 0.01 && scene.start_sec < range.end - 0.01,
  )
}
// v1.0.272 — per-episode in-flight flags. A plan/recipe run holds its flag
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
const continuityPacing = ref<{ min_sec: number; max_sec: number } | null>(null)
// v1.0.260 — whether the explainer Visual Recipe is enabled for this episode
// (set on the Character Sheet). Gates the Apply/Revert controls below.
const recipeEnabled = ref(false)
// v1.0.263 — recipe composition mode. 'guide' shows per-scene emotion controls;
// 'scene' (no recurring character) hides them since there's no character to emote.
const recipeMode = ref<'guide' | 'scene'>('guide')
// For continuity-chain the canonical look is the Character Sheet's continuity
// Style Bible. Scene Plan displays it read-only so there is no competing style
// editor or chance for the two steps to drift.
const characterSheetStyleBible = ref('')

async function loadContinuity(): Promise<void> {
  const ep = episodeId.value
  const requestSequence = ++continuityLoadSequence
  continuityPacing.value = null
  recipeEnabled.value = false
  recipeMode.value = 'guide'
  characterSheetStyleBible.value = ''
  if (!ep) return
  try {
    const fmt = await get<{ visualSource?: string }>(`/projects/${slug.value}/effective-format`)
    if (requestSequence !== continuityLoadSequence || episodeId.value !== ep) return
    if (fmt?.visualSource !== 'continuity-chain') return
    const r = await get<{ exists: boolean; config: { pacing?: { min_sec: number; max_sec: number }; recipe?: { enabled?: boolean; mode?: 'guide' | 'scene' }; style_bible?: string } }>(
      `/projects/${slug.value}/continuity/${ep}`,
    )
    if (requestSequence !== continuityLoadSequence || episodeId.value !== ep) return
    continuityPacing.value = r.config?.pacing || { min_sec: 2, max_sec: 8 }
    recipeEnabled.value = r.config?.recipe?.enabled === true
    recipeMode.value = r.config?.recipe?.mode === 'scene' ? 'scene' : 'guide'
    characterSheetStyleBible.value = (r.config?.style_bible || '').trim()
  } catch { /* non-continuity project or fetch failed — no chip */ }
}

// ── v1.0.260 — Visual Recipe (Prompt Director) apply / revert ───────────
const applyingEpisode = ref<string | null>(null)
const revertingEpisode = ref<string | null>(null)
const applyingRecipe = computed(() => applyingEpisode.value === episodeId.value)
const revertingRecipe = computed(() => revertingEpisode.value === episodeId.value)
const recipeComposedCount = computed(() =>
  (plan.value?.scenes || []).filter(s => s.visual_prompt_raw && s.visual_prompt_raw.length).length,
)

async function applyRecipe(): Promise<void> {
  if (!form.value.model) { showError('Pick a model above first'); return }
  if (dirty.value) {
    const ok = await ask({
      title: 'Apply Visual Recipe?',
      message: 'This rewrites every scene\'s prompt into the explainer composition (guide-at-side + framed subject). Your unsaved plan edits will be discarded first. The planner\'s original prompts are preserved, so you can revert.',
      confirmLabel: 'Apply recipe',
    })
    if (!ok) return
  }
  const ep = episodeId.value
  applyingEpisode.value = ep
  // Signature of the current composed prompts — the poll waits for THIS to
  // change, which works for both first-apply and re-apply (where the raw-count
  // is already non-zero and wouldn't move).
  const beforeSig = promptsSignature()
  try {
    await post(`/projects/${slug.value}/continuity/${ep}/apply-recipe`, { model: form.value.model })
    success('Composing scene prompts — watch the Jobs panel; the list updates when it lands.')
    await pollUntilRecomposed(beforeSig, ep)
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to apply Visual Recipe')
  } finally {
    if (applyingEpisode.value === ep) applyingEpisode.value = null
  }
}

async function revertRecipe(): Promise<void> {
  const ok = await ask({
    title: 'Revert to planner prompts?',
    message: 'Restores each scene\'s original planner prompt and clears the recipe\'s emotion data. The composition template + recipe settings are kept — you can re-apply anytime.',
    confirmLabel: 'Revert',
  })
  if (!ok) return
  const ep = episodeId.value
  revertingEpisode.value = ep
  try {
    await post(`/projects/${slug.value}/continuity/${ep}/revert-recipe`, {})
    if (episodeId.value === ep) await loadStatus()
    success('Reverted to planner prompts')
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to revert')
  } finally {
    if (revertingEpisode.value === ep) revertingEpisode.value = null
  }
}

/** Serialized composed prompts — used to detect when the Director's rewrite
 *  has landed (changes on both first-apply and re-apply). */
function promptsSignature(): string {
  return (plan.value?.scenes || []).map(s => s.visual_prompt || '').join('')
}

/** Poll the plan until the Director's recompose lands (the composed prompts
 *  change vs the pre-apply signature) or we time out. */
async function pollUntilRecomposed(beforeSig: string, ep: string): Promise<void> {
  const start = Date.now()
  const timeoutMs = 180_000
  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 3000))
    if (episodeId.value !== ep) return  // switched away — stop; don't touch the new episode
    await loadStatus()
    if (promptsSignature() !== beforeSig) return
  }
  if (episodeId.value === ep) showError('Recipe taking longer than expected — check the Jobs panel, then refresh.')
}

/** A hand-edit to a scene's emotion locks it so the next apply keeps it. */
function markEmotionEdited(scene: ScenePlanEntry): void {
  scene.emotion_locked = true
  markPlanDirty()
}
function toggleEmotionLock(scene: ScenePlanEntry): void {
  scene.emotion_locked = !scene.emotion_locked
  markPlanDirty()
}

/** Set a scene's type and lock it so deterministic repairs keep the choice. The
 *  `dirty` computed picks up the mutation; the user saves with the Save button. */
function setSceneType(scene: ScenePlanEntry, value: string): void {
  scene.scene_type = value as SceneType
  scene.scene_type_locked = true
  markPlanDirty()
}

type PromptCostTier = 'local' | 'free' | 'paid'
type PromptPackSetting = 'auto' | 5 | 10 | 20 | 30
type PromptTokenSetting = 'auto' | 4096 | 6144 | 8192
interface SelectedModelMeta { id: string; cost_tier?: PromptCostTier }

const selectedModelMeta = ref<SelectedModelMeta | null>(null)

const form = ref({
  model: '',  // ModelSelector auto-picks first usable
  use_research: true,
  prompt_pack_size: 'auto' as PromptPackSetting,
  prompt_max_tokens: 'auto' as PromptTokenSetting,
  // v1.0.468 — image-to-video motion prompt: whether to generate one per scene,
  // and how lively the motion is (1=Still … 4=Lively). 2 = Gentle (sleep-tuned).
  generate_motion_prompts: ((projectConfig.value as any)?.motion_prompts_enabled) === true,
  motion_level: 2,
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
})
// v1.0.259 — remember plan settings per-Mac across reloads (an active plan
// preset still auto-applies on top).
useRememberedForm('scene-plan', slug, form)
if (!['auto', 5, 10, 20, 30].includes(form.value.prompt_pack_size)) {
  form.value.prompt_pack_size = 'auto'
}
if (!['auto', 4096, 6144, 8192].includes(form.value.prompt_max_tokens)) {
  form.value.prompt_max_tokens = 'auto'
}
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

const selectedModelCostTier = computed<PromptCostTier>(() => {
  if (selectedModelMeta.value?.id === form.value.model && selectedModelMeta.value.cost_tier) {
    return selectedModelMeta.value.cost_tier
  }
  if (form.value.model.startsWith('chatstudio:provider:')) return 'free'
  if (form.value.model.startsWith('chatstudio:')) return 'local'
  return 'paid'
})
const selectedModelTierLabel = computed(() => selectedModelCostTier.value === 'local'
  ? 'local' : selectedModelCostTier.value === 'free' ? 'free-cloud' : 'paid-cloud')
const automaticPromptPackSize = computed<10 | 20>(() => selectedModelCostTier.value === 'paid' ? 20 : 10)
const effectivePromptPackSize = computed<5 | 10 | 20 | 30>(() => {
  const requested = form.value.prompt_pack_size === 'auto'
    ? automaticPromptPackSize.value : Number(form.value.prompt_pack_size)
  return Math.min(requested, selectedModelCostTier.value === 'paid' ? 30 : 10) as 5 | 10 | 20 | 30
})
const automaticTokenBudget = computed<4096 | 8192>(() => selectedModelCostTier.value === 'paid' ? 8192 : 4096)
const effectivePromptTokenBudget = computed<4096 | 6144 | 8192>(() => {
  const requested = form.value.prompt_max_tokens === 'auto'
    ? automaticTokenBudget.value : Number(form.value.prompt_max_tokens)
  return (effectivePromptPackSize.value > 10 ? 8192 : requested) as 4096 | 6144 | 8192
})

// v1.0.468 — labels for the motion-intensity slider stops. Every level stays
// slow/smooth; the scale only controls how much movement is allowed.
const MOTION_LEVELS = [
  { value: 1, label: 'Still', hint: 'Almost a living photo — faint ambient drift only, no subject motion.' },
  { value: 2, label: 'Gentle', hint: 'Slow pan / push-in + soft ambient motion. Calm and hypnotic — the sleep-story default.' },
  { value: 3, label: 'Moderate', hint: 'Subtle script-driven subject motion (walking, turning, pointing) + gentle camera.' },
  { value: 4, label: 'Lively', hint: 'Clear but smooth movement and more active ambient elements — never fast or abrupt.' },
]
const motionMeta = computed(() => MOTION_LEVELS.find(m => m.value === form.value.motion_level) ?? MOTION_LEVELS[1])

const canPlan = computed(() => {
  if (!episodeId.value) return false
  return subtitleTimelineComplete.value
})
const planDisabledReason = computed(() => {
  if (!episodeId.value) return 'Pick an episode first'
  if (!status.value?.stitched_srt) return 'Stitch subtitles first (step 1)'
  if (!subtitleTimelineComplete.value) return `Transcribe missing subtitles: ${missingSubtitleSections.value.join(', ')}`
  return ''
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
  let overlong = 0
  const problems: Array<{ scene: ScenePlanEntry; index: number; reasons: string[] }> = []
  const problemIds = new Set<string>()
  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i]!
    const visualReady = !!scene.visual_prompt?.trim() && !duplicates.has(scene.id)
    if (visualReady) visualDone++
    if (visualReady && scene.motion_prompt?.trim()) motionDone++
    if (visualReady && !scene.motion_prompt?.trim()) motionPending++
    const duration = scene.end_sec - scene.start_sec
    if (duration > OVERLONG_SEC) overlong++
    const reasons: string[] = []
    if (!scene.visual_prompt?.trim()) reasons.push('no prompt')
    else if (duplicates.has(scene.id)) reasons.push('duplicate prompt')
    if (sceneOverlapsMissingSubtitles(scene)) reasons.push('missing subtitle narration')
    else if (duration > OVERLONG_SEC) reasons.push(`${duration.toFixed(0)}s long`)
    if (reasons.length) {
      problems.push({ scene, index: i + 1, reasons })
      problemIds.add(scene.id)
    }
  }
  return { duplicates, visualDone, motionDone, motionPending, overlong, problems, problemIds }
})
const duplicateVisualPromptIds = computed(() => sceneDiagnostics.value.duplicates)
const visualDoneCount = computed(() => sceneDiagnostics.value.visualDone)
const visualPendingCount = computed(() => Math.max(0, (plan.value?.scenes.length || 0) - visualDoneCount.value))
const motionDoneCount = computed(() => sceneDiagnostics.value.motionDone)
const motionPendingCount = computed(() => sceneDiagnostics.value.motionPending)
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
  if (headerPrimaryStage.value === 'ready') return true
  if (headerPrimaryStage.value === 'timeline') return !canPlan.value
  return !subtitleTimelineComplete.value || !form.value.model || !plan.value
})
const headerPrimaryStatus = computed(() => {
  if (planning.value || planJobActive.value) return `Scene Plan is working on ${episodeId.value}…`
  if (headerPrimaryStage.value === 'timeline') return canPlan.value ? '' : planDisabledReason.value
  if (!subtitleTimelineComplete.value) return `Transcribe missing subtitles: ${missingSubtitleSections.value.join(', ')}`
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
  const requestSequence = ++statusLoadSequence
  if (!ep) {
    status.value = null
    plan.value = null
    dirty.value = false
    return
  }
  try {
    const r = await get<ScenePlanStatus>(`/projects/${slug.value}/scene-plan/${ep}`)
    if (requestSequence !== statusLoadSequence || episodeId.value !== ep) return
    status.value = r
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
    if (requestSequence !== statusLoadSequence || episodeId.value !== ep) return
    if (e?.__slugRace) return
    // Non-fatal — empty-state renders.
  }
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
    await post(`/projects/${slug.value}/scene-plan/${ep}/run`, {
      stage: 'timeline',
      opening_mode: openingMode.value,
      opening_reserved_sec: openingMode.value === 'branded-opening' ? openingReservedSec.value : 0,
    })
    success('Timeline build queued — no LLM call is needed')
    await pollUntilPlanLanded(ep)
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to start planner')
  } finally {
    if (planningEpisode.value === ep) planningEpisode.value = null
  }
}

async function runPromptStage(stage: 'visual' | 'motion', promptLimit?: number): Promise<void> {
  if (!subtitleTimelineComplete.value) {
    showError(`Complete the missing subtitle chapters first: ${missingSubtitleSections.value.join(', ')}`)
    return
  }
  if (!form.value.model || !plan.value) return
  const ep = episodeId.value
  planningEpisode.value = ep
  const previousGeneratedAt = plan.value.generated_at || null
  try {
    const job = await post<{ job_id?: string }>(`/projects/${slug.value}/scene-plan/${ep}/run`, {
      model: form.value.model,
      model_cost_tier: selectedModelCostTier.value,
      stage,
      prompt_limit: promptLimit,
      prompt_pack_size: form.value.prompt_pack_size,
      use_research: form.value.use_research,
      prompt_max_tokens: stage === 'visual' ? form.value.prompt_max_tokens : undefined,
      detail_level: 4,
      motion_level: form.value.motion_level,
      creative_direction: creativeDirectionPayload.value,
      custom_instructions: form.value.custom_instructions.trim() || undefined,
    })
    success(`${stage === 'visual' ? 'Visual' : 'Motion'} prompt packs queued in Studio Hub${job?.job_id ? ` · Story task ${job.job_id}` : ''}`)
    await pollUntilPlanLanded(ep, { previousGeneratedAt, timeoutMs: 3_600_000, trackJobId: job?.job_id || null })
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || `Failed to start ${stage} prompt stage`)
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
const OVERLONG_SEC = 20
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
async function regenerateScenePrompt(scene: ScenePlanEntry): Promise<void> {
  if (!subtitleTimelineComplete.value) { showError('Complete and stitch every subtitle chapter first.'); return }
  if (!form.value.model) { showError('Pick a model above first'); return }
  if (!scene.transcript_segment?.trim()) { showError('Scene has no transcript_segment to base a prompt on.'); return }
  const ep = episodeId.value
  regenPromptId.value = scene.id
  const previousGeneratedAt = plan.value?.generated_at || null
  try {
    await post(`/projects/${slug.value}/scene-plan/${ep}/regenerate-prompt`, {
      scene_id: scene.id,
      model: form.value.model,
      detail_level: 4,
      creative_direction: creativeDirectionPayload.value,
      custom_instructions: form.value.custom_instructions.trim() || undefined,
    })
    success('Regen queued — watch the Jobs panel; the prompt updates when it lands.')
    await pollUntilPlanLanded(ep, { previousGeneratedAt })
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to start prompt regen')
  } finally {
    regenPromptId.value = null
  }
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
  if (!form.value.model) { showError('Pick a model above first'); return }
  if (!scene.visual_prompt?.trim()) { showError('Write the visual prompt first — the motion prompt animates that image.'); return }
  const ep = episodeId.value
  regenMotionId.value = scene.id
  const previousGeneratedAt = plan.value?.generated_at || null
  try {
    await post(`/projects/${slug.value}/scene-plan/${ep}/regenerate-motion-prompt`, {
      scene_id: scene.id,
      model: form.value.model,
      motion_level: form.value.motion_level,
    })
    success('Motion regen queued — the prompt updates when the job lands.')
    await pollUntilPlanLanded(ep, { previousGeneratedAt })
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to start motion regen')
  } finally {
    regenMotionId.value = null
  }
}

/**
 * v1.0.458 — bulk regenerate prompts for every empty-prompt scene in ONE
 * backend job that fans the work out across the whole LM Studio pool (one
 * scene per endpoint, in parallel) and retries transient disconnects.
 *
 * This replaces the old v1.0.288 loop that fired one regenerate-prompt job
 * per scene and awaited each before queuing the next — which forced 47 empty
 * scenes through a single endpoint, serially, wasting the rest of the pool
 * and the user's time. Now a 3-endpoint setup regenerates ~3 scenes at once.
 */
async function regenAllEmptyPrompts(): Promise<void> {
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
      `Rewrites every missing or duplicated visual prompt in a single job that fans out across your Chat Studio pool `
      + `(one scene per endpoint, in parallel) and retries transient disconnects. Time boundaries + transcript_segment stay exactly as-is. `
      + `Much faster than the old one-at-a-time loop when you have more than one endpoint configured.`
      + `${dirty.value ? ' Unsaved edits to the plan will be discarded first.' : ''}`,
    confirmLabel: `Repair all ${empty.length}`,
  })
  if (!ok) return

  bulkReplan.value = {
    active: true, parallel: true, completed: 0, total: empty.length,
    currentSceneIndex: null, cancelRequested: false, jobId: null,
  }

  const previousGeneratedAt = plan.value?.generated_at || null
  try {
    const job = await post<{ job_id?: string }>(`/projects/${slug.value}/scene-plan/${ep}/regenerate-empty-prompts`, {
      model: form.value.model,
      detail_level: 4,
      creative_direction: creativeDirectionPayload.value,
      custom_instructions: form.value.custom_instructions.trim() || undefined,
    })
    bulkReplan.value.jobId = job?.job_id || null
    success('Bulk prompt regen queued — fanning out across your model pool. Watch the Jobs panel for detail.')
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
      showError(`Bulk regen finished with 0 prompts filled. Your model couldn't produce prompts — try a stronger model (qwen3-coder, claude-sonnet, gpt-4o) or check your Chat Studio endpoints are reachable.`)
    } else {
      success(`Regenerated ${filled} visual prompt${filled === 1 ? '' : 's'} across your pool.`)
    }
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to start bulk regen')
  } finally {
    bulkReplan.value = { active: false, parallel: false, completed: 0, total: 0, currentSceneIndex: null, cancelRequested: false, jobId: null }
  }
}

// Bulk prompt regeneration state. Timeline boundaries never change here.
const bulkReplan = ref<{
  active: boolean
  completed: number
  total: number
  currentSceneIndex: number | null
  cancelRequested: boolean
  /** True while the backend fans prompt packs across the model pool. */
  parallel?: boolean
  /** v1.0.458 — backend job id for the parallel run, so Cancel can stop it. */
  jobId?: string | null
}>({ active: false, completed: 0, total: 0, currentSceneIndex: null, cancelRequested: false })

function cancelBulkReplan(): void {
  if (!bulkReplan.value.active) return
  bulkReplan.value.cancelRequested = true
  // v1.0.458 — the parallel bulk regen is a single backend job; cancelling the
  // frontend poll alone would leave it churning. Tell the server to stop it
  // The generator polls isCancelled() between chunks.
  const jobId = bulkReplan.value.jobId
  if (bulkReplan.value.parallel && jobId) {
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
    title: `Repair ${overlongSceneCount.value} long scene${overlongSceneCount.value === 1 ? '' : 's'}?`,
    message: 'Uses the restored subtitle cues to split only abnormal long ranges. No LLM is used. Every unaffected scene, prompt, image, and approval stays in place; newly uncovered scenes will need visual prompts and images.',
    confirmLabel: 'Repair long scenes',
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

// v1.0.522 — heal the plan to full audio coverage (close inter-scene gaps,
// extend the last scene to the ffprobed audio end). Both assemblers refuse
// to render when >2s of narration has no scene; this is the one-click fix.
const repairingCoverage = ref(false)
async function repairCoverage(): Promise<void> {
  if (!episodeId.value || repairingCoverage.value) return
  repairingCoverage.value = true
  try {
    const r = await post<{
      ok: boolean
      audio_duration_sec: number
      changes: string[]
      coverage_after: { uncoveredTotalSec: number }
    }>(`/projects/${slug.value}/scene-plan/${episodeId.value}/repair-coverage`, {})
    if (r.changes?.length) {
      success(`Coverage repaired — plan now covers ${r.audio_duration_sec.toFixed(1)}s of audio. ${r.changes.join(' ')}`)
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

// v1.0.242 — savable presets for the plan settings (model, research toggle,
// opening visuals, output budget, motion, and custom instructions). Mirrors the
// same local PresetPicker pattern used on Ideas / Scripts. Stored under
// config.scene_plan_presets; episode_id/title are stripped automatically.
const planPresets = usePresets<any>({
  slug: slug.value,
  configKey: 'scene_plan',
  presetType: 'scene-plan',
  snapshot: () => ({
    model: form.value.model,
    use_research: form.value.use_research,
    opening_mode: openingMode.value,
    opening_reserved_sec: openingReservedSec.value,
    model_cost_tier: selectedModelCostTier.value,
    prompt_pack_size: form.value.prompt_pack_size,
    prompt_max_tokens: form.value.prompt_max_tokens,
    creative_direction: creativeDirectionPayload.value,
    detail_level: 4,
    custom_instructions: form.value.custom_instructions,
    generate_motion_prompts: form.value.generate_motion_prompts,
    motion_level: form.value.motion_level,
  }),
  apply: (data) => {
    // Retired presets may contain a per-plan style. Ignore it so Character
    // Sheet remains the single authoritative style source.
    const activeData = { ...(data || {}) }
    delete activeData.style_prompt
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
    if (data.opening_mode === 'branded-opening' || data.opening_mode === 'from-start') {
      openingMode.value = data.opening_mode
      openingReservedSec.value = Math.max(1, Math.min(120, Number(data.opening_reserved_sec) || 15))
      openingPresetControlsActive.value = true
    }
    if (!['auto', 5, 10, 20, 30].includes(form.value.prompt_pack_size)) {
      form.value.prompt_pack_size = 'auto'
    }
    if (!['auto', 4096, 6144, 8192].includes(form.value.prompt_max_tokens)) {
      form.value.prompt_max_tokens = 'auto'
    }
  },
})

watch([slug, episodeId], () => {
  void Promise.all([loadStatus(), loadContinuity()])
}, { immediate: true })
onMounted(() => { void planPresets.load() })
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
.scene-setting-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.scene-setting-head > span {
  color: var(--text-muted);
  font-size: 11px;
}
.scene-setting-head em {
  color: var(--text-muted);
  font-size: 10px;
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
.scene-compact-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.scene-setting-help {
  margin: 0;
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.45;
}
.scene-motion-controls {
  transition: opacity .15s ease;
}
.scene-motion-controls.is-disabled { opacity: .52; }
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
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .07em;
  text-transform: uppercase;
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
  font-size: 10px;
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

/* v1.0.260 — Visual Recipe bar + per-scene recipe affordances. */
.recipe-bar {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  flex-wrap: wrap;
  padding: 10px 12px; border-radius: 8px;
  background: rgba(240, 198, 116, 0.08);
  border: 1px solid rgba(240, 198, 116, 0.25);
}
.recipe-bar-main { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.recipe-bar-actions { display: flex; align-items: center; gap: 8px; }
.scene-raw {
  display: flex; gap: 6px; align-items: baseline; flex-wrap: wrap;
  padding: 4px 8px; border-left: 2px solid var(--border);
  background: var(--bg-tertiary); border-radius: 4px;
}
.scene-raw-text { font-size: 12px; color: var(--text-secondary, #888); font-style: italic; }
.scene-emotion { display: flex; align-items: center; gap: 8px; }
.scene-emotion .input-inline { width: 160px; }

/* v1.0.242 — visual-detail slider. */
.detail-pill {
  display: inline-block;
  margin-left: 8px;
  padding: 1px 10px;
  font-size: 11px; font-weight: 600;
  color: var(--accent);
  background: rgba(240, 198, 116, 0.12);
  border: 1px solid rgba(240, 198, 116, 0.25);
  border-radius: 999px;
}
.detail-slider { width: 100%; margin: 6px 0 2px; accent-color: var(--accent, #f0b429); cursor: pointer; }
.detail-ticks {
  display: flex; justify-content: space-between;
  font-size: 10.5px; color: var(--text-muted);
  text-transform: uppercase; letter-spacing: 0.03em;
}
.detail-ticks span { flex: 1; text-align: center; transition: color 0.15s ease; }
.detail-ticks span:first-child { text-align: left; }
.detail-ticks span:last-child { text-align: right; }
.detail-ticks span.on { color: var(--accent); font-weight: 600; }

/* Creative direction changes visual interpretation, never the Style Bible. */
.scene-creative-card { border-color: color-mix(in srgb, var(--accent) 28%, var(--border)); }
.creative-profile-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
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
.creative-profile span { margin-top: 3px; font-size: 10.5px; line-height: 1.35; color: var(--text-muted); }
.scene-creative-controls {
  display: grid;
  grid-template-columns: minmax(220px, .8fr) minmax(220px, 1fr) minmax(220px, 1fr);
  gap: 10px;
  align-items: end;
  margin-top: 10px;
}
.scene-creative-controls .form-group { margin: 0; }
.creative-strategy-picker { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 12px 0; }
.creative-strategy-picker > span { flex-basis: 100%; margin-bottom: 2px; }
.creative-strategy-chip {
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  font-size: 11px;
  cursor: pointer;
}
.creative-strategy-chip.active { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, var(--bg-tertiary)); color: var(--text-primary); }
.scene-strategy-badge {
  padding: 2px 7px;
  border: 1px solid color-mix(in srgb, var(--accent) 42%, var(--border));
  border-radius: 999px;
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 8%, transparent);
  font-size: 10px;
  font-weight: 600;
  line-height: 1.2;
}
@media (max-width: 1100px) {
  .creative-profile-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .scene-creative-controls { grid-template-columns: 1fr 1fr; }
  .scene-creative-controls > :first-child { grid-column: 1 / -1; }
}
@media (max-width: 680px) {
  .creative-profile-grid, .scene-creative-controls { grid-template-columns: 1fr; }
  .scene-creative-controls > :first-child { grid-column: auto; }
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
  font-size: 11.5px;
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
  font-size: 11px; padding: 1px 4px; border-radius: 4px; cursor: pointer;
  border: 1px solid var(--border); background: var(--bg-subtle); color: var(--text-primary);
}
.scene-type-lock { font-size: 10px; }
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
  font-size: 11px;
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
