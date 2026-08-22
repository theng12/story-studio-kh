import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import JSZip from 'jszip'
import sharp from 'sharp'

import { buildContentPack, validateContentPack } from '../lib.mjs'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const TEST_KEY_ID = 'com.storystudio.key.test'
const TEST_MIN_APP_VERSION = '9.9.9'

const RESTORED_RECIPES = [
  ['com.storystudio.thumbnail.annotated-business-board', 'content-packs/free-starters/thumbnail/annotated-business-board'],
  ['com.storystudio.thumbnail.centered-hero-headline', 'content-packs/free-starters/thumbnail/centered-hero-headline-v1.0.1'],
  ['com.storystudio.thumbnail.curiosity-question-cartoon', 'content-packs/free-starters/thumbnail/curiosity-question-cartoon'],
  ['com.storystudio.thumbnail.documentary-label-tableau', 'content-packs/free-starters/thumbnail/documentary-label-tableau'],
  ['com.storystudio.thumbnail.portrait-block-right', 'content-packs/free-starters/thumbnail/portrait-block-right-v1.0.1'],
  ['com.storystudio.thumbnail.prehistoric-discovery', 'content-packs/free-starters/thumbnail/prehistoric-discovery-v1.0.1'],
  ['com.storystudio.thumbnail.dreamscape-story-window', 'content-packs/free-starters/thumbnail/dreamscape-story-window-v1.0.1'],
  ['com.storystudio.thumbnail.archival-map-investigation', 'content-packs/paid/archival-ledger/thumbnail/archival-map-investigation'],
  ['com.storystudio.thumbnail.editorial-psychology-symbolic-split', 'content-packs/psychology-editorial/thumbnail/editorial-psychology-symbolic-split'],
  ['com.storystudio.thumbnail.animal-hardship-annotation', 'content-packs/legacy-thumbnail-restoration/thumbnail/animal-hardship-annotation'],
  ['com.storystudio.thumbnail.prehistoric-survival-title-card', 'content-packs/legacy-thumbnail-restoration/thumbnail/prehistoric-survival-title-card'],
  ['com.storystudio.thumbnail.dreamlike-story-title-card', 'content-packs/legacy-thumbnail-restoration/thumbnail/dreamlike-story-title-card'],
]

const QUALIFIED_SOURCES = [
  'content-packs/legacy-thumbnail-restoration/thumbnail/animal-hardship-annotation',
  'content-packs/legacy-thumbnail-restoration/style/hand-drawn-hardship-cartoon',
  'content-packs/legacy-thumbnail-restoration/style/impasto-psychological-animals',
  'content-packs/legacy-thumbnail-restoration/thumbnail/prehistoric-survival-title-card',
  'content-packs/legacy-thumbnail-restoration/thumbnail/dreamlike-story-title-card',
  'content-packs/legacy-thumbnail-restoration/style/dreamlike-luminous-sleep-illustration',
  'content-packs/free-starters/thumbnail/centered-hero-headline-v1.0.1',
  'content-packs/free-starters/thumbnail/portrait-block-right-v1.0.1',
  'content-packs/free-starters/thumbnail/dreamscape-story-window-v1.0.1',
  'content-packs/free-starters/thumbnail/prehistoric-discovery-v1.0.1',
]

const PRIVATE_MATERIAL = /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|private[ _-]?key/i

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function filesBelow(root) {
  const files = []
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = join(directory, entry.name)
      if (entry.isDirectory()) await walk(candidate)
      else if (entry.isFile()) files.push(candidate)
      else assert.fail(`qualification source must contain only regular files: ${candidate}`)
    }
  }
  await walk(root)
  return files.sort()
}

function assertNoPrivateMaterial(bytes, label, privateKeyPem) {
  const text = Buffer.from(bytes).toString('latin1')
  assert.doesNotMatch(text, PRIVATE_MATERIAL, `${label} must not contain private-key material`)
  assert.equal(Buffer.from(bytes).includes(Buffer.from(privateKeyPem)), false, `${label} must not contain the ephemeral private key`)
}

