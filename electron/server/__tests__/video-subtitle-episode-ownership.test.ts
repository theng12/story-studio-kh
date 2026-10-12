/**
 * v1.3.4 — the renderer refuses another episode's subtitle file.
 *
 * The incident: `EP0047_final_video.mp4` was rendered with EP0048's captions
 * burned across it. The video was EP0047 by every other measure — 989.833s,
 * matching EP0047's own merged audio — but the burned caption at t=14s read
 * "…At Timbuktu, that process has", which is cue #3 of EP0048's stitched SRT.
 *
 * The browser sent the wrong path (fixed separately, in Video Assembly's
 * episode change). This is the other half: the backend accepted a path from
 * anywhere on the disk, checked only `existsSync`, and burned it. That is what
 * turned a page-state bug into a video that was about to be published — so the
 * guard lives here too, where a stale payload from any source has to pass.
 *
 * It REFUSES rather than silently substituting the right file. Everything else
 * in `prepareUnifiedVideoAssemblyInputs` is a silent re-resolve, because for
 * scenes and merged audio there is exactly one correct answer. Which transcript
 * to burn is an editorial choice, and swapping it unasked would be this app
 * deciding what words go into a customer's video. Refusing also keeps a future
 * frontend regression of this kind visible instead of papered over — and it
 * costs nothing, because this runs in preflight, before a frame is encoded.
 */

import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'

import { assertSubtitleFileBelongsToEpisode, resolveEpisodeSubtitleFile } from '../generators/video.js'
import { useTempDataDir } from './_helpers.js'

let testData: Awaited<ReturnType<typeof useTempDataDir>>
before(async () => {
  testData = await useTempDataDir()
  const projectDir = path.join(testData.dir, 'projects', 'my-channel')
  await fs.mkdir(projectDir, { recursive: true })
  // These refusal regressions exercise an explicit Block choice. Warn/Off
  // omission is covered separately by video-safety-policy.test.ts.
  await fs.writeFile(path.join(projectDir, 'config.json'), JSON.stringify({
    safety_checks: { subtitles_this_episode: 'block' },
  }))
})
after(async () => { await testData.cleanup() })

const EP47_DIR = '/projects/my-channel/episodes/Season 003/EP0047 - Rome'
const EP48_DIR = '/projects/my-channel/episodes/Season 003/EP0048 - Timbuktu'

function reqWith(srtPath: string | undefined, enabled = true): any {
  return { subtitles: srtPath === undefined ? undefined : { enabled, srt_path: srtPath, style: {} } }
}

function jobStub(): any {
  return { output_lines: [] as string[] }
}

