/**
 * An introduction that lives only inside the unified narration must not read
 * as absent — because the batch spends credits writing over it.
 *
 * THE DAMAGE. `isIntroductionMarker` answers from filenames alone and never
 * opens the narration. Pre-refactor episodes keep their introduction INSIDE
 * `{code}_Script_Narration.md`, with no `_Introduction.md` and no sidecar
 * beside it. Detection therefore reported `introduction: false`,
 * `isStepAlreadyDone` let the batch run `introduction-only`, and the generator
 * wrote a freshly generated introduction straight over the real one. There is
 * no versioning on that path and no backup, so the original was gone. On a
 * 302-episode fixture where every episode genuinely had one, detection
 * reported 0 of 302.
 *
 * THE CONSTRAINT. Status sits on the warm-list hot path that was just
 * optimised, so the fix must not add a narration parse per episode. It does
 * not: the recovery is gated on "this episode has no chapter source files",
 * a test over a list already in memory. A modern episode never opens
 * anything, and a recovered one is answered by its new sidecar from then on.
 *
 * THE TRAP, pinned below. `parseNarrationDocx` labels ANY leading level-1
 * heading "Introduction" — including `# Title — Narration`. Building this on
 * that parser would report a phantom introduction and SKIP a generation the
 * owner asked for, which is worse than the bug being fixed.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { useTempDataDir } from './_helpers.js'

const NARRATION_WITH_INTRO = [
  '# Introduction',
  '',
  'Tonight we walk the quiet ledger of a city that kept every receipt and lost every name.',
  '',
  '# The Vanished Ledger — Narration',
  '',
  '# Chapter 1 — The First Entry',
  '',
  'The clerk wrote the date twice, once for the city and once for himself.',
  '',
].join('\n')

const NARRATION_WITHOUT_INTRO = [
  '# The Vanished Ledger — Narration',
  '',
  '# Chapter 1 — The First Entry',
  '',
  'The clerk wrote the date twice, once for the city and once for himself.',
  '',
].join('\n')

/** A legacy episode: unified narration only — no chapter files, no markers. */
async function legacyEpisode(root: string, code: string, narration: string): Promise<string> {
  const scriptDir = path.join(root, code, '01 Script')
  await fs.mkdir(scriptDir, { recursive: true })
  await fs.writeFile(path.join(scriptDir, `${code}_Script_Narration.md`), narration)
  return scriptDir
}

test('an introduction living only in the narration is recovered, not reported absent', async () => {
  const temp = await useTempDataDir()
  try {
    const { computeScriptFolderIntroduction } = await import('../services/asset-status.js')
    const code = 'TN0001'
    const scriptDir = await legacyEpisode(temp.dir, code, NARRATION_WITH_INTRO)

    const files = await fs.readdir(scriptDir)
    assert.equal(files.length, 1, 'the fixture must have no marker of any kind')

    const found = await computeScriptFolderIntroduction(scriptDir, code, files)
    assert.equal(found, true, 'the introduction is really there; absent is the wrong answer')

    // And it left the marker behind, so the question is answered from a
    // filename from now on rather than by reading the narration again.
    const marker = JSON.parse(
      await fs.readFile(path.join(scriptDir, `${code}_Script_Narration.intro.json`), 'utf-8'),
    )
    assert.ok(marker.word_count > 0, 'a recovered marker must carry a real word count')
    assert.equal(marker.recovered_from, 'unified narration')
  } finally {
    await temp.cleanup()
  }
})

test('a narration whose only heading is the title reports no introduction', async () => {
  const temp = await useTempDataDir()
  try {
    const { computeScriptFolderIntroduction } = await import('../services/asset-status.js')
    const code = 'TN0002'
    const scriptDir = await legacyEpisode(temp.dir, code, NARRATION_WITHOUT_INTRO)

    const found = await computeScriptFolderIntroduction(scriptDir, code, await fs.readdir(scriptDir))
    assert.equal(found, false,
      'a phantom introduction would SKIP a generation the owner asked for')
    // Nothing was written, so nothing was claimed.
    assert.equal(
      (await fs.readdir(scriptDir)).some(name => name.endsWith('.intro.json')), false,
      'no marker may be left behind for an introduction that does not exist',
    )
  } finally {
    await temp.cleanup()
  }
})

test('a modern episode never opens its narration, whatever the narration says', async () => {
  const temp = await useTempDataDir()
  try {
    const { computeScriptFolderIntroduction } = await import('../services/asset-status.js')
    const code = 'TN0003'
    const scriptDir = path.join(temp.dir, code, '01 Script')
    await fs.mkdir(scriptDir, { recursive: true })
    // The narration DOES contain an Introduction, so a parse-based
    // implementation would answer true. A modern episode is recognised by its
    // chapter files instead, and is not consulted at all.
    await fs.writeFile(path.join(scriptDir, `${code}_Script_Narration.md`), NARRATION_WITH_INTRO)
    await fs.writeFile(path.join(scriptDir, `${code}_Chapter_01.md`), '# Chapter 1\n\nText.\n')

    const files = await fs.readdir(scriptDir)
    const found = await computeScriptFolderIntroduction(scriptDir, code, files)
    assert.equal(found, false,
      'a chaptered episode with no intro marker genuinely has no introduction')
    assert.equal(
      (await fs.readdir(scriptDir)).some(name => name.endsWith('.intro.json')), false,
      'the recovery must not fire for an episode the per-chapter writers own',
    )
  } finally {
    await temp.cleanup()
  }
})

test('recovery runs once, ever — the second look is answered by the marker', async () => {
  // The perf claim, made checkable. The narration is parsed at most once per
  // episode over the app's whole life; every later status read takes the O(1)
  // filename path. If the marker were ignored or rewritten, this would be a
  // per-episode parse on the status path — the regression the perf work removed.
  const temp = await useTempDataDir()
  try {
    const { computeScriptFolderIntroduction } = await import('../services/asset-status.js')
    const code = 'TN0004'
    const scriptDir = await legacyEpisode(temp.dir, code, NARRATION_WITH_INTRO)
    const markerPath = path.join(scriptDir, `${code}_Script_Narration.intro.json`)

    assert.equal(await computeScriptFolderIntroduction(scriptDir, code, await fs.readdir(scriptDir)), true)
    const writtenAt = (await fs.stat(markerPath)).mtimeMs

    // Rewrite the narration so that a re-parse would now answer FALSE. The
    // marker must win, proving the narration is not being read again.
    await fs.writeFile(path.join(scriptDir, `${code}_Script_Narration.md`), NARRATION_WITHOUT_INTRO)
    assert.equal(await computeScriptFolderIntroduction(scriptDir, code, await fs.readdir(scriptDir)), true)
    assert.equal((await fs.stat(markerPath)).mtimeMs, writtenAt, 'the marker must not be rewritten')
  } finally {
    await temp.cleanup()
  }
})
