<template>
  <section class="card visual-timing-motion" :aria-busy="loading || saving">
    <header class="vtm-header">
      <div>
        <h3>Visual timing & motion</h3>
        <p class="text-muted text-sm">Set the next Scene Plan's timing and motion scope for this episode.</p>
      </div>
      <button type="button" class="btn btn-primary btn-sm" :disabled="loading || saving || !!loadError || !!validationError" @click="save">
        {{ saving ? 'Saving…' : 'Save Timing & Motion' }}
      </button>
    </header>

    <p v-if="planPacing" class="vtm-plan-state text-sm">
      <strong>Saved plan:</strong> {{ pacingLabel(planPacing) }}
      <span>Draft: {{ pacingLabel(draft.pacing) }}</span>
    </p>
    <p v-else class="vtm-plan-state text-sm">
      This draft applies the next time Scene Plan is created or rebuilt. Existing scene timing is unchanged.
    </p>
    <p class="vtm-scope-note text-sm">Changing motion scope does not alter clips already approved or generated. It guides a future motion-generation run only.</p>

    <p v-if="loadError" class="vtm-error text-sm" role="alert">{{ loadError }}</p>
    <p v-else-if="saveError" class="vtm-error text-sm" role="alert">{{ saveError }}</p>
    <p v-if="!loadError && validationError" class="vtm-error text-sm" role="alert">{{ validationError }}</p>
    <p v-if="presetNotice" class="vtm-notice text-sm" role="status">{{ presetNotice }}</p>

    <fieldset class="vtm-section" :disabled="loading || saving || !!loadError">
      <legend>Scene timing</legend>
      <div class="vtm-choice-row" role="radiogroup" aria-label="Scene timing mode">
        <label><input :checked="draft.pacing.mode !== 'variable'" type="radio" name="timing-mode" @change="setPacingMode('uniform')" /> Uniform</label>
        <label><input :checked="draft.pacing.mode === 'variable'" type="radio" name="timing-mode" @change="setPacingMode('variable')" /> Ordered periods</label>
      </div>

      <div v-if="draft.pacing.mode !== 'variable'" class="vtm-band">
        <label>Shortest scene
          <input :value="draft.pacing.min_sec" class="input" type="number" min="1" max="60" step="1" @input="setUniformBand('min_sec', inputNumber($event))" /> seconds
        </label>
        <label>Longest scene
          <input :value="draft.pacing.max_sec" class="input" type="number" min="1" max="60" step="1" @input="setUniformBand('max_sec', inputNumber($event))" /> seconds
        </label>
      </div>

      <div v-else class="vtm-periods">
        <div v-for="(period, index) in draft.pacing.periods" :key="`${period.start_sec}-${index}`" class="vtm-period">
          <strong>Period {{ index + 1 }}</strong>
          <span>From {{ period.start_sec }}s</span>
          <label v-if="period.end_sec !== null">Ends at
            <input :value="period.end_sec" class="input" type="number" :min="period.start_sec + 0.1" step="1" @input="setPeriodEnd(index, inputNumber($event))" /> seconds
          </label>
          <span v-else>To episode end</span>
          <label>Shortest
            <input :value="period.min_sec" class="input" type="number" min="1" max="60" step="1" @input="setPeriodBand(index, 'min_sec', inputNumber($event))" /> seconds
          </label>
          <label>Longest
            <input :value="period.max_sec" class="input" type="number" min="1" max="60" step="1" @input="setPeriodBand(index, 'max_sec', inputNumber($event))" /> seconds
          </label>
        </div>
        <div class="vtm-period-actions">
          <button type="button" class="btn btn-secondary btn-sm" @click="addPeriod">Add Period</button>
          <button type="button" class="btn btn-ghost btn-sm" :disabled="draft.pacing.periods.length === 1" @click="removeLastPeriod">Remove Last Period</button>
        </div>
      </div>
    </fieldset>

    <fieldset class="vtm-section" :disabled="loading || saving || !!loadError">
      <legend>Motion scope</legend>
      <p class="text-muted text-sm">Times use the narration clock, starting at zero. Any opening visuals already covering that time remain in place.</p>
      <div class="vtm-choice-row" role="radiogroup" aria-label="Motion scope">
        <label><input :checked="draft.motion_scope.mode === 'off'" type="radio" name="motion-scope" @change="setMotionMode('off')" /> Off</label>
        <label><input :checked="draft.motion_scope.mode === 'opening'" type="radio" name="motion-scope" @change="setMotionMode('opening')" /> Opening</label>
        <label><input :checked="draft.motion_scope.mode === 'selected'" type="radio" name="motion-scope" @change="setMotionMode('selected')" /> Selected scenes</label>
        <label><input :checked="draft.motion_scope.mode === 'all'" type="radio" name="motion-scope" @change="setMotionMode('all')" /> All scenes</label>
      </div>

      <label v-if="draft.motion_scope.mode === 'opening'" class="vtm-opening">Motion through
        <input :value="draft.motion_scope.end_sec" class="input" type="number" min="0.1" step="1" @input="setOpeningEnd(inputNumber($event))" /> seconds
      </label>

      <div v-if="draft.motion_scope.mode === 'selected'" class="vtm-scene-picker">
        <p v-if="!scenes.length" class="text-muted text-sm">Open a Scene Plan with scenes to choose this scope.</p>
        <label v-for="scene in scenes" v-else :key="scene.id" class="vtm-scene-choice">
          <input :checked="selectedSceneIds.has(scene.id)" type="checkbox" @change="toggleScene(scene.id)" />
          Scene {{ scene.id }} · {{ scene.start_sec }}–{{ scene.end_sec }} seconds
        </label>
      </div>

      <p class="vtm-eligibility text-sm">{{ eligibilityMessage }}</p>
      <p v-if="crossingSceneIds.length" class="vtm-crossing text-sm">
        Motion applies only to whole scenes. {{ crossingSceneIds.join(', ') }} crosses the opening boundary and stays still.
      </p>

      <div class="vtm-intensity">
        <strong>Motion intensity</strong>
        <div class="vtm-choice-row" role="radiogroup" aria-label="Motion intensity">
          <button
            v-for="level in MOTION_LEVELS"
            :key="level.value"
            type="button"
            class="btn btn-ghost btn-sm"
            :class="{ active: draft.motion_level === level.value }"
            role="radio"
            :aria-checked="draft.motion_level === level.value"
            @click="setMotionLevel(level.value)"
          >{{ level.label }}</button>
        </div>
        <p class="text-muted text-sm">{{ motionLevel.hint }}</p>
      </div>
    </fieldset>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { normalizeMotionScope, resolveMotionScope, type MotionScope } from '@shared/motion-scope'
