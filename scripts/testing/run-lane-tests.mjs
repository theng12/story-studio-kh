/**
 * The completeness floor for the three gate lanes that are NOT the backend.
 *
 * WHY THIS EXISTS. On 2026-08-28 a run reported `fail 0 / skipped 0 / exit 0`
 * while whole files' worth of results had been thrown away: `--test-force-exit`
 * is inherited by every child test process, and on macOS a child that exits
 * with results still queued in its stdout pipe simply discards them. The
 * missing tests are not failed and not cancelled — they never existed, so the
 * summary shrinks and still adds up perfectly.
 *
 * The fix landed for the BACKEND lane only. `scripts/testing/run-backend-tests.mjs`
 * reconciles the files that reported a completed suite against the files it
 * DISCOVERED, and fails the run when the first number is smaller. The other
 * three lanes — release, content-packs, frontend — were plain `node --test` /
 * `tsx --test` invocations whose only evidence was their own summary block.
 * That is precisely the artifact we proved can lie, so three quarters of the
 * gate was resting on it.
 *
 * This wrapper gives those three the same proof. It is deliberately thin: the
 * reporter (`suite-coverage-reporter.mjs`) and the two verdict functions are
 * the backend lane's, imported rather than copied, so there is exactly one
 * implementation of the floor and it cannot drift between lanes.
 *
 * WHAT IT DOES NOT DO. It does not change any lane's runner, flags, working
 * directory or the set of files that run — only the two reporter arguments are
 * added. A wrapper that quietly altered the run it was measuring would be
 * worth less than no wrapper at all.
 *
 * THERE IS NO EXPECTED TOTAL ANYWHERE. The floor for each lane is that lane's
 * own discovery list, so adding a test file raises the floor by itself and
 * nothing has to be bumped by hand.
 *
 * Usage: `node scripts/testing/run-lane-tests.mjs <lane>`
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  assertEverySuiteCompleted,
  assertSummaryAgrees,
  readCoverageRecords,
} from './run-backend-tests.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const COVERAGE_REPORTER = path.join(ROOT, 'scripts', 'testing', 'suite-coverage-reporter.mjs')

/**
 * The lanes, described as data.
 *
 * Each entry mirrors what `package.json` used to run inline, one field per
 * moving part, so the shape of a lane is readable without reading the spawn:
 *
 *   dir     — where the lane's test files live, relative to the repo root.
 *             This directory IS the floor; nothing else defines it.
 *   suffix  — what counts as a test file in that directory.
 *   cwd     — the directory the runner is launched from, relative to the root.
 *   runner  — 'node' runs the files directly; 'tsx' goes through tsx's CLI,
 *             which is what compiles TypeScript tests before handing them back
 *             to node's own test runner.
 *   args    — flags that belong to the lane and must be preserved verbatim.
 */
export const LANES = {
  release: {
    dir: path.join('scripts', 'release', '__tests__'),
    suffix: '.test.mjs',
    cwd: '.',
    runner: 'node',
    args: [],
  },
  'content-packs': {
    dir: path.join('scripts', 'content-packs', '__tests__'),
    suffix: '.test.mjs',
    cwd: '.',
    runner: 'node',
    args: [],
  },
  frontend: {
    dir: path.join('frontend', '__tests__'),
    suffix: '.test.ts',
    cwd: 'frontend',
    runner: 'tsx',
    // Registers happy-dom's globals once per test process. Passed exactly as
    // the inline command passed it — relative to `cwd`, which is `frontend`.
    args: ['--import', './__tests__/setup.ts'],
  },
}

/**
 * Every file in the lane's directory, sorted, with symlinks resolved.
 *
 * Real paths on both sides matter: node's reporter names files by their
 * resolved path, and a discovered path can differ from it by a symlink alone
 * (on macOS /var -> /private/var). Comparing the two unresolved would report
 * every file as missing, and a floor that cries wolf gets switched off.
 */
async function discover(lane) {
  const testsRoot = path.resolve(ROOT, lane.dir)
  const names = (await fs.readdir(testsRoot)).filter(name => name.endsWith(lane.suffix)).sort()
  return Promise.all(names.map(name => fs.realpath(path.join(testsRoot, name))))
}

