/**
 * Focused RED contract for preset-authoritative NEW admissions.
 *
 * These tests intentionally stay at the existing exported seams and inspect
 * the two route bodies whose orchestration is not exported. They make no
 * network/provider calls and create no project or episode data.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  findActivePreset,
  parseBatchRequest,
  pipelineRepairFingerprint,
  resolveStepParams,
} from '../routes/pipeline.js'
import {
  findFreshActionJob,
  stampFreshGenerationAction,
} from '../lib/fresh-generation-action.js'
import { resolveScenePlanPromptCharCap, sanitizeScenePlanPresetData } from '../services/preset-authority.js'

const pipelineSource = readFileSync(fileURLToPath(new URL('../routes/pipeline.ts', import.meta.url)), 'utf8')
const scenePlanRouteSource = readFileSync(fileURLToPath(new URL('../routes/scene-plan.ts', import.meta.url)), 'utf8')
const jobQueueSource = readFileSync(fileURLToPath(new URL('../services/job-queue.ts', import.meta.url)), 'utf8')

const threePhasePacing = {
  mode: 'variable',
  min_sec: 1,
  max_sec: 5,
  periods: [
    { start_sec: 0, end_sec: 300, min_sec: 1, max_sec: 5 },
    { start_sec: 300, end_sec: 600, min_sec: 10, max_sec: 20 },
    { start_sec: 600, end_sec: null, min_sec: 20, max_sec: 30 },
  ],
}

test('Scene Plan preset boundary drops foreign selected scene ids while keeping portable scopes', () => {
  assert.deepEqual(sanitizeScenePlanPresetData({
    model: 'writer', motion_scope: { mode: 'selected', scene_ids: ['FOREIGN-SCENE'] }, motion_level: 3,
  }), { model: 'writer', motion_level: 3 })
  assert.deepEqual(sanitizeScenePlanPresetData({
    motion_scope: { mode: 'opening', end_sec: 12 }, motion_level: 2,
  }), { motion_scope: { mode: 'opening', end_sec: 12 }, motion_level: 2 })
})

test('a genuinely new admission never heals a stale or absent pointer to the newest surviving preset', () => {
  const stale = findActivePreset({
    scene_plan_presets: [
      { id: 'approved-old', name: 'Approved old', type: 'scene-plan' },
      { id: 'newest-neighbour', name: 'Newest neighbour', type: 'scene-plan' },
    ],
    'scene_plan_last_preset_scene-plan': 'retired-selected-id',
  }, 'scene_plan')
  assert.equal(stale.preset, null,
    'a retired/deleted selection blocks NEW admission instead of choosing the newest survivor')
  assert.match(stale.missingReason || '', /deleted|missing|selected/i)

  const absent = findActivePreset({
    scene_plan_presets: [
      { id: 'only-saved', name: 'Only saved', type: 'scene-plan' },
    ],
  }, 'scene_plan')
  assert.equal(absent.preset, null,
    'API callers that omit preset_ids use only an exact configured active pointer, never save order')
  assert.match(absent.missingReason || '', /No active preset/i)
})

test('an explicit retained legacy active pointer remains valid without inferring retirement from age or type', () => {
  const result = findActivePreset({
    script_presets: [{ id: 'retained-legacy', name: 'Owner approved legacy record' }],
    script_last_preset: 'retained-legacy',
  }, 'script-only')
  assert.equal(result.preset?.id, 'retained-legacy')
  assert.equal(result.missingReason, null)
})

test('an explicit preset id must resolve in the requested stage pool and current collection', () => {
  // The optional third argument is the bounded extension of the existing
  // resolver seam. Casting keeps this RED compilable before implementation.
  const resolve = findActivePreset as unknown as (
    config: Record<string, unknown>,
    step: 'scene_plan',
    explicitPresetId?: string,
  ) => ReturnType<typeof findActivePreset>
  const config = {
    scene_plan_presets: [
      { id: 'scene-active', name: 'Configured active', type: 'scene-plan' },
      // A restored, known production alternative may be older and untyped.
      // Current membership in this pool is its validity evidence.
      { id: 'scene-explicit', name: 'Original production alternative 2024' },
    ],
    'scene_plan_last_preset_scene-plan': 'scene-active',
    script_presets: [{ id: 'wrong-pool', name: 'Script', type: 'script' }],
  }

  assert.equal(resolve(config, 'scene_plan', 'scene-explicit').preset?.id, 'scene-explicit',
    'an explicit current ID is authoritative even when API automation did not mutate the active pointer')
  assert.equal(resolve(config, 'scene_plan', 'wrong-pool').preset, null,
    'an ID from another generation pool cannot borrow the configured active Scene Plan preset')
  assert.equal(resolve(config, 'scene_plan', 'deleted-scene-preset').preset, null,
    'a deleted explicit ID cannot fall back to the configured active preset')
})

test('Pipeline request parsing accepts optional exact preset ids without breaking API-only active-pointer callers', () => {
  const explicit = parseBatchRequest({
    episode_ids: ['EP1001'],
    steps: ['scene_plan'],
    preset_ids: { scene_plan: 'scene-explicit' },
  }) as ReturnType<typeof parseBatchRequest> & { presetIds?: Record<string, string> }
  assert.deepEqual(explicit.presetIds, { scene_plan: 'scene-explicit' })

  const apiOnly = parseBatchRequest({
    episode_ids: ['EP1001'],
    steps: ['scene_plan'],
  }) as ReturnType<typeof parseBatchRequest> & { presetIds?: Record<string, string> }
  assert.deepEqual(apiOnly.presetIds ?? {}, {},
    'omitting preset_ids remains supported and delegates to the exact configured active pointer')
})

test('present malformed preset identities are rejected instead of becoming active-pointer omission', () => {
  assert.match(parseBatchRequest({ preset_ids: null }).presetIdError || '', /preset_ids/i)
  assert.match(parseBatchRequest({ preset_ids: [] }).presetIdError || '', /preset_ids/i)
  assert.match(parseBatchRequest({ preset_ids: { scene_plan: '' } }).presetIdError || '', /scene_plan/i)
  assert.equal(parseBatchRequest({}).presetIdError, null)
  assert.equal(parseBatchRequest({ preset_ids: {} }).presetIdError, null)
})

test('Pipeline Scene Plan params preserve every reusable preset choice and reject legacy episode/style leakage', () => {
  const params = resolveStepParams('scene_plan', 'EP1002', 'Current episode', {
    id: 'scene-authority',
    name: 'Approved Scene Plan',
    type: 'scene-plan',
    data: {
      model: 'pool::approved-writing',
      use_research: true,
      prompt_pack_size: 40,
      prompt_max_tokens: 'auto',
      intended_image_model: 'studio-hub::approved-image',
      prompt_char_cap: 'auto',
      creative_direction: { profile: 'narrative', intensity: 3, strategies: ['literal-narrative'] },
      reusable_guidance: 'Keep locations geographically coherent.',
      avoid_legible_text: true,
      pacing: threePhasePacing,
      motion_scope: { mode: 'all' },
      motion_level: 3,
      custom_instructions: 'FOREIGN EPISODE TEXT FROM A LEGACY RECORD',
      style_prompt: 'RETIRED PER-PLAN STYLE',
    },
  })

  assert.equal(params.model, 'pool::approved-writing')
  assert.equal(params.custom_instructions, 'Keep locations geographically coherent.',
    'Pipeline feeds the reusable guidance through the executor input used by manual Scene Plan')
  assert.equal(params.avoid_legible_text, true)
  assert.equal(params.intended_image_model, 'studio-hub::approved-image',
    'the selected image product travels to NEW-admission live capability resolution')
  assert.equal(params.prompt_char_cap, 'auto',
    'the pure preset mapper preserves the reusable selection; NEW admission resolves it against the live image catalogue')
  assert.deepEqual(params.pacing, threePhasePacing)
  assert.deepEqual(params.motion_scope, { mode: 'all' })
  assert.equal(params.motion_level, 3)
  assert.equal(params.style_prompt, undefined,
    'Character Sheet remains the style authority; a legacy Scene Plan style is inert')
  assert.doesNotMatch(String(params.custom_instructions), /FOREIGN EPISODE TEXT/)

  const legacyMissing = resolveStepParams('scene_plan', 'EP1002', 'Current episode', {
    id: 'retained-minimal', name: 'Retained minimal record', data: { model: 'pool::approved-writing' },
  })
  assert.equal(legacyMissing.custom_instructions, undefined,
    'a retained record with no reusable guidance stays neutral instead of borrowing form state')
  assert.equal(legacyMissing.pacing, undefined,
    'missing reusable pacing is not healed from another preset')
})

test('new Scene Plan admission resolves the saved selection against the live image capability', () => {
  const catalog = [{
    id: 'current-image-product',
    legacy_ids: ['studio-hub::approved-image'],
    max_prompt_characters: 4_800,
  }]
  assert.equal(resolveScenePlanPromptCharCap({
    intended_image_model: 'studio-hub::approved-image', prompt_char_cap: 'auto',
  }, catalog), 4_800)
  assert.equal(resolveScenePlanPromptCharCap({
    intended_image_model: 'studio-hub::approved-image', prompt_char_cap: 8_000,
  }, catalog), 4_800, 'a saved custom value cannot exceed the current published capability')
  assert.throws(() => resolveScenePlanPromptCharCap({
    intended_image_model: 'deleted-image-product', prompt_char_cap: 'auto',
  }, catalog), /current image catalogue/i)
})

test('the active Scene Plan preset outranks old episode pacing while episode-owned selections stay separate', () => {
  const currentEpisode = {
    pacing: { mode: 'live', min_sec: 20, max_sec: 30 },
    motion_scope: { mode: 'selected', scene_ids: ['scene-episode-only'] },
    motion_scene_ids: ['scene-episode-only'],
    use_episode_sheet: true,
  }
  const presetParams = resolveStepParams('scene_plan', 'EP1003', 'Pacing', {
    id: 'scene-paced', name: 'Approved pacing', type: 'scene-plan',
    data: { model: 'pool::approved-writing', pacing: threePhasePacing, motion_level: 4 },
  })
  const accepted = { ...structuredClone(currentEpisode), ...structuredClone(presetParams) }
  assert.deepEqual(accepted.pacing, threePhasePacing,
    'portable preset pacing owns a genuinely new Scene Plan admission')
  assert.deepEqual(accepted.motion_scene_ids, ['scene-episode-only'],
    'the exact current-episode selection remains outside the reusable preset')
  assert.equal(accepted.use_episode_sheet, true)

  const runBatch = pipelineSource.slice(
    pipelineSource.indexOf('async function runBatch'),
    pipelineSource.indexOf("router.post('/projects/:slug/pipeline/run-batch'"),
  )
  assert.doesNotMatch(
    runBatch,
    /link\.params\s*=\s*\{\s*\.\.\.link\.params,\s*\.\.\.structuredClone\(visualSettings\)\s*\}/s,
    'the final chain overlay must not replace approved preset pacing with stale episode pacing',
  )
})

test('accepted Pipeline UUID/body adoption is decided before current preset or preflight state', () => {
  const runBatch = pipelineSource.slice(
    pipelineSource.indexOf('async function runBatch'),
    pipelineSource.indexOf("router.post('/projects/:slug/pipeline/run-batch'"),
  )
  const acceptedLookup = runBatch.indexOf('existingActionJobs')
  assert.ok(acceptedLookup >= 0, 'the route has an accepted-action lookup')
  assert.ok(acceptedLookup < runBatch.indexOf('preflightBatch('),
    'accepted UUID lookup precedes current preset and episode preflight')
})

test('manual Scene Plan uses the same accepted-action-first boundary and exact preset identity', () => {
  const route = scenePlanRouteSource.slice(
    scenePlanRouteSource.indexOf("router.post('/projects/:slug/scene-plan/:episodeId/run'"),
    scenePlanRouteSource.indexOf("router.post('/projects/:slug/scene-plan/:episodeId/replan-scene'"),
  )
  assert.match(route, /operation_id/,
    'manual Scene Plan carries a stable action UUID so an unknown response can be adopted')
  assert.match(route, /preset_id/,
    'manual Scene Plan names the exact selected preset for a genuinely new admission')
  const acceptedLookup = Math.max(route.indexOf('freshActionMatch'), route.indexOf('findFreshActionJob'))
  assert.ok(acceptedLookup >= 0, 'manual Scene Plan looks for the accepted UUID')
  assert.ok(acceptedLookup < route.indexOf('requireScenePlanGenStudioModel'),
    'accepted manual work is adopted before today\'s model catalogue is consulted')
})

test('a saved accepted snapshot remains authoritative after preset and catalogue mutation', () => {
  const operationId = '10040000-0000-4000-8000-000000000004'
  const rawRequest = {
    episode_ids: ['EP1004'],
    steps: ['scene_plan'],
    preset_ids: { scene_plan: 'scene-retired-after-acceptance' },
    force: true,
  }
  const acceptedParams = stampFreshGenerationAction({
    ...rawRequest,
    resolved_preset: {
      id: 'scene-retired-after-acceptance',
      content_fingerprint: 'accepted-fingerprint',
      data: { model: 'accepted-model', pacing: threePhasePacing },
    },
  }, operationId)
  const acceptedJob = {
    job_id: 'accepted-job', project_slug: 'mock-project', episode_id: 'EP1004',
    type: 'scene_plan_run', status: 'queued', title: 'Accepted', output_lines: [],
    created_at: '2026-10-14T00:00:00.000Z', params: acceptedParams,
  } as any
  const before = structuredClone(acceptedJob.params)

  // These represent state after production retirement/catalogue refresh. The
  // accepted lookup must not read either to adopt the historical operation.
  const currentConfig = { scene_plan_presets: [], 'scene_plan_last_preset_scene-plan': '' }
  const currentCatalogue: unknown[] = []
  void currentConfig
  void currentCatalogue

  const adopted = findFreshActionJob([acceptedJob], operationId)
  assert.equal(adopted?.job_id, 'accepted-job')
  assert.deepEqual(adopted?.params, before)
  assert.deepEqual(adopted?.params.resolved_preset.data.pacing, threePhasePacing)
  assert.equal(pipelineRepairFingerprint(rawRequest), pipelineRepairFingerprint(structuredClone(rawRequest)),
    'the raw submitted body identity is independent of later config/catalogue state')

  const handoff = jobQueueSource.slice(
    jobQueueSource.indexOf('async function dispatchChainLink'),
    jobQueueSource.indexOf('async function joinDuplicateChainLink'),
  )
  assert.match(handoff, /structuredClone\(nextStep\.params \|\| \{\}\)/,
    'existing chain handoff retains the accepted resolved snapshot instead of re-resolving a preset')
})
