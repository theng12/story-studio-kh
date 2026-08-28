import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

async function runHarness(args = ['--probe'], env = process.env) {
  const child = spawn(process.execPath, ['scripts/testing/run-backend-tests.mjs', ...args], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => resolve(code ?? 1))
  })

  return { exitCode, stdout, stderr }
}

/**
 * Env for a `node --test` spawned from INSIDE a test file. Node refuses to
 * recurse ("skipping running files") when it sees its own marker, and the
 * harness deletes the same variable for the same reason.
 */
function nestedRunnerEnv() {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  delete env.NODE_OPTIONS
  return env
}

test('backend test runner is hermetic without an operator-provided environment wrapper', async () => {
  const { exitCode, stdout, stderr } = await runHarness()

  assert.equal(exitCode, 0, stderr || stdout)
  assert.match(stdout, /configured projects root byte-identical: true/)
})

test('backend test runner ignores inherited temp-directory escape routes', async () => {
  const missingUntrustedTemp = path.join(ROOT, `.untrusted-test-temp-${process.pid}-${Date.now()}`)
  try {
    await assert.rejects(fs.access(missingUntrustedTemp), error => error?.code === 'ENOENT')
    const { exitCode, stdout, stderr } = await runHarness(['--probe'], {
      ...process.env,
      TMPDIR: missingUntrustedTemp,
      TMP: missingUntrustedTemp,
      TEMP: missingUntrustedTemp,
    })

    assert.equal(exitCode, 0, stderr || stdout)
    await assert.rejects(fs.access(missingUntrustedTemp), error => error?.code === 'ENOENT')
  } finally {
    await fs.rm(missingUntrustedTemp, { recursive: true, force: true })
  }
})

test('backend test runner removes its sandbox when setup fails', async () => {
  const { exitCode, stdout } = await runHarness(['--probe', '--fail-after-setup'])
  assert.notEqual(exitCode, 0)

  const sandbox = stdout.match(/\[test-harness\] sandbox: (.+)/)?.[1]?.trim()
  assert.ok(sandbox, 'the failing setup probe must report its sandbox')
  await assert.rejects(fs.access(sandbox), error => error?.code === 'ENOENT')
})

/**
 * `--only <substring>` — running part of the suite on purpose.
 *
 * WHY. The backend suite is one indivisible block: any agent or human wanting
 * to check a single file had to run all of it. On 2026-08-26 two full suites
 * competed for the same machine — one was killed at sixty minutes having
 * printed nothing, the other mis-reported eleven failures that were not real.
 * Hours went to that, and none of it was about the code under test.
 *
 * THE TWO GUARD-RAILS, because this is the release gate:
 *
 *   • the DEFAULT MUST NOT MOVE. No `--only` means every file, exactly as
 *     before. A gate that can be narrowed by accident is worse than a slow one.
 *   • a filtered run must be IMPOSSIBLE TO MISTAKE for a full one. Three times
 *     in one day a run reported success without covering what its reader
 *     assumed it had. A quiet filter is that same trap wearing a new face, so
 *     the harness shouts the patterns and the number of files it skipped.
 *
 * And a filter that matches nothing FAILS. Zero tests is not a pass — it is
 * the most convincing green light in the world and it means nothing ran.
 */
test('--only runs just the matching files, and says so unmistakably', async () => {
  const { exitCode, stdout, stderr } = await runHarness(['--only', 'image-episode-concurrency'])

  assert.equal(exitCode, 0, stderr || stdout)
  assert.match(stdout, /PARTIAL RUN/, 'a filtered run must announce itself')
  assert.match(stdout, /image-episode-concurrency/, 'it must name the pattern it filtered on')
  assert.match(stdout, /skipped/i, 'it must say how many files it did not run')
  // The number it skipped has to be the real remainder, not a decoration.
  const skipped = Number(stdout.match(/(\d+) file\(s\) SKIPPED/)?.[1])
  assert.ok(Number.isInteger(skipped) && skipped > 0, `expected a positive skipped count, got ${skipped}`)
  assert.doesNotMatch(stdout, /genstudio-product-handles/, 'a filtered run must not run the rest of the suite')
})

