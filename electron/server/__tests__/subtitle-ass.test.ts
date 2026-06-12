/**
 * Tests for srtToAss — the animated-caption ASS generator (v1.0.353).
 * A malformed ASS silently drops subtitles, so lock the structure + the
 * per-animation override tags.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { srtToAss, parseSrt } from '../lib/subtitle-builder.js'

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
