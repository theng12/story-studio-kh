import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  effectiveFormatPathForEpisode,
  episodeFormatResponseMatchesSelection,
  parseSuggestedMinutes,
  resolveEpisodeScriptSizing,
  scriptDeepLinkQuery,
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

  test('requests the effective format for the selected accepted episode', () => {
    assert.equal(
      effectiveFormatPathForEpisode('pastoral-channel', 'PS 001/2'),
      '/projects/pastoral-channel/effective-format?episode_id=PS%20001%2F2',
    )
    assert.equal(
      effectiveFormatPathForEpisode('pastoral-channel', ''),
      '/projects/pastoral-channel/effective-format',
    )
  })

  test('ignores an effective-format response after a newer episode is selected', () => {
    assert.equal(episodeFormatResponseMatchesSelection('EP0001', 'EP0002'), false)
    assert.equal(episodeFormatResponseMatchesSelection('EP0002', 'EP0002'), true)
    assert.equal(episodeFormatResponseMatchesSelection('', 'EP0002'), true)
  })

  test('Ideas deep-links the truthful suggested duration instead of mapping every non-60 value to 45', () => {
    assert.deepEqual(scriptDeepLinkQuery({
      episodeCode: 'PS0007',
      title: 'A Daily Reflection',
      suggestedChapters: 6,
      suggestedLength: '25 min',
    }), {
      episode_id: 'PS0007',
      title: 'A Daily Reflection',
      chapters: 6,
      length: '25',
    })
  })
})
