<!--
  v1.0.143+ — Scene Plan page real content.
  Three-step flow:
    1. Stitch subtitles (uses the gap from audio_chapters.json).
    2. Plan scenes (LLM picks natural beats; runs as a job).
    3. Edit + save the plan.

  Surfaces drift detection: if the audio merge gap changed since the
  stitched SRT was built, prompt for re-stitch. If the stitched SRT
  changed since the plan was built, prompt for re-plan.

  v1.0.144's Scene Review page reads the saved scene_plan.json to
  render the per-scene approval grid.
-->
<template>
  <div>
    <div class="page-header">
      <Breadcrumb />
      <h1 class="page-title">Scene Plan</h1>
    </div>

    <TopActionBar
      :project-slug="slug"
      v-model:episode-id="episodeId"
      filter-field="scene_plan"
      :presets="planPresets"
      generate-label="Plan scenes"
      loading-label="Planning…"
      :generate-loading="planning || planJobActive"
      :generate-disabled="!canPlan"
      :generate-status="(planning || planJobActive) ? `Planning scenes for ${episodeId}…` : (canPlan ? '' : planDisabledReason)"
      @generate="planScenes"
    />

    <p class="text-muted mt-1 mb-2">
      Plan scenes against the stitched audio timeline. Step 1 stitches
      per-chapter SRTs into one global timeline (using the gap from
      v1.0.140's audio sidecar). Step 2 asks an LLM to pick natural
      narrative beats. Step 3 lets you edit before sending to Scene Review.
    </p>

    <!-- v1.0.193 — continuity-chain density pacing (shown only for that format). -->
    <div v-if="continuityPacing" class="cc-pacing-chip">
      <span aria-hidden="true">🎬</span>
      <span>
        <strong>Live pacing:</strong>
        scenes {{ continuityPacing.min_sec }}–{{ continuityPacing.max_sec }}s, cut denser on busy passages.
        The planner uses these guardrails instead of a fixed scene count.
      </span>
      <NuxtLink :to="`/projects/${slug}/character-sheet`" class="cc-pacing-link">Change →</NuxtLink>
    </div>

    <!-- Step 1: Subtitles (created + stitched in the Subtitles workspace) -->
    <section class="card mt-3">
      <h3>1. Subtitles</h3>
      <p class="text-muted text-sm mt-1">
        The planner reads one global-timeline SRT. Create per-chapter
        subtitles and stitch them into that timeline in the
        <NuxtLink :to="`/projects/${slug}/subtitles`" class="inline-link">Subtitles workspace</NuxtLink>
        — this page just consumes the result.
      </p>
      <div v-if="!status?.audio_merged" class="validation-msg text-sm mt-2">
        ⚠ Audio Assembly hasn't run for this episode yet. It's needed before
        subtitles + stitching (provides per-section durations + the gap).
      </div>
      <div v-else class="mt-2">
        <div class="text-sm text-muted">
          Audio merged with gap = <strong>{{ status.audio_merge_gap_s }}s</strong>.
          <span v-if="status.stitched_srt">
            Stitched SRT ready:
            <strong>{{ status.stitched_srt.meta?.total_cues ?? '?' }} cues</strong>
            across
            <strong>{{ status.stitched_srt.meta?.sections?.length ?? '?' }} section(s)</strong>,
            <strong>{{ status.stitched_srt.meta?.total_duration_sec?.toFixed(1) ?? '?' }}s</strong> total. ✓
          </span>
          <span v-else>No stitched SRT yet.</span>
        </div>
        <div v-if="!status.stitched_srt" class="validation-msg text-sm mt-2">
          ⚠ Stitch the subtitles first —
          <NuxtLink :to="`/projects/${slug}/subtitles`" class="inline-link">open Subtitles → "Stitch into the timeline"</NuxtLink>.
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
    </section>

    <!-- Step 2: Plan options -->
    <section class="card mt-3">
      <h3>2. Plan settings</h3>
      <p class="text-muted text-sm mt-1">
        The LLM reads the stitched SRT
        <span v-if="status?.research_available">+ your research.json</span>
        + the narration docx and picks scene boundaries based on
        natural narrative beats.
      </p>
      <div class="grid-2 mt-2">
        <ModelSelector v-model="form.model" :project-slug="slug" />
        <div class="form-group">
          <label>
            Target scene count
            <span class="text-muted text-xs">— guideline, not strict</span>
          </label>
          <input
            v-model.number="form.target_scene_count"
            class="input"
            type="number"
            min="3"
            max="200"
            placeholder="auto (~1 scene per 8s)"
          />
        </div>
      </div>
      <label class="flex items-center gap-1 mt-2 text-sm" v-if="status?.research_available">
        <input type="checkbox" v-model="form.use_research" />
        Include <code>research.json</code> as context
      </label>
      <p
        v-else
        class="text-muted text-xs mt-2"
      >
        No <code>research.json</code> sidecar found. The planner will run without research context.
      </p>

      <!-- v1.0.423 — sleep-story intro skip (per-project default). -->
      <label class="flex items-center gap-1 mt-2 text-sm" title="For sleep-story formats whose first audio chapter is the Introduction (welcome / context / CTA / breathing). Plans scenes only from the first story chapter.">
        <input type="checkbox" :checked="skipIntro" @change="setSkipIntro(($event.target as HTMLInputElement).checked)" />
        Skip the <strong>Introduction</strong> chapter when planning scenes
      </label>
      <p class="text-muted text-xs mt-1" v-if="skipIntro">
        Project-wide. Scenes are planned from the first story chapter onward. At render, the title (thumbnail) card is auto-held through the intro and intro captions are hidden by default — so story scenes line up with their narration.
      </p>

      <!-- v1.0.475 — image-to-video (motion) planning settings (per-project). -->
      <label class="flex items-center gap-1 mt-3 text-sm" title="When on, the planner writes a per-scene motion_prompt (image-to-video instruction) alongside each visual_prompt. Turn off if this channel never animates scenes.">
        <input type="checkbox" :checked="motionEnabled" @change="setMotionEnabled(($event.target as HTMLInputElement).checked)" />
        Generate <strong>motion prompts</strong> for image-to-video
      </label>
      <div v-if="motionEnabled" class="flex items-center gap-2 mt-1 text-sm" title="Baseline motion intensity for generated motion prompts. 1 = barely-there drift, 4 = livelier (still smooth). Sleep stories ~2.">
        <span class="text-muted">Motion level</span>
        <select :value="motionLevel" @change="setMotionLevel(Number(($event.target as HTMLSelectElement).value))" class="select select-sm" style="max-width: 220px;">
          <option :value="1">1 — Minimal drift</option>
          <option :value="2">2 — Gentle (sleep-story)</option>
          <option :value="3">3 — Moderate</option>
          <option :value="4">4 — Lively</option>
        </select>
      </div>

      <!-- v1.0.242 — visual-prompt detail slider. Controls how richly the LLM
           writes each scene's visual_prompt (length + which elements to cover). -->
      <div class="form-group mt-3">
        <label>
          Visual detail
          <span class="detail-pill">{{ detailMeta?.label }}</span>
        </label>
        <input
          v-model.number="form.detail_level"
          type="range"
          min="1"
          max="4"
          step="1"
          class="detail-slider"
          list="detail-stops"
        />
        <datalist id="detail-stops">
          <option value="1" label="Concise"></option>
          <option value="2" label="Standard"></option>
          <option value="3" label="Detailed"></option>
          <option value="4" label="Cinematic"></option>
        </datalist>
        <div class="detail-ticks">
          <span :class="{ on: form.detail_level === 1 }">Concise</span>
          <span :class="{ on: form.detail_level === 2 }">Standard</span>
          <span :class="{ on: form.detail_level === 3 }">Detailed</span>
          <span :class="{ on: form.detail_level === 4 }">Cinematic</span>
        </div>
        <p class="text-muted text-xs mt-1">{{ detailMeta?.hint }}</p>
      </div>

      <!-- v1.0.468 — motion-prompt controls. The planner also writes a per-scene
           motion_prompt (image-to-video instruction) cohesive with the visual
           prompt. Intensity biases how lively the motion is — always slow/smooth. -->
      <div class="form-group mt-3">
        <label class="flex items-center gap-1">
          <input v-model="form.generate_motion_prompts" type="checkbox" />
          Also write motion prompts (for animating scenes into clips)
        </label>
        <div v-if="form.generate_motion_prompts" class="mt-2">
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
          <p class="text-muted text-xs mt-1">{{ motionMeta?.hint }}</p>
        </div>
      </div>

      <!-- v1.0.509 — fast "prompt model" for the short LLM tasks (motion +
           thumbnail prompts). Off = each step uses its own model. -->
      <div class="form-group mt-3">
        <label class="flex items-center gap-2" style="cursor: pointer;">
          <input type="checkbox" v-model="usePromptModel" @change="onTogglePromptModel" />
          <span>Use a separate fast model for prompts <span class="text-muted text-xs">— motion + thumbnail prompts</span></span>
        </label>
        <div v-if="usePromptModel" class="mt-2" style="max-width: 380px;">
          <ModelSelector :model-value="promptModel" :project-slug="slug" @update:model-value="setPromptModel" />
        </div>
        <p class="text-muted text-xs mt-1">
          Motion + thumbnail prompts are short, simple outputs — a fast/cheap model (e.g. Haiku, a mini, or a fast local) here speeds up those phases a lot, while your planning model stays strong. Off = each step uses its own model.
        </p>
      </div>

      <!-- v1.0.291 — planning mode. Two-pass is only meaningful for local
           models (cloud LLMs handle structured JSON fine), so the
           two-pass radio is only enabled when a chatstudio:* model is
           selected. -->
      <div class="form-group mt-3">
        <label>
          Planning mode
          <span class="text-muted text-xs">— how the LLM produces the plan</span>
        </label>
        <div class="planning-mode-radios">
          <label class="planning-mode-radio" :class="{ active: form.planning_mode === 'single-pass' }">
            <input type="radio" v-model="form.planning_mode" value="single-pass" />
            <div>
              <strong>Single-pass</strong> <span class="text-muted text-xs">(default — recommended for cloud)</span>
              <p class="text-muted text-xs">One LLM call per ~10–30-scene window produces timing + transcript + visual prompts as structured JSON.</p>
            </div>
          </label>
          <label
            class="planning-mode-radio"
            :class="{ active: form.planning_mode === 'two-pass', disabled: !isLocalModel }"
            :title="isLocalModel ? '' : 'Only available for local Chat Studio models. Pick a local model above to enable.'"
          >
            <input type="radio" v-model="form.planning_mode" value="two-pass" :disabled="!isLocalModel" />
            <div>
              <strong>Two-pass</strong> <span class="text-muted text-xs">(recommended for local models)</span>
              <p class="text-muted text-xs">Pass 1: deterministic cue-walk produces scene timing instantly (no LLM). Pass 2: one prose LLM call per scene for the visual prompt. No structured JSON anywhere — works on small local models that fail single-pass.</p>
            </div>
          </label>
        </div>
      </div>

      <!-- v1.0.285 — per-window scene count control. Only meaningful in
           single-pass mode; hidden in two-pass since there are no JSON
           windows to size. -->
      <div v-if="form.planning_mode === 'single-pass'" class="form-group mt-3">
        <label>
          Scenes per LLM call
          <span class="text-muted text-xs">— chunked planning window size</span>
        </label>
        <select v-model="form.window_size" class="select" style="max-width: 380px;">
          <option value="auto">Auto — pick from model ({{ isLocalModel ? '10 (local)' : '30 (cloud)' }})</option>
          <option value="full">Full — 30 scenes per call (fewer calls, richer cohesion)</option>
          <option value="small">Small — 10 scenes per call (smaller JSON; safer for local LLMs)</option>
        </select>
        <p class="text-muted text-xs mt-1">
          Switch to <strong>Small</strong> if your local model returns empty visual prompts after planning —
          the planner fell back to cue-aligned splits because the JSON output failed to parse twice.
          Smaller windows = smaller per-call output = less likely to hit truncation.
        </p>

        <!-- v1.0.508 — "story so far" continuity toggle. ON = sequential with
             a rolling recap (better cross-seam continuity). OFF = parallel
             segments (much faster on long episodes). -->
        <label class="flex items-center gap-2 mt-3" style="cursor: pointer;">
          <input type="checkbox" v-model="form.cross_window_context" />
          <span>“Story so far” continuity across segments</span>
        </label>
        <p class="text-muted text-xs mt-1">
          <strong>On</strong> (default): each segment sees a recap of earlier ones, so recurring characters/setting carry across seams — but segments must plan <em>one after another</em>.
          <strong>Off</strong>: segments plan <strong>in parallel</strong> (much faster on long videos) at the cost of weaker cross-seam continuity. Great when each scene stands on its own; save it in a preset either way.
        </p>
      </div>

      <!-- v1.0.291 — neighbor-context dropdown for two-pass. Only shown when
           two-pass is selected. Maps to {back, forward} numeric fields in
           the POST body via NEIGHBOR_CONTEXT_PRESETS. -->
      <div v-else class="form-group mt-3">
        <label>
          Neighbor context
          <span class="text-muted text-xs">— how much surrounding context each prompt sees</span>
        </label>
        <select v-model="form.neighbor_context" class="select" style="max-width: 380px;">
          <option v-for="(meta, key) in NEIGHBOR_CONTEXT_PRESETS" :key="key" :value="key">{{ meta.label }}</option>
        </select>
        <p class="text-muted text-xs mt-1">{{ neighborContextMeta.hint }}</p>
      </div>

      <!-- v1.0.364 — unified channel Look. The same shipped-style gallery used
           on the Character Sheet; picking one sets the Style Bible applied to
           every scene (channel-wide for continuity, this plan otherwise). -->
      <div class="mt-2">
        <label class="block">Look <span class="text-muted text-xs">— the art style for every scene</span></label>
        <StylePicker class="mt-1" :slug="slug" :image-models="projectConfig?.image_models || {}" @apply="onStyleApply" />
      </div>

      <div class="grid-2 mt-2">
        <!-- Continuity: the Look IS the channel Style Bible — shown read-only;
             edit the wording on the Character Sheet. The planner uses it
             automatically, so there's no separate style field to drift. -->
        <div v-if="isContinuityChain" class="form-group">
          <label>
            Channel look <span class="text-muted text-xs">— the Style Bible used for every scene</span>
          </label>
          <div class="channel-look-box">
            <span v-if="channelStyleBible">{{ channelStyleBible }}</span>
            <span v-else class="text-muted">Not set — pick a style above, or set it on the Character Sheet.</span>
          </div>
          <span class="text-muted text-xs">
            Set once per channel. Edit the wording on the
            <NuxtLink :to="`/projects/${slug}/character-sheet`" class="link">Character Sheet</NuxtLink> — the planner uses it automatically.
          </span>
        </div>
        <!-- Non-continuity formats keep the per-plan style field. -->
        <div v-else class="form-group">
          <label>
            Style prompt
            <span class="text-muted text-xs">— applied to every scene</span>
          </label>
          <textarea
            v-model="form.style_prompt"
            class="textarea"
            rows="3"
            placeholder="e.g. cinematic photoreal, warm golden-hour light, shallow depth of field, muted earthy palette, subtle film grain"
          />
        </div>
        <div class="form-group">
          <label>
            Custom instructions
            <span class="text-muted text-xs">— optional, free text</span>
          </label>
          <textarea
            v-model="form.custom_instructions"
            class="textarea"
            rows="3"
            placeholder="e.g. always frame the protagonist slightly off-centre; never show modern technology; keep the same red scarf throughout"
          />
        </div>
      </div>

      <!-- v1.0.357 — the Plan preset moved to the page-level preset row at the
           top (TopActionBar), matching every other generator tab. -->
    </section>

    <!-- Step 3: Plan + edit -->
    <section v-if="status?.scene_plan || planning" class="card mt-3">
      <!-- v1.0.250 — the plan predates the current stitched SRT (you changed
           audio / re-stitched after this plan was generated). Re-run so it
           matches the new timeline. -->
      <div v-if="status?.plan_stale_vs_stitched && !planning" class="validation-msg text-sm mb-2">
        ⚠ This plan is <strong>older than the current stitched subtitles</strong> — it was built from a previous audio/timeline.
        Re-run <strong>Plan scenes</strong> (action bar) so it matches the latest stitch.
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

        <!-- v1.0.245 — Plan-health banner. Surfaces scenes that look broken
             (no prompt, over-long, or a planner fallback) so you don't have to
             scroll hundreds of scenes to find them. Click to jump.
             v1.0.286 — bulk re-plan button for the empty-prompt subset. -->
        <div v-if="problemScenes.length" class="plan-health mt-2">
          <div class="plan-health-head">
            <span>
              ⚠ {{ problemScenes.length }} scene{{ problemScenes.length === 1 ? '' : 's' }} need attention
              <span class="text-muted text-xs">— no prompt, over-long, or planner fallback</span>
            </span>
            <!-- Bulk re-plan: only offers to re-plan empty-prompt scenes (the
                 planner-failure class). Over-long / boundary-reason scenes
                 stay on the per-row Re-plan button because they're judgement
                 calls, not pure failures. -->
            <div class="bulk-buttons" v-if="emptyPromptCount > 0">
              <!-- v1.0.288 — prompt-only bulk lives next to Re-plan-all. It's
                   the better default for local models because each call is
                   prose (no JSON), so failure rates are much lower. The
                   heavier "🪄 Re-plan all" stays available for users who
                   want the planner to also re-segment the empties. -->
              <button
                class="btn btn-sm btn-primary"
                :disabled="!form.model || planning || bulkReplan.active"
                :title="!form.model
                  ? 'Pick a model above first'
                  : `Regenerate ONLY the visual prompts for ${emptyPromptCount} scene(s). Time ranges + transcripts unchanged. Much more reliable on local models than full Re-plan.`"
                @click="regenAllEmptyPrompts"
              >
                ✨ Regen {{ emptyPromptCount }} prompt{{ emptyPromptCount === 1 ? '' : 's' }} only
              </button>
              <button
                class="btn btn-sm btn-secondary"
                :disabled="!form.model || planning || bulkReplan.active"
                :title="!form.model
                  ? 'Pick a model above first'
                  : `Full re-plan: each scene gets re-segmented + re-prompted (can change time ranges).`"
                @click="replanAllEmpty"
              >
                🪄 Full re-plan {{ emptyPromptCount }}
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
              <template v-if="bulkReplan.parallel">
                Regenerating {{ bulkReplan.total }} prompt{{ bulkReplan.total === 1 ? '' : 's' }} in parallel across your model pool ·
                {{ bulkReplan.completed }}/{{ bulkReplan.total }} done
                <button class="link-btn-danger" @click="cancelBulkReplan">Cancel</button>
              </template>
              <template v-else>
                Re-planning scene #{{ bulkReplan.currentSceneIndex ?? '?' }} ·
                {{ bulkReplan.completed }}/{{ bulkReplan.total }} done
                <button class="link-btn-danger" @click="cancelBulkReplan">Cancel after this scene</button>
              </template>
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
            Tip: pick a model above, then click <strong>🪄 Re-plan</strong> on a scene to regenerate just that range (other scenes + their images are kept).
          </p>
        </div>

        <ul class="scene-list mt-2">
          <li
            v-for="(scene, i) in plan.scenes"
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
                <span v-if="scene.scene_type_locked" class="scene-type-lock" title="You set this — kept on re-plan.">🔒</span>
              </span>
            </div>
            <div class="form-group mt-1">
              <label class="text-xs text-muted">Transcript segment</label>
              <textarea
                v-model="scene.transcript_segment"
                class="textarea scene-textarea"
                rows="2"
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
              <!-- v1.0.245 — re-plan just this scene's time range via the LLM. -->
              <button
                class="btn-icon"
                :disabled="!form.model || replanningId === scene.id || planning || bulkReplan.active || regenPromptId === scene.id"
                :title="!form.model ? 'Pick a model above first' : 'Re-plan this time range with the LLM — replaces it with proper sub-scenes (other scenes + images untouched)'"
                @click="replanScene(scene)"
              >{{ replanningId === scene.id ? '⏳ Re-planning…' : '🪄 Re-plan' }}</button>
              <!-- v1.0.288 — prompt-only regeneration. Keeps the scene's time
                   boundaries and transcript exactly as-is; only rewrites
                   visual_prompt. Works on local models that fail full Re-plan. -->
              <button
                class="btn-icon"
                :disabled="!form.model || regenPromptId === scene.id || planning || bulkReplan.active || replanningId === scene.id || !scene.transcript_segment?.trim()"
                :title="!form.model
                  ? 'Pick a model above first'
                  : !scene.transcript_segment?.trim()
                    ? 'Scene has no transcript_segment — fill that in first'
                    : 'Regenerate ONLY the visual prompt — time range + transcript stay exactly the same. Works on local models that fail full Re-plan.'"
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
                :disabled="(scene.end_sec - scene.start_sec) < 6"
                title="Split this scene in half (min 6s)"
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
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'

definePageMeta({ layout: 'dashboard' })
useAppTitle('Scene Plan')

const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { get, post, put, del } = useApi()
const { success, error: showError } = useToast()
const { ask } = useConfirm()
// v1.0.364 — project config (image_models) for the StylePicker preview models.
const { config: projectConfig } = useProject()

// v1.0.423 — sleep-story intro skip (per-project default). Persisted to project
// config so it applies to every episode and is read by BOTH the planner (skips
// the Introduction chapter) and the renderer (holds the title card + hides intro
// captions). No per-call plumbing — the backend reads config.skip_intro_scenes.
const skipIntro = ref<boolean>(!!(projectConfig.value as any)?.skip_intro_scenes)
watch(projectConfig, (c) => { skipIntro.value = !!(c as any)?.skip_intro_scenes })
async function setSkipIntro(v: boolean) {
  skipIntro.value = v
  try {
    await put(`/projects/${slug.value}/settings/config`, { skip_intro_scenes: v })
    if (projectConfig.value) (projectConfig.value as any).skip_intro_scenes = v
    success(v
      ? 'Scenes will skip the Introduction chapter for this project.'
      : 'Scenes will be planned for the full transcript.')
  } catch (e: any) {
    skipIntro.value = !v
    showError(e?.data?.detail || e?.message || 'Could not save the setting')
  }
}

// v1.0.475 — image-to-video (motion) planning settings, persisted to project
// config. motion_prompts_enabled (default true) toggles whether the planner
// writes a per-scene motion_prompt; default_motion_level (1–4) sets the baseline
// intensity. Both are read by the scene planner.
const motionEnabled = ref<boolean>(((projectConfig.value as any)?.motion_prompts_enabled) !== false)
const motionLevel = ref<number>(Number((projectConfig.value as any)?.default_motion_level) || 2)
// v1.0.509 — fast "prompt model" for short prompt tasks (motion + thumbnail
// prompts). Empty = each step falls back to its own model. Persisted to config.
const promptModel = ref<string>(String((projectConfig.value as any)?.prompt_model || ''))
// Separate boolean so the ModelSelector can mount (and auto-pick) even while
// promptModel is still empty; unchecking clears the saved config value.
const usePromptModel = ref<boolean>(!!promptModel.value)
watch(projectConfig, (c) => {
  motionEnabled.value = ((c as any)?.motion_prompts_enabled) !== false
  motionLevel.value = Number((c as any)?.default_motion_level) || 2
  promptModel.value = String((c as any)?.prompt_model || '')
  usePromptModel.value = !!promptModel.value
})
function onTogglePromptModel() {
  if (!usePromptModel.value) void setPromptModel('') // off → fall back to each step's own model
  // on → the ModelSelector mounts below and auto-picks a first usable model,
  // which fires setPromptModel with the chosen id.
}
async function setPromptModel(v: string) {
  const prev = promptModel.value
  promptModel.value = v
  try {
    await put(`/projects/${slug.value}/settings/config`, { prompt_model: v })
    if (projectConfig.value) (projectConfig.value as any).prompt_model = v
    success(v ? `Prompt model set to ${v} — used for motion + thumbnail prompts.` : 'Prompt model cleared — each step uses its own model.')
  } catch (e: any) {
    promptModel.value = prev
    showError(e?.data?.detail || e?.message || 'Could not save the setting')
  }
}
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
      sections?: Array<{ slug: string; source_srt?: string; cues_added: number }>
    } | null
    drifts_from_current_merge: boolean
    stale_vs_subtitles?: boolean
  } | null
  scene_plan: ScenePlan | null
  plan_stale_vs_stitched?: boolean
  audio_merged: boolean
  audio_merge_gap_s: number | null
  research_available: boolean
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
}
type SceneType = 'character' | 'event' | 'environment' | 'map' | 'artifact'
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
  planner_model?: string
  source_stitched_srt?: string
  total_duration_sec: number
  research_used: boolean
  scenes: ScenePlanEntry[]
}

