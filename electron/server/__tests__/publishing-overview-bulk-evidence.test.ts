/**
 * The Publishing Overview's cold read: the bulk-evidence contract.
 *
 * The overview resolves EVERY accepted episode of EVERY channel through the
 * same remote-evidence predicate `/youtube/publishable` asks (`remoteVideoFor`:
 * operation record → reconcile link → legacy sidecar) plus a rendered-final
 * probe. On the owner's library that was ~21 filesystem calls per episode
 * (`existsSync`/`readdir`/`stat`/`readFile`), and the cold read took 41 s on the
 * production mini.
 *
 * Two things are pinned here, because the cheap version of each is exactly the
 * kind of change that quietly changes an ANSWER:
 *
 *   1. EQUIVALENCE. The bulk inputs — one season-folder listing, one Exports
 *      season listing, one sidecar read per episode — must resolve to the same
 *      episode folder, the same sidecar and the same finished-video path as the
 *      per-episode probes they replaced. The reference implementations below
 *      are the ORIGINAL algorithms, kept verbatim, and every one of them is
 *      exercised against the shapes where a shortcut could differ: a sidecar
 *      inside the `03 Scene Prompts` subfolder (with and without the user's
 *      `✅ ` done-marker), a renamed episode whose folder moved, a duplicate
 *      folder left behind by a rename, and a final video that lives in an
 *      earlier Exports base.
 *
 *   2. COST. The bulk reads are per channel and per season, not per episode:
 *      `existsSync` does not grow when the same channels hold eight times as
 *      many episodes, and the total per-episode filesystem cost stays a small
 *      constant instead of climbing back toward 20.
 */

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fsSync from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { syncBuiltinESMExports } from 'node:module'

import { useTempDataDir } from './_helpers.js'
import { buildOverviewFixture, type OverviewFixture } from './_publishing-overview-fixture.js'

let pm: typeof import('../services/project-manager.js')
let utils: typeof import('../services/utils.js')
let svc: typeof import('../services/publishing-overview.js')
let remote: typeof import('../services/youtube-remote-video.js')
let connections: typeof import('../services/youtube-connection-store.js')
let appSettings: typeof import('../services/app-settings.js')
let externalStore: typeof import('../services/external-video-store.js')
let folderResolver: typeof import('../lib/folder-resolver.js')
let im: typeof import('../services/idea-manager.js')
let uploadSidecar: typeof import('../services/upload-sidecar.js')
let sourceVideo: typeof import('../services/youtube-source-video.js')

let tmp: { dir: string; cleanup: () => Promise<void> }

before(async () => {
  pm = await import('../services/project-manager.js')
  utils = await import('../services/utils.js')
  svc = await import('../services/publishing-overview.js')
  remote = await import('../services/youtube-remote-video.js')
  connections = await import('../services/youtube-connection-store.js')
  appSettings = await import('../services/app-settings.js')
  externalStore = await import('../services/external-video-store.js')
  folderResolver = await import('../lib/folder-resolver.js')
  im = await import('../services/idea-manager.js')
  uploadSidecar = await import('../services/upload-sidecar.js')
  sourceVideo = await import('../services/youtube-source-video.js')
})
beforeEach(async () => {
  await tmp?.cleanup()
  tmp = await useTempDataDir()
})
after(async () => { await tmp?.cleanup() })

// ── Filesystem counting ─────────────────────────────────────────────────────

interface Counters {
  existsSync: number
  readdir: number
  stat: number
  readFile: number
  /** Every `readdir` path, so a directory listed twice in one request is visible. */
  readdirPaths: string[]
  /** `readFile` calls against an episode's own `youtube_upload.json`. */
  sidecarReads: number
}

