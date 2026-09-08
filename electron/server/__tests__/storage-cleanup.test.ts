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
 *   - cleanupFinalVideoForEpisode: deletes only a freshly verified exact
 *     content-hash render on the current YouTube channel
 *   - bulk all_uploaded: considers current hash receipts and skips unverified
 */

import { test, describe, before, after, afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { useTempDataDir } from './_helpers.js'
import { setAppSetting } from '../services/app-settings.js'
import { withFinalVideoPathLock } from '../services/final-video-lock.js'
import { DEFAULT_SUBFOLDER_NAMES } from '../models/types.js'
import { saveYouTubeChannelGrantForTest } from './_youtube-connection-test-helper.js'
import {
  __resetYouTubeTransportForTests,
  __setYouTubeTransportForTests,
} from '../lib/youtube-client.js'

let pm: typeof import('../services/project-manager.js')
let im: typeof import('../services/idea-manager.js')
let assetStatus: typeof import('../services/asset-status.js')
let storageAudit: typeof import('../services/storage-audit.js')
let externalStore: typeof import('../services/external-video-store.js')
let sidecar: typeof import('../services/upload-sidecar.js')
let cacheMod: typeof import('../services/episode-status-cache.js')
let connections: typeof import('../services/youtube-connection-store.js')
let operations: typeof import('../services/youtube-operation-store.js')
let sourceVideo: typeof import('../services/youtube-source-video.js')
let tmp: { dir: string; cleanup: () => Promise<void> }

const SLUG = 'storage-test'
const TITLE = 'Storage Demo'

async function makeProject(): Promise<void> {
  const projDir = path.join(pm.projectsRoot(), SLUG)
  const outputRoot = path.join(projDir, 'episodes')
  await fs.mkdir(projDir, { recursive: true })
  await fs.writeFile(path.join(projDir, 'project.json'), JSON.stringify({
    slug: SLUG, name: 'Storage Demo',
    episode_prefix: 'TN', episode_digits: 4,
    season_size: 20, season_prefix: 'Season',
    folder_template: '{season_prefix} {season_num}/{code} - {title}/',
    subfolder_names: DEFAULT_SUBFOLDER_NAMES,
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

async function writeUploadedSidecar(code: string, videoId = `vid-${code}`): Promise<string> {
  const uploadedAt = new Date().toISOString()
  await sidecar.writeSidecar(SLUG, code, TITLE, {
    platform: 'youtube',
    video_id: videoId,
    account_id: 'acct',
    channel_id: 'chan',
    uploaded_at: uploadedAt,
    last_sync_at: new Date().toISOString(),
    scheduled_for: null,
    privacy_status: 'public',
    title: TITLE,
    description: '',
    tags: [],
    thumbnail_set: true,
  } as any)
  return uploadedAt
}

const CHANNEL = 'channel-storage'
const PAYLOAD = {
  snippet_json: JSON.stringify({ title: TITLE, description: '', tags: [], categoryId: '24' }),
  status_json: JSON.stringify({ privacyStatus: 'public' }),
  source_sha256: 'a'.repeat(64),
}

async function writeCanonicalOperation(
  code: string,
  finalPath: string,
  lifecycle: 'ready' | 'failed' | 'rejected' = 'ready',
): Promise<void> {
  await connections.configureYouTubeApplication({ client_id: 'storage-client', client_secret: 'storage-secret' })
  await saveYouTubeChannelGrantForTest({
    channel: { channel_id: CHANNEL, title: 'Storage Channel', granted_scopes: ['youtube.upload'] },
    tokens: { access_token: 'storage-access', refresh_token: 'storage-refresh', expires_at: Date.now() + 3_600_000 },
  })
  await connections.assignProjectYouTubeChannel({
    project_slug: SLUG, channel_id: CHANNEL, expected_previous_channel_id: null,
  })
  const opened = await operations.createYouTubeOperation({
    project_slug: SLUG,
    episode_code: code,
    channel_id: CHANNEL,
    source_revision: await sourceVideo.resolveYouTubeSourceRevision(finalPath),
    metadata_revision: PAYLOAD.source_sha256,
    final_payload: PAYLOAD,
    origin: 'manual',
    final_action: 'manual_upload',
  })
  const accepted = await operations.acceptYouTubeOperation({
    project_slug: SLUG,
    operation_id: opened.operation_id,
    expected_revision: opened.revision,
    channel_id: CHANNEL,
    video_id: `canonical-${code}`,
    accepted_at: new Date().toISOString(),
    final_payload: PAYLOAD,
  })
  await operations.updateYouTubeOperation({
    project_slug: SLUG,
    operation_id: accepted.operation_id,
    expected_revision: accepted.revision,
    mutate(record) { record.lifecycle = lifecycle },
  })
}

function mockPublicationDetails(input: {
  code: string
  uploadStatus?: string
  channelId?: string
  missing?: boolean
  onCall?: () => Promise<void>
}): () => number {
  let calls = 0
  __setYouTubeTransportForTests((async (request, init) => {
    calls++
    assert.equal(init?.method || 'GET', 'GET')
    assert.match(String(request), /youtube\/v3\/videos\?.*processingDetails/)
    await input.onCall?.()
    return new Response(JSON.stringify({
      items: input.missing ? [] : [{
        id: `canonical-${input.code}`,
        status: { uploadStatus: input.uploadStatus || 'processed', privacyStatus: 'private' },
        snippet: { channelId: input.channelId ?? CHANNEL, title: TITLE, description: '', tags: [] },
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch)
  return () => calls
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
    connections = await import('../services/youtube-connection-store.js')
    operations = await import('../services/youtube-operation-store.js')
    sourceVideo = await import('../services/youtube-source-video.js')
    assert.equal(pm.projectsRoot(), path.join(tmp.dir, 'projects'))
  })

  after(async () => { await tmp.cleanup() })

  afterEach(() => { __resetYouTubeTransportForTests() })

  beforeEach(async () => {
    await fs.rm(pm.projectsRoot(), { recursive: true, force: true }).catch(() => {})
    await fs.mkdir(pm.projectsRoot(), { recursive: true })
    cacheMod.episodeStatusCache.clear()
    // v1.4.3 — the exports root is derived from the Library rather than set
    // directly, so each test opts in by choosing a Library (or not).
    await setAppSetting('library_root', '')
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

  test('zero-byte final cannot mark video assembly complete', async () => {
    const seed = await seedAcceptedEpisode('TN0099', 0)
    const status = await assetStatus.computeEpisodeStatus(SLUG, seed.code)
    assert.equal(status.video_assembly, false, 'empty final is not a successful render')
  })

  // ── Part C: external-root detection ───────────────────────────────

  test('final at external root flips video_assembly true', async () => {
    const seed = await seedAcceptedEpisode('TN0003')
    // v1.4.3 — exports live at `<Library>/Exports`, so choosing a Library is
    // how a test opts in. There is no separate export root to configure.
    await setAppSetting('library_root', path.join(tmp.dir, 'library-a'))
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
    assert.equal(ep4.cleanup_eligible, false, 'a historical sidecar has no content-hash receipt')
    assert.equal(ep5.uploaded_to_youtube, false, 'TN0005 has no sidecar')
    assert.equal(ep5.cleanup_eligible, false)
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
    assert.match((caught as Error).message, /not confirmed as the uploaded render/)
  })

  test('a legacy sidecar cannot authorize cleanup, even when a caller sends force', async () => {
    const seed = await seedAcceptedEpisode('TN0008', 3_000_000)
    await writeUploadedSidecar('TN0008')
    await assert.rejects(
      storageAudit.cleanupFinalVideoForEpisode(SLUG, 'TN0008', { force: true }),
      (error: any) => error?.statusCode === 412,
    )
    assert.equal(existsSync(seed.final_path), true, 'the historical receipt remains visible but cannot delete bytes')
  })

  test('cleanup deletes only after a fresh processed current-channel response for the exact content hash', async () => {
    const seed = await seedAcceptedEpisode('TN0016', 2048)
    await writeCanonicalOperation(seed.code, seed.final_path)
    const calls = mockPublicationDetails({ code: seed.code })
    const result = await storageAudit.cleanupFinalVideoForEpisode(SLUG, seed.code)
    assert.equal(result.deleted_count, 1)
    assert.equal(calls(), 1, 'one fresh provider read proves this exact remote video is processed')
    assert.equal(existsSync(seed.final_path), false)
    cacheMod.episodeStatusCache.clear()
    assert.equal((await assetStatus.computeEpisodeStatus(SLUG, seed.code)).video_assembly, true)
  })

  test('same name, size, and mtime with different bytes cannot inherit a canonical receipt', async () => {
    const seed = await seedAcceptedEpisode('TN0017', 2048)
    await writeCanonicalOperation(seed.code, seed.final_path)
    const original = await fs.stat(seed.final_path)
    await fs.writeFile(seed.final_path, Buffer.alloc(2048, 1))
    await fs.utimes(seed.final_path, original.atime, original.mtime)
    const calls = mockPublicationDetails({ code: seed.code })
    await assert.rejects(
      storageAudit.cleanupFinalVideoForEpisode(SLUG, seed.code),
      (error: any) => error?.statusCode === 412 && /content SHA-256/.test(error.message),
    )
    assert.equal(calls(), 0, 'a hash mismatch never spends a provider read')
    assert.deepEqual(await fs.readFile(seed.final_path), Buffer.alloc(2048, 1))
  })

  test('a stale ready receipt is refused when YouTube no longer returns the exact video', async () => {
    const seed = await seedAcceptedEpisode('TN0021', 2048)
    await writeCanonicalOperation(seed.code, seed.final_path)
    const calls = mockPublicationDetails({ code: seed.code, missing: true })
    await assert.rejects(storageAudit.cleanupFinalVideoForEpisode(SLUG, seed.code), (error: any) => error?.statusCode === 412)
    assert.equal(calls(), 1)
    assert.equal(existsSync(seed.final_path), true)
  })

  test('a failed accepted operation never authorizes ordinary cleanup', async () => {
    const seed = await seedAcceptedEpisode('TN0018', 2048)
    await writeCanonicalOperation(seed.code, seed.final_path, 'failed')
    await writeUploadedSidecar(seed.code, `canonical-${seed.code}`)
    await assert.rejects(
      storageAudit.cleanupFinalVideoForEpisode(SLUG, seed.code),
      (error: any) => error?.statusCode === 412,
    )
    assert.equal(existsSync(seed.final_path), true)
    const audit = await storageAudit.auditProjectStorage(SLUG)
    assert.equal(audit.episodes[0]?.uploaded_to_youtube, true, 'accepted identity remains visible operationally')
    assert.equal(audit.episodes[0]?.cleanup_eligible, false, 'failed identity never bypasses destructive confirmation')
    await fs.rm(seed.final_path)
    cacheMod.episodeStatusCache.clear()
    assert.equal((await assetStatus.computeEpisodeStatus(SLUG, seed.code)).video_assembly, false)
  })

  test('a failed operation and a historical sidecar both remain insufficient for cleanup', async () => {
    const seed = await seedAcceptedEpisode('TN0020', 2048)
    await writeUploadedSidecar(seed.code, `historical-${seed.code}`)
    await writeCanonicalOperation(seed.code, seed.final_path, 'failed')

    await assert.rejects(storageAudit.cleanupFinalVideoForEpisode(SLUG, seed.code), (error: any) => error?.statusCode === 412)
    assert.equal(existsSync(seed.final_path), true)
  })

  test('a legacy sidecar cannot authorize deleting a final rendered after its upload', async () => {
    const seed = await seedAcceptedEpisode('TN0019', 2048)
    const uploadedAt = await writeUploadedSidecar(seed.code)
    await fs.writeFile(seed.final_path, Buffer.alloc(4096))
    const newer = new Date(Date.parse(uploadedAt) + 1_000)
    await fs.utimes(seed.final_path, newer, newer)
    await assert.rejects(
      storageAudit.cleanupFinalVideoForEpisode(SLUG, seed.code),
      (error: any) => error?.statusCode === 412,
    )
    assert.equal((await fs.stat(seed.final_path)).size, 4096)
  })

  test('a current content hash still refuses a remote video that is processing', async () => {
    const seed = await seedAcceptedEpisode('TN0022', 2048)
    await writeCanonicalOperation(seed.code, seed.final_path)
    const calls = mockPublicationDetails({ code: seed.code, uploadStatus: 'uploaded' })
    await assert.rejects(storageAudit.cleanupFinalVideoForEpisode(SLUG, seed.code), (error: any) => error?.statusCode === 412)
    assert.equal(calls(), 1)
    assert.equal(existsSync(seed.final_path), true)
  })

  test('a processed response from another channel cannot delete the local final', async () => {
    const seed = await seedAcceptedEpisode('TN0023', 2048)
    await writeCanonicalOperation(seed.code, seed.final_path)
    const calls = mockPublicationDetails({ code: seed.code, channelId: 'UC-other-channel' })
    await assert.rejects(storageAudit.cleanupFinalVideoForEpisode(SLUG, seed.code), (error: any) => error?.statusCode === 412)
    assert.equal(calls(), 1)
    assert.equal(existsSync(seed.final_path), true)
  })

  test('a final replaced during fresh verification is not removed', async () => {
    const seed = await seedAcceptedEpisode('TN0024', 2048)
    await writeCanonicalOperation(seed.code, seed.final_path)
    mockPublicationDetails({
      code: seed.code,
      onCall: async () => { await fs.writeFile(seed.final_path, Buffer.alloc(2048, 2)) },
    })
    await assert.rejects(
      storageAudit.cleanupFinalVideoForEpisode(SLUG, seed.code),
      (error: any) => error?.statusCode === 412,
    )
    assert.deepEqual(await fs.readFile(seed.final_path), Buffer.alloc(2048, 2))
  })

  test('a locked final promotion wins over cleanup after remote verification', async () => {
    const seed = await seedAcceptedEpisode('TN0026', 2048)
    await writeCanonicalOperation(seed.code, seed.final_path)
    const replacement = `${seed.final_path}.replacement`
    const replacementBytes = Buffer.alloc(2048, 6)
    await fs.writeFile(replacement, replacementBytes)
    let providerRead!: () => void
    const providerReadPromise = new Promise<void>(resolve => { providerRead = resolve })
    mockPublicationDetails({ code: seed.code, onCall: async () => { providerRead() } })

    let cleanup!: Promise<unknown>
    await withFinalVideoPathLock(seed.final_path, async () => {
      cleanup = storageAudit.cleanupFinalVideoForEpisode(SLUG, seed.code)
      await providerReadPromise
      await fs.rename(replacement, seed.final_path)
    })

    await assert.rejects(cleanup, (error: any) => error?.statusCode === 412)
    assert.deepEqual(await fs.readFile(seed.final_path), replacementBytes)
  })

  test('a changed external final refuses the whole episode before either final is deleted', async () => {
    const seed = await seedAcceptedEpisode('TN0025', 2048)
    await setAppSetting('library_root', path.join(tmp.dir, 'library-exact-cleanup'))
    const externalDir = await externalStore.ensureExternalFinalVideoDir(SLUG, seed.code, TITLE)
    assert.ok(externalDir)
    const externalFinal = path.join(externalDir!, `${seed.code}_final_video.mp4`)
    await fs.copyFile(seed.final_path, externalFinal)
    await writeCanonicalOperation(seed.code, seed.final_path)
    mockPublicationDetails({
      code: seed.code,
      onCall: async () => { await fs.writeFile(externalFinal, Buffer.alloc(2048, 3)) },
    })

    await assert.rejects(
      storageAudit.cleanupFinalVideoForEpisode(SLUG, seed.code),
      (error: any) => error?.statusCode === 412,
    )
    assert.equal(existsSync(seed.final_path), true, 'the project-tree final must not be partially cleared')
    assert.deepEqual(await fs.readFile(externalFinal), Buffer.alloc(2048, 3))
  })

  test('cleanup leaves per-scene clips intact (only final-video targeted)', async () => {
    const seed = await seedAcceptedEpisode('TN0010', 1_000_000)
    const videoDir = path.dirname(seed.final_path)
    const clipPath = path.join(videoDir, 'TN0010_Scene01_v1.mp4')
    await fs.writeFile(clipPath, Buffer.alloc(2_000_000))
    await writeCanonicalOperation(seed.code, seed.final_path)
    mockPublicationDetails({ code: seed.code })
    const r = await storageAudit.cleanupFinalVideoForEpisode(SLUG, 'TN0010')
    assert.equal(r.deleted_count, 1, 'only the final, not the clip')
    assert.equal(existsSync(clipPath), true, 'per-scene clip survived')
    assert.equal(existsSync(seed.final_path), false)
  })

  // ── bulk cleanup ──────────────────────────────────────────────────

  test('bulk all_uploaded selects only current content-hash candidates', async () => {
    await seedAcceptedEpisode('TN0011', 1_000_000)  // not uploaded
    const uploaded = await seedAcceptedEpisode('TN0012', 2_000_000)
    await writeCanonicalOperation(uploaded.code, uploaded.final_path)
    mockPublicationDetails({ code: uploaded.code })
    const r = await storageAudit.bulkCleanupFinalVideos(SLUG, { all_uploaded: true })
    assert.equal(r.deleted_count, 1)
    assert.equal(r.bytes_freed, 2_000_000)
    assert.equal(existsSync(uploaded.final_path), false)
  })

  test('bulk with explicit codes: per-episode safety guard fires for non-uploaded', async () => {
    await seedAcceptedEpisode('TN0014', 1_000_000)  // not uploaded
    await seedAcceptedEpisode('TN0015', 2_000_000)  // historical receipt only
    await writeUploadedSidecar('TN0015')
    const r = await storageAudit.bulkCleanupFinalVideos(SLUG, {
      episode_codes: ['TN0014', 'TN0015'],
    })
    assert.equal(r.deleted_count, 0, 'legacy receipts cannot authorize deletion')
    assert.equal(r.skipped_count, 2, 'each unverified final is skipped (412)')
    const skipItem = r.items.find(i => i.episode_code === 'TN0014')
    assert.ok(skipItem)
    assert.equal(skipItem!.status, 'skipped')
  })

  // v1.4.5 — the `migrateFinalsToExternal` tests went with the function.
  // It moved finished videos with an unverified copy-then-delete across
  // volumes; the archive sweep replaced it and is covered by
  // `archive-sweep.test.ts`, which asserts verification before removal.
})
