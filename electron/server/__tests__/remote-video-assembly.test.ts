import assert from 'node:assert/strict'
import test from 'node:test'
import { remoteVideoAssemblyFallbackReasons } from '../generators/remote-timestamp-assemble.js'
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

test('advanced layers trigger a named local fallback instead of being dropped', () => {
  const reasons = remoteVideoAssemblyFallbackReasons(request({
    logo: { enabled: true },
    overlays: { enabled: true, items: [] },
    title_image: { enabled: true, image_path: '/tmp/title.png' },
  } as any))
  assert.deepEqual(reasons, ['title card/image', 'logo overlay', 'overlay layers'])
})

test('the default crossfade is worker-compatible for continuity renders', () => {
  assert.deepEqual(remoteVideoAssemblyFallbackReasons(request({
    transition: 'crossfade',
    transition_duration: 1.5,
  })), [])
})
