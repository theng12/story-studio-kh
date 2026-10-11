/**
 * Self-contained channels (2026-10-07): each channel carries its own assets
 * and finished videos, so copying the channel folder to another Mac moves
 * everything it needs.
 *
 * Pinned here:
 *   - `${CHANNEL}` resolves to the channel folder and picks inside it collapse to it;
 *   - every kind of reference is rewritten (`${ASSET}`, absolute outside the
 *     Library, absolute inside the channel / episodes, an old iCloud path the
 *     channel still holds), and a missing file is reported, not invented;
 *   - the dry run changes nothing; apply copies with matching sha256, leaves
 *     every original untouched, and a second run does nothing;
 *   - the moved channel folder resolves every reference in a fresh Library;
 *   - finals move from `<Library>/Exports/<slug>` into `<channel>/Exports`, and
 *     status, the upload source finder, the storage audit and cleanup's trash
 *     anchor follow; a `media_root` channel keeps today's location.
 */

import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'crypto'
import { existsSync } from 'fs'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

let tmp: { dir: string; cleanup: () => Promise<void> } | undefined

beforeEach(async () => {
  await tmp?.cleanup()
  tmp = await useTempDataDir()
})
after(async () => { await tmp?.cleanup() })

const sha = async (p: string) => createHash('sha256').update(await fs.readFile(p)).digest('hex')

async function write(p: string, body: string | Buffer): Promise<string> {
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, body)
  return p
}

async function setup(name = 'Night Atlas') {
  const lib = await import('../services/library.js')
  const pm = await import('../services/project-manager.js')
  const resolver = await import('../services/path-resolver.js')
  const library = path.join(tmp!.dir, 'Library')
  await lib.setLibraryRoot(library)
  const project = await pm.createProject({ name, episode_prefix: 'EP', episode_digits: 3 })
  const channelDir = pm.getProjectDir(project.slug)!
  const episodesRoot = (await pm.getProjectOutputRoot(project.slug))!
  return { lib, pm, resolver, library, slug: project.slug, channelDir, episodesRoot, shared: resolver.assetsRoot() }
}

async function readJson(p: string): Promise<any> {
  return JSON.parse(await fs.readFile(p, 'utf-8'))
}

/** A channel whose config uses every kind of reference found on the owner's mini. */
async function seedReferences(ctx: Awaited<ReturnType<typeof setup>>) {
  const { channelDir, shared, slug } = ctx
  const outside = path.join(tmp!.dir, 'Elsewhere')
  const files = {
    sharedLogo: await write(path.join(shared, 'night-atlas-assets', 'Logo.png'), 'logo-bytes'),
    sharedIntro: await write(path.join(shared, 'night-atlas-assets', 'Intro.mp4'), 'intro-bytes'),
    outsideMusic: await write(path.join(outside, 'Bed.mp3'), 'music-bytes'),
    outsideOverlay: await write(path.join(outside, 'film frame.png'), 'overlay-bytes'),
    channelMusic: await write(path.join(channelDir, 'music', 'Own bed.mp3'), 'own-music'),
    episodeSrt: await write(path.join(channelDir, 'episodes', 'Season 001', 'EP001 - One', 'EP001.srt'), '1\n'),
    reRooted: await write(path.join(channelDir, 'episodes', '00 Assets', 'End Still.png'), 'end-still'),
  }
  const icloud = `/Users/someone/Library/Mobile Documents/com~apple~CloudDocs/YouTube/${slug}/episodes/00 Assets/End Still.png`
  const gone = '/Users/someone/Library/Mobile Documents/com~apple~CloudDocs/YouTube/other/Logo old.png'
  const configPath = path.join(channelDir, 'config.json')
  const config = await readJson(configPath)
  Object.assign(config, {
    effects_presets: [{ id: 'e1', name: 'Look', data: {
      logo: { image_path: '${ASSET}/night-atlas-assets/Logo.png' },
      overlays: { layers: [{ id: 'o1', source_path: files.outsideOverlay }] },
      frame: { background_path: gone },
    } }],
    intro_presets: [{ id: 'i1', name: 'Intro', data: { video_path: '${ASSET}/night-atlas-assets/Intro.mp4', timeline_clips: [{ image_path: icloud }] } }],
    audio_merge_presets: [{ id: 'a1', name: 'Mix', data: { music: { files: [files.outsideMusic, files.channelMusic] }, intro: { file: '${ASSET}/night-atlas-assets/Intro.mp4' } } }],
    video_bundle_presets: [{ id: 'b1', name: 'Bundle', data: { fallback: { subtitles: { srt_path: files.episodeSrt }, effects: { logo: { image_path: '${ASSET}/night-atlas-assets/Logo.png' } } } } }],
    note_about_folder: '/Users/someone/notes.txt',
  })
  await fs.writeFile(configPath, JSON.stringify(config, null, 2))
  const projectPath = path.join(channelDir, 'project.json')
  const meta = await readJson(projectPath)
  meta.channel_logo_path = files.outsideOverlay
  await fs.writeFile(projectPath, JSON.stringify(meta, null, 2))
  return { files, icloud, gone, configPath, projectPath }
}

