/**
 * The OPT-IN stronger scene-image check (owner 2026-10-27).
 *
 * It is a second check, never a replacement: its verdict is recorded BESIDE the
 * free check's, it is OFF by default, and in shadow mode it changes nothing.
 *
 * These tests pin the four-verdict honesty (§6): pass / fail / not_visible /
 * could_not_check per axis, and `not_checked` for the whole check when no call
 * happened. A missing model, a provider failure and an unreadable answer must
 * never come back as a pass, and the auto-remake switches must not act while the
 * shadow window is open.
 *
 * No network and no paid call: the catalogue read and the model call are both
 * replaced through the service's own seams.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'

import { useTempDataDir } from './_helpers.js'
import { SCENE_IMAGE_CHECK_SHADOW_UNTIL } from '../contracts/scene-image-check.js'
import type { GenStudioChatModel } from '../lib/genstudio-client.js'
import {
  _drainSceneVisionCheckQueueForTesting,
  _setSceneVisionCatalogForTesting,
  _setSceneVisionEvaluatorForTesting,
  describeSceneVisionCheck,
  eligibleSceneVisionModels,
  queueSceneVisionCheck,
  resolveSceneVisionModel,
  runSceneVisionCheck,
  sceneImageVisionConfig,
  sceneVisionAutoRemakeActive,
  sceneVisionAxesToRemake,
} from '../services/scene-image-vision-check.js'

const MODEL_ID = 'openrouter-main::vision-free'

function visionRow(over: Partial<GenStudioChatModel> = {}): GenStudioChatModel {
  return {
    id: MODEL_ID,
    display_name: 'Vision Free',
    provider_id: 'openrouter-main',
    provider_name: 'OpenRouter',
    available: true,
    qualification_only: false,
    locked: false,
    supports_vision: true,
    structured_output_mode: 'json_object',
    controls: ['temperature'],
    context_window_tokens: 128_000,
    max_output_tokens: 4_096,
    ...over,
  } as GenStudioChatModel
}

function config(over: Record<string, unknown> = {}) {
  return {
    scene_image_check: {
      vision: { enabled: true, model: MODEL_ID, ...over },
    },
  }
}

/** The answer the rubric asks for, as a string. */
function answer(axes: Record<string, any>, confidence = 0.8): string {
  return JSON.stringify({ ...axes, confidence })
}

async function fixture(): Promise<{ dir: string; planPath: string; imagePath: string }> {
  const dir = await fs.mkdtemp(path.join(process.env.STORY_STUDIO_DATA_DIR!, 'vision-'))
  const planPath = path.join(dir, 'scene_plan.json')
  const imagePath = path.join(dir, 'scene-1.png')
  await fs.writeFile(imagePath, 'not a real image: the model call is stubbed')
  await fs.writeFile(planPath, JSON.stringify({
    schema_version: 1,
    scenes: [{
      id: 'scene-1', scene_index: 1, start_sec: 0, end_sec: 5,
      visual_prompt: 'A monk walking through a Khmer temple courtyard at dawn',
      approved: true,
    }],
  }))
  return { dir, planPath, imagePath }
}

function useSeams(t: any, rows: GenStudioChatModel[], evaluator?: (input: any) => Promise<string>) {
  _setSceneVisionCatalogForTesting(async () => rows)
  _setSceneVisionEvaluatorForTesting(evaluator ? async input => evaluator(input) : null)
  t.after(() => {
    _setSceneVisionCatalogForTesting(null)
    _setSceneVisionEvaluatorForTesting(null)
  })
}

// ── A complete, a partial and an empty answer ───────────────────────────────

