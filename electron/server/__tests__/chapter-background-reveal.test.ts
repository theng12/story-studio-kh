/**
 * A reveal-enabled chapter boundary still draws its heading (release 1.4.386).
 *
 * The reveal branch used to return before the chapter-title drawtext and the
 * chapter-background overlay were built, so a chapter that opened on a revealed
 * scene silently lost its heading. Pinned here:
 *   - the reveal clip is still rendered by the reveal engine;
 *   - the heading filters and the pool background are drawn onto that clip in
 *     one second pass, with the background under the heading for the same
 *     title window;
 *   - the scene's final clip is the heading-bearing `scene_XXXX.mp4`, not the
 *     bare reveal clip, and the serial pool record still runs once.
 *
 * What this cannot catch: how the composed frame looks. That is a frame check,
 * not an argv assertion.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { useTempDataDir } from './_helpers.js'
import { tinyVideoBytes } from './fixtures/tiny-video.js'

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

const scratch: string[] = []
after(async () => {
  await Promise.all(scratch.map(dir => fs.rm(dir, { recursive: true, force: true }).catch(() => {})))
})

test('a reveal-enabled chapter boundary draws its heading and pool background', async () => {
  const isolated = await useTempDataDir()
  try {
    const pm = await import('../services/project-manager.js')
    const pool = await import('../services/chapter-background-pool.js')
    const { prepareSceneClips } = await import('../generators/video.js')
    const { resolveSceneReveals } = await import('../lib/reveal-assembly.js')

    const project = await pm.createProject({ name: 'RevealChapterHeading' })
    const bgDir = path.join(pm.getProjectDir(project.slug)!, 'backgrounds')
    await fs.mkdir(bgDir, { recursive: true })
    await fs.writeFile(path.join(bgDir, 'one.png'), ONE_PIXEL_PNG)
    await pool.updateChapterBackgroundPool(project.slug, [
      { id: 'one', name: 'one', reference: 'one.png', enabled: true },
    ])

    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chapter-background-reveal-'))
    scratch.push(workDir)
    const still = path.join(workDir, 'still.png')
    await fs.writeFile(still, ONE_PIXEL_PNG)

    const plan = resolveSceneReveals({
      scenes: [{ scene_id: 'scene-1', scene_index: 0, window_seconds: 12, narration_seconds: 12 }],
      settings: { enabled: true, seed: 8, pace: 'slow' },
    })
    const sceneDuration = plan.durations[0]!

    const revealArgs: string[][] = []
    const sceneArgs: string[][] = []
    const job = {
      job_id: 'chapter-background-reveal', project_slug: project.slug, type: 'video_assembly', episode_id: 'EP0001',
      title: 'chapter-background-reveal', status: 'running', created_at: new Date().toISOString(),
      started_at: null, finished_at: null, error: null, output_lines: [], params: {},
    } as any

    const clips = await prepareSceneClips(
      [{ image_path: still, duration: sceneDuration, title: 'Chapter One', show_title: true }] as any,
      { type: 'none' } as any,
      { enabled: true, style: 'white', position: 'bottom', duration: 2.5, font_size: 'medium', animation: 'none' } as any,
      128, 96, { crf: 23, preset: 'medium', fps: 5 }, workDir, true,
      { seconds_per_scene: sceneDuration, shuffle: false, excluded_scenes: [] }, job,
      {
        pool: [], randomizeMode: 'off', seed: 7, reveals: plan, crf: 23,
        chapterBackgrounds: { slug: project.slug, episodeCode: 'EP0001', byIndex: new Map([[0, 'setup']]) },
      },
      [sceneDuration], 0, [],
      {
        checkpoint: {
          version: 1, job_id: job.job_id, project_slug: project.slug, episode_id: 'EP0001', work_dir: workDir,
          render_fingerprint: 'a'.repeat(64), completed_scene_clips: [],
        },
        renderFingerprint: 'a'.repeat(64),
        runRevealClip: async (args: string[]) => {
          revealArgs.push(args)
          await fs.writeFile(args.at(-1)!, tinyVideoBytes())
        },
        encodeSceneClip: async (args: string[]) => {
          sceneArgs.push(args)
          await fs.writeFile(args.at(-1)!, tinyVideoBytes())
        },
      } as any,
    )

    assert.equal(revealArgs.length, 1, 'the scene still renders through the reveal engine')
    assert.equal(sceneArgs.length, 1, 'one second pass draws the heading onto the reveal clip')
    const overlay = sceneArgs[0]!.join(' ')
    assert.match(overlay, /drawtext=text='Chapter One'/, 'the chapter heading is drawn')
    assert.match(overlay, /overlay=enable='lt\(t,2\.5\)'/, 'the pool background is drawn under the heading for the title window')
    assert.match(overlay, /one\.png/, 'the chapter pool pick reaches the filter graph')
    assert.match(clips[0]!, /scene_0000\.mp4$/, 'the heading-bearing clip is the scene clip')
    assert.match(job.output_lines.join(' | '), /Chapter background "one" → "setup"/, 'the serial pool record still runs once')
  } finally {
    await isolated.cleanup()
  }
})
