/**
 * The Introduction's recipe: what a beat MEANS, and who writes it.
 *
 * Two things the shipped stage was missing, both asked for by name:
 *
 *   "how can someone knows what's a welcome host intro is, a story teaser is,
 *    community question is? patreon? how?"
 *   "what is the model picker not added."
 *
 * The explanations live in one catalogue on the server rather than as copy in
 * the page, so there is one wording and the page cannot drift from the beats
 * it describes. The model is a channel setting whose BLANK value is a real
 * answer — "follow the Script Generator" — which is what every channel that
 * has never opened the page already has.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  BEAT_LIBRARY,
  DEFAULT_INTRODUCTION_BEATS,
  beatLinesForPrompt,
  defaultSegmentRecipe,
  normalizeChannelSegments,
  INTRODUCTION_SEGMENT_ID,
} from '../lib/episode-segments.js'

describe('every beat explains itself', () => {
  test('each default beat is in the catalogue, spelt one way', () => {
    for (const beat of DEFAULT_INTRODUCTION_BEATS) {
      const known = BEAT_LIBRARY[beat.id]
      assert.ok(known, `the default list offers "${beat.label}" with no catalogue entry`)
      assert.equal(beat.label, known.label,
        'a beat must have exactly one name; two spellings is how the page and the '
        + 'generator drifted apart before')
    }
  })

  test('each catalogue entry says what it produces and gives an example', () => {
    for (const beat of Object.values(BEAT_LIBRARY)) {
      assert.ok(beat.description.trim().length > 30,
        `"${beat.label}" needs a real explanation, not a restated label`)
      assert.ok(!beat.description.includes(beat.label),
        `"${beat.label}" explains itself with its own name, which explains nothing`)
      assert.ok(beat.example.trim().length > 0,
        `"${beat.label}" needs an example for its own wording box`)
    }
  })

  test('the beat that suits only one kind of channel says which', () => {
    // The owner's charge in full: "i think this was built for just one format
    // of video". The breathing exercise is the proof of it — a sleep beat in a
    // list every channel gets, on an app that now runs explainer, history and
    // business channels. Removing it per format is the redo; saying so is the
    // floor under the redo.
    assert.ok(BEAT_LIBRARY.relaxation.suitsNote,
      'the breathing exercise must not present itself as general-purpose')
    assert.match(BEAT_LIBRARY.relaxation.suitsNote!, /sleep/i)
  })
})

describe('a beat from the catalogue is named by the catalogue', () => {
  test('a stale or hand-edited label is healed from the id', () => {
    const segments = normalizeChannelSegments({
      introduction: {
        enabled: true,
        recipe: { beats: [{ id: 'subscribe_cta', label: 'Subscibe CTAA', enabled: true }] },
      },
    })
    assert.equal(segments.introduction.recipe.beats[0].label, BEAT_LIBRARY.subscribe_cta.label)
  })

  test('a beat somebody wrote themselves keeps its own name', () => {
    const segments = normalizeChannelSegments({
      introduction: {
        enabled: true,
        recipe: { beats: [{ id: 'custom-1', label: 'Weekly riddle', enabled: true }] },
      },
    })
    assert.equal(segments.introduction.recipe.beats[0].label, 'Weekly riddle')
  })

  test('healing a label does not change what the model is told', () => {
    const segments = normalizeChannelSegments({
      introduction: {
        enabled: true,
        recipe: {
          beats: [
            { id: 'welcome', label: 'welcome and host intro', enabled: true, custom_text: 'say hello' },
            { id: 'patreon', label: 'Patreon', enabled: false },
          ],
        },
      },
    })
    assert.deepEqual(beatLinesForPrompt(segments.introduction.recipe), [
      `${BEAT_LIBRARY.welcome.label} — specifically cover: say hello`,
    ])
  })
})

describe('which model writes the opening', () => {
  test('a channel that has said nothing has a blank model, which is a real answer', () => {
    const recipe = defaultSegmentRecipe(INTRODUCTION_SEGMENT_ID)
    assert.equal(recipe.model, '',
      'blank means "follow the Script Generator" — the behaviour every channel already has. '
      + 'Anything else here would switch untouched channels onto a product nobody chose.')
  })

  test('a saved choice survives a read, trimmed', () => {
    const segments = normalizeChannelSegments({
      introduction: { enabled: true, recipe: { model: '  the-owners-pick  ' } },
    })
    assert.equal(segments.introduction.recipe.model, 'the-owners-pick')
  })

  test('a config carrying rubbish in that field falls back to blank, never to a guess', () => {
    const segments = normalizeChannelSegments({
      introduction: { enabled: true, recipe: { model: { id: 'not-a-string' } } },
    })
    assert.equal(segments.introduction.recipe.model, '')
  })
})