import { parseScenePacing, type ScenePacing, type ScenePacingPeriod } from '@shared/pacing'
import {
  continuityDefaults,
  normalizeContinuityConfig,
  storedPresetPacing,
  type ContinuityConfig,
} from '~/composables/useContinuityConfig'

interface SceneTiming {
  id: string
  start_sec: number
  end_sec: number
}

const props = withDefaults(defineProps<{
  episodeId: string
  scenes?: readonly SceneTiming[]
  planPacing?: ScenePacing | null
}>(), {
  scenes: () => [],
  planPacing: null,
})

const emit = defineEmits<{ saved: [config: ContinuityConfig] }>()
const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { get, put } = useApi()
const { success, error: showError } = useToast()

const draft = ref<ContinuityConfig>(continuityDefaults())
const savedEpisodeConfig = ref<ContinuityConfig>(continuityDefaults())
const loading = ref(false)
const saving = ref(false)
const loadError = ref('')
const saveError = ref('')
const presetNotice = ref('')
let requestSequence = 0

const MOTION_LEVELS = [
  { value: 1, label: 'Minimal', hint: 'Faint ambient drift only.' },
  { value: 2, label: 'Gentle', hint: 'Slow camera and ambient movement.' },
  { value: 3, label: 'Moderate', hint: 'Subtle subject motion with gentle camera.' },
  { value: 4, label: 'Lively', hint: 'Clear but smooth movement.' },
] as const

const motionLevel = computed(() =>
  MOTION_LEVELS.find(level => level.value === draft.value.motion_level) ?? MOTION_LEVELS[1],
)

const selectedSceneIds = computed(() => new Set(
  draft.value.motion_scope.mode === 'selected' ? draft.value.motion_scope.scene_ids : [],
))

const validationError = computed(() => {
  try {
    parseScenePacing(draft.value.pacing)
    normalizeMotionScope(draft.value.motion_scope)
    if (!isMotionLevel(draft.value.motion_level)) throw new Error('Choose a valid motion intensity.')
    return ''
  } catch (error) {
    return error instanceof Error ? error.message
      .replace(/pacing\.periods\[(\d+)\]\./g, (_, index) => `Period ${Number(index) + 1}: `)
      .replace(/pacing\./g, '')
      .replace(/min_sec/g, 'shortest scene')
      .replace(/max_sec/g, 'longest scene')
      .replace(/start_sec/g, 'start time')
      .replace(/end_sec/g, 'end time')
      : 'Review timing and motion before saving.'
  }
})

