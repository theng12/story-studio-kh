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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const WRAPPER = path.join(ROOT, 'scripts', 'testing', 'run-lane-tests.mjs')

/**
 * Env for a runner spawned from INSIDE a test file. Node refuses to recurse
 * ("skipping running files") when it sees its own marker, and an outer run's
 * NODE_OPTIONS are not this run's.
 */
function nestedRunnerEnv() {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  delete env.NODE_OPTIONS
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
async function runFixtureLane(dir) {
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
    env: nestedRunnerEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { out += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { out += chunk })
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => resolve(code ?? 1))
  })
  return { exitCode, out }
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
    await fs.rm(dir, { recursive: true, force: true })
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
    await fs.rm(dir, { recursive: true, force: true })
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
    await fs.rm(dir, { recursive: true, force: true })
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

test('only adapted invocations request serial test files', async () => {
  const body = await fs.readFile(WRAPPER, 'utf8')
  const code = body.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
  assert.match(code, /const concurrencyArgs = addRetainedAdapter \? \['--test-concurrency=1'\] : \[\]/)
  assert.match(code, /'--test',\s*\.\.\.concurrencyArgs/)
})

test('a real adapted fixture lane schedules its test files one at a time', async () => {
  // Two proofs in ONE real invocation, neither of them a stopwatch.
  //
  // 1. The serial contract. Every child of the adapted invocation inherits
  //    `--test-concurrency=1`, so a missing flag fails THIS test every time.
  //    A marker race alone cannot do that: with the flag gone, the two files
  //    still finish in order whenever the scheduler happens not to interleave
  //    them, which is a green light for a broken wrapper.
  // 2. The ordered marker. The first file's completion marker is on disk
  //    before the second file starts, which is what "one at a time" looks
  //    like from the inside. The marker is written by an awaited async write,
  //    so nothing here bets on a duration: no sleep, no clock, no timeout.
  const dir = await fixtureDir('lane-serialization-')
  try {
    const marker = path.join(dir, 'sequence.marker')
    // The contract every child of the adapted invocation must inherit.
    const serialContract = 'function assertSerialContract() {\n'
      + '  const serial = process.execArgv.filter(arg => arg.startsWith("--test-concurrency="))\n'
      + '  assert.deepEqual(serial, ["--test-concurrency=1"],\n'
      + '    "the adapted invocation must hand every child the serial runner contract")\n'
      + '}\n'
    await fs.writeFile(path.join(dir, 'a-sequencer.test.mjs'),
      'import { test } from "node:test"\n'
      + 'import assert from "node:assert/strict"\n'
      + 'import fs from "node:fs/promises"\n'
      + `const marker = ${JSON.stringify(marker)}\n`
      + serialContract
      + 'test("the first file inherits the serial contract, then completes", async () => {\n'
      + '  assertSerialContract()\n'
      + '  await fs.writeFile(marker, "a-done")\n'
      + '})\n')
    await fs.writeFile(path.join(dir, 'b-verifier.test.mjs'),
      'import { test } from "node:test"\n'
      + 'import assert from "node:assert/strict"\n'
      + 'import fs from "node:fs/promises"\n'
      + `const marker = ${JSON.stringify(marker)}\n`
      + serialContract
      + 'test("the second file inherits the serial contract and starts after the first finished", async () => {\n'
      + '  assertSerialContract()\n'
      + '  const content = await fs.readFile(marker, "utf8").catch(() => "")\n'
      + '  assert.equal(content, "a-done",\n'
      + '    "the first file must have finished before the second one started")\n'
      + '})\n')

    const { exitCode, out } = await runFixtureLane(dir)

    assert.equal(exitCode, 0, `serialized run must pass:\n${out}`)
    assert.match(out, /fixture suite coverage: 2\/2 file\(s\) completed/,
      'both files must complete under serialization')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
