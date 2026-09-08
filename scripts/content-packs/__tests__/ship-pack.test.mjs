/**
 * Gates, reproducibility and manifest completeness for `content-pack:ship`.
 *
 * The fixtures here are not hand-written registries. A registry record is
 * content-addressed — its receipt is a hash over the exact reservation request
 * — so a registry typed out by hand is either invalid or a copy of a real one
 * that will rot. Instead these tests build a throwaway repository and drive it
 * through the same `reserveAuthoringBatch` / `transitionAuthoringRecord` API an
 * author uses. The gate under test is therefore the real gate, and a change to
 * the registry contract breaks these tests loudly rather than silently leaving
 * them asserting against a shape nothing produces any more.
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import JSZip from 'jszip'

import { reserveAuthoringBatch, transitionAuthoringRecord } from '../authoring-registry.mjs'
import { MARKS } from './forbidden-marks.mjs'
import {
  MANIFEST_VERSION,
  REQUIRED_ARCHIVE_FIELDS,
  archiveFileName,
  missingManifestFields,
  resolveSelections,
  scanEntriesForForbiddenMarks,
  shipContentPacks,
} from '../ship-pack.mjs'

const execFileAsync = promisify(execFile)

const REPOSITORY_ROOT = new URL('../../../', import.meta.url).pathname
const DONOR_PACK = 'content-packs/production-looks/style/anime-cel'
const FIXTURE_PACK_ID = 'com.storystudio.pack.style.ship-fixture'
const FIXTURE_ITEM_ID = 'com.storystudio.style.ship-fixture'
const FIXTURE_SOURCE_PATH = 'content-packs/style/ship-fixture'

const temporaryRoots = []

async function temporaryDirectory(prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryRoots.push(directory)
  return directory
}

test.after(async () => {
  for (const directory of temporaryRoots) await rm(directory, { recursive: true, force: true })
})

/**
 * A complete throwaway repository holding exactly one authored pack.
 *
 * The pack is a copy of a real style pack — binary preview asset included — so
 * that what is built here exercises the same code path as a real pack rather
 * than a minimal shape that happens to satisfy the schema. `description` is the
 * only knob: passing one that names a trademark is how the forbidden-mark
 * refusal is provoked.
 */