const resolvedMotion = computed(() => {
  if (!props.scenes.length) return null
  try {
    return resolveMotionScope(props.scenes, draft.value.motion_scope)
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Review the Scene Plan before choosing motion.' }
  }
})

const crossingSceneIds = computed(() => {
  const resolution = resolvedMotion.value
  return resolution && 'crossing_scene_ids' in resolution ? resolution.crossing_scene_ids : []
})

const eligibilityMessage = computed(() => {
  if (!props.scenes.length) return 'Scene eligibility will appear when this episode has a Scene Plan.'
  const resolution = resolvedMotion.value
  if (resolution && 'error' in resolution) return resolution.error
  const eligible = resolution && 'scene_ids' in resolution ? resolution.scene_ids.length : 0
  return `${eligible} of ${props.scenes.length} scenes are eligible for motion.`
})

function identity(): string {
  return `${slug.value}:${props.episodeId}`
}

function inputNumber(event: Event): number {
  return Number((event.target as HTMLInputElement).value)
}

function isMotionLevel(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 4
}

function clearPresetNotice(): void {
  presetNotice.value = ''
}

function pacingLabel(pacing: ScenePacing): string {
  return pacing.mode === 'variable'
    ? `${pacing.periods.length} ordered periods`
    : `uniform ${pacing.min_sec}–${pacing.max_sec} second scenes`
}

function setPacingMode(mode: 'uniform' | 'variable'): void {
  clearPresetNotice()
  if (mode === 'uniform' && draft.value.pacing.mode === 'variable') {
    const first = draft.value.pacing.periods[0]!
    draft.value.pacing = { min_sec: first.min_sec, max_sec: first.max_sec }
  }
  if (mode === 'variable' && draft.value.pacing.mode !== 'variable') {
    const { min_sec, max_sec } = draft.value.pacing
    draft.value.pacing = {
      mode: 'variable', min_sec, max_sec,
      periods: [{ start_sec: 0, end_sec: null, min_sec, max_sec }],
    }
  }
}

function setUniformBand(key: 'min_sec' | 'max_sec', value: number): void {
  clearPresetNotice()
  if (draft.value.pacing.mode === 'variable') return
  draft.value.pacing = { ...draft.value.pacing, [key]: value }
}

function variablePeriods(): ScenePacingPeriod[] {
  return draft.value.pacing.mode === 'variable' ? [...draft.value.pacing.periods] : []
}

function replaceVariablePeriods(periods: ScenePacingPeriod[]): void {
  if (draft.value.pacing.mode !== 'variable') return
  const first = periods[0]!
  draft.value.pacing = { mode: 'variable', min_sec: first.min_sec, max_sec: first.max_sec, periods }
}

function setPeriodEnd(index: number, end_sec: number): void {
  clearPresetNotice()
  const periods = variablePeriods()
  const period = periods[index]
  const next = periods[index + 1]
  if (!period || !next) return
  periods[index] = { ...period, end_sec }
  periods[index + 1] = { ...next, start_sec: end_sec }
  replaceVariablePeriods(periods)
}

function setPeriodBand(index: number, key: 'min_sec' | 'max_sec', value: number): void {
  clearPresetNotice()
  const periods = variablePeriods()
  const period = periods[index]
  if (!period) return
  periods[index] = { ...period, [key]: value }
  replaceVariablePeriods(periods)
}

function addPeriod(): void {
  clearPresetNotice()
  const periods = variablePeriods()
  const last = periods.at(-1)
  if (!last) return
  const end_sec = last.start_sec + 60
  periods[periods.length - 1] = { ...last, end_sec }
  periods.push({ start_sec: end_sec, end_sec: null, min_sec: last.min_sec, max_sec: last.max_sec })
  replaceVariablePeriods(periods)
}

function removeLastPeriod(): void {
  clearPresetNotice()
  const periods = variablePeriods()
  if (periods.length < 2) return
  const previous = periods[periods.length - 2]!
  periods.splice(-1, 1)
  periods[periods.length - 1] = { ...previous, end_sec: null }
  replaceVariablePeriods(periods)
}

function setMotionMode(mode: MotionScope['mode']): void {
  clearPresetNotice()
  if (mode === 'opening') draft.value.motion_scope = { mode, end_sec: 30 }
  else if (mode === 'selected') draft.value.motion_scope = { mode, scene_ids: [] }
  else if (mode === 'share') draft.value.motion_scope = { mode, share_percent: 25, formula: 'opening_hook' }
  else draft.value.motion_scope = { mode }
}

