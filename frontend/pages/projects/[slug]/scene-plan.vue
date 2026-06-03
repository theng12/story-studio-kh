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
      filter-field="script"
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
        <!-- v1.0.245 — Plan-health banner. Surfaces scenes that look broken
             (no prompt, over-long, or a planner fallback) so you don't have to
             scroll hundreds of scenes to find them. Click to jump. -->
        <div v-if="problemScenes.length" class="plan-health mt-2">
          <div class="plan-health-head">
            ⚠ {{ problemScenes.length }} scene{{ problemScenes.length === 1 ? '' : 's' }} need attention
            <span class="text-muted text-xs">— no prompt, over-long, or planner fallback</span>
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
              <label class="text-xs text-muted">Visual prompt (sent to the image generator)</label>
              <textarea
                v-model="scene.visual_prompt"
                class="textarea scene-textarea"
                rows="2"
              />
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
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'

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
const planning = ref(false)
const saving = ref(false)
const deleting = ref(false)

// v1.0.193 — continuity-chain density-pacing indicator. When this project is
// continuity-chain, surface the active scene-length band (set on the Character
// Sheet page) so the user knows the planner paces for a "live" feel.
const continuityPacing = ref<{ min_sec: number; max_sec: number } | null>(null)

async function loadContinuity(): Promise<void> {
  continuityPacing.value = null
  if (!episodeId.value) return
  try {
    const fmt = await get<{ visualSource?: string }>(`/projects/${slug.value}/effective-format`)
    if (fmt?.visualSource !== 'continuity-chain') return
    const r = await get<{ exists: boolean; config: { pacing?: { min_sec: number; max_sec: number } } }>(
      `/projects/${slug.value}/continuity/${episodeId.value}`,
    )
    continuityPacing.value = r.config?.pacing || { min_sec: 2, max_sec: 8 }
  } catch { /* non-continuity project or fetch failed — no chip */ }
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
  planning.value = true
  try {
    await post(`/projects/${slug.value}/scene-plan/${episodeId.value}/run`, {
      model: form.value.model,
      target_scene_count: form.value.target_scene_count || undefined,
      use_research: form.value.use_research,
      detail_level: form.value.detail_level,
      style_prompt: form.value.style_prompt.trim() || undefined,
      custom_instructions: form.value.custom_instructions.trim() || undefined,
    })
    success('Scene planner queued — watch the Jobs panel')
    await pollUntilPlanLanded()
  } catch (e: any) {
    showError(e?.data?.detail || e?.message || 'Failed to start planner')
  } finally {
    planning.value = false
  }
}

async function pollUntilPlanLanded(): Promise<void> {
  const start = Date.now()
  const timeoutMs = 120_000
  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 3000))
    await loadStatus()
    if (plan.value && plan.value.generated_at) {
      const generated = new Date(plan.value.generated_at).getTime()
      if (Date.now() - generated < timeoutMs) return
    }
  }
  showError('Scene planner taking longer than 120s — check the Jobs panel.')
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
async function replanScene(scene: ScenePlanEntry): Promise<void> {
  if (!form.value.model) { showError('Pick a model above first'); return }
  const dur = (scene.end_sec - scene.start_sec).toFixed(0)
  const ok = await ask({
    title: `Re-plan scene #${scene.scene_index}?`,
    message: `Re-runs the planner on just this ${dur}s range (${scene.start_sec.toFixed(1)}–${scene.end_sec.toFixed(1)}s) and replaces it with proper sub-scenes. Every other scene and its generated image is kept.${dirty.value ? ' Your unsaved edits to the plan will be discarded first.' : ''}`,
    confirmLabel: 'Re-plan scene',
  })
  if (!ok) return
  replanningId.value = scene.id
  try {
    await post(`/projects/${slug.value}/scene-plan/${episodeId.value}/replan-scene`, {
      scene_id: scene.id,
      model: form.value.model,
      detail_level: form.value.detail_level,
      style_prompt: form.value.style_prompt.trim() || undefined,
      custom_instructions: form.value.custom_instructions.trim() || undefined,
    })
    success('Re-plan queued — watch the Jobs panel; the scene list updates when it lands.')
    await pollUntilPlanLanded()
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
