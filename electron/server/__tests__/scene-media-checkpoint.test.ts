import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'

import { auditSceneClipCompletion, auditSceneImageCompletion, checkpointSceneClip, checkpointSceneImage, countScenesAwaitingApproval } from '../services/scene-media-checkpoint.js'
import type { ScenePlan } from '../models/types.js'
import { tinyVideoBytes } from './fixtures/tiny-video.js'
import { withLock } from '../lib/atomic-store.js'

const tempDirs: string[] = []
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

async function writeValidImage(filePath: string): Promise<void> {
  await fs.writeFile(filePath, ONE_PIXEL_PNG)
}

/** Still a valid PNG, but different bytes: what a re-roll produces. */
async function writeVariantImage(filePath: string): Promise<void> {
  await fs.writeFile(filePath, Buffer.concat([ONE_PIXEL_PNG, Buffer.from('variant')]))
}

async function ownerSetApproved(planPath: string, sceneId: string, approved: boolean): Promise<void> {
  await withLock(planPath, async () => {
    const plan = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
    plan.scenes.find(scene => scene.id === sceneId)!.approved = approved
    await fs.writeFile(planPath, JSON.stringify(plan), 'utf-8')
  })
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

async function fixture(): Promise<{ dir: string; planPath: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scene-media-checkpoint-'))
  tempDirs.push(dir)
  const planPath = path.join(dir, 'scene_plan.json')
  const plan: ScenePlan = {
    schema_version: 1,
    generated_at: '2026-01-01T00:00:00.000Z',
    planner_model: 'test',
    source_stitched_srt: 'test.srt',
    total_duration_sec: 10,
    research_used: false,
    planned_in_windows: 0,
    planning_stage: 'visual',
    scenes: [
      { id: 'scene-1', scene_index: 1, start_sec: 0, end_sec: 5, transcript_segment: 'One', visual_prompt: 'Prompt one', approved: false },
      { id: 'scene-2', scene_index: 2, start_sec: 5, end_sec: 10, transcript_segment: 'Two', visual_prompt: 'Prompt two', approved: false },
    ],
  }
  await fs.writeFile(planPath, JSON.stringify(plan), 'utf-8')
  return { dir, planPath }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
})