/**
 * Environment for the runner child.
 *
 * `NODE_TEST_CONTEXT` makes node refuse to recurse ("skipping running files")
 * when this wrapper is itself launched from inside a test — which the harness
 * test does on purpose — so it is removed, exactly as the backend runner
 * removes it. `NODE_OPTIONS` goes for the same reason: an outer test run's
 * options are not this lane's, and inheriting them silently changes the run
 * being measured.
 */
function childEnv() {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  delete env.NODE_OPTIONS
  return env
}

/**
 * Run one lane and return its exit code.
 *
 * Exported, and taking the lane object rather than only its name, so the
 * harness test can point it at a fixture directory containing a file that
 * dies mid-run. A floor that has never been shown catching a real truncation
 * is a claim, not evidence.
 */
export async function runLane(name, lane = LANES[name]) {
  if (!lane) {
    console.error(`[test-harness] unknown lane "${name}". Known lanes: ${Object.keys(LANES).join(', ')}`)
    return 1
  }

  const discovered = await discover(lane)
  // Zero discovered files is NOT a pass. It is the most convincing green light
  // there is and it means nothing ran, so it fails here — before the runner is
  // spawned, and before anything can print a clean summary over the top of it.
  if (discovered.length === 0) {
    console.error(`[test-harness] the ${name} lane discovered no ${lane.suffix} files in ${lane.dir}. `
      + 'Nothing ran, so this is a failure, not a pass.')
    return 1
  }

  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), `story-studio-${name}-coverage-`))
  try {
    const coveragePath = path.join(sandbox, 'suite-coverage.jsonl')
    const require = createRequire(import.meta.url)
    const runnerArgs = lane.runner === 'tsx' ? [require.resolve('tsx/cli')] : []
    const child = spawn(process.execPath, [
      ...runnerArgs,
      ...lane.args,
      '--test',
      // NO `--test-force-exit`, in any lane, ever. A child that force-exits
      // drops whatever results are still sitting in its pipe.
      // `spec` is already node's default on this runtime; naming it explicitly
      // only makes room for the second reporter, and keeps the human-readable
      // output identical if that default ever moves.
      '--test-reporter=spec',
      '--test-reporter-destination=stdout',
      `--test-reporter=${COVERAGE_REPORTER}`,
      `--test-reporter-destination=${coveragePath}`,
      ...discovered,
    ], {
      cwd: path.resolve(ROOT, lane.cwd),
      env: childEnv(),
      // Piped rather than inherited so the summary can be READ. The exit code
      // alone is not enough to know whether the suite passed.
      stdio: ['inherit', 'pipe', 'pipe'],
    })

    let transcript = ''
    for (const [stream, sink] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
      stream.setEncoding('utf8')
      stream.on('data', chunk => { transcript += chunk; sink.write(chunk) })
    }
    let exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', code => resolve(code ?? 1))
    })

    const summary = assertSummaryAgrees(transcript, exitCode)
    if (summary) {
      console.error(`[test-harness] ${name}: ${summary}`)
      exitCode = 1
    }

    // The coverage floor. Checked even when the summary looked clean — a
    // vanished file is INVISIBLE to the summary, which is the whole point.
    const coverage = assertEverySuiteCompleted(discovered, await readCoverageRecords(coveragePath))
    console.log(`[test-harness] ${name} suite coverage: `
      + `${coverage.completed}/${coverage.discovered} file(s) completed`
      + `, ${coverage.tests} test(s) + ${coverage.suites} suite(s) = ${coverage.tests + coverage.suites} marks`)
    if (coverage.message) {
      console.error(`[test-harness] ========= ${name.toUpperCase()} SUITE COVERAGE BELOW FLOOR =========`)
      console.error(`[test-harness] ${coverage.message}`)
      for (const missing of coverage.missing) console.error(`[test-harness]   ✗ ${path.basename(missing)}`)
      console.error('[test-harness] A file that never finished cannot have passed. Treating this run as a failure.')
      console.error('[test-harness] ================================================================')
      exitCode = 1
    }

    return exitCode
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true })
  }
}

// Importing this module (the harness test reaching for `runLane` or `LANES`)
// must NOT run a lane as a side effect.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const name = process.argv[2]
  process.exitCode = await runLane(name)
}
