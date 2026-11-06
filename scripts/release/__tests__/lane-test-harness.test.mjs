/**
 * The completeness floor for the release, content-packs and frontend lanes.
 *
 * The backend lane's floor is covered by `backend-test-harness.test.mjs`.
 * These three lanes had no floor at all until 2026-08-28: they were bare
 * `node --test` / `tsx --test` invocations whose only evidence was their own
 * summary block — the exact artifact that reported `fail 0 / skipped 0 /
 * exit 0` while discarding whole files' worth of results.
 *
 * Every claim below is proven by running the real wrapper against a real
 * fixture, never by reading its source and hoping. A floor that has never been
 * shown catching a truncation is a claim, not evidence.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { retainSandbox } from '../../testing/run-backend-tests.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const WRAPPER = path.join(ROOT, 'scripts', 'testing', 'run-lane-tests.mjs')

/**
 * Env for a runner spawned from INSIDE a test file. Node refuses to recurse
 * ("skipping running files") when it sees its own marker, and an outer run's
 * NODE_OPTIONS are not this run's.
 *
 * Nested runners establish their own sandbox; never preload against the outer one.
 */
function nestedRunnerEnv() {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  delete env.NODE_OPTIONS
  delete env.STORY_STUDIO_TEST_HARNESS_ROOT
  delete env.STORY_STUDIO_RETAINED_SNAPSHOT_ROOT
  return env
}

/**
 * Run the REAL wrapper over a fixture directory, by importing `runLane` and
 * handing it a lane whose discovery directory is the fixture.
 *
 * Spawned rather than called in-process so the wrapper's stdout and its exit
 * code are observed the way the gate observes them — the banner and the status
 * are the two things under test, and neither is visible from a direct call.
 */
const POLL_MS = 20
const DEADLINE_MS = 20_000

async function waitFor(condition, label) {
  const deadline = Date.now() + DEADLINE_MS
  for (;;) {
    const value = await condition()
    if (value) return value
    assert.ok(Date.now() < deadline, `timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, POLL_MS))
  }
}

async function runFixtureLane(dir, env = {}, duringRun) {
  const source = `
    import { runLane } from ${JSON.stringify(WRAPPER)}
    process.exitCode = await runLane('fixture', {
      dir: ${JSON.stringify(dir)},
      suffix: '.test.mjs',
      cwd: ${JSON.stringify(dir)},
      runner: 'node',
      args: [],
    })
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    cwd: ROOT,
    env: { ...nestedRunnerEnv(), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })
  let out = ''
  let closed = false
  let childError
  const completion = new Promise(resolve => {
    child.once('error', error => { childError = error })
    child.once('close', code => { closed = true; resolve(code ?? 1) })
  })
  child.stdout.setEncoding('utf8').on('data', chunk => { out += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { out += chunk })
  try {
    if (duringRun) await duringRun({ output: () => out, closed: () => closed })
    await waitFor(() => closed, `fixture lane completion; output:\n${out}`)
    const exitCode = await completion
    if (childError) throw childError
    return { exitCode, out }
  } finally {
    if (!closed) {
      if (process.platform !== 'win32' && child.pid) {
        try { process.kill(-child.pid, 'SIGKILL') } catch (error) {
          if (error?.code !== 'ESRCH') throw error
        }
      } else child.kill('SIGKILL')
    }
  }
}

/**
 * realpath: on macOS os.tmpdir() is /var/..., a symlink to /private/var/...,
 * and node's reporter names files by the resolved path. The wrapper resolves
 * both sides for exactly this reason, and the fixture must not accidentally
 * be the thing that proves it.
 */
async function fixtureDir(prefix) {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)))
}


