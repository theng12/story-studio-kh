/**
 * v1.4.45 — a free upgrade has no purchase receipt, and never will.
 *
 * MEASURED on the owner's Mac, 2026-08-23. Five kits he owns had a 1.0.1
 * successor published. The Store listed all five under Updates and every
 * "Install update" returned:
 *
 *   409 CONTENT_PACK_RECEIPT_MISSING
 *   "GenStudio did not return permanent signed receipt evidence for this
 *    owned release."
 *
 * "i tried updating, nothing happened here."
 *
 * Ownership is family-level: buying "A Life As…" entitles the account to
 * whatever release that family currently points at, for ever. The purchase
 * receipt is deliberately frozen at the version bought on the day — GenStudio
 * says so in as many words: "a receipt attests to what was bought on the day,
 * and a retirement or a reprice since then must not be able to restate it."
 *
 * So NO purchase receipt can ever name 1.0.1, and requiring one refused every
 * free upgrade the Store has ever offered. The restore receipt is the artefact
 * for this — GenStudio mints it fresh on every call to say "this account,
 * these families, these current releases, at this instant" — and Story already
 * verifies its signature before any of this runs.
 *
 * These tests pin the matching rule, because accepting a restore receipt is
 * only safe while it still identifies the release exactly.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { restoreReceiptAttestsRelease } from '../services/content-store-delivery.js'

const RELEASE = {
  releaseId: 'crel_e648b81a088e419c8f177f446f1ad01d',
  packId: 'com.storystudio.pack.kit.a-life-as',
  version: '1.0.1',
  archiveSha256: '4b8b5123b5a0c09ea6008bd2224b1da89e895b82f7400fbb05f02a42f9e964d3',
  archiveBytes: 551,
} as const
const FAMILY = 'com.storystudio.family.kit.a-life-as'

const attested = (overrides: Record<string, unknown> = {}) => ({
  entitlement_family: FAMILY,
  release_id: RELEASE.releaseId,
  pack_id: RELEASE.packId,
  version: RELEASE.version,
  archive_sha256: RELEASE.archiveSha256,
  archive_bytes: RELEASE.archiveBytes,
  min_story_version: '1.0.843',
  ...overrides,
})

describe('a restore receipt authorises an upgrade only when it names it exactly', () => {
  test('the owner\'s own case: the row GenStudio actually returns is accepted', () => {
    assert.equal(restoreReceiptAttestsRelease(attested(), FAMILY, RELEASE), true)
  })

  test('every identifying field is load-bearing', () => {
    // Not one of these may be dropped to "same family, close enough". The
    // hash and the byte count are what bind the receipt to actual bytes.
    for (const [field, wrong] of [
      ['entitlement_family', 'com.storystudio.family.kit.calm-mind'],
      ['release_id', 'crel_somethingelse'],
      ['pack_id', 'com.storystudio.pack.kit.calm-mind'],
      ['version', '1.0.2'],
      ['archive_sha256', 'f'.repeat(64)],
      ['archive_bytes', 552],
    ] as const) {
      assert.equal(
        restoreReceiptAttestsRelease(attested({ [field]: wrong }), FAMILY, RELEASE),
        false,
        `${field} must be matched, or a receipt could authorise different bytes`,
      )
    }
  })

  test('a missing field is a mismatch, never a pass', () => {
    for (const field of [
      'entitlement_family', 'release_id', 'pack_id', 'version', 'archive_sha256', 'archive_bytes',
    ]) {
      const row = attested()
      delete (row as Record<string, unknown>)[field]
      assert.equal(restoreReceiptAttestsRelease(row, FAMILY, RELEASE), false,
        `an absent ${field} must not be treated as agreement`)
    }
  })

  test('a row for a different family this account also owns is refused', () => {
    // The receipt lists every owned family. Picking the wrong row would
    // install one kit's bytes under another kit's name.
    assert.equal(
      restoreReceiptAttestsRelease(attested(), 'com.storystudio.family.kit.sleep-journeys', RELEASE),
      false,
    )
  })

  test('the byte count is compared as a number, not a string', () => {
    assert.equal(restoreReceiptAttestsRelease(attested({ archive_bytes: '551' }), FAMILY, RELEASE), false)
  })
})

const source = readFileSync(
  fileURLToPath(new URL('../services/content-store-delivery.ts', import.meta.url)), 'utf8')

describe('the fallback is a fallback, and the closure follows the same rule', () => {

  test('a purchase receipt is still preferred when one names the release', () => {
    // The restore path is reached only after the purchase-receipt search
    // fails, so a genuine purchase keeps its own stronger, historical proof.
    assert.match(source, /if \(!matchingReceipt\) \{[\s\S]{0,3000}?restoreReceiptAttestsRelease/)
  })

  test('a restore receipt that names nothing relevant still refuses', () => {
    assert.match(source, /if \(!currentRelease\) \{[\s\S]{0,200}?CONTENT_PACK_RECEIPT_MISSING/)
  })

  test('a kit\'s components bind to the CURRENT entitled release, not a purchase-time pin', () => {
    // A restore receipt carries no `bundle_closure` — nothing was pinned,
    // because nothing was bought. Its `releases` list is the right binding for
    // an upgrade: the dependency must be the version the account is entitled
    // to now.
    assert.match(source, /const restoreAttested = Array\.isArray\(payload\.releases\) && !Array\.isArray\(payload\.bundle_closure\)/)
    assert.match(source, /CONTENT_PACK_RECEIPT_CLOSURE_MISMATCH', 'The signed Studio Library restore receipt does not attest to this exact dependency\.'/)
  })
})