const status = ref<ScenePlanStatus | null>(null)
const plan = ref<ScenePlan | null>(null)
const serverPlan = ref<string>('')  // snapshot for dirty check
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
// v1.0.364 — unified Look. For continuity-chain the canonical look is the
// continuity Style Bible (shown read-only here; edited via the StylePicker or
// the Character Sheet). The planner falls back to it when no per-plan style is
// set, so it drives every scene without a competing field.
const isContinuityChain = ref(false)
const channelStyleBible = ref('')

async function loadContinuity(): Promise<void> {
  continuityPacing.value = null
  recipeEnabled.value = false
  recipeMode.value = 'guide'
  isContinuityChain.value = false
  channelStyleBible.value = ''
  if (!episodeId.value) return
  try {
    const fmt = await get<{ visualSource?: string }>(`/projects/${slug.value}/effective-format`)
    if (fmt?.visualSource !== 'continuity-chain') return
    isContinuityChain.value = true
    const r = await get<{ exists: boolean; config: { pacing?: { min_sec: number; max_sec: number }; recipe?: { enabled?: boolean; mode?: 'guide' | 'scene' }; style_bible?: string } }>(
      `/projects/${slug.value}/continuity/${episodeId.value}`,
    )
    continuityPacing.value = r.config?.pacing || { min_sec: 2, max_sec: 8 }
    recipeEnabled.value = r.config?.recipe?.enabled === true
    recipeMode.value = r.config?.recipe?.mode === 'scene' ? 'scene' : 'guide'
    channelStyleBible.value = (r.config?.style_bible || '').trim()
  } catch { /* non-continuity project or fetch failed — no chip */ }
}

