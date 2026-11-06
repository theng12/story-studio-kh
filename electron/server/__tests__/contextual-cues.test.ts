import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  assertContextualCueReadiness,
  autoApproveEligibleCues,
  resolveRenderableContextualCues,
  contextualCueProgressFingerprint,
  contextualCueProgressPath,
  isReleasedContextualCueBackpressure,
  normalizeContextualCueConfig,
  normalizeContextualCueProposalSettings,
  normalizeContextualCueTemplate,
  resolveContextualCueBatchSize,
  resolveContextualCueBatchSizeForOutput,
  readContextualCueProgress,
  removeContextualCueProgress,
  validateContextualCueTimeline,
  writeContextualCueProgress,
} from '../services/contextual-cues.js'
import { UpdateConfigSchema } from '../contracts/index.js'
import { GenStudioChatTerminalFailureError } from '../lib/genstudio-client.js'

const plan = {
  generated_at: '2026-07-26T00:00:00.000Z',
  scenes: [
    { id: 'scene-1', scene_index: 1, start_sec: 0, end_sec: 6, transcript_segment: '', visual_prompt: '' },
    { id: 'scene-2', scene_index: 2, start_sec: 6, end_sec: 12, transcript_segment: '', visual_prompt: '' },
  ],
} as any

/**
 * A plan with one long scene, so a cue can legitimately be held past the ~12s
 * advisory without falling outside the scene it belongs to. Both rules are
 * live at once and this keeps them from being confused for each other.
 */
const planWithLongScene = {
  generated_at: '2026-07-26T00:00:00.000Z',
  scenes: [
    { id: 'scene-3', scene_index: 1, start_sec: 12, end_sec: 30, transcript_segment: '', visual_prompt: '' },
  ],
} as any

function cue(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cue-scene-1', scene_id: 'scene-1', start_sec: 0.2, end_sec: 3.5,
    title: 'Berlin', subtitle: '1919', kind: 'location_date', placement: 'top-right',
    template: 'documentary-label', entrance: 'fade', exit: 'dissolve', status: 'approved',
    created_at: '2026-07-26T00:00:00.000Z', updated_at: '2026-07-26T00:00:00.000Z', ...overrides,
  } as any
}

