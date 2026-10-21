import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { constants, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'
import { promisify } from 'node:util'
import ts from 'typescript'

import {
  hasFinalRenderRemoteWaitMarker,
  parseFinalRenderRemoteWaitReceipt,
  publicFinalRenderWait,
  sameFinalRenderRemoteWaitIdentity,
} from '../lib/final-render-remote-wait.js'
import type {
  FinalRenderIntentStagedReceiptV2,
  FinalRenderRemoteWaitReceiptV1,
  Job,
} from '../models/types.js'
import { resolveJobAutoRetryPolicy } from '../services/job-retry-policy.js'
import { assertProjectJobsSafeToRemove } from '../services/project-job-removal-guard.js'
import { installTestSafeStorage, setTestSafeStorageAvailable } from './safe-storage-test-double.js'
import {
  attemptId, COMMITTED_AT, intentId, STORY_ID, writeV2PrivateSnapshot,
} from './fixtures/final-render-v2-snapshot.js'
import '../../../scripts/testing/loopback-supertest.mjs'

installTestSafeStorage()

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url))
const SERVER_ROOT = path.resolve(TEST_DIR, '..')
const HASH = 'a'.repeat(64)

const execFileAsync = promisify(execFile)
const previousEnvironment = new Map(
  ['STORY_STUDIO_DATA_DIR', 'TMPDIR', 'TMP', 'TEMP'].map(key => [key, process.env[key]]),
)
let retained: { dir: string; runRoot: string }
let queue: typeof import('../services/job-queue.js')
const trackedJobIds = new Set<string>()

async function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms) }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function createRetainedFifo(filePath: string): Promise<void> {
  await execFileAsync('/usr/bin/mkfifo', [filePath])
  assert.equal((await fs.lstat(filePath)).isFIFO(), true, 'the retained special-node proof must be a real FIFO')
}

async function releaseBlockedFifoReader(filePath: string): Promise<void> {
  for (let turn = 0; turn < 100; turn++) {
    try {
      const writer = await fs.open(filePath, constants.O_WRONLY | constants.O_NONBLOCK)
      await writer.close()
      return
    } catch (error: any) {
      if (error?.code !== 'ENXIO') throw error
      await new Promise<void>(resolve => setTimeout(resolve, 5))
    }
  }
  assert.fail('blocked FIFO reader was not available for bounded release')
}

async function assertRejectsWithoutBlockingOnFifo(attempt: Promise<unknown>, filePath: string, label: string): Promise<void> {
  let settled = false
  const observed = attempt.then(
    () => ({ kind: 'fulfilled' as const, error: null }),
    error => ({ kind: 'rejected' as const, error }),
  ).finally(() => { settled = true })
  await new Promise<void>(resolve => setTimeout(resolve, 100))
  const settledBeforeRelease = settled
  if (!settled) await releaseBlockedFifoReader(filePath)
  const result = await within(observed, 2_000, `${label} physical FIFO settlement`)
  assert.equal(result.kind, 'rejected', `${label} must reject the FIFO`)
  assert.equal(settledBeforeRelease, true, `${label} must reject before a FIFO writer exists`)
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  await within((async () => {
    for (let turn = 0; turn < 2_000; turn++) {
      if (check()) return
      await new Promise<void>(resolve => setTimeout(resolve, 2))
    }
    assert.fail(`${label} did not settle`)
  })(), 5_000, label)
}

async function settle(): Promise<void> {
  if (!queue) return
  await waitFor(
    () => [...trackedJobIds].every(jobId => !queue._isJobWorkerActiveForTesting(jobId)),
    'physical video workers',
  )
  await within(queue._waitForJobPersistenceForTesting(), 5_000, 'job persistence')
}

before(async () => {
  const harnessRoot = process.env.STORY_STUDIO_TEST_HARNESS_ROOT
  assert.ok(harnessRoot, 'run through scripts/testing/run-backend-tests.mjs so the retained root is isolated')
  for (const key of ['TMPDIR', 'TMP', 'TEMP']) {
    assert.equal(path.resolve(process.env[key] || ''), path.resolve(harnessRoot), `${key} must stay bound to the retained harness root`)
  }
  const root = await fs.mkdtemp(path.join(harnessRoot, 'video-assembly-intent-staged-retained-'))
  await fs.chmod(root, 0o700)
  process.env.STORY_STUDIO_DATA_DIR = root
  setTestSafeStorageAvailable(true)
  retained = { dir: root, runRoot: root }
  queue = await import('../services/job-queue.js')
})