// v1.0.364 — apply a picked style. Continuity-chain → write the channel Style
// Bible (re-fetch first so we never clobber other continuity fields, since the
// PUT replaces). Otherwise it's this plan's style override.
async function onStyleApply(data: { style_bible: string; negative_prompt: string }): Promise<void> {
  const ep = episodeId.value
  if (!ep) return
  if (isContinuityChain.value) {
    try {
      const r = await get<{ config: Record<string, any> }>(`/projects/${slug.value}/continuity/${ep}`)
      const merged = {
        ...(r.config || {}),
        schema_version: 1,
        style_bible: data.style_bible,
        negative_prompt: data.negative_prompt,
      }
      const saved = await put<{ config: { style_bible?: string } }>(`/projects/${slug.value}/continuity/${ep}`, merged)
      channelStyleBible.value = (saved.config?.style_bible || data.style_bible || '').trim()
      success('Style applied to this episode’s Style Bible')
    } catch (e: any) {
      showError(e?.data?.detail || e?.message || 'Failed to save the style')
    }
  } else {
    form.value.style_prompt = data.style_bible
    success('Style applied to this plan')
  }
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
}
function toggleEmotionLock(scene: ScenePlanEntry): void {
  scene.emotion_locked = !scene.emotion_locked
}

/** Set a scene's type and lock it so a re-plan keeps the user's choice. The
 *  `dirty` computed picks up the mutation; the user saves with the Save button. */