test('the restored thumbnail lineup has twelve original 16:9 recipe galleries', async t => {
  for (const [id, relativeDirectory] of RESTORED_RECIPES) {
    await t.test(id, async () => {
      const sourceDirectory = join(ROOT, relativeDirectory)
      const recipe = await readJson(join(sourceDirectory, 'content', 'thumbnail-recipe.json'))
      assert.equal(recipe.id, id)
      assert.ok(Array.isArray(recipe.preview_assets), `${id} declares preview assets`)
      assert.ok(recipe.preview_assets.length >= 3 && recipe.preview_assets.length <= 5, `${id} has three to five previews`)
      for (const preview of recipe.preview_assets) {
        assert.match(preview, /^assets\/[^/]+\.webp$/)
        const bytes = await readFile(join(sourceDirectory, preview))
        const metadata = await sharp(bytes, { failOn: 'error' }).metadata()
        assert.deepEqual(
          { format: metadata.format, width: metadata.width, height: metadata.height },
          { format: 'webp', width: 1672, height: 941 },
          `${id} preview ${preview} decodes as 1672×941 WebP`,
        )
      }
    })
  }
})

test('ten restored source packs build deterministically and validate with one ephemeral key', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'legacy-thumbnail-restoration-'))
  t.after(async () => {
    await rm(temporary, { recursive: true, force: true })
    await assert.rejects(access(temporary), { code: 'ENOENT' })
  })

  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const privateKeyPath = join(temporary, 'ephemeral-private.pem')
  const publicKeyPath = join(temporary, 'ephemeral-public.pem')
  await writeFile(privateKeyPath, privateKeyPem, { mode: 0o600 })
  await writeFile(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 })

  for (const relativeDirectory of QUALIFIED_SOURCES) {
    await t.test(relativeDirectory, async () => {
      const sourceDirectory = join(ROOT, relativeDirectory)
      const manifest = await readJson(join(sourceDirectory, 'pack.json'))
      for (const sourcePath of await filesBelow(sourceDirectory)) {
        assertNoPrivateMaterial(await readFile(sourcePath), sourcePath, privateKeyPem)
      }

      const slug = relativeDirectory.replaceAll('/', '--')
      const firstPath = join(temporary, `${slug}-first.sspack`)
      const secondPath = join(temporary, `${slug}-second.sspack`)
      const first = await buildContentPack({
        sourceDirectory,
        privateKeyPath,
        outputPath: firstPath,
        keyId: TEST_KEY_ID,
        minAppVersion: TEST_MIN_APP_VERSION,
      })
      const second = await buildContentPack({
        sourceDirectory,
        privateKeyPath,
        outputPath: secondPath,
        keyId: TEST_KEY_ID,
        minAppVersion: TEST_MIN_APP_VERSION,
      })
      const [firstBytes, secondBytes] = await Promise.all([readFile(firstPath), readFile(secondPath)])
      const validated = await validateContentPack({
        archivePath: firstPath,
        publicKeyPath,
        publisherId: 'com.storystudio',
        keyId: TEST_KEY_ID,
      })
      const archive = await JSZip.loadAsync(firstBytes)

      assert.equal(first.packId, manifest.pack_id)
      assert.equal(first.version, manifest.version)
      assert.equal(first.sha256, second.sha256)
      assert.deepEqual(firstBytes, secondBytes)
      assert.deepEqual(validated, { packId: first.packId, version: first.version, sha256: first.sha256 })
      assert.equal(JSON.parse(await archive.file('manifest.json').async('text')).min_app_version, TEST_MIN_APP_VERSION)
      for (const [name, entry] of Object.entries(archive.files)) {
        assert.doesNotMatch(name, PRIVATE_MATERIAL, 'archives must not contain private-key files')
        assertNoPrivateMaterial(await entry.async('nodebuffer'), `${relativeDirectory} archive entry ${name}`, privateKeyPem)
      }
    })
  }
})
