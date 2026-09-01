#!/usr/bin/env node
/**
 * Take an authored Content Pack all the way to a ready-to-stock artifact folder.
 *
 * WHY THIS EXISTS. Shipping a pack used to be six manual steps performed by
 * hand, in order, from memory: check the registry, build with the right
 * profile and no key, build a second time and compare, scan for trademarks in
 * a way that survives NUL bytes, validate, then hand-write a manifest that
 * GenStudio can stock from. Every wave re-derived that sequence, and the parts
 * that were easy to forget (the second build, the exact min app version, the
 * entitlement family GenStudio needs) were the parts that mattered. This
 * command is that sequence, written down once.
 *
 * THE TWO RULES IT ENFORCES SILENTLY, because they keep biting people:
 *   1. Store archives are KEYLESS BY DESIGN. The store delivery profile is
 *      receipt-attested, and `buildContentPack` refuses a private key on that
 *      path. This command never accepts, reads, or asks for a signing key.
 *   2. A published (pack_id, version, sha256) is IMMUTABLE. Re-running against
 *      a folder that already holds an archive re-verifies it and refuses to
 *      overwrite; changed content ships as a new version, never as new bytes
 *      under an old one.
 *
 * Usage: node scripts/content-packs/ship-pack.mjs <selector...> [--out <dir>] [--dry-run]
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import JSZip from 'jszip'

import { validateAuthoringRegistry } from './authoring-registry.mjs'
import { buildContentPack, validateContentPack } from './lib.mjs'
import { MARKS, meaningfulStrings } from './__tests__/forbidden-marks.mjs'

const execFileAsync = promisify(execFile)

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
// model-drift-allow: Frozen Content Store receipt profile is the only profile the Store accepts.
export const DELIVERY_PROFILE = 'genstudio-store-receipt-v1'
export const MIN_APP_VERSION_TOKEN = '{{MIN_APP_VERSION}}'
export const MANIFEST_VERSION = 1

/**
 * The manifest contract between this repository and GenStudio's stocking tool.
 *
 * Every field here is one GenStudio needs to create or update a product without
 * asking a human a question. Adding a field is safe; removing or renaming one
 * breaks stocking, so treat this list as the published shape of `manifest.json`.
 */
export const REQUIRED_ARCHIVE_FIELDS = Object.freeze([
  'file',
  'sha256',
  'bytes',
  'pack_id',
  'version',
  'publisher_id',
  'kind',
  'title',
  'entitlement_family',
  'entitlement_sku',
  'min_story_version',
  'source_path',
  'source_commit',
  'build_command',
])

function fail(message) {
  throw new Error(`Content Pack shipper: ${message}`)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function today(now = new Date()) {
  return now.toISOString().slice(0, 10)
}

/** `com.storystudio.pack.style.anime-cel` @ 1.0.0 -> `style-anime-cel-1.0.0.sspack`. */
export function archiveFileName({ pack_id, publisher_id, version }) {
  const prefix = `${publisher_id}.pack.`
  const stem = pack_id.startsWith(prefix) ? pack_id.slice(prefix.length) : pack_id
  return `${stem.replace(/\./g, '-')}-${version}.sspack`
}

/**
 * The current minimum app version, read from data the owner can edit.
 *
 * It lives in `content-packs/release-floor.json` rather than in this file
 * because it is a commercial decision — every customer below the floor stops
 * seeing packs shipped after it moves — and those are never constants in code.
 */
export async function readReleaseFloor(repositoryRoot = ROOT) {
  const path = join(repositoryRoot, 'content-packs/release-floor.json')
  let document
  try {
    document = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    fail(`cannot read the release floor at content-packs/release-floor.json (${error instanceof Error ? error.message : String(error)})`)
  }
  const value = document?.min_app_version
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+$/.test(value)) {
    fail('content-packs/release-floor.json must declare min_app_version as an exact semantic version')
  }
  return value
}