test('${CHANNEL} resolves to the channel folder; picks inside the channel collapse to it', async () => {
  const { resolver, channelDir, episodesRoot, shared } = await setup()
  assert.equal(resolver.resolveAssetPath('${CHANNEL}/assets/Logo.png', episodesRoot), path.join(channelDir, 'assets', 'Logo.png'))
  assert.equal(resolver.toPortablePath(path.join(channelDir, 'music', 'a.mp3'), episodesRoot), '${CHANNEL}/music/a.mp3')
  assert.equal(resolver.toPortablePath(path.join(episodesRoot, 'Season 001', 'x.srt'), episodesRoot), '${PROJECT}/Season 001/x.srt')
  assert.equal(resolver.toPortablePath(path.join(shared, 'a.png'), episodesRoot), '${ASSET}/a.png', 'the shared folder still collapses as before')
  assert.throws(() => resolver.resolveAssetPath('${CHANNEL}/a.png'), /requires an episodes-folder context/)
})

// boundful EP0095 (2026-10-10): a Video Assembly recovery saved before the move still named
// `${ASSET}/boundless-assets/…` after the shared originals were gone; the channel's copy is used.
test('a stale ${ASSET} reference finds the channel copy once the shared original is gone', async () => {
  const { resolver, channelDir, episodesRoot, shared } = await setup()
  const rel = 'boundless-assets/Boundless - Intro Video 10s.mp4'
  assert.equal(resolver.resolveAssetPath(`\${ASSET}/${rel}`, episodesRoot), path.join(shared, rel), 'nothing anywhere: the shared path, as before')
  const own = await write(path.join(channelDir, 'assets', rel), 'intro')
  assert.equal(resolver.resolveAssetPath(`\${ASSET}/${rel}`, episodesRoot), own)
  const sharedCopy = await write(path.join(shared, rel), 'intro')
  assert.equal(resolver.resolveAssetPath(`\${ASSET}/${rel}`, episodesRoot), sharedCopy, 'a present shared original still wins')
})

test('dry run lists every kind of reference with sizes and changes nothing', async () => {
  const ctx = await setup()
  const seeded = await seedReferences(ctx)
  const before = { config: await fs.readFile(seeded.configPath, 'utf-8'), project: await fs.readFile(seeded.projectPath, 'utf-8') }
  const { planChannel } = await import('../services/channel-self-contained.js')
  const plan = await planChannel(ctx.slug)

  const byField = Object.fromEntries(plan.refs.map(r => [`${r.file}:${r.field}`, r]))
  const at = (f: string) => byField[f] ?? assert.fail(`no plan row for ${f}: ${Object.keys(byField).join(', ')}`)
  assert.equal(at('config.json:effects_presets[0].data.logo.image_path').to, '${CHANNEL}/assets/night-atlas-assets/Logo.png')
  assert.equal(at('config.json:effects_presets[0].data.logo.image_path').action, 'copy')
  assert.equal(at('config.json:intro_presets[0].data.video_path').to, '${CHANNEL}/assets/night-atlas-assets/Intro.mp4')
  assert.equal(at('config.json:effects_presets[0].data.overlays.layers[0].source_path').to, '${CHANNEL}/assets/film frame.png')
  assert.equal(at('config.json:audio_merge_presets[0].data.music.files[0]').to, '${CHANNEL}/assets/Bed.mp3')
  assert.equal(at('config.json:audio_merge_presets[0].data.music.files[1]').to, '${CHANNEL}/music/Own bed.mp3')
  assert.equal(at('config.json:audio_merge_presets[0].data.music.files[1]').action, 'rewrite')
  assert.equal(at('config.json:video_bundle_presets[0].data.fallback.subtitles.srt_path').to, '${PROJECT}/Season 001/EP001 - One/EP001.srt')
  assert.equal(at('config.json:intro_presets[0].data.timeline_clips[0].image_path').to, '${PROJECT}/00 Assets/End Still.png', 'an old iCloud path the channel still holds is re-rooted')
  assert.equal(at('project.json:channel_logo_path').to, '${CHANNEL}/assets/film frame.png')
  const missing = at('config.json:effects_presets[0].data.frame.background_path')
  assert.equal(missing.action, 'missing')
  assert.equal(missing.to, seeded.gone, 'a missing file is reported and left as it is')
  assert.ok(!plan.refs.some(r => r.from === '/Users/someone/notes.txt'), 'a non-asset string is never touched')

  // The same shared file used twice is copied once; sizes add up.
  assert.equal(plan.copies.length, 4)
  assert.equal(plan.totals.bytes_to_copy, ['logo-bytes', 'intro-bytes', 'music-bytes', 'overlay-bytes'].reduce((n, s) => n + s.length, 0))
  assert.equal(plan.totals.missing, 1)
  assert.equal(plan.done, false)

  assert.equal(await fs.readFile(seeded.configPath, 'utf-8'), before.config, 'dry run never writes config.json')
  assert.equal(await fs.readFile(seeded.projectPath, 'utf-8'), before.project, 'dry run never writes project.json')
  assert.equal(existsSync(path.join(ctx.channelDir, 'assets')), false, 'dry run copies nothing')
})

