import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { tinyVideoBytes } from './fixtures/tiny-video.js'
import { getWorkTempDir, cleanOrphanWorkTempDirs } from '../lib/work-tempdir.js'
import {
  buildVideoAssemblyRenderFingerprint,
  collectProtectedVideoAssemblyWorkDirs,
  findReusableVideoAssemblySceneClips,
  getValidVideoAssemblyCheckpoint,
  type VideoAssemblyCheckpoint,
  type VideoAssemblyCompletedSceneClip,
} from '../lib/video-assembly-checkpoint.js'
import {
  createVideoAssemblyExecutionRequest,
  prepareSceneClips,
  resolveVideoAssemblySceneAnimation,
} from '../generators/video.js'
import type { Job } from '../models/types.js'

const createdDirs: string[] = []

after(async () => {
  await Promise.all(createdDirs.map(dir => fs.rm(dir, { recursive: true, force: true }).catch(() => {})))
})

function job(
  id: string,
  slug: string,
  episode: string,
  status: Job['status'],
  checkpoint: VideoAssemblyCheckpoint,
): Job {
  return {
    job_id: id,
    project_slug: slug,
    type: 'video_assembly',
    episode_id: episode,
    title: 'Video Assembly recovery fixture',
    status,
    created_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    finished_at: null,
    error: null,
    output_lines: [],
    params: {},
    result: { video_assembly_checkpoint: checkpoint },
  }
}

async function ownedDir(slug: string, episode: string): Promise<string> {
  const dir = await getWorkTempDir(slug, episode)
  createdDirs.push(dir)
  return dir
}

function checkpoint(
  id: string,
  slug: string,
  episode: string,
  workDir: string,
  fingerprint = 'a'.repeat(64),
): VideoAssemblyCheckpoint {
  return {
    version: 1,
    job_id: id,
    project_slug: slug,
    episode_id: episode,
    work_dir: workDir,
    render_fingerprint: fingerprint,
    completed_scene_clips: [],
  }
}

describe('Video Assembly checkpoint ownership', () => {
  test('accepts only the exact canonical job-owned work directory', async () => {
    const slug = `video-recovery-${process.pid}-owned`
    const episode = 'EP0001'
    const workDir = await ownedDir(slug, episode)
    const owned = job('video-owned', slug, episode, 'running', checkpoint('video-owned', slug, episode, workDir))

    assert.equal((await getValidVideoAssemblyCheckpoint(owned))?.work_dir, workDir)

    const escaped = structuredClone(owned)
    escaped.result!.video_assembly_checkpoint.work_dir = path.dirname(workDir)
    assert.equal(await getValidVideoAssemblyCheckpoint(escaped), null)

    const wrongOwner = structuredClone(owned)
    wrongOwner.result!.video_assembly_checkpoint.job_id = 'another-job'
    assert.equal(await getValidVideoAssemblyCheckpoint(wrongOwner), null)

    const wrongType = structuredClone(owned)
    wrongType.type = 'audio_merge'
    assert.equal(await getValidVideoAssemblyCheckpoint(wrongType), null)

    const traversal = structuredClone(owned)
    traversal.result!.video_assembly_checkpoint.completed_scene_clips = [{
      scene_index: 0,
      clip_path: `${workDir}${path.sep}nested${path.sep}..${path.sep}scene_0000.mp4`,
      render_duration_sec: 1,
    }]
    assert.equal(await getValidVideoAssemblyCheckpoint(traversal), null)

    const paused = structuredClone(owned)
    paused.status = 'paused'
    paused.pause_origin = 'manual'
    const terminal = structuredClone(owned)
    terminal.status = 'error'
    const protectedDirs = await collectProtectedVideoAssemblyWorkDirs([paused, wrongOwner, wrongType, terminal, null, 'malformed'])
    assert.deepEqual([...protectedDirs], [workDir])
  })

  test('rejects a symlinked work directory even when its lexical path looks owned', async () => {
    const slug = `video-recovery-${process.pid}-symlink`
    const episode = 'EP0002'
    const realDir = await ownedDir(`${slug}-target`, episode)
    const lexicalDir = await ownedDir(slug, episode)
    await fs.rm(lexicalDir, { recursive: true, force: true })
    await fs.symlink(realDir, lexicalDir)
    const owned = job('video-symlink', slug, episode, 'running', checkpoint('video-symlink', slug, episode, lexicalDir))

    assert.equal(await getValidVideoAssemblyCheckpoint(owned), null)
  })
})

