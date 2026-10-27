/**
 * Owner answers, 2026-10-27 — the five decisions that finish the video expansion on
 * `feat/story-video-plan-20261027`:
 *
 *   1. the 25% / opening-hook video share is the CONTROL's starting value for every channel,
 *      new or existing, and an episode that never saved a scope is Off (owner, 2026-10-27);
 *   2. a text-to-video scene is approved in Motion Review, never in Scene Review;
 *   3. the planner SUGGESTS key moments, and the customer's own mark always wins;
 *   4. the dead legacy `generators/ai-video.ts` generator is gone;
 *   5. Story enables no video model itself — the live catalogue's `available` is the only gate.
 */
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'

const readJsonFile = async (file: string) => JSON.parse(await fs.readFile(file, 'utf-8'))

let cleanup: () => Promise<void>
let app: any
let pm: typeof import('../services/project-manager.js')
let projectsRoot: () => string

const EP = 'EP001'
let slug: string
let episodeDir: string

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  await fs.mkdir(path.join(temp.dir, 'projects'), { recursive: true })
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'

  app = (await import('../app.js')).app
  pm = await import('../services/project-manager.js')
  projectsRoot = pm.projectsRoot

  const created = await request(app).post('/api/projects').send({
    name: 'Video Plan Answers', episode_prefix: 'EP', episode_digits: 3,
  })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  slug = created.body.slug

  const { resolveEpisodePathsByCode } = await import('../services/utils.js')
  episodeDir = (await resolveEpisodePathsByCode(slug, EP)).episode_dir
  await fs.mkdir(episodeDir, { recursive: true })
})

after(async () => { await cleanup() })

// ── 1. Share default, OFF at the start ──────────────────────────────────────

describe('the video share starts at 25%, and an episode with no saved scope is Off', () => {
  test('the 25% / opening-hook value is the control’s default, and no channel stores it', async () => {
    const { DEFAULT_MOTION_SCOPE } = await import('../contracts/motion-scope.js')
    assert.deepEqual(DEFAULT_MOTION_SCOPE, { mode: 'share', share_percent: 25, formula: 'opening_hook' })
    const config = await readJsonFile(path.join(projectsRoot(), slug, 'config.json'))
    assert.equal('default_motion_scope' in config, false,
      'a starting value of the control is never written into a channel (§5)')
  })

  test('an episode with no saved scope is Off — it authorizes no motion', async () => {
    const { readEpisodeMotionScope, resolveEpisodeMotionSceneIds } = await import('../services/episode-motion-scope.js')
    const scope = await readEpisodeMotionScope(slug, EP, episodeDir)
    assert.deepEqual(scope.motion_scope, { mode: 'off' },
      'owner, 2026-10-27: existing channels default to 25% in the CONTROL, but every episode starts OFF')
    const plan = [
      { id: 's1', start_sec: 0, end_sec: 8 },
      { id: 's2', start_sec: 8, end_sec: 16 },
    ]
    const resolved = await resolveEpisodeMotionSceneIds(slug, EP, plan, episodeDir)
    assert.deepEqual(resolved.scene_ids, [], 'nothing is in this episode’s motion scope')
    assert.deepEqual(resolved.crossing_scene_ids, [])
  })

  test('a continuity record without a scope is still Off, not the 25% default', async () => {
    const { readEpisodeMotionScope } = await import('../services/episode-motion-scope.js')
    const sidecar = path.join(episodeDir, 'continuity.json')
    await fs.writeFile(sidecar, JSON.stringify({ schema_version: 1, motion_level: 3 }))
    try {
      const scope = await readEpisodeMotionScope(slug, EP, episodeDir)
      assert.deepEqual(scope.motion_scope, { mode: 'off' })
      assert.equal(scope.motion_level, 3)
    } finally {
      await fs.unlink(sidecar).catch(() => {})
    }
  })

  test("an episode's own saved scope wins, and is never overwritten by the default", async () => {
    const { readEpisodeMotionScope } = await import('../services/episode-motion-scope.js')
    const sidecar = path.join(episodeDir, 'continuity.json')
    await fs.writeFile(sidecar, JSON.stringify({ motion_scope: { mode: 'all' }, motion_level: 3 }))
    try {
      const scope = await readEpisodeMotionScope(slug, EP, episodeDir)
      assert.deepEqual(scope.motion_scope, { mode: 'all' }, "the customer's own answer is read back")
      assert.equal(scope.motion_level, 3)
    } finally {
      await fs.unlink(sidecar).catch(() => {})
    }
  })

  test('creating a second channel leaves the first channel config byte-identical', async () => {
    const before = await fs.readFile(path.join(projectsRoot(), slug, 'config.json'), 'utf-8')
    const created = await request(app).post('/api/projects').send({
      name: 'Another Channel', episode_prefix: 'AN', episode_digits: 3,
    })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    const after = await fs.readFile(path.join(projectsRoot(), slug, 'config.json'), 'utf-8')
    assert.equal(after, before, 'an existing channel is never rewritten')
  })
})

// ── 2. T2V approval ──────────────────────────────────────────────────────────

