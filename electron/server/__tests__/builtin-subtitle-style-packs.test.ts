/**
 * The twenty-four built-in caption looks as portable Content Packs
 * (owner-approved 2026-11-05 conversion).
 *
 * What each section proves — all light, one file, no full suite:
 *
 *  1. SOURCES + EQUALITY — every `content-packs/builtin-conversion/subtitle-style/*`
 *     source validates through the real pack schema, carries a qualified id the
 *     engine's no-shadowing guard requires, and its `style` document is
 *     DEEP-EQUAL to the shipped built-in preset it converts (name, description,
 *     approximation and wordLevel included). The adapter that feeds the gallery
 *     resolves each pack document back to that same style.
 *  2. REGISTRY — the authoring registry (written only through its own tool)
 *     holds an authored record per source, and the pre-existing
 *     metadata-formula conversion records are still there.
 *  3. BUILD — one representative archive builds TWICE TO THE SAME SHA256,
 *     validates against its own public key, and carries version 1.0.0, a
 *     changelog (What's New) and the release-floor app-compatibility version.
 *  4. INSTALL — a real archive installs into an isolated data dir and appears
 *     in the caption gallery through the real loader, with the identical style
 *     and the pack's version in its origin.
 *  5. PIXEL PROOF — for EVERY one of the 24 styles: burn the built-in document
 *     and the pack-resolved document (same cues, same canvas, one frame each,
 *     sequential) and require byte-identical raw frames. A style whose font
 *     cannot be confirmed available FAILS the file as "not checked" — it never
 *     skips, because a skip here would read as a pass.
 *
 * Deliberately out of scope: remote/Hub rendering. This file proves local
 * source equality, build determinism, install and pixel identity only.
 * Remote subtitle behaviour is owned by the separate remote-render-parity
 * workstream and must not be inferred from these receipts. It touches no
 * final-render code.
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { generateKeyPairSync, createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { after, describe, test } from 'node:test'

import { installContentPack } from '../content-packs/installer.js'
import { createContentPackKeyring } from '../content-packs/keyring.js'
import { getContentPackRuntimePaths } from '../content-packs/runtime-paths.js'
import { ContentPackDocumentSchema } from '../content-packs/schemas.js'
import { contentPackDocumentToSubtitlePreset } from '../content-packs/legacy-adapters.js'
import { listSubtitleStylePresets } from '../services/style-effect-loader.js'
import { BUILT_IN_SUBTITLE_PRESETS } from '../contracts/subtitle-presets.js'
import { buildSubtitleAssDocument, type SrtCue } from '../lib/subtitle-builder.js'
import { hasLibass } from '../lib/ffmpeg-utils.js'
import { getFFmpegPath } from '../services/ffmpeg-manager.js'
import { setAppSetting } from '../services/app-settings.js'
import { bundledFontsFilterOption } from '../lib/subtitle-font-dir.js'
import { escapeFilterPath } from '../lib/ffmpeg-filter-escape.js'
import { useTempDataDir } from './_helpers.js'

const execFileAsync = promisify(execFile)

const repoRoot = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const packRoot = path.join(repoRoot, 'content-packs', 'builtin-conversion', 'subtitle-style')
/** Opt-in evidence target. Default writes into this run's own temp dir. */
const evidenceOptIn = process.env.STORY_SUBTITLE_PACK_EVIDENCE
const evidencePath = evidenceOptIn ?? '' // resolved after useTempDataDir below
const temp = await useTempDataDir()
const evidenceFile = evidencePath || path.join(temp.dir, 'subtitle-pack-proof.json')
const TEST_KEY_ID = 'com.storystudio.test-builtin-subtitle-packs'
const PUBLISHER_ID = 'com.storystudio'
const CANVAS = { width: 640, height: 360 }

after(async () => {
  // Loud on purpose: a failed evidence write fails the run instead of
  // shipping a green result with no receipts behind it.
  try {
    await fs.mkdir(path.dirname(evidenceFile), { recursive: true })
    await fs.writeFile(evidenceFile, JSON.stringify(evidence, null, 2) + '\n')
  } finally {
    await temp.cleanup()
  }
})

/** Everything this file proved, written to the external evidence dir at the end. */
const evidence: Record<string, unknown> & { fonts_unavailable: string[] } = {
  worktree: repoRoot,
  head_evidence: 'see sibling evidence dir',
  built_sources: [] as unknown[],
  registry: null as unknown,
  build: null as unknown,
  install: null as unknown,
  pixel: [] as unknown[],
  fonts_unavailable: [] as string[],
  remote_note: 'proof scope: local source equality, build determinism, install and pixel identity only; remote/Hub subtitle behaviour is owned by the remote-render-parity workstream and is not proven here',
}

