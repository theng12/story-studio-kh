import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, describe, test } from 'node:test'
import { useTempDataDir } from './_helpers.js'
import { saveYouTubeChannelGrantForTest } from './_youtube-connection-test-helper.js'
import { FakeYouTube } from './fixtures/fake-youtube.js'
import * as pm from '../services/project-manager.js'
import { __resetYouTubeTransportForTests, __setYouTubeTransportForTests } from '../lib/youtube-client.js'
import { assignProjectYouTubeChannel, configureYouTubeApplication } from '../services/youtube-connection-store.js'
import {
  createDefaultEndScreenConfig,
  normalizeEndScreenConfig,
  buildYouTubeStudioGuidance,
  formatSecondsToTimestamp,
  YOUTUBE_END_SCREEN_CAPABILITY,
} from '../contracts/youtube-channel-settings.js'
import {
  getDefaultPlaylist,
  setDefaultPlaylist,
  getEndScreenSettings,
  updateEndScreenSettings,
  getPlaylistInventory,
  getYouTubeChannelSettings,
  updateYouTubeChannelSettings,
  _resetPlaylistCacheForTesting,
} from '../services/upload-playlists.js'

describe('YouTube Channel Settings Contract & Service (Item 20)', () => {
  let cleanup: () => Promise<void>
  let testSlug: string
  let accountId: string

  before(async () => {
    cleanup = (await useTempDataDir()).cleanup
    await configureYouTubeApplication({ client_id: 'channel-settings-client', client_secret: 'test-client-secret' })
    const project = await pm.createProject({ name: 'YT Channel Settings Test' })
    testSlug = project.slug
    await saveYouTubeChannelGrantForTest({
      channel: { channel_id: 'UC-channel-settings', title: 'Settings Test', granted_scopes: ['youtube.upload'] },
      tokens: { access_token: 'test-access-token', refresh_token: 'test-refresh-token', expires_at: Date.now() + 3_600_000 },
    })
    await assignProjectYouTubeChannel({
      project_slug: project.slug, channel_id: 'UC-channel-settings', expected_previous_channel_id: null,
    })
    accountId = 'registry:UC-channel-settings'
  })

  after(async () => {
    __resetYouTubeTransportForTests()
    if (cleanup) await cleanup()
  })

  afterEach(() => {
    __resetYouTubeTransportForTests()
  })

  beforeEach(() => {
    _resetPlaylistCacheForTesting()
  })

  /** One playlists.list page: a public series playlist and a private one. */
  function queuePlaylists(): FakeYouTube {
    const fake = new FakeYouTube()
    fake.respond({
      method: 'GET',
      path: '/youtube/v3/playlists?part=snippet%2Cstatus%2CcontentDetails&mine=true&maxResults=50',
      body: {
        items: [
          { id: 'PL_SERIES_A', snippet: { title: 'Series A', description: 'All episodes' }, status: { privacyStatus: 'public' }, contentDetails: { itemCount: 12 } },
          { id: 'PL_SLEEP', snippet: { title: 'Sleep', description: '' }, status: { privacyStatus: 'private' }, contentDetails: { itemCount: 0 } },
        ],
      },
    })
    return fake
  }

  describe('Contract: End-Screen Settings & Capabilities', () => {
    test('YOUTUBE_END_SCREEN_CAPABILITY honestly reports lack of remote API support', () => {
      assert.equal(YOUTUBE_END_SCREEN_CAPABILITY.remote_api_supported, false)
      assert.equal(
        YOUTUBE_END_SCREEN_CAPABILITY.remote_status,
        'unsupported_by_youtube_data_api_v3',
      )
      assert.equal(YOUTUBE_END_SCREEN_CAPABILITY.local_presentation_supported, true)
      assert.equal(YOUTUBE_END_SCREEN_CAPABILITY.min_duration_seconds, 5)
      assert.equal(YOUTUBE_END_SCREEN_CAPABILITY.max_duration_seconds, 20)
      assert.equal(YOUTUBE_END_SCREEN_CAPABILITY.max_elements, 4)
      assert.match(YOUTUBE_END_SCREEN_CAPABILITY.reason, /YouTube Data API v3 does not expose/i)
    })

    test('createDefaultEndScreenConfig produces safe, disabled defaults', () => {
      const cfg = createDefaultEndScreenConfig('PL_TEST_DEFAULT')
      assert.equal(cfg.enabled, false, 'End-screen outro must be OFF by default')
      assert.equal(cfg.duration_seconds, 20, 'Default duration should be 20s (standard YouTube max)')
      assert.equal(cfg.template, 'playlist_and_subscribe')
      assert.equal(cfg.elements.length, 2)
      assert.equal(cfg.elements[0].type, 'playlist')
      assert.equal(cfg.elements[0].playlist_id, 'PL_TEST_DEFAULT')
      assert.equal(cfg.elements[1].type, 'subscribe')
      assert.equal(cfg.backdrop_style, 'dimmed_backdrop')
      assert.equal(cfg.audio_treatment, 'continue_bed')
      assert.ok(cfg.notes_for_youtube_studio, 'Generated guidance notes must be present')
    })

    test('normalizeEndScreenConfig clamps duration to YouTube 5-20s limits', () => {
      const tooShort = normalizeEndScreenConfig({ duration_seconds: 2 })
      assert.equal(tooShort.duration_seconds, 5, 'Clamps below 5 to 5')

      const tooLong = normalizeEndScreenConfig({ duration_seconds: 45 })
      assert.equal(tooLong.duration_seconds, 20, 'Clamps above 20 to 20')

      const decimal = normalizeEndScreenConfig({ duration_seconds: 14.7 })
      assert.equal(decimal.duration_seconds, 15, 'Rounds decimal seconds to integer')

      const nanVal = normalizeEndScreenConfig({ duration_seconds: 'invalid' })
      assert.equal(nanVal.duration_seconds, 20, 'Fallback to 20 on NaN')
    })

    test('normalizeEndScreenConfig caps elements at 4 (YouTube limit)', () => {
      const fiveElements = [
        { id: '1', type: 'subscribe' },
        { id: '2', type: 'playlist' },
        { id: '3', type: 'best_for_viewer' },
        { id: '4', type: 'latest_upload' },
        { id: '5', type: 'specific_video' },
      ]
      const normalized = normalizeEndScreenConfig({ elements: fiveElements })
      assert.equal(normalized.elements.length, 4, 'Must strictly cap elements to 4')
      assert.equal(normalized.elements[0].type, 'subscribe')
      assert.equal(normalized.elements[3].type, 'latest_upload')
    })

    test('normalizeEndScreenConfig heals invalid template and backdrop styles', () => {
      const normalized = normalizeEndScreenConfig({
        template: 'non_existent_template',
        backdrop_style: 'neon_glow',
        audio_treatment: 'explode',
      })
      assert.equal(normalized.template, 'playlist_and_subscribe')
      assert.equal(normalized.backdrop_style, 'dimmed_backdrop')
      assert.equal(normalized.audio_treatment, 'continue_bed')
    })

    test('formatSecondsToTimestamp formats properly', () => {
      assert.equal(formatSecondsToTimestamp(0), '00:00')
      assert.equal(formatSecondsToTimestamp(5), '00:05')
      assert.equal(formatSecondsToTimestamp(65), '01:05')
      assert.equal(formatSecondsToTimestamp(1220), '20:20')
      assert.equal(formatSecondsToTimestamp(-10), '00:00')
      assert.equal(formatSecondsToTimestamp(NaN), '00:00')
    })

    test('buildYouTubeStudioGuidance creates clear timestamp and elements guidance', () => {
      const guidance = buildYouTubeStudioGuidance(
        {
          duration_seconds: 20,
          template: 'playlist_and_subscribe',
          elements: [
            { id: '1', type: 'playlist', playlist_id: 'PL_ABC', label: 'My Series' },
            { id: '2', type: 'subscribe', label: 'Subscribe' },
          ],
        },
        600, // 10 minutes total video
        'My Series',
      )

      assert.match(guidance, /YouTube Studio End-Screen Setup Guide/)
      assert.match(guidance, /Timestamp Window: 09:40 - 10:00 \(last 20s\)/)
      assert.match(guidance, /1\. Playlist \(My Series\)/)
      assert.match(guidance, /2\. Channel Subscribe button/)
      assert.match(guidance, /YouTube Data API v3 does not support third-party end screen writes/)
    })
  })

  describe('Service: upload-playlists Channel Settings & Defaults', () => {
    test('getPlaylistInventory returns empty state when no accountId provided', async () => {
      const inventory = await getPlaylistInventory(testSlug, '')
      assert.equal(inventory.has_connected_account, false)
      assert.equal(inventory.account_id, '')
      assert.equal(inventory.playlists.length, 0)
      assert.equal(inventory.count, 0)
    })

    test('getDefaultPlaylist returns empty string when none set', async () => {
      const pl = await getDefaultPlaylist(testSlug, 'UC_ACCOUNT_1')
      assert.equal(pl, '')
    })

    test('setDefaultPlaylist saves default playlist for account and reads back', async () => {
      await setDefaultPlaylist(testSlug, 'UC_ACCOUNT_1', 'PL_SERIES_A')
      const readBack = await getDefaultPlaylist(testSlug, 'UC_ACCOUNT_1')
      assert.equal(readBack, 'PL_SERIES_A')

      // Independent multi-account check
      await setDefaultPlaylist(testSlug, 'UC_ACCOUNT_2', 'PL_SERIES_B')
      assert.equal(await getDefaultPlaylist(testSlug, 'UC_ACCOUNT_1'), 'PL_SERIES_A')
      assert.equal(await getDefaultPlaylist(testSlug, 'UC_ACCOUNT_2'), 'PL_SERIES_B')

      // Empty string unsets the default
      await setDefaultPlaylist(testSlug, 'UC_ACCOUNT_1', '')
      assert.equal(await getDefaultPlaylist(testSlug, 'UC_ACCOUNT_1'), '')
      assert.equal(await getDefaultPlaylist(testSlug, 'UC_ACCOUNT_2'), 'PL_SERIES_B')
    })

    test('setDefaultPlaylist rejects missing account ID', async () => {
      await assert.rejects(
        () => setDefaultPlaylist(testSlug, '', 'PL_X'),
        /Cannot set default playlist without a valid YouTube account ID/,
      )
    })

    test('getEndScreenSettings returns default when none in config', async () => {
      const settings = await getEndScreenSettings(testSlug)
      assert.equal(settings.enabled, false)
      assert.equal(settings.duration_seconds, 20)
      assert.equal(settings.template, 'playlist_and_subscribe')
    })

    test('updateEndScreenSettings persists valid settings and normalizes', async () => {
      const updated = await updateEndScreenSettings(testSlug, {
        enabled: true,
        duration_seconds: 12,
        backdrop_style: 'slate_card',
        audio_treatment: 'duck_bed',
      })

      assert.equal(updated.enabled, true)
      assert.equal(updated.duration_seconds, 12)
      assert.equal(updated.backdrop_style, 'slate_card')
      assert.equal(updated.audio_treatment, 'duck_bed')

      const reRead = await getEndScreenSettings(testSlug)
      assert.equal(reRead.enabled, true)
      assert.equal(reRead.duration_seconds, 12)
      assert.equal(reRead.backdrop_style, 'slate_card')
      assert.equal(reRead.audio_treatment, 'duck_bed')
    })

    test('getYouTubeChannelSettings reads live playlists once and reports the default', async () => {
      await setDefaultPlaylist(testSlug, accountId, 'PL_SERIES_A')
      const fake = queuePlaylists()
      __setYouTubeTransportForTests(fake.transport())

      const summary = await getYouTubeChannelSettings(testSlug, accountId)
      assert.equal(summary.inventory.has_connected_account, true)
      assert.equal(summary.inventory.count, 2)
      assert.equal(summary.inventory.playlists[0].title, 'Series A')
      assert.equal(summary.inventory.playlists[0].itemCount, 12)
      assert.equal(summary.inventory.playlists[1].privacyStatus, 'private')
      assert.equal(summary.inventory.default_playlist_id, 'PL_SERIES_A')
      assert.equal(summary.end_screen.enabled, true)
      assert.equal(summary.end_screen_capabilities.remote_api_supported, false)
      assert.equal(fake.calls.length, 1, 'one playlists.list call serves the read')

      await getYouTubeChannelSettings(testSlug, accountId)
      assert.equal(fake.calls.length, 1, 'the 60s cache must serve the second read')
    })

    test('updateYouTubeChannelSettings updates both default playlist and end screen', async () => {
      __setYouTubeTransportForTests(queuePlaylists().transport())
      const result = await updateYouTubeChannelSettings(testSlug, accountId, {
        default_playlist_id: 'PL_NEW_DEFAULT',
        end_screen: {
          duration_seconds: 18,
          template: 'one_video_one_subscribe',
        },
      })

      assert.equal(result.inventory.default_playlist_id, 'PL_NEW_DEFAULT')
      assert.equal(result.end_screen.duration_seconds, 18)
      assert.equal(result.end_screen.template, 'one_video_one_subscribe')

      const verified = await getYouTubeChannelSettings(testSlug, accountId)
      assert.equal(verified.inventory.default_playlist_id, 'PL_NEW_DEFAULT')
      assert.equal(verified.end_screen.duration_seconds, 18)
    })
  })
})