describe('a text-to-video scene is approved in Motion Review, not Scene Review', () => {
  test('Scene Review ignores T2V rows, and an all-T2V plan is complete there', async () => {
    const { inspectSceneReviewCompletion } = await import('../services/scene-review-completion.js')
    const scenes = [
      { id: 'still-1', approved: true, visual_lane: 'image_to_video' },
      { id: 't2v-1', approved: false, visual_lane: 'text_to_video' },
    ]
    const review = inspectSceneReviewCompletion(scenes, [true, true], true)
    assert.deepEqual(review.unapprovedIds, [], 'the T2V row is not Scene Review’s to approve')
    assert.deepEqual(review.missingImageIds, [])
    assert.deepEqual(review.motionOnlyIds, ['t2v-1'])
    assert.equal(review.complete, true)

    const allT2V = inspectSceneReviewCompletion([{ id: 't2v-2', visual_lane: 'text_to_video' }], [true], true)
    assert.equal(allT2V.complete, true, 'nothing for Scene Review to approve is still complete')
    assert.equal(inspectSceneReviewCompletion([], [], true).complete, false, 'no plan is not complete')
  })

  test('a still-lane scene without an approval still keeps Scene Review pending', async () => {
    const { inspectSceneReviewCompletion } = await import('../services/scene-review-completion.js')
    const review = inspectSceneReviewCompletion([
      { id: 'a', approved: false, visual_lane: 'image_to_video' },
      { id: 'b', approved: true, visual_lane: 'text_to_video' },
    ], [true, true], true)
    assert.deepEqual(review.unapprovedIds, ['a'])
    assert.equal(review.complete, false)
  })
})

// ── 3. Key moments: suggested, never decided ─────────────────────────────────

describe('the planner suggests key moments; the customer’s own mark wins', () => {
  test('the opening scene and narratively-significant boundaries are suggested', async () => {
    const { suggestKeyMoments } = await import('../services/scene-planner.js')
    const scenes = suggestKeyMoments([
      { id: 'a', scene_index: 1, start_sec: 0, end_sec: 8, transcript_segment: '', visual_prompt: '', boundary_reason: 'Opening' },
      { id: 'b', scene_index: 2, start_sec: 8, end_sec: 16, transcript_segment: '', visual_prompt: '', boundary_reason: 'Topic shift to the salt trade' },
      { id: 'c', scene_index: 3, start_sec: 16, end_sec: 24, transcript_segment: '', visual_prompt: '', boundary_reason: 'filler' },
    ] as any)
    assert.equal(scenes[0]!.key_moment_suggested, true, 'the opening scene is the hook')
    assert.equal(scenes[1]!.key_moment_suggested, true, 'a topic shift is a narrative beat')
    assert.equal(scenes[2]!.key_moment_suggested, false)
    assert.equal(scenes[1]!.key_moment, undefined, 'a suggestion is NEVER written as the customer’s mark')
  })

  test('a customer “no” beats a planner suggestion, and a customer “yes” beats no suggestion', async () => {
    const { resolveMotionScope } = await import('../contracts/motion-scope.js')
    const scenes = [
      { id: 'a', start_sec: 0, end_sec: 8, key_moment: false, key_moment_suggested: true },
      { id: 'b', start_sec: 8, end_sec: 16, key_moment: true, key_moment_suggested: false },
      { id: 'c', start_sec: 16, end_sec: 24 },
    ]
    // 100% needs both; the customer's answers decide which are key moments.
    const keyed = resolveMotionScope(scenes, { mode: 'share', share_percent: 100, formula: 'key_moments' })
    assert.deepEqual(keyed.scene_ids, ['a', 'b', 'c'], 'the budget still fills the whole plan')
    // 34% needs one key moment, and the customer's “yes” on b is honoured before the suggestion on a.
    const oneKey = resolveMotionScope([scenes[0]!, scenes[1]!], { mode: 'share', share_percent: 34, formula: 'key_moments' })
    assert.deepEqual(oneKey.scene_ids, ['b'],
      'a scene the customer turned OFF is not a key moment, even when the planner suggested it')
  })
})

// ── 4. Legacy generator is gone ──────────────────────────────────────────────

describe('the dead AI-video generator is deleted, not renamed', () => {
  test('nothing imports or registers it any more', async () => {
    const root = new URL('..', import.meta.url).pathname
    const walk = async (dir: string): Promise<string[]> => {
      const out: string[] = []
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) out.push(...await walk(full))
        else if (/\.ts$/.test(entry.name)) out.push(full)
      }
      return out
    }
    const offenders: string[] = []
    for (const file of await walk(root)) {
      if (file.endsWith('video-plan-owner-answers.test.ts')) continue // this check names the file by design
      const body = await fs.readFile(file, 'utf-8')
      if (/generators\/ai-video|generateAiVideo/.test(body)) offenders.push(path.relative(root, file))
    }
    assert.deepEqual(offenders, [], 'no file may reference the removed generator')
    await assert.rejects(fs.access(path.join(root, 'generators', 'ai-video.ts')), 'the generator file is gone')
  })
})

// ── 5. No Story-side video enablement ────────────────────────────────────────

describe('only the live catalogue decides whether a video model is usable', () => {
  test('an unavailable row never resolves, and an available row always does', async () => {
    const { resolveSceneClipCatalogModel } = await import('../generators/scene-clip.js')
    const rows = [
      { id: 'paid-wan-3', display_name: 'Wan 3.0', available: false, modes: ['text-to-video'], aspect_ratios: [], variants: [] },
      { id: 'seedance-2-5', display_name: 'Seedance 2.5', available: true, modes: ['text-to-video'], aspect_ratios: ['16:9'], variants: [] },
    ] as any[]
    assert.equal(resolveSceneClipCatalogModel('paid-wan-3', rows), null,
      'a paid model the Gateway has not switched on is not offered')
    assert.equal(resolveSceneClipCatalogModel('seedance-2-5', rows), 'seedance-2-5',
      'switching it on in the Gateway is the whole enablement — Story keeps no list')
  })

  test('no allowlist of model names exists in the client', async () => {
    const client = await fs.readFile(new URL('../lib/genstudio-client.ts', import.meta.url), 'utf-8')
    assert.doesNotMatch(client, /ALLOWED_PAID_VIDEO_MODELS|isAllowedVideoModel/,
      'a Story-side paid allowlist would duplicate the Gateway catalogue (§1)')
  })
})
