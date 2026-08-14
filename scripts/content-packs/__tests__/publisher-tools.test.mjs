import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

import JSZip from 'jszip'

const REPOSITORY_ROOT = new URL('../../../..', import.meta.url)
const BUILD = new URL('../build-pack.mjs', import.meta.url)
const VALIDATE = new URL('../validate-pack.mjs', import.meta.url)
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==', 'base64')

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function run(command, args, options = {}) {
  return spawnSync(process.execPath, [command.pathname, ...args], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...options.env },
  })
}

async function writeSource(root, { config = {}, document = {}, extras = [] } = {}) {
  const source = join(root, 'source')
  await mkdir(join(source, 'content'), { recursive: true })
  await mkdir(join(source, 'assets'), { recursive: true })
  await writeFile(join(source, 'pack.json'), JSON.stringify({
    pack_format: 1,
    pack_id: 'com.storystudio.pack.test',
    publisher_id: 'com.storystudio',
    key_id: 'com.storystudio.key.test',
    version: '1.0.0',
    min_app_version: '1.0.0',
    lifecycle: 'active',
    entitlement: {
      sku: 'com.storystudio.sku.test',
      family: 'com.storystudio.family.test',
    },
    ...config,
  }), 'utf8')
  await writeFile(join(source, 'content', 'visual-style.json'), JSON.stringify({
    kind: 'visual-style',
    schema_version: 1,
    id: 'com.storystudio.style.test',
    name: 'Test Style',
    description: 'A strict visual-style fixture.',
    category: 'test',
    tags: ['test'],
    style_bible: 'Use a restrained first-party style.',
    negative_prompt: 'No text.',
    preview_assets: ['assets/preview.png'],
    compatible_formula_ids: [],
    ...document,
  }), 'utf8')
  await writeFile(join(source, 'assets', 'preview.png'), PNG_1PX)
  for (const [relativePath, bytes] of extras) {
    await mkdir(join(source, relativePath, '..'), { recursive: true })
    await writeFile(join(source, relativePath), bytes)
  }
  return source
}

async function writeBundleOnlySource(root, { config = {}, entries = [] } = {}) {
  const source = join(root, 'bundle-only-source')
  await mkdir(source, { recursive: true })
  await writeFile(join(source, 'pack.json'), JSON.stringify({
    pack_format: 1,
    pack_id: 'com.storystudio.bundle.free-starter',
    publisher_id: 'com.storystudio',
    key_id: '{{KEY_ID}}',
    version: '1.0.0',
    min_app_version: '{{MIN_APP_VERSION}}',
    lifecycle: 'active',
    entitlement: {
      sku: 'com.storystudio.sku.free-starter',
      family: 'com.storystudio.family.free-starter',
    },
    dependencies: [
      { pack_id: 'com.storystudio.formula.free-starter', version: '1.0.0' },
      { pack_id: 'com.storystudio.topic.free-starter', version: '1.0.0' },
      { pack_id: 'com.storystudio.style.free-starter', version: '1.0.0' },
      { pack_id: 'com.storystudio.thumbnail.free-starter', version: '1.0.0' },
    ],
    bundles: [{
      id: 'com.storystudio.bundle.free-starter',
      kind: 'channel-kit',
      name: 'Free Starter Channel Kit',
      components: [
        { pack_id: 'com.storystudio.formula.free-starter', version: '1.0.0', item_id: 'com.storystudio.formula.free-starter', kind: 'series-formula' },
        { pack_id: 'com.storystudio.topic.free-starter', version: '1.0.0', item_id: 'com.storystudio.topic.free-starter', kind: 'topic-pack' },
        { pack_id: 'com.storystudio.style.free-starter', version: '1.0.0', item_id: 'com.storystudio.style.free-starter', kind: 'visual-style' },
        { pack_id: 'com.storystudio.thumbnail.free-starter', version: '1.0.0', item_id: 'com.storystudio.thumbnail.free-starter', kind: 'thumbnail-recipe' },
      ],
    }],
    ...config,
  }), 'utf8')
  for (const [relativePath, bytes] of entries) {
    await mkdir(join(source, relativePath, '..'), { recursive: true })
    await writeFile(join(source, relativePath), bytes)
  }
  return source
}

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'story-content-pack-cli-'))
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const privateKeyPath = join(root, 'publisher-private.pem')
  const publicKeyPath = join(root, 'publisher-public.pem')
  await writeFile(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }))
  await writeFile(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }))
  return { root, privateKeyPath, publicKeyPath }
}