test('no --only still means the whole suite, with no partial-run banner', async () => {
  // The default is the release gate. Proven without paying for a full run:
  // --probe is the harness path that already runs a fixed, tiny file list.
  const { exitCode, stdout, stderr } = await runHarness(['--probe'])

  assert.equal(exitCode, 0, stderr || stdout)
  assert.doesNotMatch(stdout, /PARTIAL RUN/, 'an unfiltered run must never look filtered')
  const body = await fs.readFile(path.join(ROOT, 'scripts', 'testing', 'run-backend-tests.mjs'), 'utf8')
  assert.match(body, /selectOnly\(/, 'the filter must be an explicit opt-in applied to the full list')
})

test('an --only that matches nothing is a failure, not a silent pass', async () => {
  const { exitCode, stdout, stderr } = await runHarness(['--only', 'no-such-test-file-anywhere'])

  assert.notEqual(exitCode, 0, 'zero matched files must fail the run')
  assert.match(stderr + stdout, /matched no backend test files/i)
})

test('a summary reporting zero tests is a failure', async () => {
  const { assertSummaryAgrees } = await import(
    pathToFileURL(path.join(ROOT, 'scripts', 'testing', 'run-backend-tests.mjs')).href
  )
  // The exact shape of a run that started nothing: totals present, all zero.
  const empty = ['# tests 0', '# pass 0', '# fail 0', '# skipped 0', '# todo 0'].join('\n')
  assert.match(String(assertSummaryAgrees(empty, 0)), /no tests ran/i)
  // A real run is still judged exactly as before.
  assert.equal(assertSummaryAgrees(['# tests 3', '# pass 3', '# fail 0'].join('\n'), 0), null)
  assert.match(String(assertSummaryAgrees(['# tests 3', '# pass 2', '# fail 1'].join('\n'), 1)), /1 of 3/)
})

test('a file that never finished fails the run, and is named', async () => {
  const { assertEverySuiteCompleted } = await import(
    pathToFileURL(path.join(ROOT, 'scripts', 'testing', 'run-backend-tests.mjs')).href
  )
  const discovered = ['/s/a.test.ts', '/s/b.test.ts', '/s/c.test.ts']
  const sound = assertEverySuiteCompleted(discovered, [
    { file: '/s/a.test.ts', tests: 4, suites: 1 },
    { file: '/s/b.test.ts', tests: 6, suites: 2 },
    { file: '/s/c.test.ts', tests: 2, suites: 1 },
  ])
  assert.equal(sound.message, null, 'a fully covered run must pass')
  assert.equal(sound.tests + sound.suites, 16, 'the mark inventory is reconciled, not asserted by hand')

  // The false green: b never reported, yet every count that survives is clean.
  const short = assertEverySuiteCompleted(discovered, [
    { file: '/s/a.test.ts', tests: 4, suites: 1 },
    { file: '/s/c.test.ts', tests: 2, suites: 1 },
  ])
  assert.match(String(short.message), /1 of 3 discovered test file\(s\) never reported/i)
  assert.deepEqual(short.missing, ['/s/b.test.ts'], 'the missing file must be named, not just counted')
})

test('no coverage record at all is a failure, never an empty pass', async () => {
  const { assertEverySuiteCompleted } = await import(
    pathToFileURL(path.join(ROOT, 'scripts', 'testing', 'run-backend-tests.mjs')).href
  )
  // A reporter that never wrote is absence of evidence, and absence of
  // evidence is the exact thing this floor exists to refuse.
  const none = assertEverySuiteCompleted(['/s/a.test.ts', '/s/b.test.ts'], null)
  assert.match(String(none.message), /no suite-coverage record at all/i)
  assert.equal(none.missing.length, 2)
})

test('the floor is derived from discovery, so adding a file needs no constant bumped', async () => {
  const body = await fs.readFile(path.join(ROOT, 'scripts', 'testing', 'run-backend-tests.mjs'), 'utf8')
  const floor = body.slice(body.indexOf('export function assertEverySuiteCompleted'))
  assert.doesNotMatch(floor, /\b(3[0-9]{3}|[0-9]{3,}\s*(?:tests|suites|files))\b/,
    'an expected-total constant would have to be bumped by hand, and would rot')
  assert.match(floor, /discoveredFiles\.filter/, 'the expectation must come from the discovered list itself')
})

test('the suite is never run with --test-force-exit', async () => {
  // The flag is inherited by every child test process. Node runs each file in
  // its own child, which reports results back over a stdout PIPE, and on macOS
  // a pipe write is asynchronous — so a child that calls process.exit() while
  // its results are still queued DISCARDS the rest of them. Those tests are
  // not failed and not cancelled; they never existed, and the summary shrinks
  // and still adds up.
  //
  // Measured on this runtime, 3,600 tests across 20 files, under CPU load:
  //   with    the flag: 3538 / 3427 / 3485 tests, fail 0, exit 0
  //   without the flag: 3600 / 3600 / 3600 tests, fail 0, exit 0
  // The losses land on the TAIL of a file — the "six of nine describes" that
  // subtitle-engine.test.ts was blamed for, and the drifting totals.
  const body = await fs.readFile(path.join(ROOT, 'scripts', 'testing', 'run-backend-tests.mjs'), 'utf8')
  const code = body.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
  assert.doesNotMatch(code, /--test-force-exit/,
    'a child that force-exits drops whatever results are still in its pipe')
  // A hang still has to be handled, just loudly: a killed child prints no
  // summary, and assertSummaryAgrees already fails a run with no summary.
  assert.match(code, /startSuiteWatchdog/, 'removing the flag must not remove hang protection')
  assert.match(code, /STORY_STUDIO_BACKEND_TEST_TIMEOUT_MS/,
    'the limit must be data the operator can change, not a constant')
  assert.match(code, /child\.kill\('SIGKILL'\)/)
})

test('failing and skipped files still report a completed suite, so the floor cannot cry wolf', async () => {
  // The floor's value depends entirely on NOT firing for healthy files. A
  // failing file and an all-skipped file are both legitimate, both must be
  // recorded as completed, and neither may be mistaken for a vanished file.
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'suite-coverage-sane-')))
  try {
    await fs.writeFile(path.join(dir, 'failing.test.mjs'),
      'import { test } from "node:test"\ntest("fails", () => { throw new Error("boom") })\n')
    await fs.writeFile(path.join(dir, 'skipped.test.mjs'),
      'import { test } from "node:test"\ntest("skipped", { skip: true }, () => {})\n')
    const records = await runCoverageReporter(dir, ['failing.test.mjs', 'skipped.test.mjs'])
    const { assertEverySuiteCompleted } = await import(
      pathToFileURL(path.join(ROOT, 'scripts', 'testing', 'run-backend-tests.mjs')).href
    )
    const verdict = assertEverySuiteCompleted(
      [path.join(dir, 'failing.test.mjs'), path.join(dir, 'skipped.test.mjs')], records,
    )
    assert.equal(verdict.message, null, 'a failing or skipped file is present, not missing')
    assert.equal(verdict.completed, 2)
    assert.equal(records.find(r => r.file.endsWith('failing.test.mjs')).success, false)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

/** Run the real coverage reporter over `files` in `dir`; return its records. */
async function runCoverageReporter(dir, files) {
  const coveragePath = path.join(dir, 'coverage.jsonl')
  const child = spawn(process.execPath, [
    '--test', '--test-concurrency=1', '--test-force-exit',
    '--test-reporter=spec', '--test-reporter-destination=stdout',
    `--test-reporter=${path.join(ROOT, 'scripts', 'testing', 'suite-coverage-reporter.mjs')}`,
    `--test-reporter-destination=${coveragePath}`,
    ...files,
  ], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: nestedRunnerEnv() })
  let out = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { out += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { out += chunk })
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => resolve(code ?? 1))
  })
  const raw = await fs.readFile(coveragePath, 'utf8')
  return Object.assign(raw.split('\n').filter(Boolean).map(JSON.parse), { exitCode, out })
}

