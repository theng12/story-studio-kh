/**
 * No narration sentence longer than 220 characters (owner decision 2026-10-03).
 *
 * Studio Hub renders every voice in sections of at most 250 characters and
 * ends a section at a sentence wherever one fits, so only a sentence longer
 * than that forces a cut inside a sentence. The writing prompt asks for short
 * sentences; this pins the deterministic pass that splits any sentence still
 * over 220 at a natural clause boundary when a chapter or introduction is
 * saved — never dropping a word, never truncating — and logs what it split.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const { splitLongSentences, describeLongSentences, MAX_NARRATION_SENTENCE_CHARS } = await import('../lib/tts-text.js')
const { writeChapterFiles, chapterFilePath, introductionFilePath } = await import('../lib/narration-assembly.js')

const LONG = 'The lantern swung slowly on its hook above the quiet harbour, casting long ribbons of amber light across '
  + 'the black water, and the old fisherman watched it for a long while, remembering the summers of his childhood '
  + 'when the boats came home heavy with silver fish.'
const words = (text: string) => text.toLowerCase().match(/[a-z']+/g) ?? []
const sentences = (text: string) => text.split(/(?<=[.!?]["'”’]?)\s+/).filter(Boolean)

void test('a sentence over 220 characters is split at a clause boundary; every word kept, short text untouched', () => {
  assert.equal(MAX_NARRATION_SENTENCE_CHARS, 220)
  assert.ok(LONG.length > 250)
  const text = `It was late. ${LONG} Then the tide turned.\n\nA new paragraph begins here.`
  const { text: out, reports } = splitLongSentences(text)
  assert.equal(reports.length, 1)
  assert.deepEqual(words(out), words(text), 'no word dropped, added or reordered')
  assert.ok(sentences(out).every(sentence => sentence.length <= 220), out)
  assert.match(out, /across the black water\. And the old fisherman/)
  assert.ok(out.startsWith('It was late. ') && out.endsWith('Then the tide turned.\n\nA new paragraph begins here.'))
  const short = 'One. Two, three.\n\nFour?'
  assert.deepEqual(splitLongSentences(short), { text: short, reports: [] })
})

void test('a quoted long line stays inside its quotes; a very long one is split as often as it needs', () => {
  const { text: quoted } = splitLongSentences(`"${LONG}"`)
  assert.match(quoted, /^"The lantern.*water\. And the old.*silver fish\."$/)
  const huge = [LONG.replace(/\.$/, ''), LONG.replace(/\.$/, ''), LONG].join(', and ')
  const { text: out, reports } = splitLongSentences(huge)
  assert.ok(reports[0]!.pieces.length >= 4)
  assert.ok(sentences(out).every(sentence => sentence.length <= 220), out)
  assert.deepEqual(words(out), words(huge))
})

void test('a sentence with no natural break is left exactly as written and reported, never truncated', () => {
  const runOn = `${Array.from({ length: 45 }, (_, index) => `word${index}`).join(' ')}.`
  assert.ok(runOn.length > 220)
  const { text, reports } = splitLongSentences(runOn)
  assert.equal(text, runOn)
  assert.deepEqual(reports, [{ original: runOn, pieces: [runOn] }])
  assert.match(describeLongSentences('Chapter 4', reports)[0]!, /^Chapter 4: a \d+-character sentence has no natural break, so it was left as written/)
})

void test('a plain comma is a cut only for a sentence the Hub would cut mid-sentence (over 250); never before "which"', () => {
  // 223 characters, Dreamlands EP0002: splitting it at its only commas would leave "As she passed … once more."
  const subordinate = 'As she passed beneath the high central dome once more, Elara glanced up through the clear glass ceiling to '
    + 'offer a silent farewell to the constellation of Orion, which still held its vigilant watch over the sleeping garden.'
  assert.ok(subordinate.length > 220 && subordinate.length <= 250)
  assert.deepEqual(splitLongSentences(subordinate).text, subordinate)
  const longer = subordinate.replace('the sleeping garden.', 'the sleeping garden of the old house on the hill by the sea.')
  assert.ok(longer.length > 250)
  const { text } = splitLongSentences(longer)
  assert.ok(sentences(text).every(sentence => sentence.length <= 250), text)
  assert.doesNotMatch(text, /\. Which/)
})

void test('saving a chapter or introduction splits its long sentences and logs each one; a byte-preserving save does not', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sentence-length-'))
  try {
    const log: string[] = []
    await writeChapterFiles(dir, 'EP001', 'Test', {
      chapters: [{ number: 2, title: 'Harbour', text: LONG }], intro: { text: `Welcome. ${LONG}` },
    }, { log: line => log.push(line) })
    const chapter = await fs.readFile(chapterFilePath(dir, 'EP001', 2), 'utf8')
    const intro = await fs.readFile(introductionFilePath(dir, 'EP001'), 'utf8')
    assert.match(chapter, /black water\. And the old fisherman/)
    assert.match(intro, /black water\. And the old fisherman/)
    assert.equal(log.length, 2)
    assert.match(log[0]!, /^Chapter 2: split a \d+-character sentence into 2 /)
    assert.match(log[1]!, /^Introduction: split /)

    await writeChapterFiles(dir, 'EP001', 'Test', { chapters: [{ number: 3, title: 'Kept', text: LONG }] },
      { normalizeSpokenProse: false, log: line => log.push(line) })
    assert.ok((await fs.readFile(chapterFilePath(dir, 'EP001', 3), 'utf8')).includes(LONG))
    assert.equal(log.length, 2)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

void test('the writing prompt every narrated format uses asks for sentences under the limit', async () => {
  const source = await fs.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'generators', 'episode.ts'), 'utf8')
  const guidance = source.slice(source.indexOf('const ttsWritingGuidance'), source.indexOf('const baseSystem'))
  assert.match(guidance, /Keep EVERY sentence under \$\{MAX_NARRATION_SENTENCE_CHARS\} characters/)
})
