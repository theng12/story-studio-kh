/**
 * Tests for the storage cleanup + external-root + sidecar-aware
 * detection trifecta (the "free up iCloud sync space" feature batch).
 *
 * Coverage:
 *   - sidecar-aware video_assembly: sidecar with video_id flips
 *     status.video_assembly to true even with no local file
 *   - external-root detection: a final video at the external path
 *     also flips status.video_assembly to true
 *   - storage-audit: per-category byte breakdown is correct + uploaded
 *     badge mirrors the sidecar
 *   - cleanupFinalVideoForEpisode: refuses without uploaded sidecar
 *     unless force=true; deletes when uploaded
 *   - bulk all_uploaded: cleans uploaded ones, skips non-uploaded
 *   - migrateFinalsToExternal: moves files + idempotent on second run
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

let pm: typeof import('../services/project-manager.js')
let im: typeof import('../services/idea-manager.js')
let assetStatus: typeof import('../services/asset-status.js')
let storageAudit: typeof import('../services/storage-audit.js')
let externalStore: typeof import('../services/external-video-store.js')
let sidecar: typeof import('../services/upload-sidecar.js')
let cacheMod: typeof import('../services/episode-status-cache.js')
let tmp: { dir: string; cleanup: () => Promise<void> }

const SLUG = 'storage-test'
const TITLE = 'Storage Demo'

async function makeProject(): Promise<void> {
  const projDir = path.join(pm.PROJECTS_ROOT, SLUG)
  const outputRoot = path.join(projDir, 'episodes')
  await fs.mkdir(projDir, { recursive: true })
  await fs.writeFile(path.join(projDir, 'project.json'), JSON.stringify({
    slug: SLUG, name: 'Storage Demo',
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

interface SeededEpisode { code: string; idea_id: string; episode_dir: string; final_path: string }

async function seedAcceptedEpisode(code: string, finalSizeBytes = 1024): Promise<SeededEpisode> {
  const [created] = await im.addIdeas(SLUG, [{
    title: TITLE, logline: 'l', themes: [],
    suggested_chapters: 1, suggested_length: '5 min', mood: 'm',
  }], 'test')
  const r = await im.acceptIdea(SLUG, created.id, false, { override_code: code })
  // Drop a fake final video of the requested size into the canonical
  // {code} - 10 Video Assembly Output folder.
  const videoDir = path.join(r.episode_dir, `${code} - 10 Video Assembly Output`)
  await fs.mkdir(videoDir, { recursive: true })
  const finalPath = path.join(videoDir, `${code}_final_video.mp4`)
  await fs.writeFile(finalPath, Buffer.alloc(finalSizeBytes))
  return { code, idea_id: created.id, episode_dir: r.episode_dir, final_path: finalPath }
}

async function writeUploadedSidecar(code: string): Promise<void> {
  await sidecar.writeSidecar(SLUG, code, TITLE, {
    platform: 'youtube',
    video_id: `vid-${code}`,
    account_id: 'acct',
    channel_id: 'chan',
    uploaded_at: new Date().toISOString(),
    last_sync_at: new Date().toISOString(),
    scheduled_for: null,
    privacy_status: 'public',
    title: TITLE,
    description: '',
    tags: [],
    thumbnail_set: true,
  } as any)
}

describe('storage cleanup + sidecar detection + external root', () => {
  before(async () => {
    tmp = await useTempDataDir()
    pm = await import('../services/project-manager.js')
    im = await import('../services/idea-manager.js')
    assetStatus = await import('../services/asset-status.js')
    storageAudit = await import('../services/storage-audit.js')
    externalStore = await import('../services/external-video-store.js')
    sidecar = await import('../services/upload-sidecar.js')
    cacheMod = await import('../services/episode-status-cache.js')
    assert.equal(pm.PROJECTS_ROOT, path.join(tmp.dir, 'projects'))
  })

  after(async () => { await tmp.cleanup() })

  beforeEach(async () => {
    await fs.rm(pm.PROJECTS_ROOT, { recursive: true, force: true }).catch(() => {})
    await fs.mkdir(pm.PROJECTS_ROOT, { recursive: true })
    cacheMod.episodeStatusCache.clear()
    // Always start each test with NO external root configured so each
    // test can opt in independently.
    await externalStore.setExternalFinalVideoRoot('')
    await makeProject()
  })

  // ── Part A: sidecar-aware detection ───────────────────────────────

  test('sidecar with video_id flips video_assembly true even with no local file', async () => {
    const seed = await seedAcceptedEpisode('TN0001')
    // Delete the local final to simulate the "iCloud cleanup" state.
    await fs.rm(seed.final_path, { force: true })
    // Without sidecar → video_assembly should be false.
    let status = await assetStatus.computeEpisodeStatus(SLUG, 'TN0001')
    assert.equal(status.video_assembly, false, 'no file + no sidecar → not done')

    // Drop sidecar → video_assembly should now be true.
    await writeUploadedSidecar('TN0001')
    cacheMod.episodeStatusCache.clear()
    status = await assetStatus.computeEpisodeStatus(SLUG, 'TN0001')
    assert.equal(status.video_assembly, true, 'sidecar with video_id → done')
  })

  test('local final still wins over missing sidecar', async () => {
    await seedAcceptedEpisode('TN0002')
    const status = await assetStatus.computeEpisodeStatus(SLUG, 'TN0002')
    assert.equal(status.video_assembly, true, 'local file always counts as done')
  })

  // ── Part C: external-root detection ───────────────────────────────

  test('final at external root flips video_assembly true', async () => {
    const seed = await seedAcceptedEpisode('TN0003')
    // Configure a non-default external root.
    const extRoot = path.join(tmp.dir, 'external-videos')
    await externalStore.setExternalFinalVideoRoot(extRoot)
    // Move the local final to the external location.
    const extDir = await externalStore.ensureExternalFinalVideoDir(SLUG, 'TN0003', TITLE)
    assert.ok(extDir, 'external dir resolves')
    await fs.rename(seed.final_path, path.join(extDir!, 'TN0003_final_video.mp4'))
    cacheMod.episodeStatusCache.clear()
    const status = await assetStatus.computeEpisodeStatus(SLUG, 'TN0003')
    assert.equal(status.video_assembly, true, 'final at external location detected')
  })

  // ── storage-audit ─────────────────────────────────────────────────

  test('audit returns per-episode bytes + uploaded badge', async () => {
    await seedAcceptedEpisode('TN0004', 5_000_000)
    await seedAcceptedEpisode('TN0005', 1_000_000)
    await writeUploadedSidecar('TN0004')

    const r = await storageAudit.auditProjectStorage(SLUG)
    assert.equal(r.episodes.length, 2)
    const ep4 = r.episodes.find(e => e.episode_code === 'TN0004')!
    const ep5 = r.episodes.find(e => e.episode_code === 'TN0005')!
    assert.equal(ep4.bytes_final_video, 5_000_000)
    assert.equal(ep5.bytes_final_video, 1_000_000)
    assert.equal(ep4.uploaded_to_youtube, true, 'TN0004 has sidecar')
    assert.equal(ep5.uploaded_to_youtube, false, 'TN0005 has no sidecar')
    assert.equal(ep4.youtube_video_id, 'vid-TN0004')
    assert.equal(r.project_bytes_final_video, 6_000_000)
  })

  test('audit surfaces per-scene clips separately from final', async () => {
    const seed = await seedAcceptedEpisode('TN0006')
    // Drop a couple of fake Veo clips alongside the final.
    const videoDir = path.dirname(seed.final_path)
    await fs.writeFile(path.join(videoDir, 'TN0006_Scene01_v1.mp4'), Buffer.alloc(2_000_000))
    await fs.writeFile(path.join(videoDir, 'TN0006_Scene02_v1.mp4'), Buffer.alloc(2_500_000))
    const r = await storageAudit.auditProjectStorage(SLUG)
    const ep = r.episodes.find(e => e.episode_code === 'TN0006')!
    assert.equal(ep.bytes_per_scene_clips, 4_500_000, 'clips counted separately')
    assert.equal(ep.bytes_final_video, 1024, 'final size unchanged by clip presence')
  })

  // ── cleanup safety guard ──────────────────────────────────────────

  test('cleanup refuses without uploaded sidecar (412)', async () => {
    await seedAcceptedEpisode('TN0007')
    let caught: any = null
    try {
      await storageAudit.cleanupFinalVideoForEpisode(SLUG, 'TN0007')
    } catch (e) { caught = e }
    assert.ok(caught, 'should throw when not uploaded')
    assert.equal((caught as any).statusCode, 412, 'distinguishable status')
    assert.match((caught as Error).message, /not confirmed uploaded/)
  })

  test('cleanup deletes when uploaded', async () => {
    const seed = await seedAcceptedEpisode('TN0008', 3_000_000)
    await writeUploadedSidecar('TN0008')
    const r = await storageAudit.cleanupFinalVideoForEpisode(SLUG, 'TN0008')
    assert.equal(r.deleted_count, 1)
    assert.equal(r.bytes_freed, 3_000_000)
    assert.equal(existsSync(seed.final_path), false, 'file removed')
  })

  test('cleanup with force:true bypasses the sidecar guard', async () => {
    const seed = await seedAcceptedEpisode('TN0009', 1_500_000)
    const r = await storageAudit.cleanupFinalVideoForEpisode(SLUG, 'TN0009', { force: true })
    assert.equal(r.deleted_count, 1)
    assert.equal(existsSync(seed.final_path), false)
  })

  test('cleanup leaves per-scene clips intact (only final-video targeted)', async () => {
    const seed = await seedAcceptedEpisode('TN0010', 1_000_000)
    const videoDir = path.dirname(seed.final_path)
    const clipPath = path.join(videoDir, 'TN0010_Scene01_v1.mp4')
    await fs.writeFile(clipPath, Buffer.alloc(2_000_000))
    await writeUploadedSidecar('TN0010')
    const r = await storageAudit.cleanupFinalVideoForEpisode(SLUG, 'TN0010')
    assert.equal(r.deleted_count, 1, 'only the final, not the clip')
    assert.equal(existsSync(clipPath), true, 'per-scene clip survived')
    assert.equal(existsSync(seed.final_path), false)
  })

  // ── bulk cleanup ──────────────────────────────────────────────────

  test('bulk all_uploaded: cleans uploaded ones, skips non-uploaded', async () => {
    await seedAcceptedEpisode('TN0011', 1_000_000)  // not uploaded
    await seedAcceptedEpisode('TN0012', 2_000_000)  // uploaded
    await seedAcceptedEpisode('TN0013', 3_000_000)  // uploaded
    await writeUploadedSidecar('TN0012')
    await writeUploadedSidecar('TN0013')
    const r = await storageAudit.bulkCleanupFinalVideos(SLUG, { all_uploaded: true })
    assert.equal(r.deleted_count, 2)
    assert.equal(r.bytes_freed, 5_000_000)
    // TN0011 wasn't even in the target list (all_uploaded filter
    // excluded it before cleanup ran), so skipped_count is 0.
  })

  test('bulk with explicit codes: per-episode safety guard fires for non-uploaded', async () => {
    await seedAcceptedEpisode('TN0014', 1_000_000)  // not uploaded
    await seedAcceptedEpisode('TN0015', 2_000_000)  // uploaded
    await writeUploadedSidecar('TN0015')
    const r = await storageAudit.bulkCleanupFinalVideos(SLUG, {
      episode_codes: ['TN0014', 'TN0015'],
    })
    assert.equal(r.deleted_count, 1, 'only the uploaded one deletes')
    assert.equal(r.skipped_count, 1, 'the non-uploaded one is skipped (412)')
    const skipItem = r.items.find(i => i.episode_code === 'TN0014')
    assert.ok(skipItem)
    assert.equal(skipItem!.status, 'skipped')
  })

  // ── migration ─────────────────────────────────────────────────────

  test('migrate moves project-tree finals to external root', async () => {
    const seed = await seedAcceptedEpisode('TN0016', 4_000_000)
    const extRoot = path.join(tmp.dir, 'ext-root')
    await externalStore.setExternalFinalVideoRoot(extRoot)
    const r = await storageAudit.migrateFinalsToExternal(SLUG)
    assert.equal(r.moved.length, 1)
    assert.equal(r.bytes_moved, 4_000_000)
    assert.equal(existsSync(seed.final_path), false, 'project-tree path emptied')
    const extPath = path.join(r.moved[0].to)
    assert.equal(existsSync(extPath), true, 'external path now contains the final')
  })

  test('migrate is idempotent: no error on second run', async () => {
    await seedAcceptedEpisode('TN0017', 1_000_000)
    await externalStore.setExternalFinalVideoRoot(path.join(tmp.dir, 'ext'))
    const r1 = await storageAudit.migrateFinalsToExternal(SLUG)
    assert.equal(r1.moved.length, 1)
    const r2 = await storageAudit.migrateFinalsToExternal(SLUG)
    assert.equal(r2.moved.length, 0, 'second run finds nothing in project tree to move')
    assert.equal(r2.errors.length, 0)
  })

  test('migrate throws when external root not configured', async () => {
    await seedAcceptedEpisode('TN0018', 1_000_000)
    await externalStore.setExternalFinalVideoRoot('')
    await assert.rejects(
      () => storageAudit.migrateFinalsToExternal(SLUG),
      /not configured/,
    )
  })
})