describe('scene media checkpoints', () => {
  it('an image filled in after an auto-approve render is approved too; a replacement still waits', async () => {
    const { dir, planPath } = await fixture()
    const image1 = path.join(dir, 'scene-1.png')
    const image2 = path.join(dir, 'scene-2.png')
    await Promise.all([writeValidImage(image1), writeValidImage(image2)])
    // The batch auto-approved scene 1; scene 2 failed and is filled in later by a job without the flag (TN0329).
    await checkpointSceneImage(planPath, 'scene-1', image1, 'Prompt one', true)
    let plan = await checkpointSceneImage(planPath, 'scene-2', image2, 'Prompt two', false)
    assert.equal(plan.auto_approve_generated, true)
    assert.equal(plan.scenes.find(scene => scene.id === 'scene-2')?.approved, true)
    // Regenerating an image that already existed (new bytes) is the owner's call to review.
    await writeVariantImage(image1)
    plan = await checkpointSceneImage(planPath, 'scene-1', image1, 'Prompt one', false)
    assert.equal(plan.scenes.find(scene => scene.id === 'scene-1')?.approved, false)
  })

  it('a job re-registering the same image keeps an approval the owner made after it started', async () => {
    const { dir, planPath } = await fixture()
    const images = [path.join(dir, 'scene-1.png'), path.join(dir, 'scene-2.png')]
    await Promise.all(images.map(writeValidImage))
    // Job starts with auto_approve_generated=false and registers both images.
    await checkpointSceneImage(planPath, 'scene-1', images[0]!, 'Prompt one', false)
    await checkpointSceneImage(planPath, 'scene-2', images[1]!, 'Prompt two', false)
    // The owner approves scene 2 by hand while the job is still running ...
    await ownerSetApproved(planPath, 'scene-2', true)
    // ... then the job checkpoints again (retry / restart re-runs the registration with the same file).
    await checkpointSceneImage(planPath, 'scene-2', images[1]!, 'Prompt two', false)
    const plan = await checkpointSceneImage(planPath, 'scene-1', images[0]!, 'Prompt one', false)
    assert.equal(plan.scenes.find(scene => scene.id === 'scene-2')?.approved, true, 'owner approval survives')
    assert.equal(plan.scenes.find(scene => scene.id === 'scene-1')?.approved, false, 'unapproved stays unapproved')
  })

  it('a re-registered image keeps its motion choice and still follows auto_approve_generated', async () => {
    const { dir, planPath } = await fixture()
    const image = path.join(dir, 'scene-1.png')
    await writeValidImage(image)
    await checkpointSceneImage(planPath, 'scene-1', image, 'Prompt one', false)
    await withLock(planPath, async () => {
      const plan = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
      plan.scenes[0]!.motion_choice = 'still'
      await fs.writeFile(planPath, JSON.stringify(plan), 'utf-8')
    })
    const plan = await checkpointSceneImage(planPath, 'scene-1', image, 'Prompt one', true)
    assert.equal(plan.scenes[0]?.motion_choice, 'still')
    assert.equal(plan.scenes[0]?.approved, true, 'an auto-approve job approves the image it generated')
  })

  it('a regenerated image (new bytes) waits for approval even if the old one was approved', async () => {
    // Existing semantics, kept on purpose: approval belongs to the picture the owner looked at.
    const { dir, planPath } = await fixture()
    const image = path.join(dir, 'scene-1.png')
    await writeValidImage(image)
    await checkpointSceneImage(planPath, 'scene-1', image, 'Prompt one', false)
    await ownerSetApproved(planPath, 'scene-1', true)
    await writeVariantImage(image)
    const plan = await checkpointSceneImage(planPath, 'scene-1', image, 'Prompt one', false)
    assert.equal(plan.scenes[0]?.approved, false)
  })

  it('without an auto-approve render, a filled-in image waits for approval', async () => {
    const { dir, planPath } = await fixture()
    const image2 = path.join(dir, 'scene-2.png')
    await writeValidImage(image2)
    const plan = await checkpointSceneImage(planPath, 'scene-2', image2, 'Prompt two', false)
    assert.equal(plan.scenes.find(scene => scene.id === 'scene-2')?.approved, false)
    assert.equal(await countScenesAwaitingApproval(planPath), 1, 'scene 1 has no image yet, so only scene 2 waits on the owner')
  })

  it('keeps concurrent image registrations for different scenes', async () => {
    const { dir, planPath } = await fixture()
    const image1 = path.join(dir, 'scene-1.png')
    const image2 = path.join(dir, 'scene-2.png')
    await Promise.all([writeValidImage(image1), writeValidImage(image2)])

    await Promise.all([
      checkpointSceneImage(planPath, 'scene-1', image1, 'Prompt one'),
      checkpointSceneImage(planPath, 'scene-2', image2, 'Prompt two'),
    ])

    const saved = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
    assert.equal(saved.scenes[0]?.image_path, image1)
    assert.equal(saved.scenes[1]?.image_path, image2)
    assert.equal(saved.scenes[0]?.approved, false)
    assert.equal(saved.scenes[1]?.approved, false)
  })

  it('auto-approves only after a non-empty generated image is verified and registered', async () => {
    const { dir, planPath } = await fixture()
    const image = path.join(dir, 'scene-1.png')
    await writeValidImage(image)

    await checkpointSceneImage(planPath, 'scene-1', image, 'Prompt one', true)

    const saved = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
    assert.equal(saved.scenes[0]?.image_path, image)
    assert.equal(saved.scenes[0]?.approved, true)
  })

  it('rejects an empty media file without changing the plan', async () => {
    const { dir, planPath } = await fixture()
    const empty = path.join(dir, 'empty.png')
    await fs.writeFile(empty, '')
    await assert.rejects(checkpointSceneImage(planPath, 'scene-1', empty, 'Prompt one', true), /usable file/)
    const saved = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
    assert.equal(saved.scenes[0]?.image_path, undefined)
    assert.equal(saved.scenes[0]?.approved, false)
  })

  it('rejects a non-empty truncated image without changing the plan', async () => {
    const { dir, planPath } = await fixture()
    const corrupt = path.join(dir, 'corrupt.png')
    await fs.writeFile(corrupt, ONE_PIXEL_PNG.subarray(0, 40))
    await assert.rejects(checkpointSceneImage(planPath, 'scene-1', corrupt, 'Prompt one', true), /corrupt or incomplete/)
    const saved = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
    assert.equal(saved.scenes[0]?.image_path, undefined)
    assert.equal(saved.scenes[0]?.approved, false)
  })

  it('fails loudly when a paid result no longer has a matching scene', async () => {
    const { dir, planPath } = await fixture()
    const image = path.join(dir, 'orphan.png')
    await writeValidImage(image)
    await assert.rejects(checkpointSceneImage(planPath, 'missing', image, 'Prompt'), /disappeared/)
  })

  it('registers a verified clip with its prompt and image version', async () => {
    const { dir, planPath } = await fixture()
    const clip = path.join(dir, 'scene-1.mp4')
    await fs.writeFile(clip, tinyVideoBytes())
    await checkpointSceneClip(planPath, 'scene-1', clip, 'Slow push in', 'image-v1', true)
    const saved = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
    assert.equal(saved.scenes[0]?.clip_path, clip)
    assert.equal(saved.scenes[0]?.rendered_motion_prompt, 'Slow push in')
    assert.equal(saved.scenes[0]?.clip_source_image_version, 'image-v1')
    assert.equal(saved.scenes[0]?.motion_choice, 'clip')
  })

  it('keeps a Still choice saved while an auto-approved clip completion is deferred', async () => {
    const { dir, planPath } = await fixture()
    const clip = path.join(dir, 'scene-1.mp4')
    await fs.writeFile(clip, tinyVideoBytes())
    const choiceWriteEntered = deferred()
    const releaseChoiceWrite = deferred()
    const chooseStill = withLock(planPath, async () => {
      choiceWriteEntered.resolve()
      await releaseChoiceWrite.promise
      const plan = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
      plan.scenes[0]!.motion_choice = 'still'
      await fs.writeFile(planPath, JSON.stringify(plan))
    })
    await choiceWriteEntered.promise

    const completion = checkpointSceneClip(
      planPath,
      'scene-1',
      clip,
      'Slow push in',
      'image-v1',
      true,
      { requested_duration_seconds: 1, duration_seconds: 1, shortfall_mode: 'hold' },
    )
    releaseChoiceWrite.resolve()
    await Promise.all([chooseStill, completion])

    const saved = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
    assert.equal(saved.scenes[0]?.motion_choice, 'still')
    assert.equal(saved.scenes[0]?.clip_path, clip)
    assert.equal(saved.scenes[0]?.rendered_motion_prompt, 'Slow push in')
    assert.equal(saved.scenes[0]?.clip_source_image_version, 'image-v1')
    assert.equal(saved.scenes[0]?.clip_requested_duration_seconds, 1)
    assert.equal(saved.scenes[0]?.clip_duration_seconds, 1)
    assert.equal(saved.scenes[0]?.clip_shortfall_mode, 'hold')
  })

  it('records a Follow narration clip receipt and its required final-frame hold', async () => {
    const { dir, planPath } = await fixture()
    const clip = path.join(dir, 'scene-1.mp4')
    await fs.writeFile(clip, tinyVideoBytes())

    await checkpointSceneClip(planPath, 'scene-1', clip, 'Slow push in', 'image-v1', true, {
      requested_duration_seconds: 1,
      duration_seconds: 1,
      shortfall_mode: 'hold',
    })

    const saved = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
    assert.equal(saved.scenes[0]?.clip_requested_duration_seconds, 1)
    assert.equal(saved.scenes[0]?.clip_duration_seconds, 1)
    assert.equal(saved.scenes[0]?.clip_shortfall_mode, 'hold')
  })

  it('audits canonical, empty, missing, and removed scene images', async () => {
    const { dir, planPath } = await fixture()
    const canonicalDir = path.join(dir, 'images')
    await fs.mkdir(canonicalDir)
    await writeValidImage(path.join(canonicalDir, 'scene-1.png'))
    await fs.writeFile(path.join(canonicalDir, 'scene-2.png'), '')

    const audit = await auditSceneImageCompletion(
      planPath,
      ['scene-1', 'scene-2', 'scene-3'],
      [canonicalDir],
    )
    assert.deepEqual(audit, {
      expected: 3,
      completed: 1,
      missing: [],
      invalid: ['scene-2 (empty image)', 'scene-3 (missing from scene plan)'],
      issues: [
        { item_id: 'scene-2', state: 'invalid', reason: 'empty image' },
        { item_id: 'scene-3', state: 'invalid', reason: 'missing from scene plan' },
      ],
    })
  })

  it('rejects stale, empty, and unselected motion clips', async () => {
    const { dir, planPath } = await fixture()
    const clipsDir = path.join(dir, 'clips')
    await fs.mkdir(clipsDir)
    await fs.writeFile(path.join(clipsDir, 'scene-1.mp4'), 'clip-one')
    await fs.writeFile(path.join(clipsDir, 'scene-2.mp4'), '')
    const plan = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
    plan.scenes[0]!.motion_prompt = 'Slow push in'
    plan.scenes[0]!.rendered_motion_prompt = 'Different prompt'
    plan.scenes[0]!.motion_choice = 'clip'
    await fs.writeFile(planPath, JSON.stringify(plan))

    const audit = await auditSceneClipCompletion(planPath, ['scene-1', 'scene-2'], clipsDir)
    assert.deepEqual(audit, {
      expected: 2,
      completed: 0,
      missing: [],
      invalid: ['scene-1 (stale motion prompt)', 'scene-2 (empty clip)'],
      issues: [
        { item_id: 'scene-1', state: 'invalid', reason: 'stale motion prompt' },
        { item_id: 'scene-2', state: 'invalid', reason: 'empty clip' },
      ],
    })
  })

  it('treats a scoped scene changed to Still as complete without a clip', async () => {
    const { dir, planPath } = await fixture()
    const clipsDir = path.join(dir, 'clips')
    await fs.mkdir(clipsDir)
    const plan = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
    plan.scenes[0]!.motion_choice = 'still'
    await fs.writeFile(planPath, JSON.stringify(plan))

    const audit = await auditSceneClipCompletion(planPath, ['scene-1'], clipsDir)

    assert.deepEqual(audit, {
      expected: 1,
      completed: 1,
      missing: [],
      invalid: [],
      issues: [],
    })
  })
})