function installCounters(): { counters: Counters; restore: () => void } {
  const counters: Counters = { existsSync: 0, readdir: 0, stat: 0, readFile: 0, readdirPaths: [], sidecarReads: 0 }
  const originalExists = fsSync.existsSync
  const originalReaddir = fsp.readdir
  const originalStat = fsp.stat
  const originalReadFile = fsp.readFile
  fsSync.existsSync = function (this: unknown, ...args: any[]) {
    counters.existsSync += 1
    return (originalExists as any).apply(this, args)
  }
  ;(fsp as any).readdir = function (this: unknown, ...args: any[]) {
    counters.readdir += 1
    counters.readdirPaths.push(String(args[0]))
    return (originalReaddir as any).apply(this, args)
  }
  ;(fsp as any).stat = function (this: unknown, ...args: any[]) {
    counters.stat += 1
    return (originalStat as any).apply(this, args)
  }
  ;(fsp as any).readFile = function (this: unknown, ...args: any[]) {
    counters.readFile += 1
    if (String(args[0]).endsWith(`${path.sep}youtube_upload.json`)) counters.sidecarReads += 1
    return (originalReadFile as any).apply(this, args)
  }
  syncBuiltinESMExports()
  return {
    counters,
    restore: () => {
      fsSync.existsSync = originalExists
      ;(fsp as any).readdir = originalReaddir
      ;(fsp as any).stat = originalStat
      ;(fsp as any).readFile = originalReadFile
      syncBuiltinESMExports()
    },
  }
}

/** One timed, counted cold read of the whole overview. */
async function measureOverview(): Promise<{ counters: Counters; ms: number }> {
  const { counters, restore } = installCounters()
  try {
    const started = Date.now()
    await svc.readPublishingOverview({ now: Date.now() })
    return { counters, ms: Date.now() - started }
  } finally {
    restore()
  }
}

// ── The ORIGINAL algorithms, kept as the reference ──────────────────────────

/**
 * `resolveEpisodePathsByCodeWithSidecar` as it stood before the bulk work:
 * probe the canonical folder, and only then list the season and probe every
 * same-code sibling.
 */
async function originalSidecarEpisodeDir(slug: string, code: string, sidecarFilename: string): Promise<string> {
  const paths = await utils.resolveEpisodePathsByCode(slug, code)
  const names = await utils.resolveSubfolderNames(slug, code)
  const hasSidecar = async (dir: string): Promise<boolean> => {
    if (fsSync.existsSync(path.join(dir, sidecarFilename))) return true
    const sp = await folderResolver.findSubfolder(dir, names.scene_prompts)
    return !!sp && fsSync.existsSync(path.join(sp, sidecarFilename))
  }
  if (await hasSidecar(paths.episode_dir)) return paths.episode_dir

  const seasonDir = path.dirname(path.resolve(paths.episode_dir))
  const entries = await fsp.readdir(seasonDir, { withFileTypes: true }).catch(() => null)
  if (!entries) return paths.episode_dir
  const wanted = code.toLowerCase()
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const name = entry.name.toLowerCase()
    if (name !== wanted && !name.startsWith(`${wanted} - `)) continue
    const candidateDir = path.join(seasonDir, entry.name)
    if (path.resolve(candidateDir) === path.resolve(paths.episode_dir)) continue
    if (await hasSidecar(candidateDir)) return candidateDir
  }
  return paths.episode_dir
}

/**
 * `findYouTubeSourceVideoPath` as it stood before the bulk work: no Exports
 * index, so `resolveExternalFinalVideoDir` is called WITHOUT a facts cache and
 * probes each candidate folder with `existsSync`.
 */
async function originalFindYouTubeSourceVideoPath(
  paths: { episode_dir: string; video_dir: string },
  slug: string,
  code: string,
  title: string,
): Promise<string> {
  const normalizedCode = code.toUpperCase()
  const videoExts = ['.mp4', '.mov', '.mkv', '.webm', '.m4v']
  const isVideo = (name: string) => videoExts.some(ext => name.toLowerCase().endsWith(ext))
  const isCanonical = (name: string) => name.startsWith(`${normalizedCode}_final_video.`) && isVideo(name)
  const validFile = async (dir: string, name: string): Promise<string> => {
    const info = await fsp.stat(path.join(dir, name)).catch(() => null)
    return info?.isFile() && info.size > 0 ? path.join(dir, name) : ''
  }

  const externalDir = await externalStore.resolveExternalFinalVideoDir(slug, normalizedCode, title)
  if (externalDir) {
    const externalFiles = await fsp.readdir(externalDir).catch(() => [])
    const final = externalFiles.find(isCanonical)
    if (final) {
      const valid = await validFile(externalDir, final)
      if (valid) return valid
    }
  }
  const localFiles = await fsp.readdir(paths.video_dir).catch(() => [])
  const final = localFiles.find(isCanonical)
  return final ? validFile(paths.video_dir, final) : ''
}

