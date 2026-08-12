import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { normalizeForTts, normalizeSpokenNumbers } from '../lib/tts-text.js'

test('writes historical and modern years in conventional spoken English', () => {
  const cases = [
    ['In 1871, the empire changed.', 'In eighteen seventy-one, the empire changed.'],
    ['In 1066, the invasion began.', 'In ten sixty-six, the invasion began.'],
    ['The reforms lasted from 1862–1866.', 'The reforms lasted from eighteen sixty-two to eighteen sixty-six.'],
    ['In 1905 and 2000.', 'In nineteen oh five and two thousand.'],
    ['In 2001 and 2009.', 'In two thousand one and two thousand nine.'],
    ['In 2010 and 2026.', 'In twenty ten and twenty twenty-six.'],
    ['Across the 1860s and 2010s.', 'Across the eighteen sixties and twenty tens.'],
  ]

  for (const [input, expected] of cases) {
    assert.equal(normalizeSpokenNumbers(input).text, expected, input)
  }
})

test('writes dates, quantities, decimals, percentages, and currency for speech', () => {
  const cases = [
    ['On January 18, 1871, it happened.', 'On January eighteenth, eighteen seventy-one, it happened.'],
    ['By the 19th century.', 'By the nineteenth century.'],
    ['On January 18th, 1871.', 'On January eighteenth, eighteen seventy-one.'],
    ['On February 1, 2001.', 'On February first, two thousand one.'],
    ['On 18 January 1871.', 'On eighteenth January eighteen seventy-one.'],
    ['42 percent of 1,250 people agreed.', 'forty-two percent of one thousand two hundred fifty people agreed.'],
    ['The rate was 3.5%.', 'The rate was three point five percent.'],
    ['The temperature fell to -12 degrees.', 'The temperature fell to minus twelve degrees.'],
    ['$5 million and $12.50 remained.', 'five million dollars and twelve dollars and fifty cents remained.'],
  ]

  for (const [input, expected] of cases) {
    assert.equal(normalizeSpokenNumbers(input).text, expected, input)
  }
})

test('preserves exact technical numbers and ambiguous digit forms', () => {
  const exact = [
    'Episode HMH0001 uses GPT-5.6 and Fish S2.1 in v1.0.826.',
    'Read https://example.com/archive/1871?q=42 and [the source](https://example.com/1871).',
    'Keep `1871`, citation [12], equation 2 + 2 = 4, and path /archive/1871/report.json.',
    'The timecode is 00:01:12.500, the address is 127.0.0.1, and the ratio is 16:9.',
    'Call +1 (555) 123-4567, preserve 18/01/1871, and keep (Smith, 1871).',
    'Ambiguous grouping 12,50 and equation 10 - 2 = 8 stay exact.',
  ]

  for (const input of exact) {
    assert.equal(normalizeSpokenNumbers(input).text, input)
  }
})

test('spoken-number normalization is idempotent', () => {
  const once = normalizeSpokenNumbers('On January 18, 1871, 42 percent cost $5 million.').text
  assert.equal(normalizeSpokenNumbers(once).text, once)
  assert.equal(normalizeForTts(once).text, once)
})

test('the shared TTS normalizer converts numbers before cleaning punctuation', () => {
  assert.equal(
    normalizeForTts('From 1862–1866 — a change of 42%.').text,
    'From eighteen sixty-two to eighteen sixty-six, a change of forty-two percent.',
  )
})

test('the universal script prompt requires spoken numbers but preserves exact identifiers', () => {
  const source = readFileSync(new URL('../generators/episode.ts', import.meta.url), 'utf8')
  assert.match(source, /ordinary numbers as words/i)
  assert.match(source, /1871.*eighteen seventy-one/i)
  assert.match(source, /2001.*two thousand one/i)
  assert.match(source, /2010.*twenty ten/i)
  assert.match(source, /identifiers.*URLs.*model names/i)
  assert.match(source, /structural headings.*digits/i)
})
