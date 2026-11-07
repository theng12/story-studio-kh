/**
 * Successful-run fixture reclamation — the one place a green run may delete.
 *
 * A settled successful run (children closed, evidence reconciled, exit 0)
 * releases its bulky sandbox/snapshots and keeps only the small report bytes
 * the lane return and the gate read. Every other outcome — a refusal, a throw,
 * a nonzero exit — retains every byte, and STORY_STUDIO_RETAIN_SUCCESSFUL_
 * FIXTURES=1 opts a successful run back into full retention for debugging.
 *
 * Proven against the real runner, never by reading its source.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { RETAIN_SUCCESSFUL_ENV } from '../../testing/run-backend-tests.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const RUNNER = path.join(ROOT, 'scripts', 'testing', 'run-backend-tests.mjs')

function runnerEnv(extra = {}) {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  delete env.NODE_OPTIONS
  delete env.STORY_STUDIO_TEST_HARNESS_ROOT
  delete env.STORY_STUDIO_RETAINED_SNAPSHOT_ROOT
  delete env[RETAIN_SUCCESSFUL_ENV]
  return { ...env, ...extra }
}

async function runHarness(args, extra = {}) {
  const child = spawn(process.execPath, [RUNNER, ...args], {
    cwd: ROOT,
    env: runnerEnv(extra),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', code => resolve(code ?? 1))
  })
  return { exitCode, stdout, stderr }
}

// Outside the checkout, beside it — the retained-root override refuses any
// path inside the repository.
async function retainedRoot() {
  const base = path.join(path.resolve(ROOT, '..'), '.test-work', path.basename(path.resolve(ROOT)), 'reclamation')
  await fs.mkdir(base, { recursive: true })
  return fs.realpath(await fs.mkdtemp(path.join(base, 'retained-')))
}

function archivedFrom(stdout) {
  const match = stdout.match(/\[test-harness\] retained sandbox: (.+)/)
  assert.ok(match, `the runner must report its retained sandbox:\n${stdout}`)
  return match[1].trim()
}

async function assertNoBulk(archived) {
  const bulky = (await fs.readdir(archived)).filter(name => /^sandbox(-|$)|^snapshots(-|$)/.test(name))
  assert.deepEqual(bulky, [], `bulk evidence must be released from ${archived}`)
}

async function assertFullRetention(archived) {
  assert.equal(
    await fs.readFile(
      path.join(archived, 'sandbox', 'configured-projects', 'owner-sentinel', 'owner-marker.txt'),
      'utf8',
    ),
    'must remain byte-identical\n',
    'every byte of a non-success fixture must be retained',
  )
  assert.equal((await fs.stat(path.join(archived, 'snapshots'))).isDirectory(), true)
}

for (const retainSuccessful of [undefined, '0']) {
  test(`a settled successful run releases bulk and keeps coverage (opt-in=${retainSuccessful ?? 'unset'})`, async () => {
    const root = await retainedRoot()
    const { exitCode, stdout, stderr } = await runHarness(['--probe'], {
      STORY_STUDIO_RETAINED_FIXTURES_ROOT: root,
      ...(retainSuccessful === undefined ? {} : { [RETAIN_SUCCESSFUL_ENV]: retainSuccessful }),
    })
    assert.equal(exitCode, 0, stderr || stdout)
    const archived = archivedFrom(stdout)
    assert.ok(archived.startsWith(root + path.sep), archived)
    await assertNoBulk(archived)
    const reports = (await fs.readdir(archived)).filter(name => /^suite-coverage.*\.jsonl$/.test(name))
    assert.ok(reports.length > 0, 'the coverage report the gate reads must survive reclamation')
    const coverage = await fs.readFile(path.join(archived, reports[0]), 'utf8')
    assert.ok(coverage.length > 0 && coverage.endsWith('\n'), 'coverage bytes must be complete')
  })
}

test('a refused run retains every byte of its fixture', async () => {
  const root = await retainedRoot()
  // Matching nothing fails before any test runs — a refusal with no throw.
  const { exitCode, stdout, stderr } = await runHarness(['--only', 'no-such-test-file-anywhere'], {
    STORY_STUDIO_RETAINED_FIXTURES_ROOT: root,
  })
  assert.notEqual(exitCode, 0, stderr || stdout)
  await assertFullRetention(archivedFrom(stdout))
})

test('a thrown setup failure is never mistaken for a success', async () => {
  const root = await retainedRoot()
  const { exitCode, stdout, stderr } = await runHarness(['--probe', '--fail-after-setup'], {
    STORY_STUDIO_RETAINED_FIXTURES_ROOT: root,
  })
  assert.notEqual(exitCode, 0)
  assert.match(stderr + stdout, /intentional backend test harness setup failure/)
  await assertFullRetention(archivedFrom(stdout))
})

test('retaining a successful fixture is a deliberate env opt-in', async () => {
  const root = await retainedRoot()
  const { exitCode, stdout, stderr } = await runHarness(['--probe'], {
    STORY_STUDIO_RETAINED_FIXTURES_ROOT: root,
    [RETAIN_SUCCESSFUL_ENV]: '1',
  })
  assert.equal(exitCode, 0, stderr || stdout)
  await assertFullRetention(archivedFrom(stdout))
})
