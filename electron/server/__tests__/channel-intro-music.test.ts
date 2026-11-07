import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildIntroAudioFfmpegArgs,
  channelIntroMusicKey,
  compileIntroAudioFilter,
  normalizeChannelIntroMusic,
  resolveChannelIntroMusic,
  sameChannelIntroMusic,
  type ChannelIntroMusicSettings,
} from '../services/channel-intro-music.js'

test('normalizeChannelIntroMusic handles valid and edge-case inputs cleanly', () => {
  assert.equal(normalizeChannelIntroMusic(null), null)
  assert.equal(normalizeChannelIntroMusic(undefined), null)
  assert.equal(normalizeChannelIntroMusic(''), null)
  assert.equal(normalizeChannelIntroMusic({ file: '' }), null)
  assert.equal(normalizeChannelIntroMusic({ file: '   ' }), null)
  assert.equal(normalizeChannelIntroMusic({ file: 'intro.mp3', enabled: false }), null)

  const normalized = normalizeChannelIntroMusic({
    file: '${CHANNEL}/assets/jingle.mp3',
    volume: 0.8,
    gap_after: 1.5,
    trim_start_sec: 2.0,
    duration_sec: 5.0,
    fade_in_sec: 0.5,
    fade_out_sec: 1.0,
    sha256: 'abc123',
    source: '/abs/path/jingle.mp3',
    name: 'jingle.mp3',
  })

  assert.deepEqual(normalized, {
    file: '${CHANNEL}/assets/jingle.mp3',
    volume: 0.8,
    gap_after: 1.5,
    trim_start_sec: 2.0,
    duration_sec: 5.0,
    fade_in_sec: 0.5,
    fade_out_sec: 1.0,
    enabled: true,
    sha256: 'abc123',
    source: '/abs/path/jingle.mp3',
    name: 'jingle.mp3',
  })

  // Clamping and defaulting
  const clamped = normalizeChannelIntroMusic({
    file: 'intro.mp3',
    volume: 1.5, // should clamp to 1.0
    gap_after: -1, // should clamp to 0
    trim_start_sec: -5, // should clamp to 0
    duration_sec: -2, // invalid duration should become null
    fade_in_sec: -0.5, // should clamp to 0
    fade_out_sec: -1, // should clamp to 0
  })

  assert.equal(clamped?.volume, 1.0)
  assert.equal(clamped?.gap_after, 0)
  assert.equal(clamped?.trim_start_sec, 0)
  assert.equal(clamped?.duration_sec, null)
  assert.equal(clamped?.fade_in_sec, 0)
  assert.equal(clamped?.fade_out_sec, 0)
})

test('sameChannelIntroMusic and channelIntroMusicKey detect differences accurately', () => {
  const base: ChannelIntroMusicSettings = {
    file: 'intro.mp3',
    volume: 1,
    gap_after: 0,
    trim_start_sec: 1,
    duration_sec: 4,
    fade_in_sec: 0.5,
    fade_out_sec: 0.5,
  }

  assert.equal(sameChannelIntroMusic(base, { ...base }), true)
  assert.equal(sameChannelIntroMusic(null, null), true)
  assert.equal(sameChannelIntroMusic(base, null), false)
  assert.equal(sameChannelIntroMusic(base, { ...base, trim_start_sec: 2 }), false)
  assert.equal(sameChannelIntroMusic(base, { ...base, fade_out_sec: 1.0 }), false)
  assert.equal(sameChannelIntroMusic(base, { ...base, duration_sec: null }), false)

  const key1 = channelIntroMusicKey(base)
  const key2 = channelIntroMusicKey({ ...base, trim_start_sec: 2 })
  assert.notEqual(key1, key2)
  assert.equal(channelIntroMusicKey(null), 'null')
})

