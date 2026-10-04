/**
 * Khmer ។ (U+17D4) / ៕ (U+17D5) and CJK 。！？ end a sentence (Khmer TTS test 2026-10-04).
 *
 * Story Studio's sentence detection only knew .!? so every Khmer paragraph was
 * one over-long "sentence" for the 220-character narration rule, and a long
 * Khmer chapter could be cut into TTS requests only at a paragraph or a space.
 * One shared definition (lib/sentence-ends.ts) now feeds the 220 pass, the
 * request splitter, the sentence timing and the seam pauses; English is unchanged.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const { splitSentences, splitAtLimit, endsSentence, terminatorFor } = await import('../lib/sentence-ends.js')
const { chunkText } = await import('../lib/text-chunker.js')
const { splitLongSentences, MAX_NARRATION_SENTENCE_CHARS } = await import('../lib/tts-text.js')
const { splitIntoSentences } = await import('../lib/sentence-timing.js')
const { splitGenStudioApiRequests } = await import('../lib/genstudio-client.js')
const { planSeams } = await import('../services/chapter-parts.js')

const A = 'ព្រះអាទិត្យរះលើភ្នំខ្ពស់នៅពេលព្រឹកព្រលឹមហើយសត្វស្លាបចាប់ផ្តើមច្រៀងនៅលើមែកឈើ។'
const B = 'ទន្លេហូរកាត់វាលស្រែដ៏ធំល្វឹងល្វើយនាំទឹកត្រជាក់មកកាន់ភូមិតូចមួយនៅជើងភ្នំ។'
const C = 'កុមារៗរត់លេងនៅមាត់ទឹកហើយចាប់ត្រីតូចៗដោយដៃទទេរហូតដល់ថ្ងៃលិច៕'
const UNSPACED = A + B + C + A + B + C
const SPACED = [A, B, C, A, B, C].join(' ')

/** A cut is inside a Khmer syllable when the next chunk opens with a combining mark or follows a coeng. */
const cutsSyllable = (chunks: string[]) => chunks.slice(1).some((chunk, i) =>
  /^\p{M}/u.test(chunk) || chunks[i]!.endsWith('្'))

void test('Khmer and CJK stops split sentences with or without a space; Latin behaviour is unchanged', () => {
  assert.deepEqual(splitSentences(UNSPACED), [A, B, C, A, B, C])
  assert.deepEqual(splitSentences(SPACED), [`${A} `, `${B} `, `${C} `, `${A} `, `${B} `, C])
  assert.deepEqual(splitSentences('今日は晴れ。明日は雨？はい！'), ['今日は晴れ。', '明日は雨？', 'はい！'])
  assert.deepEqual(splitSentences('One. Two!  Three? It is 3.5 ok.'), ['One. ', 'Two! ', 'Three? ', 'It is 3.5 ok.'])
  assert.deepEqual(splitSentences('No stop here'), ['No stop here'])
  assert.ok(endsSentence('ហើយ។') && endsSentence('ចប់៕') && endsSentence('wait…') && !endsSentence('ហើយ'))
  assert.deepEqual([terminatorFor('ហើយ'), terminatorFor('晴れ'), terminatorFor('done')], ['។', '。', '.'])
})

void test('a 290-320 character Khmer paragraph is no longer one over-long sentence', () => {
  const paragraph = A + B + C + A
  assert.ok(paragraph.length > 250 && A.length < MAX_NARRATION_SENTENCE_CHARS)
  const unspaced = splitLongSentences(paragraph)
  assert.deepEqual(unspaced, { text: paragraph, reports: [] }, 'every sentence is under 220, nothing to split')
  const spaced = [A, B, C, A].join(' ')
  assert.deepEqual(splitLongSentences(spaced), { text: spaced, reports: [] })
})

void test('an over-long Khmer sentence is split at a comma and the cut gets a Khmer stop, not a Latin one', () => {
  const long = `${A.slice(0, -1)}, ${B.slice(0, -1)}, ${C.slice(0, -1)}, ${A}`
  const { text, reports } = splitLongSentences(long)
  assert.equal(reports.length, 1)
  assert.ok(!text.includes('.') && text.includes('។ '), text)
  assert.ok(splitSentences(text).every(sentence => sentence.trim().length <= MAX_NARRATION_SENTENCE_CHARS), text)
})

void test('a Khmer chapter over the request boundary is split at ។ / ៕, spaced or not, and rebuilds exactly', () => {
  for (const [text, join] of [[UNSPACED, ''], [SPACED, ' ']] as const) {
    const cap = 200
    assert.ok(text.length > cap)
    const parts = chunkText(text, cap)
    assert.ok(parts.length >= 3)
    assert.ok(parts.every(part => part.length <= cap && /[។៕]$/.test(part)), parts.join('|'))
    assert.equal(parts.join(join), text)
    assert.deepEqual(splitGenStudioApiRequests(text, cap), parts)
  }
})

void test('the request splitter never cuts inside a Khmer syllable', () => {
  const noStops = (A + B + C).replace(/[។៕]/g, '')
  for (const cap of [37, 41, 50, 63, 80]) {
    const parts = splitGenStudioApiRequests(noStops, cap)
    assert.ok(parts.every(part => part.length <= cap), String(cap))
    assert.ok(!cutsSyllable(parts), `cap ${cap}: ${parts.join('|')}`)
    assert.equal(parts.join(''), noStops)
  }
  // Spaced Khmer prefers the space over a hard cut.
  const words = splitAtLimit('សួស្តី ពិភពលោក ព្រះអាទិត្យ រះហើយ', 24)
  assert.ok(words.every(w => w.length <= 24) && words.join(' ') === 'សួស្តី ពិភពលោក ព្រះអាទិត្យ រះហើយ', words.join('|'))
  // A coeng (U+17D2) is never separated from its subscript consonant.
  const cluster = 'ក្ក'.repeat(20)
  assert.ok(!cutsSyllable(splitAtLimit(cluster, 7)))
})

void test('English chunking and sentence timing are unchanged', () => {
  assert.deepEqual(chunkText('Alpha one. Beta two. Gamma three.', 20), ['Alpha one. Beta two.', 'Gamma three.'])
  assert.deepEqual(chunkText('Alpha one.\n\nBeta two.\n\nGamma three.', 22), ['Alpha one.\n\nBeta two.', 'Gamma three.'])
  assert.deepEqual(chunkText('aaaa bbbb cccc dddd', 9), ['aaaa bbbb', 'cccc dddd'])
  assert.deepEqual(chunkText('Hello  there.   World again.', 14), ['Hello  there.', 'World again.'])
  assert.deepEqual(splitIntoSentences('One. Two!\nThree? 3.5 stays.'), ['One.', 'Two!', 'Three?', '3.5 stays.'])
})

void test('sentence timing and seam pauses see Khmer stops', () => {
  assert.deepEqual(splitIntoSentences(UNSPACED), [A, B, C, A, B, C])
  const section = `${A} ${B}`
  assert.deepEqual(planSeams(section, [A, B]).pauses, [0.6])
})
