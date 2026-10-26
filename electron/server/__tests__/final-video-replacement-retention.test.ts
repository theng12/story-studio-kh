/**
 * A re-assembly keeps the final it replaces (owner, 2026-10-27).
 *
 * The accepted final used to be overwritten in place with no copy kept. Now:
 * the new render is verified first, the previous final + the sidecars that
 * belong to it are moved into `_previous_finals/`, and the daily retention tick
 * hands that folder to Story's one Trash after three days. A failed render
 * leaves the accepted final exactly where it was.
 */

import { after, before, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import { existsSync } from 'node:fs'
import path from 'node:path'

import {
  FINAL_VIDEO_REPLACEMENTS_SIDECAR,
  FINAL_VIDEO_RETENTION_DAYS,
  PREVIOUS_FINALS_DIRNAME,
  publishOverPreviousFinal,
  readRetainedFinalVideos,
  retainPreviousFinalVideo,
  sweepChannelRetainedFinalVideos,
} from '../services/final-video-retention.js'
import { TRASH_INDEX } from '../lib/trash-move.js'

const CODE = 'EP0007'
const FINAL = `${CODE}_final_video.mp4`
const DAY = 24 * 60 * 60 * 1000

let root: string
let projectDir: string
let videoDir: string
let finalPath: string

const job = () => ({ output_lines: [] as string[] }) as any

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'final-replacement-'))
})

after(async () => {
  // The harness's own scratch space (like every other suite's temp data dir).
  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
})

beforeEach(async () => {
  projectDir = await fs.mkdtemp(path.join(root, 'channel-'))
  videoDir = path.join(projectDir, 'Season 01', `${CODE} - Some title`, 'video')
  await fs.mkdir(videoDir, { recursive: true })
  finalPath = path.join(videoDir, FINAL)
})

async function seedFinal(bytes = 'OLD FINAL BYTES'): Promise<void> {
  await fs.writeFile(finalPath, bytes)
  await fs.writeFile(`${finalPath}.finalcheck.json`, JSON.stringify({ passed: true }))
  // A neighbour's sidecar must never travel with this episode's final (§6).
  await fs.writeFile(path.join(videoDir, 'EP0008_final_video.mp4.finalcheck.json'), JSON.stringify({ other: true }))
}

describe('a re-assembly keeps the final it replaces', () => {
  test('the previous final and its own sidecars move aside; the new render takes the name', async () => {
    await seedFinal()
    const log = job()
    const order: string[] = []
    const replacement = await publishOverPreviousFinal({
      job: log,
      project_slug: 'chan',
      projectDir,
      code: CODE,
      finalPath,
      newRenderPath: path.join(projectDir, `${CODE}_video_123.mp4`),
      finalName: FINAL,
      verify: async () => { order.push('verify') },
      publish: async () => {
        order.push('publish')
        await fs.writeFile(finalPath, 'NEW FINAL BYTES')
        return finalPath
      },
    })

    assert.deepEqual(order, ['verify', 'publish'], 'the new render is checked before the old one moves')
    assert.equal(replacement.previousExisted, true)
    assert.equal(replacement.restored, false)
    assert.equal(await fs.readFile(finalPath, 'utf8'), 'NEW FINAL BYTES')

    assert.ok(replacement.retained, 'the previous final was kept')
    const keptDir = replacement.retained!.retained_path
    assert.ok(keptDir.startsWith(path.join(videoDir, PREVIOUS_FINALS_DIRNAME) + path.sep), keptDir)
    assert.equal(await fs.readFile(path.join(keptDir, FINAL), 'utf8'), 'OLD FINAL BYTES')
    assert.equal(await fs.readFile(path.join(keptDir, `${FINAL}.finalcheck.json`), 'utf8'), JSON.stringify({ passed: true }))
    assert.equal(existsSync(path.join(videoDir, `${FINAL}.finalcheck.json`)), false, 'the old verdict moved with the old video')
    assert.equal(existsSync(path.join(videoDir, 'EP0008_final_video.mp4.finalcheck.json')), true, 'a neighbour keeps its sidecar')

    const recorded = readRetainedFinalVideos(projectDir)
    assert.equal(recorded.length, 1)
    assert.equal(recorded[0]!.retained_path, keptDir)
    assert.equal(recorded[0]!.final_name, FINAL)

    assert.match(log.output_lines.join('\n'), new RegExp(`Previous final kept for ${FINAL_VIDEO_RETENTION_DAYS} days`))
    assert.match(log.output_lines.join('\n'), /_previous_finals/)
  })

  test('a failed render leaves the accepted final untouched and publishes nothing', async () => {
    await seedFinal()
    const log = job()
    let published = false
    await assert.rejects(() => publishOverPreviousFinal({
      job: log,
      project_slug: 'chan',
      projectDir,
      code: CODE,
      finalPath,
      newRenderPath: path.join(projectDir, `${CODE}_video_123.mp4`),
      finalName: FINAL,
      verify: async () => { throw new Error('the finished video is 30 s short of the plan') },
      publish: async () => { published = true; return finalPath },
    }), /30 s short/)

    assert.equal(published, false, 'a render that fails its checks is never published')
    assert.equal(await fs.readFile(finalPath, 'utf8'), 'OLD FINAL BYTES')
    assert.equal(existsSync(path.join(videoDir, PREVIOUS_FINALS_DIRNAME)), false, 'nothing was moved aside')
    assert.equal(readRetainedFinalVideos(projectDir).length, 0)
    assert.match(log.output_lines.join('\n'), /previous final is unchanged/)
  })

  test('a publication that throws also puts the previous final back', async () => {
    await seedFinal()
    const log = job()
    await assert.rejects(() => publishOverPreviousFinal({
      job: log,
      project_slug: 'chan',
      projectDir,
      code: CODE,
      finalPath,
      newRenderPath: path.join(projectDir, `${CODE}_video_123.mp4`),
      finalName: FINAL,
      verify: async () => undefined,
      publish: async () => { throw new Error('another writer won the name') },
    }), /another writer won/)
    assert.equal(await fs.readFile(finalPath, 'utf8'), 'OLD FINAL BYTES')
    assert.equal(readRetainedFinalVideos(projectDir).length, 0)
  })

  test('a remote-refused fallback keeps its exclusive publish and moves nothing', async () => {
    await seedFinal()
    const refused = { output_lines: [] as string[], final_render_remote_wait: { phase: 'refused' } } as any
    let verified = false
    await assert.rejects(() => publishOverPreviousFinal({
      job: refused,
      project_slug: 'chan',
      projectDir,
      code: CODE,
      finalPath,
      newRenderPath: path.join(projectDir, `${CODE}_video_123.mp4`),
      finalName: FINAL,
      verify: async () => { verified = true },
      publish: async () => { throw new Error('Local fallback preserved the accepted final video') },
    }), /preserved the accepted final/)
    assert.equal(verified, false, 'the accepted-final conflict is reported, not masked by a check')
    assert.equal(await fs.readFile(finalPath, 'utf8'), 'OLD FINAL BYTES')
    assert.equal(existsSync(path.join(videoDir, PREVIOUS_FINALS_DIRNAME)), false)
  })

  test('a first assembly keeps its historical order and creates no retention record', async () => {
    const order: string[] = []
    const replacement = await publishOverPreviousFinal({
      job: job(),
      project_slug: 'chan',
      projectDir,
      code: CODE,
      finalPath,
      newRenderPath: path.join(projectDir, `${CODE}_video_123.mp4`),
      finalName: FINAL,
      verify: async () => { order.push('verify') },
      publish: async () => {
        order.push('publish')
        await fs.writeFile(finalPath, 'FIRST FINAL')
        return finalPath
      },
    })
    assert.deepEqual(order, ['publish'], 'a first render is checked after publication, as before')
    assert.equal(replacement.previousExisted, false)
    assert.equal(replacement.retained, null)
    assert.equal(existsSync(path.join(projectDir, FINAL_VIDEO_REPLACEMENTS_SIDECAR)), false)
  })

  test('a publication that did not land puts the previous final back', async () => {
    await seedFinal()
    const log = job()
    const replacement = await publishOverPreviousFinal({
      job: log,
      project_slug: 'chan',
      projectDir,
      code: CODE,
      finalPath,
      newRenderPath: path.join(projectDir, `${CODE}_video_123.mp4`),
      finalName: FINAL,
      verify: async () => undefined,
      // EPERM on a cloud-synced folder: the caller keeps the timestamped file.
      publish: async () => path.join(projectDir, `${CODE}_video_123.mp4`),
    })
    assert.equal(replacement.restored, true)
    assert.equal(await fs.readFile(finalPath, 'utf8'), 'OLD FINAL BYTES')
    assert.equal(readRetainedFinalVideos(projectDir).length, 0)
    assert.match(log.output_lines.join('\n'), /previous final was put back/)
  })
})

