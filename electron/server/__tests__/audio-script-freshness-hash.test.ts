/**
 * X-01 — the audio freshness fingerprint must describe the SCRIPT, not the run.
 *
 * The quality check asks one question: "is the audio on disk still the audio for
 * this script?" It answers it by comparing a hash recorded when the audio was
 * generated against one recomputed from the script file now
 * (`currentChapterScriptHash`). Both sides must therefore describe the script on
 * disk and nothing else.
 *
 * The generator used to record `hashInput(section.text)` after transforming that
 * array in memory for the run (expression markup and auto-pacing have since been
 * removed). A transformed value could never match the recomputed one, so a
 * customer who changed nothing was told the script had changed. These tests pin the contract in both directions:
 * the fingerprint survives an equivalent normalization, and it still changes
 * when the script really changes.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { after, before, describe, test } from 'node:test'

import { parseNarrationDocx } from '../lib/docx-parser.js'
import { normalizeForTts } from '../lib/tts-text.js'
import { chapterScriptFingerprint, currentChapterScriptHash } from '../services/audio-quality.js'

const CODE = 'EP0042'
const SCRIPT_FILE = `${CODE}_script_narration.md`
const SCRIPT = [
  '# Narration',
  '',
  '## Chapter 01: The Ledger',
  '',
  'The archive opened at dawn. The ledger was already waiting on the table.',
  'No one had touched it since the flood.',
  '',
].join('\n')
const CHANGED_SCRIPT = SCRIPT.replace('The ledger was already waiting on the table.', 'The ledger had been moved overnight.')

let dir: string

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'audio-script-hash-'))
  await fs.writeFile(path.join(dir, SCRIPT_FILE), SCRIPT, 'utf8')
})

after(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('the script fingerprint the freshness check recomputes', () => {
  test('the recorded fingerprint equals the one recomputed from the script file', async () => {
    const sections = await parseNarrationDocx(path.join(dir, SCRIPT_FILE))
    assert.equal(sections.length, 1, 'the fixture has one chapter')
    const section = sections[0]!

    // Generation time: the generator captures this immediately after parsing.
    const recorded = chapterScriptFingerprint(section.text)
    // Quality-check time: the same chapter, recomputed from the file.
    const recomputed = await currentChapterScriptHash(dir, CODE, section.slug)

    assert.equal(recomputed, recorded, 'an unchanged script must never be reported as changed')
  })

  test('an equivalent TTS normalization does not change the fingerprint', async () => {
    const sections = await parseNarrationDocx(path.join(dir, SCRIPT_FILE))
    const text = sections[0]!.text
    // Normalization is idempotent for this text, which is why the recomputation
    // can normalize at all without inventing a difference.
    assert.equal(normalizeForTts(normalizeForTts(text).text).text, normalizeForTts(text).text)
    assert.equal(chapterScriptFingerprint(normalizeForTts(text).text), chapterScriptFingerprint(text))
  })

  test('a changed script DOES change the fingerprint', async () => {
    const before = await currentChapterScriptHash(dir, CODE, 'Chapter_01')
      ?? await currentChapterScriptHash(dir, CODE, (await parseNarrationDocx(path.join(dir, SCRIPT_FILE)))[0]!.slug)
    await fs.writeFile(path.join(dir, SCRIPT_FILE), CHANGED_SCRIPT, 'utf8')
    const after = await currentChapterScriptHash(dir, CODE, (await parseNarrationDocx(path.join(dir, SCRIPT_FILE)))[0]!.slug)

    assert.notEqual(after, before, 'the true positive must survive the fix')
    await fs.writeFile(path.join(dir, SCRIPT_FILE), SCRIPT, 'utf8')
  })
})

describe('the transformations a run applies in memory are not part of the fingerprint', () => {
  test('a tagged copy of the text changes the submitted text but not the recorded fingerprint', async () => {
    const sections = await parseNarrationDocx(path.join(dir, SCRIPT_FILE))
    const tagged = `[warm] ${sections[0]!.text}`
    assert.notEqual(normalizeForTts(tagged).text, normalizeForTts(sections[0]!.text).text)
    assert.equal(await currentChapterScriptHash(dir, CODE, sections[0]!.slug), chapterScriptFingerprint(sections[0]!.text))
  })
})

describe('the generator captures the fingerprint before it transforms anything', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../generators/audio.ts', import.meta.url)),
    'utf8',
  )

  test('the capture sits immediately after the parse and before every transform', () => {
    const capture = source.indexOf('const scriptFingerprints = new Map(')
    const normalization = source.indexOf('normalizeSectionsForTts(allSections)')

    assert.ok(capture > 0, 'the generator must capture script fingerprints')
    for (const [label, index] of [['normalization', normalization]] as const) {
      assert.ok(index > 0, `expected to find the ${label} step`)
      assert.ok(capture < index, `the fingerprint must be captured before ${label} rewrites the text`)
    }
  })

  test('the provenance record uses the captured fingerprint, not the transformed text', () => {
    assert.match(
      source,
      /scriptHash: scriptFingerprints\.get\(section\.slug\)/,
      'recording hashInput(section.text) is the defect this fixes',
    )
  })
})
