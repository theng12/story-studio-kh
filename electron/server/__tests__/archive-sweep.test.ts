/**
 * v1.4.4 — moving finished videos out, without ever losing one.
 *
 * *"i also want to add an option to move uploaded videos to a folder anywhere i
 * want … so that only finished videos live there. this way i can consider
 * backing it up and clearing for storage or just delete it or something."*
 *
 * Every test here exists because of one asymmetry: a video that fails to move
 * is an inconvenience, and a video that is deleted before its copy was checked
 * is gone forever. So the ordering — copy, verify, THEN remove — is asserted
 * directly, including in the failure case where it matters most.
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import { existsSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'node:url'
import { useTempDataDir } from './_helpers.js'
import { DEFAULT_SUBFOLDER_NAMES } from '../models/types.js'
import { saveYouTubeChannelGrantForTest } from './_youtube-connection-test-helper.js'

let sweep: typeof import('../services/archive-sweep.js')
let pm: typeof import('../services/project-manager.js')
let connections: typeof import('../services/youtube-connection-store.js')
let operations: typeof import('../services/youtube-operation-store.js')
let sourceVideo: typeof import('../services/youtube-source-video.js')
let tmp: { dir: string; cleanup: () => Promise<void> }

before(async () => {
  sweep = await import('../services/archive-sweep.js')
  pm = await import('../services/project-manager.js')
  connections = await import('../services/youtube-connection-store.js')
  operations = await import('../services/youtube-operation-store.js')
  sourceVideo = await import('../services/youtube-source-video.js')
})
beforeEach(async () => {
  await tmp?.cleanup()
  tmp = await useTempDataDir()
})
after(async () => { await tmp?.cleanup() })

const SLUG = 'sleep-stories'

/**
 * v1.4.10 — every helper here now takes a SLUG, and that is the point.
 *
 * This fixture used to be a single project on one prefix, which is why
 * the worst bug this feature ever had shipped green. The sweep proved a file's
 * upload by episode code alone; seven of the owner's eleven channels use the
 * `EP` prefix and 302 codes exist in more than one channel, so an upload on one
 * channel authorised deleting another channel's master. In a single-project
 * fixture that case cannot be written down at all — the suite was not failing
 * to catch it, it was unable to.
 */

/** An accepted episode, optionally with a proven YouTube upload. */
async function seedEpisode(code: string, title: string, uploaded: boolean, slug = SLUG) {
  const root = pm.projectsRoot()
  const projDir = path.join(root, slug)
  await fs.mkdir(projDir, { recursive: true })
  if (!existsSync(path.join(projDir, 'project.json'))) {
    await fs.writeFile(path.join(projDir, 'project.json'), JSON.stringify({
      slug, name: slug, episode_prefix: code.replace(/\d+$/, ''), episode_digits: 4,
      season_size: 20, season_prefix: 'Season',
      folder_template: '{season_prefix} {season_num}/{code} - {title}/',
      subfolder_names: DEFAULT_SUBFOLDER_NAMES,
      created_at: new Date().toISOString(),
    }))
  }
  const ideasPath = path.join(projDir, 'ideas.json')
  let ideas: any = { ideas: [] }
  try { ideas = JSON.parse(await fs.readFile(ideasPath, 'utf-8')) } catch { /* first */ }
  ideas.ideas.push({
    id: `idea-${code}`, title, status: 'accepted', episode_code: code,
    generated_at: new Date().toISOString(), accepted_at: new Date().toISOString(),
  })
  await fs.writeFile(ideasPath, JSON.stringify(ideas))

  // Season folder computed the same way the app computes it, so codes past the
  // first season (EP0042 → Season 003) land where `resolveEpisodePaths` looks.
  const epNum = parseInt(code.replace(/^[A-Za-z]+/, ''), 10) || 1
  const season = `Season ${String(Math.floor((epNum - 1) / 20) + 1).padStart(3, '0')}`
  const epDir = path.join(projDir, 'episodes', season, `${code} - ${title}`)
  await fs.mkdir(epDir, { recursive: true })
  if (uploaded) {
    await fs.writeFile(path.join(epDir, 'youtube_upload.json'), JSON.stringify({
      platform: 'youtube', video_id: `vid-${code}`, uploaded_at: new Date().toISOString(),
    }))
  }
  return epDir
}