// Outside the checkout, but in ONE enclosing folder beside it (`../.test-work/<checkout>/`, the
// content-packs lane's convention) — never loose in the parent folder, where every run left a new
// directory beside the owner's projects.
async function outsideRepoWorkDir() {
  const dir = path.join(path.resolve(ROOT, '..'), '.test-work', path.basename(path.resolve(ROOT)), 'release-lane')
  await fs.mkdir(dir, { recursive: true })
  return dir
}

test('a whole lane reports one completed file per discovered file', async () => {
  const dir = await fixtureDir('lane-coverage-whole-')
  try {
    await fs.writeFile(path.join(dir, 'alpha.test.mjs'),
      'import { test, describe } from "node:test"\n'
      + 'describe("alpha", () => { test("a1", () => {}); test("a2", () => {}) })\n')
    await fs.writeFile(path.join(dir, 'beta.test.mjs'),
      'import { test, describe } from "node:test"\n'
      + 'describe("beta", () => { test("b1", () => {}) })\n')

    const { exitCode, out } = await runFixtureLane(dir)

    assert.equal(exitCode, 0, out)
    // The accept line. Derived from the discovery list, never a constant.
    assert.match(out, /fixture suite coverage: 2\/2 file\(s\) completed/,
      'the healthy case must state the floor was met, in the same shape the backend lane prints')
    assert.match(out, /3 test\(s\) \+ 2 suite\(s\) = 5 marks/)
    assert.doesNotMatch(out, /BELOW FLOOR/, 'a healthy lane must not fire the banner')
  } finally {
    await retainSandbox(dir, undefined, 'lane-contract')
  }
})

test('a failing file still counts as completed coverage, and the lane still fails', async () => {
  // A failing test is the summary's business. The file ran to completion and
  // emitted its own file-scoped summary, so the floor must count it — and the
  // run must still fail loudly rather than reporting a covered, green lane.
  const dir = await fixtureDir('lane-coverage-failing-')
  try {
    await fs.writeFile(path.join(dir, 'passing.test.mjs'),
      'import { test } from "node:test"\n'
      + 'test("p1", () => {})\n')
    await fs.writeFile(path.join(dir, 'failing.test.mjs'),
      'import { test } from "node:test"\n'
      + 'import assert from "node:assert/strict"\n'
      + 'test("f1", () => {})\n'
      + 'test("f2", () => { assert.equal(1, 2) })\n')

    const { exitCode, out } = await runFixtureLane(dir)

    assert.notEqual(exitCode, 0, `a failing test must fail the lane:\n${out}`)
    assert.match(out, /fixture suite coverage: 2\/2 file\(s\) completed/,
      'the failing file finished, so coverage must count it')
    assert.doesNotMatch(out, /BELOW FLOOR/, 'a completed file is not a missing file')
    assert.match(out, /1 of 3 test\(s\) failed/, 'the summary must still report the failure')
  } finally {
    await retainSandbox(dir, undefined, 'lane-contract')
  }
})

test('a file that dies mid-run fails the lane, however green node reports it', async () => {
  // `process.exit(0)` inside a test is the smallest form of every way a file
  // ends early. Node reports the FILE as passing and counts none of its tests,
  // so the summary shrinks and still adds up — which is why the summary block
  // cannot be the evidence, and why this lane needed a floor of its own.
  const dir = await fixtureDir('lane-coverage-truncated-')
  try {
    await fs.writeFile(path.join(dir, 'whole.test.mjs'),
      'import { test, describe } from "node:test"\n'
      + 'describe("alpha", () => { test("a1", () => {}) })\n')
    await fs.writeFile(path.join(dir, 'truncated.test.mjs'),
      'import { test, describe } from "node:test"\n'
      + 'describe("beta", () => { test("b1", () => { process.exit(0) }) })\n'
      + 'describe("gamma", () => { test("g1", () => {}) })\n')

    const { exitCode, out } = await runFixtureLane(dir)

    // The floor sees what the summary cannot, and says so unmistakably.
    assert.notEqual(exitCode, 0, `a truncated run must not pass:\n${out}`)
    assert.match(out, /FIXTURE SUITE COVERAGE BELOW FLOOR/,
      'the failure must be impossible to scroll past')
    assert.match(out, /fixture suite coverage: 1\/2 file\(s\) completed/)
    assert.match(out, /✗ truncated\.test\.mjs/, 'the vanished file must be named')
    assert.match(out, /A file that never finished cannot have passed/)
  } finally {
    await retainSandbox(dir, undefined, 'lane-contract')
  }
})