function setOpeningEnd(end_sec: number): void {
  clearPresetNotice()
  if (draft.value.motion_scope.mode === 'opening') draft.value.motion_scope = { mode: 'opening', end_sec }
}

function toggleScene(sceneId: string): void {
  clearPresetNotice()
  if (draft.value.motion_scope.mode !== 'selected') return
  const scene_ids = selectedSceneIds.value.has(sceneId)
    ? draft.value.motion_scope.scene_ids.filter(id => id !== sceneId)
    : [...draft.value.motion_scope.scene_ids, sceneId]
  draft.value.motion_scope = { mode: 'selected', scene_ids }
}

function setMotionLevel(level: number): void {
  clearPresetNotice()
  draft.value.motion_level = level
}

function assertPresetReady(action: 'snapshot' | 'apply'): void {
  if (loading.value) throw new Error(`Cannot ${action} timing and motion while it is loading.`)
  if (saving.value) throw new Error(`Cannot ${action} timing and motion while it is saving.`)
  if (loadError.value) throw new Error(`Cannot ${action} timing and motion: ${loadError.value}`)
  if (validationError.value) throw new Error(`Cannot ${action} timing and motion: ${validationError.value}`)
}

function snapshotPreset(): { pacing: ScenePacing; motion_scope?: MotionScope; motion_level: number } {
  assertPresetReady('snapshot')
  const pacing = parseScenePacing(draft.value.pacing)
  const motion_scope = normalizeMotionScope(draft.value.motion_scope)
  const snapshot = { pacing, motion_level: draft.value.motion_level }
  if (motion_scope.mode === 'selected') {
    presetNotice.value = 'Selected-scene motion stays with this episode and was not included in the preset. Save timing & motion if you change this episode’s scope.'
    return snapshot
  }
  return { ...snapshot, motion_scope }
}

function snapshotPresetForComparison(): { pacing: ScenePacing; motion_scope?: MotionScope; motion_level: number } | null {
  if (loading.value || saving.value || loadError.value || validationError.value) return null
  try {
    const pacing = parseScenePacing(draft.value.pacing)
    const motion_scope = normalizeMotionScope(draft.value.motion_scope)
    const snapshot = { pacing, motion_level: draft.value.motion_level }
    return motion_scope.mode === 'selected' ? snapshot : { ...snapshot, motion_scope }
  } catch {
    return null
  }
}

function applyPreset(data: any): void {
  assertPresetReady('apply')
  const source = data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : {}
  const savedPacing = parseScenePacing(savedEpisodeConfig.value.pacing)
  const savedScope = normalizeMotionScope(savedEpisodeConfig.value.motion_scope)
  const storedPacing = storedPresetPacing(source as Partial<ContinuityConfig>)
  const pacing = storedPacing ? parseScenePacing(storedPacing) : savedPacing
  const hasScope = source.motion_scope != null
  const presetScope = hasScope ? normalizeMotionScope(source.motion_scope) : null
  const motion_scope = presetScope?.mode === 'selected' ? savedScope : presetScope ?? savedScope
  const hasMotionLevel = source.motion_level !== undefined
  if (hasMotionLevel && !isMotionLevel(source.motion_level)) {
    throw new Error('Cannot apply timing and motion: preset motion intensity is invalid.')
  }
  const motion_level = hasMotionLevel ? source.motion_level as number : savedEpisodeConfig.value.motion_level

  draft.value = { ...draft.value, pacing, motion_scope, motion_level }
  const timingMessage = storedPacing ? 'timing updated' : 'no saved timing; kept this episode’s timing'
  const scopeMessage = presetScope?.mode === 'selected' || (!hasScope && savedScope.mode === 'selected')
    ? 'Selected-scene motion stays with this episode'
    : hasScope ? 'motion scope updated' : 'no saved motion scope; kept this episode’s scope'
  const intensityMessage = hasMotionLevel ? 'motion intensity updated' : 'no saved motion intensity; kept this episode’s intensity'
  presetNotice.value = `Preset applied: ${timingMessage}; ${scopeMessage}; ${intensityMessage}. Save timing & motion before the next Scene Plan build.`
}

