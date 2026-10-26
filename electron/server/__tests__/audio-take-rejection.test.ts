/**
 * Rejected narration takes (owner, 2026-10-26): a take the owner threw away can
 * never be selected, merged, or counted as present, is restorable for three
 * days, and after that its files move into Story's ONE Trash — not `rm`, not a
 * second path (AGENTS.md §8 and the universal-trash guard).
 *
 * Every fact here runs on real files under `useTempDataDir()`, with an injected
 * clock for the age rule.
 */
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { useTempDataDir } from './_helpers.js'

let tmp: { dir: string; cleanup: () => Promise<void> }
process.env.STORY_STUDIO_DISABLE_LISTEN = '1'

const pm = await import('../services/project-manager.js')
const {
  AUDIO_TAKE_REJECTIONS_SIDECAR, rejectTake, restoreTake, readTakeRejections,
  rejectedTakeFileSet, sweepRejectedTakeFiles,
} = await import('../services/audio-take-rejection.js')
const { listChapterTakes, useChapterTake } = await import('../services/audio-versions.js')
const { getAudioStatus } = await import('../services/audio-reconciler.js')
const { inspectChapterAudioReadiness } = await import('../services/audio-workflow-readiness.js')
const { scanEpisodeAudioAssets } = await import('../generators/audio-merge.js')
const { TRASH_INDEX } = await import('../lib/trash-move.js')

const DAY_MS = 24 * 60 * 60 * 1000

const NARRATION = `# Test — Narration

## Chapter 01: One

The first chapter speaks a short sentence.

## Chapter 02: Two

The second chapter speaks another short sentence.
`

interface Fixture {
  projectDir: string
  episodeDir: string
  audioDir: string
  code: string
  slug: string
}

/** A channel whose EP001 has two narrated chapters, one of them with a `_v2` take. */
async function fixture(
  name: string,
  options: { chapter2Versions?: boolean; selector?: boolean; activeVersion2?: boolean } = {},
): Promise<Fixture> {
  const project = await pm.createProject({ name, episode_prefix: 'EP', episode_digits: 3 })
  const root = (await pm.getProjectOutputRoot(project.slug))!
  const episodeDir = path.join(root, 'EP001 - Test')
  const audioDir = path.join(episodeDir, 'EP001 - 07 Audio Assets')
  await fs.mkdir(audioDir, { recursive: true })
  await fs.writeFile(path.join(episodeDir, 'EP001_Script_Narration.md'), NARRATION)
  await fs.writeFile(path.join(audioDir, 'EP001_Chapter_01.mp3'), 'one')
  await fs.writeFile(path.join(audioDir, 'EP001_Chapter_02.mp3'), 'two')
  if (options.chapter2Versions) await fs.writeFile(path.join(audioDir, 'EP001_Chapter_02_v2.mp3'), 'two-v2')
  if (options.selector !== false) {
    const chapter2 = options.activeVersion2 ? ['EP001_Chapter_02_v2.mp3'] : ['EP001_Chapter_02.mp3']
    await fs.writeFile(path.join(episodeDir, 'audio_chapters.json'), JSON.stringify({
      schema_version: 1,
      sections: [
        { slug: 'Chapter_01', source_file: 'EP001_Chapter_01.mp3', source_files: ['EP001_Chapter_01.mp3'], duration_s: 1 },
        {
          slug: 'Chapter_02',
          source_file: chapter2[0],
          source_files: chapter2,
          duration_s: 1,
        },
      ],
    }))
  }
  return { projectDir: pm.getProjectDir(project.slug)!, episodeDir, audioDir, code: 'EP001', slug: project.slug }
}

before(async () => { tmp = await useTempDataDir() })
after(async () => { await tmp.cleanup() })