test('apply copies with matching sha256, leaves originals untouched, and is idempotent', async () => {
  const ctx = await setup()
  const seeded = await seedReferences(ctx)
  const originals = [seeded.files.sharedLogo, seeded.files.sharedIntro, seeded.files.outsideMusic, seeded.files.outsideOverlay]
  const beforeStat = await Promise.all(originals.map(async p => ({ p, sha: await sha(p), mtime: (await fs.stat(p)).mtimeMs })))
  const { applyChannel, planChannel } = await import('../services/channel-self-contained.js')

  const result = await applyChannel(ctx.slug)
  assert.deepEqual(result.errors, [])
  assert.equal(result.copied.length, 4)
  for (const c of result.copied) assert.equal(await sha(c.target), await sha(c.source), `${c.target} matches its source`)
  for (const o of beforeStat) {
    assert.equal(await sha(o.p), o.sha, `${o.p} unchanged`)
    assert.equal((await fs.stat(o.p)).mtimeMs, o.mtime, `${o.p} not touched`)
  }
  assert.ok(existsSync(seeded.files.sharedLogo), '_Project Assets is left alone')

  const config = await readJson(seeded.configPath)
  assert.equal(config.effects_presets[0].data.logo.image_path, '${CHANNEL}/assets/night-atlas-assets/Logo.png')
  assert.equal(config.audio_merge_presets[0].data.music.files[0], '${CHANNEL}/assets/Bed.mp3')
  assert.equal(config.effects_presets[0].data.frame.background_path, seeded.gone, 'missing stays as it was')
  assert.equal(config.note_about_folder, '/Users/someone/notes.txt')
  assert.equal((await readJson(seeded.projectPath)).channel_logo_path, '${CHANNEL}/assets/film frame.png')
  assert.equal(result.plan_after.done, true)
  assert.equal(result.missing.length, 1)

  // Second run: nothing to copy, nothing to rewrite, files not rewritten.
  const mtime = (await fs.stat(seeded.configPath)).mtimeMs
  const again = await applyChannel(ctx.slug)
  assert.equal(again.copied.length, 0)
  assert.equal(again.rewritten, 0)
  assert.equal((await fs.stat(seeded.configPath)).mtimeMs, mtime, 'an idempotent run does not touch config.json')
  assert.equal((await planChannel(ctx.slug)).totals.refs_to_rewrite, 0)
})

test('a name clash with different bytes gets its own file; same bytes are reused', async () => {
  const ctx = await setup()
  const outsideA = await write(path.join(tmp!.dir, 'A', 'Logo.png'), 'one')
  const outsideB = await write(path.join(tmp!.dir, 'B', 'Logo.png'), 'two')
  await write(path.join(ctx.channelDir, 'assets', 'Logo.png'), 'one')
  const configPath = path.join(ctx.channelDir, 'config.json')
  const config = await readJson(configPath)
  config.effects_presets = [{ id: 'x', data: { logo: { image_path: outsideA } } }, { id: 'y', data: { logo: { image_path: outsideB } } }]
  await fs.writeFile(configPath, JSON.stringify(config))
  const { applyChannel } = await import('../services/channel-self-contained.js')
  await applyChannel(ctx.slug)
  const after = await readJson(configPath)
  assert.equal(after.effects_presets[0].data.logo.image_path, '${CHANNEL}/assets/Logo.png')
  assert.equal(after.effects_presets[1].data.logo.image_path, '${CHANNEL}/assets/Logo (2).png')
  assert.equal(await fs.readFile(path.join(ctx.channelDir, 'assets', 'Logo (2).png'), 'utf-8'), 'two')
})

