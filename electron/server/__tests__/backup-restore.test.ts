/**
 * Backup and restore, end to end (1.4.287): two real channels made through Story's own services,
 * backed up to a temp "drive", changed, backed up again (old copies in _versions), interrupted and
 * resumed, checked, then restored onto a "new machine" where numbering, upload records and
 * settings must carry on exactly.
 */
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

let dir: string
let cleanup: () => Promise<void>
let pm: typeof import('../services/project-manager.js')
let im: typeof import('../services/idea-manager.js')
let backup: typeof import('../services/backup.js')
let utils: typeof import('../services/utils.js')

const drive = () => path.join(dir, 'SSD')
const backupRoot = () => path.join(drive(), 'Story Studio Backup')
const library = () => pm.projectsRoot()

interface Made { slug: string; codes: string[]; dirs: string[] }

async function write(file: string, body: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, body)
}

async function makeChannel(name: string, episodes: number): Promise<Made> {
  const project = await pm.createProject({ name })
  const slug = project.slug
  const ideas = await im.addIdeas(slug, Array.from({ length: episodes + 1 }, (_, i) => ({
    title: `${name} Story ${i + 1}`, logline: 'x', themes: [], suggested_chapters: 3, suggested_length: 'short', mood: 'calm',
  })), 'test-model')
  const made: Made = { slug, codes: [], dirs: [] }
  for (const idea of ideas.slice(0, episodes)) {
    const accepted = await im.acceptIdea(slug, idea.id)
    made.codes.push(accepted.episode_code)
    made.dirs.push(accepted.episode_dir)
    const p = await utils.resolveEpisodePaths(slug, accepted.episode_code, accepted.idea.title)
    const code = accepted.episode_code
    await write(path.join(p.script_dir, `${code}_Script_Narration.md`), `# ${code}\nOnce upon a time.\n`)
    await write(path.join(p.metadata_dir, `${code}_Metadata.json`), JSON.stringify({ titles: ['T'], description: 'D', tags: ['a'] }))
    await write(path.join(p.scene_prompts_dir, 'scene_plan.json'), JSON.stringify({ scenes: [{ n: 1, approved: true }] }))
    await write(path.join(p.subtitles_dir, `${code}_${slug}.srt`), '1\n00:00:00,000 --> 00:00:01,000\nHi\n')
    await write(path.join(p.bg_dir, `${code}_Scene01_v1.png`), Buffer.alloc(4000, 1))
    await write(path.join(p.thumb_dir, `${code}_Thumb01_v1.png`), Buffer.alloc(3000, 2))
    await write(path.join(p.thumb_dir, `${code}_Thumb02_v1.png`), Buffer.alloc(3000, 3))
    await write(path.join(p.episode_dir, 'upload_metadata_overrides.json'), JSON.stringify({ youtube: { selected_thumbnail: `${code}_Thumb01_v1.png` } }))
    await write(path.join(p.audio_dir, `${code}_${slug}.mp3`), Buffer.alloc(5000, 4))
    await write(path.join(p.audio_dir, '.parts', 'ch1', 'part.mp3'), Buffer.alloc(100, 4))
    await write(path.join(p.merged_audio_dir, `${code}_merged_audio.mp3`), Buffer.alloc(6000, 5))
    await write(path.join(p.merged_audio_dir, `${code}_merged_audio.completion.json`), '{"ok":true}')
    await write(path.join(p.video_dir, `${code}_final_video.mp4`), Buffer.alloc(9000, 6))
    await write(path.join(p.episode_dir, 'audio_chapters.json'), '[{"chapter":1,"start":0}]')
    await write(path.join(p.episode_dir, 'scene_effects.json'), '{"effects":[]}')
    await write(path.join(p.episode_dir, 'living_masks', 'lantern.png'), Buffer.alloc(200, 7))
    await write(path.join(p.episode_dir, '.render_status.json'), '{}')
  }
  const projectDir = pm.getProjectDir(slug)!
  // Channel-level: presets with a legacy key, OAuth secrets, Music Pool, branding, job history.
  const configPath = path.join(projectDir, 'config.json')
  const config = JSON.parse(await fs.readFile(configPath, 'utf-8'))
  await write(configPath, JSON.stringify({ ...config, genstudio_api_key: 'sk-live-should-not-travel', video_presets: { calm: { fade: 2 } } }))
  await write(path.join(projectDir, 'secrets.json'), JSON.stringify({ upload: { youtube: { main: { refresh_token: 'rt' } } } }))
  await write(path.join(projectDir, 'music', 'harbour-lullaby.m4a'), Buffer.alloc(7000, 8))
  await write(path.join(projectDir, 'music', 'old-tide.m4a'), Buffer.alloc(7000, 9))
  await write(path.join(projectDir, 'assets', 'logo.png'), Buffer.alloc(500, 10))
  await write(path.join(projectDir, 'assets', 'intro.mp4'), Buffer.alloc(800, 11))
  await write(path.join(projectDir, 'covered-topics.json'), '{"topics":[]}')
  await write(path.join(projectDir, 'jobs.json'), JSON.stringify({ jobs: [
    { job_id: 'a', status: 'done', type: 'script' },
    { job_id: 'b', status: 'running', type: 'images' },
  ] }))
  await write(path.join(projectDir, '.cache', 'thumbs', 'x.jpg'), Buffer.alloc(100))
  await write(path.join(projectDir, 'Exports', `${made.codes[0]}_final_video.mp4`), Buffer.alloc(9000, 12))
  return made
}

