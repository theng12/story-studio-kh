import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, test } from 'node:test'
import { pathToFileURL } from 'node:url'

import { useTempDataDir } from './_helpers.js'
import {
  getContentPackRuntimePaths,
  findContentPackSourceRoot,
  installedVersionPath,
  resolveContentPackRecoveryRoot,
  resolveVerifiedPackFile,
} from '../content-packs/runtime-paths.js'
import {
  emptyContentPackState,
  __testAcquireContentPackStateLock,
  mutateContentPackState,
  readContentPackState,
} from '../content-packs/state.js'
import type { ContentPackManifest } from '../content-packs/types.js'
import { createContentPackKeyring, resolveFirstPartyContentPackKeyringPath } from '../content-packs/keyring.js'

let cleanup: (() => Promise<void>) | undefined

afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

async function isolatedPaths() {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  return { temp, paths: getContentPackRuntimePaths() }
}

function manifest(): ContentPackManifest {
  return {
    pack_format: 1,
    pack_id: 'com.storystudio.test-pack',
    publisher_id: 'com.storystudio',
    key_id: 'com.storystudio.test-key',
    version: '1.2.3',
    min_app_version: '1.0.0',
    lifecycle: 'active',
    entitlement: { sku: 'com.storystudio.sku.test-pack', family: 'com.storystudio.family.test' },
    bundles: [],
    items: [{
      id: 'com.storystudio.style.test',
      kind: 'visual-style',
      schema_version: 1,
      path: 'content/visual-style.json',
    }],
    files: [{
      path: 'content/visual-style.json',
      sha256: '0'.repeat(64),
      bytes: 1,
      mime: 'application/json',
    }],
  }
}

function installedState(installPath: string) {
  const m = manifest()
  return {
    schema_version: 1,
    packs: {
      [m.pack_id]: {
        active_version: m.version,
        discovery_disabled: false,
        versions: {
          [m.version]: {
            archive_sha256: 'a'.repeat(64),
            installed_at: '2026-08-13T00:00:00.000Z',
            verified_at: '2026-08-13T00:00:00.000Z',
            source: 'local-import',
            install_path: installPath,
            manifest: m,
          },
        },
      },
    },
  }
}

function runWorker(workerPath: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', workerPath], { env, stdio: 'pipe' })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`state worker exited ${code}: ${stderr}`)))
  })
}