describe('the kept final ages into Story\'s Trash after three days', () => {
  async function retain(now: number): Promise<string> {
    const kept = await retainPreviousFinalVideo({
      job: job(), projectDir, code: CODE, finalPath, now,
    })
    assert.ok(kept)
    await fs.writeFile(finalPath, 'NEW FINAL BYTES')
    return kept.retained_path
  }

  test('inside the window it stays, with its record', async () => {
    await seedFinal()
    const keptDir = await retain(Date.now() - 2 * DAY)
    const result = await sweepChannelRetainedFinalVideos({ projectDir, slug: 'chan' })
    assert.equal(result.swept, 0)
    assert.equal(existsSync(keptDir), true)
    assert.equal(readRetainedFinalVideos(projectDir).length, 1)
  })

  test('past the window the folder is in Story\'s Trash, recorded in the index', async () => {
    await seedFinal()
    const keptDir = await retain(Date.now() - (FINAL_VIDEO_RETENTION_DAYS * DAY + 60_000))
    const result = await sweepChannelRetainedFinalVideos({ projectDir, slug: 'chan' })
    assert.equal(result.swept, 1)
    assert.equal(result.deferred, 0)
    assert.equal(existsSync(keptDir), false)
    assert.equal(readRetainedFinalVideos(projectDir).length, 0, 'the handled record leaves the channel list')

    // Story's one Trash is `<parent of the channel>/_trash/<slug>/…`, and every
    // move is recorded in its `.trash-index.jsonl` (that is what Restore reads).
    const trashRoot = path.join(path.dirname(projectDir), '_trash')
    const index = await fs.readFile(path.join(trashRoot, TRASH_INDEX), 'utf8')
    const lines = index.trim().split('\n').map(line => JSON.parse(line))
    const entry = lines.find((row: any) => row.from === keptDir)
    assert.ok(entry, 'the move has an index entry')
    assert.equal(entry.kind, 'final-video')
    assert.equal(existsSync(path.join(entry.to, FINAL)), true, 'the video travelled with the folder')
  })
})

describe('the channel record is a measurement, not a convenient zero', () => {
  test('a malformed record throws instead of reading as "nothing retained"', async () => {
    await fs.writeFile(path.join(projectDir, FINAL_VIDEO_REPLACEMENTS_SIDECAR), '{ not json')
    assert.throws(() => readRetainedFinalVideos(projectDir), /not valid JSON/)
  })

  test('an absent record is honestly empty', () => {
    assert.deepEqual(readRetainedFinalVideos(projectDir), [])
  })
})
