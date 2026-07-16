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

test('only effects without a worker-equivalent trigger a named local fallback', () => {
  const reasons = remoteVideoAssemblyFallbackReasons(request({
    logo: { enabled: true },
    overlays: { enabled: true, items: [] },
    title_image: { enabled: true, image_path: '/tmp/title.png' },
  } as any))
  assert.deepEqual(reasons, ['overlay layers'])
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
