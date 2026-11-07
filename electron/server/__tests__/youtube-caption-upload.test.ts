/**
 * Unit tests for optional integrated YouTube captions upload.
 *
 * Verifies:
 * - OFF by default (enabled: false)
 * - Pure normalization & defaults
 * - Subtitle file discovery hierarchy + EPISODE OWNERSHIP (realpath inside the
 *   episode's own folder, canonical name starting with the episode code —
 *   shared folders and symlinks can never select another episode's track)
 * - Deduplication guard (skip_if_exists vs replace_existing), including the
 *   refusal to guess when the existing tracks could not be listed, and the
 *   refusal to overwrite an ambiguous same-language track
 * - OAuth grant scope checked BEFORE any captions network call
 * - Quota: published captions costs in QUOTA_COST, charged through the
 *   Cloud-project ledger like every other endpoint
 * - Honest failure: never throws, preserves remote video ID intact
 * - Integration with the REAL client seams: registry credentials +
 *   `__setYouTubeTransportForTests` (no bespoke transport injection).
 */

import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'

import { useTempDataDir } from './_helpers.js'
import { saveYouTubeChannelGrantForTest } from './_youtube-connection-test-helper.js'
import {
  __resetYouTubeTransportForTests,
  __setYouTubeTransportForTests,
  registryCredentialFor,
} from '../lib/youtube-client.js'
import {
  DEFAULT_YOUTUBE_CAPTION_SETTINGS,
  buildCaptionUploadCheckpoint,
  normalizeCaptionUploadSettings,
  type ResolvedCaptionTrack,
} from '../contracts/youtube-caption-upload.js'
import { QUOTA_COST } from '../services/upload-quota.js'
import {
  executeOptionalCaptionUpload,
  findEpisodeSubtitleTrack,
} from '../services/youtube-caption-upload.js'

const CHANNEL = 'UC-captions-test'
const FORCE_SSL_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl'

let cleanup: (() => Promise<void>) | undefined
/** Temp episode folders created by realTrack(); removed after every test. */
const trackDirs: string[] = []
afterEach(async () => {
  __resetYouTubeTransportForTests()
  for (const dir of trackDirs.splice(0)) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
  await cleanup?.()
  cleanup = undefined
})

/** A connected project + channel grant, on the real credential path. */
async function connectedAccount(options: { scopes?: string[] } = {}): Promise<{ slug: string; accountId: string }> {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  const pm = await import('../services/project-manager.js')
  const connections = await import('../services/youtube-connection-store.js')
  const project = await pm.createProject({ name: 'Captions Fixture' })
  await connections.configureYouTubeApplication({ client_id: 'cap-client', client_secret: 'cap-secret' })
  await saveYouTubeChannelGrantForTest({
    channel: {
      channel_id: CHANNEL,
      title: 'Captions Channel',
      granted_scopes: options.scopes ?? ['youtube.upload', FORCE_SSL_SCOPE],
    },
    tokens: { access_token: 'cap-access', refresh_token: 'cap-refresh', expires_at: Date.now() + 3_600_000 },
  })
  await connections.assignProjectYouTubeChannel({
    project_slug: project.slug,
    channel_id: CHANNEL,
    expected_previous_channel_id: null,
  })
  return { slug: project.slug, accountId: registryCredentialFor(CHANNEL) }
}

const CAPTIONS_LIST = /^\/youtube\/v3\/captions\?/
const CAPTIONS_UPLOAD = /^\/upload\/youtube\/v3\/captions\?/