async function readArchiveOrder(path) {
  const archive = await JSZip.loadAsync(await readFile(path))
  return Object.keys(archive.files)
}

test('build-pack creates a deterministic signed archive that validate-pack verifies without leaking the key', async (t) => {
  const fixture = await makeFixture()
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const source = await writeSource(fixture.root)
  const first = join(fixture.root, 'first.sspack')
  const second = join(fixture.root, 'second.sspack')

  const buildOne = run(BUILD, [source, '--private-key', fixture.privateKeyPath, '--output', first])
  assert.equal(buildOne.status, 0, buildOne.stderr)
  const buildTwo = run(BUILD, [source, '--private-key', fixture.privateKeyPath, '--output', second])
  assert.equal(buildTwo.status, 0, buildTwo.stderr)
  assert.deepEqual(await readFile(first), await readFile(second))
  assert.deepEqual(await readArchiveOrder(first), [
    'manifest.json',
    'signature.ed25519',
    'assets/preview.png',
    'content/visual-style.json',
  ])

  const validation = run(VALIDATE, [
    first,
    '--key-id', 'com.storystudio.key.test',
    '--publisher-id', 'com.storystudio',
    '--public-key', fixture.publicKeyPath,
  ])
  assert.equal(validation.status, 0, validation.stderr)
  assert.match(validation.stdout, /com\.storystudio\.pack\.test 1\.0\.0/)
  assert.match(validation.stdout, /sha256=[a-f0-9]{64}/)
  const privateKey = await readFile(fixture.privateKeyPath, 'utf8')
  assert.doesNotMatch(`${buildOne.stdout}${buildOne.stderr}${validation.stdout}${validation.stderr}`, new RegExp(privateKey.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.equal((await readFile(first)).includes(Buffer.from(privateKey)), false)
})

test('build-pack accepts the deliberate private-key environment path and refuses a missing key', async (t) => {
  const fixture = await makeFixture()
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const source = await writeSource(fixture.root)
  const output = join(fixture.root, 'environment.sspack')

  const missing = run(BUILD, [source, '--output', output])
  assert.notEqual(missing.status, 0)
  assert.match(missing.stderr, /private key/i)

  const built = run(BUILD, [source, '--output', output], {
    env: { STORY_CONTENT_PACK_PRIVATE_KEY_PATH: fixture.privateKeyPath },
  })
  assert.equal(built.status, 0, built.stderr)
})

test('buildContentPack signs only a complete token-resolved bundle-only coordination source with the supplied key identity', async (t) => {
  const fixture = await makeFixture()
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const source = await writeBundleOnlySource(fixture.root)
  const output = join(fixture.root, 'bundle-only.sspack')
  const { buildContentPack, validateContentPack } = await import('../lib.mjs')

  await assert.rejects(
    buildContentPack({ sourceDirectory: source, privateKeyPath: fixture.privateKeyPath, outputPath: output }),
    /MIN_APP_VERSION|KEY_ID|semantic version|qualified/i,
  )
  await assert.rejects(readFile(output), /ENOENT/)
  await assert.rejects(
    buildContentPack({
      sourceDirectory: source,
      privateKeyPath: fixture.privateKeyPath,
      outputPath: output,
      minAppVersion: '1.0.0',
      keyId: 'com.someoneelse.key.free-starter',
    }),
    /publisher namespace/i,
  )
  const result = await buildContentPack({
    sourceDirectory: source,
    privateKeyPath: fixture.privateKeyPath,
    outputPath: output,
    minAppVersion: '1.0.0',
    keyId: 'com.storystudio.key.free-starter',
  })
  assert.equal(result.packId, 'com.storystudio.bundle.free-starter')
  const archive = await JSZip.loadAsync(await readFile(output))
  const signedManifest = JSON.parse(await archive.file('manifest.json').async('text'))
  assert.equal(signedManifest.key_id, 'com.storystudio.key.free-starter')
  assert.equal(signedManifest.min_app_version, '1.0.0')
  await validateContentPack({
    archivePath: output,
    keyId: 'com.storystudio.key.free-starter',
    publisherId: 'com.storystudio',
    publicKeyPath: fixture.publicKeyPath,
  })
  const wrongPublicKeyPath = join(fixture.root, 'wrong-publisher-public.pem')
  const { publicKey: wrongPublicKey } = generateKeyPairSync('ed25519')
  await writeFile(wrongPublicKeyPath, wrongPublicKey.export({ type: 'spki', format: 'pem' }))
  await assert.rejects(
    validateContentPack({
      archivePath: output,
      keyId: 'com.storystudio.key.free-starter',
      publisherId: 'com.storystudio',
      publicKeyPath: wrongPublicKeyPath,
    }),
    /signature/i,
  )
})

test('buildContentPack refuses content or assets in a bundle-only source', async (t) => {
  const fixture = await makeFixture()
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const { buildContentPack } = await import('../lib.mjs')
  for (const [relativePath, bytes] of [['content/formula.json', '{}'], ['assets/preview.png', PNG_1PX]]) {
    const source = await writeBundleOnlySource(fixture.root, { entries: [[relativePath, bytes]] })
    await assert.rejects(
      buildContentPack({
        sourceDirectory: source,
        privateKeyPath: fixture.privateKeyPath,
        outputPath: join(fixture.root, `${relativePath.replace('/', '-')}.sspack`),
        minAppVersion: '1.0.0',
        keyId: 'com.storystudio.key.free-starter',
      }),
      /bundle|content|file|asset/i,
    )
    await rm(source, { recursive: true })
  }
})

test('build-pack refuses a secret-bearing content source and writes no archive', async (t) => {
  const fixture = await makeFixture()
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const source = await writeSource(fixture.root, {
    document: { style_bible: 'api_key = "sk-live-abc123456789"' },
  })
  const output = join(fixture.root, 'must-not-exist.sspack')

  const result = run(BUILD, [source, '--private-key', fixture.privateKeyPath, '--output', output])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /credential|private key|secret/i)
  await assert.rejects(readFile(output), /ENOENT/)
})

for (const [name, setup, expected] of [
  ['wrong publisher namespace', { config: { pack_id: 'com.other.pack.test' } }, /publisher namespace/i],
  ['undeclared source file', { extras: [['unexpected.txt', 'not pack content']] }, /not declared by pack\.json/i],
  ['unsupported source asset', { extras: [['assets/unsafe.svg', '<svg/>']] }, /unsupported source file/i],
  ['invalid source document', { document: { unexpected: true } }, /content document does not match/i],
]) {
  test(`build-pack refuses ${name}`, async (t) => {
    const fixture = await makeFixture()
    t.after(() => rm(fixture.root, { recursive: true, force: true }))
    const source = await writeSource(fixture.root, setup)
    const result = run(BUILD, [source, '--private-key', fixture.privateKeyPath, '--output', join(fixture.root, 'invalid.sspack')])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, expected)
  })
}

