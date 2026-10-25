/**
 * Bundled font integrity — is each shipped file the genuine face the manifest names?
 *
 * A fingerprint match alone cannot answer that: it only proves the manifest agrees with whatever
 * is on disk, so a wrong FILE passes as readily as a wrong manifest entry (one of them was in fact
 * wrong once — see the Battambang note below). These checks read the font's own internals:
 *
 *  - every sfnt table checksum recomputed and compared (a truncated or edited file fails);
 *  - the `name` table's family/subfamily/version, compared with the manifest's family and the
 *    upstream version the licence notes name;
 *  - the cmap's real coverage, read through the production `missingCharacters` reader.
 *
 * Battambang's recorded SHA-256 was corrected on 2026-10-25: the manifest carried
 * `...fb4184b20198...` where the file hashes to `...fb4184b22198...`. The FILE was proven genuine
 * before the manifest was touched — all 17 sfnt table checksums recompute, the name table reads
 * Battambang/Bold, Version 8.002, designer Danh Hong, and the file is byte-identical to the
 * upstream Google Fonts build (`ofl/battambang/Battambang-Bold.ttf`). The manifest was the typo.
 * (All five bundled fonts were checked the same way against upstream; every one matched.)
 * The upstream comparison is a one-off manual check, not a test — the suite makes no network call.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { describe, test } from 'node:test'
import { fontFilePath, fontManifestPath, listThumbnailFonts, readFontManifest } from '../lib/thumbnail-fonts.js'
import { missingCharacters } from '../lib/font-coverage.js'

// ── Minimal sfnt readers (no dependency; the build ships no font tooling) ────

interface SfntTable { checksum: number, offset: number, length: number }

function readTables(bytes: Buffer): Map<string, SfntTable> {
  const tableCount = bytes.readUInt16BE(4)
  const tables = new Map<string, SfntTable>()
  for (let index = 0; index < tableCount; index++) {
    const record = 12 + index * 16
    const tag = bytes.toString('latin1', record, record + 4)
    tables.set(tag, {
      checksum: bytes.readUInt32BE(record + 4),
      offset: bytes.readUInt32BE(record + 8),
      length: bytes.readUInt32BE(record + 12),
    })
  }
  return tables
}

/** A table's stored checksum, recomputed from its bytes (`head` is summed with the field zeroed). */
function tableChecksum(bytes: Buffer, tag: string, table: SfntTable): number {
  const raw = Buffer.from(bytes.subarray(table.offset, table.offset + table.length))
  if (tag === 'head') raw.writeUInt32BE(0, 8)
  const padded = Buffer.concat([raw, Buffer.alloc((4 - (raw.length % 4)) % 4)])
  let sum = 0
  for (let index = 0; index < padded.length; index += 4) sum = (sum + padded.readUInt32BE(index)) >>> 0
  return sum
}

const NAME_IDS = { 1: 'family', 2: 'subfamily', 5: 'version', 6: 'postscript', 0: 'copyright' } as const

function readNameTable(bytes: Buffer, table: SfntTable): Record<string, string> {
  const base = table.offset
  const count = bytes.readUInt16BE(base + 2)
  const stringOffset = base + bytes.readUInt16BE(base + 4)
  const names: Record<string, string> = {}
  for (let index = 0; index < count; index++) {
    const record = base + 6 + index * 12
    const platform = bytes.readUInt16BE(record)
    const nameId = bytes.readUInt16BE(record + 6)
    const length = bytes.readUInt16BE(record + 8)
    const offset = bytes.readUInt16BE(record + 10)
    const label = NAME_IDS[nameId as keyof typeof NAME_IDS]
    if (!label || names[label] !== undefined) continue
    const raw = bytes.subarray(stringOffset + offset, stringOffset + offset + length)
    // Platform 3 (Windows) uses UTF-16 BE, not LE.
    names[label] = platform === 3 ? Buffer.from(raw).swap16().toString('utf16le') : raw.toString('latin1')
  }
  return names
}

// ── The checks ──────────────────────────────────────────────────────────────