describe('subtitle file ownership at Video Assembly preflight', () => {
  test('refuses the exact shape of the incident, naming the other episode', async () => {
    const req = reqWith(`${EP48_DIR}/EP0048 - 09 Subtitles Output/EP0048_stitched.corrected.srt`)
    await assert.rejects(
      () => assertSubtitleFileBelongsToEpisode('my-channel', 'EP0047', EP47_DIR, req),
      (e: Error) => {
        assert.match(e.message, /not EP0047's/)
        assert.match(e.message, /EP0048_stitched\.corrected\.srt/)
        assert.match(e.message, /It belongs to EP0048\./)
        // The message has to tell him what to do, not just that he is stuck.
        assert.match(e.message, /Step 5/)
        return true
      },
    )
  })

  test('accepts this episode\'s own file and says so in the job log', async () => {
    const job = jobStub()
    const req = reqWith(`${EP47_DIR}/EP0047 - 09 Subtitles Output/EP0047_stitched.srt`)
    await assertSubtitleFileBelongsToEpisode('my-channel', 'EP0047', EP47_DIR, req, job)
    // The log used to print "Burning in subtitles: EP0048_stitched.srt" for a
    // correct render and a catastrophic one in identical words. The one line
    // that could have caught this now states the ownership it verified.
    assert.equal(job.output_lines.length, 1)
    assert.match(job.output_lines[0], /EP0047_stitched\.srt/)
    assert.match(job.output_lines[0], /belong to EP0047/)
  })

  test('accepts a legacy subtitles folder, because ownership is the episode dir', async () => {
    const job = jobStub()
    const req = reqWith(`${EP47_DIR}/EP0047 - 09 Subtitles/EP0047_whisper.srt`)
    await assertSubtitleFileBelongsToEpisode('my-channel', 'EP0047', EP47_DIR, req, job)
    assert.equal(job.output_lines.length, 1)
  })

  test('a sibling directory sharing a prefix is not "inside" the episode', async () => {
    // `/…/EP0047 - Rome` must not swallow `/…/EP0047 - Rome (old)`.
    const req = reqWith(`${EP47_DIR} (old)/EP0047_stitched.srt`)
    await assert.rejects(
      () => assertSubtitleFileBelongsToEpisode('my-channel', 'EP0047', EP47_DIR, req),
      /not EP0047's/,
    )
  })

  test('does nothing when subtitles are off or none is selected', async () => {
    const job = jobStub()
    // Off, with a foreign path still sitting in state — nothing will be burned,
    // so nothing is blocked. Refusing here would stop a render over a field the
    // customer has already switched out of the picture.
    await assertSubtitleFileBelongsToEpisode(
      'my-channel', 'EP0047', EP47_DIR,
      reqWith(`${EP48_DIR}/EP0048_stitched.srt`, false), job,
    )
    await assertSubtitleFileBelongsToEpisode('my-channel', 'EP0047', EP47_DIR, reqWith(''), job)
    await assertSubtitleFileBelongsToEpisode('my-channel', 'EP0047', EP47_DIR, reqWith(undefined), job)
    assert.deepEqual(job.output_lines, [])
  })

  test('an unexpandable portable token is refused, not assumed to be local', async () => {
    // `${NOT_A_ROOT}/…` cannot be shown to belong to this episode. Treating an
    // unresolvable path as acceptable would defeat the whole check.
    const req = reqWith('${NOT_A_ROOT_ON_THIS_MACHINE}/EP0048_stitched.srt')
    await assert.rejects(
      () => assertSubtitleFileBelongsToEpisode('my-channel', 'EP0047', EP47_DIR, req),
      /not EP0047's/,
    )
  })

  test('a file with no episode code is refused without inventing an owner', async () => {
    const req = reqWith('/Users/someone/Downloads/transcript.srt')
    await assert.rejects(
      () => assertSubtitleFileBelongsToEpisode('my-channel', 'EP0047', EP47_DIR, req),
      (e: Error) => {
        assert.match(e.message, /transcript\.srt/)
        assert.doesNotMatch(e.message, /It belongs to/)
        return true
      },
    )
  })

  test('the guard is wired into the preflight every render goes through', async () => {
    // The decision above is worthless if nothing calls it. `generateVideo` and
    // the /generate/video-assembly preflight route both funnel through
    // `prepareUnifiedVideoAssemblyInputs`, so that is where it has to sit.
    const source = await fs.readFile(
      path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'generators', 'video.ts'),
      'utf-8',
    )
    const prepare = source.slice(source.indexOf('export async function prepareUnifiedVideoAssemblyInputs'))
    assert.ok(
      prepare.includes('assertSubtitleFileBelongsToEpisode('),
      'prepareUnifiedVideoAssemblyInputs must call the ownership guard',
    )
  })

  test('a batch render with subtitles on and no file named gets this episode\'s own', async () => {
    // `routes/pipeline.ts` drops `srt_path` from the bundle as episode-specific
    // and its comment says the generator regenerates it. Nothing did, so every
    // batch render with subtitles switched on produced a captionless video and
    // never registered the omission. This is that missing half.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sskh-srt-fill-'))
    try {
      const subs = path.join(root, 'EP0047 - 09 Subtitles Output')
      await fs.mkdir(subs, { recursive: true })
      await fs.writeFile(path.join(subs, 'EP0047_Chapter_01.srt'), '1\n')
      await fs.writeFile(path.join(subs, 'EP0047_stitched.srt'), '1\n')
      const job = jobStub()
      const req = reqWith('')
      await resolveEpisodeSubtitleFile('EP0047', subs, req, job)
      // The full stitched transcript, never the per-chapter partial.
      assert.equal(req.subtitles.srt_path, path.join(subs, 'EP0047_stitched.srt'))
      assert.match(job.output_lines[0], /no file was named/)
      assert.match(job.output_lines[0], /EP0047_stitched\.srt/)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test('the fill honours the user\'s own pinned choice', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sskh-srt-pin-'))
    try {
      await fs.writeFile(path.join(root, 'EP0047_stitched.srt'), '1\n')
      await fs.writeFile(path.join(root, 'EP0047_whisper.srt'), '1\n')
      await fs.writeFile(path.join(root, '.selected_subtitle'), 'EP0047_whisper.srt')
      const req = reqWith('')
      await resolveEpisodeSubtitleFile('EP0047', root, req, jobStub())
      assert.equal(req.subtitles.srt_path, path.join(root, 'EP0047_whisper.srt'))
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test('subtitles on with nothing to burn says so loudly instead of rendering blank', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sskh-srt-none-'))
    try {
      const job = jobStub()
      const req = reqWith('')
      await resolveEpisodeSubtitleFile('EP0047', root, req, job)
      assert.equal(req.subtitles.srt_path, '')
      assert.match(job.output_lines[0], /no subtitle file to burn/)
      assert.match(job.output_lines[0], /no captions/)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test('the fill never overrides a file the caller did name', async () => {
    const req = reqWith(`${EP47_DIR}/EP0047 - 09 Subtitles Output/EP0047_whisper.srt`)
    const job = jobStub()
    await resolveEpisodeSubtitleFile('EP0047', `${EP47_DIR}/EP0047 - 09 Subtitles Output`, req, job)
    assert.match(req.subtitles.srt_path, /EP0047_whisper\.srt$/)
    assert.deepEqual(job.output_lines, [])
  })

  test('relative-path edge: an episode dir given relatively still resolves', async () => {
    // Guards against a `path.relative` foot-gun if a caller ever passes a
    // non-absolute episode dir.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sskh-srt-own-'))
    try {
      const job = jobStub()
      await assertSubtitleFileBelongsToEpisode(
        'my-channel', 'EP0047', root,
        reqWith(path.join(root, 'subs', 'EP0047_stitched.srt')), job,
      )
      assert.equal(job.output_lines.length, 1)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