describe('rejecting a take', () => {
  test('records the reason durably and excludes the take from the versions list', async () => {
    const f = await fixture('Reject Records', { chapter2Versions: true })
    const outcome = await rejectTake({
      projectDir: f.projectDir, episodeDir: f.episodeDir, audioDir: f.audioDir,
      code: f.code, section: 'Chapter_02', files: ['EP001_Chapter_02_v2.mp3'],
      reason: 'Khmer narration is gibberish',
    })
    assert.equal(outcome.already, false)
    assert.equal(outcome.needs_narration, false, 'a rejected spare take does not empty the chapter')
    assert.equal(outcome.moved_to, null)

    const store = JSON.parse(await fs.readFile(path.join(f.episodeDir, AUDIO_TAKE_REJECTIONS_SIDECAR), 'utf8'))
    const row = Object.values(store.takes)[0] as any
    assert.deepEqual({ files: row.files, reason: row.reason }, {
      files: ['EP001_Chapter_02_v2.mp3'], reason: 'Khmer narration is gibberish',
    })
    assert.ok(Number.isFinite(Date.parse(row.rejected_at)), 'a durable rejected_at is stored')

    const takes = await listChapterTakes(f.episodeDir, f.audioDir, f.code, 'Chapter_02')
    assert.equal(takes.find(take => take.files[0] === 'EP001_Chapter_02_v2.mp3')?.rejected, true)
    assert.equal(takes.find(take => take.files[0] === 'EP001_Chapter_02.mp3')?.active, true)
  })

  test('a rejected take can never be selected ("Use This Version" refuses)', async () => {
    const f = await fixture('Reject Refuses Selection', { chapter2Versions: true })
    await rejectTake({
      projectDir: f.projectDir, episodeDir: f.episodeDir, audioDir: f.audioDir,
      code: f.code, section: 'Chapter_02', files: ['EP001_Chapter_02_v2.mp3'], reason: 'wrong voice',
    })
    await assert.rejects(
      useChapterTake({
        projectDir: f.projectDir, episodeDir: f.episodeDir, audioDir: f.audioDir,
        code: f.code, slug: 'Chapter_02', files: ['EP001_Chapter_02_v2.mp3'],
      }),
      (error: any) => error?.statusCode === 409 && /rejected/i.test(error.message),
    )
    // And the selection is untouched.
    const selector = JSON.parse(await fs.readFile(path.join(f.episodeDir, 'audio_chapters.json'), 'utf8'))
    assert.deepEqual(selector.sections[1].source_files, ['EP001_Chapter_02.mp3'])
  })

  test('a rejected take counts as missing everywhere the audio is audited', async () => {
    const f = await fixture('Reject Counts As Missing')
    await rejectTake({
      projectDir: f.projectDir, episodeDir: f.episodeDir, audioDir: f.audioDir,
      code: f.code, section: 'Chapter_01', files: ['EP001_Chapter_01.mp3'], reason: 'silent file',
    })
    const status = await getAudioStatus(f.slug, f.code)
    assert.deepEqual(status.missing, ['EP001_Chapter_01.mp3'], 'the rejected take is not present')
    assert.equal(status.present.includes('EP001_Chapter_01.mp3'), false)
    const readiness = await inspectChapterAudioReadiness(f.slug, f.code)
    assert.equal(readiness.ready, false)
    assert.match(readiness.issues.join(' '), /EP001_Chapter_01\.mp3/)

    const scan = await scanEpisodeAudioAssets(f.slug, f.code)
    assert.deepEqual(scan.chapters.map(chapter => chapter.filename), ['EP001_Chapter_02.mp3'],
      'Audio Assembly never lists a rejected take as a chapter')
  })

  test('rejecting the take in use moves the selection to a usable one and keeps the rejected bytes', async () => {
    const f = await fixture('Reject Active Moves', { chapter2Versions: true, activeVersion2: true })
    const outcome = await rejectTake({
      projectDir: f.projectDir, episodeDir: f.episodeDir, audioDir: f.audioDir,
      code: f.code, section: 'Chapter_02', files: ['EP001_Chapter_02_v2.mp3'], reason: 'breathy',
    })
    assert.equal(outcome.was_active, true)
    assert.deepEqual(outcome.moved_to, ['EP001_Chapter_02.mp3'])
    assert.equal(outcome.needs_narration, false)
    const selector = JSON.parse(await fs.readFile(path.join(f.episodeDir, 'audio_chapters.json'), 'utf8'))
    assert.deepEqual(selector.sections[1].source_files, ['EP001_Chapter_02.mp3'])
    // Restorable for three days, so the rejected files stay put.
    assert.equal(await fs.stat(path.join(f.audioDir, 'EP001_Chapter_02_v2.mp3')).then(() => true).catch(() => false), true)
  })

  test('rejecting the only take makes the chapter need narration', async () => {
    const f = await fixture('Reject Only Take')
    const outcome = await rejectTake({
      projectDir: f.projectDir, episodeDir: f.episodeDir, audioDir: f.audioDir,
      code: f.code, section: 'Chapter_01', files: ['EP001_Chapter_01.mp3'], reason: 'unusable',
    })
    assert.equal(outcome.was_active, true)
    assert.equal(outcome.moved_to, null)
    assert.equal(outcome.needs_narration, true)
    assert.match(outcome.message, /needs narration/)
  })

  test('a reason is required; a corrupt record throws instead of reading as "not rejected"', async () => {
    const f = await fixture('Reject Reason Required')
    await assert.rejects(
      rejectTake({
        projectDir: f.projectDir, episodeDir: f.episodeDir, audioDir: f.audioDir,
        code: f.code, section: 'Chapter_01', files: ['EP001_Chapter_01.mp3'], reason: '   ',
      }),
      (error: any) => error?.statusCode === 400,
    )
    await fs.writeFile(path.join(f.episodeDir, AUDIO_TAKE_REJECTIONS_SIDECAR), '{ not json')
    await assert.rejects(readTakeRejections(f.episodeDir), /cannot be read/)
    await assert.rejects(rejectedTakeFileSet(f.episodeDir), /cannot be read/)
    await assert.rejects(getAudioStatus(f.slug, f.code), /cannot be read/)
  })
})