test('a lane that discovers nothing is a failure, never an empty pass', async () => {
  // An empty directory produces the most convincing green light there is.
  const dir = await fixtureDir('lane-coverage-empty-')
  try {
    const { exitCode, out } = await runFixtureLane(dir)
    assert.notEqual(exitCode, 0, out)
    assert.match(out, /discovered no \.test\.mjs files/)
    assert.match(out, /Nothing ran, so this is a failure/)
  } finally {
    await retainSandbox(dir, undefined, 'lane-contract')
  }
})

test('no lane is ever run with --test-force-exit', async () => {
  // The flag is inherited by every child test process. Node runs each file in
  // its own child reporting back over a stdout PIPE, and on macOS a pipe write
  // is asynchronous — so a child that exits while its results are still queued
  // DISCARDS them. Those tests are not failed and not cancelled; they never
  // existed. This is what put three-quarters of the gate at risk.
  const body = await fs.readFile(WRAPPER, 'utf8')
  const code = body.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
  assert.doesNotMatch(code, /--test-force-exit/)
})

test('the floor of every real lane is that lane\'s own discovery list', async () => {
  const { LANES } = await import(WRAPPER)
  assert.deepEqual(Object.keys(LANES).sort(), ['content-packs', 'frontend', 'release'])

  for (const [name, lane] of Object.entries(LANES)) {
    const dir = path.resolve(ROOT, lane.dir)
    const found = (await fs.readdir(dir)).filter(entry => entry.endsWith(lane.suffix))
    // A renamed or moved directory would otherwise discover zero files and
    // silently lower the floor to nothing. The wrapper fails that case at
    // runtime; this fails it at review time.
    assert.ok(found.length > 0, `the ${name} lane discovered no ${lane.suffix} files in ${lane.dir}`)
  }

  // No expected total anywhere: adding a test file must raise the floor by
  // itself, with nothing to bump by hand.
  const body = await fs.readFile(WRAPPER, 'utf8')
  const code = body.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
  assert.doesNotMatch(code, /\b\d{2,}\s*(?:tests|suites|files)\b/i)
})

test('every gate lane runs through a wrapper that proves its own completeness', async () => {
  // Reverting a lane to a bare `node --test` would remove its floor without
  // removing anything that looks like a test, so the wiring is asserted.
  const manifest = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'))
  const gate = manifest.scripts.test
  for (const lane of ['test:backend', 'test:frontend', 'test:release', 'test:content-packs']) {
    assert.ok(gate.includes(`npm run ${lane}`), `${lane} must be part of the gate`)
    assert.match(manifest.scripts[lane], /run-(backend|lane)-tests\.mjs/,
      `${lane} must run through a wrapper that reconciles completed files against discovered files`)
  }
})

test('the lane keeps its retained evidence in the override root, not the shared Trash', async () => {
  // The same override the backend runner honours. The main checkout reaches
  // `_trash` through a symlink into a directory every checkout shares, so a
  // retained sandbox kept there is at the mercy of that shared directory.
  // The lane's evidence must land where the operator named instead. The
  // fixture is retained, not cleaned up.
  // Use a path explicitly outside the repo, not os.tmpdir() which may resolve
  // inside the worktree on some platforms.
  const override = await fs.realpath(await fs.mkdtemp(path.join(await outsideRepoWorkDir(), 'lane-retained-root-')))
  const dir = await fixtureDir('lane-retained-override-')
  await fs.writeFile(path.join(dir, 'alpha.test.mjs'),
    'import { test } from "node:test"\ntest("alpha", () => {})\n')

  const { exitCode, out } = await runFixtureLane(dir, {
    STORY_STUDIO_RETAINED_FIXTURES_ROOT: override,
  })

  assert.equal(exitCode, 0, out)
  const container = out.match(/\[test-harness\] retained fixture sandbox: (.+)/)?.[1]?.trim()
  assert.ok(container, `the wrapper must report where it retained the lane sandbox:\n${out}`)
  assert.ok(container.startsWith(override),
    `the retained container must live under the override root: ${container}`)
})

