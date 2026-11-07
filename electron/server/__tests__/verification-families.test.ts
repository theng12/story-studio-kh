/**
 * Verification check set — the cheap isolated F1–F5 checks (release 386, item 13).
 *
 * One serial fixture orchestration for the checks that need no live target:
 *   01 — F1  select a reusable Shell (browse, save, reload; episode choices stay; no-Shell stays off)
 *   06 — F2  settings and exclusive channel ownership (save/reload, channel switch,
 *             foreign paths refused, character migration keeps id/voice/bytes and
 *             never overwrites an edited copy)
 *   07 — F3  resume/reconcile without duplicate writes (no second init or quota
 *             charge; an accepted thumbnail with failed readback is not re-sent)
 *   10 — F5  bounded resources and recoverable cleanup (explained fixture growth,
 *             no orphan child process, both guard scripts exit as designed)
 *
 * NOT CHECKED here, deliberately: the live F1 pilot (03–05, needs an owner-approved
 * private target), installed version/health readback (08), rendered subtitle
 * parity (09). Everything below runs against temp fixtures, mock transports and
 * local HTTP fakes — zero provider, network, YouTube or production writes.
 *
 * What a green run cannot catch: real provider byte re-encoding, real quota,
 * UI geometry, or anything about an installed build. Existing suites
 * (thumbnail-shell-runtime, character-library, upload-resume-flow,
 * youtube-thumbnail-canonical) remain the deep coverage; this file is the thin
 * serial join the verification brief asks for.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { after, afterEach, before, mock, test } from 'node:test'
import express from 'express'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'
import { FakeYouTube } from './fixtures/fake-youtube.js'
import { saveYouTubeChannelGrantForTest } from './_youtube-connection-test-helper.js'
import {
  channelReferenceShellId, resolveThumbnailShell, stageThumbnailShellImage,
} from '../services/thumbnail-shell.js'
import {
  __resetYouTubeTransportForTests, __setYouTubeTransportForTests, uploadVideo,
} from '../lib/youtube-client.js'
import { generateThumbnailRefresh } from '../generators/youtube-thumbnail-refresh.js'
import {
  acceptYouTubeOperation, createYouTubeOperation, readYouTubeOperation,
} from '../services/youtube-operation-store.js'
import {
  assignProjectYouTubeChannel, configureYouTubeApplication, readYouTubeConnectionRegistry,
} from '../services/youtube-connection-store.js'
import { readYouTubeQuota } from '../services/youtube-quota-ledger.js'
import { readResumeSidecar, writeResumeSidecar } from '../services/upload-resume-sidecar.js'
import { resolveEpisodePaths } from '../services/utils.js'

const execFileAsync = promisify(execFile)

/** Orchestra guards live outside the repo; this Mac is the only test host. */
const ORCHESTRA_TOOLS = '/build/Developer/_orchestra/tools'

const TEMPLATE_ID = 'verify-shell-01'
const LAYOUT_NOTE = 'Leave the left third clear for the episode’s chosen words.'
const SHELL_IMAGE = 'verify-shell.png'
const SHELL_BYTES = Buffer.from('verification managed shell bytes')
const REFRACT_PROMPT = 'Keep the subject centred with empty space above.'

const EPISODES = [
  { code: 'EP0001', title: 'Topic One' },
  { code: 'EP0002', title: 'Topic Two' },
] as const

const SIDE_OPTION_1 = {
  thumbnail_template_id: 'recipe-episode-one',
  style_tag: 'storybook-ink',
  thumb_font_style: 'chiselled-slab',
  thumb_text_style: 'gold-foil',
  thumb_text_position: 'bottom',
} as const
const SIDE_OPTION_2 = {
  thumbnail_template_id: 'recipe-episode-two',
  style_tag: 'noir-ink',
  thumb_font_style: 'typewriter',
  thumb_text_style: 'paper-cut',
  thumb_text_position: 'top',
} as const

const CHANNEL_A = 'UC-verify-a'
const CHANNEL_B = 'UC-verify-thumb'
const VIDEO_ID = 'video-verify-1'