function setSceneType(scene: ScenePlanEntry, value: string): void {
  scene.scene_type = value as SceneType
  scene.scene_type_locked = true
}

const form = ref({
  model: '',  // ModelSelector auto-picks first usable
  target_scene_count: null as number | null,
  use_research: true,
  // v1.0.242 — visual-prompt richness (1=Concise … 4=Cinematic). 2 = the
  // historical default, so existing behaviour is unchanged until changed.
  detail_level: 2,
  // v1.0.468 — image-to-video motion prompt: whether to generate one per scene,
  // and how lively the motion is (1=Still … 4=Lively). 2 = Gentle (sleep-tuned).
  generate_motion_prompts: true,
  motion_level: 2,
  // Global style woven into every scene's visual_prompt, + free-text planner
  // instructions. Both optional.
  style_prompt: '',
  custom_instructions: '',
  // v1.0.285 — per-window scene count.
  //   'auto'  — local model → 10 scenes/call; cloud → 30/call (default)
  //   'full'  — always 30/call (fewer LLM calls, richer cross-scene cohesion)
  //   'small' — always 10/call (smaller JSON; better for flaky local models)
  // Surfaced as a dropdown so users with weak local LLMs can drop to 'small'
  // when they hit the empty-visual_prompts fallback, without sacrificing
  // the cloud's more efficient batched output.
  window_size: 'auto' as 'auto' | 'full' | 'small',
  // v1.0.508 — "story so far" cross-window continuity. true (default) plans
  // segments sequentially with a rolling recap; false plans them in parallel
  // (much faster on multi-segment episodes, weaker cross-seam continuity).
  cross_window_context: true,
  // v1.0.291 — planning architecture toggle.
  //   'single-pass' — historical windowed LLM (default; works great on cloud)
  //   'two-pass'    — deterministic split + per-scene prompts (best for
  //                   smaller local models that fail JSON output)
  // UI only surfaces 'two-pass' when an lmstudio:* model is selected — cloud
  // users have no reason to pay the per-scene request-overhead.
  planning_mode: 'single-pass' as 'single-pass' | 'two-pass',
  // v1.0.291 — neighbor-context window for two-pass prompt generation.
  // The dropdown maps preset combinations: Minimal=0/0, Standard=2/1, Rich=3/2.
  // Saved as a single label so it survives presets cleanly.
  neighbor_context: 'standard' as 'minimal' | 'standard' | 'rich',
})
// v1.0.259 — remember plan settings per-Mac across reloads (an active plan
// preset still auto-applies on top).
useRememberedForm('scene-plan', slug, form)

