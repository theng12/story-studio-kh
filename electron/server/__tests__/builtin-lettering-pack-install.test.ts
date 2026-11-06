/**
 * Two built-in lettering conversions — one font axis, one text axis — as
 * portable Content Packs: the isolated REAL-ARCHIVE install proof.
 *
 * What each section proves — all light, one file:
 *
 *  1. REAL ARCHIVE — a .sspack built from each source with a test-only key,
 *     or an explicitly supplied pre-built archive and its test public key,
 *     installs into a fresh isolated data dir through the real installer/keyring.
 *  2. CATALOGUE — after both installs the lettering catalogue has exactly two
 *     new pack rows with the exact qualified item id, axis, phrase, name,
 *     preview asset list and versioned preview URL from the source documents.
 *  3. BUILT-INS RETAINED — every pre-install row (all built-ins) survives
 *     unchanged; the packs ADD rows and shadow nothing.
 *
 * Deliberately out of scope: pixel/render proof, runtime suites, network.
 */
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, test } from 'node:test'

import { installContentPack } from '../content-packs/installer.js'
import { createContentPackKeyring } from '../content-packs/keyring.js'
import { getContentPackRuntimePaths } from '../content-packs/runtime-paths.js'
import { letteringCatalogue } from '../services/lettering-catalogue.js'
import { useTempDataDir } from './_helpers.js'

const repoRoot = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const packRoot = path.join(repoRoot, 'content-packs', 'builtin-conversion', 'lettering-style')
const archivesRoot = process.env.STORY_LETTERING_INSTALL_ARCHIVES
const evidenceOptIn = process.env.STORY_LETTERING_INSTALL_EVIDENCE
const TEST_KEY_ID = 'com.storystudio.test-builtin-lettering-builds'
const PUBLISHER_ID = 'com.storystudio'
const publicKeyPath = process.env.STORY_LETTERING_INSTALL_PUBLIC_KEY
const REPS = [
  { axis: 'font' as const, slug: 'font-bold' },
  { axis: 'text' as const, slug: 'text-gold' },
]

const temp = await useTempDataDir()
const evidence: Record<string, unknown> = {}

after(async () => {
  // Loud on purpose: a failed evidence write fails the run instead of
  // shipping a green result with receipts missing.
  try {
    const target = evidenceOptIn ?? path.join(temp.dir, 'lettering-install-proof.json')
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, JSON.stringify(evidence, null, 2) + '\n')
  } finally {
    await temp.cleanup()
  }
})

describe('Two built-in lettering conversions install as real portable packs', () => {
  test('font-axis and text-axis archives install and land exactly, builtins retained', async () => {
    assert.equal(Boolean(archivesRoot), Boolean(publicKeyPath), 'external archives and their test public key must be supplied together')
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const publicKeyPem = publicKeyPath
      ? await fs.readFile(publicKeyPath, 'utf8')
      : publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const keyPath = path.join(temp.dir, 'lettering-test-private.pem')
    if (!archivesRoot) await fs.writeFile(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }))
    const policy = createContentPackKeyring([{ keyId: TEST_KEY_ID, publisherId: PUBLISHER_ID, publicKeyPem }])
    const paths = await getContentPackRuntimePaths()

    const rowsBefore = await letteringCatalogue({ paths, policy })
    assert.ok(rowsBefore.length > 0, 'isolated dir still lists the built-in catalogue')
    assert.ok(rowsBefore.some(row => row.axis === 'font'), 'font built-ins present')
    assert.ok(rowsBefore.some(row => row.axis === 'text'), 'text built-ins present')
    assert.ok(rowsBefore.every(row => row.source === 'built-in'), 'nothing installed yet')

    const installed: unknown[] = []
    for (const rep of REPS) {
      const packId = `${PUBLISHER_ID}.pack.lettering.${rep.slug}`
      const itemId = `${PUBLISHER_ID}.lettering.${rep.slug}`
      const doc = JSON.parse(await fs.readFile(path.join(packRoot, rep.slug, 'content', `${rep.slug}.json`), 'utf8'))
      assert.equal(doc.kind, 'lettering-style')
      assert.equal(doc.id, itemId, 'qualified item id is exact')
      assert.equal(doc.axis, rep.axis, 'axis is exact')

      const archivePath = path.join(archivesRoot || temp.dir, `${rep.slug}-a.sspack`)
      if (!archivesRoot) {
        // @ts-expect-error JavaScript-only deterministic pack tooling.
        const { buildContentPack } = await import('../../../scripts/content-packs/lib.mjs')
        const floor = JSON.parse(await fs.readFile(path.join(repoRoot, 'content-packs/release-floor.json'), 'utf8'))
        await buildContentPack({
          sourceDirectory: path.join(packRoot, rep.slug), privateKeyPath: keyPath,
          outputPath: archivePath, keyId: TEST_KEY_ID, minAppVersion: floor.min_app_version,
        })
      }
      const archiveBytes = new Uint8Array(await fs.readFile(archivePath))
      const sha256 = createHash('sha256').update(archiveBytes).digest('hex')
      await installContentPack(
        { archiveBytes, source: 'local-import', expectedArchiveSha256: sha256 },
        { paths, policy },
      )
      installed.push({ slug: rep.slug, pack_id: packId, sha256, bytes: archiveBytes.byteLength })
    }

    const rowsAfter = await letteringCatalogue({ paths, policy })
    assert.equal(rowsAfter.length, rowsBefore.length + 2, 'the two packs ADD exactly two rows')

    // Every pre-install (built-in) row survives unchanged: nothing shadowed.
    const afterById = new Map(rowsAfter.map(row => [`${row.axis}:${row.id}`, row]))
    for (const row of rowsBefore) {
      const survivor = afterById.get(`${row.axis}:${row.id}`)
      assert.ok(survivor, `built-in ${row.axis}:${row.id} retained`)
      assert.deepEqual(
        { axis: survivor.axis, phrase: survivor.phrase, name: survivor.name, source: survivor.source },
        { axis: row.axis, phrase: row.phrase, name: row.name, source: row.source },
        `built-in ${row.id} unchanged`,
      )
    }

    for (const rep of REPS) {
      const packId = `${PUBLISHER_ID}.pack.lettering.${rep.slug}`
      const doc = JSON.parse(await fs.readFile(path.join(packRoot, rep.slug, 'content', `${rep.slug}.json`), 'utf8'))
      const row = rowsAfter.find(candidate => candidate.id === doc.id)
      assert.ok(row, 'pack row appears in the catalogue')
      assert.equal(row!.source, 'pack')
      assert.equal(row!.axis, rep.axis, 'axis exact')
      assert.equal(row!.phrase, doc.phrase, 'phrase byte-exact against source doc')
      assert.equal(row!.name, doc.name, 'name exact')
      assert.deepEqual(row!.previewAssets, doc.preview_assets, 'preview asset references exact')
      assert.equal(row!.packId, packId, 'qualified pack id exact')
      assert.ok(
        row!.previewUrl && row!.previewUrl.includes(`/${packId}/1.0.0/assets/`),
        'versioned preview URL resolves against pack 1.0.0',
      )
      installed.push({ slug: rep.slug, row: { id: row!.id, axis: row!.axis, packId: row!.packId, previewUrl: row!.previewUrl } })
    }

    evidence.proof = {
      rows_before: rowsBefore.length,
      rows_after: rowsAfter.length,
      builtins_retained: rowsBefore.length,
      reps: REPS.map(rep => rep.slug),
      installed,
    }
    assert.equal(evidence.proof && REPS.length, 2)
  })
})