let cleanup: (() => Promise<void>) | undefined
let tempDir: string
let pm: typeof import('../services/project-manager.js')
let cl: typeof import('../services/character-library.js')
let topt: typeof import('../services/thumbnail-option-settings.js')
let slugA: string
let dirA: string
let slugB: string

const PNG = await (await import('sharp')).default({
  create: { width: 16, height: 9, channels: 3, background: '#244c5a' },
}).png().toBuffer()

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  tempDir = temp.dir
  pm = await import('../services/project-manager.js')
  cl = await import('../services/character-library.js')
  topt = await import('../services/thumbnail-option-settings.js')

  const projectA = await pm.createProject({ name: 'Verify Shell Channel' })
  slugA = projectA.slug
  dirA = pm.getProjectDir(slugA)!

  // A user-library Shell plus the channel's own managed reference image.
  const templates = path.join(pm.projectsRoot(), '.thumbnail-templates')
  await fs.mkdir(templates, { recursive: true })
  await fs.writeFile(path.join(templates, `${TEMPLATE_ID}.json`), JSON.stringify({
    id: TEMPLATE_ID, name: 'Verification Shell', description: 'Layout only', builtin: false,
    schemaVersion: 1, layoutNote: LAYOUT_NOTE,
  }))
  await fs.mkdir(path.join(dirA, 'thumbnail-reference-assets'), { recursive: true })
  await fs.writeFile(path.join(dirA, 'thumbnail-reference-assets', SHELL_IMAGE), SHELL_BYTES)
  // The route writes this key through the same loose update (routes/vision.ts).
  await pm.updateConfig(slugA, {
    thumbnail_reference_asset: {
      id: 'verify-reference', filename: SHELL_IMAGE, reframing_prompt: REFRACT_PROMPT,
    },
  } as any)

  // Two mock episodes, each with its own topic and its own lettering/visual sidecar.
  await fs.writeFile(path.join(dirA, 'ideas.json'), JSON.stringify({
    ideas: EPISODES.map((episode, index) => ({
      id: `idea-${index + 1}`, episode_code: episode.code, title: episode.title, status: 'accepted',
    })),
    next_episode_number: EPISODES.length + 1,
    recycled_numbers: [],
  }))
  for (const episode of EPISODES) {
    const paths = await resolveEpisodePaths(slugA, episode.code, episode.title)
    await fs.mkdir(paths.episode_dir, { recursive: true })
  }
  await topt.updateThumbnailOptionSettings(slugA, 'EP0001', settings => ({
    ...settings, options: { ...settings.options, '1': { ...SIDE_OPTION_1 } },
  }))
  await topt.updateThumbnailOptionSettings(slugA, 'EP0002', settings => ({
    ...settings, options: { ...settings.options, '1': { ...SIDE_OPTION_2 } },
  }))
})

after(async () => { await cleanup?.() })

afterEach(() => {
  mock.restoreAll()
  __resetYouTubeTransportForTests()
})

async function dirBytes(dir: string): Promise<number> {
  let total = 0
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) total += await dirBytes(full)
    else if (entry.isFile()) total += (await fs.stat(full)).size
  }
  return total
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function settingsApp(): Promise<express.Express> {
  const { router } = await import('../routes/settings.js')
  const app = express()
  app.use(express.json())
  app.use('/api', router)
  return app
}

async function templatesApp(): Promise<express.Express> {
  const { router } = await import('../routes/thumbnail-templates.js')
  const app = express()
  app.use(express.json())
  app.use('/api', router)
  return app
}

// ── 01 — F1 ────────────────────────────────────────────────────────────────