test('validate-pack fails with an explicit incorrect publisher key identity', async (t) => {
  const fixture = await makeFixture()
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const source = await writeSource(fixture.root)
  const output = join(fixture.root, 'valid.sspack')
  assert.equal(run(BUILD, [source, '--private-key', fixture.privateKeyPath, '--output', output]).status, 0)

  const result = run(VALIDATE, [
    output,
    '--key-id', 'com.storystudio.key.other',
    '--publisher-id', 'com.storystudio',
    '--public-key', fixture.publicKeyPath,
  ])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /unknown publisher key/i)
})

test('build-pack rejects an output that could overwrite its private key or source tree before reading either', async (t) => {
  const fixture = await makeFixture()
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const source = await writeSource(fixture.root, { document: { unexpected: true } })
  const privateKeyBefore = await readFile(fixture.privateKeyPath)
  const documentPath = join(source, 'content', 'visual-style.json')
  const documentBefore = await readFile(documentPath)

  const keyCollision = run(BUILD, [source, '--private-key', fixture.privateKeyPath, '--output', fixture.privateKeyPath])
  assert.notEqual(keyCollision.status, 0)
  assert.match(keyCollision.stderr, /output.*private key/i)
  assert.deepEqual(await readFile(fixture.privateKeyPath), privateKeyBefore)

  const sourceCollision = run(BUILD, [source, '--private-key', fixture.privateKeyPath, '--output', join(source, 'replacement.sspack')])
  assert.notEqual(sourceCollision.status, 0)
  assert.match(sourceCollision.stderr, /output.*source/i)
  assert.deepEqual(await readFile(documentPath), documentBefore)

  const sourceAlias = join(fixture.root, 'source-alias')
  await symlink(source, sourceAlias)
  const physicalSourceCollision = run(BUILD, [source, '--private-key', fixture.privateKeyPath, '--output', join(sourceAlias, 'replacement.sspack')])
  assert.notEqual(physicalSourceCollision.status, 0)
  assert.match(physicalSourceCollision.stderr, /output.*source/i)
  assert.deepEqual(await readFile(documentPath), documentBefore)
})

