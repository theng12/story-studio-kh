/**
 * Tests for srtToAss — the animated-caption ASS generator (v1.0.353) — and
 * the v1.0.517 "px at 1080" scaling contract shared with buildAssStyle.
 * A malformed ASS silently drops subtitles, so lock the structure + the
 * per-animation override tags.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  srtToAss,
  parseSrt,
  buildAssStyle,
  hasPreciseSubtitlePlacement,
  resolveSubtitlePlacement,
} from '../lib/subtitle-builder.js'

const baseStyle: any = {
  font_family: 'Avenir Next', font_size_px: 32, color_hex: '#FFEE00',
  outline_color_hex: '#000000', outline_px: 3, background: 'none',
  position: 'bottom', align: 'center', max_chars_per_line: 42, max_lines: 2,
}
const cues = [
  { index: 1, start_sec: 0, end_sec: 2.5, text: 'Hello world' },
  { index: 2, start_sec: 2.5, end_sec: 5, text: 'Second line with {braces}' },
]

describe('srtToAss — animated captions (v1.0.353)', () => {
  test('emits a well-formed ASS document with the style + events', () => {
    const ass = srtToAss(cues, baseStyle, { width: 1920, height: 1080, animation: 'fade' })
    assert.match(ass, /\[Script Info\]/)
    assert.match(ass, /PlayResX: 1920/)
    assert.match(ass, /PlayResY: 1080/)
    assert.match(ass, /\[V4\+ Styles\]/)
    assert.match(ass, /Style: Default,Avenir Next,32,/)
    assert.match(ass, /\[Events\]/)
    assert.equal((ass.match(/^Dialogue:/gm) || []).length, 2, 'one Dialogue per cue')
  })

  test('fade injects \\fad on every line', () => {
    const ass = srtToAss(cues, baseStyle, { width: 1920, height: 1080, animation: 'fade' })
    const dialogues = ass.match(/^Dialogue:.*$/gm) || []
    assert.ok(dialogues.length > 0 && dialogues.every(d => d.includes('\\fad(')), 'every line fades')
  })

  test('pop scales up from 72% to 100%', () => {
    const ass = srtToAss(cues, baseStyle, { width: 1920, height: 1080, animation: 'pop' })
    assert.match(ass, /\\fscx72\\fscy72\\t\(0,150,\\fscx100\\fscy100\)/)
  })

  test('slide-up uses \\move with resolution-derived center x', () => {
    const ass = srtToAss(cues, baseStyle, { width: 1920, height: 1080, animation: 'slide-up' })
    assert.match(ass, /\\move\(960,/, 'center x = width/2')
  })

  test("neutralises braces so source text can't be read as an override block", () => {
    const ass = srtToAss(cues, baseStyle, { width: 1920, height: 1080, animation: 'none' })
    assert.ok(!ass.includes('{braces}'), 'raw braces removed')
    assert.match(ass, /\(braces\)/)
  })

  test('handles empty cues without crashing', () => {
    const ass = srtToAss([], baseStyle, { width: 1280, height: 720, animation: 'fade' })
    assert.match(ass, /\[Events\]/)
    assert.equal((ass.match(/^Dialogue:/gm) || []).length, 0)
  })

  test('round-trips through parseSrt with ASS centisecond timestamps', () => {
    const srt = '1\n00:00:00,000 --> 00:00:02,500\nHi there\n\n'
    const ass = srtToAss(parseSrt(srt), baseStyle, { width: 1920, height: 1080, animation: 'fade' })
    assert.match(ass, /Hi there/)
    assert.match(ass, /Dialogue: 0,0:00:00\.00,0:00:02\.50,/)
  })
})

describe('precise safe-area placement', () => {
  test('detects precise placement only when both coordinates exist', () => {
    assert.equal(hasPreciseSubtitlePlacement({ ...baseStyle, position_x_pct: 50 }), false)
    assert.equal(hasPreciseSubtitlePlacement({ ...baseStyle, position_x_pct: 50, position_y_pct: 90 }), true)
  })

  test('clamps coordinates to the protected edge and anchors text inward', () => {
    const placement = resolveSubtitlePlacement({
      ...baseStyle,
      position_x_pct: 99,
      position_y_pct: 1,
      safe_margin_pct: 10,
    }, 1920, 1080)
    assert.deepEqual(placement, {
      x: 1728,
      y: 108,
      safeMarginPx: 108,
      alignment: 9,
    })
  })

  test('emits an exact position for static subtitles', () => {
    const style = {
      ...baseStyle,
      position_x_pct: 12.5,
      position_y_pct: 22,
      safe_margin_pct: 8,
    }
    const ass = srtToAss(cues, style, { width: 1920, height: 1080, animation: 'none' })
    assert.match(ass, /Style: Default,[^\n]+,7,/, 'top-left anchor keeps text inside the frame')
    assert.match(ass, /\{\\pos\(240,238\)\}Hello world/)
  })

  test('uses the custom anchor for animated subtitles too', () => {
    const style = {
      ...baseStyle,
      position_x_pct: 25,
      position_y_pct: 75,
      safe_margin_pct: 8,
    }
    const fade = srtToAss(cues, style, { width: 1920, height: 1080, animation: 'fade' })
    assert.match(fade, /\{\\pos\(480,810\)\\fad\(180,180\)\}/)
    const slide = srtToAss(cues, style, { width: 1920, height: 1080, animation: 'slide-up' })
    assert.match(slide, /\\move\(480,846,480,810\)/)
  })

  test('keeps legacy static subtitles on the coarse-anchor path', () => {
    const ass = srtToAss(cues, baseStyle, { width: 1920, height: 1080, animation: 'none' })
    assert.doesNotMatch(ass, /\\pos\(/)
  })
})

// v1.0.517 — font_size_px / outline_px mean "px at a 1080 reference" in BOTH
// render paths. Regressing either scale factor silently blows fonts up (or
// shrinks them) in final renders, so pin the numbers.
describe('"px at 1080" scaling contract (v1.0.517)', () => {
  test('buildAssStyle pre-scales into the SRT-default 384×288 PlayRes space', () => {
    // ffmpeg's subtitles filter interprets force_style against a synthesized
    // 384×288 script, then scales to the output — so values must shrink by
    // 288/1080 or they render 3.75× too big (the v1.0.413–516 bug).
    const s = buildAssStyle({ ...baseStyle, font_size_px: 35, outline_px: 2 })
    assert.match(s, /FontSize=9\.33/, '35px @1080 → 35·(288/1080) ≈ 9.33')
    assert.match(s, /Outline=0\.53/, '2px @1080 → 2·(288/1080) ≈ 0.53')
    assert.match(s, /MarginV=11/, '40px @1080 → ≈ 11')
  })

  test('srtToAss is a no-op at 1080p and proportional at other heights', () => {
    const at1080 = srtToAss(cues, baseStyle, { width: 1920, height: 1080, animation: 'none' })
    assert.match(at1080, /Style: Default,Avenir Next,32,/, '1080p keeps px values as-is')
    const at720 = srtToAss(cues, baseStyle, { width: 1280, height: 720, animation: 'none' })
    assert.match(at720, /Style: Default,Avenir Next,21\.33,/, '720p scales by 720/1080')
  })
})