/**
 * A finished video sitting in an exports pile, inside its channel's folder.
 *
 * The channel folder is not decoration: since v1.4.10 it is the ONLY thing that
 * ties a file to a channel, and a file that has no channel folder is refused
 * rather than guessed at.
 */
async function seedExport(sourceRoot: string, code: string, bytes = 2048, slug = SLUG) {
  const dir = slug ? path.join(sourceRoot, slug) : sourceRoot
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, `${code}_final_video.mp4`)
  await fs.writeFile(file, Buffer.alloc(bytes, code.charCodeAt(0)))
  // When this fixture has a receipt, the exported bytes are the bytes that
  // were uploaded. Persist the receipt after the candidate write so its
  // timestamp can truthfully prove this exact legacy file is not newer.
  const projectDir = path.join(pm.projectsRoot(), slug)
  const ideas = JSON.parse(await fs.readFile(path.join(projectDir, 'ideas.json'), 'utf-8'))
  const title = ideas.ideas.find((idea: any) => idea.episode_code === code)?.title
  if (title) {
    const epNum = parseInt(code.replace(/^[A-Za-z]+/, ''), 10) || 1
    const season = `Season ${String(Math.floor((epNum - 1) / 20) + 1).padStart(3, '0')}`
    const receiptPath = path.join(projectDir, 'episodes', season, `${code} - ${title}`, 'youtube_upload.json')
    if (existsSync(receiptPath)) {
      const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf-8'))
      receipt.uploaded_at = new Date().toISOString()
      await fs.writeFile(receiptPath, JSON.stringify(receipt))
    }
  }
  return file
}

async function writeCanonicalOperation(
  slug: string,
  code: string,
  file: string,
  lifecycle: 'ready' | 'failed' | 'rejected' = 'ready',
  videoId = `canonical-${code}`,
): Promise<void> {
  const channelId = `channel-${slug}`
  await connections.configureYouTubeApplication({ client_id: 'archive-client', client_secret: 'archive-secret' })
  await saveYouTubeChannelGrantForTest({
    channel: { channel_id: channelId, title: slug, granted_scopes: ['youtube.upload'] },
    tokens: { access_token: `access-${slug}`, refresh_token: `refresh-${slug}`, expires_at: Date.now() + 3_600_000 },
  })
  await connections.assignProjectYouTubeChannel({
    project_slug: slug, channel_id: channelId, expected_previous_channel_id: null,
  })
  const payload = {
    snippet_json: JSON.stringify({ title: code, description: '', tags: [], categoryId: '24' }),
    status_json: JSON.stringify({ privacyStatus: 'public' }),
    source_sha256: 'b'.repeat(64),
  }
  const opened = await operations.createYouTubeOperation({
    project_slug: slug, episode_code: code, channel_id: channelId,
    source_revision: await sourceVideo.resolveYouTubeSourceRevision(file),
    metadata_revision: payload.source_sha256, final_payload: payload,
    origin: 'manual', final_action: 'manual_upload',
  })
  const accepted = await operations.acceptYouTubeOperation({
    project_slug: slug, operation_id: opened.operation_id, expected_revision: opened.revision,
    channel_id: channelId, video_id: videoId, accepted_at: new Date().toISOString(), final_payload: payload,
  })
  await operations.updateYouTubeOperation({
    project_slug: slug, operation_id: accepted.operation_id, expected_revision: accepted.revision,
    mutate(record) { record.lifecycle = lifecycle },
  })
}

