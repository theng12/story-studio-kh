/**
 * Sketch Draw provenance survived the 2026-10-28 restart — the freshness rule could not read it.
 *
 * Production ran four `scene_clips_batch` Sketch Draw jobs on 1.4.366, restarted the app under
 * them, and every resumed job rendered all its clips and then finished
 * "0/N required item(s) verified … Sketch Draw cannot verify its source image here"
 * (`restart-recovery-20261028/monitor/receipts/clip-verify-defect-20261028T154406Z.json`).
 *
 * Nothing was lost. The persisted plan held `clip_source_image_sha256` and `clip_sketch` on
 * 365/365 (refinanced EP0018) and 201/201 (brain-wise EP0050) scenes, and the MP4s were on disk.
 * What was missing is `image_sha256`: that stamp is only written when an image is REGISTERED, it
 * arrived on 2026-10-16, and every image in these episodes was generated on 2026-09-03 — so those
 * scenes have no image stamp and never will, because nothing rewrites a stored plan.
 *
 * `sceneClipStaleReason` needs a source image to hash in exactly that case, and every multi-scene
 * caller (the batch's completion audit, the restart auditor, Motion Review, episode status) passed
 * a context with no image at all. The rule therefore answered "cannot verify" for clips it had
 * complete proof for. The renderer never hit this because it hands the rule its one scene's image;
 * the batch checked eligibility behind `scene.image_sha256` and re-rendered all 1,310 clips.
 *
 * These tests build the EXACT production scene shape — no `image_sha256`, helper 4, 30 fps,
 * 124 frames, a 4.12 s window, 62 hold frames — and drive it through the real code path.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'

import {
  auditSceneClipCompletion, resolveSketchDrawSettings, revealTypeFor, sceneClipStaleReason, sketchHoldFramesFor,
  type SketchDrawSettings,
} from '../services/scene-media-checkpoint.js'
import { generateSketchDrawBatch, resolveVideoAssetsDir } from '../generators/scene-clip.js'
import { resolveSceneImagesDir } from '../generators/scene-image.js'
import { resolveEpisodePathsByCode, resolveScenePlanPath } from '../services/utils.js'
import { DEFAULT_SKETCH_REVEAL } from '../lib/sketch-reveal.js'
import { runFfmpeg } from '../lib/ffmpeg-utils.js'
import { NATIVE_SCENE_CLIP_VERSION } from '../lib/native-scene-clip-version.js'
import { useTempDataDir } from './_helpers.js'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const CHANGED_PNG = Buffer.concat([PNG, Buffer.from('re-rendered')])
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
/** The 4.12 s scene of the production sample: 4.12 × 30 fps = 123.6 → 124 frames. */
const WINDOW = 4.12

const CANNOT_VERIFY = 'Sketch Draw cannot verify its source image here. Open Motion Review and Retry.'

let data: { dir: string; cleanup: () => Promise<void> }

before(async () => { data = await useTempDataDir() })
after(async () => { await data.cleanup() })

interface Fixture {
  slug: string
  episodeId: string
  episodeDir: string
  imagesDir: string
  clipsDir: string
  planPath: string
  settings: SketchDrawSettings
  frames: number
}

/**
 * A channel + accepted episode whose three scenes are the production shape:
 * `ep0018-scene-0001` recoverable (no image stamp, matching image), `ep0018-scene-0002` whose
 * image was replaced after the clip was drawn, and `ep0018-scene-0003` whose receipt never
 * recorded a source sha at all.
 */