for (const removeLiveWork of [false, true]) {
  test(removeLiveWork
    ? 'a vanished live work root fails loudly and stops the child'
    : 'emptying finished evidence during a run leaves live work intact', async () => {
    // The container must be OUTSIDE the repository (the retained-root override
    // is refused inside it) and outside `_trash` (a live work root there is
    // refused by construction). The checkout's parent satisfies both, and is
    // already this file's fixture home for the retained-root override.
    const container = await fs.realpath(
      await fs.mkdtemp(path.join(path.resolve(ROOT, '..'), 'lane-work-lifecycle-')),
    )
    const work = path.join(container, 'work')
    const retained = path.join(container, 'retained')
    const dir = path.join(container, 'tests')
    await fs.mkdir(retained)
    await fs.mkdir(dir)
    await fs.writeFile(path.join(retained, 'old-evidence.txt'), 'finished evidence\n')
    // Only reads occur during the handshake, so the fixture does not race a destructive-operation lock.
    await fs.writeFile(path.join(dir, 'handshake.test.mjs'), `
      import assert from 'node:assert/strict'
      import fs from 'node:fs/promises'
      import path from 'node:path'
      import test from 'node:test'
      const POLL_MS = 20
      test('waits for parent action before completing', async () => {
        const sandbox = process.env.STORY_STUDIO_TEST_HARNESS_ROOT
        console.log('WORK_READY=' + sandbox)
        const deadline = Date.now() + 20_000
        for (;;) {
          try { await fs.access(path.join(sandbox, 'resume')); break }
          catch (error) { if (error.code !== 'ENOENT') throw error }
          assert.ok(Date.now() < deadline, 'parent never resumed the fixture')
          await new Promise(resolve => setTimeout(resolve, POLL_MS))
        }
        await fs.writeFile(path.join(sandbox, 'after-parent.txt'), 'completed after parent action')
      })
    `)
    const { exitCode, out } = await runFixtureLane(dir, {
      STORY_STUDIO_TEST_WORK_ROOT: work,
      STORY_STUDIO_RETAINED_FIXTURES_ROOT: retained,
    }, async ({ output, closed }) => {
      const sandbox = await waitFor(() => {
        const match = output().match(/WORK_READY=(.+)/)
        assert.ok(match || !closed(), `fixture exited before readiness:\n${output()}`)
        return match?.[1]?.trim()
      }, 'fixture readiness')
      const realWork = await fs.realpath(work)
      assert.ok(sandbox.startsWith(realWork + path.sep), `sandbox ${sandbox} not under resolved work ${realWork}`)
      assert.doesNotMatch(sandbox, /(?:^|\/)_trash(?:\/|$)/)
      // Rename models removal from the original path without deleting any evidence.
      const source = removeLiveWork ? work : retained
      await fs.rename(source, path.join(container, 'removed-root'))
      if (!removeLiveWork) await fs.writeFile(path.join(sandbox, 'resume'), 'parent finished')
    })
    try {
      if (removeLiveWork) {
        assert.notEqual(exitCode, 0, out)
        assert.match(out, /live test work disappeared or changed; failing the run/)
        assert.doesNotMatch(out, /retained fixture sandbox:/)
      } else {
        assert.equal(exitCode, 0, out)
        const archived = out.match(/retained fixture sandbox: (.+)/)?.[1]?.trim()
        assert.ok(archived?.startsWith(retained + path.sep), out)
        assert.equal(await fs.readFile(path.join(archived, 'sandbox', 'after-parent.txt'), 'utf8'),
          'completed after parent action')
        await assert.rejects(fs.access(path.join(retained, 'old-evidence.txt')), { code: 'ENOENT' })
        const aggregate = out.match(/inputs=(.+)/)?.[1]
        assert.ok(aggregate, out)
        const inputs = JSON.parse(aggregate)
        assert.ok(inputs[0].coveragePath.startsWith(archived + path.sep), aggregate)
        assert.ok((await fs.stat(inputs[0].coveragePath)).isFile(), aggregate)
      }
    } finally {
      await retainSandbox(container, undefined, 'lifecycle-contract')
    }
  })
}