describe('deciding what may be moved', () => {
  test('only a confirmed upload qualifies; everything else is skipped WITH a reason', async () => {
    const src = path.join(tmp.dir, 'exports')
    await seedEpisode('TN0001', 'Uploaded One', true)
    await seedEpisode('TN0002', 'Never Uploaded', false)
    await seedExport(src, 'TN0001')
    await seedExport(src, 'TN0002')
    await fs.writeFile(path.join(src, 'holiday-clip.mp4'), 'not an episode')

    const preview = await sweep.previewArchiveSweep({ sourceRoot: src })
    assert.equal(preview.ready_count, 1)
    assert.equal(preview.skipped_count, 2)

    const ready = preview.candidates.find(c => c.status === 'ready')!
    assert.equal(ready.code, 'TN0001')
    assert.equal(ready.slug, SLUG)

    const unproven = preview.candidates.find(c => c.code === 'TN0002')!
    assert.match(unproven.reason!, /not the exact render confirmed usable/)
    const stray = preview.candidates.find(c => c.filename === 'holiday-clip.mp4')!
    assert.match(stray.reason!, /no episode code/)
  })

  test('a code-shaped folder ABOVE the scan cannot lend its code to a file inside', async () => {
    // v1.4.44 — the folder search ran over the whole absolute path, so any
    // ancestor between the disk root and the scan could donate a code. It
    // showed up here as an intermittent failure: a system temp folder named
    // `…-JW5269` made an unrelated holiday clip claim to be episode JW5269.
    // The same happens to anyone whose Videos folder sits under a path with
    // two-to-six letters and three-to-five digits in it.
    const above = path.join(tmp.dir, 'JW5269')
    const src = path.join(above, 'exports')
    await fs.mkdir(src, { recursive: true })
    await fs.writeFile(path.join(src, 'holiday-clip.mp4'), 'not an episode')

    const preview = await sweep.previewArchiveSweep({ sourceRoot: src })

    const stray = preview.candidates.find(c => c.filename === 'holiday-clip.mp4')!
    assert.equal(stray.code, '', 'a file outside any episode folder has no code to report')
    assert.match(stray.reason!, /no episode code/)
  })

  test('a code-shaped folder INSIDE the scan still names the episode', async () => {
    // The fix must not cost the real behaviour: the scanned tree is exactly
    // where a code legitimately comes from.
    const src = path.join(tmp.dir, 'exports-inside')
    await fs.mkdir(path.join(src, 'TN0001 - Uploaded One'), { recursive: true })
    await fs.writeFile(path.join(src, 'TN0001 - Uploaded One', 'final.mp4'), 'video')

    const preview = await sweep.previewArchiveSweep({ sourceRoot: src })

    assert.equal(preview.candidates.find(c => c.filename === 'final.mp4')!.code, 'TN0001')
  })

  test('the preview is a preview — it moves nothing', async () => {
    const src = path.join(tmp.dir, 'exports')
    await seedEpisode('TN0001', 'Uploaded One', true)
    const file = await seedExport(src, 'TN0001')
    await sweep.previewArchiveSweep({ sourceRoot: src })
    assert.ok(existsSync(file), 'previewing must not move anything')
  })

  test('it can see videos that are nowhere near the Library', async () => {
    // The point of the feature on day one: his 220 GB are in ~/Downloads, put
    // there by a setting that no longer exists. A sweep that only looked in
    // <Library>/Exports would find nothing.
    const faraway = path.join(tmp.dir, 'Downloads', 'YouTube Exports')
    await seedEpisode('TN0007', 'Far Away', true)
    await seedExport(faraway, 'TN0007')
    const preview = await sweep.previewArchiveSweep({ sourceRoot: faraway })
    assert.equal(preview.ready_count, 1, 'a video outside the Library must still resolve to its episode')
  })

  test('a missing source folder is reported, not treated as "nothing to do"', async () => {
    const preview = await sweep.previewArchiveSweep({ sourceRoot: path.join(tmp.dir, 'nope') })
    assert.equal(preview.source_exists, false)
    assert.equal(preview.ready_count, 0)
  })

  test('a ready canonical operation authorizes only its exact source revision', async () => {
    const src = path.join(tmp.dir, 'canonical-exports')
    await seedEpisode('TN0020', 'Canonical Archive', false)
    const file = await seedExport(src, 'TN0020')
    await writeCanonicalOperation(SLUG, 'TN0020', file)

    let preview = await sweep.previewArchiveSweep({ sourceRoot: src })
    assert.equal(preview.ready_count, 1)
    assert.equal(preview.candidates[0]?.youtube_video_id, 'canonical-TN0020')

    await fs.writeFile(file, Buffer.alloc(4096))
    preview = await sweep.previewArchiveSweep({ sourceRoot: src })
    assert.equal(preview.ready_count, 0)
    assert.equal(preview.candidates[0]?.reason_code, 'not_uploaded')
    assert.equal(existsSync(file), true)
  })

  test('a legacy receipt cannot authorize an export rendered after its upload', async () => {
    const src = path.join(tmp.dir, 'legacy-newer-exports')
    const episodeDir = await seedEpisode('TN0021', 'Legacy Newer', true)
    const file = await seedExport(src, 'TN0021')
    const receipt = JSON.parse(await fs.readFile(path.join(episodeDir, 'youtube_upload.json'), 'utf-8'))
    await fs.writeFile(file, Buffer.alloc(4096))
    const newer = new Date(Date.parse(receipt.uploaded_at) + 1_000)
    await fs.utimes(file, newer, newer)

    const preview = await sweep.previewArchiveSweep({ sourceRoot: src })
    assert.equal(preview.ready_count, 0)
    assert.equal(preview.candidates[0]?.reason_code, 'not_uploaded')
    assert.equal(existsSync(file), true)
  })

  test('a failed canonical operation blocks its same-video sidecar from authorizing archive', async () => {
    const src = path.join(tmp.dir, 'failed-same-video')
    await seedEpisode('TN0022', 'Failed Same Video', true)
    const file = await seedExport(src, 'TN0022')
    await writeCanonicalOperation(SLUG, 'TN0022', file, 'failed', 'vid-TN0022')

    const preview = await sweep.previewArchiveSweep({ sourceRoot: src })
    assert.equal(preview.ready_count, 0)
    assert.equal(preview.candidates[0]?.reason_code, 'not_uploaded')
    assert.equal(existsSync(file), true)
  })

  test('a failed retry for another video does not invalidate historical archive proof', async () => {
    const src = path.join(tmp.dir, 'failed-different-video')
    await seedEpisode('TN0023', 'Failed Different Video', true)
    const file = await seedExport(src, 'TN0023')
    await writeCanonicalOperation(SLUG, 'TN0023', file, 'failed', 'failed-retry-TN0023')

    const preview = await sweep.previewArchiveSweep({ sourceRoot: src })
    assert.equal(preview.ready_count, 1)
    assert.equal(preview.candidates[0]?.youtube_video_id, 'vid-TN0023')
  })
})

