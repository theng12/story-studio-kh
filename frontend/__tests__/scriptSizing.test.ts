import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  effectiveFormatPathForEpisode,
  parseSuggestedMinutes,
  refreshScriptFormatState,
  resolveEpisodeScriptSizing,
  scriptDeepLinkQuery,
  type ScriptFormatRefreshState,
} from '../utils/scriptSizing.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function formatResponse(options: {
  name: string
  chapters: number
  minutes: number
  wpm: number
  narrator: string
}) {
  return {
    id: options.name.toLowerCase(), name: options.name, description: `${options.name} format. More detail.`,
    script: {
      defaultChapterCount: options.chapters,
      chapterCountRange: [options.chapters, options.chapters + 2],
      defaultLengthMinutes: options.minutes,
      lengthMinutesRange: [options.minutes, options.minutes + 10],
      durationPresets: [options.minutes],
      defaultWordsPerMinute: options.wpm,
      narratorStyles: [{ id: options.narrator, label: options.narrator, description: options.narrator }],
      defaultNarratorStyleId: options.narrator,
    },
  }
}

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

  test('an in-flight profile refresh installs context but preserves preset-owned sizing', async () => {
    const response = deferred<ReturnType<typeof formatResponse>>()
    const state: ScriptFormatRefreshState = {
      selectedEpisodeCode: 'EP0001', sizingTouched: false,
      chapters: 9, wordsPerChapter: 700,
      formatContext: null,
    }
    const refresh = refreshScriptFormatState({
      state,
      requestedEpisodeCode: 'EP0001',
      load: () => response.promise,
      suggestedChapters: 6,
      suggestedLength: '25 min',
    })

    state.sizingTouched = true
    state.chapters = 3
    state.wordsPerChapter = 1000
    response.resolve(formatResponse({ name: 'Daily', chapters: 6, minutes: 25, wpm: 125, narrator: 'daily-a' }))
    assert.equal(await refresh, true)
    assert.equal(state.formatContext?.defaultNarratorStyleId, 'daily-a')
    assert.equal(state.formatContext?.defaultWordsPerMinute, 125)
    assert.deepEqual({ chapters: state.chapters, wordsPerChapter: state.wordsPerChapter }, {
      chapters: 3, wordsPerChapter: 1000,
    })
  })

  test('an untouched refresh derives sizing from the newly installed profile WPM', async () => {
    const state: ScriptFormatRefreshState = {
      selectedEpisodeCode: 'EP0001', sizingTouched: false,
      chapters: 10, wordsPerChapter: 550,
      formatContext: {
        id: 'old', name: 'Old', summary: '', defaultChapterCount: 10, defaultLengthMinutes: 50,
        chapterCountRange: [8, 12], lengthMinutesRange: [40, 60], durationPresets: [50],
        defaultWordsPerMinute: 200, defaultWordsPerChapter: null,
        narratorStyles: [], defaultNarratorStyleId: 'old-a',
      },
    }
    await refreshScriptFormatState({
      state,
      requestedEpisodeCode: 'EP0001',
      load: async () => formatResponse({ name: 'Daily', chapters: 5, minutes: 25, wpm: 125, narrator: 'daily-a' }),
      suggestedChapters: 5,
      suggestedLength: '25 min',
    })
    assert.equal(state.formatContext?.defaultWordsPerMinute, 125)
    assert.deepEqual({ chapters: state.chapters, wordsPerChapter: state.wordsPerChapter }, {
      chapters: 5, wordsPerChapter: 625,
    })
  })

  test('a selected profile wins an async mount-versus-selection race', async () => {
    const mountResponse = deferred<ReturnType<typeof formatResponse>>()
    const selectedResponse = deferred<ReturnType<typeof formatResponse>>()
    const state: ScriptFormatRefreshState = {
      selectedEpisodeCode: '', sizingTouched: false,
      chapters: 10, wordsPerChapter: 550, formatContext: null,
    }
    const mount = refreshScriptFormatState({
      state, requestedEpisodeCode: '', load: () => mountResponse.promise,
    })

    state.selectedEpisodeCode = 'EP0002'
    const selected = refreshScriptFormatState({
      state, requestedEpisodeCode: 'EP0002', load: () => selectedResponse.promise,
      suggestedChapters: 8, suggestedLength: '40 min',
    })
    selectedResponse.resolve(formatResponse({ name: 'Teaching', chapters: 8, minutes: 40, wpm: 145, narrator: 'teaching-a' }))
    assert.equal(await selected, true)
    mountResponse.resolve(formatResponse({ name: 'Parent', chapters: 5, minutes: 20, wpm: 100, narrator: 'parent-a' }))
    assert.equal(await mount, false)

    assert.equal(state.formatContext?.name, 'Teaching')
    assert.equal(state.formatContext?.defaultNarratorStyleId, 'teaching-a')
    assert.equal(state.formatContext?.defaultWordsPerMinute, 145)
    assert.deepEqual({ chapters: state.chapters, wordsPerChapter: state.wordsPerChapter }, {
      chapters: 8, wordsPerChapter: 725,
    })
  })

  test('no suggestion and no authoritative duration defers instead of inventing 45 minutes', () => {
    assert.equal(resolveEpisodeScriptSizing({
      suggestedChapters: 4,
      wordsPerMinute: 130,
    }), null)
  })

  test('a refresh with no authoritative duration preserves existing sizing while installing context', async () => {
    const state: ScriptFormatRefreshState = {
      selectedEpisodeCode: 'EP0003', sizingTouched: false,
      chapters: 7, wordsPerChapter: 777, formatContext: null,
    }
    const applied = await refreshScriptFormatState({
      state,
      requestedEpisodeCode: 'EP0003',
      load: async () => ({
        id: 'duration-deferred', name: 'Duration deferred',
        script: {
          defaultChapterCount: 4,
          defaultWordsPerMinute: 135,
          narratorStyles: [{ id: 'deferred-a', label: 'Deferred', description: 'Wait for owner input.' }],
          defaultNarratorStyleId: 'deferred-a',
        },
      }),
    })

    assert.equal(applied, true)
    assert.equal(state.formatContext?.defaultLengthMinutes, null)
    assert.equal(state.formatContext?.defaultNarratorStyleId, 'deferred-a')
    assert.deepEqual({ chapters: state.chapters, wordsPerChapter: state.wordsPerChapter }, {
      chapters: 7, wordsPerChapter: 777,
    })
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