describe('restoring a rejected take', () => {
  test('inside the window it is usable again', async () => {
    const f = await fixture('Restore In Window')
    const now = Date.UTC(2026, 9, 26, 10)
    await rejectTake({
      projectDir: f.projectDir, episodeDir: f.episodeDir, audioDir: f.audioDir,
      code: f.code, section: 'Chapter_01', files: ['EP001_Chapter_01.mp3'], reason: 'scratchy', now,
    })
    assert.deepEqual((await getAudioStatus(f.slug, f.code)).missing, ['EP001_Chapter_01.mp3'])
    const outcome = await restoreTake({
      episodeDir: f.episodeDir, section: 'Chapter_01', files: ['EP001_Chapter_01.mp3'], now: now + DAY_MS,
    })
    assert.match(outcome.message, /usable again/)
    assert.deepEqual((await getAudioStatus(f.slug, f.code)).missing, [])
  })

  test('after the window it refuses and says why', async () => {
    const f = await fixture('Restore Too Late')
    const now = Date.UTC(2026, 9, 26, 10)
    await rejectTake({
      projectDir: f.projectDir, episodeDir: f.episodeDir, audioDir: f.audioDir,
      code: f.code, section: 'Chapter_01', files: ['EP001_Chapter_01.mp3'], reason: 'scratchy', now,
    })
    await assert.rejects(
      restoreTake({ episodeDir: f.episodeDir, section: 'Chapter_01', files: ['EP001_Chapter_01.mp3'], now: now + 4 * DAY_MS }),
      (error: any) => error?.statusCode === 409 && /restore window ended/.test(error.message),
    )
  })
})