test('build-pack never replaces an existing output, including a file created immediately before finalization', async (t) => {
  const fixture = await makeFixture()
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const source = await writeSource(fixture.root)
  const output = join(fixture.root, 'immutable.sspack')
  const sentinel = Buffer.from('do not replace this published artifact')

  await writeFile(output, sentinel)
  const existing = run(BUILD, [source, '--private-key', fixture.privateKeyPath, '--output', output])
  assert.notEqual(existing.status, 0)
  assert.match(existing.stderr, /output path already exists/i)
  assert.deepEqual(await readFile(output), sentinel)

  await rm(output)
  const { buildContentPack } = await import('../lib.mjs')
  await assert.rejects(
    buildContentPack({
      sourceDirectory: source,
      privateKeyPath: fixture.privateKeyPath,
      outputPath: output,
      onBeforeOutputCommit: async () => writeFile(output, sentinel, { flag: 'wx' }),
    }),
    /output path already exists/i,
  )
  assert.deepEqual(await readFile(output), sentinel)
})

test('concurrent builders leave the first committed output intact', async (t) => {
  const fixture = await makeFixture()
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const source = await writeSource(fixture.root)
  const output = join(fixture.root, 'concurrent.sspack')
  const { buildContentPack } = await import('../lib.mjs')
  let allowFirstCommit
  const firstReachedCommit = new Promise(resolve => { allowFirstCommit = resolve })
  let releaseFirstCommit
  const waitForSecond = new Promise(resolve => { releaseFirstCommit = resolve })

  const first = buildContentPack({
    sourceDirectory: source,
    privateKeyPath: fixture.privateKeyPath,
    outputPath: output,
    onBeforeOutputCommit: async () => {
      allowFirstCommit()
      await waitForSecond
    },
  })
  await firstReachedCommit
  const second = await buildContentPack({
    sourceDirectory: source,
    privateKeyPath: fixture.privateKeyPath,
    outputPath: output,
  })
  releaseFirstCommit()

  await assert.rejects(first, /output path already exists/i)
  assert.equal(sha256(await readFile(output)), second.sha256)
})

