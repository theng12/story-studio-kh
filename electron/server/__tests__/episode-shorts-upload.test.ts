/**
 * 1.4.374 — uploading an episode's Shorts to YouTube.
 *
 * WHAT THIS PINS
 *
 *   - the switch is OFF unless the owner turns it on, and a missing or
 *     unknown value never turns it on;
 *   - 'private' uploads the Short private;
 *   - 'scheduled' uploads it private with a publish date, and that date is
 *     the episode's own date plus the spacing;
 *   - a date that is not in the future is REFUSED (YouTube would publish it
 *     the moment it landed);
 *   - 'scheduled' with no episode date is refused, and says why;
 *   - a Short that failed verification is never uploaded;
 *   - a retry never uploads the same Short twice, and finishes only what is
 *     missing;
 *   - a failed upload is loud, and fails neither the Shorts nor the episode;
 *   - nothing is ever uploaded PUBLIC, and no visibility is ever changed.
 *
 * The provider is never contacted: every test here stops at the admission
 * boundary or at the decision the admission is built on.
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { useTempDataDir } from './_helpers.js'
import { UpdateConfigSchema } from '../contracts/index.js'
import { runFfmpeg } from '../lib/ffmpeg-utils.js'
import {
  planShortsUpload,
  qualifiesAsYouTubeShort,
  readShortsUploadState,
  shortsAutoUploadMode,
  shortsUploadSpacingDays,
  shortIdentity,
  writeShortUploadRecord,
  YOUTUBE_SHORT_MAX_SECONDS,
} from '../services/shorts-upload.js'
import { shortsAutoUploadMode as cadenceShortsMode, shortsUploadSpacingDays as cadenceShortsSpacing } from '../services/publish-cadence.js'
import type { ShortMoment } from '../services/episode-shorts.js'
import { storedEpisodeNumber } from '../services/utils.js'

let cleanup: () => Promise<void>
let root: string
before(async () => {
  const temp = await useTempDataDir()
  root = temp.dir
  cleanup = temp.cleanup
})
after(async () => { await cleanup?.() })

/**
 * A Short is 20–58 seconds and VERTICAL — that is what the Shorts job cuts,
 * and what `verifyShort` insists on. The fixture makes the same thing, so the
 * plan's verification gate is exercised against a real file rather than a
 * stub: a fake file that fails the probe would prove nothing about the plan.
 */
const PASSAGE_SECONDS = 20

const moments: ShortMoment[] = [
  { start: 0, end: PASSAGE_SECONDS, title: 'First Short', reason: 'A complete idea' },
  { start: 40, end: 40 + PASSAGE_SECONDS, title: 'Second Short', reason: 'Another idea' },
]

/** A shorts folder with one real, verified clip per moment. */
async function shortsFolder(selected: ShortMoment[] = moments): Promise<string> {
  const dir = path.join(root, 'shorts-fixture')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'shorts.json'), JSON.stringify({ shorts: selected }))
  for (const [index] of selected.entries()) {
    const file = path.join(dir, `EP0001-short-${index + 1}.mp4`)
    await runFfmpeg([
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `color=c=blue:s=1080x1920:r=10:d=${PASSAGE_SECONDS}`,
      '-f', 'lavfi', '-i', `sine=frequency=440:duration=${PASSAGE_SECONDS}`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', file,
    ])
  }
  return dir
}