describe('Contextual Cues contract', () => {
  test('uses the published structured-item cap only as a ceiling and preserves resumable batch identity', () => {
    assert.equal(resolveContextualCueBatchSize(null), 50, 'unknown keeps the measured Story policy')
    assert.equal(resolveContextualCueBatchSize(20), 20, 'a smaller published cap is enforced')
    assert.equal(resolveContextualCueBatchSize(80), 50, 'a maximum is not a recommendation to grow the batch')
    assert.equal(resolveContextualCueBatchSize(20, 40), 20, 'a newly lower live cap wins over stale saved work')
    assert.equal(resolveContextualCueBatchSize(80, 40), 40, 'an interrupted run keeps its saved grouping when still legal')
  })

  /**
   * v1.4.374 — the batch is sized from the OUTPUT allowance too, not only from
   * the structured-item cap.
   *
   * A 68-scene episode failed three times with the Gateway's "answer stopped
   * early (length)": the batch was sized by `max_structured_items_per_request`
   * alone, which says how many ITEMS a product accepts, not how long its ANSWER
   * may be. Fifty cues of the shape the output contract allows is far more text
   * than the output allowance the request asked for, so the provider cut the
   * answer off mid-JSON.
   *
   * Every figure here is the product's OWN published allowance. Nothing in
   * this function is a number Story Studio remembers about a model.
   */
  test('the batch also fits the model\'s published output allowance, so a long answer is not cut off', () => {
    // 4,096 published output tokens → the `standard` tier asks for the
    // 4,096 floor → 4,096 ÷ 520 tokens per candidate = 7 scenes per request.
    assert.equal(resolveContextualCueBatchSizeForOutput(null, 4_096), 7)
    // A roomier product carries more scenes in one answer.
    assert.equal(resolveContextualCueBatchSizeForOutput(null, 32_768), 15)
    // The smaller of the two rules wins: a published item cap of 3 beats an
    // output allowance that would carry 7.
    assert.equal(resolveContextualCueBatchSizeForOutput(3, 32_768), 3)
    // A product that publishes NO output allowance keeps today's behaviour
    // exactly — the item cap alone decides, and the request omits the ceiling.
    assert.equal(resolveContextualCueBatchSizeForOutput(null, null), 50)
    assert.equal(resolveContextualCueBatchSizeForOutput(null, 0), 50)
    // A product with a tiny allowance still gets ONE scene per request: a
    // batch of zero would ask for nothing at all.
    assert.equal(resolveContextualCueBatchSizeForOutput(null, 512), 1)
    // The policy default is still a ceiling, never a floor to grow past.
    assert.equal(resolveContextualCueBatchSizeForOutput(null, 1_000_000), 50)
  })

  test('persists incomplete proposal batches separately from the final timeline and resumes exact matching work', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'contextual-cues-progress-'))
    const planPath = path.join(dir, 'scene_plan.json')
    const settings = { model: 'gemini-3.1-flash-lite', density: 'restrained', placement: 'top-right', auto_approve: false } as const
    const fingerprint = contextualCueProgressFingerprint(plan as any, settings)
    const progress = {
      schema_version: 1 as const,
      fingerprint,
      source_scene_plan_generated_at: plan.generated_at,
      model: settings.model,
      batch_size: 50,
      total_scenes: 100,
      total_batches: 2,
      completed_batches: [{ index: 0, scene_ids: ['scene-1'], candidates: [{ scene_id: 'scene-1', title: 'Berlin' }] }],
      updated_at: '2026-08-12T00:00:00.000Z',
    }
    try {
      await writeContextualCueProgress(planPath, progress)
      assert.equal(path.basename(contextualCueProgressPath(planPath)), 'contextual_cues.progress.json')
      assert.deepEqual(await readContextualCueProgress(planPath, fingerprint), progress)
      assert.equal(await readContextualCueProgress(planPath, `${fingerprint}-different`), null)
      await removeContextualCueProgress(planPath)
      assert.equal(await readContextualCueProgress(planPath, fingerprint), null)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test('permits bounded replacement only for confirmed backpressure without a hold or cancellation', () => {
    const released = new GenStudioChatTerminalFailureError({
      id: 'job-backpressure', state: 'failed', failure_code: 'LANGUAGE_PROVIDER_BACKPRESSURE',
      reserved_credits: 23, settled_credits: 0, released_credits: 23,
    })
    assert.equal(released.failureCode, 'LANGUAGE_PROVIDER_BACKPRESSURE')
    assert.equal(released.reservedCredits, null)
    assert.equal(released.settledCredits, null)
    assert.equal(released.releasedCredits, null)
    assert.equal(isReleasedContextualCueBackpressure(released), true)
    for (const failure of [
      { failureCode: 'LANGUAGE_PROVIDER_BACKPRESSURE', cancelled: true },
      { failureCode: 'LANGUAGE_PROVIDER_BACKPRESSURE', unknownOutcome: true },
      { failureCode: 'LANGUAGE_PROVIDER_SUBMISSION_UNCERTAIN' },
    ]) assert.equal(isReleasedContextualCueBackpressure(failure), false)
  })

  test('disabled projects normalize to a zero-impact safe default', () => {
    assert.deepEqual(normalizeContextualCueConfig(undefined), { enabled: false })
  })

  /**
   * v1.4.365 — the project-level auto-approve switch is GONE (owner,
   * 2026-10-28). The preset's `auto_approve` is the only one.
   *
   * Both directions matter and both are pinned here. A channel config on disk
   * still stores the old key, so reading it must not throw, must not crash, and
   * — the part that would be a real defect — must not carry it through as if it
   * still decided anything. A future reader who "restores" the field would turn
   * a stale `true` in an old config back into cues nobody approved.
   */
  test('the retired project-level auto-approve key is read safely and has no effect', () => {
    assert.equal(normalizeContextualCueConfig({ enabled: true }).auto_approve_cues, undefined)
    assert.equal(normalizeContextualCueConfig({ enabled: true }).auto_approve_cues, undefined)
    assert.equal(normalizeContextualCueConfig({ enabled: true }).enabled, true)
  })

  test('proposal controls use their own safe defaults instead of Scene Plan settings', () => {
    assert.deepEqual(normalizeContextualCueProposalSettings(undefined), {
      model: '', density: 'restrained', min_gap_sec: 10, placement: 'top-right',
      position_x_pct: null, position_y_pct: null, auto_approve: false,
    })
    assert.deepEqual(normalizeContextualCueProposalSettings({
      model: 'genstudio-current-text', density: 'editorial', placement: 'top-left', auto_approve: true,
    }), {
      model: 'genstudio-current-text', density: 'editorial', min_gap_sec: 10, placement: 'top-left',
      position_x_pct: null, position_y_pct: null, auto_approve: true,
    })
  })

  /**
   * Rewritten for v1.3.0, not added alongside the old assertion.
   *
   * Until v1.3.0 this normaliser collapsed anything that was not 'top-left'
   * to 'top-right', and a test asserted that it did. Between them they made a
   * fully implemented four-corner feature reachable in two corners only — the
   * customer whose channel logo sits in a top corner had labels drawn over it
   * with no way to move them. The old narrowing was never an owner decision;
   * it arrived in the feature's first commit with no reasoning recorded.
   */
  test('every corner survives the proposal normaliser, not just the two top ones', () => {
    for (const placement of ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const) {
      assert.equal(normalizeContextualCueProposalSettings({ placement }).placement, placement)
    }
    assert.equal(normalizeContextualCueProposalSettings({ placement: 'middle' }).placement, 'top-right')
  })

  test('a precise default anchor is kept only when both axes are given', () => {
    const both = normalizeContextualCueProposalSettings({ position_x_pct: 22, position_y_pct: 71 })
    assert.equal(both.position_x_pct, 22)
    assert.equal(both.position_y_pct, 71)
    // Half an anchor is not a position — honouring it would slide a label on
    // one axis and leave the other wherever it happened to be.
    const half = normalizeContextualCueProposalSettings({ position_x_pct: 22 })
    assert.equal(half.position_x_pct, null)
    assert.equal(half.position_y_pct, null)
    const outOfRange = normalizeContextualCueProposalSettings({ position_x_pct: 140, position_y_pct: 50 })
    assert.equal(outOfRange.position_x_pct, null)
    assert.equal(outOfRange.position_y_pct, null)
  })

  test('an UNREVIEWED cue is skipped with a note, never a refused render', () => {
    // v1.4.365 — owner, 2026-10-28: "render approved ones, report the rest".
    // Before this, one proposed cue threw and the whole episode refused to
    // assemble. An optional editorial layer that is allowed to be empty is not
    // allowed to be a hard gate either.
    const timeline = { schema_version: 1, generated_at: '', source_scene_plan_generated_at: plan.generated_at, cues: [cue({ status: 'proposed' })] } as any
    const result = resolveRenderableContextualCues({ enabled: true }, timeline, plan)
    assert.deepEqual(result.cues, [])
    assert.equal(result.skipped.length, 1)
    assert.match(result.skipped[0]!.detail, /awaiting review/i)
  })

  test('approved labels render while the unreviewed ones beside them are reported', () => {
    const timeline = {
      schema_version: 1, generated_at: '', source_scene_plan_generated_at: plan.generated_at,
      cues: [cue({ status: 'approved' }), cue({ id: 'cue-scene-2', scene_id: 'scene-2', start_sec: 6.2, end_sec: 9.5, title: 'Later', status: 'proposed' })],
    } as any
    const result = resolveRenderableContextualCues({ enabled: true }, timeline, plan)
    assert.equal(result.cues.length, 1, 'the approved label is drawn')
    assert.equal(result.cues[0]!.id, 'cue-scene-1')
    assert.equal(result.skipped.length, 1, 'the unreviewed one is named, not silently dropped')
    assert.equal(result.skipped[0]!.cue_id, 'cue-scene-2')
  })

  test('preset save accepts the gap range and rejects invalid values', () => {
    for (const value of [1, 20, 30, 600]) assert.equal(UpdateConfigSchema.safeParse({ contextual_cues_presets: [{ data: { min_gap_sec: value } }] }).success, true)
    for (const value of [0, 601, null, '20']) assert.equal(UpdateConfigSchema.safeParse({ contextual_cues_presets: [{ data: { min_gap_sec: value } }] }).success, false)
  })

  test('gap defaults safely and changes proposal identity', () => {
    for (const value of [undefined, null, 0, 601, '20']) assert.equal(normalizeContextualCueProposalSettings({ min_gap_sec: value }).min_gap_sec, 10)
    const twenty = normalizeContextualCueProposalSettings({ min_gap_sec: 20 })
    const thirty = normalizeContextualCueProposalSettings({ min_gap_sec: 30 })
    assert.equal(twenty.min_gap_sec, 20)
    assert.notEqual(contextualCueProgressFingerprint(plan, twenty), contextualCueProgressFingerprint(plan, thirty))
  })

  test('render skips only a crowded label and retains later labels', () => {
    const longPlan = { generated_at: plan.generated_at, scenes: [{ id: 'scene-1', start_sec: 0, end_sec: 30 }] } as any
    const timeline = { schema_version: 1, generated_at: '', source_scene_plan_generated_at: plan.generated_at, cues: [
      cue({ title: 'First', start_sec: 0, end_sec: 3 }),
      cue({ id: 'second', title: 'Crowded', start_sec: 3.2, end_sec: 8 }),
      cue({ id: 'third', title: 'Kept', start_sec: 6, end_sec: 9 }),
    ] } as any
    assert.ok(validateContextualCueTimeline(timeline, longPlan).some(issue => /overlaps or crowds/.test(issue.detail)))
    const result = resolveRenderableContextualCues({ enabled: true }, timeline, longPlan)
    assert.deepEqual(result.cues.map(row => row.title), ['First', 'Kept'])
    assert.deepEqual(result.skipped.map(row => row.cue_id), ['second'])
    assert.match(result.skipped[0]!.detail, /First/)
  })

  test('a label whose timing is broken still refuses, and is named without its id', () => {
    const bad = cue({ id: 'cue-bad', scene_id: 'scene-1', start_sec: 5.9, end_sec: 9.9, title: 'Escapes its scene' })
    const timeline = { schema_version: 1, generated_at: '', source_scene_plan_generated_at: plan.generated_at, cues: [bad] } as any
    assert.throws(
      () => resolveRenderableContextualCues({ enabled: true }, timeline, plan),
      (error: Error) => {
        assert.match(error.message, new RegExp(`Cue 1 "Escapes its scene" \\(\\d+:\\d{2}\\)`))
        assert.ok(!error.message.includes(bad.id), 'raw cue id is not shown')
        return true
      },
    )
  })

  /**
   * Rewritten for v1.3.0. Crowding is unchanged and still an error; the
   * caption-region rule changed force and basis, deliberately.
   *
   * It used to REFUSE any bottom-corner cue whenever subtitles were enabled.
   * That made "put the label at the bottom" impossible for anyone burning in
   * captions — nearly everyone — so unlocking the bottom corners in the UI
   * alone would only have moved the dead end to render time. It is now a
   * warning, and it asks where the cue actually LANDS rather than which corner
   * it happens to name, so a precisely placed cue in the middle of the frame
   * is not accused of colliding with captions at the bottom of it.
   */
  test('crowding still fails, while a caption-region cue only warns', () => {
    const timeline = {
      schema_version: 1, generated_at: '', source_scene_plan_generated_at: plan.generated_at,
      cues: [cue({ placement: 'bottom-right' }), cue({ id: 'cue-scene-2', scene_id: 'scene-2', start_sec: 3.8, end_sec: 7, title: 'Next' })],
    } as any
    const issues = validateContextualCueTimeline(timeline, plan, { subtitles: { enabled: true }, requireResolved: true } as any)
    const caption = issues.find(issue => /subtitles are drawn/.test(issue.detail))
    assert.ok(caption, 'a bottom cue under enabled subtitles should still say something')
    assert.equal(caption!.severity, 'warning', 'it must not block the render')
    const crowding = issues.find(issue => /overlaps or crowds/.test(issue.detail))
    assert.match(crowding?.detail || '', /the approved cue at \d+:\d\d;/, 'the other cue is named by its time, not an internal id')
    assert.ok(crowding, 'crowding is a real defect and stays an error')
    assert.notEqual(crowding!.severity, 'warning')
  })

  test('a bottom-corner cue with captions on still renders', () => {
    const timeline = {
      schema_version: 1, generated_at: '', source_scene_plan_generated_at: plan.generated_at,
      cues: [cue({ placement: 'bottom-left' })],
    } as any
    const approved = assertContextualCueReadiness(
      { enabled: true }, timeline, plan, { enabled: true } as any,
    )
    assert.equal(approved.length, 1, 'the caption warning must not stop assembly')
  })

  test('a precisely placed cue clear of the caption band says nothing at all', () => {
    const timeline = {
      schema_version: 1, generated_at: '', source_scene_plan_generated_at: plan.generated_at,
      // Still carries 'bottom-right', but anchored high in the frame.
      cues: [cue({ placement: 'bottom-right', position_x_pct: 50, position_y_pct: 30 })],
    } as any
    const issues = validateContextualCueTimeline(timeline, plan, { subtitles: { enabled: true } } as any)
    assert.equal(issues.filter(issue => /subtitles are drawn/.test(issue.detail)).length, 0)
  })

  test('preserves image-backed design identifiers without accepting paths', () => {
    assert.equal(normalizeContextualCueTemplate('label:location-pin'), 'label:location-pin')
    assert.equal(normalizeContextualCueTemplate('label:../../secret'), 'documentary-label')
    assert.equal(normalizeContextualCueTemplate('map-pin'), 'map-pin')
  })

  test('all reviewed visual treatments are accepted, while unknown treatments are rejected', () => {
    for (const template of ['documentary-label', 'map-pin', 'archival-caption', 'chapter-plate']) {
      assert.equal(validateContextualCueTimeline({
        schema_version: 1, generated_at: '', source_scene_plan_generated_at: plan.generated_at,
        cues: [cue({ template })],
      } as any, plan).length, 0)
    }
    assert.ok(validateContextualCueTimeline({
      schema_version: 1, generated_at: '', source_scene_plan_generated_at: plan.generated_at,
      cues: [cue({ template: 'mystery-template' })],
    } as any, plan).some(issue => /treatment is invalid/i.test(issue.detail)))
  })

  test('disabled feature does not block Video Assembly', () => {
    assert.deepEqual(assertContextualCueReadiness({ enabled: false }, null, plan), [])
  })

  // Reported on EP0046: "it says contextual cue is blocking the render as it
  // needs approval but i don't remember adding contextual cue at all… i went to
  // the context cue tab and sees nothing there." The ABSENCE of a timeline was
  // returned as a validation issue, so an OPTIONAL feature refused to render on
  // any episode that had simply never proposed a cue — 70 episodes' worth of
  // forced cue generation just to earn permission to render.
  test('an episode that never proposed a cue renders — nothing exists to resolve', () => {
    assert.deepEqual(validateContextualCueTimeline(null, plan, { requireResolved: true }), [])
    assert.deepEqual(assertContextualCueReadiness({ enabled: true }, null, plan), [])
    assert.deepEqual(assertContextualCueReadiness({ enabled: true }, null, plan), [])
  })

  test('a timeline with unreviewed proposals renders without them', () => {
    const proposed = { schema_version: 1, generated_at: '', source_scene_plan_generated_at: plan.generated_at, cues: [cue({ status: 'proposed' })] } as any
    assert.deepEqual(assertContextualCueReadiness({ enabled: true }, proposed, plan), [])
    const empty = { schema_version: 1, generated_at: '', source_scene_plan_generated_at: plan.generated_at, cues: [] } as any
    assert.deepEqual(assertContextualCueReadiness({ enabled: true }, empty, plan), [])
  })
})

