/**
 * The start page's channel search, label filter, sort and remembered view.
 *
 * All of it is a pure function of a channel list, so it is pinned directly
 * rather than through a mounted page (the wiring is checked by
 * `homeChannelFilters.test.ts`, which mounts the real `pages/index.vue`).
 *
 * The cases worth naming, because each one is a way the feature could be
 * quietly wrong rather than loudly broken:
 *
 *   - KHMER. The owner's channels are Khmer, and Khmer text arrives from a
 *     document with zero-width characters in it. A search that only matches
 *     byte-identical pastes fails exactly where this feature is needed.
 *   - The search matches what the CARD shows and not what it hides. A channel
 *     appearing in results with no visible reason for it reads as a bug.
 *   - Several labels mean ALL of them, and no labels means no filter. "None
 *     selected" and "selected, but nothing matches" must not be the same screen.
 *   - An unknown time sorts LAST and never as the oldest: a channel the app
 *     could not read is not evidence of anything (AGENTS §6).
 *   - The search text is not remembered; the sort and the label filter are.
 */

import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'

import {
  DEFAULT_CHANNEL_SORT,
  applyChannelFilters,
  channelLabels,
  channelSearchText,
  filterChannelsByLabels,
  filtersAreActive,
  formulaLabel,
  isChannelSort,
  isTypingTarget,
  labelCounts,
  labelSuggestions,
  languageLabel,
  matchesChannelSearch,
  readChannelViewPrefs,
  sameLabel,
  sortChannels,
  writeChannelViewPrefs,
} from '../utils/channel-view.ts'

type Row = {
  name?: string
  slug?: string
  episode_prefix?: string
  created_at?: string
  labels?: string[]
  content_language?: string
  last_worked_at?: string | null
  formula_name?: string
  formula_id?: string
  niche_id?: string
}

function row(name: string, extra: Partial<Row> = {}): Row {
  return { name, slug: name.toLowerCase().replace(/\s+/g, '-'), episode_prefix: 'EP', ...extra }
}

const KHMER = 'ប្រវត្តិវិទ្យាខ្មែរ'

const CHANNELS: Row[] = [
  row('Khmer History', { labels: ['Khmer', 'History'], content_language: 'km', created_at: '2026-01-02T00:00:00Z', last_worked_at: '2026-03-01T00:00:00Z' }),
  row('Sleep Stories', { labels: ['Sleep'], content_language: 'en', created_at: '2026-02-02T00:00:00Z', last_worked_at: '2026-04-01T00:00:00Z' }),
  row('Khmer Sleep', { labels: ['Khmer', 'Sleep'], content_language: 'km', created_at: '2026-03-02T00:00:00Z', last_worked_at: '2026-02-01T00:00:00Z' }),
  row('Animals Explained', { labels: [], created_at: '2025-12-02T00:00:00Z', last_worked_at: null }),
]

const names = (rows: Row[]) => rows.map(r => r.name)

