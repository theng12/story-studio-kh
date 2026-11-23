import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import {
  isTextVariantFile, nextVariantPath, sidecarPathFor, buildSidecar,
  writeSidecar, readSidecar, sourceIdentity, variantStaleness, listVariants,
  assertVariantUploadable,
} from '../services/thumbnail-text-variants.js'
import { listBuiltinPresets } from '../lib/thumbnail-text-presets.js'

let tempDir: string
let number = 0
before(async () => {
  tempDir = await fs.mkdtemp(path.join(process.env.TMPDIR || '/tmp', 'thumb-text-variants-'))
})
after(async () => {
  if (process.env.STORY_STUDIO_TEST_HARNESS_ROOT) return // retained by the focused runner
  const trash = process.env.STORY_STUDIO_TRASH_ROOT || path.join(tmpdir(), 'story-studio-thumbnail-text-tests')
  await fs.mkdir(trash, { recursive: true })
  await fs.rename(tempDir, path.join(trash, path.basename(tempDir)))
})

async function fixture() {
  const dir = path.join(tempDir, `fixture-${++number}`)
  await fs.mkdir(dir)
  const source = path.join(dir, 'art.png')
  const original = Buffer.from('original source bytes')
  await fs.writeFile(source, original)
  const identity = await sourceIdentity(source)
  const variant = path.join(dir, 'art_text-1.png')
  await fs.writeFile(variant, 'variant bytes')
  const sidecar = buildSidecar({
    sourceFilename: 'art.png', sourceSha256: identity.sha256, sourceBytes: identity.bytes,
    text: 'សួស្តី', style: (await listBuiltinPresets())[0]!.style,
    fontSha256: 'font-hash', appVersion: 'test-version',
  })
  await writeSidecar(variant, sidecar)
  return { dir, source, original, identity, variant, sidecar }
}

test('variant detection matches the filename ending, never a sidecar or neighboring file', () => {
  for (const filename of ['art_text-1.png', 'art_text-12.jpg', 'art_text-2.JPEG']) assert.equal(isTextVariantFile(filename), true)
  for (const filename of ['art.png', 'art_v2.png', 'art_text-1.png.text-layer.json', 'art_text-1.png.backup', 'art_text-1.bmp']) {
    assert.equal(isTextVariantFile(filename), false, filename)
  }
})

test('variant numbering preserves existing files and escapes punctuation in source stems', async () => {
  const f = await fixture()
  const first = await nextVariantPath(f.dir, 'art.png')
  assert.equal(first.filename, 'art_text-2.png')
  await fs.writeFile(first.fullPath, 'second variant')
  assert.equal((await nextVariantPath(f.dir, 'art.png')).filename, 'art_text-3.png')
  await fs.writeFile(path.join(f.dir, 'art[1]_text-4.png'), 'existing')
  assert.equal((await nextVariantPath(f.dir, 'art[1].png')).filename, 'art[1]_text-5.png')
  assert.equal(await fs.readFile(f.variant, 'utf8'), 'variant bytes')
})

test('sidecar round-trip records the exact source hash, text, look and provenance', async () => {
  const f = await fixture()
  assert.equal(sidecarPathFor(f.variant), `${f.variant}.text-layer.json`)
  assert.deepEqual(await readSidecar(f.variant), { ok: true, sidecar: f.sidecar })
  assert.equal(f.sidecar.schema, 1)
  assert.equal(f.sidecar.source_sha256, crypto.createHash('sha256').update(f.original).digest('hex'))
  assert.equal(f.sidecar.source_bytes, f.original.length)
  assert.equal(f.sidecar.text, 'សួស្តី')
  assert.equal(f.sidecar.font_sha256, 'font-hash')
  assert.equal(f.sidecar.app_version, 'test-version')
  assert.ok(Number.isFinite(Date.parse(f.sidecar.rendered_at)))
  assert.deepEqual(await variantStaleness(f.variant, f.dir), { stale: false, reason: null })
  assert.equal(await assertVariantUploadable(path.basename(f.variant), f.dir), null)
})

test('same-size changed source bytes are stale with mtime restored; original bytes heal it', async () => {
  const f = await fixture()
  const before = await fs.stat(f.source)
  const changed = Buffer.from(f.original)
  changed[0] = changed[0]! ^ 1
  await fs.writeFile(f.source, changed)
  await fs.utimes(f.source, before.atime, before.mtime)
  assert.equal((await fs.stat(f.source)).size, before.size)
  const verdict = await variantStaleness(f.variant, f.dir)
  assert.equal(verdict.stale, true)
  assert.match(verdict.reason!, /artwork changed.*re-apply/is)
  assert.match((await assertVariantUploadable(path.basename(f.variant), f.dir))!, /Nothing was uploaded/)
  await fs.writeFile(f.source, f.original)
  assert.deepEqual(await variantStaleness(f.variant, f.dir), { stale: false, reason: null })
})

test('touching only mtime does not stale a variant', async () => {
  const f = await fixture()
  const before = await fs.stat(f.source)
  await fs.utimes(f.source, before.atime, new Date(before.mtimeMs + 60_000))
  assert.notEqual((await fs.stat(f.source)).mtimeMs, before.mtimeMs)
  assert.deepEqual(await fs.readFile(f.source), f.original)
  assert.deepEqual(await variantStaleness(f.variant, f.dir), { stale: false, reason: null })
})

test('missing source is stale rather than silently measured as zero', async () => {
  const f = await fixture()
  await fs.rename(f.source, path.join(f.dir, 'retired-art.png'))
  await assert.rejects(() => sourceIdentity(f.source), { code: 'ENOENT' })
  const verdict = await variantStaleness(f.variant, f.dir)
  assert.equal(verdict.stale, true)
  assert.match(verdict.reason!, /artwork.*gone.*re-apply/is)
})

test('missing or malformed provenance fails closed; a backup suffix does not count', async () => {
  const f = await fixture()
  const sidecar = sidecarPathFor(f.variant)
  await fs.rename(sidecar, `${sidecar}.backup`)
  assert.equal((await readSidecar(f.variant)).ok, false)
  assert.equal((await variantStaleness(f.variant, f.dir)).stale, true)
  for (const bytes of ['{', '{}', 'null']) {
    await fs.writeFile(sidecar, bytes)
    assert.equal((await readSidecar(f.variant)).ok, false)
    const verdict = await variantStaleness(f.variant, f.dir)
    assert.equal(verdict.stale, true)
    assert.match(verdict.reason!, /record|read|again/i)
  }
})

test('listing includes valid and stale items without mistaking ordinary art or sidecars for variants', async () => {
  const f = await fixture()
  await fs.writeFile(path.join(f.dir, 'art_text-2.png'), 'orphan variant')
  await fs.writeFile(path.join(f.dir, 'art_text-3.png.backup'), 'neighbor')
  const rows = await listVariants(f.dir)
  assert.deepEqual(rows.map(row => row.filename), ['art_text-1.png', 'art_text-2.png'])
  assert.deepEqual(rows[0], { filename: 'art_text-1.png', source_filename: 'art.png', text: 'សួស្តី', stale: false, stale_reason: null })
  assert.equal(rows[1]!.stale, true)
  assert.match(rows[1]!.stale_reason!, /missing/i)
  assert.deepEqual(await listVariants(path.join(f.dir, 'absent')), [])
})

test('upload guard refuses a missing variant and leaves ordinary art alone', async () => {
  const f = await fixture()
  assert.match((await assertVariantUploadable('art_text-999.png', f.dir))!, /no longer on disk.*apply/is)
  assert.equal(await assertVariantUploadable('art.png', f.dir), null)
})