test('a complete answer passes every axis, and the free check is untouched', async (t) => {
  const temp = await useTempDataDir()
  t.after(temp.cleanup)
  const { planPath, imagePath } = await fixture()
  useSeams(t, [visionRow()], async () => answer({
    anatomy: { verdict: 'pass', findings: [] },
    face: { verdict: 'pass', findings: [] },
    text: { verdict: 'pass', findings: [], transcription: 'WELCOME' },
  }))

  const result = await runSceneVisionCheck({
    sceneId: 'scene-1', imagePath, visualPrompt: 'A monk at dawn', planPath, config: config(),
  })

  assert.equal(result.state, 'checked')
  assert.equal(result.axes.anatomy.verdict, 'pass')
  assert.equal(result.axes.face.verdict, 'pass')
  assert.equal(result.axes.text.verdict, 'pass')
  assert.deepEqual(result.findings, [])
  assert.equal(result.shadow_mode, true, 'the default shadow window is still open')
  assert.equal(result.model_id, MODEL_ID)
  assert.equal(result.provider_name, 'OpenRouter', 'the published provider is recorded with the verdict')

  // Recorded BESIDE the free check, never over it.
  const plan = JSON.parse(await fs.readFile(planPath, 'utf8'))
  assert.equal(plan.scenes[0].vision_check.state, 'checked')
  assert.equal(plan.scenes[0].image_check, undefined, 'the free check still owns its own field')
  const sidecar = JSON.parse(await fs.readFile(path.join(path.dirname(imagePath), 'scene-1.vision-check.json'), 'utf8'))
  assert.equal(sidecar.state, 'checked')
})

test('a partial answer keeps each axis its own verdict', async (t) => {
  const temp = await useTempDataDir()
  t.after(temp.cleanup)
  const { planPath, imagePath } = await fixture()
  useSeams(t, [visionRow()], async () => answer({
    anatomy: { verdict: 'fail', findings: ['left hand has six fingers'] },
    face: { verdict: 'not_visible', findings: [] },
    text: { verdict: 'pass', findings: [] },
  }))

  const result = await runSceneVisionCheck({
    sceneId: 'scene-1', imagePath, visualPrompt: 'A monk at dawn', planPath, config: config(),
  })

  assert.equal(result.state, 'checked')
  assert.equal(result.axes.anatomy.verdict, 'fail')
  assert.deepEqual(result.axes.anatomy.findings, ['left hand has six fingers'])
  assert.equal(result.axes.face.verdict, 'not_visible', 'no face is not a pass')
  assert.equal(result.axes.text.verdict, 'pass')
  assert.deepEqual(result.findings, ['anatomy: left hand has six fingers'])
})

test('an empty answer is unmeasurable on every axis — never a pass', async (t) => {
  const temp = await useTempDataDir()
  t.after(temp.cleanup)
  const { planPath, imagePath } = await fixture()
  useSeams(t, [visionRow()], async () => '{}')

  const result = await runSceneVisionCheck({
    sceneId: 'scene-1', imagePath, visualPrompt: 'A monk at dawn', planPath, config: config(),
  })

  assert.equal(result.state, 'checked', 'a call did happen')
  for (const axis of ['anatomy', 'face', 'text'] as const) {
    assert.equal(result.axes[axis].verdict, 'could_not_check', `${axis} was never answered`)
  }
  assert.deepEqual(result.findings, [])
})

test('a fail with no named defect is unmeasurable, not a pass and not a fail', async (t) => {
  const temp = await useTempDataDir()
  t.after(temp.cleanup)
  const { planPath, imagePath } = await fixture()
  useSeams(t, [visionRow()], async () => answer({
    anatomy: { verdict: 'fail', findings: [] },
    face: { verdict: 'pass', findings: [] },
    text: { verdict: 'pass', findings: [] },
  }))

  const result = await runSceneVisionCheck({
    sceneId: 'scene-1', imagePath, visualPrompt: 'A monk at dawn', planPath, config: config(),
  })
  assert.equal(result.axes.anatomy.verdict, 'could_not_check', 'no score without a reason')
})

// ── The call could not happen or could not be read ──────────────────────────

test('a malformed answer records not_checked with a reason, never a pass', async (t) => {
  const temp = await useTempDataDir()
  t.after(temp.cleanup)
  const { planPath, imagePath } = await fixture()
  useSeams(t, [visionRow()], async () => 'I think the picture looks fine.')

  const result = await runSceneVisionCheck({
    sceneId: 'scene-1', imagePath, visualPrompt: 'A monk at dawn', planPath, config: config(),
  })

  assert.equal(result.state, 'not_checked')
  assert.match(result.reason || '', /could not run|JSON/i)
  const plan = JSON.parse(await fs.readFile(planPath, 'utf8'))
  assert.equal(plan.scenes[0].vision_check.state, 'not_checked')
  assert.equal(plan.scenes[0].vision_check.axes.anatomy.verdict, 'could_not_check')
})