/** The readiness figures recomputed the per-episode way, one channel at a time. */
async function referenceReadiness(slug: string, channelId: string | null): Promise<{
  ready: number
  on_youtube: number
}> {
  const records = await remote.readYouTubeRetentionStores(slug).then(stores => stores.records)
  const state = (await import('../services/youtube-project-publishing-store.js')).readYouTubeProjectPublishingState
  const publishingState = await state(slug)
  const ideas = await im.getIdeas(slug, 'accepted')
  let ready = 0
  const onYouTube = new Set<string>()
  for (const idea of ideas) {
    if (!idea.episode_code) continue
    const code = idea.episode_code
    const title = idea.title || ''
    // No facts cache anywhere on this path: the memo, the season listing cache
    // and the Exports index are all bypassed, so this is the per-episode sweep.
    const found = await remote.remoteVideoFor(slug, code, title, channelId, records, publishingState)
    if (found?.video_id) { onYouTube.add(code); continue }
    if (found) continue
    const paths = await utils.resolveEpisodePaths(slug, code, title)
    const source = await originalFindYouTubeSourceVideoPath(paths, slug, code, title)
    if (source) ready += 1
  }
  return { ready, on_youtube: onYouTube.size }
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const SIDECAR = 'youtube_upload.json'

async function write(file: string, body: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, body)
}

function sidecarBody(videoId: string, channelId: string): string {
  return JSON.stringify({
    platform: 'youtube', video_id: videoId, account_id: 'a', channel_id: channelId,
    uploaded_at: '2026-01-02T00:00:00.000Z', last_sync_at: '2026-01-02T00:00:00.000Z',
    scheduled_for: null, privacy_status: 'private', title: 't', description: '', tags: [], thumbnail_set: false,
  })
}

/**
 * One channel holding every shape a sidecar resolution has to get right.
 * Returns the slug and the episode folder each code should resolve to.
 */
