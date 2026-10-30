/**
 * One sizing resolution for every script path (2026-10-30, DM0021).
 *
 * Its outline was 20 chapters; a `force` rebuild carrying only `force`, `model`,
 * `title` and `episode_id` produced 6 and said nothing, because an outline build
 * read the request and ignored the episode's own recorded plan. A rebuild is the
 * same episode, so its own sizing wins next to the request; the Formula default
 * is the last resort and is always said out loud.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  NEUTRAL_WORDS_PER_CHAPTER,
  describeScriptSizingSource,
  resolveScriptSizing,
} from '../lib/script-sizing.js'

const formula = { chapters: 6, length: 30, wordsPerMinute: 150 }

test('a force rebuild with no sizing keeps the episode\'s own chapter count', () => {
  const sizing = resolveScriptSizing({
    prefer: 'request',
    requested: {},
    episode: { chapters: 20, length: 120, words_per_chapter: 600 },
    formula,
  })
  assert.equal(sizing.chapters, 20, 'the 20 the episode already had, not the Formula\'s 6')
  assert.equal(sizing.sources.chapters, 'episode')
  assert.equal(sizing.wordsPerChapter, 600)
  assert.equal(sizing.sources.words, 'episode')
  assert.equal(sizing.length, 120)
  assert.equal(sizing.sources.length, 'episode')
})

test('an explicit request still wins on a rebuild', () => {
  const sizing = resolveScriptSizing({
    prefer: 'request',
    requested: { chapters: 12, length: 45, words_per_chapter: 500 },
    episode: { chapters: 20, length: 120, words_per_chapter: 600 },
    formula,
  })
  assert.equal(sizing.chapters, 12)
  assert.equal(sizing.sources.chapters, 'request')
  assert.equal(sizing.length, 45)
  assert.equal(sizing.wordsPerChapter, 500)
})

test('a first build uses the Formula and says so', () => {
  const sizing = resolveScriptSizing({ prefer: 'request', requested: {}, episode: null, formula })
  assert.equal(sizing.chapters, 6)
  assert.equal(sizing.sources.chapters, 'formula')
  assert.equal(sizing.length, 30)
  assert.equal(sizing.sources.length, 'formula')
  assert.equal(sizing.wordsPerChapter, 750, '30 min × 150 wpm ÷ 6 chapters')
  assert.equal(sizing.sources.words, 'formula')
})

test('expansion prefers the episode\'s outline over the request (sidecar semantics)', () => {
  const sizing = resolveScriptSizing({
    prefer: 'episode',
    requested: { chapters: 3 },
    episode: { chapters: 20 },
    formula,
  })
  assert.equal(sizing.chapters, 20)
  assert.equal(sizing.sources.chapters, 'episode')
})

test('word sizing follows the documented order, and the neutral default names itself', () => {
  const fromTotal = resolveScriptSizing({
    prefer: 'request', requested: { chapters: 10, total_words: 5_000 }, formula,
  })
  assert.equal(fromTotal.wordsPerChapter, 500, 'the total is divided across the chapters')

  const neutral = resolveScriptSizing({
    prefer: 'request',
    requested: { chapters: 4 },
    formula: { chapters: 4 },
  })
  assert.equal(neutral.wordsPerChapter, NEUTRAL_WORDS_PER_CHAPTER)
  assert.equal(neutral.sources.words, 'default')
  assert.match(describeScriptSizingSource(neutral.sources.words), /neutral default/)
  assert.match(describeScriptSizingSource(fromTotal.sources.words), /this run's request/)
})
