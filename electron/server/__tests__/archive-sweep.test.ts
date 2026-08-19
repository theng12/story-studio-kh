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
import { existsSync, readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'node:url'
import { useTempDataDir } from './_helpers.js'

let sweep: typeof import('../services/archive-sweep.js')
let pm: typeof import('../services/project-manager.js')
let tmp: { dir: string; cleanup: () => Promise<void> }

before(async () => {
  sweep = await import('../services/archive-sweep.js')
  pm = await import('../services/project-manager.js')
})
beforeEach(async () => {
  await tmp?.cleanup()
  tmp = await useTempDataDir()
})
after(async () => { await tmp?.cleanup() })

const SLUG = 'terranash'

/** An accepted episode, optionally with a proven YouTube upload. */
async function seedEpisode(code: string, title: string, uploaded: boolean) {
  const root = pm.projectsRoot()
  const projDir = path.join(root, SLUG)
  await fs.mkdir(projDir, { recursive: true })
  if (!existsSync(path.join(projDir, 'project.json'))) {
    await fs.writeFile(path.join(projDir, 'project.json'), JSON.stringify({
      slug: SLUG, name: 'TerraNash', episode_prefix: 'TN', episode_digits: 4,
      season_size: 20, season_prefix: 'Season',
      folder_template: '{season_prefix} {season_num}/{code} - {title}/',
      subfolder_names: {}, output_root: './episodes',
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

  const epDir = path.join(projDir, 'episodes', 'Season 001', `${code} - ${title}`)
  await fs.mkdir(epDir, { recursive: true })
  if (uploaded) {
    await fs.writeFile(path.join(epDir, 'youtube_upload.json'), JSON.stringify({
      platform: 'youtube', video_id: `vid-${code}`, uploaded_at: new Date().toISOString(),
    }))
  }
  return epDir
}

/** A finished video sitting in an exports pile. */
async function seedExport(sourceRoot: string, code: string, bytes = 2048) {
  await fs.mkdir(sourceRoot, { recursive: true })
  const file = path.join(sourceRoot, `${code}_final_video.mp4`)
  await fs.writeFile(file, Buffer.alloc(bytes, code.charCodeAt(0)))
  return file
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
    assert.match(unproven.reason!, /not confirmed uploaded/)
    const stray = preview.candidates.find(c => c.filename === 'holiday-clip.mp4')!
    assert.match(stray.reason!, /no episode code/)
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
    const faraway = path.join(tmp.dir, 'Downloads', 'YouTube Exports', 'terranash')
    await seedEpisode('TN0007', 'Far Away', true)
    await seedExport(faraway, 'TN0007')
    const preview = await sweep.previewArchiveSweep({ sourceRoot: path.join(tmp.dir, 'Downloads', 'YouTube Exports') })
    assert.equal(preview.ready_count, 1, 'a video outside the Library must still resolve to its episode')
  })

  test('a missing source folder is reported, not treated as "nothing to do"', async () => {
    const preview = await sweep.previewArchiveSweep({ sourceRoot: path.join(tmp.dir, 'nope') })
    assert.equal(preview.source_exists, false)
    assert.equal(preview.ready_count, 0)
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

  test('a name collision is refused rather than overwriting a finished video', async () => {
    const src = path.join(tmp.dir, 'exports')
    const dest = path.join(tmp.dir, 'archive')
    await seedEpisode('TN0001', 'Uploaded One', true)
    await seedExport(src, 'TN0001')
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
    assert.ok(existsSync(path.join(src, 'TN0001_final_video.mp4')), 'and the source stays put')
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
    const left = (await fs.readdir(src)).filter(f => f.endsWith('.mp4'))
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
})