async function sidecarShapesChannel(channelId: string): Promise<{ slug: string; expected: Record<string, string> }> {
  const project = await pm.createProject({ name: 'Sidecar Shapes', episode_prefix: 'EP' })
  const slug = project.slug
  await appSettings.setAppSetting('library_root', process.env.STORY_STUDIO_DATA_DIR!)
  await connections.configureYouTubeApplication({ client_id: 'shape-client', client_secret: 'shape-client-secret-value' })
  const { saveYouTubeChannelGrantForTest } = await import('./_youtube-connection-test-helper.js')
  await saveYouTubeChannelGrantForTest({
    channel: { channel_id: channelId, title: 'Shapes', granted_scopes: ['youtube.upload'] },
    tokens: { access_token: 'a', refresh_token: 'r', expires_at: Date.now() + 3_600_000 },
  })
  await connections.assignProjectYouTubeChannel({
    project_slug: slug, channel_id: channelId, expected_previous_channel_id: null,
  })

  const root = path.join(pm.getProjectDir(slug)!, 'episodes', 'Season 001')
  const dir = (name: string) => path.join(root, name)
  // The subfolder name comes from `DEFAULT_SUBFOLDER_NAMES.scene_prompts`, which
  // is `{code} - 03 Scene Prompts` — the CODE, not the episode folder's name.
  const scenePrompts = (episodeFolder: string, code: string, marked = false) =>
    path.join(dir(episodeFolder), `${marked ? '✅ ' : ''}${code} - 03 Scene Prompts`)

  // 1. The ordinary case: the sidecar sits at the episode root.
  await write(path.join(dir('EP0001 - One'), SIDECAR), sidecarBody('vid_1', channelId))
  // 2. No sidecar at all.
  await fsp.mkdir(dir('EP0002 - Two'), { recursive: true })
  // 3. The sidecar is inside the `03 Scene Prompts` subfolder only.
  await write(path.join(scenePrompts('EP0003 - Three', 'EP0003'), SIDECAR), sidecarBody('vid_3', channelId))
  // 4. A RENAMED episode: the titled folder is gone, a same-code sibling owns it.
  await write(path.join(dir('EP0004 - Four Old Title'), SIDECAR), sidecarBody('vid_4', channelId))
  // 5. A duplicate left by a rename: the canonical folder has NO sidecar, the
  //    sibling has one — the sibling must win.
  await fsp.mkdir(dir('EP0005 - Five'), { recursive: true })
  await write(path.join(dir('EP0005 - Five Old'), SIDECAR), sidecarBody('vid_5', channelId))
  // 6. The trap: the canonical folder has no ROOT sidecar but does have one in
  //    its scene-prompts subfolder, AND a sibling has a root sidecar. The
  //    original answers "the canonical folder" (so the read finds nothing);
  //    a shortcut that skipped the subfolder check would hand back the
  //    sibling's video instead.
  await write(path.join(scenePrompts('EP0006 - Six', 'EP0006'), SIDECAR), sidecarBody('vid_6_canonical', channelId))
  await write(path.join(dir('EP0006 - Six Old'), SIDECAR), sidecarBody('vid_6_sibling', channelId))
  // 7. The same trap with the user's `✅ ` done-marker on the subfolder.
  await write(path.join(scenePrompts('EP0007 - Seven', 'EP0007', true), SIDECAR), sidecarBody('vid_7_canonical', channelId))
  await write(path.join(dir('EP0007 - Seven Old'), SIDECAR), sidecarBody('vid_7_sibling', channelId))

  const codes = ['EP0001', 'EP0002', 'EP0003', 'EP0004', 'EP0005', 'EP0006', 'EP0007']
  const titles: Record<string, string> = {
    EP0001: 'One', EP0002: 'Two', EP0003: 'Three', EP0004: 'Four',
    EP0005: 'Five', EP0006: 'Six', EP0007: 'Seven',
  }
  await write(path.join(pm.getProjectDir(slug)!, 'ideas.json'), JSON.stringify({
    ideas: codes.map((code, index) => ({
      id: `shape-${index}`, title: titles[code], logline: '', themes: [], suggested_chapters: 1,
      suggested_length: 'short', mood: 'calm', status: 'accepted', episode_code: code,
      generated_at: '2026-01-01T00:00:00.000Z', accepted_at: '2026-01-01T00:00:00.000Z',
      batch_id: 'shapes', model_used: 'fixture',
    })),
    next_episode_number: codes.length + 1,
    recycled_numbers: [],
  }))

  return {
    slug,
    expected: {
      EP0001: dir('EP0001 - One'),
      EP0002: dir('EP0002 - Two'),
      // 3, 6 and 7 all resolve to the CANONICAL folder: the subfolder sidecar is
      // what makes the canonical folder own the episode, and the read then
      // finds no root sidecar there.
      EP0003: dir('EP0003 - Three'),
      EP0004: dir('EP0004 - Four Old Title'),
      EP0005: dir('EP0005 - Five Old'),
      EP0006: dir('EP0006 - Six'),
      EP0007: dir('EP0007 - Seven'),
    },
  }
}

// ── 1. Equivalence ──────────────────────────────────────────────────────────

