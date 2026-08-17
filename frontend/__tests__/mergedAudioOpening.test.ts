/**
 * v1.3.2 — the Merged Audio row must answer "is my intro in there?" without
 * ever pretending to know more than it does.
 *
 * The trap this file guards is specific: 393 merged files already on the
 * owner's disk carry the old completion record with no intro information, and
 * the tempting fix is to read the current Audio Assembly settings and describe
 * them as though they described the file. They do not — they describe now, the
 * file was made earlier. So the assertions below check the WORDING, not just
 * the branch: a measured line must say the cause is unrecorded, and no line
 * may name an intro file the record did not name.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  describeMergedAudioOpening,
  type MergedAudioOpening,
} from '../utils/merged-audio-opening'

const base: MergedAudioOpening = {
  source: 'measured',
  lead_in_sec: 0,
  intro: null,
  music_lead_in_sec: null,
  reason: null,
}

describe('merged audio opening line', () => {
  test('no opening data renders nothing rather than a guess', () => {
    assert.equal(describeMergedAudioOpening(null), null)
    assert.equal(describeMergedAudioOpening(undefined), null)
  })

  test('a recorded intro is named, with its gap and the resulting start', () => {
    const line = describeMergedAudioOpening({
      source: 'recorded',
      lead_in_sec: 14.4,
      intro: { filename: 'Boundless_Intro.mp3', duration_sec: 12.4, gap_after_sec: 2 },
      music_lead_in_sec: 0,
      reason: null,
    })!
    assert.equal(line.certainty, 'stated')
    assert.equal(line.hasIntro, true)
    assert.match(line.text, /Intro included/)
    assert.match(line.text, /Boundless_Intro\.mp3/)
    assert.match(line.text, /12\.4s/)
    assert.match(line.text, /2\.0s gap/)
    assert.match(line.text, /narration starts at 14\.4s/)
  })

  test('a recorded merge with no intro says so plainly', () => {
    const line = describeMergedAudioOpening({
      source: 'recorded',
      lead_in_sec: 0,
      intro: null,
      music_lead_in_sec: 0,
      reason: null,
    })!
    assert.equal(line.certainty, 'stated')
    assert.equal(line.hasIntro, false)
    assert.equal(line.text, 'No intro — narration only.')
  })

  test('a music lead-in is not reported as an intro', () => {
    const line = describeMergedAudioOpening({
      source: 'recorded',
      lead_in_sec: 6,
      intro: null,
      music_lead_in_sec: 6,
      reason: null,
    })!
    assert.equal(line.hasIntro, false)
    assert.match(line.text, /No intro file/)
    assert.match(line.text, /6\.0s music lead-in/)
  })

  test('both an intro and a music lead-in are itemised', () => {
    const line = describeMergedAudioOpening({
      source: 'recorded',
      lead_in_sec: 20.4,
      intro: { filename: 'intro.mp3', duration_sec: 12.4, gap_after_sec: 2 },
      music_lead_in_sec: 6,
      reason: null,
    })!
    assert.match(line.text, /intro\.mp3/)
    assert.match(line.text, /2\.0s gap/)
    assert.match(line.text, /6\.0s music lead-in/)
    assert.match(line.text, /20\.4s/)
  })

  test('an old-schema file with a lead-in states the seconds and refuses to name a cause', () => {
    const line = describeMergedAudioOpening({ ...base, lead_in_sec: 16.066 })!
    assert.equal(line.certainty, 'measured')
    assert.equal(line.hasIntro, false)
    assert.match(line.text, /16\.1s plays before the narration/)
    // The whole point: it must not claim to know which of the two it was.
    assert.match(line.text, /can't say whether that is your intro or a music lead-in/i)
    assert.match(line.text, /re-merging records it/i)
  })

  test('an old-schema file with no lead-in is still a complete answer', () => {
    const line = describeMergedAudioOpening({ ...base, lead_in_sec: 0 })!
    assert.equal(line.certainty, 'measured')
    assert.equal(line.text, 'No intro — the narration starts immediately.')
  })

  test('an unmeasurable file says so and repeats the reason verbatim', () => {
    const line = describeMergedAudioOpening({
      source: 'unmeasurable',
      lead_in_sec: null,
      intro: null,
      music_lead_in_sec: null,
      reason: 'the chapter-duration sidecar (audio_chapters.json) is missing.',
    })!
    assert.equal(line.certainty, 'unknown')
    assert.equal(line.hasIntro, false)
    assert.match(line.text, /Can't say what plays before the narration/)
    assert.match(line.text, /audio_chapters\.json/)
  })

  test('no wording anywhere claims an intro that was only measured', () => {
    for (const lead of [0, 0.5, 5, 16.066, 120]) {
      const line = describeMergedAudioOpening({ ...base, lead_in_sec: lead })!
      assert.equal(line.hasIntro, false, `lead ${lead}`)
      assert.doesNotMatch(line.text, /Intro included/, `lead ${lead}`)
    }
  })
})
