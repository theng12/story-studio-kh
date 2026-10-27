/**
 * Video Assembly follows what is switched on (owner decision 2026-10-07): an
 * enabled feature with no input stops BEFORE the encode with what to press,
 * and the finished file's length must match the plan.
 */
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { finalDurationIssue, missingEnabledVideoInputs, missingInputsMessage, switchedOnCueGate } from '../lib/video-enabled-inputs.js'

let dir = ''
let real = ''
before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'enabled-inputs-'))
  real = path.join(dir, 'real.png')
  await fs.writeFile(real, 'x')
})
after(async () => { await fs.rm(dir, { recursive: true, force: true }) })

const base = (extra: Record<string, unknown> = {}) => ({ scenes: [], ...extra }) as any
const gone = () => path.join(dir, 'gone.mp4')

describe('switched-on features need their input', () => {
  test('everything off, or everything present: nothing is missing', () => {
    assert.deepEqual(missingEnabledVideoInputs(base({
      subtitles: { enabled: false }, title_image: { enabled: false, image_path: gone() },
      intro: { enabled: false, video_path: '' }, logo: { enabled: false, image_path: '' },
    }), { canDrawtext: true, episodeCode: 'EP1' }), [])
    assert.deepEqual(missingEnabledVideoInputs(base({
      subtitles: { enabled: true, srt_path: real }, title_image: { enabled: true, image_path: real },
      intro: { enabled: true, video_path: real }, outro: { enabled: true, video_path: real },
      logo: { enabled: true, image_path: real },
      overlays: { enabled: true, layers: [{ id: 'a', enabled: true, source_path: real }] },
      timeline_clips: [{ id: 'c', anchor: 'after_intro', enabled: true, video_path: real }],
    }), { canDrawtext: true, episodeCode: 'EP1' }), [])
  })

  test('each switched-on feature without its input is named, with what to press', () => {
    const missing = missingEnabledVideoInputs(base({
      subtitles: { enabled: true, srt_path: '' },
      title_image: { enabled: true, image_path: gone() },
      intro: { enabled: true, video_path: gone() },
      outro: { enabled: true, video_path: '' },
      logo: { enabled: true, image_path: gone() },
      overlays: { enabled: true, layers: [{ id: 'fireflies', enabled: true, source_path: gone() }, { id: 'off', enabled: false, source_path: gone() }] },
      timeline_clips: [
        { id: 'c1', anchor: 'after_intro', enabled: true, video_path: gone() },
        { id: 'c2', anchor: 'after_scenes', enabled: true, kind: 'static', image_path: real, duration_sec: 0 },
        { id: 'c3', anchor: 'after_outro', enabled: false, video_path: gone() },
      ],
      title_card: { enabled: false },
      outro_card: { enabled: true, text: 'Thanks' },
      video_layout: 'compilation', scenes: [{}, {}], chapter_durations: [{ slug: 'a', duration_s: 1 }],
    }), { canDrawtext: false, episodeCode: 'EP7' })
    assert.deepEqual(missing.map(item => item.feature), [
      'Captions', 'Title image / cover frame', 'Intro video', 'Outro video', 'Text outro card',
      'Timeline clip 1 (after_intro)', 'Timeline clip 2 (after_scenes)', 'Logo', 'Overlay "fireflies"',
      'Compilation foregrounds',
    ])
    assert.match(missing[0]!.fix, /EP7 has no subtitle file\. Open Subtitles and press Transcribe, then Stitch/)
    const message = missingInputsMessage(missing, 'EP7')
    assert.match(message, /stopped before encoding EP7/)
    assert.match(message, /Nothing was rendered\./)
  })

  test('a text title card stands in for the title image', () => {
    assert.deepEqual(missingEnabledVideoInputs(base({
      title_image: { enabled: true, image_path: '' }, title_card: { enabled: true, text: 'Title' },
    }), { canDrawtext: true, episodeCode: 'EP1' }), [])
  })
})

describe('final duration check', () => {
  test('within tolerance passes; a truncated or padded file is named', () => {
    assert.equal(finalDurationIssue(1200.4, 1200), null)
    assert.match(String(finalDurationIssue(1150, 1200)), /1150\.0s long but .* 1200\.0s \(-50\.0s\)/)
    assert.match(String(finalDurationIssue(null, 1200)), /could not be measured/)
  })
})

describe('Sound & Labels follows its switches at render time', () => {
  /**
   * v1.4.365 — owner, 2026-10-28: "nothing optional ever blocks Video Assembly:
   * a missing/unapproved optional sound = silence and a stated note".
   *
   * Every case below used to return a `stop` that refused the whole render.
   * They now return a note, and the case that matters most is pinned last: a
   * gate that always returned `{}` would pass a test written only against
   * "approved cues say nothing", so the note cases must assert a note EXISTS.
   */
  test('off: nothing runs and nothing is expected', () => {
    assert.deepEqual(switchedOnCueGate('On-screen text', 'EP1', { enabled: false, timeline: null, approved: 0 }), {})
    assert.deepEqual(switchedOnCueGate('Sound', 'EP1', { enabled: false, timeline: null, approved: 0 }), {})
  })

  test('on and never made: a NOTE says the episode plays without it, never a stop', () => {
    const labels = switchedOnCueGate('On-screen text', 'EP1', { enabled: true, timeline: null, approved: 0 })
    assert.equal(labels.stop, undefined, 'an optional layer must never refuse the render')
    assert.match(String(labels.note), /nothing was ever proposed/)
    assert.match(String(labels.note), /Open Sound & Labels/)

    const sound = switchedOnCueGate('Sound', 'EP1', { enabled: true, timeline: null, approved: 0 })
    assert.equal(sound.stop, undefined)
    assert.match(String(sound.note), /switched on for this project, but nothing was ever placed/)
  })

  test('on with proposals still waiting: a note names the count and the page', () => {
    const gate = switchedOnCueGate('On-screen text', 'EP1', {
      enabled: true, timeline: { cues: [{ status: 'proposed' }, { status: 'disabled' }] }, approved: 0,
    })
    assert.equal(gate.stop, undefined)
    assert.match(String(gate.note), /1 item is still awaiting review/)
    assert.match(String(gate.note), /The rest of the episode renders normally/)
  })

  test('every item turned down in review: render, with a note for the job result', () => {
    const gate = switchedOnCueGate('On-screen text', 'EP1', { enabled: true, timeline: { cues: [{ status: 'disabled' }] }, approved: 0 })
    assert.equal(gate.stop, undefined)
    assert.match(String(gate.note), /turned down in review/)
  })

  test('something approved: nothing to say', () => {
    assert.deepEqual(switchedOnCueGate('Sound', 'EP1', { enabled: true, timeline: { cues: [{ status: 'approved' }] }, approved: 1 }), {})
  })
})
