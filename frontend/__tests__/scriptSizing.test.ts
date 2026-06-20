import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  parseSuggestedMinutes,
  resolveEpisodeScriptSizing,
} from '../utils/scriptSizing.js'

describe('script episode sizing', () => {
  test('parses the episode duration instead of treating every non-60 value as 45 minutes', () => {
    assert.equal(parseSuggestedMinutes('10 min'), 10)
    assert.equal(parseSuggestedMinutes('20 minutes'), 20)
    assert.equal(parseSuggestedMinutes(8), 8)
  })

  test('uses the effective format structure when an old episode suggestion is outside its range', () => {
    const sizing = resolveEpisodeScriptSizing({
      suggestedChapters: 1,
      suggestedLength: '10 min',
      formatDefaultChapters: 3,
      formatDefaultLengthMinutes: 10,
      chapterCountRange: [3, 5],
      wordsPerMinute: 130,
    })

    assert.deepEqual(sizing, {
      chapters: 3,
      wordsPerChapter: 433,
    })
  })

  test('keeps a valid episode-specific chapter suggestion', () => {
    const sizing = resolveEpisodeScriptSizing({
      suggestedChapters: 4,
      suggestedLength: '20 min',
      formatDefaultChapters: 3,
      formatDefaultLengthMinutes: 10,
      chapterCountRange: [3, 5],
      wordsPerMinute: 130,
    })

    assert.deepEqual(sizing, {
      chapters: 4,
      wordsPerChapter: 650,
    })
  })
})