test('resolveChannelIntroMusic respects explicit clear, episode overrides, and automatic channel binding', () => {
  const channelIntroSetting: ChannelIntroMusicSettings = {
    file: '${CHANNEL}/assets/channel-theme.mp3',
    volume: 0.85,
    gap_after: 0.5,
    trim_start_sec: 1.0,
    duration_sec: 6.0,
    fade_in_sec: 0.5,
    fade_out_sec: 1.0,
  }

  const channelConfig = {
    channel_intro_music: channelIntroSetting,
  }

  // 1. Explicit clear on request
  const clearOnReq = resolveChannelIntroMusic({
    projectSlug: 'brain-wise',
    episodeId: 'EP001',
    requestSelection: null,
    channelConfig,
  })
  assert.equal(clearOnReq.source, 'episode_explicit')
  assert.equal(clearOnReq.settings, null)
  assert.equal(clearOnReq.explicitlyCleared, true)

  // 2. Explicit episode override on request
  const reqOverride: ChannelIntroMusicSettings = {
    file: '${CHANNEL}/assets/episode-special.mp3',
    volume: 1.0,
    gap_after: 1.0,
  }
  const onReq = resolveChannelIntroMusic({
    projectSlug: 'brain-wise',
    episodeId: 'EP001',
    requestSelection: reqOverride,
    channelConfig,
  })
  assert.equal(onReq.source, 'episode_explicit')
  assert.equal(onReq.settings?.file, '${CHANNEL}/assets/episode-special.mp3')
  assert.equal(onReq.explicitlyCleared, false)

  // 3. Saved episode-specific choice in last-used settings
  const episodeSaved: ChannelIntroMusicSettings = {
    file: '${CHANNEL}/assets/saved-ep.mp3',
    volume: 0.9,
    gap_after: 0,
  }
  const fromSaved = resolveChannelIntroMusic({
    projectSlug: 'capi-psychology',
    episodeId: 'EP002',
    episodeLastUsedSettings: {
      channel_intro: episodeSaved,
    },
    channelConfig,
  })
  assert.equal(fromSaved.source, 'episode_explicit')
  assert.equal(fromSaved.settings?.file, '${CHANNEL}/assets/saved-ep.mp3')

  // Saved episode explicitly cleared
  const fromSavedClear = resolveChannelIntroMusic({
    projectSlug: 'capi-psychology',
    episodeId: 'EP002',
    episodeLastUsedSettings: {
      channel_intro: null,
    },
    channelConfig,
  })
  assert.equal(fromSavedClear.source, 'episode_explicit')
  assert.equal(fromSavedClear.settings, null)
  assert.equal(fromSavedClear.explicitlyCleared, true)

  // 4. Automatic binding from channel config when episode has no override
  const autoBound = resolveChannelIntroMusic({
    projectSlug: 'brain-wise',
    episodeId: 'EP003',
    episodeLastUsedSettings: {
      // no channel_intro key
      timeline: {},
    },
    channelConfig,
  })
  assert.equal(autoBound.source, 'channel_bound')
  assert.equal(autoBound.settings?.file, '${CHANNEL}/assets/channel-theme.mp3')
  assert.equal(autoBound.settings?.trim_start_sec, 1.0)
  assert.equal(autoBound.settings?.duration_sec, 6.0)
  assert.equal(autoBound.settings?.fade_out_sec, 1.0)

  // 5. Channel has no intro music configured
  const noIntro = resolveChannelIntroMusic({
    projectSlug: 'other-channel',
    episodeId: 'EP004',
    channelConfig: {},
  })
  assert.equal(noIntro.source, 'none')
  assert.equal(noIntro.settings, null)
})

test('compileIntroAudioFilter and buildIntroAudioFfmpegArgs produce correct filters and CLI args', () => {
  // Test trims, volume, and fades
  const filterResult = compileIntroAudioFilter({
    settings: {
      file: 'intro.mp3',
      volume: 0.5,
      trim_start_sec: 1.5,
      duration_sec: 4.0,
      fade_in_sec: 0.5,
      fade_out_sec: 1.0,
    },
    measuredDurationSec: 10.0,
  })

  assert.equal(filterResult.effectiveDurationSec, 4.0)
  assert.equal(filterResult.trimStartSec, 1.5)
  assert.equal(filterResult.trimEndSec, 5.5)
  assert.equal(filterResult.fadeInSec, 0.5)
  assert.equal(filterResult.fadeOutSec, 1.0)

  // Check filter clauses
  const filterGraph = filterResult.filterGraph
  assert.ok(filterGraph.includes('aresample=44100'))
  assert.ok(filterGraph.includes('atrim=start=1.500:end=5.500,asetpts=PTS-STARTPTS'))
  assert.ok(filterGraph.includes('volume=0.50'))
  assert.ok(filterGraph.includes('afade=t=in:st=0:d=0.500'))
  assert.ok(filterGraph.includes('afade=t=out:st=3.000:d=1.000')) // 4.0 - 1.0 = 3.000

  // Test full track with measured duration for fade-out
  const fullTrackFilter = compileIntroAudioFilter({
    settings: {
      file: 'intro.mp3',
      volume: 1.0,
      fade_out_sec: 2.0,
    },
    measuredDurationSec: 8.0,
  })
  assert.equal(fullTrackFilter.effectiveDurationSec, 8.0)
  assert.ok(fullTrackFilter.filterGraph.includes('afade=t=out:st=6.000:d=2.000'))

  // Test FFmpeg args
  const args = buildIntroAudioFfmpegArgs({
    inputPath: '/tmp/in.mp3',
    outputPath: '/tmp/out.mp3',
    settings: {
      file: 'intro.mp3',
      volume: 0.8,
      trim_start_sec: 2.0,
      duration_sec: 3.0,
    },
  })

  assert.deepEqual(args.slice(0, 3), ['-y', '-i', '/tmp/in.mp3'])
  assert.equal(args[args.length - 1], '/tmp/out.mp3')
  assert.ok(args.includes('-af'))
  assert.ok(args.includes('libmp3lame'))
})
