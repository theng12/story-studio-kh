/**
 * Which closing an episode has, and when the final check expects music over it
 * (Wonder in Ink WI0001, 2026-10-23).
 *
 * 1. A MANUAL Audio Assembly reads the closing through `resolveProjectClosingTail`: this episode's own
 *    last Video Assembly render, else the active timeline preset. The channel-level last render is
 *    another episode's choice and never leaks in. A merge that carries `closing_post_audio` (a Pipeline
 *    run, a render's re-mix) bakes THAT block instead, whatever is saved.
 * 2. The final check expects closing music over a tail the master carries, and over a padded tail
 *    unless the master is KNOWN music-free (`background_music: false`). A merge that does not say keeps
 *    the check on.
 *
 * The guard's verdicts for "no active Audio Assembly preset" live in closing-tail-remix.test.ts (they
 * need real merges). This file needs only config and tiny ffmpeg fixtures; ZERO paid calls. It cannot
 * see the wiring of `backgroundMusic` / `bakedTailSec` at each call site in generators/video.ts, nor the
 * Pipeline enqueue handing `closing_post_audio` to its audio_merge job — a full render / enqueue test
 * would have to cover those.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after, before, describe } from 'node:test'
import { useTempDataDir } from './_helpers.js'

const temp = await useTempDataDir()
process.env.STORY_STUDIO_DISABLE_LISTEN = '1'

const pm = await import('../services/project-manager.js')
const { closingTailFromPostAudio, resolveProjectClosingTail } = await import('../lib/closing-tail.js')
const { finalCheckExpectation } = await import('../generators/video.js')
const { runFinalCheck } = await import('../lib/final-video-check.js')

let dir: string
before(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'closing-tail-source-')) })
after(async () => {
  rmSync(dir, { recursive: true, force: true })
  await temp.cleanup()
})

const hold = (seconds: number) => ({
  behavior: 'hold-last-scene', fade_duration: 5, tail_seconds: seconds, closing_music: { volume: 100 },
})
const timelinePreset = (seconds: number) => ({
  timeline_presets: [{ id: 't-1', name: 'Closing', data: { post_audio: hold(seconds) } }],
  timeline_last_preset: 't-1',
})
const lastRender = (episode: string, seconds: number | null) => ({
  episode_id: episode, saved_at: '2026-10-23T00:00:00.000Z',
  settings: { timeline: seconds === null ? {} : { post_audio: hold(seconds) } },
})

async function channel(config: Record<string, unknown> = {}): Promise<string> {
  const project = await pm.createProject({
    name: `Source ${Math.random().toString(36).slice(2, 7)}`, episode_prefix: 'EP', episode_digits: 3,
  })
  if (Object.keys(config).length) await pm.updateConfig(project.slug, config as any)
  return project.slug
}

describe('a manual Audio Assembly resolves the closing from the episode, never from another episode', () => {
  test('the active timeline preset is the source when the episode has not rendered', async () => {
    const slug = await channel(timelinePreset(10))
    assert.equal((await resolveProjectClosingTail(slug, 'EP001')).seconds, 10)
  })

  test("a closing saved only as the episode's last render is seen, with no timeline preset at all", async () => {
    const slug = await channel({ video_assembly_last_used: { episodes: { EP001: lastRender('EP001', 10) } } })
    const closing = await resolveProjectClosingTail(slug, 'EP001')
    assert.equal(closing.seconds, 10)
    assert.equal(closing.music?.volume, 100)
    assert.equal((await resolveProjectClosingTail(slug, 'EP002')).seconds, 0, "another episode has not rendered: not this one's")
  })

  test("the episode's own last render wins over the preset, and the channel's last render never leaks in", async () => {
    const slug = await channel({
      ...timelinePreset(4),
      video_assembly_last_used: {
        channel: lastRender('EP002', 20),
        episodes: { EP001: lastRender('EP001', 10), EP002: lastRender('EP002', 20) },
      },
    })
    assert.equal((await resolveProjectClosingTail(slug, 'EP001')).seconds, 10)
    assert.equal((await resolveProjectClosingTail(slug, 'ep001')).seconds, 10, 'the episode code is matched case-insensitively')
    assert.equal((await resolveProjectClosingTail(slug, 'EP003')).seconds, 4, "EP003 gets the preset's closing, not EP002's 20 s")
    const onlyChannel = await channel({ video_assembly_last_used: { channel: lastRender('EP002', 20) } })
    assert.equal((await resolveProjectClosingTail(onlyChannel, 'EP003')).seconds, 0)
  })

  test("a last render whose timeline names no post-audio leaves the preset's closing in place", async () => {
    const slug = await channel({ ...timelinePreset(4), video_assembly_last_used: { episodes: { EP001: lastRender('EP001', null) } } })
    assert.equal((await resolveProjectClosingTail(slug, 'EP001')).seconds, 4)
  })

  test("a last render that chose no tail is an answer: no tail, not the preset's", async () => {
    const slug = await channel({
      ...timelinePreset(4),
      video_assembly_last_used: { episodes: { EP001: { episode_id: 'EP001', saved_at: 'x', settings: { timeline: { post_audio: { behavior: 'hard-cut', fade_duration: 5 } } } } } },
    })
    assert.equal((await resolveProjectClosingTail(slug, 'EP001')).seconds, 0)
  })

  test('closingTailFromPostAudio is the render block\'s own length and music', () => {
    const closing = closingTailFromPostAudio(hold(10) as any)
    assert.equal(closing.seconds, 10)
    assert.equal(closing.music?.volume, 100)
    assert.equal(closingTailFromPostAudio(undefined).seconds, 0)
  })
})

describe('the final check expects closing music over a tail the master carries, unless it is known music-free', () => {
  const req = (postAudio: unknown): any => ({ post_audio: postAudio })
  const shape = { plannedSec: 8, tailFromEndSec: 0, width: 320, height: 180 }

  test('a baked tail with closing music asked for expects music, whatever the record says', () => {
    for (const backgroundMusic of [true, false, null]) {
      assert.equal(finalCheckExpectation(req(hold(3)), { ...shape, tailSec: 3, bakedTailSec: 3, backgroundMusic }).closing_music, true)
    }
  })

  test('a padded tail over a master KNOWN to have no bed expects no music', () => {
    const expected = finalCheckExpectation(req(hold(3)), { ...shape, tailSec: 3, bakedTailSec: 0, backgroundMusic: false })
    assert.equal(expected.closing_music, false)
    assert.equal(expected.tail.sec, 3, 'the tail itself is still measured where it was drawn')
  })

  test('a padded tail over a master that does not say (older merge) or has a bed keeps the check on', () => {
    assert.equal(finalCheckExpectation(req(hold(3)), { ...shape, tailSec: 3, bakedTailSec: 0, backgroundMusic: null }).closing_music, true)
    assert.equal(finalCheckExpectation(req(hold(3)), { ...shape, tailSec: 3, bakedTailSec: 0, backgroundMusic: true }).closing_music, true)
  })

  test('music nobody asked for, and no tail at all, expect none', () => {
    const quiet = { behavior: 'hold-last-scene', fade_duration: 5, tail_seconds: 3, closing_music: { volume: 0 } }
    assert.equal(finalCheckExpectation(req(quiet), { ...shape, tailSec: 3, bakedTailSec: 3, backgroundMusic: true }).closing_music, false)
    assert.equal(finalCheckExpectation(req(undefined), { ...shape, tailSec: 0, bakedTailSec: 0, backgroundMusic: null }).closing_music, false)
    assert.equal(finalCheckExpectation(req(hold(3)), { ...shape, tailSec: 0, bakedTailSec: 0, backgroundMusic: null }).closing_music, false)
  })

  const silentTail = (): string => {
    const file = path.join(dir, `silent-tail-${Math.random().toString(36).slice(2, 7)}.mp4`)
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=10:d=8',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5',
      '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=3',
      '-filter_complex', '[1][2]concat=n=2:v=0:a=1[a]', '-map', '0:v', '-map', '[a]',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file], { stdio: ['ignore', 'ignore', 'inherit'] })
    return file
  }

  test('a baked tail with a silent bed fails; so does a silent tail of an older merge; a known music-free one passes', async () => {
    const file = silentTail()
    const verdict = async (bakedTailSec: number, backgroundMusic: boolean | null) =>
      runFinalCheck(file, finalCheckExpectation(req(hold(3)), { ...shape, tailSec: 3, bakedTailSec, backgroundMusic }))
    const baked = await verdict(3, true)
    assert.deepEqual(baked.issues.map(issue => issue.check), ['closing_tail'], JSON.stringify(baked.actual))
    const legacy = await verdict(0, null)
    assert.deepEqual(legacy.issues.map(issue => issue.check), ['closing_tail'], 'an older record cannot excuse a silent ending')
    const designed = await verdict(0, false)
    assert.deepEqual(designed.issues, [], JSON.stringify(designed.actual))
  })
})
