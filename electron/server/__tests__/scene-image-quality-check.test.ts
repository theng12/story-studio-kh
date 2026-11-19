import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { useTempDataDir } from './_helpers.js'
import * as pm from '../services/project-manager.js'
import { SCENE_IMAGE_CHECK_SHADOW_UNTIL, sceneImageCheckShadowOver } from '../contracts/scene-image-check.js'
import {
  _setVisionCheckCatalogForTesting,
  _setVisionCheckEvaluatorForTesting,
  enqueueImageCheckRemake,
  runSceneImageQualityCheck,
  sceneImageCheckConfig,
} from '../services/scene-image-quality-check.js'

const generatorSource = readFileSync(
  new URL('../generators/scene-image.ts', import.meta.url), 'utf8',
)
const continuitySource = readFileSync(
  new URL('../generators/continuity-render.ts', import.meta.url), 'utf8',
)

async function scenePlanFixture(): Promise<{ dir: string; planPath: string; imagePath: string }> {
  const dir = await fs.mkdtemp(path.join(process.env.STORY_STUDIO_DATA_DIR!, 'episode-'))
  const planPath = path.join(dir, 'scene_plan.json')
  const imagePath = path.join(dir, 'scene-1.png')
  await fs.writeFile(imagePath, 'not a real image: the evaluator is stubbed')
  await fs.writeFile(planPath, JSON.stringify({
    schema_version: 1,
    scenes: [{
      id: 'scene-1',
      scene_index: 1,
      start_sec: 0,
      end_sec: 5,
      visual_prompt: 'A monk walking through a Khmer temple courtyard at dawn',
      approved: true,
    }],
  }))
  return { dir, planPath, imagePath }
}