/** A minimal transport answering captions endpoints with queued responses. */
function captionTransport(responses: Array<{ match: RegExp; status: number; body: unknown; onCall?: (init?: RequestInit) => void }>): typeof fetch {
  return (async (input: any, init?: RequestInit) => {
    const url = new URL(String(input))
    const target = `${url.pathname}${url.search}`
    const hit = responses.find(r => r.match.test(target))
    if (!hit) throw new Error(`Unexpected request: ${target}`)
    hit.onCall?.(init)
    return new Response(JSON.stringify(hit.body), {
      status: hit.status,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
}

const SRT_CONTENT = [
  '1',
  '00:00:01,000 --> 00:00:04,000',
  'First line of caption',
  '',
  '2',
  '00:00:05,000 --> 00:00:08,000',
  'Second line of caption',
  '',
].join('\n')

/**
 * A REAL subtitle file on disk owned by `code` (in its own temp folder), plus
 * the track resolved from it — so trackOverride goes through the same episode
 * ownership check a discovered file does.
 */
async function realTrack(
  code: string,
  overrides: Partial<ResolvedCaptionTrack> = {},
): Promise<{ track: ResolvedCaptionTrack; dir: string }> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'story-caption-ep-'))
  trackDirs.push(dir)
  await fsp.writeFile(path.join(dir, `${code}_stitched.srt`), SRT_CONTENT, 'utf-8')
  const track = await findEpisodeSubtitleTrack({ episodeCode: code, subtitlesDir: dir })
  if (!track) throw new Error(`fixture subtitle track for ${code} could not be resolved`)
  return { track: { ...track, ...overrides }, dir }
}

test('contracts: normalizeCaptionUploadSettings enforces OFF by default and safe defaults', () => {
  const def = normalizeCaptionUploadSettings(undefined)
  assert.equal(def.enabled, false)
  assert.equal(def.language, 'en')
  assert.equal(def.track_name, 'English')
  assert.equal(def.is_draft, false)
  assert.equal(def.dedupe_mode, 'skip_if_exists')
  assert.equal(def.preferred_source, 'auto')

  assert.deepEqual(DEFAULT_YOUTUBE_CAPTION_SETTINGS, {
    enabled: false,
    language: 'en',
    track_name: 'English',
    is_draft: false,
    dedupe_mode: 'skip_if_exists',
    preferred_source: 'auto',
  })

  const km = normalizeCaptionUploadSettings({ enabled: true, language: 'km' })
  assert.equal(km.enabled, true)
  assert.equal(km.language, 'km')
  assert.equal(km.track_name, 'Khmer')

  const custom = normalizeCaptionUploadSettings({
    enabled: true,
    language: 'en',
    track_name: 'English (Full)',
    dedupe_mode: 'replace_existing',
    preferred_source: 'stitched',
    is_draft: true,
  })
  assert.equal(custom.track_name, 'English (Full)')
  assert.equal(custom.dedupe_mode, 'replace_existing')
  assert.equal(custom.preferred_source, 'stitched')
  assert.equal(custom.is_draft, true)
})

test('contracts: buildCaptionUploadCheckpoint captures honest outcome and timestamps', () => {
  const uploaded = buildCaptionUploadCheckpoint(
    {
      status: 'uploaded',
      remote_video_id: 'vid123',
      caption_id: 'cap_999',
      language: 'en',
      track_name: 'English',
      source_file: '/tmp/ep_stitched.srt',
      details: { sha256: 'abc123hash' },
    },
    { ...DEFAULT_YOUTUBE_CAPTION_SETTINGS, enabled: true },
  )

  assert.equal(uploaded.enabled, true)
  assert.equal(uploaded.status, 'uploaded')
  assert.equal(uploaded.caption_id, 'cap_999')
  assert.equal(uploaded.language, 'en')
  assert.equal(uploaded.source_sha256, 'abc123hash')
  assert.ok(uploaded.uploaded_at)

  const failed = buildCaptionUploadCheckpoint(
    {
      status: 'failed',
      remote_video_id: 'vid123',
      error: 'Daily quota exceeded',
    },
    { ...DEFAULT_YOUTUBE_CAPTION_SETTINGS, enabled: true },
  )
  assert.equal(failed.status, 'failed')
  assert.equal(failed.error, 'Daily quota exceeded')
  assert.equal(failed.uploaded_at, undefined)
})

test('services: findEpisodeSubtitleTrack resolves stitched > whisper in auto mode', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'story-caption-test-'))
  try {
    await fsp.writeFile(path.join(tmpDir, 'EP0001_whisper.srt'), SRT_CONTENT, 'utf-8')
    await fsp.writeFile(path.join(tmpDir, 'EP0001_stitched.srt'), SRT_CONTENT, 'utf-8')

    const foundAuto = await findEpisodeSubtitleTrack({
      episodeCode: 'EP0001',
      subtitlesDir: tmpDir,
      settings: { preferred_source: 'auto' },
    })
    assert.ok(foundAuto)
    assert.match(foundAuto.file_path, /EP0001_stitched\.srt$/)
    assert.equal(foundAuto.cues_count, 2)
    assert.ok(foundAuto.sha256)

    const foundWhisper = await findEpisodeSubtitleTrack({
      episodeCode: 'EP0001',
      subtitlesDir: tmpDir,
      settings: { preferred_source: 'whisper' },
    })
    assert.ok(foundWhisper)
    assert.match(foundWhisper.file_path, /EP0001_whisper\.srt$/)
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
})