before(async () => {
  const temp = await useTempDataDir()
  dir = temp.dir
  cleanup = temp.cleanup
  pm = await import('../services/project-manager.js')
  im = await import('../services/idea-manager.js')
  backup = await import('../services/backup.js')
  utils = await import('../services/utils.js')
})

after(async () => { await cleanup() })

let alpha: Made
let beta: Made
const appSettings = () => ({
  library_root: '/Volumes/Old/Library',
  voice_presets: [{ id: 'calm-narrator', voice: 'v1' }],
  notifications: { desktop: true, telegram: { chat_id: '1', bot_token: 'secret-bot' } },
  server_mode: { enabled: true, auth: { password_hash: 'h', session_secret: 's' }, automation_keys: [{ hash: 'k' }] },
  genstudio_url: 'http://gateway.local',
})

async function run(extra: Partial<Parameters<typeof backup.runBackup>[0]> = {}) {
  return backup.runBackup({
    dataDir: dir, libraryRoot: library(), destination: drive(), options: {}, storyVersion: '9.9.9',
    appSettings: appSettings(), ...extra,
  })
}

test('a default backup keeps records and irreplaceable files, leaves out media and secrets', async () => {
  alpha = await makeChannel('Alpha Tales', 3)
  beta = await makeChannel('Beta Myths', 2)
  // App-wide stores in the data folder, and a dot-store at the Library root.
  await write(path.join(dir, 'youtube', 'connections.json'), JSON.stringify({ assignments: { [alpha.slug]: 'UC1' } }))
  await write(path.join(dir, 'app-secrets.json'), '{"providers":{"genstudio":{"apiKey":"x"}}}')
  await write(path.join(dir, 'content-packs', 'state.json'), '{"installed":[]}')
  await write(path.join(dir, 'logs', 'app.log'), 'log')
  await write(path.join(library(), '.character-library', 'hero', 'character.json'), '{"name":"Hero"}')
  // Alpha's first episode was uploaded.
  await write(path.join(alpha.dirs[0], 'youtube_upload.json'), JSON.stringify({ video_id: 'yt123', uploaded_at: '2026-10-01T00:00:00Z', privacy_status: 'public' }))
  await fs.mkdir(drive(), { recursive: true })

  const r = await run()
  assert.equal(r.complete, true, r.interrupted)
  const m = (await backup.readManifest(backupRoot()))!
  const has = (suffix: string) => Object.keys(m.files).some(k => k.endsWith(suffix))
  const code = alpha.codes[0]

  // In.
  for (const s of ['/project.json', '/config.json', '/ideas.json', '/covered-topics.json', '/jobs.json', 'music/harbour-lullaby.m4a',
    'assets/logo.png', 'assets/intro.mp4', `${code}_Script_Narration.md`, `${code}_Metadata.json`, 'scene_plan.json', '.srt',
    'audio_chapters.json', 'scene_effects.json', 'living_masks/lantern.png', 'youtube_upload.json', 'upload_metadata_overrides.json',
    `${code}_Thumb01_v1.png`, `${code}_merged_audio.completion.json`, 'app/youtube/connections.json', 'app/content-packs/state.json',
    'app/app-settings.json', '.character-library/hero/character.json']) assert.ok(has(s), `expected ${s} in the backup`)
  // Out.
  for (const s of ['secrets.json', 'app-secrets.json', `${code}_Thumb02_v1.png`, 'Scene01_v1.png', `${code}_merged_audio.mp3`,
    `${code}_final_video.mp4`, `_${alpha.slug}.mp3`, 'part.mp3', '.render_status.json', 'x.jpg', 'app.log']) assert.ok(!has(s), `did not expect ${s}`)

  // Secrets stripped from what was kept.
  const cfg = JSON.parse(await fs.readFile(path.join(backupRoot(), 'library', alpha.slug, 'config.json'), 'utf-8'))
  assert.equal(cfg.genstudio_api_key, undefined)
  assert.deepEqual(cfg.video_presets, { calm: { fade: 2 } })
  const settings = await fs.readFile(path.join(backupRoot(), 'app', 'app-settings.json'), 'utf-8')
  assert.doesNotMatch(settings, /secret-bot|password_hash|session_secret|library_root/)
  assert.match(settings, /calm-narrator/)

  // Manifest facts.
  assert.equal(m.story_version, '9.9.9')
  assert.equal(m.counts.channels[alpha.slug].episodes, 3)
  assert.equal(m.counts.channels[beta.slug].episodes, 2)
  assert.equal(m.counts.channels[alpha.slug].uploaded_episodes, 1)
  assert.ok(r.sizes.final_videos > 0 && r.sizes.narration_audio > 0 && r.sizes.all_thumbnails > 0, 'optional extras are measured')
  // A plain mirror: the pinned thumbnail is the real file.
  assert.equal((await fs.stat(path.join(backupRoot(), 'library', path.relative(library(), alpha.dirs[0]), `${code} - 06 Thumbnail Images`, `${code}_Thumb01_v1.png`))).size, 3000)
})