async function productionEpisode(name: string): Promise<Fixture> {
  const pm = await import('../services/project-manager.js')
  const ideas = await import('../services/idea-manager.js')
  const project = await pm.createProject({ name, episode_prefix: 'EP', episode_digits: 4 })
  const [idea] = await ideas.addIdeas(project.slug, [{
    title: 'Restart fixture', logline: 'A deterministic provenance fixture.', themes: [],
    suggested_chapters: 1, suggested_length: 'short', mood: 'neutral',
  }], 'mock-chat-v1')
  assert.ok(idea)
  const accepted = await ideas.acceptIdea(project.slug, idea.id, false)
  const paths = await resolveEpisodePathsByCode(project.slug, accepted.episode_code)
  const episodeId = accepted.episode_code
  const imagesDir = await resolveSceneImagesDir(project.slug, episodeId.toUpperCase(), paths.episode_dir)
  const clipsDir = await resolveVideoAssetsDir(project.slug, episodeId.toUpperCase(), paths.episode_dir)
  await fs.mkdir(paths.scene_prompts_dir, { recursive: true })
  await fs.mkdir(imagesDir, { recursive: true })
  await fs.mkdir(clipsDir, { recursive: true })

  // The channel never chose a pen, hold or reveal, so the episode renders at the app's default
  // frame rate and canvas — 30 fps at 1920×1080, which is exactly what production recorded.
  const settings = await resolveSketchDrawSettings(project.slug, episodeId)
  assert.equal(settings.fps, 30)
  const frames = Math.round(WINDOW * settings.fps)
  assert.equal(frames, 124, 'the production sample is a 4.12 s scene at 30 fps')

  const ids = ['ep0018-scene-0001', 'ep0018-scene-0002', 'ep0018-scene-0003']
  for (const id of ids) await fs.writeFile(path.join(imagesDir, `${id}.png`), PNG)
  // The replaced image of scene 2: same path, different bytes.
  await fs.writeFile(path.join(imagesDir, 'ep0018-scene-0002.png'), CHANGED_PNG)

  // One real clip, shared by the three scenes: the audit decodes every Sketch Draw clip it counts.
  const clip = path.join(clipsDir, `${ids[0]}.mp4`)
  await runFfmpeg(['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=red:s=${settings.width}x${settings.height}:r=${settings.fps}:d=${frames / settings.fps}`,
    '-t', String(frames / settings.fps), '-frames:v', String(frames), '-r', String(settings.fps),
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', clip])
  const clipBytes = await fs.readFile(clip)
  for (const id of ids.slice(1)) await fs.writeFile(path.join(clipsDir, `${id}.mp4`), clipBytes)

  const receiptFor = (id: string) => ({
    helper_version: NATIVE_SCENE_CLIP_VERSION, fps: settings.fps, frames,
    width: settings.width, height: settings.height,
    pen_fingerprint: settings.penFingerprint,
    hold_frames: sketchHoldFramesFor(settings, episodeId, id, frames),
    hold_fingerprint: settings.holdFingerprint,
    // What the generator would record: resolved from this episode's own scene order, never guessed.
    reveal_type: revealTypeFor(settings.reveal ?? DEFAULT_SKETCH_REVEAL,
      { slug: project.slug, episodeId, episodeDir: paths.episode_dir, revealScenes: ids }, id)!,
  })
  const scene = (id: string, over: Record<string, unknown> = {}) => ({
    id, scene_index: ids.indexOf(id) + 1, start_sec: 0, end_sec: WINDOW,
    transcript_segment: 'The blue light from my monitor is the only thing illuminating the office.',
    visual_prompt: 'A silhouette at a desk in the cool blue glow of a monitor.',
    rendered_prompt: 'A silhouette at a desk in the cool blue glow of a monitor.',
    image_path: path.join(imagesDir, `${id}.png`),
    image_version: '2026-09-03T20:57:17.036Z',
    // NOTE: no `image_sha256`. That is the defect shape, not an omission in the fixture.
    motion_choice: 'clip', approved: true,
    clip_renderer: 'sketch_draw',
    clip_source_image_sha256: sha(PNG),
    clip_scene_window_seconds: WINDOW,
    clip_sketch: receiptFor(id),
    clip_path: path.join(clipsDir, `${id}.mp4`),
    rendered_motion_prompt: '',
    clip_duration_seconds: frames / settings.fps,
    clip_shortfall_mode: 'hold',
    ...over,
  })
  const planPath = await resolveScenePlanPath(project.slug, episodeId, paths.episode_dir)
  await fs.writeFile(planPath, JSON.stringify({
    schema_version: 1,
    scenes: [
      scene(ids[0]!),
      scene(ids[1]!),
      // A clip from before receipts carried a source sha: nothing to compare, so nothing to prove.
      scene(ids[2]!, { clip_source_image_sha256: undefined, clip_sketch: { ...receiptFor(ids[2]!), helper_version: 2 } }),
    ],
  }, null, 1))
  return { slug: project.slug, episodeId, episodeDir: paths.episode_dir, imagesDir, clipsDir, planPath, settings, frames }
}

/** The context the batch's completion audit and Motion Review build: no single scene's image. */
const auditContext = (fixture: Fixture) => ({ slug: fixture.slug, episodeId: fixture.episodeId, episodeDir: fixture.episodeDir })

describe('Sketch Draw provenance without a recorded image stamp', () => {
  test('a clip whose scene image predates image_sha256 is proven from the file, not called unknowable', async () => {
    const fixture = await productionEpisode('Provenance complete')
    const plan = JSON.parse(await fs.readFile(fixture.planPath, 'utf8'))
    // The exact defect: the plan has the clip's receipt and no image stamp.
    assert.equal(plan.scenes[0].image_sha256, undefined)
    assert.equal(plan.scenes[0].clip_source_image_sha256, sha(PNG))
    assert.equal(await sceneClipStaleReason(plan.scenes[0], auditContext(fixture)), null)
  })

  test('a batch audit verifies the episode it has receipts for, and names only the scenes it cannot', async () => {
    const fixture = await productionEpisode('Provenance partial')
    const audit = await auditSceneClipCompletion(fixture.planPath,
      ['ep0018-scene-0001', 'ep0018-scene-0002', 'ep0018-scene-0003'], fixture.clipsDir, {}, auditContext(fixture))
    // Complete in the sense the audit counts: three clips present, only one of them provable.
    assert.equal(audit.expected, 3)
    assert.equal(audit.completed, 1)
    assert.deepEqual(audit.missing, [])
    assert.deepEqual(audit.invalid, [
      // The image was replaced after this clip was drawn: stale, and it says which fact is wrong.
      'ep0018-scene-0002 (stale source image)',
      // This clip recorded no source sha, so there is nothing to compare and nothing to claim.
      `ep0018-scene-0003 (${CANNOT_VERIFY})`,
    ])
  })

  test('a scene whose image is gone stays stale, and the reason names the missing image', async () => {
    const fixture = await productionEpisode('Provenance missing image')
    await fs.rm(path.join(fixture.imagesDir, 'ep0018-scene-0001.png'))
    const plan = JSON.parse(await fs.readFile(fixture.planPath, 'utf8'))
    assert.equal(await sceneClipStaleReason(plan.scenes[0], auditContext(fixture)), 'source image is missing')
    // A rule with no episode context at all still refuses to guess, exactly as before.
    assert.equal(await sceneClipStaleReason(plan.scenes[0]), CANNOT_VERIFY)
  })

  /**
   * AGENTS §4: ownership is a fact to look up, not a string to parse. `image_path` is a stored
   * string that can name another scene's or another episode's file, and its bytes may even match
   * the clip's receipt (a copied translation, a hand-edited plan). The proof must hash the scene's
   * OWN image, resolved by `scene.id` the way the renderer draws it — never the stored path.
   */
  test('a clip is proven against its own image, never the stored image_path', async () => {
    const fixture = await productionEpisode('Provenance foreign path')
    const plan = JSON.parse(await fs.readFile(fixture.planPath, 'utf8'))
    const ownOne = path.join(fixture.imagesDir, 'ep0018-scene-0001.png')
    const ownTwo = path.join(fixture.imagesDir, 'ep0018-scene-0002.png')
    const foreignEpisodeImage = path.join(data.dir, 'another-episode', 'ep0018-scene-0001.png')
    await fs.mkdir(path.dirname(foreignEpisodeImage), { recursive: true })
    await fs.writeFile(foreignEpisodeImage, CHANGED_PNG)

    // Scene 1's stored `image_path` names ANOTHER episode's image whose bytes match the clip's
    // receipt; its own image (by id) does not. Trusting the string would call a foreign picture the
    // clip's source and accept a clip that was not drawn from this scene's image.
    plan.scenes[0].image_path = foreignEpisodeImage
    plan.scenes[0].clip_source_image_sha256 = sha(CHANGED_PNG)
    // The mirror: scene 2's stored path names ANOTHER scene's image, while its own image matches.
    plan.scenes[1].image_path = ownOne
    plan.scenes[1].clip_source_image_sha256 = sha(CHANGED_PNG)
    await fs.writeFile(fixture.planPath, JSON.stringify(plan, null, 1))

    // The fixture proves the trap is real: the stored paths match the receipts, the own images do not.
    assert.equal(sha(await fs.readFile(foreignEpisodeImage)), plan.scenes[0].clip_source_image_sha256)
    assert.notEqual(sha(await fs.readFile(ownOne)), plan.scenes[0].clip_source_image_sha256)
    assert.equal(sha(await fs.readFile(ownTwo)), plan.scenes[1].clip_source_image_sha256)
    assert.notEqual(sha(await fs.readFile(ownOne)), plan.scenes[1].clip_source_image_sha256)

    assert.equal(await sceneClipStaleReason(plan.scenes[0], auditContext(fixture)), 'stale source image',
      'a foreign file matching the receipt must never prove this clip')
    assert.equal(await sceneClipStaleReason(plan.scenes[1], auditContext(fixture)), null,
      'the scene’s own matching image proves it, whatever its stored path says')

    // The same verdict through the real completion audit, which resolves each scene's own image.
    const audit = await auditSceneClipCompletion(fixture.planPath,
      ['ep0018-scene-0001', 'ep0018-scene-0002'], fixture.clipsDir, {}, auditContext(fixture))
    assert.equal(audit.completed, 1)
    assert.deepEqual(audit.invalid, ['ep0018-scene-0001 (stale source image)'])
  })
})

describe('A resumed Sketch Draw batch after a restart', () => {
  test('re-verifies the clips already on disk and renders nothing', async () => {
    const fixture = await productionEpisode('Provenance resume')
    const renders: unknown[] = []
    const job = {
      job_id: 'resume-fixture', project_slug: fixture.slug, output_lines: [] as string[], progress: 0,
      params: {
        episode_id: fixture.episodeId, motion_scene_ids: ['ep0018-scene-0001'],
        auto_approve_clip: true,
      },
    }
    const before = await fs.readFile(fixture.planPath)

    await generateSketchDrawBatch(job as any, (async () => {
      renders.push('render')
      throw new Error('a raw render must never run for a clip that is already provable')
    }) as any)

    assert.deepEqual(renders, [], 'the resumed batch rendered a clip it already had')
    assert.equal(job.progress, 100)
    const result = (job as any).result
    assert.equal(result?.complete, true)
    assert.equal(result?.completion?.completed, 1)
    assert.match(job.output_lines.join('\n'), /already has a fresh, selected Sketch Draw clip/)
    // Nothing rewrote the plan: a verification is a read.
    assert.deepEqual(await fs.readFile(fixture.planPath), before)
  })

  test('re-renders only the scene whose image changed, and never the provable ones', async () => {
    const fixture = await productionEpisode('Provenance resume partial')
    const renders: string[] = []
    const job = {
      job_id: 'resume-partial-fixture', project_slug: fixture.slug, output_lines: [] as string[], progress: 0,
      params: {
        episode_id: fixture.episodeId, motion_scene_ids: ['ep0018-scene-0001', 'ep0018-scene-0002'],
        auto_approve_clip: true,
      },
    }
    await assert.rejects(
      generateSketchDrawBatch(job as any, (async () => {
        renders.push('render')
        throw new Error('render attempted in the fixture')
      }) as any),
      // One verified clip is kept; the batch fails loudly and names only the scene it lacks.
      /1\/2 required item\(s\) verified[\s\S]*ep0018-scene-0002/,
    )
    assert.equal(renders.length, 1, 'exactly one scene — the stale one — was offered to the renderer')
    assert.doesNotMatch(job.output_lines.join('\n'), /ep0018-scene-0001 failed/)
  })
})