test('services: executeOptionalCaptionUpload skips when disabled (OFF by default)', async () => {
  const logLines: string[] = []
  const outcome = await executeOptionalCaptionUpload({
    slug: 'no-project-needed',
    accountId: 'unused',
    videoId: 'v_remote_1',
    episodeCode: 'EP0001',
    settings: { enabled: false },
    logLines,
  })

  assert.equal(outcome.status, 'skipped_disabled')
  assert.equal(outcome.remote_video_id, 'v_remote_1')
  assert.match(logLines.join(' '), /disabled/i)
})

test('services: executeOptionalCaptionUpload skips when no subtitle file is found', async () => {
  const logLines: string[] = []
  const emptyDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'story-caption-empty-'))
  try {
    const outcome = await executeOptionalCaptionUpload({
      slug: 'no-project-needed',
      accountId: 'unused',
      videoId: 'v_remote_2',
      episodeCode: 'EP9999',
      subtitlesDir: emptyDir,
      settings: { enabled: true },
      logLines,
    })

    assert.equal(outcome.status, 'skipped_no_subtitles')
    assert.equal(outcome.remote_video_id, 'v_remote_2')
    assert.ok(outcome.warning)
  } finally {
    await fsp.rm(emptyDir, { recursive: true, force: true }).catch(() => {})
  }
})

test('services: dedupe guard skips when language already exists and mode is skip_if_exists', async () => {
  const { slug, accountId } = await connectedAccount()
  const logLines: string[] = []
  __setYouTubeTransportForTests(captionTransport([
    {
      match: CAPTIONS_LIST,
      status: 200,
      body: {
        items: [{
          id: 'existing_cap_123',
          snippet: { videoId: 'v_remote_3', language: 'en', name: 'English', isDraft: false },
        }],
      },
    },
  ]))

  const { track, dir } = await realTrack('EP0001')
  const outcome = await executeOptionalCaptionUpload({
    slug,
    accountId,
    videoId: 'v_remote_3',
    episodeCode: 'EP0001',
    subtitlesDir: dir,
    settings: { enabled: true, language: 'en', dedupe_mode: 'skip_if_exists' },
    trackOverride: track,
    logLines,
  })

  assert.equal(outcome.status, 'skipped_already_exists')
  assert.equal(outcome.remote_video_id, 'v_remote_3')
  assert.equal(outcome.caption_id, 'existing_cap_123')
  assert.match(logLines.join(' '), /already exists/i)
})

test('services: inserts new caption track when none exists', async () => {
  const { slug, accountId } = await connectedAccount()
  const logLines: string[] = []
  let uploadedBody = ''
  __setYouTubeTransportForTests(captionTransport([
    { match: CAPTIONS_LIST, status: 200, body: { items: [] } },
    {
      match: CAPTIONS_UPLOAD,
      status: 200,
      body: { id: 'new_cap_456', snippet: { videoId: 'v_remote_4', language: 'km', name: 'Khmer' } },
      onCall: (init) => { uploadedBody = String(init?.body || '') },
    },
  ]))

  const { track, dir } = await realTrack('EP0002', { language: 'km', track_name: 'Khmer' })
  const outcome = await executeOptionalCaptionUpload({
    slug,
    accountId,
    videoId: 'v_remote_4',
    episodeCode: 'EP0002',
    subtitlesDir: dir,
    settings: { enabled: true, language: 'km', track_name: 'Khmer' },
    trackOverride: track,
    logLines,
  })

  assert.equal(outcome.status, 'uploaded')
  assert.equal(outcome.remote_video_id, 'v_remote_4')
  assert.equal(outcome.caption_id, 'new_cap_456')
  assert.equal(outcome.language, 'km')
  assert.match(logLines.join(' '), /Closed captions uploaded ✓/)
  assert.ok(uploadedBody.includes(SRT_CONTENT.split('\n')[2]!))
})

