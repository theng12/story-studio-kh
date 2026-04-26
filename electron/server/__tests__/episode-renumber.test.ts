/**
 * Tests for the single-episode renumber service in
 * services/episode-renumber.ts.
 *
 * Coverage:
 *   - Happy path: episode dir + subfolders + per-asset files renamed
 *   - episode_info.json's episode_code field updated
 *   - ideas.json patched atomically (status='accepted', new code)
 *   - next_episode_number bumped past the new slot
 *   - Collision: target code already in use → throws (statusCode=409)
 *   - Bad prefix → throws
 *   - same-as-old → throws
 *   - Source idea not accepted → throws
 *   - Source folder missing on disk → still patches ideas.json with a warning
 *   - YouTube sidecar (file inside episode_dir) survives the rename
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

let er: typeof import('../services/episode-renumber.js')
let pm: typeof import('../services/project-manager.js')
let im: typeof import('../services/idea-manager.js')
let tmp: { dir: string; cleanup: () => Promise<void> }

const SLUG = 'renumber-test'
const TITLE = 'Renumber Demo'

async function makeProject(): Promise<void> {
  const projDir = path.join(pm.PROJECTS_ROOT, SLUG)
  const outputRoot = path.join(projDir, 'episodes')
  await fs.mkdir(projDir, { recursive: true })
  await fs.writeFile(path.join(projDir, 'project.json'), JSON.stringify({
    slug: SLUG, name: 'Renumber Demo',
    episode_prefix: 'TN', episode_digits: 4,
    season_size: 20, season_prefix: 'Season',
    folder_template: '{season_prefix} {season_num}/{code} - {title}/',
    subfolder_names: {}, output_root: outputRoot,
    created_at: new Date().toISOString(),
  }))
  await fs.writeFile(path.join(projDir, 'config.json'), JSON.stringify({}))
  await fs.writeFile(path.join(projDir, 'ideas.json'), JSON.stringify({
    ideas: [], next_episode_number: 1, recycled_numbers: [],
  }))
}

interface SeededEpisode { code: string; idea_id: string; episode_dir: string }

/**
 * Add an idea, accept it, and seed a few representative asset files
 * so the cascading rename has something to operate on.
 */
async function seedAcceptedEpisode(code: string): Promise<SeededEpisode> {
  const [created] = await im.addIdeas(SLUG, [{
    title: TITLE, logline: 'l', themes: [],
    suggested_chapters: 8, suggested_length: '30 min', mood: 'm',
  }], 'test-model')
  // Use override_code to land exactly at the desired code so each test
  // can target a known starting point without depending on the next
  // counter's state.
  const r = await im.acceptIdea(SLUG, created.id, false, { override_code: code })
  // Drop a sample asset file in each subfolder to verify cascading rename.
  const epDir = r.episode_dir
  const inSub = (sub: string, name: string) => path.join(epDir, sub, name)
  await fs.writeFile(inSub(`${code} - 01 Script`, `${code}_Chapter_01.docx`), 'chap1')
  await fs.writeFile(inSub(`${code} - 05 Scene Images`, `${code}_Scene01_v1.png`), 'png')
  await fs.writeFile(inSub(`${code} - 07 Audio Assets`, `${code}_Chapter_01.mp3`), 'mp3')
  await fs.writeFile(path.join(epDir, `${code}_final_video.mp4`), 'video')
  return { code, idea_id: created.id, episode_dir: epDir }
}