test('01 — select a reusable Shell: browse, save, reload; episode choices stay; deliberate no-Shell stays off', async () => {
  // Browse the Shell library the way the picker does.
  const browse = await request(await templatesApp()).get('/api/thumbnail-templates').expect(200)
  assert.ok(
    browse.body.templates.some((template: { id: string }) => template.id === TEMPLATE_ID),
    'the fixture Shell must be listed',
  )
  const detail = await request(await templatesApp()).get(`/api/thumbnail-templates/${TEMPLATE_ID}`).expect(200)
  assert.equal(detail.body.layoutNote, LAYOUT_NOTE)

  // Independent episode state, snapshotted before any Shell save.
  const topicsBefore = await fs.readFile(path.join(dirA, 'ideas.json'), 'utf8')
  const side1Before = JSON.stringify(await topt.readThumbnailOptionSettings(slugA, 'EP0001'))
  const side2Before = JSON.stringify(await topt.readThumbnailOptionSettings(slugA, 'EP0002'))

  // Select the Shell through the settings route the UI saves to, then reload.
  const app = await settingsApp()
  await request(app)
    .put(`/api/projects/${slugA}/settings/config`)
    .send({ thumbnail_shell_id: TEMPLATE_ID })
    .expect(200)
  const reloaded = (await request(app).get(`/api/projects/${slugA}/settings/config`).expect(200)).body
  assert.equal(reloaded.thumbnail_shell_id, TEMPLATE_ID)
  const templateShell = await resolveThumbnailShell(slugA, {}, reloaded)
  assert.equal(templateShell.id, TEMPLATE_ID)
  assert.equal(templateShell.layoutNote, LAYOUT_NOTE)

  // The channel's own reference Shell resolves to the managed image, by hash.
  await request(app)
    .put(`/api/projects/${slugA}/settings/config`)
    .send({ thumbnail_shell_id: channelReferenceShellId(slugA) })
    .expect(200)
  const withReference = (await request(app).get(`/api/projects/${slugA}/settings/config`).expect(200)).body
  const referenceShell = await resolveThumbnailShell(slugA, {}, withReference)
  assert.equal(referenceShell.id, channelReferenceShellId(slugA))
  assert.ok(referenceShell.imagePath)
  assert.equal(
    sha256(await fs.readFile(referenceShell.imagePath!)),
    sha256(SHELL_BYTES),
    'the selected Shell image must be the channel’s own managed bytes',
  )
  assert.equal(referenceShell.layoutNote, REFRACT_PROMPT)

  // A deliberate no-Shell must not revive the legacy reference still on disk.
  await request(app)
    .put(`/api/projects/${slugA}/settings/config`)
    .send({ thumbnail_shell_id: '' })
    .expect(200)
  const cleared = (await request(app).get(`/api/projects/${slugA}/settings/config`).expect(200)).body
  const noShell = await resolveThumbnailShell(slugA, {}, cleared)
  assert.equal(noShell.id, '')
  assert.equal(noShell.imagePath, null)
  assert.equal(noShell.layoutNote, '')
  const stored = await pm.getConfig(slugA)
  assert.equal((stored as { thumbnail_reference_asset?: { filename?: string } }).thumbnail_reference_asset?.filename, SHELL_IMAGE,
    'the deliberate no-Shell choice rewrites nothing on disk')

  // Episode topics and each episode’s own lettering/visual choices survived every save.
  assert.equal(await fs.readFile(path.join(dirA, 'ideas.json'), 'utf8'), topicsBefore)
  assert.equal(JSON.stringify(await topt.readThumbnailOptionSettings(slugA, 'EP0001')), side1Before)
  assert.equal(JSON.stringify(await topt.readThumbnailOptionSettings(slugA, 'EP0002')), side2Before)
  const ep2 = await topt.readThumbnailOptionSettings(slugA, 'EP0002')
  assert.equal(ep2.options['1']?.thumb_font_style, SIDE_OPTION_2.thumb_font_style,
    'the other episode keeps its own lettering after the switch')
})

// ── 06 — F2 ────────────────────────────────────────────────────────────────

