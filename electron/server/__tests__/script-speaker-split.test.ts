/**
 * Tests for the speaker-tag splitter (lib/script-speaker-split.ts) used by
 * Phase 6 multi-character voice routing in audio generation.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  splitTextBySpeaker,
  hasSpeakerTags,
  selectVoiceForSpeaker,
} from '../lib/script-speaker-split.js'

describe('splitTextBySpeaker', () => {
  test('plain narration returns one untagged segment', () => {
    const out = splitTextBySpeaker('Once upon a time, a knight rode east.')
    assert.equal(out.length, 1)
    assert.equal(out[0].speaker, null)
    assert.equal(out[0].text, 'Once upon a time, a knight rode east.')
  })

  test('empty string returns empty array', () => {
    assert.deepEqual(splitTextBySpeaker(''), [])
    assert.deepEqual(splitTextBySpeaker('   \n  \n  '), [])
  })

  test('single speaker tag at line start', () => {
    const out = splitTextBySpeaker('[Aria]: Where are we going?')
    assert.equal(out.length, 1)
    assert.equal(out[0].speaker, 'Aria')
    assert.equal(out[0].text, 'Where are we going?')
  })

  test('alternating tags split into segments in order', () => {
    const text = `[Aria]: Where are we?
[Brick]: Lost.
[Aria]: I figured.`
    const out = splitTextBySpeaker(text)
    assert.equal(out.length, 3)
    assert.deepEqual(out.map(s => s.speaker), ['Aria', 'Brick', 'Aria'])
    assert.deepEqual(out.map(s => s.text), ['Where are we?', 'Lost.', 'I figured.'])
  })

  test('narration before, between, and after tags (paragraph-separated)', () => {
    // Real LLM output uses blank-line paragraph breaks between speaker
    // turns and narration. Each blank line ends a speaker segment.
    const text = `Aria looked up at the sky.

[Aria]: Where are we?

She paused, listening.

[Brick]: Lost.

They kept walking.`
    const out = splitTextBySpeaker(text)
    assert.deepEqual(out.map(s => s.speaker), [null, 'Aria', null, 'Brick', null])
    assert.equal(out[0].text, 'Aria looked up at the sky.')
    assert.equal(out[2].text, 'She paused, listening.')
    assert.equal(out[4].text, 'They kept walking.')
  })

  test('multi-line dialog under one tag preserved', () => {
    const text = `[Aria]: This is the first line.
And this continues the same speech.
A third line.
[Brick]: My turn now.`
    const out = splitTextBySpeaker(text)
    assert.equal(out.length, 2)
    assert.equal(out[0].speaker, 'Aria')
    assert.equal(out[0].text, 'This is the first line.\nAnd this continues the same speech.\nA third line.')
    assert.equal(out[1].speaker, 'Brick')
  })

  test('blank line ends a speaker segment (next paragraph is narration unless retagged)', () => {
    // Per the parser convention: blank line = paragraph break; subsequent
    // untagged lines are narration. The LLM is instructed to re-tag every
    // dialog turn rather than rely on tag inheritance.
    const text = `[Aria]: Paragraph one of dialog.

Now this is narration.

[Brick]: My turn.`
    const out = splitTextBySpeaker(text)
    assert.deepEqual(out.map(s => s.speaker), ['Aria', null, 'Brick'])
    assert.equal(out[0].text, 'Paragraph one of dialog.')
    assert.equal(out[1].text, 'Now this is narration.')
    assert.equal(out[2].text, 'My turn.')
  })

  test('speaker name with spaces supported', () => {
    const out = splitTextBySpeaker('[Aria the Knight]: Hello.')
    assert.equal(out[0].speaker, 'Aria the Knight')
  })

  test('tag without colon is NOT treated as a speaker tag', () => {
    const out = splitTextBySpeaker('[Stage direction] She enters the room.\nNarration follows.')
    assert.equal(out.length, 1)
    assert.equal(out[0].speaker, null)
    assert.ok(out[0].text.includes('Stage direction'))
  })

  test('inline [name]: mid-paragraph is NOT a tag (must be at line start)', () => {
    const out = splitTextBySpeaker('She replied [tired]: yes, of course.')
    assert.equal(out.length, 1)
    assert.equal(out[0].speaker, null)
  })

  test('leading whitespace before tag is tolerated', () => {
    const out = splitTextBySpeaker('   [Aria]: Indented dialog.')
    assert.equal(out[0].speaker, 'Aria')
    assert.equal(out[0].text, 'Indented dialog.')
  })

  test('tag with empty content + immediate continuation line', () => {
    const out = splitTextBySpeaker('[Aria]:\nThe content arrived on the next line.')
    assert.equal(out.length, 1)
    assert.equal(out[0].speaker, 'Aria')
    assert.equal(out[0].text, 'The content arrived on the next line.')
  })
})

describe('hasSpeakerTags', () => {
  test('true when at least one tag exists', () => {
    assert.equal(hasSpeakerTags('Plain text.\n[Aria]: hi'), true)
    assert.equal(hasSpeakerTags('   [Aria]: hi'), true)
  })

  test('false for plain narration', () => {
    assert.equal(hasSpeakerTags('No tags here.'), false)
    assert.equal(hasSpeakerTags(''), false)
    assert.equal(hasSpeakerTags('She replied [tired]: yes'), false, 'inline brackets are not tags')
  })
})

describe('selectVoiceForSpeaker', () => {
  const cast = [
    { name: 'Aria', speech: { voiceId: 'voice-aria' } },
    { name: 'Brick', speech: { voiceId: 'voice-brick' } },
    { name: 'Mute', speech: {} },  // no voiceId
  ]
  const NARRATOR = 'voice-narrator'

  test('untagged segment → narrator voice', () => {
    assert.equal(selectVoiceForSpeaker(null, cast, NARRATOR), 'voice-narrator')
  })

  test('matching speaker (case-insensitive) → character voice', () => {
    assert.equal(selectVoiceForSpeaker('Aria', cast, NARRATOR), 'voice-aria')
    assert.equal(selectVoiceForSpeaker('aria', cast, NARRATOR), 'voice-aria')
    assert.equal(selectVoiceForSpeaker('ARIA', cast, NARRATOR), 'voice-aria')
  })

  test('unknown speaker → narrator voice (graceful fallback)', () => {
    assert.equal(selectVoiceForSpeaker('Stranger', cast, NARRATOR), 'voice-narrator')
  })

  test('character with no voiceId → narrator voice', () => {
    assert.equal(selectVoiceForSpeaker('Mute', cast, NARRATOR), 'voice-narrator')
  })

  test('narrator voice undefined → segment voice undefined too', () => {
    assert.equal(selectVoiceForSpeaker('Stranger', cast, undefined), undefined)
    assert.equal(selectVoiceForSpeaker(null, cast, undefined), undefined)
  })
})