test('services: updates existing caption track when dedupe_mode is replace_existing', async () => {
  const { slug, accountId } = await connectedAccount()
  const logLines: string[] = []
  let methodUsed = ''
  __setYouTubeTransportForTests(captionTransport([
    {
      match: CAPTIONS_LIST,
      status: 200,
      body: {
        items: [{ id: 'cap_to_replace', snippet: { videoId: 'v_remote_5', language: 'en', name: 'English' } }],
      },
    },
    {
      match: CAPTIONS_UPLOAD,
      status: 200,
      body: { id: 'cap_to_replace', snippet: { videoId: 'v_remote_5', language: 'en', name: 'English' } },
      onCall: (init) => { methodUsed = init?.method || '' },
    },
  ]))

  const { track, dir } = await realTrack('EP0003')
  const outcome = await executeOptionalCaptionUpload({
    slug,
    accountId,
    videoId: 'v_remote_5',
    episodeCode: 'EP0003',
    subtitlesDir: dir,
    settings: { enabled: true, language: 'en', dedupe_mode: 'replace_existing' },
    trackOverride: track,
    logLines,
  })

  assert.equal(outcome.status, 'updated')
  assert.equal(outcome.caption_id, 'cap_to_replace')
  assert.equal(methodUsed, 'PUT')
  assert.match(logLines.join(' '), /Closed captions updated ✓/)
})

test('services: honest failure returns failed status, preserves video ID, and never throws', async () => {
  const { slug, accountId } = await connectedAccount()
  const logLines: string[] = []
  __setYouTubeTransportForTests(captionTransport([
    { match: CAPTIONS_LIST, status: 200, body: { items: [] } },
    {
      match: CAPTIONS_UPLOAD,
      status: 403,
      body: {
        error: {
          errors: [{ reason: 'quotaExceeded', message: 'Quota exceeded' }],
          code: 403,
          message: 'The request cannot be completed because quota is exhausted.',
        },
      },
    },
  ]))

  const { track, dir } = await realTrack('EP0004')
  const outcome = await executeOptionalCaptionUpload({
    slug,
    accountId,
    videoId: 'v_remote_6',
    episodeCode: 'EP0004',
    subtitlesDir: dir,
    settings: { enabled: true, language: 'en' },
    trackOverride: track,
    logLines,
  })

  // Invariants:
  // 1. Never throws
  // 2. Returns status: 'failed'
  // 3. Preserves exact remote_video_id
  // 4. Captures YouTube's own quota wording via the shared translator
  // 5. Does not block or corrupt the video upload
  assert.equal(outcome.status, 'failed')
  assert.equal(outcome.remote_video_id, 'v_remote_6')
  assert.ok(outcome.error)
  assert.match(outcome.error, /quota/i)
  assert.match(logLines.join(' '), /Closed captions upload could not be completed/i)
})

test('services: a grant without caption scope fails BEFORE any captions network call', async () => {
  const { slug, accountId } = await connectedAccount({ scopes: ['youtube.upload'] })
  const logLines: string[] = []
  let calls = 0
  __setYouTubeTransportForTests((async () => {
    calls += 1
    throw new Error('captions transport must not be reached')
  }) as unknown as typeof fetch)
  const { track, dir } = await realTrack('EP0005')

  const outcome = await executeOptionalCaptionUpload({
    slug,
    accountId,
    videoId: 'v_remote_7',
    episodeCode: 'EP0005',
    subtitlesDir: dir,
    settings: { enabled: true, language: 'en' },
    trackOverride: track,
    logLines,
  })

  assert.equal(outcome.status, 'failed')
  assert.equal(outcome.remote_video_id, 'v_remote_7')
  assert.match(outcome.error || '', /force-ssl/)
  assert.equal(calls, 0)
  assert.match(logLines.join(' '), /not attempted/i)
})