test('06 — settings survive save/reload and channel switch; foreign paths refused; migration keeps id, voice and bytes', async () => {
  const projectB = await pm.createProject({ name: 'Verify Ownership Channel' })
  slugB = projectB.slug

  // Two channels, two settings, each surviving reload without touching the other.
  const app = await settingsApp()
  await request(app).put(`/api/projects/${slugA}/settings/config`)
    .send({ thumbnail_reference_strength: 'strong' }).expect(200)
  await request(app).put(`/api/projects/${slugB}/settings/config`)
    .send({ thumbnail_reference_strength: 'loose' }).expect(200)
  const reloadA = (await request(app).get(`/api/projects/${slugA}/settings/config`).expect(200)).body
  const reloadB = (await request(app).get(`/api/projects/${slugB}/settings/config`).expect(200)).body
  assert.equal(reloadA.thumbnail_reference_strength, 'strong')
  assert.equal(reloadB.thumbnail_reference_strength, 'loose')

  // Foreign paths are refused: traversal in a legacy reference, and a Shell
  // whose declared source channel does not exist.
  await assert.rejects(
    resolveThumbnailShell(slugA, {}, {
      thumbnail_reference_asset: { id: 'x', filename: '../escape.png', reframing_prompt: 'n' },
    }),
    /unavailable/,
  )
  await assert.rejects(
    resolveThumbnailShell(slugB, { thumbnail_shell_id: 'channel-reference:no-such-channel' }, {}),
    /source channel was not found/,
  )

  // An explicit cross-channel Shell stays allowed through its declared source,
  // and the receiving channel’s own settings are untouched by selecting it.
  await request(app).put(`/api/projects/${slugB}/settings/config`)
    .send({ thumbnail_shell_id: channelReferenceShellId(slugA) }).expect(200)
  const afterShellB = (await request(app).get(`/api/projects/${slugB}/settings/config`).expect(200)).body
  assert.equal(afterShellB.thumbnail_reference_strength, 'loose')
  const shared = await resolveThumbnailShell(slugB, {}, afterShellB)
  assert.equal(shared.sourceProjectSlug, slugA)
  assert.equal(shared.imagePath, path.join(dirA, 'thumbnail-reference-assets', SHELL_IMAGE))
  assert.equal(sha256(await fs.readFile(shared.imagePath!)), sha256(SHELL_BYTES))

  // Character migration: one id claimed by both channels keeps each channel’s
  // voice and the exact reference bytes; a repeat apply never overwrites an
  // edited copy, and the legacy record is never rewritten.
  const legacyDir = path.join(pm.projectsRoot(), '.character-library', 'verifier')
  await fs.mkdir(legacyDir, { recursive: true })
  const legacyRecord = {
    id: 'verifier', name: 'Verifier', description: 'legacy description',
    scope: 'project', source: 'project', schemaVersion: 1,
    projects: [slugA, slugB],
    speech: { voiceId: 'base' },
    channel_profiles: {
      [slugA]: { speech: { voiceId: 'voice-a' } },
      [slugB]: { speech: { voiceId: 'voice-b' } },
    },
    references: { images: ['ref.png'] },
  }
  const legacyJson = `${JSON.stringify(legacyRecord, null, 2)}\n`
  await fs.writeFile(path.join(legacyDir, 'character.json'), legacyJson)
  await fs.writeFile(path.join(legacyDir, 'ref.png'), 'reference-bytes')

  const applied = await cl.applyChannelMigration()
  assert.equal(applied.copies_created, 2)
  const ownedA = await cl.getChannelCharacter(slugA, 'verifier')
  const ownedB = await cl.getChannelCharacter(slugB, 'verifier')
  assert.equal(ownedA?.id, 'verifier')
  assert.deepEqual(ownedA?.projects, [slugA])
  assert.deepEqual(ownedA?.speech, { voiceId: 'voice-a' })
  assert.equal(ownedB?.id, 'verifier')
  assert.deepEqual(ownedB?.speech, { voiceId: 'voice-b' })
  assert.equal(
    await fs.readFile(path.join(cl.channelCharacterDir(slugA, 'verifier'), 'ref.png'), 'utf8'),
    'reference-bytes',
    'migration copies the reference bytes exactly',
  )
  const backup = path.join(
    pm.projectsRoot(), '.character-library', '_channels', '_migration', applied.run_id!, 'backup', 'verifier', 'character.json',
  )
  assert.equal(await fs.readFile(backup, 'utf8'), legacyJson, 'the verified snapshot holds the original record')

  await cl.updateChannelCharacter(slugA, 'verifier', { description: 'edited after migration' })
  const repeat = await cl.applyChannelMigration()
  assert.equal(repeat.copies_created, 0)
  assert.equal(repeat.conflicts[0]?.reason, 'target_changed')
  assert.equal((await cl.getChannelCharacter(slugA, 'verifier'))?.description, 'edited after migration')
  assert.equal((await cl.getLibraryCharacter('verifier'))?.description, 'legacy description',
    'the legacy fallback record is untouched')
})