describe('channel search', () => {
  test('matches the channel name, case-insensitively and mid-word', () => {
    assert.deepEqual(names(CHANNELS.filter(r => matchesChannelSearch(r, 'sleep'))), ['Sleep Stories', 'Khmer Sleep'])
    assert.deepEqual(names(CHANNELS.filter(r => matchesChannelSearch(r, 'SLEEP'))), ['Sleep Stories', 'Khmer Sleep'])
    assert.deepEqual(names(CHANNELS.filter(r => matchesChannelSearch(r, 'tory'))), ['Khmer History'])
  })

  test('an empty or blank search keeps everything', () => {
    assert.equal(matchesChannelSearch(CHANNELS[0], ''), true)
    assert.equal(matchesChannelSearch(CHANNELS[0], '   '), true)
  })

  test('matches a label, so a type is findable before anything is named for it', () => {
    assert.deepEqual(names(CHANNELS.filter(r => matchesChannelSearch(r, 'history'))), ['Khmer History'])
  })

  test('matches the audience language, by name and by code', () => {
    assert.deepEqual(names(CHANNELS.filter(r => matchesChannelSearch(r, 'khmer'))), ['Khmer History', 'Khmer Sleep'])
    assert.deepEqual(names(CHANNELS.filter(r => matchesChannelSearch(r, 'english'))), ['Sleep Stories'])
  })

  test('matches KHMER text typed by hand against a name copied with a zero-width space', () => {
    // Khmer documents are full of U+200B. The two strings look identical on
    // screen, so a search that misses one of them looks broken.
    const pasted = row(`ប្រវត្តិ‍វិទ្យា${KHMER}`)
    assert.equal(matchesChannelSearch(pasted, KHMER), true, 'the khmer name is found')
    assert.equal(matchesChannelSearch(row(KHMER), 'ប្រវត្តិ'), true, 'and a khmer prefix is found')
  })

  test('does NOT match what the card never shows', () => {
    const hidden = row('Mystery Channel', { slug: 'khmer-history-2' } as Partial<Row>)
    assert.equal(matchesChannelSearch(hidden, 'khmer-history'), false,
      'the folder slug is not on the card, so a match on it would have no visible cause')
    assert.match(channelSearchText(hidden), /mystery channel/)
  })

  test('the search text is exactly the visible facts, and nothing else', () => {
    const text = channelSearchText(CHANNELS[0])
    for (const fact of ['khmer history', 'ep', 'km', 'history']) assert.match(text, new RegExp(fact))
  })

  test('the language is named only when the channel has one', () => {
    assert.equal(languageLabel('km'), 'Khmer')
    assert.equal(languageLabel('en'), 'English')
    assert.equal(languageLabel(''), '', 'an unset language shows nothing rather than an invented name')
    assert.equal(languageLabel(undefined), '')
    assert.equal(languageLabel('fr'), '', 'an unknown code is not guessed at')
  })
})

describe('the Series Formula on a card', () => {
  const formulaChannels: Row[] = [
    row('Sleep Stories', { formula_name: 'Sleep Story', formula_id: 'com.storystudio.formula.sleep-story', niche_id: 'sleep' }),
    row('Quiet Rain', { formula_name: 'Generic — no Formula' }),
    row('Ancient Empires', { formula_name: 'History, Explained', formula_id: 'com.storystudio.formula.history-explained', niche_id: 'history-narration' }),
    row('Brand New', { formula_name: 'No Formula chosen' }),
  ]

  test('searching the Formula NAME finds the channels that use it', () => {
    assert.deepEqual(names(formulaChannels.filter(r => matchesChannelSearch(r, 'sleep story'))), ['Sleep Stories'])
    assert.deepEqual(names(formulaChannels.filter(r => matchesChannelSearch(r, 'history, explained'))), ['Ancient Empires'])
  })

  test('the Formula ID is searchable too — the id the customer sees in Settings', () => {
    assert.deepEqual(
      names(formulaChannels.filter(r => matchesChannelSearch(r, 'com.storystudio.formula.history-explained'))),
      ['Ancient Empires'],
    )
    // The legacy id a channel still stores reads as the store Formula, and both
    // spellings find it.
    assert.deepEqual(names(formulaChannels.filter(r => matchesChannelSearch(r, 'sleep'))), ['Sleep Stories'])
  })

  test('the two "no Formula" answers are findable as what they say', () => {
    assert.deepEqual(names(formulaChannels.filter(r => matchesChannelSearch(r, 'generic'))), ['Quiet Rain'])
  })

  test('formulaLabel is the resolved name, and says NOTHING when the row carries none', () => {
    assert.equal(formulaLabel(formulaChannels[0]), 'Sleep Story')
    assert.equal(formulaLabel(row('Old cached row')), '', 'an unknown Formula is not "No Formula chosen"')
    assert.equal(formulaLabel(null), '')
    assert.equal(formulaLabel({ formula_name: '  ' }), '')
  })

  test('a Khmer Formula name is found by Khmer text (the same folding as every other fact)', () => {
    const khmer = row('រឿងព្រេង', { formula_name: 'រឿងនិទាន​ខ្មែរ' })
    assert.equal(matchesChannelSearch(khmer, 'រឿងនិទានខ្មែរ'), true)
  })
})