describe('bundled fonts — the file is the face the manifest names', () => {
  test('every bundled font hashes to its recorded SHA-256', async () => {
    for (const entry of (await readFontManifest()).fonts) {
      const bytes = readFileSync(fontFilePath(entry))
      assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, entry.id)
    }
  })

  test('every bundled font is internally intact: each table checksum recomputes', async () => {
    for (const entry of (await readFontManifest()).fonts) {
      const bytes = readFileSync(fontFilePath(entry))
      const tables = readTables(bytes)
      assert.ok(tables.has('head'), `${entry.id} is not a packed font file`)
      for (const [tag, table] of tables) {
        assert.ok(
          table.offset + table.length <= bytes.length,
          `${entry.id}: table ${tag} runs past the end of the file`,
        )
        assert.equal(
          tableChecksum(bytes, tag, table), table.checksum,
          `${entry.id}: table ${tag} checksum does not match its bytes`,
        )
      }
    }
  })

  test('each font identifies itself as the family the manifest offers', async () => {
    for (const entry of (await readFontManifest()).fonts) {
      const bytes = readFileSync(fontFilePath(entry))
      const names = readNameTable(bytes, readTables(bytes).get('name')!)
      assert.equal(names.family, entry.family, `${entry.id}: family table says ${names.family}`)
      assert.ok(names.version, `${entry.id}: no version recorded in the name table`)
      // A variable font's file stem is `Inter[opsz,wght]`; its PostScript name is `Inter-Regular`.
      const normalizedFamily = entry.family.toLowerCase().replace(/[^a-z0-9]/g, '')
      const normalizedPostScript = String(names.postscript).toLowerCase().replace(/[^a-z0-9]/g, '')
      assert.ok(
        normalizedPostScript.startsWith(normalizedFamily),
        `${entry.id}: postscript name ${names.postscript} does not name the family ${entry.family}`,
      )
    }
  })

  test('each font covers the scripts the manifest claims, through the production reader', async () => {
    const entries = (await readFontManifest()).fonts
    const publicFonts = await listThumbnailFonts()
    for (const entry of entries) {
      const publicFont = publicFonts.find(font => font.id === entry.id)!
      const file = fontFilePath(entry)
      assert.deepEqual(
        await missingCharacters(file, 'Hello\nABCDEFGHIJKLMNOPQRSTUVWXYZ'),
        [],
        `${entry.id} must cover basic Latin`,
      )
      const khmerMissing = await missingCharacters(file, 'សួស្តី')
      if (publicFont.scripts.includes('khmr')) {
        assert.deepEqual(khmerMissing, [], `${entry.id} declares khmr and must cover Khmer`)
      } else {
        // A 'latn'-only face must NOT have Khmer glyphs — that is what the renderer refuses on.
        assert.notDeepEqual(khmerMissing, [], `${entry.id} declares no khmr script but has Khmer glyphs`)
      }
    }
  })

  test('Battambang is the genuine upstream Bold, version 8.002, with full Khmer coverage', async () => {
    const entry = (await readFontManifest()).fonts.find(font => font.id === 'battambang')!
    const bytes = readFileSync(fontFilePath(entry))
    const names = readNameTable(bytes, readTables(bytes).get('name')!)
    assert.equal(names.family, 'Battambang')
    assert.equal(names.subfamily, 'Bold')
    assert.equal(names.postscript, 'Battambang-Bold')
    assert.match(names.version, /Version 8\.002/)
    assert.match(names.copyright, /Battambang Khmer Project Authors/)
    assert.equal(entry.family, 'Battambang')
    assert.deepEqual(entry.weights, [700])
    assert.deepEqual(entry.scripts, ['khmr', 'latn'])
    assert.deepEqual(await missingCharacters(fontFilePath(entry), 'សួស្តីពិភពលោក'), [])
    assert.equal(entry.sha256, createHash('sha256').update(bytes).digest('hex'))
    assert.ok(fontManifestPath().endsWith('fonts.json'))
  })
})
