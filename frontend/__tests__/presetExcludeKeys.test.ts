/**
 * Preset exclusions: episode-specific state must not ride in a preset — v1.4.205
 *
 * AGENTS.md §5. The trap this file exists for: `usePresets` does
 *
 *     const excludeKeys = opts.excludeKeys ?? DEFAULT_EXCLUDE_KEYS
 *
 * so `excludeKeys` REPLACES the list rather than extending it. A page that
 * passes its own list silently starts snapshotting `episode_id` again — the very
 * leak §4 is about — and the only workaround until now was for each caller to
 * re-type the four identity strings, which drifts.
 *
 * OWNER DECISIONS, 2026-09-20:
 *   #10  keep `character_ids` (cast is channel/series-level and identical across
 *        episodes); exclude `manual_guidance`; exclude `force` unconditionally,
 *        because a restored `force: true` silently overwrites existing work.
 *   #9   exclude Scene Plan `custom_instructions`: an episode's written
 *        guidance stays with that episode.
 *
 * OWNER DECISION, 2026-09-22 (X-06): the reusable Scene Plan guidance box is
 * preset-only. Its text MUST be captured by a preset (that is its only durable
 * home — it is never written to project config) and must therefore stay out of
 * `excludeKeys`, while `custom_instructions` remains excluded.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

import { DEFAULT_EXCLUDE_KEYS, usePresets } from '../composables/usePresets.js'
import { CONTINUITY_PRESET_EXCLUDE_KEYS } from '../composables/useContinuityConfig.js'
import {
  SCENE_REVIEW_PRESET_KEYS,
  sceneReviewPresetApply,
  sceneReviewPresetSnapshot,
  type SceneReviewPresetData,
  type SceneReviewPresetForm,
} from '../utils/scene-review-preset.js'

const sceneReviewSource = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/scene-review.vue', import.meta.url)),
  'utf8',
)

const IDENTITY_KEYS = ['episode_id', 'episodeId', 'episode', 'title']

const scriptsSource = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/scripts.vue', import.meta.url)),
  'utf8',
)

const scenePlanSource = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/scene-plan.vue', import.meta.url)),
  'utf8',
)

/**
 * The Scene Plan page's ACTUAL `excludeKeys` expression, evaluated.
 *
 * Read out of the page rather than restated here: a test that re-typed the list
 * would only prove the test and the page agree on a string. Whatever the page
 * declares is then driven through the real composable below, so these tests
 * assert what lands on disk and what reaches the form.
 */
function scenePlanExcludeKeys(): string[] {
  const declared = scenePlanSource.match(/excludeKeys:\s*(\[[^\]]*\])/)
  assert.ok(declared, 'scene-plan.vue must declare its preset exclusions')
  return new Function('DEFAULT_EXCLUDE_KEYS', `return ${declared![1]}`)(DEFAULT_EXCLUDE_KEYS)
}

describe('preset exclude keys', () => {
  test('the shared default carries every per-episode identifier', () => {
    for (const key of IDENTITY_KEYS) {
      assert.ok(DEFAULT_EXCLUDE_KEYS.includes(key), `${key} must never be captured by a preset`)
    }
  })

  test('a caller with its own list still carries the identifiers (the trap)', () => {
    // Continuity is the existing caller. It used to RE-TYPE these four strings
    // with a comment apologising for it; it now spreads the exported list, so
    // the two cannot drift apart.
    for (const key of IDENTITY_KEYS) {
      assert.ok(
        CONTINUITY_PRESET_EXCLUDE_KEYS.includes(key),
        `${key} was dropped: a custom excludeKeys list REPLACES the default, so `
        + 'it must spread DEFAULT_EXCLUDE_KEYS rather than restate it',
      )
    }
  })
})