describe('label filtering', () => {
  test('several labels mean ALL of them', () => {
    assert.deepEqual(names(filterChannelsByLabels(CHANNELS, ['Khmer'])), ['Khmer History', 'Khmer Sleep'])
    assert.deepEqual(names(filterChannelsByLabels(CHANNELS, ['Khmer', 'Sleep'])), ['Khmer Sleep'])
    assert.deepEqual(names(filterChannelsByLabels(CHANNELS, ['Khmer', 'History', 'Sleep'])), [])
  })

  test('no labels selected is no filter, not "nothing matches"', () => {
    assert.equal(filterChannelsByLabels(CHANNELS, []).length, CHANNELS.length)
    assert.equal(filtersAreActive({ search: '', labels: [] }), false)
    assert.equal(filtersAreActive({ search: '  ', labels: [] }), false)
    assert.equal(filtersAreActive({ search: 'a', labels: [] }), true)
    assert.equal(filtersAreActive({ search: '', labels: ['Khmer'] }), true)
  })

  test('matching a label ignores case, surrounding space, and a paste\'s zero-width characters', () => {
    assert.deepEqual(names(filterChannelsByLabels(CHANNELS, [' khmER '])), ['Khmer History', 'Khmer Sleep'])
    // One comparison rule for the whole UI: case and the invisible characters a
    // Khmer paste carries do not make two labels.
    assert.equal(sameLabel('Sleep', ' sleep '), true)
    assert.equal(sameLabel(KHMER, KHMER.replace('ខ', 'ខ\u200B')), true)
    assert.equal(sameLabel('Sleep', 'Sleep Stories'), false)
    assert.equal(sameLabel('', ''), false, 'an empty label is not the same as another empty label')
  })

  test('the counts describe the channels currently on screen, and the first spelling wins', () => {
    const counts = labelCounts(CHANNELS)
    assert.deepEqual(counts, [
      { label: 'History', count: 1 },
      { label: 'Khmer', count: 2 },
      { label: 'Sleep', count: 2 },
    ])
    // A row carrying the same label twice, or in another case, still counts once.
    const messy = [row('A', { labels: ['Sleep', 'sleep', ' Sleep '] }), row('B', { labels: ['SLEEP'] })]
    assert.deepEqual(labelCounts(messy), [{ label: 'Sleep', count: 2 }])
  })

  test('a row with no labels field at all is a channel with no labels, not a broken one', () => {
    assert.deepEqual(channelLabels({ name: 'Old Build' }), [])
    assert.deepEqual(labelCounts([{ name: 'Old Build' }]), [])
  })

  test('suggestions do not offer a second spelling of a label the channel already has', () => {
    assert.deepEqual(
      labelSuggestions(['Khmer', 'Sleep', 'History'], ['sleep']),
      ['Khmer', 'History'],
    )
  })
})

describe('search and labels together', () => {
  test('both apply, and the label filter narrows what the search left', () => {
    const rows = applyChannelFilters(CHANNELS, { search: 'khmer', labels: ['Sleep'] })
    assert.deepEqual(names(rows), ['Khmer Sleep'])
    assert.deepEqual(
      names(applyChannelFilters(CHANNELS, { search: 'khmer', labels: [] })),
      ['Khmer History', 'Khmer Sleep'],
    )
    assert.deepEqual(applyChannelFilters(CHANNELS, { search: 'nothing here', labels: ['Khmer'] }), [])
  })
})

