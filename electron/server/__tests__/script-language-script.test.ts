/**
 * A chapter written in the wrong script is not saved.
 *
 * 2026-10-30, measured on the mini: Khmer channels' chapter calls came back as
 * English (DM0022 chapters 9–16) and were written as if they were the episode,
 * while an English refusal at least failed loudly. An injected "reply in
 * English" line upstream is the likely cause; Story does not depend on that
 * route behaving.
 *
 * The rule: a channel that states a language may only save audience text in
 * that language's script. The measurement counts Khmer letters against Latin
 * letters and ignores digits, punctuation and every other script — so English
 * names inside Khmer prose pass, and an English chapter does not. A channel
 * with no stated language is never checked.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import {
  answerMatchesLanguage,
  languageDirectiveTail,
  measureAnswerScript,
} from '../lib/content-language.js'
import { parseAndWriteBatch } from '../lib/chunked-narration.js'
import type { ChunkedNarrationParams } from '../lib/chunked-narration.js'
import { chapterFilePath } from '../lib/narration-assembly.js'
import { useTempDataDir } from './_helpers.js'

const KHMER_CHAPTER = [
  'ព្រះអាទិត្យបានរះឡើងលើភ្នំ ហើយអ្នកស្រុកបានចាប់ផ្តើមធ្វើការនៅពេលព្រឹក។',
  'ទឹកទន្លេហូរយឺតៗ ខណៈដែលកសិករដឹកគោទៅវាលស្រែ។',
  'រឿងនេះបានបន្តពីមួយជំនាន់ទៅមួយជំនាន់ ហើយមនុស្សនៅចងចាំវាដល់សព្វថ្ងៃ។',
].join('\n\n')

const ENGLISH_CHAPTER = [
  'The sun rose over the hills, and the villagers began their work for the day.',
  'The river moved slowly while the farmers led their cattle to the fields.',
  'This story passed from one generation to the next, and people still remember it today.',
].join('\n\n')

function params(scriptDir: string, contentLanguage: 'km' | 'en' | null, lines: string[] = []): ChunkedNarrationParams {
  return {
    episode_id: 'EP0001',
    title: 'A Test Episode',
    totalChapters: 2,
    wordsPerChapter: 500,
    scriptDir,
    model: 'test-model',
    apiKeys: {},
    contentLanguage,
    log: (line: string) => lines.push(line),
  } as unknown as ChunkedNarrationParams
}

async function scriptDirFor(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const temporary = await useTempDataDir()
  t.after(temporary.cleanup)
  const dir = path.join(temporary.dir, 'script')
  await fs.mkdir(dir, { recursive: true })
  return dir
}

async function fileExists(dir: string, number: number): Promise<boolean> {
  const stat = await fs.stat(chapterFilePath(dir, 'EP0001', number)).catch(() => null)
  return !!stat?.isFile() && stat.size > 0
}

// ── the measurement ────────────────────────────────────────────────────────

test('Khmer prose passes with English names, numbers and punctuation inside it', () => {
  const text = `${KHMER_CHAPTER}\n\nAngkor Wat, 2019 — UNESCO.\n\nរឿងរ៉ាវនេះមានឈ្មោះថា "Nur" និង "Dara".`
  const measured = measureAnswerScript(text)
  assert.ok(measured.khmer > 100, `counts the Khmer letters (${measured.khmer})`)
  assert.ok(answerMatchesLanguage(text, 'km'), 'English names do not make a Khmer chapter English')
})

test('an English chapter is not Khmer, and a refusal is neither', () => {
  assert.equal(answerMatchesLanguage(ENGLISH_CHAPTER, 'km'), false)
  assert.equal(answerMatchesLanguage(ENGLISH_CHAPTER, 'en'), true)
  assert.equal(answerMatchesLanguage(KHMER_CHAPTER, 'en'), false)
  assert.equal(measureAnswerScript('  1234 … — ').script, 'none', 'no letters is not a language answer')
  assert.equal(answerMatchesLanguage('  1234 … — ', 'km'), false)
})

test('a channel with no stated language is never checked', () => {
  assert.equal(answerMatchesLanguage(ENGLISH_CHAPTER, null), true)
  assert.equal(answerMatchesLanguage('', undefined), true)
  assert.equal(answerMatchesLanguage(KHMER_CHAPTER, 'fr'), true, 'an unrecognised value is not a language to enforce')
})

test('the language instruction is the LAST line of a prompt, and absent when unset', () => {
  const tail = languageDirectiveTail('PROMPT BODY', 'km')
  assert.ok(tail.startsWith('PROMPT BODY\n\n'), 'the prompt body is unchanged')
  assert.match(tail.split('\n\n').at(-1) ?? '', /Khmer/)
  assert.equal(languageDirectiveTail('PROMPT BODY', null), 'PROMPT BODY', 'legacy prompts stay byte-identical')
})

// ── the write path ─────────────────────────────────────────────────────────

function batchOf(...numbers: number[]) {
  return numbers.map(n => ({ n, title: `Chapter ${n}` })) as unknown as Parameters<typeof parseAndWriteBatch>[1]
}

test('a wrong-script chapter is not written, and the job is told which one and why', async t => {
  const dir = await scriptDirFor(t)
  const lines: string[] = []
  const p = params(dir, 'km', lines)

  const answer = `## Chapter 01: ការចាប់ផ្តើម\n\n${KHMER_CHAPTER}\n\n## Chapter 02: The Second Chapter\n\n${ENGLISH_CHAPTER}`
  const wrote = await parseAndWriteBatch(p, batchOf(1, 2), answer)

  assert.deepEqual(wrote, [1], 'only the Khmer chapter is written')
  assert.equal(await fileExists(dir, 1), true)
  assert.equal(await fileExists(dir, 2), false, 'the English chapter never reaches disk')
  assert.ok(lines.some(line => /Chapters? 2 .*NOT written/.test(line) && /wrong script/.test(line) && /Khmer/.test(line)),
    `the log names the chapter and the reason: ${JSON.stringify(lines)}`)
})

test('a mixed batch keeps every good chapter', async t => {
  const dir = await scriptDirFor(t)
  const p = params(dir, 'km')
  const answer = `## Chapter 01: ការចាប់ផ្តើម\n\n${KHMER_CHAPTER}\n\n## Chapter 02: The Second Chapter\n\n${ENGLISH_CHAPTER}\n\n## Chapter 03: ការបញ្ចប់\n\n${KHMER_CHAPTER}`
  const wrote = await parseAndWriteBatch(p, batchOf(1, 2, 3), answer)

  assert.deepEqual(wrote, [1, 3])
  assert.equal(await fileExists(dir, 1), true)
  assert.equal(await fileExists(dir, 2), false)
  assert.equal(await fileExists(dir, 3), true)
})

test('a refusal-shaped answer writes nothing and names the chapter', async t => {
  const dir = await scriptDirFor(t)
  const lines: string[] = []
  const p = params(dir, 'km', lines)

  const refusal = '## Chapter 01: I cannot help with that\n\nI am sorry, but I cannot write this content. Please adjust your request and try again.'
  const wrote = await parseAndWriteBatch(p, batchOf(1), refusal)

  assert.deepEqual(wrote, [])
  assert.equal(await fileExists(dir, 1), false)
  assert.ok(lines.some(line => /wrong script/.test(line)), 'the reason is stated, not guessed from the parser')
})

test('an English channel is unaffected, and a channel with no language writes exactly as before', async t => {
  const englishDir = await scriptDirFor(t)
  const english = await parseAndWriteBatch(params(englishDir, 'en'), batchOf(1), `## Chapter 01: Start\n\n${ENGLISH_CHAPTER}`)
  assert.deepEqual(english, [1])

  const unsetDir = await scriptDirFor(t)
  const unset = await parseAndWriteBatch(params(unsetDir, null), batchOf(1), `## Chapter 01: Start\n\n${ENGLISH_CHAPTER}`)
  assert.deepEqual(unset, [1], 'no stated language means no check')

  const khmerOnEnglishDir = await scriptDirFor(t)
  const refused = await parseAndWriteBatch(params(khmerOnEnglishDir, 'en'), batchOf(1), `## Chapter 01: Start\n\n${KHMER_CHAPTER}`)
  assert.deepEqual(refused, [], 'an English channel does not save Khmer chapters either')
})