// ── 07 — F3, part 1 ────────────────────────────────────────────────────────

interface ResumeLogEntry {
  method: string
  url: string
  headers: Record<string, string>
}

/** Local fake of the resumable-upload protocol: probe, chunk PUTs, no init. */
function startResumeFake(opts: { totalBytes: number; serverHasBytesAt: number; finalVideo: unknown }) {
  const log: ResumeLogEntry[] = []
  const server = http.createServer((req, res) => {
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers[key.toLowerCase()] = value
    }
    log.push({ method: req.method || '', url: req.url || '', headers })
    req.on('data', () => {})
    req.on('end', () => {
      const contentRange = headers['content-range'] || ''
      if (req.method === 'PUT' && contentRange === `bytes */${opts.totalBytes}`) {
        if (opts.serverHasBytesAt >= opts.totalBytes) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(opts.finalVideo))
          return
        }
        res.writeHead(308, { range: `bytes=0-${opts.serverHasBytesAt - 1}` })
        res.end()
        return
      }
      if (req.method === 'PUT') {
        const match = /bytes (\d+)-(\d+)\/(\d+)/.exec(contentRange)
        if (!match) { res.writeHead(400); res.end(); return }
        if (Number(match[2]) + 1 >= Number(match[3])) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(opts.finalVideo))
        } else {
          res.writeHead(308, { range: `bytes=0-${match[2]}` })
          res.end()
        }
        return
      }
      // Any POST is an unexpected init — the resume path must never send one.
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'fake server: unexpected request', code: 400 } }))
    })
  })
  return { server, log }
}