describe('the script preset', () => {
  test('excludes force and manual_guidance but keeps character_ids', () => {
    const controller = scriptsSource.match(/usePresets<any>\(\{[\s\S]*?\n\}\)/)
    assert.ok(controller, 'expected the script preset controller')
    const body = controller[0]

    assert.match(body, /excludeKeys:/, 'the preset must declare its exclusions')
    assert.match(body, /'force'/, 'a restored force:true would overwrite existing work')
    assert.match(body, /'manual_guidance'/, 'the episode\'s written direction must not ride along')
    assert.doesNotMatch(body, /'character_ids'/, 'the cast is kept — owner decision #10')
    assert.match(
      body,
      /\.\.\.DEFAULT_EXCLUDE_KEYS/,
      'the spread is load-bearing: excludeKeys replaces the default list',
    )
  })
})

// ── The Scene Plan preset (owner decision #9) ───────────────────────────────
//
// The page's OWN exclusion expression is driven through the REAL composable,
// with `$fetch` backed by an in-memory config exactly as `usePresets.test.ts`
// does. Asserting the disk record and the live form — not the source text — is
// what proves the guidance actually stops travelling.

const configStore: Record<string, any> = {}

;(globalThis as any).$fetch = async (url: string, options: any = {}) => {
  const match = url.match(/^\/api\/projects\/([^/]+)\/settings\/config$/)
  if (!match) throw new Error(`unexpected fetch: ${url}`)
  const slug = match[1]
  if (!configStore[slug]) configStore[slug] = {}
  if (!options.method || options.method === 'GET') return { ...configStore[slug] }
  if (options.method === 'PUT') {
    Object.assign(configStore[slug], JSON.parse(JSON.stringify(options.body)))
    return { ok: true }
  }
  throw new Error(`unexpected method: ${options.method}`)
}

function scenePlanController(slug: string, snapshot: () => Record<string, any>, apply: (data: any) => void) {
  return usePresets<any>({
    slug,
    configKey: 'scene_plan',
    presetType: 'scene-plan',
    autoApplyOnLoad: false,
    excludeKeys: scenePlanExcludeKeys(),
    snapshot,
    apply,
  })
}