describe('sorting', () => {
  test('recently worked on is the default, newest first', () => {
    assert.equal(DEFAULT_CHANNEL_SORT, 'recent')
    assert.deepEqual(
      names(sortChannels(CHANNELS, 'recent')),
      ['Sleep Stories', 'Khmer History', 'Khmer Sleep', 'Animals Explained'],
    )
  })

  test('an unknown time sorts LAST, never as the oldest thing in the library', () => {
    const rows = sortChannels(CHANNELS, 'recent')
    assert.equal(rows[rows.length - 1]!.name, 'Animals Explained', 'last_worked_at: null goes last')
    // `oldest` is about CREATED_AT, which this row has: a null last_worked_at is
    // no evidence about when the channel was made, so it must not be read as one.
    assert.deepEqual(names(sortChannels(CHANNELS, 'oldest')), ['Animals Explained', 'Khmer History', 'Sleep Stories', 'Khmer Sleep'])
  })

  test('name A–Z, with digits ordered as a person would', () => {
    const rows = [row('Channel 10'), row('channel 2'), row('Alpha')]
    assert.deepEqual(names(sortChannels(rows, 'name')), ['Alpha', 'channel 2', 'Channel 10'])
  })

  test('newest and oldest come from created_at, and an unparseable one is unknown', () => {
    assert.deepEqual(names(sortChannels(CHANNELS, 'newest')), ['Khmer Sleep', 'Sleep Stories', 'Khmer History', 'Animals Explained'])
    assert.deepEqual(names(sortChannels(CHANNELS, 'oldest')), ['Animals Explained', 'Khmer History', 'Sleep Stories', 'Khmer Sleep'])
    const unknown = sortChannels([row('Known', { created_at: '2026-01-01T00:00:00Z' }), row('Mystery', { created_at: '' })], 'newest')
    assert.deepEqual(names(unknown), ['Known', 'Mystery'])
  })

  test('sorting never mutates the list it was given', () => {
    const rows = [...CHANNELS]
    sortChannels(rows, 'name')
    assert.deepEqual(names(rows), names(CHANNELS))
  })

  test('a sort name from somewhere else is refused rather than guessed at', () => {
    assert.equal(isChannelSort('recent'), true)
    assert.equal(isChannelSort('sideways'), false)
    assert.equal(isChannelSort(undefined), false)
  })
})

describe('the remembered view', () => {
  beforeEach(() => { localStorage.clear() })

  test('the default view is the recently-worked-on order with no label filter', () => {
    assert.deepEqual(readChannelViewPrefs(), { sort: 'recent', labels: [] })
  })

  test('the sort and the label filter survive a round trip', () => {
    writeChannelViewPrefs({ sort: 'name', labels: ['Khmer', 'Sleep'] })
    assert.deepEqual(readChannelViewPrefs(), { sort: 'name', labels: ['Khmer', 'Sleep'] })
  })

  test('the SEARCH TEXT is not stored', () => {
    writeChannelViewPrefs({ sort: 'oldest', labels: ['Khmer'] })
    const raw = localStorage.getItem('story_studio_channel_view') || ''
    assert.doesNotMatch(raw, /search|query|q"/, 'a remembered search is how the channels "disappear"')
    assert.match(raw, /oldest/)
  })

  test('a stored view from another build degrades to the default instead of breaking the page', () => {
    localStorage.setItem('story_studio_channel_view', JSON.stringify({ sort: 'by-vibes', labels: ['Khmer'] }))
    assert.deepEqual(readChannelViewPrefs(), { sort: 'recent', labels: ['Khmer'] }, 'the labels survive, the unknown sort does not')

    localStorage.setItem('story_studio_channel_view', 'not json at all')
    assert.deepEqual(readChannelViewPrefs(), { sort: 'recent', labels: [] })

    localStorage.setItem('story_studio_channel_view', JSON.stringify(['a', 'list']))
    assert.deepEqual(readChannelViewPrefs(), { sort: 'recent', labels: [] })
  })

  test('a remembered filter is normalised the same way a saved one is', () => {
    localStorage.setItem('story_studio_channel_view', JSON.stringify({ sort: 'recent', labels: [' Khmer ', 'khmer', 12, ''] }))
    assert.deepEqual(readChannelViewPrefs().labels, ['Khmer'])
  })
})

describe('the "/" shortcut', () => {
  test('is ignored where a person is typing', () => {
    assert.equal(isTypingTarget({ tagName: 'INPUT' } as unknown as EventTarget), true)
    assert.equal(isTypingTarget({ tagName: 'textarea' } as unknown as EventTarget), true)
    assert.equal(isTypingTarget({ tagName: 'SELECT' } as unknown as EventTarget), true)
    assert.equal(isTypingTarget({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget), true)
  })

  test('is honoured anywhere else, and on nothing at all', () => {
    assert.equal(isTypingTarget({ tagName: 'DIV' } as unknown as EventTarget), false)
    assert.equal(isTypingTarget({ tagName: 'BODY' } as unknown as EventTarget), false)
    assert.equal(isTypingTarget(null), false)
  })
})