/**
 * The cross-channel case — the reason 1.4.10 exists.
 *
 * `EP0042` is a real collision on his machine: one channel's is a finished
 * master he never uploaded, a second channel's is published. Keyed on the code
 * alone, the second channel's upload marked the first channel's file `ready`,
 * copied it into the second channel's archive folder, verified it byte-for-byte
 * in the wrong place, and
 * removed the original. 2.23 GB, gone, with a green checksum.
 */
describe('a code is not an identity — it belongs to a channel', () => {
  const OTHER = 'devotional'

  test('an upload on one channel must NOT authorise moving another channel’s file', async () => {
    const src = path.join(tmp.dir, 'YouTube Exports')
    await seedEpisode('EP0042', 'Published Elsewhere', true, OTHER)
    await seedEpisode('EP0042', 'The Real Reason Suleiman', false, 'my-channel')
    const master = await seedExport(src, 'EP0042', 2048, 'my-channel')

    const preview = await sweep.previewArchiveSweep({ sourceRoot: src })
    const row = preview.candidates.find(c => c.source_path === master)!
    assert.equal(row.status, 'skipped', 'the un-uploaded master must not be ready to move')
    assert.equal(row.reason_code, 'not_uploaded')
    assert.match(row.reason!, /my-channel/, 'the reason must name the channel it was judged against')
    assert.equal(preview.ready_count, 0)

    const dest = path.join(tmp.dir, 'archive')
    const result = await sweep.runArchiveSweep({ destination: dest, sourceRoot: src })
    assert.equal(result.moved.length, 0)
    assert.ok(existsSync(master), 'the un-uploaded master must still be exactly where it was')
    assert.equal(existsSync(path.join(dest, OTHER, 'EP0042_final_video.mp4')), false,
      'and nothing may land in the other channel’s archive folder')
  })

  test('the same code on the channel that DID upload it still moves, to its own folder', async () => {
    // The fix must not be a blanket refusal: the proven side of the collision
    // is still archivable, and only into its own channel's folder.
    const src = path.join(tmp.dir, 'YouTube Exports')
    await seedEpisode('EP0042', 'Published Here', true, OTHER)
    await seedEpisode('EP0042', 'Not Published There', false, 'my-channel')
    const published = await seedExport(src, 'EP0042', 2048, OTHER)
    const master = await seedExport(src, 'EP0042', 4096, 'my-channel')

    const dest = path.join(tmp.dir, 'archive')
    const result = await sweep.runArchiveSweep({ destination: dest, sourceRoot: src })
    assert.equal(result.moved.length, 1)
    assert.equal(result.moved[0]!.slug, OTHER)
    assert.equal(result.moved[0]!.from, published)
    assert.equal(path.basename(path.dirname(result.moved[0]!.to)), OTHER)
    assert.equal(existsSync(published), false)
    assert.ok(existsSync(master), 'the other channel’s file is untouched')
  })

  test('a file whose channel cannot be worked out is refused, never guessed', async () => {
    // No channel folder anywhere in its path. Before 1.4.10 the bare code was
    // enough; now the absence of a channel is itself the answer.
    const src = path.join(tmp.dir, 'loose')
    await seedEpisode('TN0001', 'Uploaded One', true)
    await fs.mkdir(src, { recursive: true })
    const loose = path.join(src, 'TN0001_final_video.mp4')
    await fs.writeFile(loose, Buffer.alloc(2048, 7))

    const preview = await sweep.previewArchiveSweep({ sourceRoot: src })
    const row = preview.candidates[0]!
    assert.equal(row.status, 'skipped')
    assert.equal(row.reason_code, 'unknown_channel')

    const result = await sweep.runArchiveSweep({ destination: path.join(tmp.dir, 'archive'), sourceRoot: src })
    assert.equal(result.moved.length, 0)
    assert.ok(existsSync(loose))
  })

  test('scanning one channel’s folder directly still identifies the channel', async () => {
    // He may point the picker at `…/YouTube Exports/<channel>` rather than its
    // parent. That is the same evidence, stated one level up.
    const src = path.join(tmp.dir, 'YouTube Exports')
    await seedEpisode('TN0001', 'Uploaded One', true)
    await seedExport(src, 'TN0001')
    const preview = await sweep.previewArchiveSweep({ sourceRoot: path.join(src, SLUG) })
    assert.equal(preview.ready_count, 1)
    assert.equal(preview.candidates[0]!.slug, SLUG)
  })
})