test('a file killed mid-run leaves node green — and leaves no summary of its own', async () => {
  // The mechanism the floor rests on, proven against the real reporter rather
  // than asserted. `process.exit(0)` inside a test is the smallest form of
  // every way a file dies early: node reports the FILE as passing, counts none
  // of its tests, and settles success:true.
  // realpath: on macOS os.tmpdir() is /var/..., a symlink to /private/var/...,
  // and Node's reporter names files by the resolved path. The harness resolves
  // both sides for exactly this reason.
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'suite-coverage-floor-')))
  try {
    await fs.writeFile(path.join(dir, 'whole.test.mjs'),
      'import { test, describe } from "node:test"\n'
      + 'describe("alpha", () => { test("a1", () => {}) })\n')
    await fs.writeFile(path.join(dir, 'truncated.test.mjs'),
      'import { test, describe } from "node:test"\n'
      + 'describe("beta", () => { test("b1", () => { process.exit(0) }) })\n'
      + 'describe("gamma", () => { test("g1", () => {}) })\n')
    const coveragePath = path.join(dir, 'coverage.jsonl')
    const child = spawn(process.execPath, [
      '--test', '--test-concurrency=1', '--test-force-exit',
      '--test-reporter=spec', '--test-reporter-destination=stdout',
      `--test-reporter=${path.join(ROOT, 'scripts', 'testing', 'suite-coverage-reporter.mjs')}`,
      `--test-reporter-destination=${coveragePath}`,
      'whole.test.mjs', 'truncated.test.mjs',
    ], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: nestedRunnerEnv() })
    let out = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { out += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { out += chunk })
    const exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', code => resolve(code ?? 1))
    })

    // The false green, reproduced: node is perfectly happy.
    assert.equal(exitCode, 0, 'a mid-run exit(0) still leaves the runner green — that is the bug')
    assert.match(out, /^[#ℹ]\s+fail\s+0\s*$/m, 'and the summary reports no failures')

    // The floor sees what the summary cannot.
    const records = (await fs.readFile(coveragePath, 'utf8')).split('\n').filter(Boolean).map(JSON.parse)
    const { assertEverySuiteCompleted } = await import(
      pathToFileURL(path.join(ROOT, 'scripts', 'testing', 'run-backend-tests.mjs')).href
    )
    const verdict = assertEverySuiteCompleted(
      [path.join(dir, 'whole.test.mjs'), path.join(dir, 'truncated.test.mjs')], records,
    )
    assert.deepEqual(verdict.missing, [path.join(dir, 'truncated.test.mjs')])
    assert.match(String(verdict.message), /never reported a completed suite/i)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
