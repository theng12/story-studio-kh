import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { after, before, test } from 'node:test'
import { useTempDataDir } from './_helpers.js'
import { getTestSafeStorageAvailable, setTestSafeStorageAvailable } from './safe-storage-test-double.js'

const STORY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const GATEWAY_ID = '22222222-2222-4222-8222-222222222222'
const OWNER_SCOPE = '33333333-3333-4333-8333-333333333333'
const BEARER = 'ab'.repeat(32)
const ORIGIN = 'https://gateway.private.example'

let retained: Awaited<ReturnType<typeof useTempDataDir>> | undefined
type IdentityModule = typeof import('../services/private-render-identity.js')

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

async function settlementWithin(
  promise: Promise<unknown>,
  milliseconds = 80,
): Promise<'fulfilled' | 'rejected' | 'pending'> {
  return Promise.race([
    promise.then(() => 'fulfilled' as const, () => 'rejected' as const),
    delay(milliseconds).then(() => 'pending' as const),
  ])
}

async function independentIdentityModule(label: string): Promise<IdentityModule> {
  const url = new URL('../services/private-render-identity.js', import.meta.url)
  url.searchParams.set('independent-caller', `${label}-${randomUUID()}`)
  return import(url.href) as Promise<IdentityModule>
}

function interceptFsOpen(
  intercept: (args: unknown[], handle: any) => any,
): () => void {
  const originalOpen = fs.open
  ;(fs as any).open = async (...args: unknown[]) => intercept(args, await (originalOpen as any)(...args))
  return () => { (fs as any).open = originalOpen }
}