test('services: when the existing tracks cannot be listed, nothing is inserted', async () => {
  const { slug, accountId } = await connectedAccount()
  const logLines: string[] = []
  const seen: string[] = []
  __setYouTubeTransportForTests((async (input: any) => {
    const url = new URL(String(input))
    seen.push(url.pathname)
    return new Response(JSON.stringify({ error: { code: 500, message: 'backend error' } }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof fetch)
  const { track, dir } = await realTrack('EP0006')

  const outcome = await executeOptionalCaptionUpload({
    slug,
    accountId,
    videoId: 'v_remote_8',
    episodeCode: 'EP0006',
    subtitlesDir: dir,
    settings: { enabled: true, language: 'en', dedupe_mode: 'skip_if_exists' },
    trackOverride: track,
    logLines,
  })

  assert.equal(outcome.status, 'failed')
  assert.equal(outcome.remote_video_id, 'v_remote_8')
  assert.match(outcome.error || '', /not inserting/i)
  // Exactly the list attempt — no blind insert after an uncertain answer.
  assert.equal(seen.length, 1)
  assert.match(logLines.join(' '), /could not be completed/i)
})

test('quota: captions costs are the published figures and charge the Cloud-project ledger', async () => {
  assert.equal(QUOTA_COST.captions_list, 50)
  assert.equal(QUOTA_COST.captions_insert, 400)
  assert.equal(QUOTA_COST.captions_update, 450)

  const { slug, accountId } = await connectedAccount()
  const logLines: string[] = []
  __setYouTubeTransportForTests(captionTransport([
    { match: CAPTIONS_LIST, status: 200, body: { items: [] } },
    {
      match: CAPTIONS_UPLOAD,
      status: 200,
      body: { id: 'cap_quota_1', snippet: { videoId: 'v_remote_9', language: 'en', name: 'English' } },
    },
  ]))
  const { track, dir } = await realTrack('EP0007')

  const outcome = await executeOptionalCaptionUpload({
    slug,
    accountId,
    videoId: 'v_remote_9',
    episodeCode: 'EP0007',
    subtitlesDir: dir,
    settings: { enabled: true, language: 'en' },
    trackOverride: track,
    logLines,
  })
  assert.equal(outcome.status, 'uploaded')

  const { readYouTubeConnectionRegistry } = await import('../services/youtube-connection-store.js')
  const applicationId = (await readYouTubeConnectionRegistry()).application?.application_id
  assert.ok(applicationId, 'the fixture application must exist')
  const { readYouTubeQuota } = await import('../services/youtube-quota-ledger.js')
  const snapshot = await readYouTubeQuota(applicationId!)
  assert.equal(
    snapshot.buckets.other_endpoints.used,
    QUOTA_COST.captions_list + QUOTA_COST.captions_insert,
  )
})

test('services: discovery never selects another episode\'s file or a symlink escaping the folder', async () => {
  const shared = await fsp.mkdtemp(path.join(os.tmpdir(), 'story-caption-shared-'))
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'story-caption-outside-'))
  const roots = await fsp.mkdtemp(path.join(os.tmpdir(), 'story-caption-roots-'))
  trackDirs.push(shared, outside, roots)
  await fsp.writeFile(path.join(shared, 'EP0001_stitched.srt'), SRT_CONTENT, 'utf-8')
  await fsp.writeFile(path.join(shared, 'EP0002_stitched.srt'), SRT_CONTENT, 'utf-8')

  // A shared folder holds both episodes' files; only the asked-for one is chosen.
  const mine = await findEpisodeSubtitleTrack({ episodeCode: 'EP0002', subtitlesDir: shared })
  assert.ok(mine)
  assert.match(mine.file_path, /EP0002_stitched\.srt$/)

  // An episode with no file of its own gets nothing — never the neighbour's.
  const foreign = await findEpisodeSubtitleTrack({ episodeCode: 'EP0009', subtitlesDir: shared })
  assert.equal(foreign, null)

  // A symlink inside the folder pointing outside it is refused: the canonical
  // file does not live in this episode's folder.
  await fsp.writeFile(path.join(outside, 'EP0003_stitched.srt'), SRT_CONTENT, 'utf-8')
  await fsp.symlink(path.join(outside, 'EP0003_stitched.srt'), path.join(roots, 'EP0003_stitched.srt'))
  const linked = await findEpisodeSubtitleTrack({ episodeCode: 'EP0003', subtitlesDir: roots })
  assert.equal(linked, null)
})

test('services: a trackOverride naming another episode\'s file is refused before any network call', async () => {
  const { slug, accountId } = await connectedAccount()
  const logLines: string[] = []
  let calls = 0
  __setYouTubeTransportForTests((async () => {
    calls += 1
    throw new Error('captions transport must not be reached')
  }) as unknown as typeof fetch)
  const { track, dir } = await realTrack('EP0001')

  const outcome = await executeOptionalCaptionUpload({
    slug,
    accountId,
    videoId: 'v_remote_10',
    episodeCode: 'EP0008',
    subtitlesDir: dir,
    settings: { enabled: true, language: 'en' },
    trackOverride: track,
    logLines,
  })

  assert.equal(outcome.status, 'failed')
  assert.equal(outcome.remote_video_id, 'v_remote_10')
  assert.match(outcome.error || '', /not this episode's own file/)
  assert.equal(calls, 0)
})

test('services: replace_existing refuses to overwrite when two same-language tracks match by language only', async () => {
  const { slug, accountId } = await connectedAccount()
  const logLines: string[] = []
  const seen: string[] = []
  __setYouTubeTransportForTests((async (input: any, init?: RequestInit) => {
    const url = new URL(String(input))
    seen.push(`${init?.method || 'GET'} ${url.pathname}`)
    if (/^\/youtube\/v3\/captions\?/.test(`${url.pathname}${url.search}`)) {
      return new Response(JSON.stringify({
        items: [
          { id: 'cap_manual', snippet: { videoId: 'v_remote_11', language: 'en', name: 'Manual' } },
          { id: 'cap_owner', snippet: { videoId: 'v_remote_11', language: 'en', name: 'Owner cut' } },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response(JSON.stringify({ error: { code: 400, message: 'must not write' } }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof fetch)
  const { track, dir } = await realTrack('EP0009')

  const outcome = await executeOptionalCaptionUpload({
    slug,
    accountId,
    videoId: 'v_remote_11',
    episodeCode: 'EP0009',
    subtitlesDir: dir,
    settings: { enabled: true, language: 'en', dedupe_mode: 'replace_existing' },
    trackOverride: track,
    logLines,
  })

  assert.equal(outcome.status, 'failed')
  assert.match(outcome.error || '', /none of them is named 'English'/)
  // Only the list call: no PUT reached the provider.
  assert.equal(seen.length, 1)
})

test('services: a caption belonging to ANOTHER video is never updated — ours is inserted', async () => {
  const { slug, accountId } = await connectedAccount()
  const logLines: string[] = []
  let methodUsed = ''
  __setYouTubeTransportForTests(captionTransport([
    {
      match: CAPTIONS_LIST,
      status: 200,
      body: {
        items: [{ id: 'foreign_cap', snippet: { videoId: 'someone_elses_video', language: 'en', name: 'English' } }],
      },
    },
    {
      match: CAPTIONS_UPLOAD,
      status: 200,
      body: { id: 'our_new_cap', snippet: { videoId: 'v_remote_12', language: 'en', name: 'English' } },
      onCall: (init) => { methodUsed = init?.method || '' },
    },
  ]))
  const { track, dir } = await realTrack('EP0010')

  const outcome = await executeOptionalCaptionUpload({
    slug,
    accountId,
    videoId: 'v_remote_12',
    episodeCode: 'EP0010',
    subtitlesDir: dir,
    settings: { enabled: true, language: 'en', dedupe_mode: 'replace_existing' },
    trackOverride: track,
    logLines,
  })

  assert.equal(outcome.status, 'uploaded')
  assert.equal(outcome.caption_id, 'our_new_cap')
  assert.equal(methodUsed, 'POST')
})