describe('Content Pack runtime state', () => {
  test('resolves userData paths lazily and does not create layout on reads', async () => {
    const { temp, paths } = await isolatedPaths()
    assert.equal(paths.root, path.join(temp.dir, 'content-packs'))
    assert.equal(paths.statePath, path.join(temp.dir, 'content-packs', 'state.json'))
    assert.equal(paths.stagingRoot, path.join(temp.dir, 'content-packs', '.staging'))
    assert.equal(paths.installedRoot, path.join(temp.dir, 'content-packs', 'installed'))
    assert.equal(paths.quarantineRoot, path.join(temp.dir, 'content-packs', 'quarantine'))

    assert.deepEqual(await readContentPackState(paths), emptyContentPackState())
    await assert.rejects(fs.stat(paths.root), { code: 'ENOENT' })
  })

  test('quarantines malformed or unknown state instead of trusting it', async () => {
    const { paths } = await isolatedPaths()
    await fs.mkdir(paths.root, { recursive: true })
    const invalid = '{"schema_version":1,"packs":{},"surprise":true}\n'
    await fs.writeFile(paths.statePath, invalid, { mode: 0o600 })

    assert.deepEqual(await readContentPackState(paths), emptyContentPackState())
    const hash = createHash('sha256').update(invalid).digest('hex')
    const quarantined = path.join(paths.quarantineRoot, `state-invalid-${hash}.json`)
    assert.equal(await fs.readFile(quarantined, 'utf8'), invalid)
    assert.deepEqual(JSON.parse(await fs.readFile(paths.statePath, 'utf8')), emptyContentPackState())
  })

  test('propagates state I/O errors without replacing or quarantining readable bytes', async () => {
    const { paths } = await isolatedPaths()
    await fs.mkdir(paths.root, { recursive: true })
    const known = '{"this":"must stay intact"}\n'
    await fs.writeFile(paths.statePath, known, { mode: 0o600 })
    await fs.chmod(paths.statePath, 0o000)
    try {
      await assert.rejects(readContentPackState(paths), /EACCES|permission/i)
    } finally {
      await fs.chmod(paths.statePath, 0o600)
    }
    assert.equal(await fs.readFile(paths.statePath, 'utf8'), known)
    await assert.rejects(fs.stat(paths.quarantineRoot), { code: 'ENOENT' })
  })

  test('quarantines semantically forged state instead of accepting path or identity drift', async () => {
    const { paths } = await isolatedPaths()
    await fs.mkdir(paths.root, { recursive: true })
    const forged = installedState('/etc')
    await fs.writeFile(paths.statePath, JSON.stringify(forged), { mode: 0o600 })

    assert.deepEqual(await readContentPackState(paths), emptyContentPackState())
    const raw = JSON.stringify(forged)
    const hash = createHash('sha256').update(raw).digest('hex')
    await fs.access(path.join(paths.quarantineRoot, `state-invalid-${hash}.json`))
  })

  test('quarantines state when its record keys or active version disagree with the manifest', async () => {
    const { paths } = await isolatedPaths()
    await fs.mkdir(paths.root, { recursive: true })
    const coherent = installedState(installedVersionPath(paths, manifest()))
    const pack = coherent.packs['com.storystudio.test-pack']
    pack.active_version = '9.9.9'
    pack.versions['1.2.3'].manifest.pack_id = 'com.storystudio.other-pack'
    await fs.writeFile(paths.statePath, JSON.stringify(coherent), { mode: 0o600 })

    assert.deepEqual(await readContentPackState(paths), emptyContentPackState())
  })

  test('serialises parallel state mutations without losing entries', async () => {
    const { paths } = await isolatedPaths()
    await Promise.all(Array.from({ length: 20 }, (_, n) =>
      mutateContentPackState(state => {
        state.packs[`com.storystudio.test.${n}`] = { discovery_disabled: false, versions: {} }
      }, paths),
    ))
    assert.equal(Object.keys((await readContentPackState(paths)).packs).length, 20)
  })

  test('serialises state mutations across 20 Node processes', async () => {
    const { temp } = await isolatedPaths()
    const workerPath = path.join(temp.dir, 'content-pack-state-worker.mts')
    const stateModule = pathToFileURL(path.resolve('electron/server/content-packs/state.ts')).href
    const pathsModule = pathToFileURL(path.resolve('electron/server/content-packs/runtime-paths.ts')).href
    await fs.writeFile(workerPath, [
      `import { mutateContentPackState } from ${JSON.stringify(stateModule)};`,
      `import { getContentPackRuntimePaths } from ${JSON.stringify(pathsModule)};`,
      'const id = process.env.CONTENT_PACK_WORKER_ID;',
      'await mutateContentPackState(state => { state.packs[`com.storystudio.process.${id}`] = { discovery_disabled: false, versions: {} }; }, getContentPackRuntimePaths());',
    ].join('\n'))
    await Promise.all(Array.from({ length: 20 }, (_, n) => runWorker(workerPath, {
      ...process.env,
      STORY_STUDIO_DATA_DIR: temp.dir,
      CONTENT_PACK_WORKER_ID: String(n),
      STORY_STUDIO_DISABLE_LISTEN: '1',
    })))
    assert.equal(Object.keys((await readContentPackState()).packs).length, 20)
  })

  test('recovers a bounded stale cross-process lock owned by a dead process', async () => {
    const { paths } = await isolatedPaths()
    const lockPath = `${paths.statePath}.lock`
    const reference = await __testAcquireContentPackStateLock(paths)
    await reference.release()
    await fs.writeFile(lockPath, JSON.stringify({
      ...reference.owner,
      pid: 999_999_999,
      process_incarnation: 'dead-process',
      created_at_ms: Date.now() - 120_000,
    }))
    await mutateContentPackState(state => {
      state.packs['com.storystudio.recovered-lock'] = { discovery_disabled: false, versions: {} }
    }, paths)
    assert.ok((await readContentPackState(paths)).packs['com.storystudio.recovered-lock'])
  })

  test('publishes a complete canonical lock record atomically with no ownerless window', async () => {
    const { paths } = await isolatedPaths()
    const lock = await __testAcquireContentPackStateLock(paths)
    try {
      const raw = JSON.parse(await fs.readFile(`${paths.statePath}.lock`, 'utf8'))
      assert.equal(raw.token, lock.owner.token)
      assert.equal(raw.hostname, lock.owner.hostname)
      assert.equal(raw.process_incarnation, lock.owner.process_incarnation)
    } finally {
      await lock.release()
    }
    await assert.rejects(fs.access(`${paths.statePath}.lock`), { code: 'ENOENT' })
  })

  test('does not steal a sleeping, live old lock or delete a successor lock token', async () => {
    const { paths } = await isolatedPaths()
    const first = await __testAcquireContentPackStateLock(paths)
    const lockPath = `${paths.statePath}.lock`
    const liveOld = { ...first.owner, created_at_ms: Date.now() - 120_000 }
    await fs.writeFile(lockPath, JSON.stringify(liveOld))
    await assert.rejects(
      __testAcquireContentPackStateLock(paths, { lockWaitMs: 25, staleLockMs: 1 }),
      /timed out/i,
    )
    const successor = { ...liveOld, token: 'successor-token' }
    await fs.writeFile(lockPath, JSON.stringify(successor))
    await first.release()
    assert.equal(JSON.parse(await fs.readFile(lockPath, 'utf8')).token, 'successor-token')
    await fs.unlink(lockPath)
  })

  test('fails closed for foreign-host or corrupt lock records and reclaims a reused PID only when incarnation differs', async () => {
    const { paths } = await isolatedPaths()
    const lockPath = `${paths.statePath}.lock`
    await fs.mkdir(paths.root, { recursive: true })
    const current = (await __testAcquireContentPackStateLock(paths)).owner
    await fs.unlink(lockPath)
    const foreign = { ...current, hostname: 'another-host', created_at_ms: Date.now() - 120_000 }
    await fs.writeFile(lockPath, JSON.stringify(foreign))
    await assert.rejects(__testAcquireContentPackStateLock(paths, { lockWaitMs: 25, staleLockMs: 1 }), /foreign host|timed out/i)
    await fs.unlink(lockPath)
    await fs.writeFile(lockPath, '{not json')
    await assert.rejects(__testAcquireContentPackStateLock(paths, { lockWaitMs: 25, staleLockMs: 1 }), /corrupt/i)
    await fs.unlink(lockPath)
    await fs.writeFile(lockPath, JSON.stringify({ ...current, process_incarnation: 'reused-pid', created_at_ms: Date.now() - 120_000 }))
    const reclaimed = await __testAcquireContentPackStateLock(paths, { lockWaitMs: 100, staleLockMs: 1 })
    await reclaimed.release()
  })

  test('uses injected process-incarnation facts to distinguish a reused PID from a live owner', async () => {
    const { paths } = await isolatedPaths()
    const runtime = {
      now: () => 1_000_000,
      sleep: async () => {},
      current: async () => ({ hostname: 'test-host', pid: 42, process_incarnation: 'new-incarnation' }),
      processIncarnation: async () => 'new-incarnation',
    }
    const initial = await __testAcquireContentPackStateLock(paths, { runtime })
    await initial.release()
    await fs.writeFile(`${paths.statePath}.lock`, JSON.stringify({
      ...initial.owner,
      process_incarnation: 'old-incarnation',
      created_at_ms: 1,
    }))
    const reclaimed = await __testAcquireContentPackStateLock(paths, { runtime, staleLockMs: 1, lockWaitMs: 10 })
    await reclaimed.release()
  })

  test('serialises two barrier-controlled stale recoveries so a delayed contender cannot unlink the successor', async () => {
    const { paths } = await isolatedPaths()
    const lockPath = `${paths.statePath}.lock`
    const reference = await __testAcquireContentPackStateLock(paths)
    await reference.release()
    await fs.writeFile(lockPath, JSON.stringify({
      ...reference.owner,
      process_incarnation: 'dead-incarnation',
      created_at_ms: Date.now() - 120_000,
      token: 'stale-token',
    }))
    let openBarrier!: () => void
    const barrier = new Promise<void>(resolve => { openBarrier = resolve })
    let recoveryGuardHeld!: () => void
    const guardHeld = new Promise<void>(resolve => { recoveryGuardHeld = resolve })
    const first = __testAcquireContentPackStateLock(paths, {
      staleLockMs: 1,
      lockWaitMs: 250,
      hooks: {
        afterRecoveryGuardAcquired: async () => {
          recoveryGuardHeld()
          await barrier
        },
      },
    })
    await guardHeld
    const second = __testAcquireContentPackStateLock(paths, { staleLockMs: 1, lockWaitMs: 40 })
    openBarrier()
    const outcomes = await Promise.allSettled([first, second])
    const acquired = outcomes.filter((outcome): outcome is PromiseFulfilledResult<Awaited<typeof first>> => outcome.status === 'fulfilled')
    const rejected = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
    assert.equal(acquired.length, 1)
    assert.equal(rejected.length, 1)
    assert.match(String(rejected[0].reason), /timed out/i)
    assert.equal(JSON.parse(await fs.readFile(lockPath, 'utf8')).token, acquired[0].value.owner.token)
    await acquired[0].value.release()
  })

  test('fails closed on an abandoned recovery guard without touching the stale canonical lock', async () => {
    const { paths } = await isolatedPaths()
    const lockPath = `${paths.statePath}.lock`
    const reference = await __testAcquireContentPackStateLock(paths)
    await reference.release()
    const stale = {
      ...reference.owner,
      process_incarnation: 'dead-incarnation',
      created_at_ms: Date.now() - 120_000,
      token: 'stale-canonical-token',
    }
    await fs.writeFile(lockPath, JSON.stringify(stale))
    await fs.writeFile(`${lockPath}.recovery`, JSON.stringify({
      ...reference.owner,
      pid: 999_999_999,
      process_incarnation: 'abandoned-guard',
      token: 'abandoned-guard-token',
    }))
    await assert.rejects(__testAcquireContentPackStateLock(paths, { staleLockMs: 1, lockWaitMs: 25 }), /recovery guard|timed out/i)
    assert.equal(JSON.parse(await fs.readFile(lockPath, 'utf8')).token, stale.token)
  })

  test('constructs only contained immutable version paths and verified files', async () => {
    const { paths } = await isolatedPaths()
    const versionRoot = installedVersionPath(paths, manifest())
    assert.equal(versionRoot, path.join(paths.installedRoot, 'com.storystudio', 'com.storystudio.test-pack', '1.2.3'))
    assert.match(resolveVerifiedPackFile(versionRoot, 'content/visual-style.json'), new RegExp(`${path.sep.replace('\\', '\\\\')}content${path.sep.replace('\\', '\\\\')}visual-style\\.json$`))
    assert.throws(() => resolveVerifiedPackFile(versionRoot, '../state.json'), /contained/i)
    assert.throws(() => resolveVerifiedPackFile(versionRoot, 'content\\style.json'), /contained/i)
    assert.throws(() => resolveVerifiedPackFile(versionRoot, 'content/../style.json'), /contained/i)
    assert.throws(() => resolveVerifiedPackFile(versionRoot, 'content/\0style.json'), /contained/i)
    assert.throws(() => resolveVerifiedPackFile(versionRoot, 'content/link/../../state.json'), /contained/i)
    assert.throws(() => resolveVerifiedPackFile(versionRoot, 'content/UPPER.json'), /contained/i)
    assert.throws(() => resolveVerifiedPackFile(versionRoot, 'content/caf\u00e9.json'), /contained/i)
  })

  test('rejects an existing intermediate symlink that escapes the verified version root', async () => {
    const { temp } = await isolatedPaths()
    const versionRoot = path.join(temp.dir, 'version')
    const outside = path.join(temp.dir, 'outside')
    await fs.mkdir(path.join(versionRoot, 'content'), { recursive: true })
    await fs.mkdir(outside)
    await fs.symlink(outside, path.join(versionRoot, 'content', 'link'))
    assert.throws(() => resolveVerifiedPackFile(versionRoot, 'content/link/file.json'), /symlink|contained/i)
  })

  test('uses source roots in dev Electron and packaged resources only for packaged app', () => {
    const sourceRoot = '/source/electron/server/content-packs'
    assert.equal(resolveContentPackRecoveryRoot({ packaged: false, sourceContentPackRoot: sourceRoot, resourcesPath: '/Resources' }), '/source/electron/server/content-packs/recovery')
    assert.equal(resolveContentPackRecoveryRoot({ packaged: true, sourceContentPackRoot: sourceRoot, resourcesPath: '/Resources' }), '/Resources/content-packs/recovery')
    assert.equal(resolveFirstPartyContentPackKeyringPath({ packaged: false, sourceContentPackRoot: sourceRoot, resourcesPath: '/Resources' }), '/source/electron/server/content-packs/recovery/trust-keys.json')
    assert.equal(resolveFirstPartyContentPackKeyringPath({ packaged: true, sourceContentPackRoot: sourceRoot, resourcesPath: '/Resources' }), '/Resources/content-packs/recovery/trust-keys.json')
  })

  test('finds the source content-pack root from a compiled-development-like importer path', async () => {
    const { temp } = await isolatedPaths()
    const root = path.join(temp.dir, 'repo')
    const source = path.join(root, 'electron', 'server', 'content-packs')
    const compiledImporter = path.join(root, 'electron', 'dist', 'server', 'content-packs')
    await fs.mkdir(source, { recursive: true })
    await fs.mkdir(compiledImporter, { recursive: true })
    await fs.writeFile(path.join(root, 'package.json'), '{}')
    assert.equal(findContentPackSourceRoot(compiledImporter), source)
  })

  test('accepts only canonical Ed25519 public keys in the publisher namespace', () => {
    const ed25519 = generateKeyPairSync('ed25519')
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const publicKeyPem = ed25519.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    assert.equal(createContentPackKeyring([{
      keyId: 'com.storystudio.test-key',
      publisherId: 'com.storystudio',
      publicKeyPem,
    }]).publisherKeys.size, 1)
    assert.throws(() => createContentPackKeyring([{
      keyId: 'com.other.test-key', publisherId: 'com.storystudio', publicKeyPem,
    }]), /namespace/i)
    assert.throws(() => createContentPackKeyring([{
      keyId: 'com.storystudio.rsa', publisherId: 'com.storystudio',
      publicKeyPem: rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    }]), /Ed25519/i)
    assert.throws(() => createContentPackKeyring([{
      keyId: 'com.storystudio.private', publisherId: 'com.storystudio',
      publicKeyPem: ed25519.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    }]), /public key|private/i)
    assert.throws(() => createContentPackKeyring([{
      keyId: 'com.storystudio.trailing', publisherId: 'com.storystudio', publicKeyPem: `${publicKeyPem}not a key`,
    }]), /canonical|public key/i)
  })
})