const IDS = BUILT_IN_SUBTITLE_PRESETS.map(preset => preset.id)
const itemOf = (id: string) => `com.storystudio.subtitle-style.${id}`
const packOf = (id: string) => `com.storystudio.pack.subtitle-style.${id}`

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function readJson(file: string): Promise<any> {
  return JSON.parse(await fs.readFile(file, 'utf8'))
}

/**
 * Isolated app-settings point at real ffmpeg binaries. Default is this repo's
 * own `bundled/ffmpeg`; a launcher that has no local binaries may supply a
 * READ-ONLY location through `STORY_TEST_FFMPEG_DIR` — never a sibling
 * checkout hard-coded into the test.
 */
async function pointAtBundledFFmpeg(): Promise<void> {
  const dir = process.env.STORY_TEST_FFMPEG_DIR || path.join(repoRoot, 'bundled', 'ffmpeg')
  for (const binary of ['ffmpeg', 'ffprobe'] as const) {
    const found = path.join(dir, binary)
    assert.ok(
      existsSync(found),
      `${binary} not found at ${found} — pixel proof NOT CHECKED (set STORY_TEST_FFMPEG_DIR to an ffmpeg location that ships with this checkout)`,
    )
    await setAppSetting(`${binary}_path`, found)
  }
}

describe('The 24 built-in caption looks as portable packs', () => {
  test('every source pack validates, keeps its style body exactly, and the adapter resolves it back', async () => {
    const dirs = (await fs.readdir(packRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
    assert.deepEqual(dirs, [...IDS].sort(), 'one source directory per built-in look, no extras')

    const built: unknown[] = []
    for (const preset of BUILT_IN_SUBTITLE_PRESETS) {
      const dir = path.join(packRoot, preset.id)
      const contentFiles = (await fs.readdir(path.join(dir, 'content'))).filter(name => name.endsWith('.json'))
      assert.equal(contentFiles.length, 1, `${preset.id}: exactly one content document`)
      assert.equal(contentFiles[0], `${preset.id}.json`, `${preset.id}: content file named for the look`)

      const manifest = await readJson(path.join(dir, 'pack.json'))
      const raw = await readJson(path.join(dir, 'content', contentFiles[0]))
      const parsed = ContentPackDocumentSchema.safeParse(raw)
      assert.ok(parsed.success, `${preset.id}: pack schema refused the document: ${JSON.stringify(parsed.success ? '' : parsed.error.issues)}`)
      const doc = parsed.data as any

      assert.equal(doc.kind, 'subtitle-style')
      assert.equal(doc.id, itemOf(preset.id), 'qualified item id')
      assert.ok(!IDS.includes(doc.id), 'a pack item id may never be a built-in id')
      assert.equal(doc.name, preset.name)
      assert.equal(doc.description, preset.description)
      assert.equal(doc.approximation, preset.approximation)
      assert.deepEqual(doc.style, preset.style, `${preset.id}: style body must be the shipped document, unchanged`)

      assert.equal(manifest.pack_id, packOf(preset.id))
      assert.equal(manifest.version, '1.0.0')
      assert.equal(manifest.min_app_version, '{{MIN_APP_VERSION}}', 'release-floor token stays in source')
      assert.ok(manifest.changelog?.includes(preset.name), `${preset.id}: changelog (What's New) names the look`)
      assert.equal(manifest.entitlement.family, `com.storystudio.family.subtitle-style.${preset.id}`)
      assert.equal(manifest.entitlement.sku, `com.storystudio.sku.subtitle-style.${preset.id}`)

      // The exact path the caption gallery uses once a pack is installed.
      const adapter = contentPackDocumentToSubtitlePreset(doc, {
        origin: 'content-pack', pack_id: manifest.pack_id, pack_version: manifest.version,
      })
      assert.deepEqual(adapter.style, doc.style, `${preset.id}: adapter resolves the same style`)
      assert.equal(adapter.wordLevel, preset.wordLevel, `${preset.id}: word-level flag preserved`)
      assert.equal(adapter.name, preset.name)

      built.push({ id: preset.id, item_id: doc.id, pack_id: manifest.pack_id, style_sha256: sha256(JSON.stringify(preset.style)) })
    }
    evidence.built_sources = built
    assert.equal(built.length, 24)
  })

  test('the authoring registry holds an authored record per source, written only through its tool', async () => {
    // @ts-expect-error JavaScript-only authoring tool.
    const { validateAuthoringRegistry } = await import('../../../scripts/content-packs/authoring-registry.mjs')
    const registry = await validateAuthoringRegistry()
    const subtitle = registry.records.filter((record: any) => record.kind === 'subtitle-style')
    assert.equal(subtitle.length, 24, '24 registry records')
    for (const id of IDS) {
      const record = subtitle.find((entry: any) => entry.pack_id === packOf(id))
      assert.ok(record, `registry record for ${id}`)
      assert.equal(record.status, 'authored', `${id}: authored`)
      assert.equal(record.item_id, itemOf(id))
      assert.equal(record.source_path, `content-packs/builtin-conversion/subtitle-style/${id}`)
      assert.equal(record.version, '1.0.0')
      assert.equal(record.min_app_version, '{{MIN_APP_VERSION}}')
      assert.equal(record.min_app_version_status, 'release-bound', 'app compatibility stays release-floor bound')
    }
    const conversions = registry.records.filter((record: any) =>
      record.kind === 'metadata-formula' && record.source_path.startsWith('content-packs/builtin-conversion/metadata-formula/'))
    assert.equal(conversions.length, 5, 'the uncommitted metadata-formula conversion records are preserved')
    const conversionStatuses = conversions.map((record: any) => `${record.source_path.split('/').pop()}:${record.status}`)
    evidence.registry = { revision: registry.revision, records: registry.records.length, subtitle: subtitle.length, metadata_conversions_preserved: conversionStatuses }
  })

  test('a representative archive builds twice to the same SHA, validates, and carries version + What\'s New + release floor', async () => {
    const floor = await readJson(path.join(repoRoot, 'content-packs', 'release-floor.json'))
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const keyPath = path.join(temp.dir, 'test-private.pem')
    const publicKeyPath = path.join(temp.dir, 'test-public.pem')
    await fs.writeFile(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }))
    await fs.writeFile(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }))

    // @ts-expect-error JavaScript-only deterministic pack tooling.
    const { buildContentPack, validateContentPack } = await import('../../../scripts/content-packs/lib.mjs')
    const sourceDirectory = path.join(packRoot, 'clean-broadcast')
    const first = path.join(temp.dir, 'clean-broadcast-a.sspack')
    const second = path.join(temp.dir, 'clean-broadcast-b.sspack')
    const buildArgs = { sourceDirectory, privateKeyPath: keyPath, keyId: TEST_KEY_ID, minAppVersion: floor.min_app_version }
    const one = await buildContentPack({ ...buildArgs, outputPath: first })
    const two = await buildContentPack({ ...buildArgs, outputPath: second })
    const bytesA = await fs.readFile(first)
    const bytesB = await fs.readFile(second)
    assert.equal(one.sha256, two.sha256, 'building the same source twice must produce the same archive hash')
    assert.equal(sha256(bytesA), one.sha256)
    assert.ok(Buffer.compare(bytesA, bytesB) === 0, 'byte-identical archives')

    const validated = await validateContentPack({
      archivePath: first, keyId: TEST_KEY_ID, publisherId: PUBLISHER_ID, publicKeyPath, includeManifest: true,
    })
    assert.equal(validated.packId, packOf('clean-broadcast'))
    assert.equal(validated.version, '1.0.0', 'installed version is the packed version')
    assert.equal(validated.manifest.min_app_version, floor.min_app_version, 'release floor flows into the archive')
    assert.ok(String(validated.manifest.changelog || '').includes('Clean Broadcast'), 'What\'s New text ships in the manifest')

    evidence.build = {
      pack_id: validated.packId, version: validated.version,
      sha256: one.sha256, bytes: bytesA.byteLength, deterministic: true,
      min_app_version: validated.manifest.min_app_version, changelog: validated.manifest.changelog,
    }
  })

  test('a real archive install lands the pack in the caption gallery with the identical style', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const keyPath = path.join(temp.dir, 'install-private.pem')
    await fs.writeFile(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }))
    // @ts-expect-error JavaScript-only deterministic pack tooling.
    const { buildContentPack } = await import('../../../scripts/content-packs/lib.mjs')
    const archivePath = path.join(temp.dir, 'install.sspack')
    await buildContentPack({
      sourceDirectory: path.join(packRoot, 'clean-broadcast'), privateKeyPath: keyPath,
      outputPath: archivePath, keyId: TEST_KEY_ID, minAppVersion: '1.0.0',
    })
    const archiveBytes = new Uint8Array(await fs.readFile(archivePath))
    const policy = createContentPackKeyring([{ keyId: TEST_KEY_ID, publisherId: PUBLISHER_ID, publicKeyPem }])
    const paths = await getContentPackRuntimePaths()
    await installContentPack(
      { archiveBytes, source: 'local-import', expectedArchiveSha256: sha256(archiveBytes) },
      { paths, policy },
    )
    const gallery = await listSubtitleStylePresets({ paths, policy })
    assert.deepEqual(gallery.refusals, [], 'no refused entries')
    assert.equal(gallery.presets.length, BUILT_IN_SUBTITLE_PRESETS.length + 1, 'the pack ADDS exactly one look')
    const added = gallery.presets.find(preset => preset.id === itemOf('clean-broadcast'))
    assert.ok(added, 'the pack look appears in the gallery')
    assert.equal(added!.origin.origin, 'content-pack')
    assert.equal(added!.origin.pack_id, packOf('clean-broadcast'))
    assert.equal(added!.origin.pack_version, '1.0.0', 'version reaches the gallery origin')
    const shipped = BUILT_IN_SUBTITLE_PRESETS.find(preset => preset.id === 'clean-broadcast')!
    assert.deepEqual(added!.style, shipped.style, 'installed look equals the shipped built-in document')

    evidence.install = {
      installed_pack: packOf('clean-broadcast'), gallery_size: gallery.presets.length,
      origin: added!.origin, style_equal: true,
    }
  })

  test('pixel proof: every one of the 24 styles burns identically as built-in and as pack, with its font confirmed', async () => {
    await pointAtBundledFFmpeg()
    const libass = await hasLibass()
    assert.ok(libass, 'this ffmpeg build has no libass — pixel proof NOT CHECKED')
    const ffmpeg = await getFFmpegPath()

    const cues: SrtCue[] = [
      { index: 1, start_sec: 0, end_sec: 6, text: 'The harbour lanterns were still lit.' },
      { index: 2, start_sec: 6, end_sec: 12, text: 'A second line, wrapped over two rows of caption.' },
    ]
    const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '')

    async function burn(ass: string, tag: string): Promise<{ pixels: Buffer; targets: string[] }> {
      const assPath = path.join(temp.dir, `pixel-${tag}.ass`)
      await fs.writeFile(assPath, ass, 'utf8')
      const filter = `setsar=1,setpts=PTS-STARTPTS+1/TB,ass=filename=${escapeFilterPath(assPath)}${bundledFontsFilterOption()}`
      const { stdout, stderr } = await execFileAsync(ffmpeg, [
        '-y', '-loglevel', 'verbose',
        '-f', 'lavfi', '-i', `color=c=0x182028:s=${CANVAS.width}x${CANVAS.height}`,
        '-vf', filter, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
      ], { encoding: 'buffer', maxBuffer: 1 << 26, timeout: 60_000 })
      const text = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr)
      const targets = [...text.matchAll(/fontselect:\s*\([^)]*\)\s*->\s*(.+)$/gm)].map(match => match[1].trim())
      return { pixels: Buffer.from(stdout), targets }
    }

    const pixels: unknown[] = []
    for (const preset of BUILT_IN_SUBTITLE_PRESETS) {
      const raw = await readJson(path.join(packRoot, preset.id, 'content', `${preset.id}.json`))
      const doc = ContentPackDocumentSchema.parse(raw) as any
      const packPreset = contentPackDocumentToSubtitlePreset(doc, { origin: 'content-pack' })

      const builtinAss = buildSubtitleAssDocument(cues, preset.style, { width: CANVAS.width, height: CANVAS.height }).ass
      const packAss = buildSubtitleAssDocument(cues, packPreset.style, { width: CANVAS.width, height: CANVAS.height }).ass
      assert.equal(packAss, builtinAss, `${preset.id}: pack and built-in must burn the same ASS document`)

      const before = await burn(builtinAss, `${preset.id}-old`)
      const afterFrame = await burn(packAss, `${preset.id}-pack`)
      assert.equal(
        Buffer.compare(before.pixels, afterFrame.pixels), 0,
        `${preset.id}: built-in and pack frames differ (old ${sha256(before.pixels)}, pack ${sha256(afterFrame.pixels)})`,
      )

      const family = preset.style.typography.font_family
      const resolved = before.targets.find(target => normalize(target).includes(normalize(family)))
      if (!resolved) {
        evidence.fonts_unavailable.push(`${preset.id}: font "${family}" — fontselect saw ${JSON.stringify(before.targets)}`)
      }
      pixels.push({
        id: preset.id, font_family: family, font_resolved: resolved ?? null,
        frame_bytes: before.pixels.byteLength, frame_sha256: sha256(before.pixels),
        equal: true, fontselect: before.targets,
      })
      // Sequential on purpose: minimal frames, no parallel burn load.
    }
    evidence.pixel = pixels
    assert.equal(pixels.length, 24, 'all 24 styles got a pixel receipt')

    if (evidence.fonts_unavailable.length) {
      assert.fail(
        'font unavailable — pixel proof NOT CHECKED for: ' + evidence.fonts_unavailable.join('; '),
      )
    }
  })
})