test('shadow mode records the finding without acting', async (t) => {
  const temp = await useTempDataDir()
  t.after(temp.cleanup)
  // After the claimed data dir: the queue's isolation guard reads it at write time.
  const jq = await import('../services/job-queue.js')
  const project = await pm.createProject({ name: 'Quality Check Shadow', episode_prefix: 'EP', episode_digits: 3 })
  const { planPath, imagePath } = await scenePlanFixture()

  _setVisionCheckCatalogForTesting(async () => [
    { id: 'studio-hub::vision-mlx', display_name: 'Fleet vision', available: true },
  ])
  t.after(() => {
    _setVisionCheckCatalogForTesting(null)
    _setVisionCheckEvaluatorForTesting(null)
  })
  _setVisionCheckEvaluatorForTesting(async () => ({
    score: 35,
    findings: ['No person or figure was found, though the prompt asks for one.'],
  }))

  const result = await runSceneImageQualityCheck({
    sceneId: 'scene-1', imagePath, visualPrompt: 'A monk walking through a temple', planPath,
    config: { scene_image_check: { auto_remake: false } },
  })

  assert.equal(result.state, 'failed')
  assert.equal(result.shadow_mode, true, 'the verdict says it came from the shadow review')
  assert.equal(result.remade, false, 'shadow mode acts on nothing')
  assert.deepEqual(result.findings, ['No person or figure was found, though the prompt asks for one.'])

  // The finding is recorded where the owner can see it: the plan and a sidecar.
  const plan = JSON.parse(await fs.readFile(planPath, 'utf8'))
  assert.equal(plan.scenes[0].image_check.state, 'failed')
  assert.equal(plan.scenes[0].image_check.shadow_mode, true)
  const sidecar = JSON.parse(await fs.readFile(path.join(path.dirname(imagePath), 'scene-1.check.json'), 'utf8'))
  assert.equal(sidecar.state, 'failed')

  // Nothing was queued: shadow mode has no remake path at all.
  const remakes = await jq.findJobs(project.slug, job => (job.params as any)?.image_check_remake === true)
  assert.equal(remakes.length, 0)
  await jq._waitForJobPersistenceForTesting()
  jq._forgetProjectPersistenceForTesting(project.slug)

  // And the generators only run a check when the master switch is ON, only reach
  // the remake branch when the auto-remake switch is ON, and shadow mode always
  // goes through the bounded background queue.
  for (const source of [generatorSource, continuitySource]) {
    assert.match(source, /if \((?:cfg|checkCfg)\.enabled\) \{/)
    assert.match(source, /if \(checkResult\.state === 'failed' && params\.image_check_remake !== true\)/)
    assert.match(source, /queueSceneImageQualityCheck\(checkInput\)/)
  }
})

test('a shadow check queued after a render still records its finding', async (t) => {
  const temp = await useTempDataDir()
  t.after(temp.cleanup)
  const { planPath, imagePath } = await scenePlanFixture()
  _setVisionCheckCatalogForTesting(async () => [
    { id: 'studio-hub::vision-mlx', display_name: 'Fleet vision', available: true },
  ])
  _setVisionCheckEvaluatorForTesting(async () => ({ score: 95, findings: [] }))
  const service = await import('../services/scene-image-quality-check.js')
  t.after(() => {
    _setVisionCheckCatalogForTesting(null)
    _setVisionCheckEvaluatorForTesting(null)
  })

  service.queueSceneImageQualityCheck({
    sceneId: 'scene-1', imagePath, visualPrompt: 'A temple at dawn', planPath,
    config: { scene_image_check: { auto_remake: false } },
  })
  await service._drainSceneImageCheckQueueForTesting()

  const plan = JSON.parse(await fs.readFile(planPath, 'utf8'))
  assert.equal(plan.scenes[0].image_check.state, 'passed')
  assert.equal(plan.scenes[0].image_check.shadow_mode, true)
})

test('the auto-remake switch remakes once at most', async (t) => {
  const temp = await useTempDataDir()
  t.after(temp.cleanup)
  const jq = await import('../services/job-queue.js')
  const project = await pm.createProject({ name: 'Quality Check Remake', episode_prefix: 'EP', episode_digits: 3 })

  await enqueueImageCheckRemake({
    projectSlug: project.slug, episodeId: 'EP0001', sceneId: 'scene-1',
    title: 'Scene 1', params: { episode_id: 'EP0001', model: 'some-model' },
  })
  const afterFirst = await jq.findJobs(project.slug, job =>
    (job.params as any)?.image_check_remake === true && (job.params as any)?.scene_id === 'scene-1')
  assert.equal(afterFirst.length, 1, 'the first failed check queues exactly one remake')

  // A retry of the first render (or a second check) must not queue a second one.
  await enqueueImageCheckRemake({
    projectSlug: project.slug, episodeId: 'EP0001', sceneId: 'scene-1',
    title: 'Scene 1', params: { episode_id: 'EP0001', model: 'some-model' },
  })
  const afterSecond = await jq.findJobs(project.slug, job =>
    (job.params as any)?.image_check_remake === true && (job.params as any)?.scene_id === 'scene-1')
  assert.equal(afterSecond.length, 1, 'one remake per image, never two')
  assert.equal((afterSecond[0]!.params as any).image_check_remake, true,
    'the remake carries its own marker, so its check cannot queue a third')
  await jq._waitForJobPersistenceForTesting()
  jq._forgetProjectPersistenceForTesting(project.slug)
})

test('an unavailable vision model shows as not checked, never a pass', async (t) => {
  const temp = await useTempDataDir()
  t.after(temp.cleanup)
  const { planPath, imagePath } = await scenePlanFixture()
  _setVisionCheckCatalogForTesting(null)
  _setVisionCheckEvaluatorForTesting(null)
  t.after(() => _setVisionCheckCatalogForTesting(null))

  // The live catalogue read must fail closed, not invented.
  _setVisionCheckCatalogForTesting(async () => [])
  const result = await runSceneImageQualityCheck({
    sceneId: 'scene-1', imagePath, visualPrompt: 'A monk walking through a temple', planPath,
    config: { scene_image_check: { auto_remake: false } },
  })

  assert.equal(result.state, 'not_checked')
  assert.equal(result.passed, false, 'an unchecked picture is not a pass')
  assert.match(result.reason || '', /not checked|No fleet vision model/i)
  const plan = JSON.parse(await fs.readFile(planPath, 'utf8'))
  assert.equal(plan.scenes[0].image_check.state, 'not_checked')
})

test('the check is ON by default and the auto-remake switch is OFF and locked until 2026-11-30', () => {
  const defaults = sceneImageCheckConfig(undefined)
  assert.equal(defaults.enabled, true, 'the check is ON by default')
  assert.equal(defaults.auto_remake, false, 'the auto-remake switch is OFF by default')
  assert.equal(defaults.shadow_until, SCENE_IMAGE_CHECK_SHADOW_UNTIL)

  const until = Date.parse(SCENE_IMAGE_CHECK_SHADOW_UNTIL)
  assert.equal(sceneImageCheckShadowOver(SCENE_IMAGE_CHECK_SHADOW_UNTIL, until - 1), false, 'locked one ms before the end')
  assert.equal(sceneImageCheckShadowOver(SCENE_IMAGE_CHECK_SHADOW_UNTIL, until + 1), true, 'unlocked after the end date')

  // An explicit end date is honoured, not "start + 14".
  assert.equal(sceneImageCheckShadowOver('2026-12-15T00:00:00.000Z', Date.parse('2026-12-14T23:59:59.000Z')), false)
  assert.equal(sceneImageCheckShadowOver('2026-12-15T00:00:00.000Z', Date.parse('2026-12-15T00:00:01.000Z')), true)

  // A saved config that names a model keeps it; an unnamed one resolves live.
  const named = sceneImageCheckConfig({ scene_image_check: { auto_remake: true, model: 'studio-hub::vision-mlx' } })
  assert.equal(named.auto_remake, true)
  assert.equal(named.model, 'studio-hub::vision-mlx')
})

test('turning the check off queues nothing and records nothing; turning it back on resumes', async (t) => {
  const temp = await useTempDataDir()
  t.after(temp.cleanup)
  const { planPath, imagePath } = await scenePlanFixture()
  _setVisionCheckCatalogForTesting(async () => [
    { id: 'studio-hub::vision-mlx', display_name: 'Fleet vision', available: true },
  ])
  _setVisionCheckEvaluatorForTesting(async () => ({ score: 95, findings: [] }))
  const service = await import('../services/scene-image-quality-check.js')
  t.after(() => {
    _setVisionCheckCatalogForTesting(null)
    _setVisionCheckEvaluatorForTesting(null)
  })

  // OFF: nothing is queued …
  service.queueSceneImageQualityCheck({
    sceneId: 'scene-1', imagePath, visualPrompt: 'A temple at dawn', planPath,
    config: { scene_image_check: { enabled: false, auto_remake: false } },
  })
  await service._drainSceneImageCheckQueueForTesting()
  // … and nothing is recorded.
  const offPlan = JSON.parse(await fs.readFile(planPath, 'utf8'))
  assert.equal(offPlan.scenes[0].image_check, undefined, 'no result is written while the check is off')
  await assert.rejects(fs.readFile(path.join(path.dirname(imagePath), 'scene-1.check.json')), /ENOENT/)

  // A direct call also refuses to run while off, and says so rather than passing.
  const offResult = await service.runSceneImageQualityCheck({
    sceneId: 'scene-1', imagePath, visualPrompt: 'A temple at dawn', planPath,
    config: { scene_image_check: { enabled: false } },
  })
  assert.equal(offResult.state, 'not_checked')
  assert.equal(offResult.passed, false)
  assert.match(offResult.reason || '', /turned off/i)

  // ON again: checking resumes.
  service.queueSceneImageQualityCheck({
    sceneId: 'scene-1', imagePath, visualPrompt: 'A temple at dawn', planPath,
    config: { scene_image_check: { enabled: true, auto_remake: false } },
  })
  await service._drainSceneImageCheckQueueForTesting()
  const onPlan = JSON.parse(await fs.readFile(planPath, 'utf8'))
  assert.equal(onPlan.scenes[0].image_check.state, 'passed')
})

test('the check asks a model that can answer "subject", not simply the first one in the catalogue', async (t) => {
  t.after(() => _setVisionCheckCatalogForTesting(null))
  const { resolveSceneImageCheckModel } = await import('../services/scene-image-quality-check.js')
  // angkor 2026-11-19: this exact order, and every scene came back not_checked / INVALID_REQUEST.
  _setVisionCheckCatalogForTesting(async () => [
    { id: 'studio-hub::depth-anything/Depth-Anything-V2-Small-hf', display_name: 'Depth', available: true, tasks: ['depth'] },
    { id: 'studio-hub::florence-community/Florence-2-base-ft', display_name: 'Florence', available: true, tasks: ['subject', 'points', 'segments'] },
  ])
  assert.equal((await resolveSceneImageCheckModel())?.id, 'studio-hub::florence-community/Florence-2-base-ft')

  // No model publishes the task: take the first, as before — the check records what actually happened.
  _setVisionCheckCatalogForTesting(async () => [
    { id: 'only-depth', display_name: 'Depth', available: true, tasks: ['depth'] },
  ])
  assert.equal((await resolveSceneImageCheckModel())?.id, 'only-depth')
})