test('a moved channel folder resolves every reference in a fresh Library', async () => {
  const ctx = await setup()
  const seeded = await seedReferences(ctx)
  const { applyChannel } = await import('../services/channel-self-contained.js')
  await applyChannel(ctx.slug)

  // Carry only the channel folder; the old Library, its _Project Assets and the
  // outside folder are gone from the new Mac's point of view.
  const carried = path.join(tmp!.dir, '..', `carried-${path.basename(tmp!.dir)}`)
  await fs.cp(ctx.channelDir, carried, { recursive: true })
  await tmp!.cleanup()
  tmp = await useTempDataDir()
  const lib = await import('../services/library.js')
  const pm = await import('../services/project-manager.js')
  const resolver = await import('../services/path-resolver.js')
  await lib.setLibraryRoot(path.join(tmp.dir, 'New Library'))
  await fs.mkdir(pm.projectsRoot(), { recursive: true })
  await fs.rename(carried, path.join(pm.projectsRoot(), ctx.slug))
  const episodesRoot = (await pm.getProjectOutputRoot(ctx.slug))!
  assert.ok(episodesRoot.startsWith(tmp.dir))

  const stored: string[] = []
  const collect = (n: unknown): void => {
    if (typeof n === 'string') { if (n.startsWith('${') || n.startsWith('/')) stored.push(n); return }
    if (Array.isArray(n)) n.forEach(collect)
    else if (n && typeof n === 'object') Object.values(n).forEach(collect)
  }
  collect(await readJson(path.join(pm.projectsRoot(), ctx.slug, 'config.json')))
  const meta = await readJson(path.join(pm.projectsRoot(), ctx.slug, 'project.json'))
  collect(meta.channel_logo_path)
  const unresolved = stored
    .filter(v => v !== seeded.gone && v !== '/Users/someone/notes.txt')
    .filter(v => !existsSync(resolver.resolveAssetPath(v, episodesRoot)))
  assert.deepEqual(unresolved, [], 'every reference resolves inside the carried folder')
  assert.ok(!stored.some(v => v.startsWith('${ASSET}')), 'no shared-folder reference is left')
})

test('picking a file outside the channel copies it into assets/ (adopt mode)', async () => {
  const ctx = await setup()
  const picked = await write(path.join(tmp!.dir, 'Downloads', 'New logo.png'), 'picked')
  const request = (await import('supertest')).default
  const { app } = await import('../app.js')
  const res = await request(app).post('/api/system/resolve-asset-path').send({ path: picked, output_root: ctx.episodesRoot, mode: 'adopt' })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.output, '${CHANNEL}/assets/New logo.png')
  assert.equal(await fs.readFile(path.join(ctx.channelDir, 'assets', 'New logo.png'), 'utf-8'), 'picked')
  assert.ok(existsSync(picked), 'the picked original stays')

  const inside = await request(app).post('/api/system/resolve-asset-path')
    .send({ path: path.join(ctx.channelDir, 'assets', 'New logo.png'), output_root: ctx.episodesRoot, mode: 'adopt' })
  assert.equal(inside.body.output, '${CHANNEL}/assets/New logo.png', 'a file already in the channel is not copied again')
  assert.equal(inside.body.copied_to, null)

  // A made-up episodes folder can never become a copy destination.
  const bogus = await request(app).post('/api/system/resolve-asset-path')
    .send({ path: picked, output_root: path.join(tmp!.dir, 'Downloads', 'episodes'), mode: 'adopt' })
  assert.equal(bogus.body.output, picked)
  assert.equal(existsSync(path.join(tmp!.dir, 'Downloads', 'assets')), false)
})

// ── Finished videos ───────────────────────────────────────────────────────

async function seedEpisode(slug: string) {
  const ideas = await import('../services/idea-manager.js')
  const [idea] = await ideas.addIdeas(slug, [{
    title: 'One', logline: 'l', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: 'm',
  }], 'test')
  const accepted = await ideas.acceptIdea(slug, idea!.id, false)
  return { code: accepted.episode_code, title: idea!.title }
}