describe('the scene plan preset', () => {
  test('the page spreads the shared default and names the episode guidance', () => {
    const keys = scenePlanExcludeKeys()
    for (const key of IDENTITY_KEYS) {
      assert.ok(keys.includes(key), `${key} was dropped from the Scene Plan preset exclusions`)
    }
    assert.ok(keys.includes('custom_instructions'), 'an episode\'s written guidance must not ride along')
    assert.ok(!keys.includes('character_ids'), 'the cast is kept — owner decision #10')
    // X-06 (owner decision 2026-09-22) — the reusable box IS the preset payload.
    // Excluding it would strip it on write AND on read, and it has no other
    // durable home: it is never written to project config.
    assert.ok(!keys.includes('reusable_guidance'), 'reusable guidance must travel with the preset')
    assert.match(
      scenePlanSource,
      /reusable_guidance: form\.value\.reusable_guidance,/,
      'the page’s own snapshot must capture the reusable box — the round-trip '
      + 'cases below supply their own snapshot and would not notice its absence',
    )
  })

  test('X-06: the reusable guidance is captured and the episode guidance still is not', async () => {
    const presets = scenePlanController('scene-plan-x06-save', () => ({
      model: 'chosen-model',
      reusable_guidance: 'one subject per scene; never render legible text',
      custom_instructions: 'keep the protagonist off-centre',
      episode_id: 'EP0007',
    }), () => undefined)

    await presets.saveAs('Channel rule')
    const stored = configStore['scene-plan-x06-save'].scene_plan_presets[0].data

    assert.equal(stored.reusable_guidance, 'one subject per scene; never render legible text',
      'the reusable text must be in the preset — that is its only durable home')
    assert.equal('custom_instructions' in stored, false,
      'the episode-only box must still be excluded (owner decision #9)')
    assert.equal('episode_id' in stored, false, 'the §4 identity leak must not return')
  })

  test('X-06: applying a preset restores its reusable guidance and never touches the episode box', async () => {
    configStore['scene-plan-x06-apply'] = {
      scene_plan_presets: [{
        id: 'x06-1',
        name: 'Channel rule',
        type: 'scene-plan',
        data: {
          model: 'old-model',
          reusable_guidance: 'the preset’s standing rule',
          custom_instructions: 'the previous episode’s guidance',
        },
      }],
      'scene_plan_last_preset_scene-plan': 'x06-1',
    }
    const live: Record<string, any> = {
      model: 'live-model',
      reusable_guidance: 'text the customer typed and has not saved',
      custom_instructions: 'this episode’s own guidance',
    }
    const presets = usePresets<any>({
      slug: 'scene-plan-x06-apply',
      configKey: 'scene_plan',
      presetType: 'scene-plan',
      excludeKeys: scenePlanExcludeKeys(),
      snapshot: () => ({}),
      apply: data => Object.assign(live, data),
    })

    await presets.load()

    assert.equal(live.reusable_guidance, 'the preset’s standing rule',
      'applying a preset is the deliberate act that brings the reusable rule in')
    assert.equal(live.custom_instructions, 'this episode’s own guidance',
      'the episode box must be neither replaced nor blanked by a preset')
  })

  test('X-06: a preset saved before the reusable field existed does not blank the live text', async () => {
    configStore['scene-plan-x06-legacy'] = {
      scene_plan_presets: [{
        id: 'legacy-no-guidance',
        name: 'Old look',
        type: 'scene-plan',
        data: { model: 'old-model' },
      }],
      'scene_plan_last_preset_scene-plan': 'legacy-no-guidance',
    }
    const live: Record<string, any> = {
      model: 'live-model',
      reusable_guidance: 'text the customer typed and has not saved',
    }
    const presets = usePresets<any>({
      slug: 'scene-plan-x06-legacy',
      configKey: 'scene_plan',
      presetType: 'scene-plan',
      excludeKeys: scenePlanExcludeKeys(),
      snapshot: () => ({}),
      apply: data => Object.assign(live, data),
    })

    await presets.load()

    assert.equal(live.reusable_guidance, 'text the customer typed and has not saved',
      'a preset that never stored the field must leave the live value alone')
  })

  test('saving writes the reusable plan but not the episode guidance or identity', async () => {
    const presets = scenePlanController('scene-plan-save', () => ({
      model: 'chosen-model',
      prompt_pack_size: 50,
      episode_id: 'EP0007',
      title: 'A stale title',
      custom_instructions: 'keep the protagonist off-centre',
      character_ids: ['cast-1'],
    }), () => undefined)

    await presets.saveAs('My look')
    const stored = configStore['scene-plan-save'].scene_plan_presets[0].data

    assert.equal(stored.model, 'chosen-model', 'reusable settings still travel')
    assert.deepEqual(stored.character_ids, ['cast-1'], 'the cast is kept — owner decision #10')
    assert.equal('custom_instructions' in stored, false, 'the preset must not capture one episode\'s guidance')
    assert.equal('episode_id' in stored, false, 'the §4 identity leak must not return')
    assert.equal('title' in stored, false, 'the §4 identity leak must not return')
  })

  test('applying a preset saved before the exclusion leaves the live guidance untouched', async () => {
    // A preset written while `custom_instructions` was still captured. Stored
    // presets are never rewritten (AGENTS.md §5), so the read side must strip.
    configStore['scene-plan-apply'] = {
      scene_plan_presets: [{
        id: 'legacy-1',
        name: 'Old look',
        type: 'scene-plan',
        data: {
          model: 'old-model',
          custom_instructions: 'the previous episode\'s guidance',
          character_ids: ['cast-9'],
        },
      }],
      'scene_plan_last_preset_scene-plan': 'legacy-1',
    }
    const live: Record<string, any> = {
      model: 'live-model',
      custom_instructions: 'this episode\'s own guidance',
      character_ids: ['cast-1'],
    }
    const presets = usePresets<any>({
      slug: 'scene-plan-apply',
      configKey: 'scene_plan',
      presetType: 'scene-plan',
      excludeKeys: scenePlanExcludeKeys(),
      snapshot: () => ({}),
      apply: data => Object.assign(live, data),
    })

    await presets.load()

    assert.equal(live.model, 'old-model', 'reusable settings still restore')
    assert.deepEqual(live.character_ids, ['cast-9'], 'the cast travels')
    assert.equal(
      live.custom_instructions,
      'this episode\'s own guidance',
      'the live episode\'s guidance must be neither replaced nor blanked',
    )
  })
})