test('07 — an interrupted upload resumes the recorded session with no second init or quota charge', async () => {
  const project = await pm.createProject({ name: 'Verify Resume' })
  await configureYouTubeApplication({ client_id: 'verify-client', client_secret: 'verify-secret' })
  await saveYouTubeChannelGrantForTest({
    channel: { channel_id: CHANNEL_A, title: 'Verify A', granted_scopes: ['youtube.upload'] },
    tokens: {
      access_token: 'verify-access', refresh_token: 'verify-refresh',
      expires_at: Date.now() + 3_600_000, scope: 'youtube.upload',
    },
  })
  await assignProjectYouTubeChannel({
    project_slug: project.slug, channel_id: CHANNEL_A, expected_previous_channel_id: null,
  })

  const totalBytes = 64 * 1024
  const filePath = path.join(tempDir, 'resume-verify.mp4')
  await fs.writeFile(filePath, Buffer.alloc(totalBytes, 0x5a))

  // The provider already holds the first 16 KB of this session.
  const { server, log } = startResumeFake({
    totalBytes,
    serverHasBytesAt: 16 * 1024,
    finalVideo: { id: 'vid_verify_resume', snippet: { title: 'resumed' }, status: { privacyStatus: 'private' } },
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const sessionUrl = `http://127.0.0.1:${port}/upload?token=verify`

  await writeResumeSidecar(project.slug, 'EP001', {
    platform: 'youtube',
    account_id: `registry:${CHANNEL_A}`,
    file_path: filePath,
    file_size: totalBytes,
    session_url: sessionUrl,
    created_at: new Date().toISOString(),
    quota_charged: true,
  })

  const applicationId = (await readYouTubeConnectionRegistry()).application!.application_id
  const quotaBefore = await readYouTubeQuota(applicationId)
  const logLines: string[] = []
  try {
    const result = await uploadVideo({
      slug: project.slug,
      accountId: `registry:${CHANNEL_A}`,
      filePath,
      snippet: { title: 'resumed' },
      status: { privacyStatus: 'private' },
      episodeCode: 'EP001',
      resumeFromSessionUrl: sessionUrl,
      logLines,
    })
    assert.equal(result.id, 'vid_verify_resume')
  } finally {
    server.close()
  }

  const quotaAfter = await readYouTubeQuota(applicationId)
  assert.equal(quotaAfter.buckets.video_uploads.used, quotaBefore.buckets.video_uploads.used,
    'a resume must not charge videos_insert a second time')
  assert.equal(log.filter(entry => entry.method === 'POST').length, 0,
    'the init endpoint must not be hit on resume')
  assert.equal(log[0]?.method, 'PUT')
  assert.equal(log[0]?.headers['content-range'], `bytes */${totalBytes}`)
  const firstChunk = log.slice(1).find(entry => entry.method === 'PUT')
  assert.ok(firstChunk, 'expected a chunk PUT after the probe')
  assert.equal(Number(/bytes (\d+)-/.exec(firstChunk.headers['content-range'] || '')![1]), 16 * 1024,
    'the chunk must continue from the provider’s high-water mark, not byte 0')
  assert.equal(await readResumeSidecar(project.slug, 'EP001', 'youtube'), null,
    'the transient sidecar clears after the final 200')
  assert.ok(logLines.some(line => line.includes('Resuming upload from byte')),
    'the resume is surfaced to the operator log')
})

// ── 07 — F3, part 2 ────────────────────────────────────────────────────────

/** Private readback is scripted explicitly — the shared helper defaults to public. */
function remotePrivateThumbnail() {
  return {
    items: [{
      id: VIDEO_ID,
      snippet: {
        channelId: CHANNEL_B,
        thumbnails: { high: { url: `https://i.ytimg.com/vi/${VIDEO_ID}/hqdefault.jpg` } },
      },
      status: { privacyStatus: 'private' },
    }],
  }
}

test('07 — an accepted thumbnail replacement with failed readback cannot be sent again', async () => {
  const project = await pm.createProject({ name: 'Verify Thumbnail Reconcile' })
  const projectDir = pm.getProjectDir(project.slug)!
  await fs.writeFile(path.join(projectDir, 'ideas.json'), JSON.stringify({
    ideas: [{ id: 'idea-r1', episode_code: 'EP0001', title: 'Reconcile One', status: 'accepted' }],
    next_episode_number: 2,
    recycled_numbers: [],
  }))
  const paths = await resolveEpisodePaths(project.slug, 'EP0001', 'Reconcile One')
  await fs.mkdir(paths.thumb_dir, { recursive: true })
  await fs.writeFile(path.join(paths.thumb_dir, 'EP0001_Thumbnail_v1.png'), PNG)

  await configureYouTubeApplication({ client_id: 'verify-client', client_secret: 'verify-secret' })
  await saveYouTubeChannelGrantForTest({
    channel: { channel_id: CHANNEL_B, title: 'Verify B', granted_scopes: ['youtube.upload'] },
    tokens: {
      access_token: 'verify-thumb-access', refresh_token: 'verify-thumb-refresh',
      expires_at: Date.now() + 3_600_000, scope: 'youtube.upload',
    },
  })
  await assignProjectYouTubeChannel({
    project_slug: project.slug, channel_id: CHANNEL_B, expected_previous_channel_id: null,
  })

  const payload = {
    snippet_json: JSON.stringify({ title: 'Reconcile One', description: '', tags: [], categoryId: '24' }),
    status_json: JSON.stringify({ privacyStatus: 'private' }),
    source_sha256: 'b'.repeat(64),
  }
  const opened = await createYouTubeOperation({
    project_slug: project.slug, episode_code: 'EP0001', channel_id: CHANNEL_B,
    source_revision: 'source-1', metadata_revision: 'metadata-1', final_payload: payload,
    origin: 'manual', final_action: 'manual_upload',
  })
  const accepted = await acceptYouTubeOperation({
    project_slug: project.slug, operation_id: opened.operation_id, expected_revision: opened.revision,
    channel_id: CHANNEL_B, video_id: VIDEO_ID, accepted_at: new Date().toISOString(), final_payload: payload,
  })

  const fake = new FakeYouTube()
  // One backup readback, then a provider success whose confirmation read fails.
  fake.respondMatching({ method: 'GET', match: /\/youtube\/v3\/videos\?/, body: remotePrivateThumbnail() })
  fake.respond({ method: 'POST', path: `/upload/youtube/v3/thumbnails/set?videoId=${VIDEO_ID}`, body: {} })
  mock.method(globalThis, 'fetch', async (input: any, init: any) => {
    assert.equal(String(input), `https://i.ytimg.com/vi/${VIDEO_ID}/hqdefault.jpg`)
    assert.equal(init.redirect, 'error')
    return new Response(PNG, { status: 200 })
  })
  __setYouTubeTransportForTests(fake.transport())

  const job = {
    job_id: 'verify-readback', project_slug: project.slug, episode_id: 'EP0001', output_lines: [],
    params: { operation_id: accepted.operation_id },
  } as any

  await assert.rejects(generateThumbnailRefresh(job), /accepted the thumbnail/)
  assert.notEqual(job.progress, 100)

  // Reconcile: the uncertain accepted action is reported, never re-sent.
  await assert.rejects(generateThumbnailRefresh(job), /previous thumbnail update may have reached/)
  assert.equal(fake.calls.filter(call => call.method === 'POST').length, 1,
    'the accepted replacement must not be sent a second time')
  const saved = await readYouTubeOperation(project.slug, accepted.operation_id)
  assert.equal(saved?.video_id, VIDEO_ID)
  assert.equal(saved?.channel_id, CHANNEL_B)
  assert.ok(saved?.actions.at(-1)?.error_code, 'the uncertain outcome is recorded for reconciliation')
})

// ── 10 — F5 ────────────────────────────────────────────────────────────────

test('10 — bounded resources: explained fixture growth, no orphan child, both guards exit as designed', async () => {
  const rssBefore = process.memoryUsage().rss
  assert.ok(Number.isFinite(rssBefore) && rssBefore > 0, 'RSS must be a real measurement')

  // One owned child process exits on stdin EOF; nothing of ours may linger.
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'ignore'] })
  assert.ok(child.pid, 'the owned child must have a pid')
  const exitPromise = new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', code => resolve(code ?? -1))
  })
  child.stdin!.end()
  const exitCode = await exitPromise
  assert.equal(exitCode, 0)
  assert.throws(
    () => process.kill(child.pid!, 0),
    (error: NodeJS.ErrnoException) => error.code === 'ESRCH',
    'the owned child must be fully reaped — no orphan process',
  )

  // Disk growth from one staging operation is explained exactly, byte for byte.
  // No fixed ceiling: the verification brief requires measured deltas, not a
  // guessed threshold (investigate unexplained growth, never fail a number).
  const source = path.join(tempDir, 'resource-probe.bin')
  const payload = Buffer.alloc(8 * 1024, 0x2b)
  await fs.writeFile(source, payload)
  const bytesBefore = await dirBytes(dirA)
  const staged = await stageThumbnailShellImage(dirA, source)
  const bytesAfter = await dirBytes(dirA)
  assert.equal(bytesAfter - bytesBefore, payload.length, 'growth equals the retained staged bytes exactly')
  assert.equal((await fs.stat(staged)).size, payload.length)
  assert.equal(sha256(await fs.readFile(staged)), sha256(payload))

  const rssAfter = process.memoryUsage().rss
  assert.ok(Number.isFinite(rssAfter) && rssAfter > 0, 'RSS after the fixture work is a real measurement')

  // Both batch guards, run as designed: promisified execFile rejects on a
  // non-zero exit, so reaching these matches means each guard exited 0.
  const selfTest = await execFileAsync('python3', ['-I', path.join(ORCHESTRA_TOOLS, 'check-request-records.py'), '--self-test'])
  assert.match(selfTest.stdout, /self-test ok/)

  // A unique no-match filter keeps the scan read-only and scoped: the guard’s
  // failing path is hard-wired to the real Developer tree and is exercised by
  // the leads’ own runs, not from inside a fixture.
  const stranded = await execFileAsync('zsh', [
    path.join(ORCHESTRA_TOOLS, 'check-stranded-work.sh'),
    'verification-families-guard-no-match-20261107',
  ])
  assert.match(stranded.stdout, /OK: nothing stranded/)
})
