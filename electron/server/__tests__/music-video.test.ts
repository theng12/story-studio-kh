/**
 * v1.4.37 — assembling one music video.
 *
 * The property that matters most here is a NEGATIVE one: **this job spends
 * nothing**. Every credit the music format costs is spent earlier and
 * deliberately, by `music_generate`, with the cost shown before it starts.
 *
 * A shortfall therefore stops the run instead of quietly buying the
 * difference. A button that spends money as a side effect of doing something
 * else is exactly the v1.0.114 "Repair & Retry all" bug that produced real
 * duplicate charges, and it is not being rebuilt in a new place.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import {
  buildConcatList,
  buildLoopArgs,
  buildStitchArgs,
  buildMusicDescription,
  musicRenderPaths,
} from '../services/music-render.js'

const SRC = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'generators', 'music-video.ts')

describe('assembly buys nothing', () => {
  test('the generator imports no provider client at all', async () => {
    const body = await readFile(SRC, 'utf8')
    for (const forbidden of ['genstudio-client', 'callAi', 'generateMusicWithGenStudio']) {
      assert.ok(!body.includes(forbidden),
        `music-video.ts must not reach ${forbidden} — a render that can spend money `
        + 'is the v1.0.114 bug in a new place')
    }
  })

  test('a short library stops the run instead of covering the gap', async () => {
    const body = await readFile(SRC, 'utf8')
    assert.match(body, /if \(plan\.shortfall_sec > 0\) \{[\s\S]{0,400}?throw new Error/,
      'a shortfall must stop, not silently shorten the video')
    assert.match(body, /Nothing was generated and nothing was charged/,
      'and it must say so, or a stopped run reads like a failed paid one')
  })

  test('usage is recorded only after the video exists', async () => {
    const body = await readFile(SRC, 'utf8')
    // Match the CALL sites, not the import block — both names appear at the top
    // of the file, and there `recordMixUsage` happens to be imported first.
    const loopAt = body.indexOf('await runFfmpeg(buildLoopArgs(')
    const recordAt = body.indexOf('await recordMixUsage(')
    assert.ok(loopAt > 0 && recordAt > loopAt,
      '"times used" must mean heard, not considered — the same peek/record split '
      + 'the narration-bed pool uses')
  })

  test('cancel and pause are read before each expensive step', async () => {
    const body = await readFile(SRC, 'utf8')
    assert.equal((body.match(/jq\.throwIfPauseRequested\(job\.job_id\)/g) || []).length, 2)
    assert.equal((body.match(/jq\.isCancelled\(job\.job_id\)\) throw/g) || []).length, 2)
  })
})

describe('the stitch', () => {
  test('the concat list names every chosen track, in order', () => {
    const list = buildConcatList(['/lib/a.mp3', '/lib/b.mp3'])
    const lines = list.trim().split('\n')
    assert.equal(lines.length, 2)
    assert.ok(lines[0]!.includes('a.mp3'))
    assert.ok(lines[1]!.includes('b.mp3'))
  })

  test('a butt-join is the default, and it re-encodes rather than copying', () => {
    const args = buildStitchArgs('/tmp/list.txt', '/tmp/out.mp3', 0)
    assert.ok(args.includes('concat'))
    assert.ok(args.includes('-safe'))
    // Copying would be faster but requires every input to share a codec and
    // sample rate. A file the owner dropped in through Finder might not, and a
    // step that takes seconds either way should be correct rather than quick.
    assert.ok(args.includes('libmp3lame'))
  })

  test('a crossfade is REFUSED rather than silently butt-joined', () => {
    // acrossfade works pairwise, so a real N-way crossfade needs a filter chain
    // per junction. Accepting the parameter and ignoring it would let the UI
    // claim a crossfade the audio does not have.
    assert.throws(() => buildStitchArgs('/tmp/list.txt', '/tmp/out.mp3', 2),
      /not supported/)
  })
})

describe('the background loop', () => {
  test('frames are copied, never re-encoded — this is why a 2-hour video is cheap', () => {
    const args = buildLoopArgs('/bg.mp4', '/mix.mp3', '/out.mp4')
    assert.ok(args.includes('-stream_loop'))
    assert.equal(args[args.indexOf('-stream_loop') + 1], '-1')
    assert.equal(args[args.indexOf('-c:v') + 1], 'copy')
    assert.ok(args.includes('-shortest'), 'the video must stop at the audio, not run for ever')
  })

  test('the audio is copied too, so the stitch is not encoded twice', () => {
    const args = buildLoopArgs('/bg.mp4', '/mix.mp3', '/out.mp4')
    assert.equal(args[args.indexOf('-c:a') + 1], 'copy')
  })

  test('it starts fast for a viewer', () => {
    assert.ok(buildLoopArgs('/bg.mp4', '/mix.mp3', '/out.mp4').includes('+faststart'))
  })
})

describe('the description', () => {
  test('the tracklist leads, and a footer is optional', () => {
    const body = buildMusicDescription('0:00 One\n3:02 Two')
    assert.ok(body.startsWith('Tracklist'))
    assert.ok(body.includes('0:00 One'))
    assert.ok(!body.endsWith('\n'))
  })

  test('a footer is appended below, separated', () => {
    const body = buildMusicDescription('0:00 One', 'Subscribe for more.')
    assert.ok(body.includes('Subscribe for more.'))
    assert.ok(body.indexOf('0:00 One') < body.indexOf('Subscribe'))
  })

  test('an empty footer adds no trailing blank lines', () => {
    assert.equal(buildMusicDescription('0:00 One', '   '), 'Tracklist\n\n0:00 One')
  })
})

describe('output paths are episode-scoped', () => {
  test('every artefact is named for its episode, so two runs cannot collide', () => {
    const a = musicRenderPaths('/eps/EP0001', 'EP0001')
    const b = musicRenderPaths('/eps/EP0002', 'EP0002')
    assert.notEqual(a.video, b.video)
    assert.ok(a.video.endsWith('EP0001-music.mp4'))
    assert.ok(a.stitchedAudio.endsWith('EP0001-music-mix.mp3'))
  })
})
