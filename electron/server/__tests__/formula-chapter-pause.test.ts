/**
 * Audio Assembly's "Pause between chapters" starts at the Series Formula's own
 * value (Sleep: a longer, calm 3 s), and a formula that says nothing leaves the
 * format's default alone.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const { applyNicheToFormat } = await import('../services/format-loader.js')
const { parseContentPackDocument } = await import('../content-packs/schemas.js')
const { contentPackDocumentToNiche } = await import('../content-packs/legacy-adapters.js')

void test('the Sleep formula sets a 2 s pause between chapters; others keep the format default', async () => {
  const shell = JSON.parse(await fs.readFile(path.join(root, 'electron/server/formats/continuity-chain.json'), 'utf8'))
  const shellDefaults = shell.script.audioMergeDefaults
  assert.equal(shellDefaults.gapDurationSec, 1)
  const sleep = JSON.parse(await fs.readFile(path.join(root, 'electron/server/niches/sleep.json'), 'utf8'))
  assert.equal(sleep.chapterPauseSec, 2)
  const sleepFormat = applyNicheToFormat(shell, sleep)
  assert.deepEqual(sleepFormat.script.audioMergeDefaults, { ...shellDefaults, gapDurationSec: 2 })
  const plain = applyNicheToFormat(shell, { ...sleep, chapterPauseSec: undefined })
  assert.deepEqual(plain.script.audioMergeDefaults, shellDefaults)
})

void test('a signed formula can carry chapter_pause_sec through to the niche', async () => {
  const doc = JSON.parse(await fs.readFile(path.join(root, 'content-packs/free-starters/formula/sleep-story-v1.0.1/content/series-formula.json'), 'utf8'))
  const niche = contentPackDocumentToNiche(parseContentPackDocument('series-formula', { ...doc, chapter_pause_sec: 3 }) as any)
  assert.equal(niche.chapterPauseSec, 3)
  assert.throws(() => parseContentPackDocument('series-formula', { ...doc, chapter_pause_sec: 60 }))
})