test('a second backup copies only what changed and moves replaced or removed copies to _versions', async () => {
  const projectDir = pm.getProjectDir(alpha.slug)!
  const scriptRel = path.relative(library(), path.join(alpha.dirs[0], `${alpha.codes[0]} - 01 Script`, `${alpha.codes[0]}_Script_Narration.md`))
  await write(path.join(library(), scriptRel), '# rewritten\n')
  const future = new Date(Date.now() + 5000)
  await fs.utimes(path.join(library(), scriptRel), future, future)
  await fs.rename(path.join(projectDir, 'music', 'old-tide.m4a'), path.join(dir, 'gone.m4a'))
  await write(path.join(projectDir, 'music', 'new-dawn.m4a'), Buffer.alloc(100, 1))

  const r = await run()
  assert.equal(r.complete, true)
  assert.equal(r.added, 1)
  assert.equal(r.updated, 1)
  assert.equal(r.removed, 1)
  assert.ok(r.unchanged > 20)
  const versions = path.join(backupRoot(), '_versions', r.versions_stamp, 'library')
  assert.equal(await fs.readFile(path.join(versions, scriptRel), 'utf-8'), `# ${alpha.codes[0]}\nOnce upon a time.\n`)
  assert.ok(existsSync(path.join(versions, alpha.slug, 'music', 'old-tide.m4a')))
  assert.ok(!existsSync(path.join(backupRoot(), 'library', alpha.slug, 'music', 'old-tide.m4a')))
  const listed = await backup.listVersions(drive())
  assert.ok(listed.total_bytes >= 7000)
})

test('an interrupted backup leaves no half file and the next run carries on', async () => {
  await write(path.join(pm.getProjectDir(beta.slug)!, 'music', 'big.m4a'), Buffer.alloc(50_000, 3))
  await write(path.join(pm.getProjectDir(beta.slug)!, 'music', 'big2.m4a'), Buffer.alloc(50_000, 4))
  let calls = 0
  const stopped = await run({ shouldStop: () => ++calls > 40 })
  assert.equal(stopped.complete, false)
  assert.ok(stopped.interrupted)
  assert.equal((await backup.readManifest(backupRoot()))!.complete, false)
  const resumed = await run()
  assert.equal(resumed.complete, true)
  assert.equal(resumed.removed, 0, 'files not reached by the stopped run are not mistaken for removed ones')
  assert.equal((await fs.stat(path.join(backupRoot(), 'library', beta.slug, 'music', 'big2.m4a'))).size, 50_000)
})

test('optional extras are copied only when chosen', async () => {
  const r = await run({ options: { final_videos: true } })
  assert.equal(r.complete, true)
  const m = (await backup.readManifest(backupRoot()))!
  assert.ok(Object.keys(m.files).some(k => k.endsWith(`${alpha.codes[0]}_final_video.mp4`)))
  assert.ok(!Object.keys(m.files).some(k => k.endsWith('_merged_audio.mp3')))
  // Turning it back off moves those copies aside rather than deleting them.
  const off = await run({ options: {} })
  assert.ok(off.removed >= 5)
  assert.ok(existsSync(path.join(backupRoot(), '_versions', off.versions_stamp)))
})

test('Check backup reports missing and damaged files', async () => {
  const clean = await backup.verifyBackup(drive())
  assert.equal(clean.missing.length + clean.damaged.length, 0)
  const m = (await backup.readManifest(backupRoot()))!
  const [first, second] = Object.keys(m.files).filter(k => k.endsWith('.md'))
  await fs.writeFile(path.join(backupRoot(), first), 'tampered')
  await fs.rename(path.join(backupRoot(), second), path.join(dir, 'moved-away.md'))
  const report = await backup.verifyBackup(drive())
  assert.deepEqual(report.damaged, [first])
  assert.deepEqual(report.missing, [second])
  // Put things right again for the restore below.
  await fs.rename(path.join(dir, 'moved-away.md'), path.join(backupRoot(), second))
  await run()
})

