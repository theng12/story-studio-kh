/**
 * A Scene Plan preset that names an image model the live catalogue no longer
 * publishes must still APPLY — and must never reach a generation.
 *
 * Production, 2026-10-27: four `terranash-sleep-stories` Scene Plan presets
 * ("Haiku 5.5", "Gemini Free", "GPT 6 Luna", "Gemma 4 Local") all carry
 * `intended_image_model: 'flux-2-klein'`, a bare legacy id. Selecting one and
 * pressing Build ended in a **409 from the prompt-cap resolver**, not a plain
 * sentence the customer could act on.
 *
 * The fix has two halves, and this file pins both:
 *
 *   1. THE PAGE drops the dead id on apply and says so, once, in the same
 *      "no longer available — choose another" wording the rest of the app uses.
 *      Every other field of the preset still applies: the model is one choice
 *      among many, and refusing the whole apply would make the preset unusable.
 *   2. THE SERVER no longer refuses. An unresolved intended model leaves the
 *      preset's own ceiling unclamped and reports `unresolved`, so a queued job
 *      or a cold catalogue degrades instead of 409-ing.
 *
 * The id is NOT guessed at from its name. `flux-2-klein` resolves only because
 * the owner published that exact replacement (`contracts/retired-image-models`),
 * and the replacement must itself be in the live catalogue — a replacement that
 * has been retired in turn resolves to nothing rather than to something else.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

import { resolveRetiredImageModelId } from '../utils/genstudio-image-model-selection.js'
import { resolveSavedImageModelId } from '../utils/genstudio-image-model-selection.js'
import { resolveScenePlanPromptCharCapDetail } from '../../electron/server/services/preset-authority.js'

/** The live catalogue as the mini reported it on 2026-10-27 (ids only). */
const LIVE = [
  { id: 'studio-hub::AITRADER/FLUX2-klein-4B-mlx-4bit', max_prompt_characters: 2_400 },
  { id: 'studio-hub::mflux-community/qwen-image-2-1-turbo-mflux-q4', max_prompt_characters: 3_000 },
]
const find = (id: string) => LIVE.find(model => model.id === id)

/** The exact stored body, copied from the real preset on the mini. */
const STORED_BODY = {
  avoid_legible_text: true,
  creative_direction: { profile: 'narrative', intensity: 2, strategies: ['literal-narrative'] },
  detail_level: 4,
  intended_image_model: 'flux-2-klein',
  model: 'chat-model-from-preset',
  motion_level: 2,
  motion_scope: { mode: 'all' },
  pacing: { mode: 'uniform', min_sec: 20, max_sec: 30 },
  prompt_char_cap: 'auto',
  prompt_max_tokens: 'auto',
  prompt_pack_size: 'auto',
  reusable_guidance: 'one subject per scene',
  use_research: true,
}

describe('the owner-published retired image id', () => {
  test('resolves to the product that replaced it, case- and space-insensitively', () => {
    assert.equal(resolveRetiredImageModelId('flux-2-klein'), 'studio-hub::AITRADER/FLUX2-klein-4B-mlx-4bit')
    assert.equal(resolveRetiredImageModelId('  FLUX-2-KLEIN '), 'studio-hub::AITRADER/FLUX2-klein-4B-mlx-4bit')
  })

  test('anything else is unknown, not a near match', () => {
    for (const value of ['flux-2-pro', 'klein', 'flux2-klein', '', null, undefined, 42]) {
      assert.equal(resolveRetiredImageModelId(value), null, `${String(value)} must not be mapped to a product`)
    }
  })
})