function proxyFileHandle(handle: any, methods: Record<string, (...args: any[]) => unknown>): any {
  return new Proxy(handle, {
    get(target, property) {
      if (typeof property === 'string' && methods[property]) return methods[property]
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function refuseSafeStorageDecrypt(): () => void {
  const require = createRequire(import.meta.url)
  const electron = require(require.resolve('electron')) as {
    safeStorage: { decryptString: (encrypted: Buffer) => string }
  }
  const originalDecrypt = electron.safeStorage.decryptString
  electron.safeStorage.decryptString = () => { throw new Error('injected safeStorage decrypt failure') }
  return () => { electron.safeStorage.decryptString = originalDecrypt }
}

before(async () => {
  retained = await useTempDataDir({ retain: true, settle: async () => {} })
})

after(async () => { await retained?.cleanup() })

async function inCase<T>(name: string, run: (dir: string) => Promise<T>): Promise<T> {
  if (!retained) throw new Error('retained fixture was not created')
  const dir = path.join(retained.dir, name)
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  const previous = process.env.STORY_STUDIO_DATA_DIR
  process.env.STORY_STUDIO_DATA_DIR = dir
  try {
    return await run(dir)
  } finally {
    if (previous === undefined) delete process.env.STORY_STUDIO_DATA_DIR
    else process.env.STORY_STUDIO_DATA_DIR = previous
    setTestSafeStorageAvailable(true)
  }
}

test('private render identity is created once with private durable bytes and malformed state is never reset', async () => {
  const identity = await import('../services/private-render-identity.js')

  await inCase('identity-once', async dir => {
    const records = await Promise.all(Array.from({ length: 12 }, () => identity.getOrCreatePrivateRenderIdentity()))
    const ids = new Set(records.map(record => record.story_instance_id))
    assert.equal(ids.size, 1)
    assert.match(records[0]!.story_instance_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)

    const privateDir = path.join(dir, 'private-render')
    const identityFile = path.join(privateDir, 'identity.json')
    const beforeBytes = await fs.readFile(identityFile)
    const beforeStat = await fs.lstat(identityFile)
    assert.deepEqual(JSON.parse(beforeBytes.toString('utf8')), {
      format: 'studio.private-render.identity.v1',
      story_instance_id: records[0]!.story_instance_id,
    })
    assert.equal(beforeStat.isFile(), true)
    assert.equal(beforeStat.isSymbolicLink(), false)
    assert.equal(beforeStat.nlink, 1)
    if (process.platform !== 'win32') {
      assert.equal((await fs.stat(privateDir)).mode & 0o777, 0o700)
      assert.equal(beforeStat.mode & 0o777, 0o600)
    }

    assert.deepEqual(await identity.getOrCreatePrivateRenderIdentity(), records[0])
    const afterStat = await fs.lstat(identityFile)
    assert.deepEqual(await fs.readFile(identityFile), beforeBytes)
    assert.equal(afterStat.ino, beforeStat.ino, 'a read must not replace the durable identity file')
  })

  await inCase('identity-malformed', async dir => {
    const privateDir = path.join(dir, 'private-render')
    const identityFile = path.join(privateDir, 'identity.json')
    await fs.mkdir(privateDir, { mode: 0o700 })
    const malformed = Buffer.from(JSON.stringify({
      format: 'studio.private-render.identity.v1',
      story_instance_id: STORY_ID.toUpperCase(),
    }))
    await fs.writeFile(identityFile, malformed, { mode: 0o600, flag: 'wx' })

    await assert.rejects(identity.getOrCreatePrivateRenderIdentity(), /identity|uuid|malformed|invalid/i)
    assert.deepEqual(await fs.readFile(identityFile), malformed, 'unsafe identity bytes remain inspectable')
  })
})

test('independent identity callers cannot observe the final path before its durable write completes', async () => {
  await inCase('identity-independent-before-write', async dir => {
    const identityFile = path.join(dir, 'private-render', 'identity.json')
    const writeEntered = deferred()
    const releaseWrite = deferred()
    let intercepted = false
    const restoreOpen = interceptFsOpen((args, handle) => {
      if (String(args[0]) !== identityFile || args[1] !== 'wx' || intercepted) return handle
      intercepted = true
      const writeFile = handle.writeFile.bind(handle)
      return proxyFileHandle(handle, {
        async writeFile(...writeArgs: any[]) {
          writeEntered.resolve()
          await releaseWrite.promise
          return writeFile(...writeArgs)
        },
      })
    })

    let first: Promise<unknown> | undefined
    let second: Promise<unknown> | undefined
    try {
      const [callerA, callerB] = await Promise.all([
        independentIdentityModule('before-write-a'),
        independentIdentityModule('before-write-b'),
      ])
      first = callerA.getOrCreatePrivateRenderIdentity()
      await writeEntered.promise
      second = callerB.getOrCreatePrivateRenderIdentity()
      const secondBeforeWrite = await settlementWithin(second)
      const lockIsPublished = await fs.lstat(`${identityFile}.lock`)
        .then(stat => stat.isFile() && !stat.isSymbolicLink(), () => false)
      releaseWrite.resolve()
      const [recordA, recordB] = await Promise.all([first, second]) as [
        Awaited<ReturnType<IdentityModule['getOrCreatePrivateRenderIdentity']>>,
        Awaited<ReturnType<IdentityModule['getOrCreatePrivateRenderIdentity']>>,
      ]
      assert.deepEqual(
        { secondBeforeWrite, lockIsPublished },
        { secondBeforeWrite: 'pending', lockIsPublished: true },
      )
      assert.equal(recordB.story_instance_id, recordA.story_instance_id)
    } finally {
      releaseWrite.resolve()
      await Promise.allSettled([first, second].filter(Boolean) as Promise<unknown>[])
      restoreOpen()
    }
  })
})

test('a failed identity sync is durably confirmed under the shared lock before another caller accepts it', async () => {
  await inCase('identity-failed-sync-retry', async dir => {
    const privateDir = path.join(dir, 'private-render')
    const identityFile = path.join(privateDir, 'identity.json')
    const syncEntered = deferred()
    const releaseFailedSync = deferred()
    let creatorSyncFailed = false
    let confirmedFileSyncs = 0
    let confirmedDirectorySyncs = 0
    const restoreOpen = interceptFsOpen((args, handle) => {
      const target = String(args[0])
      if (target !== identityFile && target !== privateDir) return handle
      const sync = handle.sync.bind(handle)
      if (target === identityFile && args[1] === 'wx' && !creatorSyncFailed) {
        return proxyFileHandle(handle, {
          async sync() {
            syncEntered.resolve()
            await releaseFailedSync.promise
            creatorSyncFailed = true
            throw new Error('injected identity file sync failure')
          },
        })
      }
      return proxyFileHandle(handle, {
        async sync() {
          const result = await sync()
          if (creatorSyncFailed) {
            if (target === identityFile) confirmedFileSyncs += 1
            if (target === privateDir) confirmedDirectorySyncs += 1
          }
          return result
        },
      })
    })

    let first: Promise<unknown> | undefined
    let second: Promise<unknown> | undefined
    try {
      const [callerA, callerB, callerC] = await Promise.all([
        independentIdentityModule('failed-sync-a'),
        independentIdentityModule('failed-sync-b'),
        independentIdentityModule('failed-sync-c'),
      ])
      first = callerA.getOrCreatePrivateRenderIdentity()
      await syncEntered.promise
      second = callerB.getOrCreatePrivateRenderIdentity()
      const secondBeforeFailure = await settlementWithin(second)
      releaseFailedSync.resolve()
      await assert.rejects(first, /injected identity file sync failure/)
      const recordB = await second as Awaited<ReturnType<IdentityModule['getOrCreatePrivateRenderIdentity']>>
      const recordC = await callerC.getOrCreatePrivateRenderIdentity()
      assert.equal(secondBeforeFailure, 'pending')
      assert.ok(confirmedFileSyncs >= 1, 'the surviving identity file must be synced before retry acceptance')
      assert.ok(confirmedDirectorySyncs >= 1, 'the identity directory must be synced before retry acceptance')
      assert.equal(recordC.story_instance_id, recordB.story_instance_id)
      assert.deepEqual(JSON.parse(await fs.readFile(identityFile, 'utf8')), recordB)
    } finally {
      releaseFailedSync.resolve()
      await Promise.allSettled([first, second].filter(Boolean) as Promise<unknown>[])
      restoreOpen()
    }
  })
})

test('Gateway binding is pinned once, origin-bound, refuses a different identity, and rides the regular Gateway key', async () => {
  const identity = await import('../services/private-render-identity.js')
  const settings = await import('../services/app-settings.js')
  const secrets = await import('../services/app-secrets-store.js')
  const binding = { origin: ORIGIN, owner_scope: OWNER_SCOPE, gateway_instance_id: GATEWAY_ID }

  await inCase('binding-once', async dir => {
    await settings.setGenStudioUrl(ORIGIN)
    const created = await identity.getOrCreatePrivateRenderIdentity()
    await assert.rejects(identity.readPrivateRenderAccess(), /API key/i)
    await secrets.setApiKey('genstudio', BEARER)
    await assert.rejects(identity.readPrivateRenderAccess(), /binding/i)
    assert.deepEqual(await identity.getGatewayBindingStatus(), {
      bound: false, story_instance_id: created.story_instance_id,
      configured_origin: ORIGIN, matches_configured_gateway: null, repaired_from: null,
    })

    const bindingFile = path.join(dir, 'private-render', 'gateway-binding.json')
    assert.deepEqual(await identity.pinGatewayBinding(binding), binding)
    const beforeBytes = await fs.readFile(bindingFile)
    const beforeStat = await fs.lstat(bindingFile)
    assert.deepEqual(JSON.parse(beforeBytes.toString('utf8')), binding)
    assert.equal(beforeStat.nlink, 1)
    if (process.platform !== 'win32') assert.equal(beforeStat.mode & 0o777, 0o600)

    assert.deepEqual(await identity.pinGatewayBinding(binding), binding)
    for (const other of [
      { ...binding, owner_scope: STORY_ID },
      { ...binding, gateway_instance_id: STORY_ID },
      { ...binding, origin: 'https://different-gateway.example' },
    ]) await assert.rejects(identity.pinGatewayBinding(other), /pinned|binding/i)
    await assert.rejects(identity.pinGatewayBinding({ ...binding, owner_scope: 'not-a-uuid' }), /binding|uuid/i)
    assert.deepEqual(await fs.readFile(bindingFile), beforeBytes, 'a different Gateway identity never re-pairs')
    assert.equal((await fs.lstat(bindingFile)).ino, beforeStat.ino)

    assert.deepEqual(await identity.readPrivateRenderAccess(), {
      origin: ORIGIN, bearer: BEARER, story_instance_id: created.story_instance_id,
      owner_scope: OWNER_SCOPE, gateway_instance_id: GATEWAY_ID,
    })
    assert.deepEqual(await identity.getGatewayBindingStatus(), {
      bound: true, story_instance_id: created.story_instance_id, ...binding,
      configured_origin: ORIGIN, matches_configured_gateway: true, repaired_from: null,
    })
    assert.ok(!JSON.stringify(await identity.getGatewayBindingStatus()).includes(BEARER))

    await secrets.setApiKey('genstudio', 'cd'.repeat(32))
    assert.equal((await identity.readPrivateRenderAccess()).bearer, 'cd'.repeat(32), 'key rotation needs no re-pairing')

    // A pin for another origin is reported, not rewritten here: only the capabilities route
    // re-pairs, because only it has the identity the new Gateway answers with.
    await settings.setGenStudioUrl('https://different-gateway.example')
    const unpaired = await identity.readPrivateRenderConnection()
    assert.equal(unpaired.origin, 'https://different-gateway.example')
    assert.equal(unpaired.binding?.origin, ORIGIN, 'the old pin is still what is stored')
    await assert.rejects(identity.readPrivateRenderAccess(), /origin|binding/i)
    await settings.setGenStudioUrl(ORIGIN)
    assert.equal((await identity.readPrivateRenderAccess()).origin, ORIGIN)
  })

  await inCase('binding-malformed', async dir => {
    await settings.setGenStudioUrl(ORIGIN)
    await secrets.setApiKey('genstudio', BEARER)
    const privateDir = path.join(dir, 'private-render')
    const bindingFile = path.join(privateDir, 'gateway-binding.json')
    await fs.mkdir(privateDir, { mode: 0o700 })
    const malformed = Buffer.from(JSON.stringify({ ...binding, extra: true }))
    await fs.writeFile(bindingFile, malformed, { mode: 0o600, flag: 'wx' })

    await assert.rejects(identity.pinGatewayBinding(binding), /binding|field/i)
    await assert.rejects(identity.readPrivateRenderAccess(), /binding|field/i)
    assert.deepEqual(await fs.readFile(bindingFile), malformed, 'unsafe binding bytes remain inspectable')
  })
})

test('a movable Gateway origin re-pairs itself, moves the old pairing to Story\'s Trash, and refuses the same origin', async () => {
  const identity = await import('../services/private-render-identity.js')
  const settings = await import('../services/app-settings.js')
  const secrets = await import('../services/app-secrets-store.js')
  const queue = await import('../services/job-queue.js')
  const binding = { origin: ORIGIN, owner_scope: OWNER_SCOPE, gateway_instance_id: GATEWAY_ID }
  const MOVED_ORIGIN = 'https://moved-gateway.example'
  const MOVED_ID = '44444444-4444-4444-8444-444444444444'
  const moved = { origin: MOVED_ORIGIN, owner_scope: OWNER_SCOPE, gateway_instance_id: MOVED_ID }

  await inCase('binding-repair', async dir => {
    await settings.setGenStudioUrl(ORIGIN)
    await secrets.setApiKey('genstudio', BEARER)
    await identity.pinGatewayBinding(binding)
    const bindingFile = path.join(dir, 'private-render', 'gateway-binding.json')
    const beforeBytes = await fs.readFile(bindingFile)
    const beforeStat = await fs.lstat(bindingFile)

    // Before the queue has loaded this Mac's jobs, "nothing is in flight" cannot be proven.
    await settings.setGenStudioUrl(MOVED_ORIGIN)
    await assert.rejects(identity.repairGatewayBinding(moved), /not been re-paired|loaded/i)
    assert.deepEqual(await fs.readFile(bindingFile), beforeBytes, 'an unproven queue state moves nothing')
    if (!queue.areBootJobsLoaded()) await queue.resumeInterruptedJobsAtBoot()

    // A different identity at the SAME origin is the replacement/spoof case and is never re-paired.
    await settings.setGenStudioUrl(ORIGIN)
    await assert.rejects(
      identity.repairGatewayBinding({ ...binding, gateway_instance_id: MOVED_ID }),
      /pinned|binding/i,
    )
    assert.deepEqual(await fs.readFile(bindingFile), beforeBytes)
    assert.equal((await fs.lstat(bindingFile)).ino, beforeStat.ino)

    // An origin nobody configured is not somewhere the pairing may move to.
    await assert.rejects(identity.repairGatewayBinding(moved), /configured Gateway origin/i)

    await settings.setGenStudioUrl(MOVED_ORIGIN)
    assert.deepEqual(await identity.repairGatewayBinding(moved), moved)
    assert.deepEqual(JSON.parse(await fs.readFile(bindingFile, 'utf8')), moved)
    assert.notEqual((await fs.lstat(bindingFile)).ino, beforeStat.ino, 'the pairing is a new file')

    // The old pairing is not destroyed: it is in Story's Trash, indexed, with its exact bytes.
    const trashRoot = path.join(dir, 'projects', '_trash')
    const movedTo = path.join(trashRoot, '_story-studio', 'private-render')
    const trashed = await fs.readdir(movedTo)
    assert.equal(trashed.length, 1)
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(movedTo, trashed[0]!), 'utf8')), binding)
    const indexEntries = (await fs.readFile(path.join(trashRoot, '.trash-index.jsonl'), 'utf8'))
      .trim().split('\n').map(line => JSON.parse(line))
      .filter(entry => entry.kind === 'private-render')
    assert.equal(indexEntries.length, 1)
    assert.equal(indexEntries[0].from, path.resolve(bindingFile))
    assert.equal(indexEntries[0].to, path.resolve(path.join(movedTo, trashed[0]!)))

    const status = await identity.getGatewayBindingStatus()
    assert.deepEqual(status, {
      bound: true, story_instance_id: status.story_instance_id, ...moved,
      configured_origin: MOVED_ORIGIN, matches_configured_gateway: true,
      repaired_from: { origin: ORIGIN, gateway_instance_id: GATEWAY_ID, at: status.repaired_from?.at },
    })
    assert.match(status.repaired_from?.at || '', /^\d{4}-\d\d-\d\dT[\d:.]+Z$/)

    // Nothing more to do on the next call, and it does not move the new pairing anywhere.
    const repairedInode = (await fs.lstat(bindingFile)).ino
    assert.deepEqual(await identity.repairGatewayBinding(moved), moved)
    assert.equal((await fs.lstat(bindingFile)).ino, repairedInode)
    assert.equal((await fs.readdir(movedTo)).length, 1, 'an unchanged pairing adds no second Trash move')

    assert.deepEqual(await identity.readPrivateRenderAccess(), {
      origin: MOVED_ORIGIN, bearer: BEARER, story_instance_id: status.story_instance_id,
      owner_scope: OWNER_SCOPE, gateway_instance_id: MOVED_ID,
    })
  })

  await inCase('binding-repair-in-flight', async dir => {
    await settings.setGenStudioUrl(ORIGIN)
    await secrets.setApiKey('genstudio', BEARER)
    await identity.pinGatewayBinding(binding)
    if (!queue.areBootJobsLoaded()) await queue.resumeInterruptedJobsAtBoot()
    const job = queue.enqueuePreparedForTest({
      project_slug: 'repair-channel', type: 'video_assembly', episode_id: 'EP1',
    })
    queue._setJobRecordForTesting(job.job_id, { final_render_remote_wait: { version: 1 } as any })

    await settings.setGenStudioUrl(MOVED_ORIGIN)
    await assert.rejects(identity.repairGatewayBinding(moved), /in flight/i)
    const bindingFile = path.join(dir, 'private-render', 'gateway-binding.json')
    assert.deepEqual(JSON.parse(await fs.readFile(bindingFile, 'utf8')), binding, 'the old pairing stands')
    await assert.rejects(fs.stat(path.join(dir, 'projects', '_trash')), /ENOENT/,
      'a refused re-pair moves nothing to the Trash')
  })
})

test('an available safeStorage decrypt failure preserves the old envelope, permits a recoverable key write, and never re-pairs the pinned binding', async () => {
  const identity = await import('../services/private-render-identity.js')
  const settings = await import('../services/app-settings.js')
  const secrets = await import('../services/app-secrets-store.js')
  const replacementKey = 'gsk_recovered_replacement_key'
  const binding = { origin: ORIGIN, owner_scope: OWNER_SCOPE, gateway_instance_id: GATEWAY_ID }

  await inCase('binding-decrypt-failure', async dir => {
    await settings.setGenStudioUrl(ORIGIN)
    await identity.getOrCreatePrivateRenderIdentity()
    await secrets.setApiKey('genstudio', BEARER)
    await identity.pinGatewayBinding(binding)
    const secretsPath = secrets.appSecretsPath()
    const bindingPath = path.join(dir, 'private-render', 'gateway-binding.json')
    const originalEnvelope = await fs.readFile(secretsPath)
    const bindingBefore = await fs.readFile(bindingPath)
    const bindingStatBefore = await fs.lstat(bindingPath)

    assert.equal(getTestSafeStorageAvailable(), true)
    const restoreDecrypt = refuseSafeStorageDecrypt()
    let providerWrite: PromiseSettledResult<unknown> | undefined
    let accessRead: PromiseSettledResult<unknown> | undefined
    let statusDuringFailure: unknown
    try {
      providerWrite = (await Promise.allSettled([
        secrets.setApiKey('genstudio', replacementKey),
      ]))[0]!
      accessRead = (await Promise.allSettled([identity.readPrivateRenderAccess()]))[0]!
      statusDuringFailure = await identity.getGatewayBindingStatus()
    } finally {
      restoreDecrypt()
    }

    assert.ok(providerWrite && accessRead)
    assert.equal(providerWrite.status, 'fulfilled', 'the recoverable bucket write is the current contract')
    assert.equal(accessRead.status, 'rejected', 'an unreadable active store cannot serve private render access')
    const accessMessage = String((accessRead as PromiseRejectedResult).reason)
    assert.match(accessMessage, /API key/i)
    assert.ok(!accessMessage.includes(BEARER), 'the rejection must not leak the prior bearer')
    assert.ok(!accessMessage.includes(replacementKey), 'the rejection must not leak the replacement key')

    // The undecryptable envelope is sidecar-preserved byte-for-byte before recovery replaces the active store.
    const secretsDir = path.dirname(secretsPath)
    const backups = (await fs.readdir(secretsDir))
      .filter(name => name.startsWith(`${path.basename(secretsPath)}.bak.`))
    assert.equal(backups.length, 1, 'exactly the preserved original envelope is retained')
    assert.deepEqual(await fs.readFile(path.join(secretsDir, backups[0]!)), originalEnvelope)
    const activeEnvelope = await fs.readFile(secretsPath)
    assert.notDeepEqual(activeEnvelope, originalEnvelope, 'the recoverable write becomes the active store')
    assert.ok(!activeEnvelope.includes(Buffer.from(BEARER)), 'active bytes never hold the old key in plaintext')
    assert.ok(!activeEnvelope.includes(Buffer.from(replacementKey)), 'active bytes never hold the replacement key in plaintext')

    // The pinned binding is neither rewritten nor re-paired during the failure.
    assert.deepEqual(await fs.readFile(bindingPath), bindingBefore)
    assert.equal((await fs.lstat(bindingPath)).ino, bindingStatBefore.ino, 'a failed decrypt must not rebind')
    const status = statusDuringFailure as {
      bound: boolean; origin?: string; owner_scope?: string; gateway_instance_id?: string
    }
    assert.equal(status.bound, true)
    assert.equal(status.origin, ORIGIN)
    assert.equal(status.owner_scope, OWNER_SCOPE)
    assert.equal(status.gateway_instance_id, GATEWAY_ID)
    assert.ok(!JSON.stringify(status).includes(replacementKey))

    // Once the OS keychain is readable again the recovered key serves the same pinned binding.
    assert.equal(await secrets.getApiKey('genstudio'), replacementKey)
    const access = await identity.readPrivateRenderAccess()
    assert.deepEqual(access, {
      origin: ORIGIN, bearer: replacementKey, story_instance_id: access.story_instance_id,
      owner_scope: OWNER_SCOPE, gateway_instance_id: GATEWAY_ID,
    })
    assert.deepEqual(await fs.readFile(bindingPath), bindingBefore)
    assert.equal((await fs.lstat(bindingPath)).ino, bindingStatBefore.ino)
    assert.deepEqual(await identity.pinGatewayBinding(binding), binding)
    await assert.rejects(identity.pinGatewayBinding({ ...binding, gateway_instance_id: STORY_ID }), /pinned|binding/i)
  })
})