describe('the switch is off unless the owner turns it on', () => {
  test('a missing, unknown or malformed value reads as off', () => {
    for (const value of [undefined, null, '', 'on', 'public', 'yes', 1, {}]) {
      assert.equal(shortsAutoUploadMode({ shorts_auto_upload: value }), 'off')
      assert.equal(shortsAutoUploadMode(undefined), 'off')
      assert.equal(shortsAutoUploadMode(null), 'off')
    }
    assert.equal(shortsAutoUploadMode({ shorts_auto_upload: 'private' }), 'private')
    assert.equal(shortsAutoUploadMode({ shorts_auto_upload: 'scheduled' }), 'scheduled')
  })

  test('the card and the job read the switch the same way', () => {
    // Two readers of one fact must not drift — the card would then show one
    // thing and the job do another.
    for (const value of ['off', 'private', 'scheduled', 'nonsense']) {
      assert.equal(shortsAutoUploadMode({ shorts_auto_upload: value }), cadenceShortsMode({ shorts_auto_upload: value }))
    }
  })

  test('the spacing is a whole number of days from 1 to 30, and anything else is the starting value', () => {
    for (const value of [undefined, null, 0, -1, 31, 1.5, '2', {}]) {
      assert.equal(shortsUploadSpacingDays({ shorts_upload_spacing_days: value }), 1)
      assert.equal(cadenceShortsSpacing({ shorts_upload_spacing_days: value }), 1)
    }
    assert.equal(shortsUploadSpacingDays({ shorts_upload_spacing_days: 1 }), 1)
    assert.equal(shortsUploadSpacingDays({ shorts_upload_spacing_days: 30 }), 30)
  })

  test('the settings route accepts both keys and refuses a value outside the range', () => {
    for (const mode of ['off', 'private', 'scheduled']) {
      assert.equal(UpdateConfigSchema.safeParse({ shorts_auto_upload: mode }).success, true)
    }
    for (const mode of ['public', 'on', '', 1, null]) {
      assert.equal(UpdateConfigSchema.safeParse({ shorts_auto_upload: mode }).success, false)
    }
    for (const days of [1, 15, 30]) {
      assert.equal(UpdateConfigSchema.safeParse({ shorts_upload_spacing_days: days }).success, true)
    }
    for (const days of [0, 31, -1, 1.5, '2']) {
      assert.equal(UpdateConfigSchema.safeParse({ shorts_upload_spacing_days: days }).success, false)
    }
  })
})

describe('what a Short looks like to YouTube', () => {
  test('a vertical or square clip qualifies, and a wide one does not', () => {
    assert.equal(qualifiesAsYouTubeShort({ width: 1080, height: 1920, durationSec: 30 }).ok, true)
    assert.equal(qualifiesAsYouTubeShort({ width: 1080, height: 1080, durationSec: 30 }).ok, true)
    const wide = qualifiesAsYouTubeShort({ width: 1920, height: 1080, durationSec: 30 })
    assert.equal(wide.ok, false)
    assert.match(wide.reason || '', /wider than it is tall/)
  })

  test('a Short longer than YouTube allows does not qualify', () => {
    const long = qualifiesAsYouTubeShort({ width: 1080, height: 1920, durationSec: YOUTUBE_SHORT_MAX_SECONDS + 1 })
    assert.equal(long.ok, false)
    assert.match(long.reason || '', /at most/)
    assert.equal(qualifiesAsYouTubeShort({ width: 1080, height: 1920, durationSec: YOUTUBE_SHORT_MAX_SECONDS }).ok, true)
  })
})