describe('moving, without losing anything', () => {
  test('copies, then removes — and the destination byte-matches', async () => {
    const src = path.join(tmp.dir, 'exports')
    const dest = path.join(tmp.dir, 'archive')
    await seedEpisode('TN0001', 'Uploaded One', true)
    const file = await seedExport(src, 'TN0001', 4096)
    const original = await fs.readFile(file)

    const result = await sweep.runArchiveSweep({ destination: dest, sourceRoot: src })
    assert.equal(result.moved.length, 1)
    assert.equal(result.bytes_moved, 4096)
    assert.equal(existsSync(file), false, 'the source is removed after a verified copy')

    const moved = result.moved[0]!.to
    assert.ok(existsSync(moved))
    assert.deepEqual(await fs.readFile(moved), original, 'the archived copy must be byte-identical')
    // Grouped per channel so the archive stays legible rather than 200 loose files.
    assert.equal(path.basename(path.dirname(moved)), SLUG)
  })

  test('an unproven episode is not touched even when it sits beside a moved one', async () => {
    const src = path.join(tmp.dir, 'exports')
    const dest = path.join(tmp.dir, 'archive')
    await seedEpisode('TN0001', 'Uploaded One', true)
    await seedEpisode('TN0002', 'Never Uploaded', false)
    await seedExport(src, 'TN0001')
    const kept = await seedExport(src, 'TN0002')

    const result = await sweep.runArchiveSweep({ destination: dest, sourceRoot: src })
    assert.equal(result.moved.length, 1)
    assert.ok(existsSync(kept), 'an unproven video must stay exactly where it was')
    assert.equal(existsSync(path.join(dest, SLUG, 'TN0002_final_video.mp4')), false)
  })

  test('there is no force option — the safety rule cannot be argued with', () => {
    // storage-audit's delete path accepts `force: true` to bypass the upload
    // check. This one deliberately does not: he is clearing space, not
    // gambling with masters. (`fs.rm(..., { force: true })` is unrelated — that
    // is "do not error if absent", so the check is for an OPTION, not the word.)
    const src = readFileSync(fileURLToPath(new URL('../services/archive-sweep.ts', import.meta.url)), 'utf8')
    assert.ok(!/force\??\s*:\s*boolean/.test(src), 'the sweep must expose no force option')
    assert.ok(!/opts\.force|options\.force/.test(src), 'the sweep must never read a force flag')
  })

  test('copy verification and source removal share the final pathname lock', () => {
    const src = readFileSync(fileURLToPath(new URL('../services/archive-sweep.ts', import.meta.url)), 'utf8')
    const lockAt = src.indexOf('withFinalVideoPathLock(candidate.source_path')
    const copyAt = src.indexOf('await fs.copyFile(candidate.source_path, target,')
    const verifyAt = src.indexOf('const [sourceHash, targetHash]')
    const exclusiveCopyAt = src.indexOf('fsConstants.COPYFILE_EXCL')
    const removeAt = src.indexOf('await fs.rm(candidate.source_path, { force: true })')
    assert.ok(lockAt >= 0 && lockAt < copyAt && copyAt < exclusiveCopyAt && exclusiveCopyAt < verifyAt && verifyAt < removeAt)
  })

  test('a name collision is refused rather than overwriting a finished video', async () => {
    const src = path.join(tmp.dir, 'exports')
    const dest = path.join(tmp.dir, 'archive')
    await seedEpisode('TN0001', 'Uploaded One', true)
    const source = await seedExport(src, 'TN0001')
    await fs.mkdir(path.join(dest, SLUG), { recursive: true })
    await fs.writeFile(path.join(dest, SLUG, 'TN0001_final_video.mp4'), 'something already here')

    const result = await sweep.runArchiveSweep({ destination: dest, sourceRoot: src })
    assert.equal(result.moved.length, 0)
    assert.match(result.skipped[0]!.reason, /already in the archive folder/)
    assert.equal(
      await fs.readFile(path.join(dest, SLUG, 'TN0001_final_video.mp4'), 'utf-8'),
      'something already here',
      'an existing archived file must never be clobbered',
    )
    assert.ok(existsSync(source), 'and the source stays put')
  })

  test('a stop leaves every remaining file untouched', async () => {
    const src = path.join(tmp.dir, 'exports')
    const dest = path.join(tmp.dir, 'archive')
    for (const code of ['TN0001', 'TN0002', 'TN0003']) {
      await seedEpisode(code, `Episode ${code}`, true)
      await seedExport(src, code)
    }
    let seen = 0
    const result = await sweep.runArchiveSweep({
      destination: dest,
      sourceRoot: src,
      // Stop after the first file. A stop is honoured BETWEEN files, so a copy
      // is never interrupted midway.
      shouldStop: () => seen >= 1,
      onProgress: () => { seen += 1 },
    })
    assert.equal(result.cancelled, true)
    assert.equal(result.moved.length, 1)
    const left = (await fs.readdir(path.join(src, SLUG))).filter(f => f.endsWith('.mp4'))
    assert.equal(left.length, 2, 'everything not yet moved must still be at the source')
  })

  test('progress is reported per file', async () => {
    const src = path.join(tmp.dir, 'exports')
    await seedEpisode('TN0001', 'One', true)
    await seedEpisode('TN0002', 'Two', true)
    await seedExport(src, 'TN0001')
    await seedExport(src, 'TN0002')
    const seen: Array<[number, number]> = []
    await sweep.runArchiveSweep({
      destination: path.join(tmp.dir, 'archive'),
      sourceRoot: src,
      onProgress: (done, total) => seen.push([done, total]),
    })
    assert.deepEqual(seen, [[1, 2], [2, 2]])
  })
})