test('sidecar resolution returns the same episode folder as the per-episode probes', async () => {
  const { slug, expected } = await sidecarShapesChannel('UC-shapes')
  const facts = utils.createProjectFactsCache(slug)

  for (const [code, episodeDir] of Object.entries(expected)) {
    const bulk = await utils.resolveEpisodePathsByCodeWithSidecar(slug, code, SIDECAR, facts)
    const original = await originalSidecarEpisodeDir(slug, code, SIDECAR)
    // The folder template ends in `/`, so the resolved path carries one; the
    // comparison is on the resolved directory, not the string spelling.
    assert.equal(path.resolve(bulk.episode_dir), path.resolve(original), `${code}: the bulk path and the per-episode path must agree`)
    assert.equal(path.resolve(bulk.episode_dir), path.resolve(episodeDir), `${code}: resolved to the expected folder`)
  }

  // …and the read that consumes it agrees too, including which video wins when
  // two folders could answer.
  assert.equal((await uploadSidecar.readSidecarStrict(slug, 'EP0001', 'youtube', facts))?.video_id, 'vid_1')
  assert.equal(await uploadSidecar.readSidecarStrict(slug, 'EP0002', 'youtube', facts), null)
  assert.equal(await uploadSidecar.readSidecarStrict(slug, 'EP0003', 'youtube', facts), null, 'the canonical folder has no root sidecar')
  assert.equal((await uploadSidecar.readSidecarStrict(slug, 'EP0004', 'youtube', facts))?.video_id, 'vid_4')
  assert.equal((await uploadSidecar.readSidecarStrict(slug, 'EP0005', 'youtube', facts))?.video_id, 'vid_5')
  assert.equal(await uploadSidecar.readSidecarStrict(slug, 'EP0006', 'youtube', facts), null, 'canonical owns it; its root sidecar is absent')
  assert.equal(await uploadSidecar.readSidecarStrict(slug, 'EP0007', 'youtube', facts), null, 'same, with the ✅-prefixed subfolder')

  // The memo is a per-request read, not a stale one: a second request re-reads.
  const fresh = utils.createProjectFactsCache(slug)
  await fsp.writeFile(path.join(expected.EP0002!, SIDECAR), sidecarBody('vid_2', 'UC-shapes'))
  assert.equal((await uploadSidecar.readSidecarStrict(slug, 'EP0002', 'youtube', fresh))?.video_id, 'vid_2')
})

test('the finished-video probe finds the same path as the per-episode probe', async () => {
  const project = await pm.createProject({ name: 'Finals', episode_prefix: 'EP' })
  const slug = project.slug
  await appSettings.setAppSetting('library_root', process.env.STORY_STUDIO_DATA_DIR!)
  const projectDir = pm.getProjectDir(slug)!
  // A previous Exports base, so the fallback loop is exercised: an episode whose
  // final still lives where it was rendered before the folder moved.
  const earlierRoot = path.join(process.env.STORY_STUDIO_DATA_DIR!, 'earlier-exports')
  await appSettings.setAppSetting('exports_root_previous', [earlierRoot])

  const title = 'Final'
  const paths = await utils.resolveEpisodePaths(slug, 'EP0001', title)
  const seasonRel = path.join('Season 001', 'EP0001 - Final')

  // (a) current Exports base, (b) an earlier Exports base, (c) the project tree,
  // (d) nothing anywhere.
  await write(path.join(projectDir, 'Exports', seasonRel, 'EP0001_final_video.mp4'), 'video')
  const paths2 = await utils.resolveEpisodePaths(slug, 'EP0002', title)
  await write(path.join(earlierRoot, slug, 'Season 001', 'EP0002 - Final', 'EP0002_final_video.mp4'), 'video')
  const paths3 = await utils.resolveEpisodePaths(slug, 'EP0003', title)
  await write(path.join(paths3.video_dir, 'EP0003_final_video.mkv'), 'video')
  const paths4 = await utils.resolveEpisodePaths(slug, 'EP0004', title)
  await fsp.mkdir(paths4.episode_dir, { recursive: true })

  const cases: Array<[string, string, typeof paths]> = [
    ['EP0001', title, paths],
    ['EP0002', title, paths2],
    ['EP0003', title, paths3],
    ['EP0004', title, paths4],
  ]

  for (const [code, epTitle, epPaths] of cases) {
    const perEpisode = await originalFindYouTubeSourceVideoPath(epPaths, slug, code, epTitle)
    const bulk = await sourceVideo.findYouTubeSourceVideoPath(epPaths, slug, code, epTitle, utils.createProjectFactsCache(slug))
    assert.equal(bulk, perEpisode, `${code}: bulk Exports listing must find the same final`)
  }
  assert.equal(await originalFindYouTubeSourceVideoPath(paths, slug, 'EP0001', title), path.join(projectDir, 'Exports', seasonRel, 'EP0001_final_video.mp4'))
  assert.equal(
    await originalFindYouTubeSourceVideoPath(paths2, slug, 'EP0002', title),
    path.join(earlierRoot, slug, 'Season 001', 'EP0002 - Final', 'EP0002_final_video.mp4'),
    'an earlier Exports base still answers',
  )
  assert.equal(await originalFindYouTubeSourceVideoPath(paths4, slug, 'EP0004', title), '')
})

