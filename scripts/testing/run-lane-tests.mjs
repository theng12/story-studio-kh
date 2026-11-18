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
 * `node --import tsx --test` invocations whose only evidence was their own summary block.
 * That is precisely the artifact we proved can lie, so three quarters of the
 * gate was resting on it.
 *
 * This wrapper gives those three the same proof. It is deliberately thin: the
 * reporter (`suite-coverage-reporter.mjs`) and the two verdict functions are
 * the backend lane's, imported rather than copied, so there is exactly one
 * implementation of the floor and it cannot drift between lanes.
 *
 * Runner arguments, working directories and discovered files remain the lane's.
 * The real release lane runs its runner contracts separately, without a
 * lane-owned adapter, then runs the remaining files with retention enabled.
 * Each invocation and their union must cover their exact discovery once.
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
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  assertEverySuiteCompleted,
  assertSummaryAgrees,
  preflightSandboxRetention,
  retainSandbox,
  waitForSuiteChild,
  resolveRetainedFixturesRoot,
  resolveWorkRoot,
  retainedFsEvidenceFailure,
} from './run-backend-tests.mjs'
import { TRASH_ROOT_ENV, DEFAULT_TRASH_ROOT } from '../shared-paths.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const COVERAGE_REPORTER = path.join(ROOT, 'scripts', 'testing', 'suite-coverage-reporter.mjs')
const RETAINED_FS_PRELOAD = path.join(ROOT, 'scripts', 'testing', 'retained-fixture-fs.mjs')

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
 *   runner  — 'node' runs the files directly; 'tsx' registers tsx's loader
 *             before node's own test runner loads TypeScript tests.
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
 * removes it. Adapted invocations append the fixed preload; runner contracts
 * preserve external `NODE_OPTIONS` verbatim, including unset and empty values.
 */
function childEnv(sandbox, snapshotRoot, addRetainedAdapter) {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  env.HOME = path.join(sandbox, 'home')
  env.USERPROFILE = path.join(sandbox, 'profile')
  env.APPDATA = path.join(sandbox, 'appdata')
  env.XDG_CONFIG_HOME = path.join(sandbox, 'xdg-config')
  env.TMPDIR = sandbox
  env.TMP = sandbox
  env.TEMP = sandbox
  env.STORY_STUDIO_TEST_HARNESS_ROOT = sandbox
  env.STORY_STUDIO_RETAINED_SNAPSHOT_ROOT = snapshotRoot
  env[TRASH_ROOT_ENV] = DEFAULT_TRASH_ROOT
  if (addRetainedAdapter) {
    env.NODE_OPTIONS = [env.NODE_OPTIONS, `--import ${pathToFileURL(RETAINED_FS_PRELOAD).href}`].filter(Boolean).join(' ')
  }
  delete env.STORY_STUDIO_DATA_DIR
  return env
}

async function exactCoverage(discovered, records) {
  if (!Array.isArray(records)) throw new Error('no suite-coverage record at all')
  const expected = new Set(discovered)
  if (expected.size !== discovered.length) throw new Error('duplicate discovered file identity')
  const seen = new Set()
  for (const record of records) {
    if (!record || typeof record.file !== 'string' || !path.isAbsolute(record.file)) {
      throw new Error('invalid coverage record file field')
    }
    const canonical = await fs.realpath(record.file)
    if (record.file !== canonical || !expected.has(canonical)) throw new Error(`unexpected coverage file: ${record.file}`)
    if (seen.has(canonical)) throw new Error(`duplicate coverage file: ${canonical}`)
    if (typeof record.success !== 'boolean'
      || ['tests', 'suites', 'failed'].some(key => !Number.isSafeInteger(record[key]) || record[key] < 0)) {
      throw new Error(`malformed coverage counts: ${canonical}`)
    }
    // A file with failing tests still reached its own summary, so it completed.
    // Test failure is the summary's and the exit code's job, not the floor's.
    if (record.tests === 0) {
      throw new Error(`coverage file reported zero tests: ${canonical}`)
    }
    seen.add(canonical)
  }
  return assertEverySuiteCompleted(discovered, records)
}