describe('the breadcrumb', () => {
  test('an archived episode records WHERE its video went', async () => {
    // Without this, an archived episode looks identical to one whose video has
    // gone missing — and 1.4.2 taught the app to report exactly that, so the
    // sweep would manufacture the false alarm that reporting exists to catch.
    const src = path.join(tmp.dir, 'exports')
    const epDir = await seedEpisode('TN0001', 'Uploaded One', true)
    await seedExport(src, 'TN0001')

    const result = await sweep.runArchiveSweep({ destination: path.join(tmp.dir, 'archive'), sourceRoot: src })
    const record = await sweep.readArchiveRecord(epDir)
    assert.ok(record, 'the episode must record its archive destination')
    assert.equal(record!.archived_to, result.moved[0]!.to)
    assert.equal(record!.youtube_video_id, 'vid-TN0001', 'the proof that authorised the move travels with it')
    assert.match(record!.sha256, /^[0-9a-f]{64}$/)
  })

  test('an episode that was never archived has no record', async () => {
    const epDir = await seedEpisode('TN0009', 'Untouched', true)
    assert.equal(await sweep.readArchiveRecord(epDir), null)
  })

  test('a breadcrumb never conjures an episode folder that is not there', async () => {
    // `writeAtomic` does `mkdir(recursive)`. Aimed at an episode that does not
    // exist it invents the folder — which, paired with the cross-channel bug
    // above, meant fabricating an episode on the wrong channel as a side effect
    // of archiving. A missing folder is a fault to report, not one to create.
    const src = path.join(tmp.dir, 'YouTube Exports')
    const epDir = await seedEpisode('TN0001', 'Uploaded One', true)
    await seedExport(src, 'TN0001')

    let pulled = false
    const result = await sweep.runArchiveSweep({
      destination: path.join(tmp.dir, 'archive'),
      sourceRoot: src,
      // Fires after the proof is read and before the copy — the one moment the
      // episode folder can go missing underneath a sweep.
      shouldStop: () => {
        if (!pulled) { rmSync(epDir, { recursive: true, force: true }); pulled = true }
        return false
      },
    })

    assert.equal(result.moved.length, 0, 'a missing fresh receipt blocks the move before any source removal')
    assert.equal(existsSync(src + path.sep + SLUG + path.sep + 'TN0001_final_video.mp4'), true)
    assert.equal(existsSync(epDir), false, 'the missing episode folder must NOT be recreated')
    assert.ok(result.skipped.some(item => item.code === 'TN0001'))
  })
})