test('the overview reports the same readiness figures as a per-episode sweep', async () => {
  const fixture: OverviewFixture = await buildOverviewFixture({ channels: 3, episodesPerChannel: 40 })
  const overview = await svc.readPublishingOverview({ now: Date.now() })

  assert.equal(overview.channels.length, fixture.channels.length)
  for (const channel of fixture.channels) {
    const row = overview.channels.find(entry => entry.slug === channel.slug)
    assert.ok(row, `${channel.slug} is in the overview`)
    const reference = await referenceReadiness(channel.slug, channel.channelId)
    assert.equal(row!.readiness.ready_to_publish, reference.ready, `${channel.slug}: ready_to_publish`)
    assert.equal(row!.readiness.on_youtube, reference.on_youtube, `${channel.slug}: on_youtube`)
    assert.equal(row!.readiness.ready_unknown, 0, `${channel.slug}: nothing was unreadable`)
  }
})

// ── 2. Cost ─────────────────────────────────────────────────────────────────

test('the overview reads each season folder once, not once per episode', async () => {
  await buildOverviewFixture({ channels: 2, episodesPerChannel: 8 })
  const small = await measureOverview()

  await tmp.cleanup()
  tmp = await useTempDataDir()
  await buildOverviewFixture({ channels: 2, episodesPerChannel: 64 })
  const large = await measureOverview()
  const largeEpisodes = 2 * 64

  // `existsSync` is the probe this work removed from the per-episode path: it
  // must scale with CHANNELS, not with episodes. Before the bulk inputs it grew
  // by ~12 per episode; a channel with eight times the episodes must not ask
  // eight times as often.
  assert.equal(
    large.counters.existsSync,
    small.counters.existsSync,
    `existsSync must not grow with episodes (${small.counters.existsSync} → ${large.counters.existsSync})`,
  )

  // No directory is listed twice in one request: the season listings, the
  // Exports season listings and the per-episode folders are each read once.
  const listedTwice = large.counters.readdirPaths
    .filter((value, index, all) => all.indexOf(value) !== index)
  assert.deepEqual([...new Set(listedTwice)], [], 'a directory was listed more than once in one request')

  // And the whole per-episode cost stays a small constant. Measured on the
  // owner's library before this change: ~21 filesystem calls per episode.
  const perEpisode = (large.counters.existsSync + large.counters.readdir + large.counters.stat + large.counters.readFile) / largeEpisodes
  assert.ok(perEpisode <= 4, `filesystem calls per episode must stay small, saw ${perEpisode.toFixed(2)}`)

  // The read that CANNOT be bulked — "does this episode have a sidecar?" — is
  // exactly ONE per episode, not three: the item schedule, the legacy-upload
  // index and `remoteVideoFor` all ask, and they share one request-scoped read.
  assert.equal(
    large.counters.sidecarReads,
    largeEpisodes,
    `one sidecar read per episode, saw ${large.counters.sidecarReads} for ${largeEpisodes} episodes`,
  )
})