async function load(): Promise<void> {
  const scope = ++requestSequence
  const key = identity()
  const current = () => scope === requestSequence && key === identity()
  if (!props.episodeId) {
    savedEpisodeConfig.value = continuityDefaults()
    draft.value = normalizeContinuityConfig(savedEpisodeConfig.value)
    loadError.value = ''
    saveError.value = ''
    clearPresetNotice()
    loading.value = false
    saving.value = false
    return
  }
  loading.value = true
  saving.value = false
  loadError.value = ''
  saveError.value = ''
  clearPresetNotice()
  try {
    const result = await get<{ exists: boolean; config: ContinuityConfig }>(`/projects/${slug.value}/continuity/${props.episodeId}`)
    if (!current()) return
    savedEpisodeConfig.value = result.exists ? normalizeContinuityConfig(result.config) : continuityDefaults()
    draft.value = normalizeContinuityConfig(savedEpisodeConfig.value)
  } catch (error: any) {
    if (!current()) return
    loadError.value = error?.data?.detail || 'Could not load visual timing and motion.'
    showError(loadError.value)
  } finally {
    if (current()) loading.value = false
  }
}

async function save(): Promise<void> {
  const scope = requestSequence
  const key = identity()
  const current = () => scope === requestSequence && key === identity()
  if (!props.episodeId || saving.value || loading.value || loadError.value || validationError.value) return
  try {
    saveError.value = ''
    clearPresetNotice()
    const snapshot = normalizeContinuityConfig({
      ...draft.value,
      pacing: parseScenePacing(draft.value.pacing),
      motion_scope: normalizeMotionScope(draft.value.motion_scope),
    })
    saving.value = true
    // This panel is the episode's timing owner, so it CLAIMS authority over
    // `pacing` — the only writer that does. Every other whole-config save (the
    // Character Sheet's *Save visual setup*, the pipeline's inline
    // Character-Sheet step) leaves the claim out and the server keeps whatever
    // rhythm is already on disk, so a stale visual save cannot undo a change
    // made here. See PACING_AUTHORITY_CLAIM in electron/server/routes/continuity.ts.
    const saved = await put<{ ok: true; config: ContinuityConfig }>(
      `/projects/${slug.value}/continuity/${props.episodeId}`,
      { ...snapshot, claim_pacing: true },
    )
    if (!current()) return
    savedEpisodeConfig.value = normalizeContinuityConfig(saved.config)
    draft.value = normalizeContinuityConfig(savedEpisodeConfig.value)
    emit('saved', draft.value)
    success('Visual timing and motion saved')
  } catch (error: any) {
    if (current()) {
      saveError.value = error?.data?.detail || error?.message || 'Could not save visual timing and motion.'
      showError(saveError.value)
    }
  } finally {
    if (current()) saving.value = false
  }
}

watch(() => [slug.value, props.episodeId], () => { void load() }, { immediate: true })

defineExpose({ snapshotPreset, snapshotPresetForComparison, applyPreset })
</script>

<style scoped>
.visual-timing-motion { display: grid; gap: 18px; }
.vtm-header, .vtm-period-actions { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.vtm-intensity .active { background: var(--accent); color: var(--accent-contrast, #181818); border-color: var(--accent); }
.vtm-choice-row input { accent-color: var(--accent); }
.vtm-header h3 { margin: 0; }
.vtm-header p { margin: 4px 0 0; }
.vtm-plan-state, .vtm-scope-note, .vtm-eligibility, .vtm-crossing { margin: 0; }
.vtm-plan-state span { display: block; color: var(--text-muted); margin-top: 3px; }
.vtm-error, .vtm-crossing { color: var(--warning, #a35d00); }
.vtm-section { border: 0; border-top: 1px solid var(--border); margin: 0; padding: 16px 0 0; min-width: 0; }
.vtm-section legend { font-weight: 700; padding: 0 8px 0 0; }
.vtm-choice-row, .vtm-band, .vtm-period { display: flex; flex-wrap: wrap; align-items: end; gap: 12px; margin-top: 10px; }
.vtm-choice-row label, .vtm-scene-choice { display: inline-flex; align-items: center; gap: 6px; }
.vtm-band label, .vtm-period label, .vtm-opening { display: grid; gap: 5px; font-size: var(--font-sm); }
.vtm-band input, .vtm-period input, .vtm-opening input { width: 78px; }
.vtm-periods { display: grid; gap: 10px; margin-top: 12px; }
.vtm-period { border: 1px solid var(--border); border-radius: 8px; padding: 10px; }
.vtm-period-actions { align-items: center; }
.vtm-opening { margin-top: 12px; }
.vtm-scene-picker { display: grid; gap: 7px; margin-top: 12px; max-height: 190px; overflow: auto; }
.vtm-eligibility { margin-top: 12px; }
.vtm-crossing { margin-top: 6px; }
.vtm-intensity { display: grid; gap: 6px; margin-top: 16px; }
.vtm-intensity p { margin: 0; }
@media (max-width: 640px) { .vtm-header, .vtm-period-actions { align-items: stretch; flex-direction: column; } }
</style>