/**
 * The bill he agreed to and the sweep that runs must be the same list.
 *
 * They used to be two separate computations: he approved a preview, and the run
 * threw it away and recomputed. Everything between the two — a render
 * finishing, an upload confirming — silently joined the move he had approved.
 */
describe('the run acts on the list he approved', () => {
  test('a video that arrives after he reviewed the list is left alone', async () => {
    const src = path.join(tmp.dir, 'YouTube Exports')
    const dest = path.join(tmp.dir, 'archive')
    await seedEpisode('TN0001', 'One', true)
    await seedEpisode('TN0002', 'Two', true)
    const reviewed = await seedExport(src, 'TN0001')

    const preview = await sweep.previewArchiveSweep({ sourceRoot: src })
    const approved = preview.candidates.filter(c => c.status === 'ready').map(c => c.source_path)
    assert.deepEqual(approved, [reviewed])

    // …and only now does a second finished video land in the same folder.
    const late = await seedExport(src, 'TN0002')

    const result = await sweep.runArchiveSweep({ destination: dest, sourceRoot: src, approved })
    assert.equal(result.moved.length, 1)
    assert.equal(result.moved[0]!.from, reviewed)
    assert.ok(existsSync(late), 'a video he never saw on the bill must not be moved')
    assert.ok(
      result.skipped.some(s => s.reason_code === 'not_reviewed' && s.source_path === late),
      'and it is reported as unreviewed rather than passed over in silence',
    )
  })

  test('a same-size render arriving after preview is freshly proven before its source can move', async () => {
    const src = path.join(tmp.dir, 'after-preview')
    const dest = path.join(tmp.dir, 'archive')
    await seedEpisode('TN0001', 'First', true)
    const secondEpisodeDir = await seedEpisode('TN0002', 'Second', true)
    await seedExport(src, 'TN0001')
    const second = await seedExport(src, 'TN0002')
    const receipt = JSON.parse(await fs.readFile(path.join(secondEpisodeDir, 'youtube_upload.json'), 'utf8'))
    const renderedLater = new Date(Date.parse(receipt.uploaded_at) + 1_000)
    let replaced = false

    const result = await sweep.runArchiveSweep({
      destination: dest,
      sourceRoot: src,
      onProgress: () => {
        if (replaced) return
        replaced = true
        // The preview has already included both candidates. Replacing this
        // second pathname is synchronous, so its later mtime is visible before
        // the next source lock is acquired without relying on a timer.
        writeFileSync(second, Buffer.alloc(2048, 9))
        utimesSync(second, renderedLater, renderedLater)
      },
    })

    assert.equal(result.moved.length, 1)
    assert.equal(result.moved[0]!.code, 'TN0001')
    assert.ok(existsSync(second), 'the unproven replacement remains at its source')
    assert.equal(existsSync(path.join(dest, SLUG, 'TN0002_final_video.mp4')), false)
    assert.ok(result.skipped.some(item => item.source_path === second && /receipt changed/.test(item.reason)))
  })

  test('approving something cannot loosen the upload rule', async () => {
    const src = path.join(tmp.dir, 'YouTube Exports')
    await seedEpisode('TN0002', 'Never Uploaded', false)
    const kept = await seedExport(src, 'TN0002')

    const result = await sweep.runArchiveSweep({
      destination: path.join(tmp.dir, 'archive'),
      sourceRoot: src,
      approved: [kept],
    })
    assert.equal(result.moved.length, 0, 'the approved list narrows what may move; it never widens it')
    assert.ok(existsSync(kept))
  })
})