async function fixtureRepository({ description }) {
  const root = await temporaryDirectory('story-ship-fixture-')
  const source = join(root, FIXTURE_SOURCE_PATH)
  const entitlement = { sku: 'com.storystudio.sku.style.ship-fixture', family: 'com.storystudio.family.style.ship-fixture' }
  await mkdir(join(root, 'content-packs'), { recursive: true })
  await writeFile(join(root, 'content-packs/release-floor.json'), `${JSON.stringify({ min_app_version: '1.0.843' }, null, 2)}\n`)

  // `source_commit` is a required manifest field, so the shipper reads HEAD and
  // is right to fail outside a repository. The fixture is a real one.
  await execFileAsync('git', ['init', '-q'], { cwd: root })
  await execFileAsync('git', ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-q', '--allow-empty', '-m', 'fixture'], { cwd: root })

  const registryPath = join(root, 'content-packs/authoring-registry.json')
  await writeFile(registryPath, `${JSON.stringify({ revision: 1, batches: [], transitions: [], records: [] }, null, 2)}\n`)

  const coordinator = { task: 'ship-pack tests', branch: 'test' }
  const record = {
    pack_id: FIXTURE_PACK_ID,
    item_id: FIXTURE_ITEM_ID,
    version: '1.0.0',
    publisher_id: 'com.storystudio',
    min_app_version: '{{MIN_APP_VERSION}}',
    min_app_version_status: 'release-bound',
    kind: 'visual-style',
    source_path: FIXTURE_SOURCE_PATH,
    status: 'reserved',
    dependencies: [],
    stocking_proposal: { family: { id: entitlement.family, status: 'proposed' }, sku: { id: entitlement.sku, status: 'proposed' } },
  }
  // Reserved first, with nothing on disk: a reservation claims the identity
  // before the pack is written, and the registry rejects a source that appears
  // without one. Authoring the files second is the order an author works in.
  const reserved = await reserveAuthoringBatch({
    registryPath,
    repositoryRoot: root,
    request: { expected_revision: 1, coordinator, proposal_ref: 'ship-pack test fixture', records: [record] },
  })

  await cp(join(REPOSITORY_ROOT, DONOR_PACK), source, { recursive: true })
  const manifest = JSON.parse(await readFile(join(source, 'pack.json'), 'utf8'))
  manifest.pack_id = FIXTURE_PACK_ID
  manifest.entitlement = entitlement
  await writeFile(join(source, 'pack.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  const [documentName] = await readdir(join(source, 'content'))
  const document = JSON.parse(await readFile(join(source, 'content', documentName), 'utf8'))
  document.id = FIXTURE_ITEM_ID
  document.name = 'Ship Fixture'
  document.description = description
  await writeFile(join(source, 'content', documentName), `${JSON.stringify(document, null, 2)}\n`)

  await transitionAuthoringRecord({
    registryPath,
    repositoryRoot: root,
    request: {
      expected_revision: reserved.revision,
      coordinator,
      receipt_ref: reserved.receipt_ref,
      pack_id: FIXTURE_PACK_ID,
      version: '1.0.0',
      changes: { status: 'authored' },
    },
  })

  return { root, registryPath }
}

const REGISTRY_RECORDS = [
  { pack_id: 'com.storystudio.pack.style.ready', version: '1.0.0', status: 'authored', source_path: 'content-packs/family/style/ready' },
  { pack_id: 'com.storystudio.pack.style.ready', version: '1.0.1', status: 'reserved', source_path: 'content-packs/family/style/ready-next' },
  { pack_id: 'com.storystudio.pack.style.ready', version: '1.0.2', status: 'withdrawn', source_path: 'content-packs/family/style/ready-withdrawn' },
  { pack_id: 'com.storystudio.pack.style.waiting', version: '1.0.0', status: 'reserved', source_path: 'content-packs/family/style/waiting' },
  { pack_id: 'com.storystudio.pack.kit.historical', version: '1.0.0', kind: 'channel-kit', status: 'authored', source_path: 'content-packs/family/kit/historical' },
]

test('an unregistered selector is refused, and selects nothing to build', () => {
  const { selected, refusals } = resolveSelections(REGISTRY_RECORDS, ['com.storystudio.pack.style.imaginary'])

  assert.equal(selected.length, 0)
  assert.equal(refusals.length, 1)
  assert.match(refusals[0].reason, /is not in the authoring registry/)
  assert.match(refusals[0].reason, /content-pack:registry -- reserve/)
})

test('a selector matching only unauthored records is refused, naming the missing step', () => {
  const { selected, refusals } = resolveSelections(REGISTRY_RECORDS, ['com.storystudio.pack.style.waiting'])

  assert.equal(selected.length, 0)
  assert.equal(refusals.length, 1)
  assert.match(refusals[0].reason, /"reserved" rather than "authored"/)
  assert.match(refusals[0].reason, /content-pack:registry -- transition/)
})

test('a direct withdrawn selector is terminal and a mixed selector skips it while shipping authored leaves', () => {
  const direct = resolveSelections(REGISTRY_RECORDS, ['content-packs/family/style/ready-withdrawn'])
  assert.deepEqual(direct.selected, [])
  assert.equal(direct.refusals.length, 1)
  assert.match(direct.refusals[0].reason, /withdrawn.*terminal|terminal.*withdrawn/i)

  const mixed = resolveSelections(REGISTRY_RECORDS, ['com.storystudio.pack.style.ready'])
  assert.deepEqual(mixed.refusals, [])
  assert.deepEqual(mixed.selected.map(record => record.version), ['1.0.0'])
  assert.deepEqual(mixed.skipped, [
    { pack_id: 'com.storystudio.pack.style.ready', version: '1.0.1', status: 'reserved' },
    { pack_id: 'com.storystudio.pack.style.ready', version: '1.0.2', status: 'withdrawn' },
  ])
})

test('a direct Channel Kit selection is terminal and a mixed selector ships only standalone leaves', () => {
  const direct = resolveSelections(REGISTRY_RECORDS, ['com.storystudio.pack.kit.historical'])
  assert.deepEqual(direct.selected, [])
  assert.equal(direct.refusals.length, 1)
  assert.match(direct.refusals[0].reason, /Channel Kit.*terminal|terminal.*Channel Kit/i)

  const mixed = resolveSelections(REGISTRY_RECORDS, ['content-packs/family/*/*'])
  assert.deepEqual(mixed.refusals, [])
  assert.deepEqual(mixed.selected.map(record => record.pack_id), ['com.storystudio.pack.style.ready'])
  assert.ok(mixed.skipped.some(record => record.pack_id === 'com.storystudio.pack.kit.historical' && /Channel Kit/i.test(record.status)))
})

test('a selector spanning authored and unauthored records ships what is ready and reports the rest', () => {
  const { selected, skipped, refusals } = resolveSelections(REGISTRY_RECORDS, ['com.storystudio.pack.style.ready'])

  assert.deepEqual(refusals, [])
  assert.deepEqual(selected.map(record => record.version), ['1.0.0'])
  assert.deepEqual(skipped, [
    { pack_id: 'com.storystudio.pack.style.ready', version: '1.0.1', status: 'reserved' },
    { pack_id: 'com.storystudio.pack.style.ready', version: '1.0.2', status: 'withdrawn' },
  ])
})

test('a glob selects across a family by source path', () => {
  const { selected, refusals } = resolveSelections(REGISTRY_RECORDS, ['content-packs/family/style/*'])

  assert.deepEqual(refusals, [])
  assert.deepEqual(selected.map(record => record.pack_id), ['com.storystudio.pack.style.ready'])
})

test('manifest completeness names every field GenStudio stocks from', () => {
  const archive = Object.fromEntries(REQUIRED_ARCHIVE_FIELDS.map(field => [field, field === 'bytes' ? 1 : `value-${field}`]))
  const manifest = {
    manifest_version: MANIFEST_VERSION,
    artifact_set: 'set',
    generated_at: '2026-08-28T00:00:00.000Z',
    source: { commit: 'abc' },
    build_profile: { delivery_profile: 'genstudio-store-receipt-v1' },
    archives: [archive],
  }

  assert.deepEqual(missingManifestFields(manifest), [])

  for (const field of REQUIRED_ARCHIVE_FIELDS) {
    const damaged = { ...manifest, archives: [{ ...archive, [field]: undefined }] }
    assert.deepEqual(missingManifestFields(damaged), [`archives[0].${field}`], `removing ${field} must be reported`)
  }
  assert.deepEqual(missingManifestFields({ ...manifest, manifest_version: 99 }), ['manifest_version'])
})

test('the forbidden-mark scan reads entry names and binary bytes, NUL bytes included', () => {
  const binary = Buffer.concat([Buffer.from([0x89, 0x50, 0x00, 0x00, 0x1a]), Buffer.from('made in Photoshop'), Buffer.from([0x00, 0xff])])

  const inBytes = scanEntriesForForbiddenMarks([{ name: 'assets/preview.webp', bytes: binary }])
  assert.equal(inBytes.length, 1)
  assert.equal(inBytes[0].matched, 'Photoshop')
  assert.equal(inBytes[0].where, 'contents')

  const inName = scanEntriesForForbiddenMarks([{ name: 'assets/YouTube-thumb.webp', bytes: Buffer.from('clean') }])
  assert.equal(inName.length, 1)
  assert.equal(inName[0].where, 'entry name')

  assert.deepEqual(scanEntriesForForbiddenMarks([{ name: 'content/style.json', bytes: Buffer.from('{"name":"Anime Cel"}') }]), [])
  assert.ok(MARKS.length > 0)
})

/**
 * The JSON entries are scanned as documents, so that the guard enforces the
 * decision it exists for — marks out of what a customer SEES — rather than
 * refusing internal lookup keys the owner deliberately kept.
 *
 * The fixture is the real shape this turned on: `metadata_profile.id` is
 * `evidence-youtube` in nine published free-starter formula packs.
 */
const METADATA_PROFILE = { id: 'evidence-youtube', label: 'Evidence-led video package', youtube_tags_hint: ['deep time'] }

test('an internal identifier value may name a mark, because no customer reads it', () => {
  const document = Buffer.from(JSON.stringify({ name: 'Ancient Humans', metadata_profile: METADATA_PROFILE }))
  assert.deepEqual(scanEntriesForForbiddenMarks([{ name: 'content/series-formula.json', bytes: document }]), [])
})

test('the same mark in a customer-visible value is still refused', () => {
  for (const field of ['label', 'name', 'description']) {
    const document = Buffer.from(JSON.stringify({
      metadata_profile: { ...METADATA_PROFILE, [field]: 'Evidence-led YouTube package' },
    }))
    const hits = scanEntriesForForbiddenMarks([{ name: 'content/series-formula.json', bytes: document }])
    assert.equal(hits.length, 1, `a mark in ${field} must be refused`)
    assert.equal(hits[0].matched, 'YouTube')
    assert.equal(hits[0].where, `contents at metadata_profile.${field}`)
  }
})

test('only the exact identifier keys are exempt, never a wider set', () => {
  // `meaningfulStrings` skips `id`, `*_id` and `*_ids`. Anything else that merely
  // looks like an identifier is customer-readable text as far as this guard knows.
  for (const key of ['identifier', 'slug', 'idea', 'profile_identity']) {
    const hits = scanEntriesForForbiddenMarks([
      { name: 'content/series-formula.json', bytes: Buffer.from(JSON.stringify({ [key]: 'evidence-YouTube' })) },
    ])
    assert.equal(hits.length, 1, `${key} is not an identifier key and must still be scanned`)
  }
  for (const key of ['id', 'profile_id', 'section_ids']) {
    const value = key.endsWith('_ids') ? ['evidence-YouTube'] : 'evidence-YouTube'
    assert.deepEqual(
      scanEntriesForForbiddenMarks([
        { name: 'content/series-formula.json', bytes: Buffer.from(JSON.stringify({ [key]: value })) },
      ]),
      [], `${key} is an identifier key and is exempt`)
  }
})

test('a JSON entry that does not parse is byte-scanned rather than skipped', () => {
  const truncated = Buffer.from('{"label": "Evidence-led YouTube package"')
  const hits = scanEntriesForForbiddenMarks([{ name: 'content/broken.json', bytes: truncated }])
  assert.equal(hits.length, 1, 'unparseable must never mean unscanned')
  assert.equal(hits[0].matched, 'YouTube')
  assert.match(hits[0].where, /unparseable JSON, byte-scanned/)
})

test('a mark in a JSON key name is still looked at', () => {
  // Not exempt — merely spared by the word boundary, which is what lets
  // `youtube_tags_hint` through while a bare key would be caught.
  assert.deepEqual(scanEntriesForForbiddenMarks([
    { name: 'content/a.json', bytes: Buffer.from(JSON.stringify({ youtube_tags_hint: [] })) },
  ]), [])
  const hits = scanEntriesForForbiddenMarks([
    { name: 'content/b.json', bytes: Buffer.from(JSON.stringify({ YouTube: [] })) },
  ])
  assert.equal(hits.length, 1)
  assert.equal(hits[0].where, 'key name YouTube')
})

test('a pack whose content names a forbidden mark is refused rather than shipped', async () => {
  const { root, registryPath } = await fixtureRepository({ description: 'A look assembled in Photoshop for editorial work.' })
  const outputDirectory = join(await temporaryDirectory('story-ship-out-'), 'artifacts')

  await assert.rejects(
    shipContentPacks({ selectors: [FIXTURE_PACK_ID], outputDirectory, repositoryRoot: root, registryPath }),
    error => {
      assert.match(error.message, /forbidden third-party mark/)
      assert.match(error.message, /Photoshop/)
      return true
    },
  )

  assert.deepEqual(await readdir(outputDirectory).catch(() => []), [], 'a refused pack must leave no archive behind')
})

test('shipping builds byte-identically, files a complete manifest, and re-verifies instead of rebuilding blind', async () => {
  const { root, registryPath } = await fixtureRepository({ description: 'A clean look with no third-party marks.' })
  const outputDirectory = join(await temporaryDirectory('story-ship-out-'), 'artifacts')

  const first = await shipContentPacks({ selectors: [FIXTURE_PACK_ID], outputDirectory, repositoryRoot: root, registryPath })

  assert.deepEqual(first.refusals, [])
  assert.equal(first.packs.length, 1)
  const [pack] = first.packs
  assert.equal(pack.state, 'shipped')
  assert.deepEqual(pack.reproducibility, { builds: 2, byte_identical: true })
  assert.equal(pack.forbidden_mark_scan.hits, 0)
  assert.equal(pack.validator, 'PASS (genstudio-store-receipt-v1)')
  assert.equal(pack.min_story_version, '1.0.843', 'the release floor, not a constant, sets the minimum')
  assert.equal(pack.entitlement_family, 'com.storystudio.family.style.ship-fixture')
  assert.equal(pack.title, 'Ship Fixture')
  assert.equal(pack.kind, 'visual-style')
  assert.equal(pack.key_id_present, false)
  assert.equal(pack.signature_present, false)

  const fileName = archiveFileName({ pack_id: FIXTURE_PACK_ID, publisher_id: 'com.storystudio', version: '1.0.0' })
  assert.equal(pack.file, fileName)

  const written = JSON.parse(await readFile(join(first.outputDirectory, 'manifest.json'), 'utf8'))
  assert.deepEqual(missingManifestFields(written), [])
  assert.equal(written.build_profile.min_app_version_source, 'content-packs/release-floor.json')
  assert.match(written.build_profile.publisher_signing, /keyless by design/)

  // The archive really is keyless: no signature entry, no key_id in its manifest.
  const archive = await JSZip.loadAsync(await readFile(join(first.outputDirectory, fileName)))
  assert.equal(archive.files['signature.ed25519'], undefined)
  assert.equal(JSON.parse(await archive.files['manifest.json'].async('string')).key_id, undefined)

  const second = await shipContentPacks({ selectors: [FIXTURE_PACK_ID], outputDirectory, repositoryRoot: root, registryPath })
  assert.equal(second.packs[0].state, 'already shipped (re-verified, sha matches)')
  assert.equal(second.packs[0].sha256, pack.sha256)
})

test('a folder whose manifest predates the schema is refused rather than half-carried forward', async () => {
  const { root, registryPath } = await fixtureRepository({ description: 'A clean look with no third-party marks.' })
  const outputDirectory = join(await temporaryDirectory('story-ship-out-'), 'artifacts')

  const first = await shipContentPacks({ selectors: [FIXTURE_PACK_ID], outputDirectory, repositoryRoot: root, registryPath })

  // A neighbour filed by an older tool: present in the manifest, missing the
  // fields GenStudio stocks from. Re-shipping must not carry it forward silently.
  const manifestPath = join(first.outputDirectory, 'manifest.json')
  const document = JSON.parse(await readFile(manifestPath, 'utf8'))
  const { entitlement_family: _dropped, ...stale } = document.archives[0]
  document.archives.push({ ...stale, pack_id: 'com.storystudio.pack.style.older-neighbour', file: 'style-older-neighbour-1.0.0.sspack' })
  await writeFile(manifestPath, `${JSON.stringify(document, null, 2)}\n`)

  await assert.rejects(
    shipContentPacks({ selectors: [FIXTURE_PACK_ID], outputDirectory, repositoryRoot: root, registryPath }),
    error => {
      assert.match(error.message, /was written before manifest_version 1/)
      assert.match(error.message, /older-neighbour/)
      return true
    },
  )
})

test('a dry run reports the gates and builds nothing', async () => {
  const { root, registryPath } = await fixtureRepository({ description: 'A clean look with no third-party marks.' })
  const outputDirectory = join(await temporaryDirectory('story-ship-out-'), 'artifacts')

  const result = await shipContentPacks({ selectors: [FIXTURE_PACK_ID], outputDirectory, repositoryRoot: root, registryPath, dryRun: true })

  assert.equal(result.dryRun, true)
  assert.equal(result.manifest, undefined)
  assert.equal(result.packs.length, 1)
  assert.deepEqual(result.packs[0].gates, { registry_status: 'authored', registry_integrity: 'PASS', forbidden_marks: 'PASS (source)' })
  assert.equal(result.packs[0].state, 'would build')
  assert.deepEqual(await readdir(outputDirectory).catch(() => []), [], 'a dry run must not create archives')
})

test('the shipped Production Looks packs still pass their gates and match what was filed', async () => {
  const result = await shipContentPacks({
    selectors: ['content-packs/production-looks/style/*'],
    outputDirectory: await temporaryDirectory('story-ship-unfiled-'),
    dryRun: true,
  })

  assert.deepEqual(result.refusals, [])
  // Twelve, not six: the 2026-09-08 preview backfill gave each of the six a
  // 1.0.1 successor in a sibling directory, and the selector is a glob over
  // that directory. Both generations must pass the same gates — the successor
  // is what a buyer now acquires, and the predecessor is still on the shelf.
  assert.equal(result.packs.length, 12)
  assert.deepEqual(
    [...new Set(result.packs.map(pack => pack.version))].sort(),
    ['1.0.0', '1.0.1'],
  )
  for (const pack of result.packs) {
    assert.equal(pack.gates.registry_status, 'authored')
    assert.equal(pack.gates.registry_integrity, 'PASS')
    assert.equal(pack.gates.forbidden_marks, 'PASS (source)')
    assert.equal(pack.min_story_version, '1.0.843')
  }
})