test('a provider failure records not_checked and does not throw', async (t) => {
  const temp = await useTempDataDir()
  t.after(temp.cleanup)
  const { planPath, imagePath } = await fixture()
  useSeams(t, [visionRow()], async () => { throw new Error('LANGUAGE_PROVIDER_FAILED') })

  const result = await runSceneVisionCheck({
    sceneId: 'scene-1', imagePath, visualPrompt: 'A monk at dawn', planPath, config: config(),
  })
  assert.equal(result.state, 'not_checked')
  assert.match(result.reason || '', /LANGUAGE_PROVIDER_FAILED/)
  assert.equal(result.model_id, MODEL_ID, 'the reason names the model that was tried')
})

test('no catalogue row publishes image input → not_checked, and no substitute model', async (t) => {
  const temp = await useTempDataDir()
  t.after(temp.cleanup)
  const { planPath, imagePath } = await fixture()
  useSeams(t, [visionRow({ supports_vision: false })], async () => { throw new Error('must not be called') })

  const result = await runSceneVisionCheck({
    sceneId: 'scene-1', imagePath, visualPrompt: 'A monk at dawn', planPath, config: config(),
  })
  assert.equal(result.state, 'not_checked')
  assert.match(result.reason || '', /does not publish image input/)
  assert.equal(eligibleSceneVisionModels([visionRow({ supports_vision: false })]).length, 0)
})