// v1.0.242 — labels for the detail slider stops.
const DETAIL_LEVELS = [
  { value: 1, label: 'Concise', hint: 'One short line per scene (~12–20 words).' },
  { value: 2, label: 'Standard', hint: '2–3 sentences (~30–60 words). The default.' },
  { value: 3, label: 'Detailed', hint: '3–4 rich sentences (~70–100 words): wardrobe, props, lens, lighting.' },
  { value: 4, label: 'Cinematic', hint: '4–5 vivid sentences (~110–150 words): full shot, lighting setup, palette, atmosphere.' },
]
const detailMeta = computed(() => DETAIL_LEVELS.find(d => d.value === form.value.detail_level) ?? DETAIL_LEVELS[1])

// v1.0.468 — labels for the motion-intensity slider stops. Every level stays
// slow/smooth; the scale only controls how much movement is allowed.
const MOTION_LEVELS = [
  { value: 1, label: 'Still', hint: 'Almost a living photo — faint ambient drift only, no subject motion.' },
  { value: 2, label: 'Gentle', hint: 'Slow pan / push-in + soft ambient motion. Calm and hypnotic — the sleep-story default.' },
  { value: 3, label: 'Moderate', hint: 'Subtle script-driven subject motion (walking, turning, pointing) + gentle camera.' },
  { value: 4, label: 'Lively', hint: 'Clear but smooth movement and more active ambient elements — never fast or abrupt.' },
]
const motionMeta = computed(() => MOTION_LEVELS.find(m => m.value === form.value.motion_level) ?? MOTION_LEVELS[1])

// v1.0.285 — flagged for the window-size "Auto" tooltip so the user sees which
// branch will fire (10 scenes for local, 30 for cloud) before they hit Plan.
const isLocalModel = computed(() => (form.value.model || '').startsWith('chatstudio:'))

// v1.0.291 — neighbor-context preset → {back, forward} mapping. Sent to the
// backend as numeric fields; surfaced as a 3-option dropdown so the user
// picks the "feel" rather than tuning two numbers independently.
const NEIGHBOR_CONTEXT_PRESETS: Record<'minimal' | 'standard' | 'rich', { back: number; forward: number; label: string; hint: string }> = {
  minimal: { back: 0, forward: 0, label: 'Minimal (independent scenes)', hint: 'Each scene gets prompted in isolation. Fastest + cheapest but visual style may drift across scenes.' },
  standard: { back: 2, forward: 1, label: 'Standard (2 back · 1 forward)', hint: 'Each prompt sees the previous 2 visual prompts + the next 1 transcript. Good balance.' },
  rich: { back: 3, forward: 2, label: 'Rich (3 back · 2 forward)', hint: 'Maximum continuity context. Slower + more tokens per call; best for visually-cohesive long episodes.' },
}
const neighborContextMeta = computed(() => NEIGHBOR_CONTEXT_PRESETS[form.value.neighbor_context])

// v1.0.291 — when switching away from a local model, force back to single-pass
// so cloud users don't accidentally trigger 100+ LLM calls for an episode.
watch(isLocalModel, (nowLocal) => {
  if (!nowLocal && form.value.planning_mode === 'two-pass') {
    form.value.planning_mode = 'single-pass'
  }
})

const canPlan = computed(() => {
  if (!episodeId.value) return false
  if (!status.value?.stitched_srt) return false
  if (!form.value.model) return false
  return true
})
const planDisabledReason = computed(() => {
  if (!episodeId.value) return 'Pick an episode first'
  if (!status.value?.stitched_srt) return 'Stitch subtitles first (step 1)'
  if (!form.value.model) return 'Pick a model'
  return ''
})
const dirty = computed(() => plan.value && JSON.stringify(plan.value) !== serverPlan.value)