describe('episode-renumber: renameAcceptedEpisode', () => {
  before(async () => {
    tmp = await useTempDataDir()
    pm = await import('../services/project-manager.js')
    im = await import('../services/idea-manager.js')
    er = await import('../services/episode-renumber.js')
    assert.equal(pm.PROJECTS_ROOT, path.join(tmp.dir, 'projects'))
  })

  after(async () => { await tmp.cleanup() })

  beforeEach(async () => {
    await fs.rm(pm.PROJECTS_ROOT, { recursive: true, force: true }).catch(() => {})
    await fs.mkdir(pm.PROJECTS_ROOT, { recursive: true })
    await makeProject()
  })

  test('renames episode dir + subfolders + per-asset files', async () => {
    const seed = await seedAcceptedEpisode('TN0005')
    const r = await er.renameAcceptedEpisode(SLUG, 'TN0005', 'TN0099')
    assert.equal(r.ok, true)
    assert.equal(r.new_code, 'TN0099')

    // Old episode dir gone, new one exists.
    assert.equal(existsSync(seed.episode_dir), false, 'old episode dir removed')
    assert.equal(existsSync(r.new_dir), true, 'new episode dir exists')

    // Subfolders renamed with new code prefix.
    const subs = await fs.readdir(r.new_dir, { withFileTypes: true })
    const subNames = subs.filter(e => e.isDirectory()).map(e => e.name)
    assert.ok(subNames.some(n => n.startsWith('TN0099 - 01 Script')),
      `script subfolder should rename: got ${JSON.stringify(subNames)}`)
    assert.ok(!subNames.some(n => n.includes('TN0005')),
      `no subfolder should still reference TN0005: got ${JSON.stringify(subNames)}`)

    // Per-asset files inside renamed.
    const scriptFiles = await fs.readdir(path.join(r.new_dir, 'TN0099 - 01 Script'))
    assert.ok(scriptFiles.includes('TN0099_Chapter_01.docx'),
      `chapter file should rename: got ${JSON.stringify(scriptFiles)}`)
    const audioFiles = await fs.readdir(path.join(r.new_dir, 'TN0099 - 07 Audio Assets'))
    assert.ok(audioFiles.includes('TN0099_Chapter_01.mp3'))
    const sceneFiles = await fs.readdir(path.join(r.new_dir, 'TN0099 - 05 Scene Images'))
    assert.ok(sceneFiles.includes('TN0099_Scene01_v1.png'))

    // Root-level final-video file renamed.
    const rootFiles = await fs.readdir(r.new_dir)
    assert.ok(rootFiles.includes('TN0099_final_video.mp4'))
    assert.ok(!rootFiles.includes('TN0005_final_video.mp4'))
  })

  test('updates episode_info.json with the new code', async () => {
    await seedAcceptedEpisode('TN0005')
    const r = await er.renameAcceptedEpisode(SLUG, 'TN0005', 'TN0099')
    const infoPath = path.join(r.new_dir, 'episode_info.json')
    assert.ok(existsSync(infoPath), 'episode_info.json moved with the folder')
    const info = JSON.parse(await fs.readFile(infoPath, 'utf-8'))
    assert.equal(info.episode_code, 'TN0099', 'episode_code field updated to new value')
  })

  test('patches ideas.json so the idea now carries the new code', async () => {
    const seed = await seedAcceptedEpisode('TN0005')
    await er.renameAcceptedEpisode(SLUG, 'TN0005', 'TN0099')
    const ideas = await im.getIdeas(SLUG, 'accepted')
    const updated = ideas.find(i => i.id === seed.idea_id)
    assert.ok(updated, 'idea still in store')
    assert.equal(updated!.episode_code, 'TN0099', 'idea now carries new code')
  })

  test('bumps next_episode_number past the new slot', async () => {
    await seedAcceptedEpisode('TN0005')
    await er.renameAcceptedEpisode(SLUG, 'TN0005', 'TN0099')
    const next = await im.getNextEpisodeNumber(SLUG)
    assert.ok(next > 99, `next_episode_number must be > 99 to avoid future collision; got ${next}`)
  })

  test('rejects collision with another accepted code (409)', async () => {
    await seedAcceptedEpisode('TN0005')
    await seedAcceptedEpisode('TN0099')
    let caught: any = null
    try {
      await er.renameAcceptedEpisode(SLUG, 'TN0005', 'TN0099')
    } catch (e) { caught = e }
    assert.ok(caught, 'should throw')
    assert.equal((caught as any).statusCode, 409, 'collision uses 409 status')
    assert.match((caught as Error).message, /already in use/)
  })

  test('rejects bad prefix', async () => {
    await seedAcceptedEpisode('TN0005')
    await assert.rejects(
      () => er.renameAcceptedEpisode(SLUG, 'TN0005', 'XX0099'),
      /must start with prefix/,
    )
  })

  test('rejects same-as-old', async () => {
    await seedAcceptedEpisode('TN0005')
    await assert.rejects(
      () => er.renameAcceptedEpisode(SLUG, 'TN0005', 'TN0005'),
      /same as old_code/,
    )
  })

  test('rejects when source idea is not accepted', async () => {
    await assert.rejects(
      () => er.renameAcceptedEpisode(SLUG, 'TN0005', 'TN0099'),
      /No accepted episode/,
    )
  })

  test('source folder missing on disk → still patches ideas.json + warns', async () => {
    const seed = await seedAcceptedEpisode('TN0005')
    // Remove the on-disk episode dir but leave the idea record.
    await fs.rm(seed.episode_dir, { recursive: true, force: true })
    const r = await er.renameAcceptedEpisode(SLUG, 'TN0005', 'TN0099')
    assert.equal(r.ok, true)
    assert.ok(r.warnings.length > 0, 'should warn about missing source folder')
    assert.ok(r.warnings[0].includes('Source folder did not exist'))
    // ideas.json still updated.
    const ideas = await im.getIdeas(SLUG, 'accepted')
    assert.equal(ideas[0].episode_code, 'TN0099')
  })

  test('YouTube sidecar (inside episode_dir) survives the rename', async () => {
    const seed = await seedAcceptedEpisode('TN0005')
    // Drop a fake sidecar file that the upload system would have written.
    const sidecar = { platform: 'youtube', video_id: 'abc123', account_id: 'acct' }
    await fs.writeFile(
      path.join(seed.episode_dir, 'youtube_upload.json'),
      JSON.stringify(sidecar),
    )
    const r = await er.renameAcceptedEpisode(SLUG, 'TN0005', 'TN0099')
    const sidecarPath = path.join(r.new_dir, 'youtube_upload.json')
    assert.ok(existsSync(sidecarPath), 'sidecar moved with the folder')
    const onDisk = JSON.parse(await fs.readFile(sidecarPath, 'utf-8'))
    assert.equal(onDisk.video_id, 'abc123', 'sidecar contents preserved verbatim')
  })

  test('canonicalises mixed-digit input (TN42 → TN0042)', async () => {
    await seedAcceptedEpisode('TN0005')
    const r = await er.renameAcceptedEpisode(SLUG, 'TN0005', 'TN42')
    // The renumber service formats through formatEpisodeCode, so the
    // result uses the project's digit width.
    assert.equal(r.new_code, 'TN0042')
  })
})