test('a real adapted fixture lane schedules its test files one at a time, and proves it by outcome', async () => {
  // `--test-concurrency=1` on the adapted invocation is the MECHANISM, not the
  // contract. Pinning the argv proved the wrapper passes a flag, not that the
  // lane works — and it went stale the moment a runner's argv could legitimately
  // change. What the lane promises is an OUTCOME: every file in the adapted
  // invocation finishes, each one alone, with no failures and no narrowed run.
  //
  // The proof has three parts, none of them a stopwatch:
  //   1. The ordered marker: the first file's completion marker is on disk before
  //      the second file starts, which is what "one at a time" looks like from the
  //      inside. Written by an awaited async write — no sleep, no clock.
  //   2. The coverage floor: both discovered files report a completed suite.
  //      A file that never ran, or one that died early, fails this.
  //   3. The summary: a positive test count and zero failures, with no PARTIAL
  //      RUN banner. A lane that quietly ran nothing cannot satisfy it.
  const dir = await fixtureDir('lane-serialization-')
  try {
    const marker = path.join(dir, 'sequence.marker')
    await fs.writeFile(path.join(dir, 'a-sequencer.test.mjs'),
      'import { test } from "node:test"\n'
      + 'import assert from "node:assert/strict"\n'
      + 'import fs from "node:fs/promises"\n'
      + `const marker = ${JSON.stringify(marker)}\n`
      + 'test("the first file completes", async () => {\n'
      + '  await fs.writeFile(marker, "a-done")\n'
      + '})\n')
    await fs.writeFile(path.join(dir, 'b-verifier.test.mjs'),
      'import { test } from "node:test"\n'
      + 'import assert from "node:assert/strict"\n'
      + 'import fs from "node:fs/promises"\n'
      + `const marker = ${JSON.stringify(marker)}\n`
      + 'test("the second file starts after the first finished", async () => {\n'
      + '  const content = await fs.readFile(marker, "utf8").catch(() => "")\n'
      + '  assert.equal(content, "a-done",\n'
      + '    "the first file must have finished before the second one started")\n'
      + '})\n')

    const { exitCode, out } = await runFixtureLane(dir)

    assert.equal(exitCode, 0, `serialized run must pass:\n${out}`)
    assert.match(out, /fixture suite coverage: 2\/2 file\(s\) completed/,
      'both files must complete under serialization')
    assert.doesNotMatch(out, /PARTIAL RUN/, 'an unfiltered lane must never look narrowed')
    const fail = out.match(/^[#ℹ]\s+fail\s+(\d+)\s*$/m)
    assert.ok(fail, `the lane must print a raw summary:\n${out}`)
    assert.equal(Number(fail[1]), 0, 'no file may fail')
    const tests = out.match(/^[#ℹ]\s+tests\s+(\d+)\s*$/m)
    assert.ok(tests && Number(tests[1]) >= 2, `both files must contribute tests:\n${out}`)
  } finally {
    await retainSandbox(dir, undefined, 'lane-contract')
  }
})