describe('applying the real terranash preset', () => {
  test('every other field applies; the dead model is dropped, not carried', () => {
    const resolved = resolveSavedImageModelId(STORED_BODY.intended_image_model, find, resolveRetiredImageModelId)

    assert.equal(resolved, 'studio-hub::AITRADER/FLUX2-klein-4B-mlx-4bit',
      'the owner-published replacement IS in the live catalogue, so it is selected')
    assert.notEqual(resolved, STORED_BODY.intended_image_model, 'the bare legacy id must never reach the form')

    // Nothing else in the preset is disturbed by the model resolution.
    assert.equal(STORED_BODY.reusable_guidance, 'one subject per scene')
    assert.equal(STORED_BODY.use_research, true)
    assert.deepEqual(STORED_BODY.pacing, { mode: 'uniform', min_sec: 20, max_sec: 30 })
  })

  test('a replacement the catalogue has itself retired selects nothing', () => {
    const emptyCatalogue = () => undefined
    assert.equal(
      resolveSavedImageModelId('flux-2-klein', emptyCatalogue, resolveRetiredImageModelId),
      '',
      'no live product answers to the replacement — select nothing rather than a dead id',
    )
  })

  test('an id with no owner-published replacement selects nothing', () => {
    assert.equal(resolveSavedImageModelId('some-vendor/unknown-model', find, resolveRetiredImageModelId), '')
  })

  test('a live id is used as-is, with no help from the retired table', () => {
    const liveId = 'studio-hub::mflux-community/qwen-image-2-1-turbo-mflux-q4'
    assert.equal(
      resolveSavedImageModelId(liveId, find, () => { throw new Error('the table must not be consulted') }),
      liveId,
      'the catalogue answers first; a table hit can never shadow a live product',
    )
  })

  test('a preset that named no model reports no loss', () => {
    assert.equal(resolveSavedImageModelId('', find, resolveRetiredImageModelId), '')
  })
})

describe('the server never turns a dead model into a refusal', () => {
  test('the preset’s own ceiling survives, unclamped, and the id is reported', () => {
    const detail = resolveScenePlanPromptCharCapDetail(
      { intended_image_model: 'flux-2-klein', prompt_char_cap: 2_000 }, LIVE,
    )
    assert.equal(detail.cap, 2_000)
    assert.equal(detail.publishedCap, undefined, 'nothing was published for the id as stored')
    assert.equal(detail.unresolved, 'flux-2-klein')
  })

  test('auto against an unknown model means no ceiling, not a crash', () => {
    const detail = resolveScenePlanPromptCharCapDetail(
      { intended_image_model: 'flux-2-klein', prompt_char_cap: 'auto' }, LIVE,
    )
    assert.equal(detail.cap, undefined)
    assert.equal(detail.unresolved, 'flux-2-klein')
  })

  test('a resolved model still clamps, so the relaxation did not weaken it', () => {
    const detail = resolveScenePlanPromptCharCapDetail(
      { intended_image_model: 'studio-hub::AITRADER/FLUX2-klein-4B-mlx-4bit', prompt_char_cap: 9_000 }, LIVE,
    )
    assert.equal(detail.cap, 2_400, 'a saved custom value cannot exceed the published capability')
    assert.equal(detail.unresolved, undefined)
  })
})

describe('the page and the route carry the fix', () => {
  const page = readFileSync(
    fileURLToPath(new URL('../pages/projects/[slug]/scene-plan.vue', import.meta.url)), 'utf8',
  )
  const route = readFileSync(
    fileURLToPath(new URL('../../electron/server/routes/scene-plan.ts', import.meta.url)), 'utf8',
  )

  test('apply resolves the saved id instead of assigning it blindly', () => {
    assert.match(page, /const resolvedIntended = resolveSavedImageModelId\(/)
    assert.match(page, /form\.value\.intended_image_model = resolvedIntended/)
    assert.doesNotMatch(page, /form\.value\.intended_image_model = typeof activeData\.intended_image_model === 'string'\s*\n\s*\? activeData\.intended_image_model/,
      'the raw saved id must not be assigned directly')
  })

  test('the sentence is shown once, on an explicit Apply only', () => {
    assert.match(page, /This preset names an image model the Gateway no longer offers, so none is selected\./)
    // Recorded by applyPromptPreset, SHOWN by the Apply handler: the same
    // function also runs on mount, and a page that just loaded is not a
    // customer who clicked Apply.
    assert.match(page, /promptPresetModelNotice = resolvedIntended \|\| !savedIntended/)
    assert.match(page, /visualPresetNotice\.value = promptPresetModelNotice/)
  })

  test('the route no longer answers 409 for an unresolved intended model', () => {
    // Scoped to the cap-resolution block: other 409s in this route are about
    // genuinely-refused requests and must stay.
    const start = route.indexOf('let promptCharCap = parsePromptCharCap')
    const block = route.slice(start, start + 900)
    assert.ok(start > 0, 'expected the cap-resolution block')
    assert.match(block, /promptCharCap = resolveScenePlanPromptCharCap\(presetData, await listImageModels\(apiKey\)\)/)
    assert.doesNotMatch(block, /catch \(error: any\) \{ return res\.status\(409\)/,
      'the prompt-cap resolver must not be able to fail a generation')
  })
})