test('finals move from <Library>/Exports/<slug> into the channel, and status, upload, audit and cleanup follow', async () => {
  const ctx = await setup()
  const { code, title } = await seedEpisode(ctx.slug)
  const store = await import('../services/external-video-store.js')
  const assetStatus = await import('../services/asset-status.js')
  const { episodeStatusCache } = await import('../services/episode-status-cache.js')
  const { resolveEpisodePathsByCode } = await import('../services/utils.js')
  const { findYouTubeSourceVideoPath } = await import('../services/youtube-source-video.js')
  const { trashRootFor } = await import('../lib/trash-move.js')

  // New renders default to the channel.
  const writeDir = await store.ensureExternalFinalVideoDir(ctx.slug, code, title)
  assert.ok(writeDir!.startsWith(path.join(ctx.channelDir, 'Exports') + path.sep), String(writeDir))
  await fs.rmdir(writeDir!)
  await fs.rmdir(path.dirname(writeDir!))

  // A final made before 2026-10-07 sits in the Library-wide Exports and is still found.
  const legacyDir = path.join(ctx.library, 'Exports', ctx.slug, path.relative(path.join(ctx.channelDir, 'Exports'), writeDir!))
  const legacyFinal = await write(path.join(legacyDir, `${code}_final_video.mp4`), Buffer.alloc(4096, 7))
  await write(path.join(legacyDir, `${code}_final_video.mp4.source.json`), '{}')
  const legacySha = await sha(legacyFinal)
  assert.equal(path.resolve((await store.resolveExternalFinalVideoDir(ctx.slug, code, title))!), path.resolve(legacyDir))
  episodeStatusCache.clear()
  assert.equal((await assetStatus.computeEpisodeStatus(ctx.slug, code)).video_assembly, true)

  const { planChannel, applyChannel } = await import('../services/channel-self-contained.js')
  const plan = await planChannel(ctx.slug)
  assert.equal(plan.exports.channel_local, true)
  assert.equal(plan.exports.moves.length, 2)
  assert.equal(plan.totals.export_bytes, 4096 + 2)
  assert.ok(existsSync(legacyFinal), 'the dry run moves nothing')

  const result = await applyChannel(ctx.slug)
  assert.deepEqual(result.errors, [])
  assert.equal(result.exports_moved, 2)
  const movedFinal = path.join(writeDir!, `${code}_final_video.mp4`)
  assert.equal(await sha(movedFinal), legacySha, 'same bytes at the new place')
  assert.equal(existsSync(legacyFinal), false)
  assert.equal(result.plan_after.exports.moves.length, 0, 'idempotent')

  assert.equal(await store.resolveExternalFinalVideoDir(ctx.slug, code, title), writeDir)
  episodeStatusCache.clear()
  assert.equal((await assetStatus.computeEpisodeStatus(ctx.slug, code)).video_assembly, true, 'status follows')
  const paths = await resolveEpisodePathsByCode(ctx.slug, code)
  assert.equal(await findYouTubeSourceVideoPath(paths, ctx.slug, code, title), movedFinal, 'upload source follows')
  const audit = await (await import('../services/storage-audit.js')).auditProjectStorage(ctx.slug)
  const row = audit.episodes.find(e => e.episode_code === code)!
  assert.equal(row.external_episode_dir, writeDir)
  assert.equal(row.bytes_external_final_video, 4096)
  assert.equal(audit.external_root, path.join(ctx.channelDir, 'Exports'))
  const anchor = await store.exportsAnchorFor(ctx.slug, writeDir!)
  assert.equal(anchor, ctx.channelDir, 'cleanup proves ownership against the channel folder')
  assert.equal(trashRootFor(anchor, ctx.channelDir, ctx.slug), path.join(path.dirname(ctx.channelDir), '_trash', ctx.slug), 'Free up space trashes into Story\'s one Trash')
  assert.equal(await store.exportsAnchorFor(ctx.slug, legacyDir), path.join(ctx.library, 'Exports'), 'an unmigrated final keeps its old anchor')
})

