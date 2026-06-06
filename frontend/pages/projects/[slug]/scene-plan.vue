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
      generate-label="Plan scenes"
      loading-label="Planning…"
      :generate-loading="planning"
      :generate-disabled="!canPlan"
      :generate-status="planning ? `Planning scenes for ${episodeId}…` : (canPlan ? '' : planDisabledReason)"
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

      <!-- v1.0.285 — per-window scene count control. Bigger windows = fewer
           LLM calls + richer cross-scene cohesion, but larger JSON outputs
           that flaky local models often truncate (the empty-visual_prompts
           symptom). "Auto" picks based on the selected model. -->
      <div class="form-group mt-3">
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
      </div>

      <!-- v1.0.242 — global style + custom instructions woven into every scene. -->
      <div class="grid-2 mt-2">
        <div class="form-group">
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

      <!-- Savable presets for these plan settings. -->
      <PresetPicker
        label="Plan preset"
        hint="Saves the model, target count, research toggle, detail level, style prompt, and custom instructions. Pick one + Apply to load; Save as… to capture the current settings."
        :presets="planPresets.presets.value"
        :active-id="planPresets.activeId.value"
        :current-machine-label="planPresets.machineLabel.value"
        :show-all-devices="planPresets.showAllDevices.value"
        :cross-device-count="planPresets.crossDeviceCount.value"
        :active-preset-is-cross-device="planPresets.activePresetIsCrossDevice.value"
        :active-preset-machine-label="planPresets.activePresetMachineLabel.value"
        @update:active-id="planPresets.setActive"
        @update:show-all-devices="(v) => planPresets.showAllDevices.value = v"
        @apply="planPresets.applyActive(); success('Preset applied')"
        @overwrite="planPresets.overwrite(); success('Preset saved')"
        @save-as="(n) => planPresets.saveAs(n).then(() => success(`Saved: ${n}`))"
        @rename="(n) => planPresets.rename(n).then(() => success(`Renamed to ${n}`))"
        @delete="planPresets.remove(); success('Preset deleted')"
      />
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
            <button
              v-if="emptyPromptCount > 0"
              class="btn btn-sm btn-secondary"
              :disabled="!form.model || planning || bulkReplan.active"
              :title="!form.model
                ? 'Pick a model above first'
                : `Re-plan ${emptyPromptCount} scene(s) with empty visual prompts, one at a time.`"
              @click="replanAllEmpty"
            >
              🪄 Re-plan all {{ emptyPromptCount }} empty
            </button>
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
              Re-planning scene #{{ bulkReplan.currentSceneIndex ?? '?' }} ·
              {{ bulkReplan.completed }}/{{ bulkReplan.total }} done
              <button class="link-btn-danger" @click="cancelBulkReplan">Cancel after this scene</button>
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
                :disabled="!form.model || replanningId === scene.id || planning"
                :title="!form.model ? 'Pick a model above first' : 'Re-plan this time range with the LLM — replaces it with proper sub-scenes (other scenes + images untouched)'"
                @click="replanScene(scene)"
              >{{ replanningId === scene.id ? '⏳ Re-planning…' : '🪄 Re-plan' }}</button>
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
  // v1.0.260 — Visual Recipe fields.
  visual_prompt_raw?: string
  emotion?: string
  emotion_locked?: boolean
}
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

async function loadContinuity(): Promise<void> {
  continuityPacing.value = null
  recipeEnabled.value = false
  recipeMode.value = 'guide'
  if (!episodeId.value) return
  try {
    const fmt = await get<{ visualSource?: string }>(`/projects/${slug.value}/effective-format`)
    if (fmt?.visualSource !== 'continuity-chain') return
    const r = await get<{ exists: boolean; config: { pacing?: { min_sec: number; max_sec: number }; recipe?: { enabled?: boolean; mode?: 'guide' | 'scene' } } }>(
      `/projects/${slug.value}/continuity/${episodeId.value}`,
    )
    continuityPacing.value = r.config?.pacing || { min_sec: 2, max_sec: 8 }
    recipeEnabled.value = r.config?.recipe?.enabled === true
    recipeMode.value = r.config?.recipe?.mode === 'scene' ? 'scene' : 'guide'
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
}
function toggleEmotionLock(scene: ScenePlanEntry): void {
  scene.emotion_locked = !scene.emotion_locked
}

const form = ref({
  model: '',  // ModelSelector auto-picks first usable
  target_scene_count: null as number | null,
  use_research: true,
  // v1.0.242 — visual-prompt richness (1=Concise … 4=Cinematic). 2 = the
  // historical default, so existing behaviour is unchanged until changed.
  detail_level: 2,
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

// v1.0.285 — flagged for the window-size "Auto" tooltip so the user sees which
// branch will fire (10 scenes for local, 30 for cloud) before they hit Plan.
const isLocalModel = computed(() => (form.value.model || '').startsWith('lmstudio:'))

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
    await post(`/projects/${slug.value}/scene-plan/${ep}/run`, {
      model: form.value.model,
      target_scene_count: form.value.target_scene_count || undefined,
      use_research: form.value.use_research,
      detail_level: form.value.detail_level,
      style_prompt: form.value.style_prompt.trim() || undefined,
      custom_instructions: form.value.custom_instructions.trim() || undefined,
      // v1.0.285 — only send when not 'auto'; the backend defaults to auto
      // anyway, so omitting keeps the request payload tidy.
      window_size: form.value.window_size === 'auto' ? undefined : form.value.window_size,
    })
    success('Scene planner queued — watch the Jobs panel')
    await pollUntilPlanLanded(ep)
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to start planner')
  } finally {
    if (planningEpisode.value === ep) planningEpisode.value = null
  }
}

async function pollUntilPlanLanded(ep: string, opts?: { previousGeneratedAt?: string | null }): Promise<void> {
  const start = Date.now()
  const timeoutMs = 120_000
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
  if (episodeId.value === ep) showError('Scene planner taking longer than 120s — check the Jobs panel.')
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
  if (bulkReplan.value.active) bulkReplan.value.cancelRequested = true
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
    message: 'Removes scene_plan.json from the episode dir. Generated images are NOT deleted — only the planning data.',
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
  }),
  apply: (data) => { Object.assign(form.value, data) },
})

onMounted(() => { void loadStatus(); void loadContinuity(); void planPresets.load() })
watch(episodeId, () => { void loadStatus(); void loadContinuity() })
</script>

<style scoped>
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
.scene-row-head { display: flex; gap: 8px; align-items: baseline; }
.scene-boundary-reason { font-style: italic; }
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
