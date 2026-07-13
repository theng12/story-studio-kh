import assert from 'node:assert/strict'
import test from 'node:test'
import { buildVideoFrameFilter } from '../lib/video-frame-filter.js'

test('video frame graph scales 1080p-authored controls and masks corners', () => {
  const graph = buildVideoFrameFilter({
    inputLabel: '[in]', outputLabel: '[out]', prefix: 'frame',
    width: 1920, height: 1080, fps: 30,
    config: {
      enabled: true, inset_pct: 5, border_width: 12, corner_radius: 28,
      border_color: '#F2C14E', background_color: '#101820', fit: 'cover',
    },
  }).join(';')
  assert.match(graph, /scale=1788:948/)
  assert.match(graph, /drawbox=x=54:y=54:w=1812:h=972/)
  assert.match(graph, /geq=.*a=/)
  assert.match(graph, /overlay=66:66:shortest=1/)
  assert.match(graph, /\[out\]$/)
})

test('video frame graph sanitizes filter-injection colors', () => {
  const graph = buildVideoFrameFilter({
    inputLabel: '[in]', outputLabel: '[out]', prefix: 'safe',
    width: 1280, height: 720, fps: 24,
    config: {
      enabled: true, inset_pct: 4, border_width: 0, corner_radius: 0,
      border_color: 'red;movie=/tmp/bad', background_color: 'nope[]', fit: 'contain',
    },
  }).join(';')
  assert.doesNotMatch(graph, /movie=/)
  assert.match(graph, /color=#FFFFFF/)
  assert.match(graph, /color=c=#101820/)
  assert.match(graph, /force_original_aspect_ratio=decrease/)
})

test('video frame graph can use a looping media input as the board', () => {
  const graph = buildVideoFrameFilter({
    inputLabel: '[in]', backgroundInputLabel: '[2:v]', outputLabel: '[out]', prefix: 'media',
    width: 1920, height: 1080, fps: 30,
    config: {
      enabled: true, inset_pct: 4, border_width: 12, corner_radius: 28,
      border_color: '#FFFFFF', background_color: '#101820', background_path: '/tmp/paper.jpg', fit: 'cover',
    },
  }).join(';')
  assert.match(graph, /\[2:v\]setpts=PTS-STARTPTS,scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080/)
  assert.doesNotMatch(graph, /color=c=#101820:s=1920x1080/)
})
