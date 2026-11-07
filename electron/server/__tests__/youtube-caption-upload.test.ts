/**
 * Unit tests for optional integrated YouTube captions upload.
 *
 * Verifies:
 * - OFF by default (enabled: false)
 * - Pure normalization & defaults
 * - Subtitle file discovery hierarchy
 * - Deduplication guard (skip_if_exists vs replace_existing)
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
} from '../contracts/youtube-caption-upload.js'
import {
  executeOptionalCaptionUpload,
  findEpisodeSubtitleTrack,
} from '../services/youtube-caption-upload.js'

const CHANNEL = 'UC-captions-test'

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => {
  __resetYouTubeTransportForTests()
  await cleanup?.()
  cleanup = undefined
})

/** A connected project + channel grant, on the real credential path. */
async function connectedAccount(): Promise<{ slug: string; accountId: string }> {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  const pm = await import('../services/project-manager.js')
  const connections = await import('../services/youtube-connection-store.js')
  const project = await pm.createProject({ name: 'Captions Fixture' })
  await connections.configureYouTubeApplication({ client_id: 'cap-client', client_secret: 'cap-secret' })
  await saveYouTubeChannelGrantForTest({
    channel: { channel_id: CHANNEL, title: 'Captions Channel', granted_scopes: ['youtube.upload'] },
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

function sampleTrack(overrides: Partial<Parameters<typeof executeOptionalCaptionUpload>[0]['trackOverride']> = {}) {
  return {
    file_path: '/fake/EP0001_stitched.srt',
    format: 'srt' as const,
    language: 'en',
    track_name: 'English',
    size_bytes: 120,
    sha256: 'deadbeef',
    cues_count: 2,
    content: SRT_CONTENT,
    ...overrides,
  }
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

  const outcome = await executeOptionalCaptionUpload({
    slug,
    accountId,
    videoId: 'v_remote_3',
    episodeCode: 'EP0001',
    settings: { enabled: true, language: 'en', dedupe_mode: 'skip_if_exists' },
    trackOverride: sampleTrack(),
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

  const outcome = await executeOptionalCaptionUpload({
    slug,
    accountId,
    videoId: 'v_remote_4',
    episodeCode: 'EP0002',
    settings: { enabled: true, language: 'km', track_name: 'Khmer' },
    trackOverride: sampleTrack({ language: 'km', track_name: 'Khmer' }),
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

  const outcome = await executeOptionalCaptionUpload({
    slug,
    accountId,
    videoId: 'v_remote_5',
    episodeCode: 'EP0003',
    settings: { enabled: true, language: 'en', dedupe_mode: 'replace_existing' },
    trackOverride: sampleTrack(),
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

  const outcome = await executeOptionalCaptionUpload({
    slug,
    accountId,
    videoId: 'v_remote_6',
    episodeCode: 'EP0004',
    settings: { enabled: true, language: 'en' },
    trackOverride: sampleTrack(),
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