// ── The Scene Review preset (plan §4.4, decision 2026-10-26) ─────────────────
//
// The "Reference to Image" character selection is episode state: it names
// specific characters of one episode, which AGENTS.md §5 excludes. It is never
// SNAPSHOTTED and never APPLIED — not even by a preset body hand-edited to
// carry it. The page's real snapshot/apply functions live in
// `utils/scene-review-preset.ts` and are driven through the real composable
// here, so this asserts what lands on disk and what reaches the live form.

interface SceneReviewLiveState {
  form: SceneReviewPresetForm
  auto_approve_generated: boolean
  referenceCharacterIds: string[]
}

function sceneReviewController(slug: string, live: SceneReviewLiveState) {
  return usePresets<SceneReviewPresetData>({
    slug,
    configKey: 'scene_review_genstudio',
    presetType: 'scene-review',
    snapshot: () => sceneReviewPresetSnapshot({
      ...live.form,
      auto_approve_generated: live.auto_approve_generated,
    }),
    apply: data => {
      const next = sceneReviewPresetApply(live.form, data as Record<string, unknown>)
      live.form = { model: next.model, aspect_ratio: next.aspect_ratio, seed: next.seed }
      live.auto_approve_generated = next.auto_approve_generated
    },
  })
}

describe('the scene review preset', () => {
  test('the page uses the shared four-field boundary', () => {
    // The page must not carry its own snapshot/apply: that is how an episode
    // field would come back without touching this test.
    assert.match(sceneReviewSource, /snapshot: \(\) => sceneReviewPresetSnapshot\(\{/)
    assert.match(sceneReviewSource, /const next = sceneReviewPresetApply\(/)
    assert.deepEqual([...SCENE_REVIEW_PRESET_KEYS], ['model', 'aspect_ratio', 'seed', 'auto_approve_generated'])
  })

  test('a round trip carries exactly the reusable settings — no character id, no reference path', async () => {
    const live: SceneReviewLiveState = {
      form: { model: 'reference-model', aspect_ratio: '16:9', seed: 42 },
      auto_approve_generated: true,
      referenceCharacterIds: ['mara', 'kiri'],
    }
    const presets = sceneReviewController('scene-review-reference-save', live)
    await presets.saveAs('With references')
    const stored = configStore['scene-review-reference-save'].scene_review_genstudio_presets[0].data

    assert.deepEqual(Object.keys(stored).sort(), [...SCENE_REVIEW_PRESET_KEYS].sort(),
      'the preset body holds exactly the four reusable settings')
    assert.equal(JSON.stringify(stored).includes('mara'), false, 'no character id may ride along')
    assert.equal('reference_character_ids' in stored, false, 'no reference selection may ride along')
    assert.equal('reference_paths' in stored, false, 'no reference path may ride along')
  })

  test('applying a hand-edited preset naming a reference model leaves the selection untouched', async () => {
    const live: SceneReviewLiveState = {
      form: { model: 'text-model', aspect_ratio: '1:1', seed: '' },
      auto_approve_generated: true,
      referenceCharacterIds: ['mara'],
    }
    configStore['scene-review-reference-apply'] = {
      scene_review_genstudio_presets: [{
        id: 'sneaky-preset',
        name: 'Hand-edited',
        type: 'scene-review',
        data: {
          model: 'reference-model',
          aspect_ratio: '16:9',
          // Written by hand into project config: neither may be applied.
          reference_character_ids: ['kiri'],
          reference_paths: ['/Users/owner/elsewhere/portrait.png'],
        },
      }],
      'scene_review_genstudio_last_preset_scene-review': 'sneaky-preset',
    }

    await sceneReviewController('scene-review-reference-apply', live).load()

    assert.equal(live.form.model, 'reference-model', 'the reusable model choice is restored')
    assert.equal(live.form.aspect_ratio, '16:9')
    assert.deepEqual(live.referenceCharacterIds, ['mara'],
      'the episode\'s own selection is neither replaced nor blanked by a preset')
    assert.equal(Object.keys(live.form).includes('reference_character_ids' as never), false)
    assert.equal(Object.keys(live.form).includes('reference_paths' as never), false)
  })
})
