/**
 * Script-vs-transcript: sentences the narration skipped are named per chapter.
 *
 * Dreamlands E2E 2026-10-03: Story's 30 s cue-gap gate missed skipped sentences
 * inside shorter pauses (EP0001 Ch15: a 27 s gap); comparing each chapter's
 * script with its transcript found 59 skipped sentences Story never flagged.
 */

import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { findMissingSentences, inspectMissingSentences, scriptSentences } from '../lib/script-transcript-check.js'

const SCRIPT = `## Chapter 15: The Quiet Loom

The weaver lit a single candle beside the silent loom.
She walked slowly to the small table where the single candle burned with patient light.
Outside, the river murmured softly under the silver bridge.
Sleep now.
`

const SRT_SKIPPING = `1
00:00:00,000 --> 00:00:04,000
The weaver lit a single candle beside the silent loom.

2
00:00:31,000 --> 00:00:35,000
Outside, the river murmured softly under the silver bridge.
`

let dir: string
before(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'script-transcript-')) })
after(async () => { await fs.rm(dir, { recursive: true, force: true }) })

describe('script vs transcript', () => {
  test('a sentence inside a pause shorter than the 30 s gate is still reported', () => {
    assert.deepEqual(findMissingSentences(SCRIPT, SRT_SKIPPING), [
      'She walked slowly to the small table where the single candle burned with patient light.',
    ])
  })

  test('headings and very short lines are not sentences to check; a full transcript reports nothing', () => {
    const sentences = scriptSentences(SCRIPT)
    assert.equal(sentences.length, 3)
    assert.ok(!sentences.some(s => s.startsWith('##') || s === 'Sleep now.'))
    const full = SRT_SKIPPING + '\n3\n00:00:05,000 --> 00:00:09,000\nShe walked slowly to the small table where the single candel burned with patient light.\n'
    assert.deepEqual(findMissingSentences(SCRIPT, full), [], 'one misspelt word must not flag a sentence')
  })

  test('per chapter, skipping chapters without a transcript and stale transcripts', async () => {
    await fs.writeFile(path.join(dir, 'EP0001_Chapter_15.md'), SCRIPT)
    await fs.writeFile(path.join(dir, 'EP0001_Chapter_15.srt'), SRT_SKIPPING)
    await fs.writeFile(path.join(dir, 'EP0001_Chapter_16.md'), SCRIPT) // not transcribed yet
    await fs.writeFile(path.join(dir, 'EP0001_Script_Narration.md'), SCRIPT) // not a chapter
    assert.deepEqual(
      (await inspectMissingSentences(dir, dir, 'ep0001')).map(c => [c.slug, c.sentences.length]),
      [['Chapter_15', 1]],
    )
    assert.deepEqual(await inspectMissingSentences(dir, dir, 'EP0001', ['Chapter_15']), [])
  })

  test('the Subtitles status and the subtitles job both report it', async () => {
    const route = await fs.readFile(new URL('../routes/video.ts', import.meta.url), 'utf8')
    assert.match(route, /missing_sentences: missingSentences/)
    const generator = await fs.readFile(new URL('../generators/subtitles.ts', import.meta.url), 'utf8')
    assert.match(generator, /job\.result\.missing_sentences = skippedSentences/)
  })
})