test('pruning _versions deletes only the chosen stamps', async () => {
  const before = await backup.listVersions(drive())
  assert.ok(before.versions.length >= 1)
  const oldest = before.versions[0].stamp
  const pruned = await backup.pruneVersions(drive(), [oldest, '../../escape'])
  assert.deepEqual(pruned.removed, [oldest])
  const afterList = await backup.listVersions(drive())
  assert.equal(afterList.versions.length, before.versions.length - 1)
})

test('restore on a new machine: new Library, numbering, upload records and settings carry on', async () => {
  const nextAlpha = await im.getNextAcceptNumber(alpha.slug)
  const nextBeta = await im.getNextAcceptNumber(beta.slug)
  // "New machine": the old Library is gone from where Story looks.
  await fs.rename(library(), path.join(dir, 'old-machine-library'))

  const preview = await backup.previewRestore(drive(), library())
  assert.deepEqual(preview.channels.map(c => c.slug).sort(), [alpha.slug, beta.slug].sort())
  assert.ok(preview.channels.every(c => !c.exists_in_target && c.restore_bytes > 0))

  const written: Record<string, unknown> = {}
  const newData = path.join(dir, 'new-data')
  const r = await backup.restoreBackup({
    source: drive(), target: library(), channels: [{ slug: alpha.slug }, { slug: beta.slug }], app: true,
    dataDir: newData, currentSettings: { last_seen_version: '1.0.0' },
    writeSetting: async (k, v) => { written[k] = v },
  })
  assert.equal(r.damaged.length, 0, r.damaged.join(', '))
  assert.equal(r.interrupted, '')

  assert.equal(await im.getNextAcceptNumber(alpha.slug), nextAlpha)
  assert.equal(await im.getNextAcceptNumber(beta.slug), nextBeta)
  const accepted = await im.getIdeas(alpha.slug, 'accepted')
  assert.deepEqual(accepted.map(i => i.episode_code).sort(), [...alpha.codes].sort())

  const { readEpisodeUploadStatus } = await import('../services/episode-upload-status.js')
  const { readYouTubeRetentionStores } = await import('../services/youtube-remote-video.js')
  const stores = await readYouTubeRetentionStores(alpha.slug)
  const status = await readEpisodeUploadStatus(alpha.slug, alpha.codes[0], accepted.find(i => i.episode_code === alpha.codes[0])!.title, stores)
  assert.equal(status.video_id, 'yt123')
  assert.notEqual(status.state, 'none')

  // Settings: non-secret ones come back, machine paths and secrets do not.
  assert.deepEqual(written.voice_presets, [{ id: 'calm-narrator', voice: 'v1' }])
  assert.equal(written.library_root, undefined)
  assert.equal(written.server_mode, undefined)
  assert.equal((written.notifications as any).telegram.bot_token, undefined)
  assert.ok(existsSync(path.join(newData, 'youtube', 'connections.json')))
  assert.ok(!existsSync(path.join(newData, 'app-settings.json')), 'settings are merged through setAppSetting, never copied over')

  // Job history returns as history: nothing queued or running from the old machine.
  const jobs = JSON.parse(await fs.readFile(path.join(pm.getProjectDir(alpha.slug)!, 'jobs.json'), 'utf-8')).jobs
  assert.deepEqual(jobs.map((j: any) => j.job_id), ['a'])
  // Presets, Music Pool and branding are back; no secrets.
  const cfg = JSON.parse(await fs.readFile(path.join(pm.getProjectDir(alpha.slug)!, 'config.json'), 'utf-8'))
  assert.deepEqual(cfg.video_presets, { calm: { fade: 2 } })
  assert.ok(existsSync(path.join(pm.getProjectDir(alpha.slug)!, 'music', 'harbour-lullaby.m4a')))
  assert.ok(!existsSync(path.join(pm.getProjectDir(alpha.slug)!, 'secrets.json')))

  // An existing channel is never overwritten without a per-channel yes, and a yes moves it to _trash.
  await assert.rejects(backup.restoreBackup({
    source: drive(), target: library(), channels: [{ slug: beta.slug }], app: false,
    dataDir: newData, currentSettings: {}, writeSetting: async () => {},
  }), /already exists/)
  const replaced = await backup.restoreBackup({
    source: drive(), target: library(), channels: [{ slug: beta.slug, replace: true }], app: false,
    dataDir: newData, currentSettings: {}, writeSetting: async () => {},
  })
  assert.equal(replaced.replaced.length, 1)
  assert.ok(existsSync(path.join(replaced.replaced[0].moved_to, 'project.json')))
  assert.equal(await im.getNextAcceptNumber(beta.slug), nextBeta)
})