async function loadStatus(): Promise<void> {
  if (!episodeId.value) {
    status.value = null
    plan.value = null
    serverPlan.value = ''
    return
  }
  try {
    const r = await get<ScenePlanStatus>(`/projects/${slug.value}/scene-plan/${episodeId.value}`)
    status.value = r
    if (r.scene_plan) {
      plan.value = r.scene_plan
      serverPlan.value = JSON.stringify(r.scene_plan)
    } else {
      plan.value = null
      serverPlan.value = ''
    }
  } catch (e: any) {
    if (e?.__slugRace) return
    // Non-fatal — empty-state renders.
  }
}

// v1.0.218 — stitching moved to the Subtitles workspace; this page only
// reads the stitched-SRT status now (see Step 1 → Subtitles link).

async function planScenes(): Promise<void> {
  if (!canPlan.value) return
  const ep = episodeId.value
  planningEpisode.value = ep
  try {
    const ncPreset = NEIGHBOR_CONTEXT_PRESETS[form.value.neighbor_context]
    await post(`/projects/${slug.value}/scene-plan/${ep}/run`, {
      model: form.value.model,
      target_scene_count: form.value.target_scene_count || undefined,
      use_research: form.value.use_research,
      detail_level: form.value.detail_level,
      // v1.0.468 — image-to-video motion prompts (off → planner skips them).
      generate_motion_prompts: form.value.generate_motion_prompts,
      motion_level: form.value.generate_motion_prompts ? form.value.motion_level : undefined,
      style_prompt: form.value.style_prompt.trim() || undefined,
      custom_instructions: form.value.custom_instructions.trim() || undefined,
      // v1.0.285 — only send when not 'auto'; the backend defaults to auto
      // anyway, so omitting keeps the request payload tidy.
      window_size: form.value.window_size === 'auto' ? undefined : form.value.window_size,
      // v1.0.508 — story-so-far continuity (false = parallel segments).
      cross_window_context: form.value.cross_window_context,
      // v1.0.291 — planning mode + neighbor context. Only send when two-pass
      // is explicitly selected; single-pass is the backend default and we'd
      // rather omit the field than send a redundant value.
      planning_mode: form.value.planning_mode === 'two-pass' ? 'two-pass' : undefined,
      neighbor_context_back: form.value.planning_mode === 'two-pass' ? ncPreset.back : undefined,
      neighbor_context_forward: form.value.planning_mode === 'two-pass' ? ncPreset.forward : undefined,
    })
    success('Scene planner queued — watch the Jobs panel')
    await pollUntilPlanLanded(ep)
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to start planner')
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
  // NEW plan to land, not any-existing-recent plan. Bulk re-plan (v1.0.286)
  // hit this: on iteration 2+, the previous replan's generated_at was still
  // < 120s old, so the legacy "is generated_at recent?" check returned
  // immediately — the second job hadn't even started running yet. The loop
  // then raced ahead, hit isDuplicate 409s on every subsequent POST, and
  // only ONE scene actually got re-planned out of (e.g.) 77 placeholders.
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
    if (plan.value && plan.value.generated_at) {
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

// ── v1.0.245 — Plan health + per-scene re-plan ──────────────────────────
// Flag scenes that look broken so they're findable without scrolling: no
// visual prompt, suspiciously long (normal scenes are ≤8–12s), or a planner
// fallback boundary_reason. 20s is well above any normal scene length.
const OVERLONG_SEC = 20
const problemScenes = computed(() => {
  const list: Array<{ scene: ScenePlanEntry; index: number; reasons: string[] }> = []
  ;(plan.value?.scenes || []).forEach((s, i) => {
    const reasons: string[] = []
    const dur = s.end_sec - s.start_sec
    if (!s.visual_prompt || !s.visual_prompt.trim()) reasons.push('no prompt')
    if (dur > OVERLONG_SEC) reasons.push(`${dur.toFixed(0)}s long`)
    if (s.boundary_reason && /^auto-(filled|split)/.test(s.boundary_reason)) reasons.push('planner fallback')
    if (reasons.length) list.push({ scene: s, index: i + 1, reasons })
  })
  return list
})
const problemIds = computed(() => new Set(problemScenes.value.map(p => p.scene.id)))

// v1.0.286 — subset count for the bulk re-plan button: only the
// empty-visual-prompt scenes (the planner-failure class). Over-long /
// boundary-reason problems aren't bulk-replannable because the user
// needs to judge each case.
const emptyPromptCount = computed(() => {
  return (plan.value?.scenes || []).filter(
    s => !s.visual_prompt || !s.visual_prompt.trim(),
  ).length
})

function jumpToScene(id: string): void {
  if (typeof document === 'undefined') return
  const el = document.getElementById(`splan-scene-${id}`)
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.classList.add('scene-row-flash')
    setTimeout(() => el.classList.remove('scene-row-flash'), 1500)
  }
}

const replanningId = ref<string | null>(null)

// v1.0.288 — prompt-only regeneration. Distinct from re-plan because the
// backend call is much smaller (prose, not JSON) and the user might want
// to regenerate a prompt without altering the scene's time boundaries.
const regenPromptId = ref<string | null>(null)
async function regenerateScenePrompt(scene: ScenePlanEntry): Promise<void> {
  if (!form.value.model) { showError('Pick a model above first'); return }
  if (!scene.transcript_segment?.trim()) { showError('Scene has no transcript_segment to base a prompt on.'); return }
  const ep = episodeId.value
  regenPromptId.value = scene.id
  const previousGeneratedAt = plan.value?.generated_at || null
  try {
    await post(`/projects/${slug.value}/scene-plan/${ep}/regenerate-prompt`, {
      scene_id: scene.id,
      model: form.value.model,
      detail_level: form.value.detail_level,
      style_prompt: form.value.style_prompt.trim() || undefined,
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
    s => (!s.visual_prompt || !s.visual_prompt.trim()) && (s.transcript_segment && s.transcript_segment.trim()),
  )
  if (!empty.length) {
    success('No regenerable scenes — either every scene already has a prompt, or empty scenes also have empty transcripts.')
    return
  }
  const ep = episodeId.value
  const ok = await ask({
    title: `Regenerate ${empty.length} visual prompt${empty.length === 1 ? '' : 's'}?`,
    message:
      `Rewrites the visual_prompt for every empty-prompt scene in a SINGLE job that fans out across your Chat Studio pool `
      + `(one scene per endpoint, in parallel) and retries transient disconnects. Time boundaries + transcript_segment stay exactly as-is. `
      + `Much faster than the old one-at-a-time loop when you have more than one endpoint configured.`
      + `${dirty.value ? ' Unsaved edits to the plan will be discarded first.' : ''}`,
    confirmLabel: `Regen all ${empty.length}`,
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
      detail_level: form.value.detail_level,
      style_prompt: form.value.style_prompt.trim() || undefined,
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

// v1.0.286 — bulk re-plan state. Holds the in-progress loop so the UI can
// surface "Re-planning N of M…" and disable other actions. `cancelRequested`
// lets the user bail out between scenes (we don't tear down the active LLM
// call mid-stream — the current scene finishes, then the loop exits).
const bulkReplan = ref<{
  active: boolean
  completed: number
  total: number
  currentSceneIndex: number | null
  cancelRequested: boolean
  /** v1.0.458 — true when the run is a single parallel pool job (bulk regen
   *  prompts) rather than the legacy one-scene-at-a-time loop (full re-plan).
   *  The progress strip + cancel behave differently for each. */
  parallel?: boolean
  /** v1.0.458 — backend job id for the parallel run, so Cancel can stop it. */
  jobId?: string | null
}>({ active: false, completed: 0, total: 0, currentSceneIndex: null, cancelRequested: false })

/**
 * v1.0.286 — bulk re-plan every scene with an empty visual prompt. Walks
 * the plan one scene at a time (the backend's isDuplicate guard only allows
 * one scene_plan_run per episode at a time, so this MUST be sequential).
 *
 * The loop is robust to scene-id shifts: after each re-plan the generator
 * splices new scenes in place of the target and renumbers scene_index, but
 * IDs of UNRELATED scenes stay stable. We re-read `plan.value` each
 * iteration to find the next still-empty scene rather than trusting a
 * snapshot taken before the first re-plan.
 *
 * Cap of 200 iterations is a safety guard — even a totally broken plan
 * shouldn't have more empty scenes than that, and if every re-plan
 * paradoxically produced MORE empty scenes we'd notice in the progress
 * count and the cancel button is one click away.
 */
async function replanAllEmpty(): Promise<void> {
  if (!form.value.model) { showError('Pick a model above first'); return }
  if (bulkReplan.value.active) return
  const empty = (plan.value?.scenes || []).filter(
    s => !s.visual_prompt || !s.visual_prompt.trim(),
  )
  if (!empty.length) {
    success('No placeholder scenes to re-plan — every scene already has a visual prompt.')
    return
  }
  const ep = episodeId.value
  const ok = await ask({
    title: `Re-plan ${empty.length} placeholder scene${empty.length === 1 ? '' : 's'}?`,
    message:
      `These scenes have empty visual prompts (the planner couldn't generate one — usually a local-model JSON failure). `
      + `Re-runs the planner on each one's time range, one at a time. `
      + `Estimated ~${Math.ceil(empty.length * 0.5)}-${empty.length}min depending on your model. `
      + `You can cancel between scenes.${dirty.value ? ' Unsaved edits to the plan will be discarded first.' : ''}`,
    confirmLabel: `Re-plan all ${empty.length}`,
  })
  if (!ok) return

  bulkReplan.value = {
    active: true, completed: 0, total: empty.length,
    currentSceneIndex: null, cancelRequested: false,
  }

  let safetyCap = 200
  let succeeded = 0
  let failed = 0
  // v1.0.287 — tracks scene IDs we've already marked as "failed" so the
  // .find() doesn't pick them up again after the marker gets wiped by the
  // next loadStatus() (plan.value is fully replaced on each fetch, so
  // in-memory mutations don't persist). Skip-set is the only reliable way
  // to avoid retrying the same hopeless scene.
  const skipIds = new Set<string>()
  while (safetyCap-- > 0 && !bulkReplan.value.cancelRequested) {
    if (episodeId.value !== ep) break // user switched episodes — stop
    const next = (plan.value?.scenes || []).find(
      s => !skipIds.has(s.id) && (!s.visual_prompt || !s.visual_prompt.trim()),
    )
    if (!next) break
    bulkReplan.value.currentSceneIndex = next.scene_index
    // v1.0.287 — capture the plan's CURRENT generated_at BEFORE posting,
    // so pollUntilPlanLanded waits specifically for THIS new re-plan to
    // land (not the previous iteration's, which would still be < 120s old
    // and falsely satisfy the legacy "any recent" check).
    const previousGeneratedAt = plan.value?.generated_at || null
    try {
      await post(`/projects/${slug.value}/scene-plan/${ep}/replan-scene`, {
        scene_id: next.id,
        model: form.value.model,
        detail_level: form.value.detail_level,
        style_prompt: form.value.style_prompt.trim() || undefined,
        custom_instructions: form.value.custom_instructions.trim() || undefined,
        window_size: form.value.window_size === 'auto' ? undefined : form.value.window_size,
      })
      await pollUntilPlanLanded(ep, { previousGeneratedAt })
      // After the splice, the original `next.id` is GONE from the plan (it
      // got replaced by 1-N new scenes). If we can't find it anymore, the
      // re-plan succeeded. If we CAN still find it AND it's still empty,
      // the re-plan produced no prompts (model failure) — skip it forever.
      const stillThereAndEmpty = (plan.value?.scenes || []).some(
        s => s.id === next.id && (!s.visual_prompt || !s.visual_prompt.trim()),
      )
      if (stillThereAndEmpty) {
        failed++
        skipIds.add(next.id)
      } else {
        succeeded++
      }
    } catch (e: any) {
      failed++
      skipIds.add(next.id)
      // Only show the first few errors — a 50-scene cascade of toasts is
      // worse than a silent failure-counter in the progress strip.
      if (failed <= 3) {
        showError(`Scene #${next.scene_index} re-plan failed: ${e?.data?.detail || e?.message || 'unknown'}`)
      } else if (failed === 4) {
        showError(`Multiple re-plans failing — suppressing further toasts. See the final summary for counts.`)
      }
    }
    bulkReplan.value.completed++
  }

  const wasCancelled = bulkReplan.value.cancelRequested
  bulkReplan.value = { active: false, completed: 0, total: 0, currentSceneIndex: null, cancelRequested: false }
  if (wasCancelled) {
    success(`Bulk re-plan cancelled. Re-planned ${succeeded}, ${failed} skipped (model couldn't produce a prompt).`)
  } else if (failed > 0 && succeeded > 0) {
    // Partial success — common with smaller local models that succeed
    // sporadically. Surface both numbers so the user knows their next move.
    success(`Bulk re-plan finished. Succeeded: ${succeeded}. Skipped (model failure): ${failed}. Re-run the bulk button to retry the skipped ones, or fill them in manually.`)
  } else if (failed > 0 && succeeded === 0) {
    // The model literally can't do any of these — escalate.
    showError(`Bulk re-plan finished with ${failed} failure${failed === 1 ? '' : 's'} and 0 successes. Your selected model can't produce valid prompts for these scenes. Try a stronger model (e.g. qwen3-coder, claude-sonnet, gpt-4o) or fill the prompts in by hand.`)
  } else {
    success(`Re-planned ${succeeded} placeholder scene${succeeded === 1 ? '' : 's'}.`)
  }
}

function cancelBulkReplan(): void {
  if (!bulkReplan.value.active) return
  bulkReplan.value.cancelRequested = true
  // v1.0.458 — the parallel bulk regen is a single backend job; cancelling the
  // frontend poll alone would leave it churning. Tell the server to stop it
  // (the generator polls isCancelled() between chunks). The legacy full-re-plan
  // loop has no job to cancel — it just stops between scenes.
  const jobId = bulkReplan.value.jobId
  if (bulkReplan.value.parallel && jobId) {
    void del(`/projects/${slug.value}/jobs/${jobId}`).catch(() => { /* already finished — harmless */ })
  }
}

// v1.0.286 — Back-to-top floating button. Tracks scroll position on the
// page's scrollable ancestor so the button only appears once the user is
// far enough down to notice the scroll burden. The dashboard layout uses
// .page-content as the scroll container (see layouts/dashboard.vue) — we
// listen there rather than on window because the page itself doesn't scroll.
const showBackToTop = ref(false)
const SCROLL_THRESHOLD = 800   // px before the button surfaces

function getScrollContainer(): HTMLElement | null {
  if (typeof document === 'undefined') return null
  return document.querySelector('.page-content') as HTMLElement | null
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
  if (el) el.addEventListener('scroll', onScroll, { passive: true })
})
onUnmounted(() => {
  const el = getScrollContainer()
  if (el) el.removeEventListener('scroll', onScroll)
})

async function replanScene(scene: ScenePlanEntry): Promise<void> {
  if (!form.value.model) { showError('Pick a model above first'); return }
  const dur = (scene.end_sec - scene.start_sec).toFixed(0)
  const ok = await ask({
    title: `Re-plan scene #${scene.scene_index}?`,
    message: `Re-runs the planner on just this ${dur}s range (${scene.start_sec.toFixed(1)}–${scene.end_sec.toFixed(1)}s) and replaces it with proper sub-scenes. Every other scene and its generated image is kept.${dirty.value ? ' Your unsaved edits to the plan will be discarded first.' : ''}`,
    confirmLabel: 'Re-plan scene',
  })
  if (!ok) return
  const ep = episodeId.value
  replanningId.value = scene.id
  try {
    await post(`/projects/${slug.value}/scene-plan/${ep}/replan-scene`, {
      scene_id: scene.id,
      model: form.value.model,
      detail_level: form.value.detail_level,
      style_prompt: form.value.style_prompt.trim() || undefined,
      custom_instructions: form.value.custom_instructions.trim() || undefined,
      // v1.0.285 — keep behaviour consistent with the full-plan call.
      window_size: form.value.window_size === 'auto' ? undefined : form.value.window_size,
    })
    success('Re-plan queued — watch the Jobs panel; the scene list updates when it lands.')
    await pollUntilPlanLanded(ep)
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to start re-plan')
  } finally {
    replanningId.value = null
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
    serverPlan.value = JSON.stringify(plan.value)
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
    serverPlan.value = ''
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
}

// v1.0.242 — savable presets for the plan settings (model, target count,
// research toggle, detail level, style, custom instructions). Mirrors the
// device-aware PresetPicker pattern used on the Ideas / Scripts pages. Stored
// under config.scene_plan_presets; episode_id/title are stripped automatically.
const planPresets = usePresets<any>({
  slug: slug.value,
  configKey: 'scene_plan',
  presetType: 'scene-plan',
  snapshot: () => ({
    model: form.value.model,
    target_scene_count: form.value.target_scene_count,
    use_research: form.value.use_research,
    detail_level: form.value.detail_level,
    style_prompt: form.value.style_prompt,
    custom_instructions: form.value.custom_instructions,
    // v1.0.508 — persist the run-shaping toggles so a preset captures the
    // speed/quality config (story-so-far continuity, motion prompts, window size).
    cross_window_context: form.value.cross_window_context,
    generate_motion_prompts: form.value.generate_motion_prompts,
    motion_level: form.value.motion_level,
    window_size: form.value.window_size,
  }),
  apply: (data) => { Object.assign(form.value, data) },
})

onMounted(() => { void loadStatus(); void loadContinuity(); void planPresets.load() })
watch(episodeId, () => { void loadStatus(); void loadContinuity() })
</script>

<style scoped>
/* v1.0.364 — read-only channel Look (Style Bible) box on the Scene Plan page. */
.channel-look-box {
  border: 1px solid var(--border, #333);
  border-radius: 6px;
  background: var(--bg-secondary, #1c1c1f);
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.5;
  max-height: 120px;
  overflow-y: auto;
}
.block { display: block; }
.link { color: var(--accent, #6c8fff); text-decoration: underline; cursor: pointer; }
.mb-1 { margin-bottom: 4px; }

/* v1.0.291 — planning-mode radio group. Each radio card spans full width
   with its description below so the user can scan both options at a glance. */
.planning-mode-radios {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 6px;
}
.planning-mode-radio {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--border, #333);
  border-radius: 6px;
  background: var(--bg-secondary, #1c1c1f);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.planning-mode-radio:hover:not(.disabled) {
  border-color: var(--accent, #6c8fff);
}
.planning-mode-radio.active {
  border-color: var(--accent, #6c8fff);
  background: rgba(108, 143, 255, 0.06);
}
.planning-mode-radio.disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.planning-mode-radio input[type="radio"] {
  margin-top: 4px;
}
.planning-mode-radio p {
  margin: 4px 0 0;
  line-height: 1.45;
}

/* v1.0.288 — bulk-button group on the plan-health head. The two bulk
   options (✨ Regen prompts only / 🪄 Full re-plan) sit side-by-side. */
.bulk-buttons {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

/* v1.0.286 — Plan-health head: room for the new bulk re-plan button next to
   the heading. Was just a static line; now needs flex so the button hangs
   on the right edge. */
.plan-health-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

/* v1.0.286 — bulk re-plan progress strip. Subtle bar + status line, visible
   only while the loop is active. The cancel button is a link-button (less
   weight than a danger button) because it's "stop after this scene", not
   "kill the running call". */
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

/* v1.0.286 — back-to-top floating button. Sits above the dashboard's bottom
   chrome (sidebar credits) and pulls to the right so it doesn't obscure
   scene-row Re-plan buttons on hover. Subtle fade-in via a brief transform. */
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

/* v1.0.193 — continuity-chain live-pacing chip. */
.cc-pacing-chip {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 12px;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-left: 3px solid #b07cff;
  border-radius: 8px;
  background: rgba(176, 124, 255, 0.07);
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--text-secondary);
}
.cc-pacing-chip strong { color: var(--text-primary); }
.cc-pacing-link { margin-left: auto; white-space: nowrap; color: var(--accent); text-decoration: none; }
.cc-pacing-link:hover { text-decoration: underline; }

.validation-msg {
  color: #c97a4a;
  background: rgba(201, 122, 74, 0.08);
  border: 1px solid rgba(201, 122, 74, 0.25);
  border-radius: 4px;
  padding: 6px 10px;
}
.scene-list { list-style: none; padding: 0; margin: 6px 0 0; display: flex; flex-direction: column; gap: 8px; }
.scene-row {
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-secondary);
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
