import assert from 'node:assert/strict'
import test from 'node:test'
import { remoteVideoAssemblyFallbackReasons } from '../generators/remote-video-assembly.js'
import type { GenerateVideoRequest } from '../models/types.js'

function request(overrides: Partial<GenerateVideoRequest> = {}): GenerateVideoRequest {
  return {
    episode_id: 'EP0001',
    format: 'mp4',
    scene_pool_mode: 'scene_plan',
    resolution: '1080p',
    fps: 30,
    quality: 'medium',
    ...overrides,
  } as GenerateVideoRequest
}

test('continuity assembly features supported by Render Studio stay eligible', () => {
  const reasons = remoteVideoAssemblyFallbackReasons(request({
    transition: 'none',
    intro: { enabled: true, video_path: '/tmp/intro.mp4', duration: 15 },
    scene_animation: { type: 'ken_burns', zoom_start: 100, zoom_end: 108 },
    subtitles: { enabled: true, style: { position: 'bottom', font_size_px: 28 } },
    frame: { enabled: true, background_type: 'color' },
  } as any))
  assert.deepEqual(reasons, [])
})

test('full Video Assembly controls stay eligible for a render worker', () => {
  const reasons = remoteVideoAssemblyFallbackReasons(request({
    format: 'webm',
    logo: { enabled: true, image_path: '/tmp/logo.png' },
    title_image: { enabled: true, image_path: '/tmp/title.png' },
    title_card: { enabled: true, text: 'A title', duration: 5, style: 'gold', background: '#000000' },
    outro: { enabled: true, video_path: '/tmp/outro.mp4' },
    outro_card: { enabled: true, text: 'Thank you', duration: 4, style: 'white' },
    timeline_clips: [{ id: 'timeline-1', enabled: true, anchor: 'after_scenes', kind: 'static', image_path: '/tmp/clip.png', duration_sec: 4 }],
    music: { enabled: true, files: ['/tmp/music.mp3'], volume: 0.3, fade_in: 1, fade_out: 1, post_narration_volume: 0.5 },
    background_noise: { enabled: true, mode: 'generated', preset: 'brown-noise', volume: 0.1, fade_in: 0, fade_out: 0 },
    overlays: { enabled: true, layers: [{ id: 'overlay', enabled: true, source_path: '/tmp/overlay.webm', opacity: 0.7, loop: true }] },
    video_layout: 'compilation',
    background_plate: { source_path: '/tmp/background.mp4' },
    foreground_defaults: { scale_pct: 0.5, position: 'center' },
    chapter_durations: [{ slug: 'chapter-01', duration_s: 30 }],
    subtitles: { enabled: true, source: 'whisper', srt_path: '/tmp/captions.srt', style: { font_family: 'Helvetica', font_size_px: 28, color_hex: '#fff', outline_color_hex: '#000', outline_px: 2, background: 'none', position: 'bottom', align: 'center', max_chars_per_line: 42, max_lines: 2, animation: 'fade' } },
  } as any))
  assert.deepEqual(reasons, [])
})

test('title media stays worker-safe even when an intro is also enabled', () => {
  assert.deepEqual(remoteVideoAssemblyFallbackReasons(request({
    intro: { enabled: true, video_path: '/tmp/intro.mp4' },
    title_image: { enabled: true, image_path: '/tmp/title.png', duration: 5 },
  } as any)), [])
})

test('worker-safe visual assembly supports titles, branding, and finishing effects', () => {
  assert.deepEqual(remoteVideoAssemblyFallbackReasons(request({
    title_image: { enabled: true, image_path: '/tmp/title.png', duration: 5 },
    logo: { enabled: true, image_path: '/tmp/logo.png' },
    color_grading: { enabled: true, preset: 'warm-night' },
    vignette: { enabled: true, strength: 0.5 },
    film_grain: { enabled: true, strength: 5 },
    letterbox: { enabled: true, ratio: '2.35:1', color: 'black' },
    frame: { enabled: true, background_path: '/tmp/background.mp4' },
  } as any)), [])
})

test('older presets without an explicit format still use worker-safe MP4', () => {
  assert.deepEqual(remoteVideoAssemblyFallbackReasons(request({ format: undefined } as any)), [])
})

test('the default crossfade is worker-compatible for continuity renders', () => {
  assert.deepEqual(remoteVideoAssemblyFallbackReasons(request({
    transition: 'crossfade',
    transition_duration: 1.5,
  })), [])
})

test('invalid transitions still name the safe local fallback reason', () => {
  const reasons = remoteVideoAssemblyFallbackReasons(request({ transition: 'not-a-real-transition' }))
  assert.deepEqual(reasons, ['unsupported transition "not-a-real-transition"'])
})