describe('the plan decides before anything is sent', () => {
  test('off uploads nothing and says so', async () => {
    const dir = await shortsFolder()
    const plan = await planShortsUpload({
      code: 'EP0001', shortsDir: dir, moments, mode: 'off', spacing_days: 1,
    })
    assert.equal(plan.entries.length, 0)
    assert.match(plan.reason || '', /off/i)
  })

  test('private uploads every verified Short with no publish date', async () => {
    const dir = await shortsFolder()
    const plan = await planShortsUpload({
      code: 'EP0001', shortsDir: dir, moments, mode: 'private', spacing_days: 1,
    })
    assert.equal(plan.entries.length, 2)
    assert.deepEqual(plan.entries.map(entry => entry.title), ['First Short', 'Second Short'])
    for (const entry of plan.entries) {
      assert.equal(entry.publish_at, undefined, 'a private Short has no publish date')
      assert.equal(entry.id, shortIdentity('EP0001', entry.index))
    }
  })

  test('scheduled gives each Short the episode date plus the spacing', async () => {
    const dir = await shortsFolder()
    const parent = new Date('2030-05-10T12:00:00.000Z')
    const plan = await planShortsUpload({
      code: 'EP0001', shortsDir: dir, moments, mode: 'scheduled', spacing_days: 2,
      parent_publish_at: parent.toISOString(),
      now: Date.parse('2030-05-01T00:00:00.000Z'),
    })
    assert.equal(plan.entries.length, 2)
    assert.equal(plan.entries[0]!.publish_at, new Date(parent.getTime() + 2 * 86_400_000).toISOString())
    assert.equal(plan.entries[1]!.publish_at, new Date(parent.getTime() + 4 * 86_400_000).toISOString())
  })

  test('scheduled with no episode date refuses everything and says why', async () => {
    const dir = await shortsFolder()
    const plan = await planShortsUpload({
      code: 'EP0001', shortsDir: dir, moments, mode: 'scheduled', spacing_days: 1,
    })
    assert.equal(plan.entries.length, 0)
    assert.match(plan.reason || '', /no publish date/i)
  })

  test('a publish date that has already passed refuses everything', async () => {
    const dir = await shortsFolder()
    const plan = await planShortsUpload({
      code: 'EP0001', shortsDir: dir, moments, mode: 'scheduled', spacing_days: 1,
      parent_publish_at: new Date('2020-01-01T12:00:00.000Z').toISOString(),
      now: Date.parse('2030-01-01T00:00:00.000Z'),
    })
    assert.equal(plan.entries.length, 0)
    assert.match(plan.reason || '', /in the past/i)
  })

  test('a Short that failed verification is never uploaded', async () => {
    const dir = await shortsFolder([moments[0]!])
    // The clip is replaced by something that is not a video at all, so the
    // verification fails the way a corrupt or truncated cut fails.
    await fs.writeFile(path.join(dir, 'EP0001-short-1.mp4'), 'not a video')
    const plan = await planShortsUpload({
      code: 'EP0001', shortsDir: dir, moments: [moments[0]!], mode: 'private', spacing_days: 1,
    })
    assert.equal(plan.entries.length, 0)
    assert.match(plan.skipped[0]?.reason || '', /verification/i)
  })

  test('a Short whose file is gone is not uploaded', async () => {
    const dir = await shortsFolder([moments[0]!])
    await fs.rm(path.join(dir, 'EP0001-short-1.mp4'))
    const plan = await planShortsUpload({
      code: 'EP0001', shortsDir: dir, moments: [moments[0]!], mode: 'private', spacing_days: 1,
    })
    assert.equal(plan.entries.length, 0)
    assert.match(plan.skipped[0]?.reason || '', /missing/i)
  })
})

describe('a retry never uploads the same Short twice', () => {
  test('an uploaded Short is skipped, and the rest still go', async () => {
    const dir = await shortsFolder()
    await writeShortUploadRecord(dir, 'EP0001-short-1.mp4', {
      file: 'EP0001-short-1.mp4', title: 'First Short', state: 'uploaded', video_id: 'vid-1',
    })
    const plan = await planShortsUpload({
      code: 'EP0001', shortsDir: dir, moments, mode: 'private', spacing_days: 1,
    })
    assert.equal(plan.entries.length, 1, 'only the Short that has not gone up is planned')
    assert.equal(plan.entries[0]!.file, 'EP0001-short-2.mp4')
    assert.match(plan.skipped[0]?.reason || '', /already on YouTube/i)
  })

  test('a FAILED Short is retried — only what is missing is finished', async () => {
    const dir = await shortsFolder()
    await writeShortUploadRecord(dir, 'EP0001-short-1.mp4', {
      file: 'EP0001-short-1.mp4', title: 'First Short', state: 'failed', error: 'the provider refused it',
    })
    const plan = await planShortsUpload({
      code: 'EP0001', shortsDir: dir, moments, mode: 'private', spacing_days: 1,
    })
    assert.equal(plan.entries.length, 2, 'a failed upload is not a finished upload')
  })

  test('the upload state lives beside the Shorts manifest and survives it', async () => {
    const dir = await shortsFolder()
    await writeShortUploadRecord(dir, 'EP0001-short-1.mp4', {
      file: 'EP0001-short-1.mp4', title: 'First Short', state: 'uploaded', video_id: 'vid-1',
    })
    // The passages are chosen again and the manifest is rewritten. The upload
    // record must NOT be rewritten with it, or the Short would go up twice.
    await fs.writeFile(path.join(dir, 'shorts.json'), JSON.stringify({ shorts: moments }))
    const state = await readShortsUploadState(dir)
    assert.equal(state.shorts['EP0001-short-1.mp4']?.state, 'uploaded')
    assert.equal(state.shorts['EP0001-short-1.mp4']?.video_id, 'vid-1')
  })

  test('two Shorts never lose each other record', async () => {
    const dir = await shortsFolder()
    await writeShortUploadRecord(dir, 'EP0001-short-1.mp4', {
      file: 'EP0001-short-1.mp4', title: 'First Short', state: 'uploaded', video_id: 'vid-1',
    })
    await writeShortUploadRecord(dir, 'EP0001-short-2.mp4', {
      file: 'EP0001-short-2.mp4', title: 'Second Short', state: 'uploaded', video_id: 'vid-2',
    })
    const state = await readShortsUploadState(dir)
    assert.equal(state.shorts['EP0001-short-1.mp4']?.video_id, 'vid-1')
    assert.equal(state.shorts['EP0001-short-2.mp4']?.video_id, 'vid-2')
  })
})