describe('Video Assembly render fingerprint and scene reuse', () => {
  test('generateVideo wires authoritative resolved state into one stable recovery fingerprint', async () => {
    const source = await fs.readFile(new URL('../generators/video.ts', import.meta.url), 'utf8')
    const generate = source.slice(source.indexOf('export async function generateVideo'), source.indexOf('// ── Prepare Scene Clips'))
    const cloneAt = generate.indexOf('createVideoAssemblyExecutionRequest(params)')
    const authoritativeAt = generate.indexOf('prepareUnifiedVideoAssemblyInputs(')
    const pathsAt = generate.indexOf('resolveAssetPathsInPlace(req, outputRoot, job)')
    const snapshotAt = generate.indexOf('const renderFingerprintRequest = structuredClone(req)')
    const animationAt = generate.indexOf('resolveVideoAssemblySceneAnimation(req, req.scenes.length)')
    const fingerprintAt = generate.indexOf('buildVideoAssemblyRenderFingerprint({')
    const finalEncodeAt = generate.lastIndexOf('await runFinalComposition({')
    const finalPromoteAt = generate.lastIndexOf('await fs.rename(outputFile, finalPath)')
    const finalVerifyAt = generate.lastIndexOf('await verifyFinalVideo(job, resolvedOutputPath, finalName)')

    assert.ok(cloneAt >= 0 && cloneAt < authoritativeAt)
    assert.ok(authoritativeAt < pathsAt && pathsAt < snapshotAt)
    assert.ok(snapshotAt < animationAt && animationAt < fingerprintAt)
    assert.match(generate.slice(fingerprintAt, fingerprintAt + 1_200), /resolved_scene_animation: resolvedSceneAnimation/)
    assert.ok(finalEncodeAt < finalPromoteAt && finalPromoteAt < finalVerifyAt)
  })

  test('generator replay keeps durable params unchanged and resolves the same default animation choices', async () => {
    const durableParams = {
      episode_id: 'EP0003',
      scenes: [{ image_path: '/tmp/scene.png', duration: 4 }],
      narration_path: '/tmp/narration.mp3',
      merged_audio_path: '/tmp/narration.mp3',
      scene_recycling: { seconds_per_scene: 10, shuffle: false, excluded_scenes: [] },
      transition: 'fade',
      transition_duration: 1.5,
      resolution: '1080p',
      quality: 'medium',
      format: 'mp4',
      chapter_titles: { enabled: false },
      subtitles: { enabled: true, srt_path: '/tmp/captions.srt' },
      animation_pool: ['zoom', 'pan-left', 'pan-right'],
      animation_randomize: 'per-scene',
    } as any
    const durableSnapshot = structuredClone(durableParams)
    const firstRequest = createVideoAssemblyExecutionRequest(durableParams)
    const firstAnimation = resolveVideoAssemblySceneAnimation(firstRequest, 4)
    const firstFingerprint = await buildVideoAssemblyRenderFingerprint({
      request: firstRequest,
      resolved_scene_animation: firstAnimation,
    })

    // Representative mutations from the real pipeline must never leak back
    // into Job.params before its checkpoint is durably persisted.
    firstRequest.merged_audio_path = '/tmp/derived-sound-mix.mp3'
    firstRequest.subtitles!.hide_during_intro = true
    firstRequest.intro = { enabled: true, video_path: '/tmp/intro.mp4', duration: 12 } as any

    const replayRequest = createVideoAssemblyExecutionRequest(durableParams)
    const replayAnimation = resolveVideoAssemblySceneAnimation(replayRequest, 4)
    const replayFingerprint = await buildVideoAssemblyRenderFingerprint({
      request: replayRequest,
      resolved_scene_animation: replayAnimation,
    })
    assert.deepEqual(durableParams, durableSnapshot)
    assert.deepEqual(replayRequest, durableSnapshot)
    assert.equal(firstAnimation.seed, 7)
    assert.deepEqual(replayAnimation, firstAnimation)
    assert.equal(replayFingerprint, firstFingerprint)
  })

  test('changes when a resolved render input or setting changes', async () => {
    const slug = `video-recovery-${process.pid}-fingerprint`
    const sourceDir = await ownedDir(slug, 'EP0003')
    const source = path.join(sourceDir, 'scene.png')
    await fs.writeFile(source, 'first render source')

    const first = await buildVideoAssemblyRenderFingerprint({
      plan: [{ id: 'scene-1', order: 1, duration_sec: 4 }],
      request: { scenes: [{ image_path: source }], transition: 'fade', fps: 30 },
    })
    const settingChanged = await buildVideoAssemblyRenderFingerprint({
      plan: [{ id: 'scene-1', order: 1, duration_sec: 4 }],
      request: { scenes: [{ image_path: source }], transition: 'cut', fps: 30 },
    })
    await fs.writeFile(source, 'second, different render source')
    const sourceChanged = await buildVideoAssemblyRenderFingerprint({
      plan: [{ id: 'scene-1', order: 1, duration_sec: 4 }],
      request: { scenes: [{ image_path: source }], transition: 'fade', fps: 30 },
    })

    assert.notEqual(settingChanged, first)
    assert.notEqual(sourceChanged, first)
  })

  test('the real scene-prep stage reuses two clips, rebuilds a truncated third, and leaves partial finals inert', async () => {
    const slug = `video-recovery-${process.pid}-clips`
    const episode = 'EP0004'
    const workDir = await ownedDir(slug, episode)
    const fingerprint = 'b'.repeat(64)
    const paths = [0, 1, 2].map(index => path.join(workDir, `scene_${String(index).padStart(4, '0')}.mp4`))
    const sources = [0, 1, 2].map(index => path.join(workDir, `source_${index}.mp4`))
    const partialFinal = path.join(workDir, `${episode}_video_123.mp4`)
    const promotedFinal = path.join(workDir, `${episode}_final_video.mp4`)
    await Promise.all([
      ...sources.map(source => fs.writeFile(source, tinyVideoBytes())),
      fs.writeFile(paths[0]!, tinyVideoBytes()),
      fs.writeFile(paths[1]!, tinyVideoBytes()),
      fs.writeFile(paths[2]!, Buffer.alloc(0)),
      fs.writeFile(partialFinal, Buffer.from('not a final video')),
      fs.writeFile(path.join(workDir, 'intermediate_video.mp4'), tinyVideoBytes()),
    ])
    const saved = checkpoint('video-clips', slug, episode, workDir, fingerprint)
    saved.completed_scene_clips = paths.map((clipPath, sceneIndex) => ({
      scene_index: sceneIndex,
      clip_path: clipPath,
      render_duration_sec: 1,
    }))

    const expected = paths.map((clipPath, sceneIndex) => ({
      scene_index: sceneIndex,
      clip_path: clipPath,
      render_duration_sec: 1,
    }))
    assert.deepEqual(
      [...(await findReusableVideoAssemblySceneClips(saved, fingerprint, expected)).keys()],
      [0, 1],
    )
    assert.equal((await findReusableVideoAssemblySceneClips(saved, 'c'.repeat(64), expected)).size, 0)

    const encoded: string[] = []
    const persisted: VideoAssemblyCompletedSceneClip[][] = []
    const stageJob = job('video-clips', slug, episode, 'running', saved)
    const rendered = await prepareSceneClips(
      sources.map(source => ({ image_path: source, duration: 1 })) as any,
      { type: 'none', zoom_start: 100, zoom_end: 108, parallax_direction: 'right', parallax_speed: 2, breathe_amplitude: 2, breathe_base_zoom: 103 },
      { enabled: false } as any,
      128, 96,
      { crf: 23, preset: 'medium', fps: 5 },
      workDir,
      false,
      { seconds_per_scene: 1, shuffle: false, excluded_scenes: [] },
      stageJob,
      { pool: [], randomizeMode: 'off', seed: 7 },
      [1, 1, 1],
      0,
      [],
      {
        checkpoint: saved,
        renderFingerprint: fingerprint,
        encodeSceneClip: async args => {
          const output = args.at(-1)!
          encoded.push(output)
          await fs.writeFile(output, tinyVideoBytes())
        },
        persistCheckpoint: async persistedJob => {
          const value = persistedJob.result?.video_assembly_checkpoint as VideoAssemblyCheckpoint
          persisted.push(structuredClone(value.completed_scene_clips))
        },
      },
    )

    assert.deepEqual(rendered, paths)
    assert.deepEqual(encoded, [paths[2]])
    assert.deepEqual(saved.completed_scene_clips, expected)
    assert.deepEqual(persisted.at(-1), expected)
    assert.equal(await fs.readFile(partialFinal, 'utf8'), 'not a final video')
    await assert.rejects(fs.stat(promotedFinal))
  })
})