async function readExactCoverage(coveragePath) {
  const raw = await fs.readFile(coveragePath, 'utf8')
  if (!raw || !raw.endsWith('\n')) throw new Error('empty or incomplete coverage JSONL')
  return raw.slice(0, -1).split('\n').map(line => JSON.parse(line))
}

/** One existing runner invocation, with its own transcript and retained evidence. */
async function runInvocation(name, lane, discovered, addRetainedAdapter) {
  const workRoot = await resolveWorkRoot(process.env, name === 'content-packs')
  const retainedFixtures = await resolveRetainedFixturesRoot()
  console.log(`[test-harness] work root: ${workRoot}`)
  console.log(`[test-harness] retained fixtures root: ${retainedFixtures}`)
  // LIVE work happens in the work root, outside any `_trash`
  const workContainer = await fs.realpath(
    await fs.mkdtemp(path.join(workRoot, `story-studio-${name}-harness-`)),
  )
  const coveragePath = path.join(workContainer, 'suite-coverage.jsonl')
  let result
  try {
    await fs.chmod(workContainer, 0o700)
    const sandbox = path.join(workContainer, 'sandbox')
    const snapshotRoot = path.join(workContainer, 'snapshots')
    await fs.mkdir(sandbox, { mode: 0o700 })
    await fs.mkdir(snapshotRoot, { mode: 0o700 })
    await Promise.all([
      fs.mkdir(path.join(sandbox, 'home'), { recursive: true }),
      fs.mkdir(path.join(sandbox, 'profile'), { recursive: true }),
      fs.mkdir(path.join(sandbox, 'appdata'), { recursive: true }),
      fs.mkdir(path.join(sandbox, 'xdg-config'), { recursive: true }),
    ])
    await preflightSandboxRetention(sandbox, retainedFixtures)
    const require = createRequire(import.meta.url)
    const runnerArgs = lane.runner === 'tsx' ? ['--import', require.resolve('tsx')] : []
    // Adapted files share a snapshot lock whose synchronous acquisition refuses contention.
    const concurrencyArgs = addRetainedAdapter ? ['--test-concurrency=1'] : []
    const child = spawn(process.execPath, [
      ...runnerArgs,
      ...lane.args,
      '--test',
      ...concurrencyArgs,
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
      env: childEnv(sandbox, snapshotRoot, addRetainedAdapter),
      // Piped rather than inherited so the summary can be READ. The exit code
      // alone is not enough to know whether the suite passed.
      stdio: ['inherit', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })

    let transcript = ''
    for (const [stream, sink] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
      stream.setEncoding('utf8')
      stream.on('data', chunk => { transcript += chunk; sink.write(chunk) })
    }
    let exitCode = await waitForSuiteChild(child, [workRoot, workContainer, sandbox, snapshotRoot])

    await fs.writeFile(path.join(workContainer, 'transcript.log'), transcript)
    console.log(`[test-harness] ${name} child exit: ${exitCode}`)
    if (addRetainedAdapter) {
      const retainedFsFailure = await retainedFsEvidenceFailure(snapshotRoot)
      if (retainedFsFailure) {
        console.error(`[test-harness] ${name}: ${retainedFsFailure}`)
        exitCode = 1
      } else {
        console.log(`[test-harness] ${name} retained filesystem evidence: complete`)
      }
    } else {
      console.log(`[test-harness] ${name} lane-owned adapter reconciliation: inapplicable (explicit contract invocation)`)
    }

    const summary = assertSummaryAgrees(transcript, exitCode)
    if (summary) {
      console.error(`[test-harness] ${name}: ${summary}`)
      exitCode = 1
    }

    // The coverage floor. Checked even when the summary looked clean — a
    // vanished file is INVISIBLE to the summary, which is the whole point.
    let records = null
    let coverage
    try {
      records = await readExactCoverage(coveragePath)
      coverage = await exactCoverage(discovered, records)
    } catch (error) {
      console.error(`[test-harness] ${name}: invalid exact coverage: ${error.message}`)
      records = null
      coverage = assertEverySuiteCompleted(discovered, null)
      exitCode = 1
    }
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

    result = { exitCode, records, coveragePath }
  } finally {
    console.log(`[test-harness] finished ${name} work container: ${workContainer}`)
    // Success is a fully reconciled exit 0 only; a throw before `result` was
    // set retains every byte, and suite-coverage.jsonl sits at the container
    // root (never in the reclaimed sandbox), so coveragePath never dangles.
    const retained = await retainSandbox(workContainer, retainedFixtures, name, result?.exitCode === 0)
    if (result) result.coveragePath = path.join(retained, 'suite-coverage.jsonl')
  }
  return result
}

/** Run each discovered file once; release runner contracts initialize separately. */
export async function runLane(name, lane = LANES[name]) {
  if (!lane) {
    console.error(`[test-harness] unknown lane "${name}". Known lanes: ${Object.keys(LANES).join(', ')}`)
    return 1
  }
  const discovered = await discover(lane)
  if (discovered.length === 0) {
    console.error(`[test-harness] the ${name} lane discovered no ${lane.suffix} files in ${lane.dir}. `
      + 'Nothing ran, so this is a failure, not a pass.')
    return 1
  }
  let invocations = [{ name, files: discovered, addRetainedAdapter: true }]
  try {
    if (new Set(discovered).size !== discovered.length) throw new Error('duplicate discovery identity')
    // Object identity excludes caller-supplied fixture lanes, even if named release.
    if (name === 'release' && lane === LANES.release) {
      const contracts = await Promise.all([
        'backend-test-harness.test.mjs', 'lane-test-harness.test.mjs', 'retained-fixture-fs.test.mjs',
      ].map(file => fs.realpath(path.join(ROOT, LANES.release.dir, file))))
      if (new Set(contracts).size !== contracts.length
        || contracts.some(file => discovered.filter(candidate => candidate === file).length !== 1)) {
        throw new Error('all canonical runner contract files must be discovered exactly once')
      }
      const contractSet = new Set(contracts)
      invocations = [
        { name: 'release-contracts', files: discovered.filter(file => contractSet.has(file)), addRetainedAdapter: false },
        { name: 'release-adapted', files: discovered.filter(file => !contractSet.has(file)), addRetainedAdapter: true },
      ]
      const assigned = invocations.flatMap(invocation => invocation.files)
      if (assigned.length !== discovered.length || new Set(assigned).size !== assigned.length
        || discovered.some(file => !assigned.includes(file)) || invocations.some(invocation => !invocation.files.length)) {
        throw new Error('release partitions must be nonempty, disjoint and cover exact discovery')
      }
    }
  } catch (error) {
    console.error(`[test-harness] ${name}: invalid discovery partition: ${error.message}`)
    return 1
  }

  let exitCode = 0
  const records = []
  const inputs = []
  for (const invocation of invocations) {
    try {
      const result = await runInvocation(invocation.name, lane, invocation.files, invocation.addRetainedAdapter)
      if (result.exitCode !== 0) exitCode = 1
      if (result.records) records.push(...result.records)
      inputs.push({ name: invocation.name, coveragePath: result.coveragePath, exitCode: result.exitCode })
    } catch (error) {
      console.error(`[test-harness] ${invocation.name}: invocation failed: ${error.message}`)
      inputs.push({ name: invocation.name, error: error.message })
      exitCode = 1
    }
  }
  try {
    const coverage = await exactCoverage(discovered, records)
    console.log(`[test-harness] ${name} aggregate suite coverage: `
      + `${coverage.completed}/${coverage.discovered} file(s) completed; inputs=${JSON.stringify(inputs)}`)
    if (coverage.message) {
      console.error(`[test-harness] ${name}: ${coverage.message}`)
      exitCode = 1
    }
  } catch (error) {
    console.error(`[test-harness] ${name}: invalid aggregate coverage: ${error.message}; inputs=${JSON.stringify(inputs)}`)
    exitCode = 1
  }
  return exitCode
}

// Importing this module (the harness test reaching for `runLane` or `LANES`)
// must NOT run a lane as a side effect.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const name = process.argv[2]
  process.exitCode = await runLane(name)
}
