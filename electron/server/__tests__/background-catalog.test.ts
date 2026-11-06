/**
 * Backgrounds catalog — approval boundary, integrity, and the portable
 * round-trip.
 *
 * What a looser test would miss:
 *   * The APPROVAL gate is enforced by the service, not by whoever calls it:
 *     a pending id is rejected even though its bytes are bundled, and it never
 *     appears in listBackgrounds(). The catalog offering a choice and the
 *     catalog activating one are different things — the default is None and
 *     nothing here selects a background.
 *   * Integrity failures name the id. A tampered or truncated bundled file
 *     stops the render (AGENTS §8) instead of streaming half an image.
 *   * Round-trip: `${BACKGROUND}/<id>` → absolute → `${BACKGROUND}/<id>`,
 *     which is what stops the bytes being duplicated into every channel that
 *     picks one, while every legacy shape (absolute, ${CHANNEL}, ${PROJECT},
 *     ${ASSET}, the retired custom token) keeps its exact old behaviour.
 */
import { describe, test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import {
  _setBackgroundManifestForTesting,
  _setBackgroundsDirForTesting,
  _clearBackgroundCatalogCache,
  backgroundReferenceForPath,
  backgroundsDir,
  listBackgrounds,
  resolveBackground,
} from '../services/background-catalog.js'
import { isPortablePath, resolveAssetPath, toPortablePath } from '../services/path-resolver.js'

const OWNED_IDS = [
  'white-crumpled-paper', 'cream-crumpled-paper', 'ruled-notebook-paper', 'brown-kraft-paper',
  'smooth-ivory-paper', 'pale-grey-recycled-paper', 'white-watercolor-paper', 'dark-slate-chalkboard',
  'deep-navy-paper', 'natural-linen', 'subtle-graph-paper', 'pale-wood-grain',
]

function resetCatalog(): void {
  _setBackgroundManifestForTesting(null)
  _setBackgroundsDirForTesting(null)
  _clearBackgroundCatalogCache()
}

beforeEach(resetCatalog)
afterEach(resetCatalog)

describe('What the catalog offers', () => {
  test('lists every approved entry with a portable reference', () => {
    const list = listBackgrounds()
    assert.deepEqual(list.map(b => b.id), OWNED_IDS)
    for (const b of list) {
      assert.equal(b.reference, `\${BACKGROUND}/${b.id}`)
      assert.ok(b.name.trim().length > 0)
      assert.ok(isPortablePath(b.reference), `${b.reference} must be portable`)
    }
  })

  test('the catalog never activates anything — None stays empty, not a fake asset', () => {
    // The picker's "None" is the empty string; it must pass through both
    // directions untouched rather than becoming some placeholder file.
    assert.equal(resolveAssetPath(''), '')
    assert.equal(toPortablePath(''), '')
  })
})

describe('Integrity of the shipped bytes', () => {
  test('every listed id resolves to its exact manifest file, hash and length', () => {
    const manifest = JSON.parse(readFileSync(path.join(backgroundsDir(), 'manifest.json'), 'utf8'))
    for (const entry of listBackgrounds()) {
      const meta = manifest.assets.find((a: any) => a.id === entry.id)
      assert.ok(meta, `${entry.id} missing from manifest`)
      const file = resolveBackground(entry.id)
      assert.ok(path.isAbsolute(file))
      assert.ok(file.endsWith(meta.file), `${entry.id} resolved to ${file}, expected ${meta.file}`)
      const bytes = readFileSync(file)
      assert.equal(bytes.length, meta.bytes, `${entry.id} byte length`)
      assert.equal(createHash('sha256').update(bytes).digest('hex'), meta.sha256, `${entry.id} hash`)
    }
  })

  test('a truncated file fails loudly with the id named', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'bg-catalog-'))
    try {
      writeFileSync(path.join(dir, 'short.webp'), 'tiny')
      _setBackgroundsDirForTesting(dir)
      _setBackgroundManifestForTesting({
        schemaVersion: 1,
        assets: [{
          id: 'short-item', name: 'Short item', file: 'short.webp',
          sha256: createHash('sha256').update('a much longer body').digest('hex'),
          bytes: 18, approval: 'approved',
        }],
      })
      assert.throws(() => resolveBackground('short-item'), /short-item.*(bytes|tampered)/i)
    } finally {
      _setBackgroundManifestForTesting(null)
      _setBackgroundsDirForTesting(null)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a same-length byte swap fails loudly with the id named', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'bg-catalog-'))
    try {
      const body = Buffer.from('0123456789')
      writeFileSync(path.join(dir, 'swapped.webp'), body)
      const good = createHash('sha256').update(body).digest('hex')
      _setBackgroundsDirForTesting(dir)
      _setBackgroundManifestForTesting({
        schemaVersion: 1,
        assets: [{
          id: 'swapped-item', name: 'Swapped item', file: 'swapped.webp',
          sha256: good.replace(/^./, good[0] === '0' ? '1' : '0'), bytes: 10, approval: 'approved',
        }],
      })
      assert.throws(() => resolveBackground('swapped-item'), /tampered asset.*swapped-item/i)
    } finally {
      _setBackgroundManifestForTesting(null)
      _setBackgroundsDirForTesting(null)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a deleted bundled file fails loudly instead of resolving to nothing', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'bg-catalog-'))
    try {
      _setBackgroundsDirForTesting(dir) // empty: no .webp written at all
      _setBackgroundManifestForTesting({
        schemaVersion: 1,
        assets: [{
          id: 'gone-item', name: 'Gone item', file: 'gone.webp',
          sha256: '0'.repeat(64), bytes: 4, approval: 'approved',
        }],
      })
      assert.throws(() => resolveBackground('gone-item'), /missing asset/i)
    } finally {
      _setBackgroundManifestForTesting(null)
      _setBackgroundsDirForTesting(null)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('Unknown ids and traversal', () => {
  test('an unknown id is refused and says which ids exist', () => {
    assert.throws(() => resolveBackground('does-not-exist'), /unknown background id/i)
  })

  test('no id may walk out of the catalog', () => {
    for (const bad of ['../manifest.json', 'a/b', 'a\\b', '..', '.', 'WHITE-CRUMPLED-PAPER', '', 'white-crumpled-paper.webp', '.hidden']) {
      assert.throws(() => resolveBackground(bad), /unknown background id|not an app-owned/i, `accepted: ${JSON.stringify(bad)}`)
    }
  })

  test('a manifest naming a file outside the directory is refused', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'bg-catalog-'))
    try {
      _setBackgroundsDirForTesting(dir)
      _setBackgroundManifestForTesting({
        schemaVersion: 1,
        assets: [{
          id: 'escape-item', name: 'Escape item', file: '../escaped.webp',
          sha256: '0'.repeat(64), bytes: 4, approval: 'approved',
        }],
      })
      assert.throws(() => resolveBackground('escape-item'), /unsafe file name|traversal/i)
    } finally {
      _setBackgroundManifestForTesting(null)
      _setBackgroundsDirForTesting(null)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('an approval typo can never silently promote an entry', () => {
    _setBackgroundManifestForTesting({
      schemaVersion: 1,
      assets: [{
        id: 'typo-item', name: 'Typo item', file: 'typo.webp',
        sha256: '0'.repeat(64), bytes: 4, approval: 'probably' as any,
      }],
    })
    assert.throws(() => listBackgrounds(), /approval must be/i)
  })
})

describe('The approval boundary', () => {
  function withPending(body: (file: string) => void): void {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'bg-catalog-'))
    try {
      const pendingBody = Buffer.from('pending artwork')
      writeFileSync(path.join(dir, 'pending-item.webp'), pendingBody)
      _setBackgroundsDirForTesting(dir)
      _setBackgroundManifestForTesting({
        schemaVersion: 1,
        assets: [{
          id: 'pending-item', name: 'Pending item', file: 'pending-item.webp',
          sha256: createHash('sha256').update(pendingBody).digest('hex'),
          bytes: pendingBody.length, approval: 'pending',
        }],
      })
      body(path.join(dir, 'pending-item.webp'))
    } finally {
      _setBackgroundManifestForTesting(null)
      _setBackgroundsDirForTesting(null)
      rmSync(dir, { recursive: true, force: true })
    }
  }

  test('a pending entry is not offered', () => {
    withPending(() => {
      assert.deepEqual(listBackgrounds(), [])
    })
  })

  test('a pending id is rejected even though its bytes are bundled and intact', () => {
    withPending(file => {
      assert.ok(readFileSync(file).length > 0, 'the bytes really are on disk')
      assert.throws(() => resolveBackground('pending-item'), /not approved/i)
      assert.equal(backgroundReferenceForPath(file), null, 'pending bytes must not collapse to a catalog reference')
      assert.equal(toPortablePath(file), path.normalize(file), 'pending bytes collapse the ordinary way')
    })
  })
})

describe('Round-trip and legacy compatibility', () => {
  test('reference → absolute → reference for every offered background', () => {
    for (const entry of listBackgrounds()) {
      const abs = resolveAssetPath(entry.reference)
      assert.equal(abs, resolveBackground(entry.id), `${entry.id} expand`)
      assert.equal(toPortablePath(abs), entry.reference, `${entry.id} collapse`)
      assert.equal(backgroundReferenceForPath(abs), entry.reference)
    }
  })

  test('a path that merely looks like a catalog file is not collapsed to one', () => {
    const impostor = path.join(path.dirname(backgroundsDir()), 'white-crumpled-paper.webp')
    assert.equal(backgroundReferenceForPath(impostor), null)
    assert.equal(toPortablePath(impostor), impostor)
  })

  test('legacy shapes resolve and collapse exactly as before', () => {
    // Absolute in, absolute out — the back-compat guarantee.
    const abs = '/Users/alice/library/episodes/Season 001/x.png'
    assert.equal(resolveAssetPath(abs), abs)
    assert.equal(toPortablePath(abs), abs)

    const episodes = path.resolve('/library/channel/episodes')
    assert.equal(resolveAssetPath('${CHANNEL}/assets/logo.png', episodes), path.join(path.dirname(episodes), 'assets', 'logo.png'))
    assert.equal(toPortablePath(path.join(path.dirname(episodes), 'music', 'a.mp3'), episodes), '${CHANNEL}/music/a.mp3')
    assert.equal(toPortablePath(path.join(episodes, 'Season 001', 'x.srt'), episodes), '${PROJECT}/Season 001/x.srt')

    // The retired custom-folder token still throws — it was never a folder.
    assert.throws(() => resolveAssetPath('${MY_FOLDER}/logo.png'), /not a folder Story Studio knows about/i)
    // A background reference with no id names what it needs.
    assert.throws(() => resolveAssetPath('${BACKGROUND}'), /catalog entry/i)
  })
})