test('a channel with media_root keeps finals where they are today and its media_root unchanged', async () => {
  const ctx = await setup()
  const { code, title } = await seedEpisode(ctx.slug)
  const mediaRoot = path.join(tmp!.dir, 'SSD', 'Media')
  await fs.mkdir(mediaRoot, { recursive: true })
  const projectPath = path.join(ctx.channelDir, 'project.json')
  const meta = await readJson(projectPath)
  meta.media_root = mediaRoot
  await fs.writeFile(projectPath, JSON.stringify(meta))
  const store = await import('../services/external-video-store.js')
  const dir = await store.ensureExternalFinalVideoDir(ctx.slug, code, title)
  assert.ok(dir!.startsWith(path.join(ctx.library, 'Exports', ctx.slug) + path.sep), String(dir))
  await write(path.join(dir!, `${code}_final_video.mp4`), 'v')

  const { applyChannel } = await import('../services/channel-self-contained.js')
  const result = await applyChannel(ctx.slug)
  assert.equal(result.plan_after.exports.channel_local, false)
  assert.equal(result.exports_moved, 0)
  assert.ok(existsSync(path.join(dir!, `${code}_final_video.mp4`)), 'finals stay on the configured location')
  assert.equal((await readJson(projectPath)).media_root, mediaRoot, 'media_root is never rewritten')
})

test('a chosen finished-videos folder keeps working, and channel finals are still found', async () => {
  const ctx = await setup()
  const { code, title } = await seedEpisode(ctx.slug)
  const store = await import('../services/external-video-store.js')
  const channelFinalDir = await store.ensureExternalFinalVideoDir(ctx.slug, code, title)
  await write(path.join(channelFinalDir!, `${code}_final_video.mp4`), 'v')
  const chosen = path.join(tmp!.dir, 'Finished')
  await ctx.lib.setExportsRoot(chosen)
  assert.equal(await store.resolveExternalFinalVideoDir(ctx.slug, code, title), channelFinalDir, 'existing channel final still found')
  const next = await store.ensureExternalFinalVideoDir(ctx.slug, code, title)
  assert.ok(next!.startsWith(path.join(chosen, ctx.slug) + path.sep), 'new renders go to the chosen folder')
})

test('whole-Library plan and apply cover every channel', async () => {
  const ctx = await setup('First Channel')
  await write(path.join(ctx.shared, 'first', 'a.png'), 'a')
  const pm = ctx.pm
  const second = await pm.createProject({ name: 'Second Channel' })
  for (const [slug, ref] of [[ctx.slug, '${ASSET}/first/a.png'], [second.slug, '${ASSET}/first/a.png']] as const) {
    const p = path.join(pm.getProjectDir(slug)!, 'config.json')
    const c = await readJson(p)
    c.timeline_presets = [{ id: 't', data: { title_image: { image_path: ref } } }]
    await fs.writeFile(p, JSON.stringify(c))
  }
  const request = (await import('supertest')).default
  const { app } = await import('../app.js')
  const preview = await request(app).get('/api/library/self-contained')
  assert.equal(preview.status, 200, JSON.stringify(preview.body))
  assert.equal(preview.body.totals.files_to_copy, 2, 'each channel gets its own copy')
  const applied = await request(app).post('/api/library/self-contained')
  assert.equal(applied.status, 200, JSON.stringify(applied.body))
  assert.equal(applied.body.totals_after.refs_to_rewrite, 0)
  for (const slug of [ctx.slug, second.slug]) {
    assert.equal(await fs.readFile(path.join(pm.getProjectDir(slug)!, 'assets', 'first', 'a.png'), 'utf-8'), 'a')
  }
  const one = await request(app).get(`/api/projects/${ctx.slug}/self-contained`)
  assert.equal(one.body.done, true)
})

test('a render expands ${CHANNEL} overlay layers and the compilation plate', async () => {
  const { channelDir, episodesRoot } = await setup()
  const { resolveAssetPathsInPlace } = await import('../generators/video.js')
  const req: any = {
    logo: { image_path: '${CHANNEL}/assets/Logo.png' },
    overlays: { layers: [{ id: 'o', enabled: true, source_path: '${CHANNEL}/overlays/film.mp4' }] },
    background_plate: { source_path: '${CHANNEL}/backgrounds/plate.png' },
  }
  const job: any = { output_lines: [] }
  resolveAssetPathsInPlace(req, episodesRoot, job)
  assert.equal(req.logo.image_path, path.join(channelDir, 'assets', 'Logo.png'))
  assert.equal(req.overlays.layers[0].source_path, path.join(channelDir, 'overlays', 'film.mp4'))
  assert.equal(req.background_plate.source_path, path.join(channelDir, 'backgrounds', 'plate.png'))
  assert.deepEqual(job.output_lines, [])
})