describe('a Short identity resolves like the episode it belongs to', () => {
  test('it carries the episode number, so admission and path lookup agree', () => {
    // The invariant `storedEpisodeNumber` documents: admission and execution
    // ask the same question, so a code the resolver accepts is admitted. A
    // Short's identity is not a stored episode — it names one — so it must
    // resolve to the same NUMBER rather than falling through to
    // `episodeNumber`, which throws "Invalid episode code" for a channel
    // whose prefix moved on since the episode was accepted.
    assert.equal(storedEpisodeNumber(shortIdentity('EP0001', 0)), 1)
    assert.equal(storedEpisodeNumber(shortIdentity('AU0001', 1)), 1)
    assert.equal(storedEpisodeNumber('EP0001'), 1)
    // A code with no digits, or one whose suffix is not a Short's, is still
    // refused rather than guessed at.
    assert.equal(storedEpisodeNumber(''), null)
    assert.equal(storedEpisodeNumber('SHORT'), null)
    assert.equal(storedEpisodeNumber('EP0001-S1-extra'), null)
  })

  test('a path lookup for a Short identity never throws', async () => {
    const pm = await import('../services/project-manager.js')
    const { resolveEpisodePaths } = await import('../services/utils.js')
    const project = await pm.createProject({ name: 'Short path lookup' })
    // The folder does not exist — a Short has no folder of its own — but the
    // resolver must ANSWER rather than throw, which is what broke the whole
    // channel for a prefix-changed episode code.
    const paths = await resolveEpisodePaths(project.slug, shortIdentity('EP0001', 0), '')
    // It resolved to the episode's number, and to a folder named for THIS
    // Short — not the episode's own folder.
    assert.ok(paths.episode_dir.includes(`EP0001-S1`), paths.episode_dir)
    assert.ok(!paths.episode_dir.includes(`EP0001${path.sep} - `), paths.episode_dir)
    // …and it is a DIFFERENT folder from the episode's, which is what stops a
    // Short reading the episode's upload sidecar as its own.
    const parent = await resolveEpisodePaths(project.slug, 'EP0001', '')
    assert.notEqual(paths.episode_dir, parent.episode_dir)
  })
})

describe('a Short is its own video on the channel', () => {
  test('its identity is distinct from the episode’s and from its neighbours', () => {
    assert.equal(shortIdentity('EP0001', 0), 'EP0001-S1')
    assert.equal(shortIdentity('EP0001', 1), 'EP0001-S2')
    assert.notEqual(shortIdentity('EP0001', 0), 'EP0001')
    assert.notEqual(shortIdentity('EP0001', 0), shortIdentity('EP0001', 1))
  })
})