after(async () => {
  try {
    await settle()
  } finally {
    setTestSafeStorageAvailable(true)
    for (const [key, value] of previousEnvironment) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

function v1(jobId = 'video-job-v1'): FinalRenderRemoteWaitReceiptV1 {
  return {
    version: 1,
    phase: 'remote_wait',
    revision: 1,
    job_id: jobId,
    intent_id: 'intent-v1',
    story_attempt: 1,
    gateway_attempt_key: 'attempt-v1',
    request_body_sha256: HASH,
    request_body_bytes: 123,
    packet_sha256: HASH,
    render_fingerprint: HASH,
    submission_scope_sha256: HASH,
    destination_fence_sha256: HASH,
    source_generation_fence_sha256: HASH,
    gateway_job_id: null,
    committed_at: COMMITTED_AT,
    cancel_requested_at: null,
  }
}

function job(slug: string, id: string, marker?: unknown): Job {
  const result: Job = {
    job_id: id,
    project_slug: slug,
    type: 'video_assembly',
    episode_id: 'EP1',
    title: 'Intent staged',
    status: 'running',
    created_at: '2026-10-15T00:00:00.000Z',
    started_at: '2026-10-15T00:00:00.000Z',
    finished_at: null,
    error: null,
    output_lines: [],
    params: { voice: 'Sophea', secret: 'private params remain unchanged' },
  }
  if (arguments.length >= 3) result.final_render_remote_wait = marker as any
  trackedJobIds.add(id)
  return result
}

async function writeCanonicalJob(value: Job): Promise<string> {
  const projectDir = path.join(retained.dir, 'projects', value.project_slug)
  await fs.mkdir(projectDir, { recursive: true, mode: 0o700 })
  const jobsPath = path.join(projectDir, 'jobs.json')
  await fs.writeFile(jobsPath, JSON.stringify({ jobs: [value] }), { mode: 0o600 })
  queue._forgetProjectPersistenceForTesting(value.project_slug)
  return jobsPath
}

function writePrivateSnapshot(value: Job, identity = 1): Promise<FinalRenderIntentStagedReceiptV2> {
  return writeV2PrivateSnapshot(retained.dir, value, identity)
}

test('v1 remains byte-for-byte accepted while v2 is exact, closed, identity-bound, and publicly intent_staged', () => {
  const old = v1()
  assert.deepEqual(parseFinalRenderRemoteWaitReceipt(old, old.job_id), { ok: true, receipt: old })

  const staged: FinalRenderIntentStagedReceiptV2 = {
    version: 2, phase: 'intent_staged', revision: 1, job_id: 'video-job-v2',
    intent_id: intentId(), story_instance_id: STORY_ID, story_attempt: 1,
    gateway_attempt_key: attemptId(), packet_sha256: HASH, staging_manifest_sha256: HASH,
    submission_scope_sha256: HASH, destination_fence_sha256: HASH,
    source_generation_fence_sha256: HASH, committed_at: COMMITTED_AT, cancel_requested_at: null,
  }
  assert.deepEqual(parseFinalRenderRemoteWaitReceipt(staged, staged.job_id), { ok: true, receipt: staged })
  assert.equal(hasFinalRenderRemoteWaitMarker(job('state', staged.job_id, null)), true)
  assert.deepEqual(publicFinalRenderWait(job('state', staged.job_id, staged)), {
    state: 'intent_staged', cancellation_requested: false, gateway_id_known: false, committed_at: COMMITTED_AT,
  })
  const cancelled = { ...staged, revision: 2 as const, cancel_requested_at: '2026-10-15T02:00:01.000Z' }
  assert.equal(sameFinalRenderRemoteWaitIdentity(staged, cancelled), true)
  for (const invalid of [
    { ...staged, version: 3 },
    { ...staged, phase: 'remote_wait' },
    { ...staged, story_instance_id: 'AAAAAAAA-3333-4333-8333-333333333333' },
    { ...staged, intent_id: 'intent-not-render' },
    { ...staged, gateway_attempt_key: 'not-a-uuid' },
    { ...staged, staging_manifest_sha256: HASH.toUpperCase() },
    { ...staged, story_attempt: 2 },
    { ...staged, extra: true },
    { ...staged, revision: 2, cancel_requested_at: null },
  ]) assert.equal(parseFinalRenderRemoteWaitReceipt(invalid, staged.job_id).ok, false)
})

test('v2 commit, exact reopen/retry, and cancellation reuse canonical disk bytes and the first instant', async () => {
  const slug = `commit-${process.pid}`
  const source = job(slug, 'intent-commit')
  const jobsPath = await writeCanonicalJob(source)
  const receipt = await writePrivateSnapshot(source)
  const [first, second] = await Promise.all([
    queue.commitFinalRenderRemoteWaitReceipt(source, receipt),
    queue.commitFinalRenderRemoteWaitReceipt(source, receipt),
  ])
  assert.deepEqual(first, { kind: 'committed', receipt })
  assert.deepEqual(second, first)
  queue._forgetProjectPersistenceForTesting(slug)
  assert.deepEqual((await queue.loadAuthoritativeJob(slug, source.job_id))?.final_render_remote_wait, receipt)

  const cancelledA = await queue.requestFinalRenderRemoteWaitCancellation(slug, source.job_id)
  const cancelledB = await queue.requestFinalRenderRemoteWaitCancellation(slug, source.job_id)
  assert.equal(cancelledA.final_render_remote_wait?.revision, 2)
  assert.equal(cancelledB.final_render_remote_wait?.cancel_requested_at, cancelledA.final_render_remote_wait?.cancel_requested_at)
  const disk = JSON.parse(await fs.readFile(jobsPath, 'utf8')).jobs[0]
  assert.deepEqual(disk.final_render_remote_wait, cancelledB.final_render_remote_wait)
  assert.equal(disk.status, 'running')
  assert.equal(disk.finished_at, null)
  assert.deepEqual(disk.params, source.params)

  const queuePath = path.join(SERVER_ROOT, 'services/job-queue.ts')
  const queueText = readFileSync(queuePath, 'utf8')
  const queueSource = ts.createSourceFile(queuePath, queueText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const commit = namedFunction(queueSource, 'commitFinalRenderRemoteWaitReceipt')
  assert.equal(commit.parameters[1]?.type?.getText(queueSource), 'FinalRenderRemoteWaitReceipt',
    'the canonical queue API must accept its closed v1/v2 receipt union')
  const stagingText = readFileSync(path.join(SERVER_ROOT, 'services/final-render-staging.ts'), 'utf8')
  assert.equal(stagingText.includes('as unknown as'), false,
    'the stager must call the canonical v1/v2 queue API without a temporary double cast')
})

test('canonical v2 commitment rejects a retained manifest FIFO without waiting for a writer', async () => {
  const slug = `manifest-fifo-${process.pid}`
  const source = job(slug, 'intent-manifest-fifo')
  await writeCanonicalJob(source)
  const receipt = await writePrivateSnapshot(source, 5)
  const intentDir = path.join(retained.dir, 'private-render', 'intents', receipt.intent_id)
  const manifestPath = path.join(intentDir, 'manifest.json')
  await fs.rename(manifestPath, path.join(intentDir, 'manifest.regular-retained'))
  await createRetainedFifo(manifestPath)

  await assertRejectsWithoutBlockingOnFifo(
    queue.commitFinalRenderRemoteWaitReceipt(source, receipt),
    manifestPath,
    'canonical manifest FIFO',
  )
  assert.equal(Object.hasOwn(JSON.parse(await fs.readFile(
    path.join(retained.dir, 'projects', slug, 'jobs.json'), 'utf8',
  )).jobs[0], 'final_render_remote_wait'), false)
  assert.equal((await fs.lstat(manifestPath)).isFIFO(), true)
})

test('concurrent different initial identities accept one lineage and never publish the losing proposal', async () => {
  const slug = `race-${process.pid}`
  const source = job(slug, 'intent-race')
  const jobsPath = await writeCanonicalJob(source)
  const left = await writePrivateSnapshot(source, 10)
  const right = await writePrivateSnapshot(source, 11)
  const outcomes = await Promise.allSettled([
    queue.commitFinalRenderRemoteWaitReceipt(source, left),
    queue.commitFinalRenderRemoteWaitReceipt(source, right),
  ])
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(outcomes.filter(result => result.status === 'rejected').length, 1)
  const disk = JSON.parse(await fs.readFile(jobsPath, 'utf8')).jobs[0]
  assert.ok([left.intent_id, right.intent_id].includes(disk.final_render_remote_wait.intent_id))
  const loser = disk.final_render_remote_wait.intent_id === left.intent_id ? right : left
  assert.notEqual(disk.final_render_remote_wait.intent_id, loser.intent_id)
  await assert.rejects(queue.commitFinalRenderRemoteWaitReceipt(source, loser), /different|lineage|pending/i)
})

test('dirty initial/readback and revision-two failures retain original data, recovery hold, and unrelated writes', async t => {
  const slug = `dirty-${process.pid}`
  const source = job(slug, 'intent-dirty')
  const unrelated = { ...job(slug, 'intent-unrelated'), type: 'audio_merge' as const }
  const projectDir = path.join(retained.dir, 'projects', slug)
  await fs.mkdir(projectDir, { recursive: true, mode: 0o700 })
  const jobsPath = path.join(projectDir, 'jobs.json')
  await fs.writeFile(jobsPath, JSON.stringify({ jobs: [source, unrelated] }))
  queue._forgetProjectPersistenceForTesting(slug)
  const receipt = await writePrivateSnapshot(source, 20)
  let failPersist = true
  const restore = queue._setJobFileLockProbeForTesting(operation => {
    if (operation === 'persist' && failPersist) { failPersist = false; throw new Error('controlled initial write failure') }
  })
  t.after(restore)
  await assert.rejects(queue.commitFinalRenderRemoteWaitReceipt(source, receipt), /controlled initial write failure/)
  assert.equal(queue._hasFinalRenderRecoveryHoldForTesting(source.job_id), true)
  restore()

  await queue.mutateAuthoritativeJob(slug, unrelated.job_id, current => ({
    ...current, output_lines: [...current.output_lines, 'unrelated persisted'],
  }))
  await queue._waitForJobPersistenceForTesting()
  let disk = JSON.parse(await fs.readFile(jobsPath, 'utf8')).jobs
  assert.deepEqual(disk.find((candidate: Job) => candidate.job_id === source.job_id).final_render_remote_wait, receipt)
  assert.deepEqual(disk.find((candidate: Job) => candidate.job_id === unrelated.job_id).output_lines, ['unrelated persisted'])
  await queue.commitFinalRenderRemoteWaitReceipt(source, receipt)

  let failCancellationPersist = true
  const restoreReadback = queue._setJobFileLockProbeForTesting(operation => {
    if (operation === 'persist' && failCancellationPersist) {
      failCancellationPersist = false
      throw new Error('controlled cancellation write failure')
    }
  })
  t.after(restoreReadback)
  await assert.rejects(queue.requestFinalRenderRemoteWaitCancellation(slug, source.job_id), /controlled cancellation write failure/)
  assert.equal(queue._hasFinalRenderRecoveryHoldForTesting(source.job_id), true)
  restoreReadback()
  const recovered = await queue.requestFinalRenderRemoteWaitCancellation(slug, source.job_id)
  disk = JSON.parse(await fs.readFile(jobsPath, 'utf8')).jobs
  assert.deepEqual(disk.find((candidate: Job) => candidate.job_id === source.job_id).final_render_remote_wait, recovered.final_render_remote_wait)
})

test('missing private snapshot and malformed or unknown marker presence fence restart, controls, retry, removal, and restore retention', async () => {
  const slug = `missing-${process.pid}`
  const id = 'intent-missing-private'
  const missing = job(slug, id, {
    version: 2, phase: 'intent_staged', revision: 1, job_id: id,
    intent_id: intentId(99), story_instance_id: STORY_ID, story_attempt: 1,
    gateway_attempt_key: attemptId(99), packet_sha256: HASH, staging_manifest_sha256: HASH,
    submission_scope_sha256: HASH, destination_fence_sha256: HASH,
    source_generation_fence_sha256: HASH, committed_at: COMMITTED_AT, cancel_requested_at: null,
  })
  missing.status = 'error'
  const projectDir = path.join(retained.dir, 'projects', slug)
  await fs.mkdir(projectDir, { recursive: true, mode: 0o700 })
  const presentNull = { ...job(slug, 'intent-present-null', null), status: 'done' as const }
  const unknown = { ...job(slug, 'intent-unknown', { version: 99, future: true }), status: 'cancelled' as const }
  await fs.writeFile(path.join(projectDir, 'jobs.json'), JSON.stringify({ jobs: [missing, presentNull, unknown] }))
  queue._forgetProjectPersistenceForTesting(slug)
  const restored = await queue.getJobs(slug)
  for (const current of restored) {
    assert.equal(current.final_render_wait?.state, 'recovery_hold')
    assert.ok(current.controls)
    assert.deepEqual(current.controls.map(control => [control.action, control.enabled]), [['return-later', false]])
    assert.equal(resolveJobAutoRetryPolicy(queue.getJob(current.job_id)!).eligible, false)
  }
  assert.throws(() => queue.retryTerminalJob(slug, id), /remote/i)
  assert.equal(queue.removeTerminalJob(slug, id), false)
  assert.equal(await queue.clearFinished(slug), 0)
  await assert.rejects(queue.forceAbandonJob(slug, id), /remote/i)
  await assert.rejects(assertProjectJobsSafeToRemove(projectDir), { statusCode: 409 })
  assert.equal((await queue.runningJobsThatWouldNotResume()).some(current => current.job_id === id), true)

  const backupSource = readFileSync(path.join(SERVER_ROOT, 'services/backup.ts'), 'utf8')
  assert.match(backupSource, /hasFinalRenderRemoteWaitMarker\(j\)/,
    'backup restore retains marker presence without opening private manifests or dropping unknown versions')
})

test('missing or corrupt v2 snapshots remain recovery-held through first and replayed cancellation', async () => {
  for (const [index, damage] of ['missing', 'corrupt'].entries()) {
    const slug = `cancel-hold-${damage}-${process.pid}`
    const source = job(slug, `intent-cancel-hold-${damage}`)
    const receipt = await writePrivateSnapshot(source, 110 + index)
    const intentDir = path.join(retained.dir, 'private-render', 'intents', receipt.intent_id)
    const manifestPath = path.join(intentDir, 'manifest.json')
    if (damage === 'missing') {
      await fs.rename(manifestPath, path.join(intentDir, 'manifest.missing-retained'))
    } else {
      await fs.rename(manifestPath, path.join(intentDir, 'manifest.valid-retained'))
      await fs.writeFile(manifestPath, 'corrupt retained manifest\n', { flag: 'wx', mode: 0o600 })
    }
    await writeCanonicalJob({ ...source, status: 'error', final_render_remote_wait: receipt })

    const [loaded] = await queue.getJobs(slug)
    assert.equal(loaded?.final_render_wait?.state, 'recovery_hold', damage)
    const first = await queue.requestFinalRenderRemoteWaitCancellation(slug, source.job_id)
    assert.equal(queue.getPublicJob(source.job_id)?.final_render_wait?.state, 'recovery_hold', `${damage} first cancel`)
    const replay = await queue.requestFinalRenderRemoteWaitCancellation(slug, source.job_id)
    assert.equal(queue.getPublicJob(source.job_id)?.final_render_wait?.state, 'recovery_hold', `${damage} replayed cancel`)
    assert.equal(first.final_render_remote_wait?.intent_id, receipt.intent_id)
    assert.equal(replay.final_render_remote_wait?.intent_id, receipt.intent_id)
    assert.equal(replay.final_render_remote_wait?.gateway_attempt_key, receipt.gateway_attempt_key)
    assert.equal(replay.final_render_remote_wait?.cancel_requested_at, first.final_render_remote_wait?.cancel_requested_at)
    assert.equal(replay.final_render_remote_wait?.revision, 2)
  }
})

test('wait and void executor outcomes both remain logically running, physically idle, and release the Mini lane once', async t => {
  const slug = `executor-${process.pid}`
  await fs.mkdir(path.join(retained.dir, 'projects', slug), { recursive: true, mode: 0o700 })
  const calls: string[] = []
  const releases = new Map<string, number>()
  const stopObserving = queue._observeQueuePumpsForTesting((_type, releasedJobId) => {
    if (releasedJobId) releases.set(releasedJobId, (releases.get(releasedJobId) ?? 0) + 1)
  })
  t.after(stopObserving)
  const restore = queue._setExecutorForTesting('video_assembly', async current => {
    calls.push(current.job_id)
    const receipt = await writePrivateSnapshot(current, 50 + calls.length)
    await queue.commitFinalRenderRemoteWaitReceipt(current, receipt)
    const intentDir = path.join(retained.dir, 'private-render', 'intents', receipt.intent_id)
    const manifestPath = path.join(intentDir, 'manifest.json')
    if (calls.length === 1) {
      await fs.rename(manifestPath, path.join(intentDir, 'manifest.missing-after-commit'))
    } else {
      await fs.rename(manifestPath, path.join(intentDir, 'manifest.valid-after-commit'))
      await fs.writeFile(manifestPath, 'corrupt after commit\n', { flag: 'wx', mode: 0o600 })
    }
    return calls.length === 1 ? { kind: 'video-assembly-remote-wait' } : undefined
  })
  t.after(restore)
  const first = queue.enqueuePreparedForTest({
    project_slug: slug, episode_id: 'EP1', type: 'video_assembly', title: 'Explicit wait', params: {},
  })
  const second = queue.enqueuePreparedForTest({
    project_slug: slug, episode_id: 'EP2', type: 'video_assembly', title: 'Implicit fenced wait', params: {},
  })
  trackedJobIds.add(first.job_id)
  trackedJobIds.add(second.job_id)
  await waitFor(() => calls.length === 2, 'both executor outcomes')
  await waitFor(() => !queue._isJobWorkerActiveForTesting(first.job_id)
    && !queue._isJobWorkerActiveForTesting(second.job_id), 'Mini lane release')
  restore()
  await queue._waitForJobPersistenceForTesting()

  assert.deepEqual(calls, [first.job_id, second.job_id])
  for (const current of [first, second]) {
    assert.equal(queue.getJob(current.job_id)?.status, 'running')
    assert.equal(queue.getPublicJob(current.job_id)?.final_render_wait?.state, 'recovery_hold')
    assert.equal(queue._hasFinalRenderRecoveryHoldForTesting(current.job_id), true)
    assert.equal(releases.get(current.job_id), 1)
  }
  assert.equal((await queue.getJobs(slug)).length, 2, 'a held pipeline head must not chain a new job')
})

function namedFunction(source: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const found = source.statements.find(statement => ts.isFunctionDeclaration(statement)
    && statement.name?.text === name) as ts.FunctionDeclaration | undefined
  assert.ok(found?.body, `${name} must exist`)
  return found
}

function enclosingStatement(node: ts.Node): ts.Statement {
  let current = node
  while (current.parent && !ts.isStatement(current)) current = current.parent
  assert.ok(ts.isStatement(current))
  return current
}

function descendants<T extends ts.Node>(root: ts.Node, matches: (node: ts.Node) => node is T): T[] {
  const found: T[] = []
  const visit = (node: ts.Node): void => {
    if (matches(node)) found.push(node)
    ts.forEachChild(node, visit)
  }
  visit(root)
  return found
}

function referencesIdentifier(root: ts.Node, name: string): boolean {
  return descendants(root, ts.isIdentifier).some(identifier => identifier.text === name)
}

function calledName(invocation: ts.CallExpression): string | null {
  if (ts.isIdentifier(invocation.expression)) return invocation.expression.text
  if (ts.isPropertyAccessExpression(invocation.expression)) return invocation.expression.name.text
  return null
}

function nearestTry(node: ts.Node): ts.TryStatement | null {
  let current: ts.Node | undefined = node.parent
  while (current && !ts.isTryStatement(current)) current = current.parent
  return current && ts.isTryStatement(current) ? current : null
}

function assertDispositionReturnType(fn: ts.FunctionDeclaration, source: ts.SourceFile): void {
  assert.ok(fn.type, `${fn.name?.text} must declare its disposition`)
  let disposition: ts.TypeNode = fn.type
  if (ts.isTypeReferenceNode(disposition)
    && ts.isIdentifier(disposition.typeName)
    && disposition.typeName.text === 'Promise'
    && disposition.typeArguments?.length === 1) disposition = disposition.typeArguments[0]!
  if (ts.isTypeReferenceNode(disposition) && ts.isIdentifier(disposition.typeName)) {
    const alias = source.statements.find(statement => ts.isTypeAliasDeclaration(statement)
      && statement.name.text === disposition.getText(source))
    assert.ok(alias && ts.isTypeAliasDeclaration(alias), `${fn.name?.text} disposition alias must exist`)
    disposition = alias.type
  }
  assert.ok(descendants(disposition, (node): node is ts.KeywordTypeNode => node.kind === ts.SyntaxKind.VoidKeyword).length > 0)
  assert.ok(descendants(disposition, ts.isLiteralTypeNode).some(node => (
    ts.isStringLiteral(node.literal) && node.literal.text === 'video-assembly-remote-wait'
  )))
}

test('both real composition callers return the staged disposition before success, promotion, or cleanup', () => {
  const videoText = readFileSync(path.join(SERVER_ROOT, 'generators/video.ts'), 'utf8')
  const source = ts.createSourceFile('generators/video.ts', videoText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const generate = namedFunction(source, 'generateVideo')
  const calls: ts.CallExpression[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && node.expression.text === 'runFinalComposition') calls.push(node)
    ts.forEachChild(node, visit)
  }
  visit(generate.body!)
  assert.equal(calls.length, 2, 'compilation and standard are the only actual composition callers')

  const heldFlags: string[] = []
  for (const [label, call] of [
    ['compilation', calls[0]!],
    ['standard', calls[1]!],
  ] as const) {
    const statement = enclosingStatement(call)
    assert.ok(ts.isVariableStatement(statement), `${label} must capture the disposition`)
    const declaration = statement.declarationList.declarations.find(candidate => candidate.initializer
      && descendants(candidate.initializer, ts.isCallExpression).includes(call))
    assert.ok(declaration && ts.isIdentifier(declaration.name), `${label} disposition must have a local identity`)
    const dispositionName = declaration.name.text
    const block = statement.parent
    assert.ok(ts.isBlock(block), `${label} call must stay in its try block`)
    const index = block.statements.indexOf(statement)
    const guard = block.statements[index + 1]
    assert.ok(guard && ts.isIfStatement(guard), `${label} must inspect the result immediately`)
    assert.ok(descendants(guard.expression, ts.isPropertyAccessExpression).some(access => (
      ts.isIdentifier(access.expression)
      && access.expression.text === dispositionName
      && access.name.text === 'kind'
    )), `${label} guard reads the captured disposition kind`)
    assert.ok(descendants(guard.expression, ts.isStringLiteral).some(literal => literal.text === 'video-assembly-remote-wait'))
    assert.ok(descendants(guard.thenStatement, ts.isReturnStatement).some(returned => (
      returned.expression && ts.isIdentifier(returned.expression) && returned.expression.text === dispositionName
    )), `${label} returns the captured disposition`)

    const flagAssignments = descendants(guard.thenStatement, ts.isBinaryExpression).filter(expression => (
      expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isIdentifier(expression.left)
      && expression.right.kind === ts.SyntaxKind.TrueKeyword
    ))
    assert.equal(flagAssignments.length, 1, `${label} marks one retained-evidence flag`)
    const heldFlag = (flagAssignments[0]!.left as ts.Identifier).text
    heldFlags.push(heldFlag)
    assert.ok(descendants(generate, ts.isVariableDeclaration).some(candidate => (
      ts.isIdentifier(candidate.name)
      && candidate.name.text === heldFlag
      && candidate.initializer?.kind === ts.SyntaxKind.FalseKeyword
    )), `${label} retained-evidence flag starts false`)

    const tail = block.statements.slice(index + 2)
    assert.ok(tail.some(item => descendants(item, ts.isBinaryExpression).some(expression => (
      expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isIdentifier(expression.left)
      && expression.left.text !== heldFlag
      && expression.right.kind === ts.SyntaxKind.TrueKeyword
    ))), `${label} local success is recorded only after the early return`)
    assert.equal(descendants(guard.thenStatement, ts.isCallExpression).some(invocation => (
      ['rm', 'rename'].includes(calledName(invocation) ?? '')
    )), false, `${label} wait guard performs no cleanup or promotion`)

    const ownerTry = nearestTry(statement)
    assert.ok(ownerTry?.finallyBlock, `${label} cleanup remains explicit`)
    assert.ok(descendants(ownerTry.finallyBlock, ts.isIfStatement).some(cleanup => (
      referencesIdentifier(cleanup.expression, heldFlag)
      && descendants(cleanup.thenStatement, ts.isCallExpression).some(invocation => (
        calledName(invocation) === 'rm'
      ))
    )), `${label} partial-output cleanup is gated by the retained-evidence flag`)
  }

  assert.equal(new Set(heldFlags).size, 1, 'both callers preserve the same outer work tree')
  const heldFlag = heldFlags[0]!
  assertDispositionReturnType(namedFunction(source, 'runFinalComposition'), source)
  assertDispositionReturnType(generate, source)
  assert.ok(descendants(generate, ts.isVariableDeclaration).some(declaration => (
    declaration.initializer
    && referencesIdentifier(declaration.initializer, heldFlag)
    && referencesIdentifier(declaration.initializer, 'debugMode')
    && referencesIdentifier(declaration.initializer, 'succeeded')
  )), 'outer work retention includes debug, failure, and the staged disposition')
  const stringFragments = descendants(generate, (node): node is ts.LiteralLikeNode => (
    ts.isStringLiteral(node)
    || ts.isNoSubstitutionTemplateLiteral(node)
    || node.kind === ts.SyntaxKind.TemplateHead
    || node.kind === ts.SyntaxKind.TemplateMiddle
    || node.kind === ts.SyntaxKind.TemplateTail
  )).map(literal => literal.text)
  assert.ok(stringFragments.some(text => /remote intent staged/i.test(text) && /preserv/i.test(text)),
    'retained work is reported as staged rather than failed or complete')

  const executors = readFileSync(path.join(SERVER_ROOT, 'boot/executors.ts'), 'utf8')
  const executorSource = ts.createSourceFile('boot/executors.ts', executors, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const guardMediaDeclaration = descendants(executorSource, ts.isVariableDeclaration).find(declaration => (
    ts.isIdentifier(declaration.name)
    && declaration.name.text === 'guardMedia'
    && declaration.initializer
    && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))
  ))
  assert.ok(guardMediaDeclaration?.initializer && (ts.isArrowFunction(guardMediaDeclaration.initializer)
    || ts.isFunctionExpression(guardMediaDeclaration.initializer)))
  const guardMedia = guardMediaDeclaration.initializer
  assert.ok(descendants(guardMedia, ts.isReturnStatement).some(statement => {
    let expression = statement.expression
    while (expression && (ts.isAsExpression(expression) || ts.isParenthesizedExpression(expression))) {
      expression = expression.expression
    }
    if (!expression || !ts.isAwaitExpression(expression)) return false
    const awaited = expression.expression
    return ts.isCallExpression(awaited)
      && ts.isIdentifier(awaited.expression)
      && awaited.expression.text === 'fn'
      && awaited.arguments.length === 1
      && ts.isIdentifier(awaited.arguments[0])
      && awaited.arguments[0].text === 'job'
  }), 'guardMedia already propagates the generator disposition')
})
