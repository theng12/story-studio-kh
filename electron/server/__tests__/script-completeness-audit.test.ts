/**
 * The completeness audit is script-aware (owner decision, 2026-10-30).
 *
 * A chapter written in the wrong writing system counts as MISSING wherever the
 * channel states a language, so the Board, the Pipeline preflight, Resume and the
 * job-completion audits give ONE answer (AGENTS §8). The check is the same
 * `answerMatchesLanguage` the write paths use, read back from the file; nothing
 * on disk is rewritten, and a channel with no stated language is never checked.
 *
 * Production read (2026-10-30): only DM0021, DM0022 and PR0040 held wrong-script
 * chapters; they are being repaired. `domnak-kmouch` and `pronom` had no
 * `content_language` set, so nothing at all is checked for them by design.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import {
  inspectChunkedScriptCompletion,
  sidecarPath,
} from '../lib/chunked-narration.js'
import { chapterFilePath } from '../lib/narration-assembly.js'
import { inspectExpandedScriptCompletion } from '../services/text-completion.js'
import { useTempDataDir } from './_helpers.js'

const KHMER = [
  'ព្រះអាទិត្យបានរះឡើងលើភ្នំ ហើយអ្នកស្រុកបានចាប់ផ្តើមធ្វើការនៅពេលព្រឹក។',
  'ទឹកទន្លេហូរយឺតៗ ខណៈដែលកសិករដឹកគោទៅវាលស្រែ។',
  'រឿងនេះបានបន្តពីមួយជំនាន់ទៅមួយជំនាន់ ហើយមនុស្សនៅចងចាំវាដល់សព្វថ្ងៃ។',
].join('\n\n')

const ENGLISH = [
  'The sun rose over the hills, and the villagers began their work for the day.',
  'The river moved slowly while the farmers led their cattle to the fields.',
  'This story passed from one generation to the next, and people still remember it today.',
].join('\n\n')

const CODE = 'EP0001'

async function scriptDir(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const temporary = await useTempDataDir()
  t.after(temporary.cleanup)
  const dir = path.join(temporary.dir, 'script')
  await fs.mkdir(dir, { recursive: true })
  return dir
}

/** A chunked episode exactly as the audit reads one: unified narration, chapters, sidecar. */
async function buildChunkedScript(
  dir: string,
  chapters: Array<{ n: number; text: string }>,
): Promise<void> {
  await fs.writeFile(path.join(dir, `${CODE}_Script_Narration.md`), `# A Test Episode\n\n${chapters.map(c => c.text).join('\n\n')}\n`)
  for (const chapter of chapters) {
    await fs.writeFile(chapterFilePath(dir, CODE, chapter.n), `## Chapter ${String(chapter.n).padStart(2, '0')}: Title\n\n${chapter.text}\n`)
  }
  await fs.writeFile(sidecarPath(dir, CODE), JSON.stringify({
    schema_version: 3,
    episode_id: CODE,
    mode: 'narrative',
    total_chapters: chapters.length,
    outline: chapters.map(chapter => ({ n: chapter.n, title: `Chapter ${chapter.n}` })),
    outline_completed_at: '2020-01-01T00:00:00.000Z',
    outline_approved_at: '2020-01-01T00:00:00.000Z',
    outline_edited_at: null,
    generation_params: null,
    chapters_done: [],
    params_hash: 'test',
    last_updated: '2020-01-01T00:00:00.000Z',
  }))
}

test('a Khmer channel with Khmer chapters is complete', async t => {
  const dir = await scriptDir(t)
  await buildChunkedScript(dir, [{ n: 1, text: KHMER }, { n: 2, text: KHMER }])

  const completion = await inspectChunkedScriptCompletion(dir, CODE, 'km')
  assert.equal(completion.complete, true)
  assert.deepEqual(completion.missing, [])
  assert.deepEqual(completion.wrong_script, [])
  assert.equal((await inspectExpandedScriptCompletion(dir, CODE, undefined, 'km')).complete, true)
})

test('a wrong-script chapter counts as missing, and the reason is named', async t => {
  const dir = await scriptDir(t)
  await buildChunkedScript(dir, [{ n: 1, text: KHMER }, { n: 2, text: ENGLISH }])

  const completion = await inspectChunkedScriptCompletion(dir, CODE, 'km')
  assert.equal(completion.complete, false)
  assert.deepEqual(completion.missing, [2], 'the English chapter is missing, not present')
  assert.deepEqual(completion.wrong_script, [2])

  const audit = await inspectExpandedScriptCompletion(dir, CODE, undefined, 'km')
  assert.equal(audit.complete, false)
  assert.match(audit.detail ?? '', /Chapter 2/)
  assert.match(audit.detail ?? '', /writing system/)

  const selected = await inspectExpandedScriptCompletion(dir, CODE, [1, 2], 'km')
  assert.equal(selected.complete, false)
  assert.match(selected.detail ?? '', /Chapter 2/)
  assert.doesNotMatch(selected.detail ?? '', /not on disk yet/,
    'a wrong-script chapter is not reported as absent')
})

test('a mixed script counts each chapter on its own', async t => {
  const dir = await scriptDir(t)
  await buildChunkedScript(dir, [{ n: 1, text: ENGLISH }, { n: 2, text: KHMER }, { n: 3, text: KHMER }])

  const completion = await inspectChunkedScriptCompletion(dir, CODE, 'km')
  assert.deepEqual(completion.missing, [1])
  assert.deepEqual(completion.wrong_script, [1])
  assert.equal(completion.present, 2)
})

test('a channel with no stated language is unchecked, exactly as before', async t => {
  const dir = await scriptDir(t)
  await buildChunkedScript(dir, [{ n: 1, text: ENGLISH }, { n: 2, text: KHMER }])

  for (const language of [null, undefined] as const) {
    const completion = await inspectChunkedScriptCompletion(dir, CODE, language)
    assert.equal(completion.complete, true, String(language))
    assert.deepEqual(completion.wrong_script, [])
  }
})

test('English names inside Khmer prose still count as Khmer', async t => {
  const dir = await scriptDir(t)
  await buildChunkedScript(dir, [{ n: 1, text: `${KHMER}\n\nNur and Dara, 2019 — Angkor.` }])

  const completion = await inspectChunkedScriptCompletion(dir, CODE, 'km')
  assert.equal(completion.complete, true)
  assert.deepEqual(completion.wrong_script, [])
})

test('an English channel does not count a Khmer chapter as done either', async t => {
  const dir = await scriptDir(t)
  await buildChunkedScript(dir, [{ n: 1, text: KHMER }])

  const completion = await inspectChunkedScriptCompletion(dir, CODE, 'en')
  assert.equal(completion.complete, false)
  assert.deepEqual(completion.missing, [1])
})
