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
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

import { DEFAULT_EXCLUDE_KEYS, usePresets } from '../composables/usePresets.js'
import { CONTINUITY_PRESET_EXCLUDE_KEYS } from '../composables/useContinuityConfig.js'

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