describe('Automatic cue approval (the preset\'s auto_approve)', () => {
  test('approves a candidate that clears every structural rule', () => {
    const candidate = cue({ status: 'proposed' }) // 0.2–3.5s in scene-1: valid duration, in-scene, fields.
    const result = autoApproveEligibleCues([candidate], [], plan)
    assert.equal(result.holds.length, 0)
    assert.equal(result.approvedCount, 1)
    assert.equal(result.cues[0]!.status, 'approved')
  })

  /**
   * Rewritten for v1.3.0, carrying its reasoning like
   * `continuityPresetPacing.test.ts` does — this was a decision, not a
   * regression, and the next reader should be able to see that.
   *
   * The rule used to be "2.25–4.5 seconds", both ends a hard refusal, and this
   * test asserted both ends. The floor survives untouched: a label that
   * flashes past unread is a defect in the output. The CEILING is gone as a
   * refusal, because 4.5s is barely a third of the ~12s that the longest label
   * this same validator accepts (80-char title + 100-char subtitle, at ~15
   * characters a second) actually needs in order to be read — and because how
   * long to hold a label is the editor's call about his own film, not the
   * app's. Reported on a live EP0047: "the contextual cue exist but it
   * disappears too fast."
   */
  test('holds back a candidate too brief to read, and only that', () => {
    const tooShort = cue({ id: 'cue-scene-2', scene_id: 'scene-2', start_sec: 6.1, end_sec: 7.1, status: 'proposed' }) // 1.0s
    const result = autoApproveEligibleCues([tooShort], [], plan)
    assert.equal(result.approvedCount, 0)
    assert.equal(result.cues[0]!.status, 'proposed', 'stays proposed, never silently dropped')
    assert.equal(result.holds.length, 1)
    assert.equal(result.holds[0]!.cue_id, tooShort.id)
    assert.ok(/at least 2\.25 seconds/.test(result.holds[0]!.reasons.join(' ')))
  })

  test('a cue held longer than the old 4.5s ceiling is approved, not held back', () => {
    // 5 seconds — refused outright before v1.3.0.
    const longer = cue({ id: 'cue-scene-1', scene_id: 'scene-1', start_sec: 0, end_sec: 5, status: 'proposed' })
    const result = autoApproveEligibleCues([longer], [], plan)
    assert.equal(result.holds.length, 0, 'a readable hold is not a structural failure')
    assert.equal(result.approvedCount, 1)
    assert.equal(result.cues[0]!.status, 'approved')
  })

  test('an unusually long hold warns without blocking anything', () => {
    // scene-2 spans 6–12s, so a 6s cue fits its scene but passes the ~12s
    // reading estimate only when stretched; use the full scene to trip it.
    const held = cue({ id: 'cue-scene-2', scene_id: 'scene-2', start_sec: 6, end_sec: 12, status: 'approved' })
    const under = validateContextualCueTimeline({
      schema_version: 1, generated_at: '', source_scene_plan_generated_at: plan.generated_at, cues: [held],
    } as any, plan)
    assert.equal(under.filter(issue => /holds for/.test(issue.detail)).length, 0, '6s is well inside the advisory')

    const veryLong = cue({ id: 'cue-scene-3', scene_id: 'scene-3', start_sec: 13, end_sec: 27, status: 'approved' })
    const issues = validateContextualCueTimeline({
      schema_version: 1, generated_at: '', source_scene_plan_generated_at: plan.generated_at, cues: [veryLong],
    } as any, planWithLongScene)
    const note = issues.find(issue => /holds for/.test(issue.detail))
    assert.ok(note, 'a 14s label should be mentioned')
    assert.equal(note!.severity, 'warning')
    // And it must not stop the render.
    assert.doesNotThrow(() => assertContextualCueReadiness(
      { enabled: true },
      { schema_version: 1, generated_at: '', source_scene_plan_generated_at: planWithLongScene.generated_at, cues: [veryLong] } as any,
      planWithLongScene,
    ))
  })

  test('holds back a candidate whose timing falls outside its own scene', () => {
    // scene-2 spans 6–12s; this candidate starts before the scene begins.
    const candidate = cue({ id: 'cue-scene-2', scene_id: 'scene-2', start_sec: 5, end_sec: 8.5, status: 'proposed' })
    const result = autoApproveEligibleCues([candidate], [], plan)
    assert.equal(result.approvedCount, 0)
    assert.equal(result.cues[0]!.status, 'proposed')
    assert.equal(result.holds[0]!.cue_id, candidate.id)
    assert.ok(/inside its scene timing/.test(result.holds[0]!.reasons.join(' ')))
  })

  test('holds back a candidate that crowds an already-approved cue from a prior run', () => {
    const protectedCue = cue({ status: 'approved' }) // scene-1, 0.2–3.5s, approved earlier.
    // Otherwise perfectly valid (in-scene, readable duration) but starts only
    // 0.1s after the protected cue ends — inside the required 0.5s gap.
    const candidate = cue({ id: 'cue-scene-1-b', scene_id: 'scene-1', start_sec: 3.6, end_sec: 6.0, status: 'proposed' })
    const result = autoApproveEligibleCues([candidate], [protectedCue], plan)
    assert.equal(result.approvedCount, 0)
    assert.equal(result.cues[0]!.status, 'proposed')
    assert.ok(/overlaps or crowds/.test(result.holds[0]!.reasons.join(' ')))
  })

  test('within one batch, an earlier-approved candidate can still block a later crowding one', () => {
    const first = cue({ status: 'proposed' }) // scene-1, 0.2–3.5s.
    const second = cue({ id: 'cue-scene-1-b', scene_id: 'scene-1', start_sec: 3.6, end_sec: 6.0, status: 'proposed' })
    const result = autoApproveEligibleCues([first, second], [], plan)
    assert.equal(result.approvedCount, 1)
    assert.equal(result.cues.find(c => c.id === first.id)!.status, 'approved')
    assert.equal(result.cues.find(c => c.id === second.id)!.status, 'proposed')
    assert.equal(result.holds.length, 1)
    assert.equal(result.holds[0]!.cue_id, second.id)
  })

  test('a disabled cue from a prior run never counts toward crowding', () => {
    const disabledCue = cue({ status: 'disabled' }) // scene-1, 0.2–3.5s, excluded from rendering.
    const candidate = cue({ id: 'cue-scene-1-b', scene_id: 'scene-1', start_sec: 3.6, end_sec: 6.0, status: 'proposed' })
    const result = autoApproveEligibleCues([candidate], [disabledCue], plan)
    assert.equal(result.holds.length, 0)
    assert.equal(result.cues[0]!.status, 'approved')
  })

  test('readiness never waits on a cue an automatic pass held back, but every other rule still applies', () => {
    // Structurally clean in every respect except that no one has approved or
    // excluded it yet — the one thing an unreviewed cue is.
    const held = cue({ id: 'cue-scene-1-b', scene_id: 'scene-1', start_sec: 3.6, end_sec: 6.0, status: 'proposed' })
    const approved = cue({ status: 'approved' })
    const timeline = { schema_version: 1, generated_at: '', source_scene_plan_generated_at: plan.generated_at, cues: [approved, held] } as any

    // A leftover 'proposed' cue never blocks Video Assembly; it is simply skipped.
    const ready = assertContextualCueReadiness({ enabled: true }, timeline, plan)
    assert.deepEqual(ready, [approved])

    // ...but a cue with an unrelated structural problem still blocks it either way.
    const brokenTimeline = { ...timeline, cues: [approved, cue({ id: 'cue-broken', scene_id: 'scene-2', start_sec: 6, end_sec: 6.5, status: 'proposed' })] } as any
    assert.throws(() => assertContextualCueReadiness({ enabled: true }, brokenTimeline, plan), /readable for/i)
  })
})