describe('the three-day sweep', () => {
  test('moves the rejected files into Story\'s one Trash and drops the record', async () => {
    const f = await fixture('Sweep Moves', { chapter2Versions: true })
    const now = Date.UTC(2026, 9, 26, 10)
    await rejectTake({
      projectDir: f.projectDir, episodeDir: f.episodeDir, audioDir: f.audioDir,
      code: f.code, section: 'Chapter_02', files: ['EP001_Chapter_02_v2.mp3'], reason: 'gibberish', now,
    })

    // Two days later: not due.
    const early = await sweepRejectedTakeFiles({
      projectDir: f.projectDir, episodeDir: f.episodeDir, audioDir: f.audioDir, now: now + 2 * DAY_MS,
    })
    assert.deepEqual(early.swept, [])
    assert.equal(await fs.stat(path.join(f.audioDir, 'EP001_Chapter_02_v2.mp3')).then(() => true), true)

    // Four days later: it goes, through the shared trash helper.
    const late = await sweepRejectedTakeFiles({
      projectDir: f.projectDir, episodeDir: f.episodeDir, audioDir: f.audioDir, now: now + 4 * DAY_MS,
    })
    assert.equal(late.swept.length, 1)
    assert.equal(await fs.stat(path.join(f.audioDir, 'EP001_Chapter_02_v2.mp3')).then(() => false).catch(() => true), true)
    const library = path.dirname(f.projectDir)
    const landed = path.join(library, '_trash', path.basename(f.projectDir), 'episodes', 'EP001 - Test',
      'EP001 - 07 Audio Assets', 'EP001_Chapter_02_v2.mp3')
    assert.equal(await fs.readFile(landed, 'utf8'), 'two-v2', 'the bytes are in Story\'s Trash, not deleted')
    const index = (await fs.readFile(path.join(library, '_trash', TRASH_INDEX), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.equal(index.at(-1).kind, 'audio')
    assert.equal(index.at(-1).to, landed)

    const store = await readTakeRejections(f.episodeDir)
    assert.deepEqual(Object.keys(store.takes), [], 'the record is gone once its files left')
    assert.equal(store.swept?.at(-1)?.reason, 'gibberish', 'the page can announce what happened')

    // Idempotent: a second sweep finds nothing to do.
    assert.deepEqual((await sweepRejectedTakeFiles({
      projectDir: f.projectDir, episodeDir: f.episodeDir, audioDir: f.audioDir, now: now + 5 * DAY_MS,
    })).swept, [])
  })
})

describe('a new take in the same name clears the old rejection', () => {
  test('regenerating over a rejected name drops its record', async () => {
    const f = await fixture('Regenerate Clears')
    await rejectTake({
      projectDir: f.projectDir, episodeDir: f.episodeDir, audioDir: f.audioDir,
      code: f.code, section: 'Chapter_01', files: ['EP001_Chapter_01.mp3'], reason: 'old bytes',
    })
    const { forgetTakeRejections } = await import('../services/audio-take-rejection.js')
    await forgetTakeRejections(f.episodeDir, ['EP001_Chapter_01.mp3'])
    assert.deepEqual(Object.keys((await readTakeRejections(f.episodeDir)).takes), [])
  })
})

describe('Video Assembly never picks a rejected take', () => {
  test('a merged track built from a rejected take is reported stale with the repair', async () => {
    const f = await fixture('Merged From Rejected')
    const mergedDir = path.join(f.episodeDir, 'EP001 - 08 Audio Merge Output')
    await fs.mkdir(mergedDir, { recursive: true })
    const mergedPath = path.join(mergedDir, 'EP001_merged_audio.mp3')
    await fs.writeFile(mergedPath, 'merged-bytes')
    await fs.writeFile(path.join(mergedDir, 'EP001_merged_audio.completion.json'), JSON.stringify({
      schema_version: 2, output_filename: 'EP001_merged_audio.mp3',
      bytes: (await fs.stat(mergedPath)).size, duration_sec: 10, generated_at: '2026-10-26T00:00:00.000Z',
    }))

    const { getAudioMergeStatus, staleMergedAudioMessage } = await import('../services/asset-status.js')
    const before = await getAudioMergeStatus(f.slug, f.code)
    assert.equal(before.present, true, 'nothing rejected yet, so the merge is current')

    await rejectTake({
      projectDir: f.projectDir, episodeDir: f.episodeDir, audioDir: f.audioDir,
      code: f.code, section: 'Chapter_01', files: ['EP001_Chapter_01.mp3'], reason: 'gibberish',
    })
    const after = await getAudioMergeStatus(f.slug, f.code)
    assert.equal(after.present, false)
    assert.equal(after.reason, 'chapter-rejected:EP001_Chapter_01.mp3')
    const message = staleMergedAudioMessage(f.code, after.file ?? null, after.reason!)
    assert.match(message, /rejected/)
    assert.match(message, /Restore it or use another version on the Audio page, then re-run Audio Assembly\./)
  })
})
