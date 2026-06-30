/**
 * Tests for the pure pieces of the AI-gen fallback (services/broll-aigen.ts).
 * Image generation + ffmpeg are integration concerns; here we pin the prompt
 * construction and the image→clip argv.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { buildAiGenPrompt, buildImageToClipArgs } from '../services/broll-aigen.js'

describe('buildAiGenPrompt', () => {
  test('prefixes the channel style before the beat subject', () => {
    assert.equal(
      buildAiGenPrompt({ queries: ['gas station at night'], line: 'whatever' }, 'flat editorial illustration'),
      'flat editorial illustration. gas station at night',
    )
  })
  test('falls back to the line when there are no queries', () => {
    assert.equal(buildAiGenPrompt({ queries: [], line: 'prices keep rising' }, 'muted 2D vector'),
      'muted 2D vector. prices keep rising')
  })
  test('no style → just the subject', () => {
    assert.equal(buildAiGenPrompt({ queries: ['stock ticker'], line: 'x' }, ''), 'stock ticker')
  })
})

describe('buildImageToClipArgs', () => {
  test('loops a still into a duration-bounded 1080p clip, no audio', () => {
    const args = buildImageToClipArgs('/p/img.png', '/p/out.mp4', 4.2, 30)
    assert.deepEqual(args.slice(0, 5), ['-y', '-loop', '1', '-i', '/p/img.png'])
    assert.ok(args.includes('-t') && args[args.indexOf('-t') + 1] === '4.20')
    assert.ok(args.includes('-an')) // muted — narration/SFX own the sound
    assert.match(args[args.indexOf('-vf') + 1]!, /scale=1920:1080.*crop=1920:1080/)
    assert.equal(args[args.length - 1], '/p/out.mp4')
  })
  test('clamps a tiny/zero duration to a floor', () => {
    const args = buildImageToClipArgs('/i.png', '/o.mp4', 0, 30)
    assert.equal(args[args.indexOf('-t') + 1], '0.50')
  })
})