function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`)
}

/**
 * Turn what a human typed into registry records.
 *
 * A selector is a pack id, a source path, or a glob over either.
 *
 * A REFUSAL MEANS NOTHING SHIPS. Refusals are collected rather than thrown so
 * that one command reports every problem at once, but the caller builds nothing
 * while any refusal stands. The earlier design refused one selector and shipped
 * the others in the same run, which wrote real archives to disk while exiting
 * non-zero — a gate reading only the exit code would have concluded that
 * nothing had been produced.
 *
 * A selector is refused when it matches no record at all, or when everything it
 * matches is still unauthored. It is NOT refused merely for sweeping up an
 * unauthored record alongside authored ones: a glob across a family, or a pack
 * id with an old reserved version beside a new authored one, should ship what
 * is ready and say plainly what it left behind.
 */
export function resolveSelections(records, selectors) {
  const selected = new Map()
  const skipped = new Map()
  const refusals = []
  for (const raw of selectors) {
    const selector = raw.replace(/\/+$/, '').replace(/^\.\//, '')
    const matches = selector.includes('*') || selector.includes('?')
      ? records.filter(record => globToRegExp(selector).test(record.pack_id) || globToRegExp(selector).test(record.source_path))
      : records.filter(record => record.pack_id === selector || record.source_path === selector)
    if (matches.length === 0) {
      refusals.push({
        selector: raw,
        reason: `"${raw}" is not in the authoring registry. Nothing can be shipped until the pack is reserved and authored there. Reserve it with: npm run content-pack:registry -- reserve --request <request.json>`,
      })
      continue
    }
    const authored = matches.filter(record => record.status === 'authored')
    if (authored.length === 0) {
      if (matches.every(record => record.status === 'withdrawn')) {
        refusals.push({
          selector: raw,
          reason: `"${raw}" selects a withdrawn registry identity. Withdrawal is terminal: it cannot be shipped, stocked, or revived.`,
        })
        continue
      }
      const statuses = [...new Set(matches.map(record => record.status))].join(', ')
      refusals.push({
        selector: raw,
        reason: `"${raw}" matches ${matches.length} registry record${matches.length === 1 ? '' : 's'}, but ${matches.length === 1 ? 'its status is' : 'every status is'} "${statuses}" rather than "authored". The authoring step has not been completed, so there is nothing approved to ship. Advance it with: npm run content-pack:registry -- transition --request <request.json>`,
      })
      continue
    }
    for (const record of authored) selected.set(`${record.pack_id}@${record.version}`, record)
    for (const record of matches.filter(record => record.status !== 'authored')) {
      skipped.set(`${record.pack_id}@${record.version}`, { pack_id: record.pack_id, version: record.version, status: record.status })
    }
  }
  const byPack = (a, b) => (a.pack_id < b.pack_id ? -1 : 1)
  return { selected: [...selected.values()].sort(byPack), skipped: [...skipped.values()].sort(byPack), refusals }
}

/**
 * WHAT THIS GUARD IS FOR, because it was once wider than the decision it enforces.
 *
 * The owner ruled on 2026-08-28 that third-party product marks must leave text
 * a CUSTOMER SEES. The first implementation scanned raw entry bytes, which is
 * wider than that: it also catches internal identifier VALUES such as
 * `evidence-youtube` — lookup keys the app branches on, never rendered, never
 * written to a customer's file. The approved scrub plan deliberately kept those
 * ids (`calm-youtube` had shipped under that spelling long before), so the byte
 * scan refused the very packs the ruling approved. Owner decision 2026-08-29:
 * make the scan smarter, never looser. The scan is now JSON-aware.
 *
 * NUL-SAFE ON PURPOSE for every non-JSON entry. The grep family treats a file
 * containing a NUL byte as binary and silently reports nothing, so a mark baked
 * into a `.webp` would pass a grep-based scan without ever being looked at.
 * Decoding as latin1 maps every byte to exactly one character, NUL included, so
 * the word-boundary regexes see the whole entry rather than its printable parts.
 *
 * MIRRORED IN GenStudio's `apps/cloud-api/app/tools/stock_pack.py`
 * (`forbidden_marks_in`), which is the last gate before a mark reaches a shelf.
 * Same convention as the forbidden-mark list itself: the two are duplicated
 * rather than shared, because they are different repositories and different
 * languages, so WIDEN OR NARROW THEM TOGETHER — and if they ever drift, the
 * Python one must be the stricter, never this one.
 */
export function jsonKeyNames(node, out = new Set()) {
  if (Array.isArray(node)) for (const item of node) jsonKeyNames(item, out)
  else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      out.add(key)
      jsonKeyNames(value, out)
    }
  }
  return out
}

/**
 * The text of one archive entry, as the mark scan should read it.
 *
 * A JSON entry is read as a document rather than as bytes, with exactly the
 * semantics of `meaningfulStrings()` — the same function
 * `published-mark-scrub.test.mjs` uses, IMPORTED rather than reimplemented so
 * the two can never drift. It exempts `id`, `*_id` and `*_ids` values and
 * scans every other string: labels, descriptions, hints, titles, prompts.
 * Narrowing that skip list is the only way this guard can be weakened, which
 * is why it lives in one place and is shared.
 *
 * Key names are scanned separately, because `meaningfulStrings` yields string
 * VALUES only and the byte scan this replaces did see key names. A key name is
 * not customer-visible text, so it is expected to be spared by the word
 * boundary rather than by exemption: `youtube_tags_hint` is followed by a word
 * character and therefore does not match.
 *
 * UNPARSEABLE NEVER MEANS UNSCANNED: a `.json` entry that does not parse falls
 * back to the byte scan. A guard that silently passes what it could not read
 * is worse than no guard.
 */
export function scannableTexts(name, bytes) {
  if (!name.endsWith('.json')) return [{ where: 'contents', text: Buffer.from(bytes).toString('latin1') }]
  let document
  try {
    document = JSON.parse(Buffer.from(bytes).toString('utf8'))
  } catch {
    return [{ where: 'contents (unparseable JSON, byte-scanned)', text: Buffer.from(bytes).toString('latin1') }]
  }
  return [
    ...[...jsonKeyNames(document)].map(key => ({ where: `key name ${key}`, text: key })),
    ...meaningfulStrings(document).map(([path, text]) => ({ where: `contents at ${path}`, text })),
  ]
}

export function scanEntriesForForbiddenMarks(entries) {
  const hits = []
  for (const { name, bytes } of entries) {
    const haystacks = [{ where: 'entry name', text: name }, ...scannableTexts(name, bytes)]
    for (const { where, text } of haystacks) {
      for (const mark of MARKS) {
        const found = text.match(mark)
        if (found) hits.push({ entry: name, where, mark: String(mark), matched: found[0] })
      }
    }
  }
  return hits
}

async function archiveEntries(archiveBytes) {
  const zip = await JSZip.loadAsync(archiveBytes)
  const entries = []
  for (const name of Object.keys(zip.files).sort()) {
    const file = zip.files[name]
    if (file.dir) continue
    entries.push({ name, bytes: await file.async('nodebuffer') })
  }
  return entries
}

async function sourceEntries(sourceDirectory) {
  const entries = []
  async function walk(directory) {
    for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = join(directory, item.name)
      if (item.isDirectory()) await walk(path)
      else if (item.isFile()) entries.push({ name: relative(sourceDirectory, path).split(sep).join('/'), bytes: await readFile(path) })
    }
  }
  await walk(sourceDirectory)
  return entries
}

/**
 * The customer-visible title of a pack, taken from the bytes that ship.
 *
 * Coordinators carry it on their single Channel Kit bundle; everything else
 * carries it on a content document. Reading it from the archive rather than
 * from the source means the manifest can never describe something the archive
 * does not contain.
 */
function titleFrom(manifest, entries) {
  if (manifest.bundles?.length) return manifest.bundles[0].name
  const documents = entries
    .filter(entry => entry.name.startsWith('content/') && entry.name.endsWith('.json'))
    .sort((a, b) => (a.name < b.name ? -1 : 1))
  for (const document of documents) {
    const name = JSON.parse(document.bytes.toString('utf8'))?.name
    if (typeof name === 'string' && name.length) return name
  }
  fail(`${manifest.pack_id} has no bundle name and no content document name to use as its title`)
}

function kindFrom(manifest) {
  if (manifest.bundles?.length) return manifest.bundles[0].kind
  const kinds = [...new Set(manifest.items.map(item => item.kind))]
  if (kinds.length !== 1) fail(`${manifest.pack_id} mixes item kinds (${kinds.join(', ')}); a pack must have one kind to be stocked`)
  return kinds[0]
}

async function gitCommit(repositoryRoot) {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot })
  return stdout.trim()
}

function buildCommandFor(record, { minAppVersion, usesToken, outputName }) {
  const parts = ['npm run content-pack:build --', `./${record.source_path}`, '--delivery-profile', DELIVERY_PROFILE]
  if (usesToken) parts.push('--min-app-version', minAppVersion)
  parts.push('--output', `./${outputName}`)
  return parts.join(' ')
}

/**
 * Build the same source twice into two fresh directories and prove the bytes
 * match. A pack that does not rebuild identically is not reproducible, and a
 * non-reproducible archive cannot be re-derived from the commit it claims.
 */
async function buildTwiceAndCompare(record, { minAppVersion, usesToken, fileName, repositoryRoot }) {
  const scratch = await mkdtemp(join(tmpdir(), 'story-ship-'))
  try {
    const outputs = []
    for (const attempt of ['a', 'b']) {
      const result = await buildContentPack({
        sourceDirectory: join(repositoryRoot, record.source_path),
        outputPath: join(scratch, attempt, fileName),
        deliveryProfile: DELIVERY_PROFILE,
        ...(usesToken ? { minAppVersion } : {}),
      })
      outputs.push({ ...result, bytes: await readFile(result.output) })
    }
    const [first, second] = outputs
    if (first.sha256 !== second.sha256 || !first.bytes.equals(second.bytes)) {
      fail(`${record.pack_id} did not rebuild byte-identically (${first.sha256} then ${second.sha256}); the source is not reproducible and must not be shipped`)
    }
    return { bytes: first.bytes, sha256: first.sha256, packId: first.packId, version: first.version }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/** Every required field is present and non-empty. Used by the shipper and by its tests. */
export function missingManifestFields(manifest) {
  const problems = []
  if (manifest?.manifest_version !== MANIFEST_VERSION) problems.push('manifest_version')
  for (const field of ['artifact_set', 'generated_at', 'source', 'build_profile', 'archives']) {
    if (manifest?.[field] === undefined) problems.push(field)
  }
  for (const [index, archive] of (manifest?.archives ?? []).entries()) {
    for (const field of REQUIRED_ARCHIVE_FIELDS) {
      const value = archive?.[field]
      if (value === undefined || value === null || value === '') problems.push(`archives[${index}].${field}`)
    }
  }
  return problems
}

async function existingArtifact(outputDirectory, fileName) {
  const path = join(outputDirectory, fileName)
  const info = await stat(path).catch(() => undefined)
  if (!info?.isFile()) return undefined
  const bytes = await readFile(path)
  return { path, bytes: info.size, sha256: sha256(bytes) }
}

async function existingManifest(outputDirectory) {
  const path = join(outputDirectory, 'manifest.json')
  const raw = await readFile(path, 'utf8').catch(() => undefined)
  if (raw === undefined) return undefined
  try {
    return JSON.parse(raw)
  } catch (error) {
    fail(`${path} exists but is not valid JSON; move it aside or delete it before shipping into this folder`)
  }
}

/**
 * Run every pack through gates, build, scan, validate and file.
 *
 * `dryRun` stops before any bytes are produced: it reports what the gates say
 * and reconciles anything already filed in the output folder, which is what
 * makes it safe to point at a folder that has already shipped.
 */
export async function shipContentPacks({
  selectors,
  outputDirectory,
  dryRun = false,
  repositoryRoot = ROOT,
  registryPath = join(ROOT, 'content-packs/authoring-registry.json'),
  now = new Date(),
} = {}) {
  if (!Array.isArray(selectors) || selectors.length === 0) fail('at least one pack selector is required')

  const registry = JSON.parse(await readFile(registryPath, 'utf8'))
  const { selected, skipped, refusals } = resolveSelections(registry.records ?? [], selectors)
  // Any refusal stops the whole batch before a single byte is produced, so the
  // exit code and the contents of the output folder can never disagree.
  if (refusals.length || selected.length === 0) {
    return { dryRun, outputDirectory, refusals, skipped, packs: [], manifest: undefined }
  }

  // The registry's own integrity check is the per-pack content gate: it
  // reconciles every authored source against its record — identity, dependency
  // closure, item kinds and ids, and the entitlement family GenStudio stocks
  // against. A pack cannot be quietly edited out from under its registration.
  await validateAuthoringRegistry({ registryPath, repositoryRoot })

  const minAppVersion = await readReleaseFloor(repositoryRoot)
  const commit = await gitCommit(repositoryRoot)
  const directory = resolve(outputDirectory ?? join(repositoryRoot, 'dist/ship', `store-packs-${today(now)}`))
  const priorManifest = await existingManifest(directory)

  const packs = []
  const pending = []
  for (const record of selected) {
    const usesToken = record.min_app_version === MIN_APP_VERSION_TOKEN
    const fileName = archiveFileName(record)
    const buildCommand = buildCommandFor(record, { minAppVersion, usesToken, outputName: fileName })
    const already = await existingArtifact(directory, fileName)

    if (dryRun) {
      const sourceHits = scanEntriesForForbiddenMarks(await sourceEntries(join(repositoryRoot, record.source_path)))
      const recorded = priorManifest?.archives?.find(entry => entry.pack_id === record.pack_id && entry.version === record.version)
      packs.push({
        pack_id: record.pack_id,
        version: record.version,
        kind: record.kind,
        source_path: record.source_path,
        file: fileName,
        gates: {
          registry_status: record.status,
          registry_integrity: 'PASS',
          forbidden_marks: sourceHits.length === 0 ? 'PASS (source)' : `FAIL (${sourceHits.length})`,
        },
        forbidden_mark_hits: sourceHits,
        min_story_version: usesToken ? minAppVersion : record.min_app_version,
        build_command: buildCommand,
        state: already
          ? (recorded && recorded.sha256 === already.sha256
            ? 'already shipped (archive present, sha matches this folder\'s manifest)'
            : recorded
              ? 'CONFLICT (archive present but its sha differs from this folder\'s manifest)'
              : 'archive present (no manifest entry to compare against)')
          : 'would build',
        existing_sha256: already?.sha256,
      })
      continue
    }

    // PHASE ONE — verify everything, write nothing. A batch that fails on its
    // third pack must not leave the first two filed: a folder holding archives
    // but no manifest is not stockable, and looks like a completed run to
    // anyone who lists it. Bytes are held until every pack has passed.
    const built = await buildTwiceAndCompare(record, { minAppVersion, usesToken, fileName, repositoryRoot })
    const entries = await archiveEntries(built.bytes)
    const hits = scanEntriesForForbiddenMarks(entries)
    if (hits.length) {
      fail(`${record.pack_id} names a forbidden third-party mark and must not ship: ${hits.map(hit => `${hit.matched} in ${hit.entry} (${hit.where})`).join('; ')}`)
    }

    if (already && already.sha256 !== built.sha256) {
      fail(`${directory}/${fileName} already exists with sha ${already.sha256}, but this source builds to ${built.sha256}. A published (pack_id, version, sha256) is immutable — ship the change as a new version instead of replacing these bytes.`)
    }

    // The build already verified this archive against the Store profile, so the
    // manifest is read from the bytes that will be written rather than re-derived.
    const manifest = JSON.parse(entries.find(entry => entry.name === 'manifest.json').bytes.toString('utf8'))
    if (manifest.key_id !== undefined) fail(`${record.pack_id} carries a key_id; Store archives are keyless by design`)
    if (entries.some(entry => entry.name === 'signature.ed25519')) fail(`${record.pack_id} carries a signature; Store archives are keyless by design`)

    pending.push({ fileName, bytes: built.bytes, alreadyFiled: Boolean(already) })
    packs.push({
      file: fileName,
      sha256: built.sha256,
      bytes: built.bytes.byteLength,
      pack_id: manifest.pack_id,
      version: manifest.version,
      publisher_id: manifest.publisher_id,
      kind: kindFrom(manifest),
      title: titleFrom(manifest, entries),
      entitlement_family: manifest.entitlement.family,
      entitlement_sku: manifest.entitlement.sku,
      min_story_version: manifest.min_app_version,
      delivery_profile: manifest.delivery_profile,
      key_id_present: false,
      signature_present: false,
      item_ids: manifest.items.map(item => item.id),
      dependencies: manifest.dependencies ?? [],
      source_path: record.source_path,
      source_commit: commit,
      build_command: buildCommand,
      validate_command: `npm run content-pack:validate -- ./${fileName} --delivery-profile ${DELIVERY_PROFILE}`,
      reproducibility: { builds: 2, byte_identical: true },
      forbidden_mark_scan: { marks: MARKS.length, hits: 0, method: 'jszip entry names and decompressed bytes, latin1-decoded so NUL bytes are scanned' },
      validator: `PASS (${DELIVERY_PROFILE})`,
      state: already ? 'already shipped (re-verified, sha matches)' : 'shipped',
    })
  }

  if (dryRun) return { dryRun, outputDirectory: directory, refusals, skipped, packs, manifest: undefined }

  // Packs already filed here that this run did not touch are carried forward.
  // A folder written before this schema existed has entries missing the fields
  // GenStudio stocks from, and silently carrying those would hand the stocking
  // tool a manifest it cannot use. Say so, and name the way out.
  const carriedForward = (priorManifest?.archives ?? [])
    .filter(entry => !packs.some(pack => pack.pack_id === entry.pack_id && pack.version === entry.version))
  const stale = carriedForward.filter(entry => REQUIRED_ARCHIVE_FIELDS.some(field => entry?.[field] === undefined))
  if (stale.length) {
    fail(`${join(directory, 'manifest.json')} was written before manifest_version ${MANIFEST_VERSION} and its entries for ${stale.map(entry => entry.pack_id ?? entry.file).join(', ')} are missing fields GenStudio needs. Ship into a fresh folder, or re-run ship for every pack in this one so the whole manifest is regenerated.`)
  }

  // PHASE TWO — every pack passed, so file them all, then read each one back
  // through the validator to prove what landed on disk is what was verified.
  await mkdir(directory, { recursive: true })
  for (const item of pending) {
    if (!item.alreadyFiled) await writeFile(join(directory, item.fileName), item.bytes, { flag: 'wx' })
    const readBack = await validateContentPack({
      archivePath: join(directory, item.fileName),
      deliveryProfile: DELIVERY_PROFILE,
    })
    const expected = packs.find(pack => pack.file === item.fileName)
    if (readBack.sha256 !== expected.sha256) {
      fail(`${item.fileName} on disk hashes to ${readBack.sha256} but was verified as ${expected.sha256}`)
    }
  }

  const manifest = {
    manifest_version: MANIFEST_VERSION,
    artifact_set: basename(directory),
    generated_at: now.toISOString(),
    source: { repository: 'story-studio-kh', commit, node: process.version },
    build_profile: {
      delivery_profile: DELIVERY_PROFILE,
      min_app_version: minAppVersion,
      min_app_version_source: 'content-packs/release-floor.json',
      publisher_signing: 'none - Store archives are keyless by design; the builder refuses a private key on this profile and the verifier refuses a publisher signature',
    },
    archives: [...carriedForward, ...packs]
      .map(({ state, ...entry }) => entry)
      .sort((a, b) => (a.file < b.file ? -1 : 1)),
  }
  const problems = missingManifestFields(manifest)
  if (problems.length) fail(`the generated manifest is incomplete: ${problems.join(', ')}`)
  await writeFile(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  return { dryRun, outputDirectory: directory, refusals, skipped, packs, manifest }
}

function parseArguments(argv) {
  const selectors = []
  const options = { dryRun: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--dry-run') options.dryRun = true
    else if (argument === '--out') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) fail('option requires a value: --out')
      options.outputDirectory = value
      index += 1
    } else if (argument.startsWith('--')) fail(`unknown option: ${argument}`)
    else selectors.push(argument)
  }
  return { selectors, options }
}

function renderTable(packs, dryRun) {
  const columns = dryRun
    ? [['PACK', 'pack_id'], ['VERSION', 'version'], ['GATES', p => Object.values(p.gates).join(' / ')], ['STATE', 'state']]
    : [['PACK', 'pack_id'], ['VERSION', 'version'], ['KIND', 'kind'], ['TITLE', 'title'], ['BYTES', 'bytes'], ['SHA256', p => p.sha256.slice(0, 12)], ['STATE', 'state']]
  const read = (pack, accessor) => String(typeof accessor === 'function' ? accessor(pack) : pack[accessor])
  const rows = [columns.map(([heading]) => heading), ...packs.map(pack => columns.map(([, accessor]) => read(pack, accessor)))]
  const widths = rows[0].map((_, column) => Math.max(...rows.map(row => row[column].length)))
  return rows.map(row => row.map((cell, column) => cell.padEnd(widths[column])).join('  ').trimEnd()).join('\n')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { selectors, options } = parseArguments(process.argv.slice(2))
    if (selectors.length === 0) fail('usage: ship-pack.mjs <pack-id | source-path | glob>... [--out <dir>] [--dry-run]')
    const result = await shipContentPacks({ selectors, outputDirectory: options.outputDirectory, dryRun: options.dryRun })

    for (const refusal of result.refusals) process.stdout.write(`REFUSED  ${refusal.reason}\n`)
    for (const skip of result.skipped ?? []) process.stdout.write(`SKIPPED  ${skip.pack_id} ${skip.version} is still "${skip.status}", not authored\n`)
    if (result.packs.length) {
      process.stdout.write(`${result.dryRun ? 'Dry run' : 'Shipped'} into ${result.outputDirectory}\n\n${renderTable(result.packs, result.dryRun)}\n`)
    }
    if (result.refusals.length) {
      process.stdout.write('\nNothing was built. Fix the refusals above and re-run.\n')
      process.exitCode = 1
    }
    else if (result.dryRun) {
      process.stdout.write(`\nNothing was built. Re-run without --dry-run to ship.\n`)
    } else if (result.packs.length) {
      process.stdout.write(`\nNext, stock these from the genstudiokh repository:\n  python -m app.tools.stock_pack ${result.outputDirectory}\n`)
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
