import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

import JSZip from 'jszip'

const REPOSITORY_ROOT = new URL('../../../..', import.meta.url)
const BUILD = new URL('../build-pack.mjs', import.meta.url)
const VALIDATE = new URL('../validate-pack.mjs', import.meta.url)
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==', 'base64')

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
