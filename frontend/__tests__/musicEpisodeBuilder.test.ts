/**
 * Music channel format, phase 2: the MUSIC sidebar flow, the Episode Builder page and
 * Video Assembly's "Music episode" settings (SPEC §1, §4–5, mockup 04, owner decisions
 * 2026-10-03).
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { describe } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  FLOW_PHASES,
  flowForVisualSource,
  requiredFlowSteps,
  visualSourceFromFormat,
} from '../composables/useProjectFlow.js'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const page = read('../pages/projects/[slug]/episode-builder.vue')
const assembly = read('../pages/projects/[slug]/video-assembly.vue')
const layout = read('../layouts/dashboard.vue')

describe('MUSIC flow', () => {
  test('a formula with musicFormat selects the music flow; anything else keeps the narration flow', () => {
    assert.match(layout, /visualSourceFromFormat\(format\)/, 'the sidebar reads the music flag through the shared helper')
    assert.equal(visualSourceFromFormat({ musicChannel: true, visualSource: 'narrated-scenes' }), 'music')
    assert.equal(visualSourceFromFormat({ visualSource: 'narrated-scenes' }), 'narrated-scenes')
    assert.equal(visualSourceFromFormat({ visualSource: 'unknown' }), null, 'unknown narration sources are still refused')
  })

  test('formula → song pool → episode builder → video assembly → thumbnail → finalizer, in three phases', () => {
    const flow = flowForVisualSource('music')
    assert.deepEqual(flow.map(s => s.key), ['music-formula', 'song-pool', 'episode-builder', 'video-assembly', 'thumbnails', 'metadata'])
    assert.deepEqual(flow.map(s => s.path), ['/music-formula', '/song-pool', '/episode-builder', '/video-assembly', '/images', '/metadata'])
    const phases = FLOW_PHASES.filter(p => flow.some(s => s.phase === p.key)).map(p => p.label)
    assert.deepEqual(phases, ['Music', 'Episode', 'Video'])
    assert.ok(!flow.some(s => ['ideas', 'script', 'audio', 'subtitles', 'scene-plan', 'scene-review'].includes(s.key)), 'no narration steps')
    assert.ok(requiredFlowSteps('music').some(s => s.key === 'video-assembly'))
  })

  test('narration flows are unchanged by the new phases', () => {
    for (const vs of ['timestamp-driven', 'continuity-chain', 'narrated-scenes'] as const) {
      assert.equal(flowForVisualSource(vs)[0]?.key, 'ideas')
      assert.ok(flowForVisualSource(vs).every(s => ['story', 'media', 'video'].includes(s.phase)))
    }
  })
})

describe('Episode Builder page', () => {
  test('every SPEC control is on the page with its starting values from the owner decisions', () => {
    for (const label of ['Random', 'Smooth flow', 'Manual', 'One per song', 'Fixed count', 'Every N min',
      'Crossfade', 'Butt-join', 'Short silence', 'Upscale to 1080p', 'LUFS', 'dBTP', "Don't repeat a song for",
      'Songs from', 'Scene change', 'Re-draw Unlocked', 'Send to Video Assembly', 'Add a Song…', 'Swap',
      'Regenerate Scene', 'Use From Pool…', 'Keep This Picture']) {
      assert.ok(page.includes(label), `missing: ${label}`)
    }
    assert.match(page, /frame_rate: 24, resolution: '720p', loudness_lufs: -14, true_peak_db: -1/)
    assert.match(page, /join: \{ style: 'crossfade', seconds: 3 \}/)
    for (const fps of ['24', '25', '30', '60']) assert.match(page, new RegExp(`\\b${fps}\\b`))
  })

  test('nothing on the page makes or buys a song; a short pool links to the Song Pool instead', () => {
    assert.ok(!/music-library\/generate|song-pool\/generate|song_pool_generate/.test(page))
    assert.match(page, /song-pool`, query: \{ generate:/)
    assert.match(page, /nothing was generated/)
  })

  test('pictures go through the fleet scene renderer and are accepted as they arrive', () => {
    assert.match(page, /scene-review\/\$\{code\.value\}\/continuity-render/)
    assert.match(page, /auto_approve_generated: true/)
    assert.match(page, /operation_id: crypto\.randomUUID\(\)/, 'a deliberate re-roll carries its own identity')
  })

  test('the image model is picked on the page, never assigned', () => {
    assert.match(page, /<ImageModelPicker v-model="imageForm\.model"/)
    assert.match(page, /useRememberedForm\('episode-builder-images'/)
  })

  test('moving a song switches the order to Manual and says so', () => {
    assert.match(page, /settings\.value\.order = 'manual'\s+success\('Order is now Manual, because you moved a song\.'\)/)
  })
})

describe('Video Assembly "Music episode" settings', () => {
  test('offered for an Episode Builder episode, applied only on click', () => {
    assert.match(assembly, /v-if="scannedAssets\?\.music_episode && !scanning"/)
    assert.match(assembly, /@click="applyMusicEpisodeSettings">Use Music Episode Settings/)
    assert.ok(!/watch\([^)]*music_episode[^)]*applyMusicEpisodeSettings/.test(assembly), 'never applied unasked')
  })

  test('sets the episode frame rate, resolution and scene change; turns off narration-only parts; keeps effects', () => {
    const fn = assembly.slice(assembly.indexOf('function applyMusicEpisodeSettings'), assembly.indexOf('function snapshotExportData'))
    for (const off of ['intro.enabled = false', 'titleImage.enabled = false', 'subtitles.enabled = false', 'titleCard.enabled = false', 'outroCard.enabled = false']) {
      assert.ok(fn.includes(off), off)
    }
    assert.match(fn, /exportSettings\.fps = music\.frame_rate/)
    assert.match(fn, /exportSettings\.resolution = music\.resolution === '1080p' \? '1080p' : '720p'/)
    assert.match(fn, /duration: music\.scene_change\.seconds/)
    assert.match(fn, /exportSettings\.encoding_effort = 'hardware'/)
    assert.match(fn, /exportSettings\.video_bitrate_kbps = exportSettings\.resolution === '1080p' \? 5000 : 2500/)
    assert.ok(!/logo\.|vignette\.|filmGrain\.|colorGrading\.|sceneEffects\./.test(fn), 'the channel look stays as the owner set it')
  })
})

test('an export preset saved before the bitrate cap means no cap (and the default sound level, 1.4.270, and allowed difference of 10%, 1.4.274)', () => {
  assert.equal((assembly.match(/Object\.assign\(exportSettings, \{ video_bitrate_kbps: 0, upscale_sharpen: 'off', loudness_lufs: -14, true_peak_db: -1, loudness_tolerance_pct: 10 \}/g) || []).length, 3)
  assert.match(read('../composables/useVideoAssemblyIo.ts'), /loudness_tolerance_pct: s\.exportSettings\.loudness_tolerance_pct \?\? 10/)
  assert.match(assembly, /data-testid="loudness-tolerance-pct"[\s\S]{0,200}Allowed difference: 10% \(default\)/)
  assert.match(read('../composables/useVideoAssemblyIo.ts'), /video_bitrate_kbps: s\.exportSettings\.video_bitrate_kbps/)
})