test('a named model that has left the catalogue is reported by name', async (t) => {
  const temp = await useTempDataDir()
  t.after(temp.cleanup)
  const { planPath, imagePath } = await fixture()
  useSeams(t, [visionRow({ id: 'openrouter-main::other' })], async () => { throw new Error('must not be called') })

  const result = await runSceneVisionCheck({
    sceneId: 'scene-1', imagePath, visualPrompt: 'A monk at dawn', planPath, config: config(),
  })
  assert.equal(result.state, 'not_checked')
  assert.match(result.reason || '', new RegExp(MODEL_ID.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(result.reason || '', /not in the Gateway catalogue/)
})

test('no model selected → not_checked, never the first available row', async (t) => {
  const temp = await useTempDataDir()
  t.after(temp.cleanup)
  const { planPath, imagePath } = await fixture()
  useSeams(t, [visionRow()], async () => { throw new Error('must not be called') })

  const result = await runSceneVisionCheck({
    sceneId: 'scene-1', imagePath, visualPrompt: 'A monk at dawn', planPath,
    config: { scene_image_check: { vision: { enabled: true } } },
  })
  assert.equal(result.state, 'not_checked')
  assert.match(result.reason || '', /No vision model is selected/)
  const resolved = await resolveSceneVisionModel({ scene_image_check: { vision: { enabled: true } } }, [visionRow()])
  assert.equal(resolved.ok, false)
})

// ── The switch ──────────────────────────────────────────────────────────────

test('with the switch off nothing is sent and nothing is recorded', async (t) => {
  const temp = await useTempDataDir()
  t.after(temp.cleanup)
  const { planPath, imagePath } = await fixture()
  let calls = 0
  useSeams(t, [visionRow()], async () => { calls++; return '{}' })

  const off = await runSceneVisionCheck({
    sceneId: 'scene-1', imagePath, visualPrompt: 'A monk at dawn', planPath,
    config: { scene_image_check: { vision: { enabled: false, model: MODEL_ID } } },
  })
  assert.equal(off.state, 'not_checked')
  assert.match(off.reason || '', /turned off/i)
  assert.equal(calls, 0, 'the model is never asked')

  const plan = JSON.parse(await fs.readFile(planPath, 'utf8'))
  assert.equal(plan.scenes[0].vision_check, undefined, 'nothing is recorded while the switch is off')
  await assert.rejects(fs.readFile(path.join(path.dirname(imagePath), 'scene-1.vision-check.json')), /ENOENT/)

  // The background queue refuses it too.
  queueSceneVisionCheck({
    sceneId: 'scene-1', imagePath, visualPrompt: 'A monk at dawn', planPath,
    config: { scene_image_check: { vision: { enabled: false, model: MODEL_ID } } },
  })
  await _drainSceneVisionCheckQueueForTesting()
  assert.equal(calls, 0)
})

test('the check is OFF by default and requests nothing on a fresh channel', () => {
  assert.equal(sceneImageVisionConfig(undefined).enabled, false)
  assert.deepEqual(sceneImageVisionConfig(undefined).auto_remake, { anatomy: false, face: false, text: false })
  assert.equal(sceneVisionAutoRemakeActive(undefined), false)
})

test('the background queue records an enabled check', async (t) => {
  const temp = await useTempDataDir()
  t.after(temp.cleanup)
  const { planPath, imagePath } = await fixture()
  useSeams(t, [visionRow()], async () => answer({
    anatomy: { verdict: 'pass', findings: [] },
    face: { verdict: 'not_visible', findings: [] },
    text: { verdict: 'not_visible', findings: [] },
  }))

  queueSceneVisionCheck({ sceneId: 'scene-1', imagePath, visualPrompt: 'A temple', planPath, config: config() })
  await _drainSceneVisionCheckQueueForTesting()

  const plan = JSON.parse(await fs.readFile(planPath, 'utf8'))
  assert.equal(plan.scenes[0].vision_check.state, 'checked')
})

// ── The text axis ───────────────────────────────────────────────────────────

test('when Story drew the text, the transcription is compared against it', async (t) => {
  const temp = await useTempDataDir()
  t.after(temp.cleanup)
  const { planPath, imagePath } = await fixture()
  let seen: any = null
  useSeams(t, [visionRow()], async input => {
    seen = input
    return answer({
      anatomy: { verdict: 'pass', findings: [] },
      face: { verdict: 'pass', findings: [] },
      text: { verdict: 'pass', findings: [], transcription: 'hello  world!' },
    })
  })

  const result = await runSceneVisionCheck({
    sceneId: 'scene-1', imagePath, visualPrompt: 'A monk at dawn', planPath,
    expectedText: 'Hello World', config: config(),
  })
  assert.equal(seen.expectedText, 'Hello World', 'the expected string reaches the prompt')
  assert.equal(result.axes.text.verdict, 'pass')
  assert.equal(result.expected_text, 'Hello World')
  assert.deepEqual(result.findings, [], 'the normalised comparison is a match, not a near miss')

  useSeams(t, [visionRow()], async () => answer({
    anatomy: { verdict: 'pass', findings: [] },
    face: { verdict: 'pass', findings: [] },
    text: { verdict: 'pass', findings: [], transcription: 'He11o W0rld' },
  }))
  const wrong = await runSceneVisionCheck({
    sceneId: 'scene-1', imagePath, visualPrompt: 'A monk at dawn', planPath,
    expectedText: 'Hello World', config: config(),
  })
  assert.equal(wrong.axes.text.verdict, 'fail', 'a different word is a defect, whatever the model said')
  assert.match(wrong.axes.text.findings[0] || '', /should read “Hello World”/)
})

test('Khmer text is unmeasurable and says so, never guessed', async (t) => {
  const temp = await useTempDataDir()
  t.after(temp.cleanup)
  const { planPath, imagePath } = await fixture()
  const khmer = 'សួស្តី'
  useSeams(t, [visionRow()], async () => answer({
    anatomy: { verdict: 'pass', findings: [] },
    face: { verdict: 'pass', findings: [] },
    text: { verdict: 'pass', findings: [], transcription: khmer },
  }))

  // 1. A transcription in Khmer cannot be trusted even when the model is sure.
  const fromTranscription = await runSceneVisionCheck({
    sceneId: 'scene-1', imagePath, visualPrompt: 'A monk at dawn', planPath, config: config(),
  })
  assert.equal(fromTranscription.axes.text.verdict, 'could_not_check')
  assert.match(fromTranscription.axes.text.findings.join(' '), /Khmer text cannot be read/)

  // 2. An expected Khmer string is compared to nothing: it is stated as unmeasurable.
  const fromExpected = await runSceneVisionCheck({
    sceneId: 'scene-1', imagePath, visualPrompt: 'A monk at dawn', planPath,
    expectedText: khmer, config: config(),
  })
  assert.equal(fromExpected.axes.text.verdict, 'could_not_check')
  assert.equal(fromExpected.axes.anatomy.verdict, 'pass', 'the other axes are unaffected')
})

// ── Auto-remake: per axis, OFF, and locked by the shadow window ─────────────

test('the shadow window locks every auto-remake axis, whatever the switches say', async (t) => {
  const temp = await useTempDataDir()
  t.after(temp.cleanup)
  const { planPath, imagePath } = await fixture()
  useSeams(t, [visionRow()], async () => answer({
    anatomy: { verdict: 'fail', findings: ['left hand has six fingers'] },
    face: { verdict: 'fail', findings: ['an eye is duplicated'] },
    text: { verdict: 'fail', findings: ['garbled glyphs'] },
  }))

  const locked = config({ auto_remake: { anatomy: true, face: true, text: true } })
  const lockedNow = Date.parse(SCENE_IMAGE_CHECK_SHADOW_UNTIL) - 1
  assert.equal(sceneVisionAutoRemakeActive(locked, lockedNow), false)
  const result = await runSceneVisionCheck({
    sceneId: 'scene-1', imagePath, visualPrompt: 'A monk at dawn', planPath, config: locked,
  })
  assert.equal(result.axes.anatomy.verdict, 'fail')
  assert.deepEqual(sceneVisionAxesToRemake(result, locked, lockedNow), [], 'shadow mode acts on nothing')

  // Past the window, ONLY the axes the owner switched on act.
  const after = Date.parse(SCENE_IMAGE_CHECK_SHADOW_UNTIL) + 1
  const anatomyOnly = config({ auto_remake: { anatomy: true } })
  assert.deepEqual(sceneVisionAxesToRemake(result, anatomyOnly, after), ['anatomy'])
  assert.equal(sceneVisionAutoRemakeActive(anatomyOnly, after), true)
  assert.equal(sceneVisionAutoRemakeActive(config(), after), false, 'no switch on means no remake')
  // A picture that IS the remake never queues another.
  assert.deepEqual(sceneVisionAxesToRemake({ ...result, remade: true }, anatomyOnly, after), [])
  // A check that did not run cannot trigger anything.
  assert.deepEqual(sceneVisionAxesToRemake({ ...result, state: 'not_checked' }, anatomyOnly, after), [])
})

test('structured output is asked for only where the row publishes it', async (t) => {
  const temp = await useTempDataDir()
  t.after(temp.cleanup)
  const { planPath, imagePath } = await fixture()
  const seen: boolean[] = []
  useSeams(t, [visionRow()], async input => {
    seen.push(input.structuredOutput)
    return answer({
      anatomy: { verdict: 'pass', findings: [] },
      face: { verdict: 'pass', findings: [] },
      text: { verdict: 'not_visible', findings: [] },
    })
  })

  await runSceneVisionCheck({ sceneId: 'scene-1', imagePath, visualPrompt: 'A temple', planPath, config: config() })
  useSeams(t, [visionRow({ structured_output_mode: 'none' })], async input => {
    seen.push(input.structuredOutput)
    return answer({
      anatomy: { verdict: 'pass', findings: [] },
      face: { verdict: 'pass', findings: [] },
      text: { verdict: 'not_visible', findings: [] },
    })
  })
  await runSceneVisionCheck({ sceneId: 'scene-1', imagePath, visualPrompt: 'A temple', planPath, config: config() })

  assert.deepEqual(seen, [true, false], 'json_object for a row that states it; prose for one that does not')
})

test('the job log line says what happened and that nothing changed in shadow mode', async (t) => {
  const temp = await useTempDataDir()
  t.after(temp.cleanup)
  const { planPath, imagePath } = await fixture()
  useSeams(t, [visionRow()], async () => answer({
    anatomy: { verdict: 'fail', findings: ['left hand has six fingers'] },
    face: { verdict: 'not_visible', findings: [] },
    text: { verdict: 'not_visible', findings: [] },
  }))
  const result = await runSceneVisionCheck({
    sceneId: 'scene-1', imagePath, visualPrompt: 'A monk at dawn', planPath, config: config(),
  })
  const line = describeSceneVisionCheck(result)
  assert.match(line, /Vision check \(Vision Free\)/)
  assert.match(line, /anatomy fail/)
  assert.match(line, /shadow — nothing changed/)

  const notChecked = describeSceneVisionCheck({
    ...result, state: 'not_checked', reason: 'no model', findings: [],
  })
  assert.match(notChecked, /not checked — no model/)
})
