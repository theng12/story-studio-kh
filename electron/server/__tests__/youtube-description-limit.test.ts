/**
 * YouTube counts the description in BYTES (Data API: "a maximum length of 5000
 * bytes"). Owner decision 2026-10-07: cap at 4,900 bytes, never fail for
 * length, trim at a sentence boundary and keep the chapter list intact.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CHAPTERS_BEGIN,
  CHAPTERS_END,
  YOUTUBE_DESCRIPTION_MAX_BYTES,
  fitYouTubeDescription,
  utf8Bytes,
} from '../lib/youtube-description-limit.js'
import { snippetFromMeta } from '../lib/upload-metadata.js'
import { buildDescriptionPrompt } from '../lib/metadata-prompt.js'

// 40 Khmer characters, 120 bytes, ending in a khan.
const KHMER_SENTENCE = 'នៅពេលព្រឹកព្រលឹមមានខ្យល់បក់ពីសមុទ្រមកដល់ភូមិតូចមួយ។'
const CHAPTERS = `${CHAPTERS_BEGIN}\nCHAPTERS\n0:00 Opening\n1:10 The Harbour\n9:45 The Storm\n${CHAPTERS_END}`

describe('YouTube description byte limit', () => {
  test('the cap is 4,900 bytes', () => {
    assert.equal(YOUTUBE_DESCRIPTION_MAX_BYTES, 4900)
  })

  test('a description under the limit is untouched', () => {
    const fitted = fitYouTubeDescription('A short description.')
    assert.equal(fitted.trimmed, false)
    assert.equal(fitted.description, 'A short description.')
  })

  test('Khmer is measured in bytes: 2,000 characters is over the limit', () => {
    const prose = Array.from({ length: 60 }, () => KHMER_SENTENCE).join(' ')
    assert.ok(prose.length < 5000, 'under the old 5,000-CHARACTER cap')
    assert.ok(utf8Bytes(prose) > 4900, 'but over YouTube’s byte limit')
    const fitted = fitYouTubeDescription(`${prose}\n\n${CHAPTERS}`)
    assert.equal(fitted.trimmed, true)
    assert.ok(fitted.bytes_after <= 4900, `${fitted.bytes_after} bytes`)
    assert.ok(fitted.description.includes(CHAPTERS), 'the chapter list is kept whole')
    const prosePart = fitted.description.slice(0, fitted.description.indexOf(CHAPTERS_BEGIN)).trim()
    assert.ok(prosePart.endsWith('។'), 'trimmed at a sentence end, not mid-word')
  })

  test('prose after the chapter list goes first, then prose before it', () => {
    const before = 'Opening line. ' + 'Before. '.repeat(300)
    const after = 'After. '.repeat(400)
    const fitted = fitYouTubeDescription(`${before}\n\n${CHAPTERS}\n\n${after}`)
    assert.ok(fitted.bytes_after <= 4900)
    assert.ok(fitted.description.startsWith('Opening line.'))
    assert.ok(fitted.description.includes(CHAPTERS))
  })

  test('the upload snippet is capped in bytes, so a long Khmer description is never refused', () => {
    const prose = Array.from({ length: 80 }, () => KHMER_SENTENCE).join(' ')
    const logs: string[] = []
    const out = snippetFromMeta({ title: 'T', description: `${prose}\n\n${CHAPTERS}`, tags: [], thumbnailPath: '' }, logs)
    assert.ok(utf8Bytes(out.description!) <= 4900, `${utf8Bytes(out.description!)} bytes`)
    assert.match(out.description!, /0:00 Opening\n1:10 The Harbour\n9:45 The Storm/)
    assert.ok(logs.some(line => line.includes('description trimmed')))
  })

  test('the prompt states the byte limit and the Khmer equivalent', () => {
    const prompt = buildDescriptionPrompt('EP1', 'T', 'ctx', [], YOUTUBE_DESCRIPTION_MAX_BYTES)
    assert.match(prompt, /under 4,900 bytes/)
    assert.match(prompt, /about 1,633 characters of Khmer/)
  })
})