test('validate-pack rejects an archive path that aliases its public key before reading it as an archive', async (t) => {
  const fixture = await makeFixture()
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const before = await readFile(fixture.publicKeyPath)
  const result = run(VALIDATE, [
    fixture.publicKeyPath,
    '--key-id', 'com.storystudio.key.test',
    '--publisher-id', 'com.storystudio',
    '--public-key', fixture.publicKeyPath,
  ])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /archive.*public key/i)
  assert.deepEqual(await readFile(fixture.publicKeyPath), before)
})

async function buildWithSourceSwap(fixture, swap) {
  const source = await writeSource(fixture.root)
  const output = join(fixture.root, 'must-not-change.sspack')
  await writeFile(output, 'preserve me', 'utf8')
  const { buildContentPack } = await import('../lib.mjs')
  await assert.rejects(
    buildContentPack({
      sourceDirectory: source,
      privateKeyPath: fixture.privateKeyPath,
      outputPath: output,
      onSourceEnumerated: () => swap({ source, output }),
    }),
    /symlink|source (?:directory|file) changed|source file/i,
  )
  assert.equal(await readFile(output, 'utf8'), 'preserve me')
}

test('build-pack refuses a content-file symlink race and preserves the output', async (t) => {
  const fixture = await makeFixture()
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const privateDocument = join(fixture.root, 'private-document.json')
  await writeFile(privateDocument, JSON.stringify({ private: 'must never be signed' }))

  await buildWithSourceSwap(fixture, async ({ source }) => {
    const document = join(source, 'content', 'visual-style.json')
    await rm(document)
    await symlink(privateDocument, document)
  })
})

test('build-pack refuses an ancestor-directory symlink race and preserves the output', async (t) => {
  const fixture = await makeFixture()
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const privateDirectory = join(fixture.root, 'private-content')
  await mkdir(privateDirectory)
  await writeFile(join(privateDirectory, 'visual-style.json'), JSON.stringify({ private: 'must never be signed' }))

  await buildWithSourceSwap(fixture, async ({ source }) => {
    const content = join(source, 'content')
    await rename(content, join(source, 'content-original'))
    await symlink(privateDirectory, content)
  })
})

test('build-pack refuses an equal-size in-place source rewrite before it can be signed', async (t) => {
  const fixture = await makeFixture()
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const source = await writeSource(fixture.root)
  const output = join(fixture.root, 'must-not-change.sspack')
  await writeFile(output, 'preserve me', 'utf8')
  const document = join(source, 'content', 'visual-style.json')
  const original = await readFile(document, 'utf8')
  const rewritten = original.replace('Test Style', 'Race Style')
  assert.equal(rewritten.length, original.length)
  const { buildContentPack } = await import('../lib.mjs')

  await assert.rejects(
    buildContentPack({
      sourceDirectory: source,
      privateKeyPath: fixture.privateKeyPath,
      outputPath: output,
      onSourceEnumerated: async () => {
        await writeFile(document, rewritten, 'utf8')
        await utimes(document, new Date('2030-01-01T00:00:00.000Z'), new Date('2030-01-01T00:00:00.000Z'))
      },
    }),
    /source file changed/i,
  )
  assert.equal(await readFile(output, 'utf8'), 'preserve me')
})

test('build-pack bounds a source read and refuses growth after the safe file handle is opened', async (t) => {
  const fixture = await makeFixture()
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const source = await writeSource(fixture.root)
  const output = join(fixture.root, 'must-not-change.sspack')
  await writeFile(output, 'preserve me', 'utf8')
  const document = join(source, 'content', 'visual-style.json')
  const { buildContentPack } = await import('../lib.mjs')

  await assert.rejects(
    buildContentPack({
      sourceDirectory: source,
      privateKeyPath: fixture.privateKeyPath,
      outputPath: output,
      onBeforeSourceRead: async record => {
        if (record.relativePath === 'content/visual-style.json') await writeFile(document, `${await readFile(document, 'utf8')}x`, 'utf8')
      },
    }),
    /source file changed|byte limit/i,
  )
  assert.equal(await readFile(output, 'utf8'), 'preserve me')
})