describe('Video Assembly orphan cleanup protection', () => {
  test('keeps only a valid nonterminal checkpoint directory past the expiry cutoff', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'story-studio-video-cleanup-test-'))
    createdDirs.push(root)
    const slug = 'cleanup-project'
    const makeRun = async (episode: string, stamp: number) => {
      const dir = path.join(root, slug, episode, `.tmp_${stamp}`)
      await fs.mkdir(dir, { recursive: true })
      return dir
    }
    const protectedDir = await makeRun('EP0010', 10)
    const terminalDir = await makeRun('EP0011', 11)
    const invalidDir = await makeRun('EP0012', 12)
    const unreferencedDir = await makeRun('EP0013', 13)
    const old = new Date(Date.now() - 60_000)
    await Promise.all([protectedDir, terminalDir, invalidDir, unreferencedDir].map(dir => fs.utimes(dir, old, old)))

    const protectedPaths = new Set([protectedDir])

    const summary = await cleanOrphanWorkTempDirs(1_000, protectedPaths, root)

    assert.equal((await fs.stat(protectedDir)).isDirectory(), true)
    await assert.rejects(fs.stat(terminalDir))
    await assert.rejects(fs.stat(invalidDir))
    await assert.rejects(fs.stat(unreferencedDir))
    assert.ok(summary.removed >= 3)
  })
})
