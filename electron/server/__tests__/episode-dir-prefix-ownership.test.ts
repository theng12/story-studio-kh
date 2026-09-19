/**
 * An episode code claims its own folder and no other — v1.4.192
 *
 * Four separate searches answered "which folder belongs to this episode?" with
 * a bare `name.toUpperCase().startsWith(CODE)`:
 *
 *   services/asset-status.ts:366   (in-memory index over the whole tree)
 *   services/asset-status.ts:383   (recursive `search`)
 *   services/manifest-audit.ts:127 (recursive search)
 *   generators/audio-merge.ts:127  (recursive search)
 *
 * MEASURED 2026-09-20 against the live library before changing any of them: of
 * 4,971 distinct episode folders, 4,971 match `^EP\d{4} - ` exactly, and the
 * count with any OTHER character after the code is zero. So the loose rule
 * cannot collide *today* — but only because `episode_digits` is project-wide and
 * every project happens to use 4. A 6-character code can never be a strict
 * prefix of another 6-character code.
 *
 * That is precisely why this is worth pinning: the safety came from the data,
 * not the code. One project migrated at a different digit width, or one folder
 * hand-added, and `EP0001` silently claims `EP00012`'s folder — first hit wins,
 * in filesystem traversal order, with no error. The strict rule (`exact code` or
 * `code + " - "`) matches all 4,971 real folders and removes the dependency.
 *
 * The fixture below is the collision shape, synthesised because the live library
 * currently contains no example of it. `EP00012 - Impostor` is the ONLY folder
 * present, so a bare prefix test answers "yes, that is EP0001" and the strict
 * rule answers "no". Both the uncached `search` and the cached tree index are
 * driven, because the two sites are separate code paths.
 */

import assert from 'node:assert/strict'
import { test, describe } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { useTempDataDir } from './_helpers.js'
import type { ProjectFactsCache } from '../services/utils.js'

const MERGED_SUBFOLDER = 'EP0001 - 08 Audio Merge Output'

async function createPrefixFixture() {
  const isolated = await useTempDataDir()
  const pm = await import('../services/project-manager.js')
  const utils = await import('../services/utils.js')
  const project = await pm.createProject({
    name: 'Prefix ownership fixture', episode_prefix: 'EP', episode_digits: 4,
  })
  const outputRoot = await utils.projectOutputRootOnce(project.slug)
  assert.ok(outputRoot, 'the fixture project must expose an episodes root')
  await fs.mkdir(outputRoot, { recursive: true })
  return { isolated, slug: project.slug, outputRoot }
}

/** Plant a merged-audio artifact for `code` inside a folder named `folderName`. */
async function plantMergedAudio(outputRoot: string, folderName: string, code: string): Promise<void> {
  const dir = path.join(outputRoot, folderName, `${code} - 08 Audio Merge Output`)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `${code}_merged_audio.mp3`), `merged-${code}`)
}

describe('episodeDirNameMatchesCode', () => {
  test('accepts the exact code and the real "{code} - {title}" folder shape', async () => {
    const { episodeDirNameMatchesCode } = await import('../services/asset-status.js')
    assert.equal(episodeDirNameMatchesCode('EP0001', 'EP0001'), true)
    assert.equal(episodeDirNameMatchesCode('EP0001 - Three chapters', 'EP0001'), true)
    // Decorative completion marks are still tolerated, as before.
    assert.equal(episodeDirNameMatchesCode('✅ EP0001 - Three chapters', 'EP0001'), true)
    assert.equal(episodeDirNameMatchesCode('ep0001 - lowercase', 'EP0001'), true)
  })

  test('rejects a longer code that merely starts with this one', async () => {
    const { episodeDirNameMatchesCode } = await import('../services/asset-status.js')
    assert.equal(episodeDirNameMatchesCode('EP00012 - Twelve', 'EP0001'), false)
    assert.equal(episodeDirNameMatchesCode('EP00010 - Ten', 'EP0001'), false)
    assert.equal(episodeDirNameMatchesCode('EP0001x - Glued', 'EP0001'), false)
    assert.equal(episodeDirNameMatchesCode('', 'EP0001'), false)
    assert.equal(episodeDirNameMatchesCode('EP0002 - Other', 'EP0001'), false)
  })
})

describe('an episode folder search never claims a neighbouring code', () => {
  test('the uncached search refuses a folder belonging to a longer code', async t => {
    const fixture = await createPrefixFixture()
    t.after(async () => { await fixture.isolated.cleanup() })
    await plantMergedAudio(fixture.outputRoot, 'EP00012 - Impostor', 'EP0001')

    const { getAudioMergeStatus } = await import('../services/asset-status.js')
    const status = await getAudioMergeStatus(fixture.slug, 'EP0001')

    assert.equal(status.present, false, "EP0001 must not be answered with EP00012's folder")
  })

  test('the cached tree index refuses it too', async t => {
    const fixture = await createPrefixFixture()
    t.after(async () => { await fixture.isolated.cleanup() })
    await plantMergedAudio(fixture.outputRoot, 'EP00012 - Impostor', 'EP0001')

    const { getAudioMergeStatus } = await import('../services/asset-status.js')
    // A populated cache routes through the in-memory index, a different site.
    const cache = {} as ProjectFactsCache
    const status = await getAudioMergeStatus(fixture.slug, 'EP0001', cache)

    assert.equal(status.present, false, "the index must not hand EP00012's folder to EP0001")
  })

  test('a real folder for the code is still found, on both paths', async t => {
    const fixture = await createPrefixFixture()
    t.after(async () => { await fixture.isolated.cleanup() })
    await plantMergedAudio(fixture.outputRoot, 'EP0001 - Real episode', 'EP0001')

    const { getAudioMergeStatus } = await import('../services/asset-status.js')
    assert.equal((await getAudioMergeStatus(fixture.slug, 'EP0001')).present, true)
    assert.equal((await getAudioMergeStatus(fixture.slug, 'EP0001', {} as ProjectFactsCache)).present, true)
  })

  test('the impostor does not shadow the real folder when both exist', async t => {
    const fixture = await createPrefixFixture()
    t.after(async () => { await fixture.isolated.cleanup() })
    await plantMergedAudio(fixture.outputRoot, 'EP00012 - Impostor', 'EP0001')
    await plantMergedAudio(fixture.outputRoot, 'EP0001 - Real episode', 'EP0001')

    const { getAudioMergeStatus } = await import('../services/asset-status.js')
    assert.equal((await getAudioMergeStatus(fixture.slug, 'EP0001')).present, true)
  })
})
