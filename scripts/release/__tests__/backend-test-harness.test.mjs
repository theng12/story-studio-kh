import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveWorkRoot, retainSandbox } from '../../testing/run-backend-tests.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

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

async function runHarness(args = ['--probe'], env = process.env, duringRun) {
  const child = spawn(process.execPath, ['scripts/testing/run-backend-tests.mjs', ...args], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  let closed = false
  let childError
  const completion = new Promise(resolve => {
    child.once('error', error => { childError = error })
    child.once('close', code => { closed = true; resolve(code ?? 1) })
  })
  try {
    if (duringRun) await duringRun({ output: () => stdout + stderr, closed: () => closed })
    await waitFor(() => closed, 'backend harness completion')
    const exitCode = await completion
    if (childError) throw childError
    return { exitCode, stdout, stderr }
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

async function runnerFixtureEntries() {
  const active = (await fs.readdir(ROOT)).filter(name => name.startsWith('.story-studio-backend-tests-'))
  const retained = await fs.readdir(path.join(ROOT, '_trash', 'test-fixtures')).catch(error => {
    if (error?.code === 'ENOENT') return []
    throw error
  })
  return [...active, ...retained.filter(name => name.startsWith('backend-test-harness-'))].sort()
}

/**
 * Whether `_trash` is a symlink to a directory this checkout shares.
 *
 * The main checkout reaches `_trash` through a symlink into a directory every
 * checkout on this machine uses, so its listing changes with other checkouts'
 * runs and cannot be compared before and after. Where the directory is this
 * checkout's own, the comparison is exact.
 */
async function trashIsShared() {
  try {
    return (await fs.lstat(path.join(ROOT, '_trash'))).isSymbolicLink()
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

/**
 * Env for a `node --test` spawned from INSIDE a test file. Node refuses to
 * recurse ("skipping running files") when it sees its own marker, and the
 * harness deletes the same variable for the same reason.
 *
 * Nested runners establish their own sandbox; never preload against the outer one.
 */
function nestedRunnerEnv() {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  delete env.NODE_OPTIONS
  delete env.STORY_STUDIO_TEST_HARNESS_ROOT
  delete env.STORY_STUDIO_RETAINED_SNAPSHOT_ROOT
  delete env.STORY_STUDIO_RETAIN_SUCCESSFUL_FIXTURES
  return env
}

/**
 * The runner's env with the retained fixtures override REMOVED.
 *
 * A test that proves the default behaviour must prove it even when the
 * operator has set the override for the gate, or the gate proves nothing
 * about the default it will fall back to.
 */
function defaultRunnerEnv(extra = {}) {
  const env = { ...nestedRunnerEnv(), ...extra }
  delete env.STORY_STUDIO_TEST_HARNESS_ROOT
  delete env.STORY_STUDIO_RETAINED_SNAPSHOT_ROOT
  return env
}


// Outside the checkout, but in ONE enclosing folder beside it (`../.test-work/<checkout>/`, the
// content-packs lane's convention) — never loose in the parent folder, where every run left a new
// directory beside the owner's projects.
async function outsideRepoWorkDir() {
  const dir = path.join(path.resolve(ROOT, '..'), '.test-work', path.basename(path.resolve(ROOT)), 'release-lane')
  await fs.mkdir(dir, { recursive: true })
  return dir
}

test('backend runner parser rejects unknown options instead of widening the run', async () => {
  const { parseBackendTestArgs, parseOnly } = await import(
    pathToFileURL(path.join(ROOT, 'scripts', 'testing', 'run-backend-tests.mjs')).href
  )
  assert.deepEqual(parseOnly(['--probe', '--only', 'alpha', '--only=beta']), ['alpha', 'beta'])
  assert.deepEqual(parseBackendTestArgs([]), {
    onlyNeedles: [], probe: false, failAfterSetup: false, help: false,
  })
  assert.deepEqual(parseBackendTestArgs([
    '--probe', '--fail-after-setup', '--only', 'alpha', '--only=beta', '--help',
  ]), {
    onlyNeedles: ['alpha', 'beta'], probe: true, failAfterSetup: true, help: true,
  })
  assert.throws(
    () => parseOnly(['--probe', '--only', 'alpha', '--typo']),
    /unsupported.*--typo/i,
  )
})

test('--help and unknown options exit before sandbox setup or test execution', async () => {
  const before = await runnerFixtureEntries()
  const shared = await trashIsShared()
  const help = await runHarness(['--help'])
  assert.equal(help.exitCode, 0, help.stderr || help.stdout)
  assert.match(help.stdout, /^Usage: node scripts\/testing\/run-backend-tests\.mjs/m)
  assert.doesNotMatch(help.stdout + help.stderr, /sandbox:|suite coverage:|PARTIAL RUN|configured projects root/)
  if (!shared) {
    assert.deepEqual(await runnerFixtureEntries(), before, '--help must not create or retain a sandbox')
  }

  const invalid = await runHarness(['--only', 'image-episode-concurrency', '--typo'])
  assert.notEqual(invalid.exitCode, 0)
  assert.match(invalid.stderr + invalid.stdout, /unsupported.*--typo/i)
  assert.doesNotMatch(invalid.stdout + invalid.stderr, /sandbox:|suite coverage:|PARTIAL RUN|configured projects root/)
  if (!shared) {
    assert.deepEqual(await runnerFixtureEntries(), before, 'invalid input must fail before sandbox setup')
  }
})

test('sandbox retention reserves a fresh container without touching a prior colliding artifact', async () => {
  const retentionRoot = await fs.mkdtemp(path.join(await resolveWorkRoot(), 'backend-retention-collision-proof-'))
  const source = await fs.mkdtemp(path.join(ROOT, '.backend-retention-collision-source-'))
  const sourceName = path.basename(source)
  const collision = path.join(retentionRoot, `backend-test-harness-${sourceName}`)
  const marker = path.join(collision, 'owner-marker.txt')
  await fs.mkdir(collision, { recursive: true })
  await fs.writeFile(marker, 'prior retained artifact\n')
  await fs.writeFile(path.join(source, 'runner-payload.txt'), 'new generated sandbox\n')

  try {
    const { retainSandbox } = await import(
      pathToFileURL(path.join(ROOT, 'scripts', 'testing', 'run-backend-tests.mjs')).href
    )
    const retained = await retainSandbox(source, retentionRoot)
    assert.notEqual(retained, collision, 'a fresh archive must never reuse the old basename-derived target')
    assert.equal(await fs.readFile(marker, 'utf8'), 'prior retained artifact\n')
    assert.equal(await fs.readFile(path.join(retained, 'runner-payload.txt'), 'utf8'), 'new generated sandbox\n')
    await assert.rejects(fs.access(source), error => error?.code === 'ENOENT')
  } finally {
    try {
      await fs.access(source)
      await fs.rename(source, path.join(retentionRoot, `retained-red-source-${sourceName}`))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    await retainSandbox(retentionRoot, undefined, 'collision-contract')
  }
})

/**
 * The retained fixtures root can be moved OUT of the shared `_trash`.
 *
 * The main checkout reaches `_trash` through a symlink into a directory every
 * checkout shares, so a retained sandbox kept there is at the mercy of that
 * shared directory. `STORY_STUDIO_RETAINED_FIXTURES_ROOT` names a permanent
 * home for the evidence instead.
 *
 * Proven with no stopwatch: the retained sandbox lands under the override,
 * the isolated projects sentinel inside it is byte-identical, the run still
 * proves its source projects untouched, and — where the Trash belongs to this
 * checkout alone — it gains nothing.
 */
test('the retained fixtures root can be moved out of the shared Trash', async () => {
  // Use a path explicitly outside the repo, not os.tmpdir() which may resolve
  // inside the worktree on some platforms.
  const override = await fs.realpath(await fs.mkdtemp(path.join(await outsideRepoWorkDir(), 'retained-fixtures-root-')))
  const before = await runnerFixtureEntries()
  const shared = await trashIsShared()
  const { exitCode, stdout, stderr } = await runHarness(['--probe'], {
    ...nestedRunnerEnv(),
    STORY_STUDIO_RETAINED_FIXTURES_ROOT: override,
  })

  assert.equal(exitCode, 0, stderr || stdout)
  assert.match(stdout, /configured projects root byte-identical: true/,
    'the source projects must still be proven untouched')
  const retained = stdout.match(/\[test-harness\] retained sandbox: (.+)/)?.[1]?.trim()
  assert.ok(retained, 'the run must report where it retained its sandbox')
  assert.ok(retained.startsWith(override),
    `the retained sandbox must live under the override root: ${retained}`)
  // A settled successful run releases its bulky sandbox/snapshots; the small
  // report bytes the gate reads are what remain under the override root.
  const bulky = (await fs.readdir(retained)).filter(name => /^sandbox(-|$)|^snapshots(-|$)/.test(name))
  assert.deepEqual(bulky, [], 'a successful run must not keep its bulky fixture')
  const reports = (await fs.readdir(retained)).filter(name => /^suite-coverage.*\.jsonl$/.test(name))
  assert.ok(reports.length > 0, 'the coverage report must survive reclamation')
  assert.ok((await fs.stat(path.join(retained, reports[0]))).size > 0)
  if (!shared) {
    assert.deepEqual(await runnerFixtureEntries(), before,
      'the shared Trash must gain nothing when the override is set')
  }
})

test('a symlinked retained fixtures root is refused, not followed', async () => {
  // Following a link is the weakness the override exists to escape: a path
  // that looks permanent can be repointed elsewhere, and the evidence goes
  // with it. The fixture below is retained, not cleaned up.
  // Use a path explicitly outside the repo, not os.tmpdir() which may resolve
  // inside the worktree on some platforms.
  const container = await fs.realpath(await fs.mkdtemp(path.join(await outsideRepoWorkDir(), 'retained-fixtures-link-')))
  const real = path.join(container, 'real')
  const link = path.join(container, 'link')
  await fs.mkdir(real, { recursive: true })
  await fs.symlink(real, link)

  const { exitCode, stdout, stderr } = await runHarness(['--probe'], {
    ...nestedRunnerEnv(),
    STORY_STUDIO_RETAINED_FIXTURES_ROOT: link,
  })

  assert.notEqual(exitCode, 0, 'a symlinked root must be refused, loudly')
  assert.match(stderr + stdout, /STORY_STUDIO_RETAINED_FIXTURES_ROOT must name a real directory/)
  assert.deepEqual(await fs.readdir(real), [],
    'a refused root must not have been written through to')
})

test('backend test runner is hermetic without an operator-provided environment wrapper', async () => {
  const { exitCode, stdout, stderr } = await runHarness()

  assert.equal(exitCode, 0, stderr || stdout)
  assert.match(stdout, /configured projects root byte-identical: true/)
})

test('backend test runner ignores inherited temp-directory escape routes', async () => {
  const missingUntrustedTemp = path.join(ROOT, `.untrusted-test-temp-${process.pid}-${Date.now()}`)
  await assert.rejects(fs.access(missingUntrustedTemp), error => error?.code === 'ENOENT')
  const { exitCode, stdout, stderr } = await runHarness(['--probe'], {
    ...process.env,
    TMPDIR: missingUntrustedTemp,
    TMP: missingUntrustedTemp,
    TEMP: missingUntrustedTemp,
  })

  assert.equal(exitCode, 0, stderr || stdout)
  await assert.rejects(fs.access(missingUntrustedTemp), error => error?.code === 'ENOENT')
})

test('backend test runner retains its sandbox recoverably when setup fails', async () => {
  // The DEFAULT retained fixtures root, proved with the override removed: the
  // gate may set one, but the default it falls back to must still hold.
  // Live work happens in .test-work/; only after settling does the container
  // move into _trash/test-fixtures/. A setup failure still triggers the finally
  // block, so the evidence is retained.
  const { exitCode, stdout, stderr } = await runHarness(['--probe', '--fail-after-setup'], defaultRunnerEnv())
  assert.notEqual(exitCode, 0)
  assert.match(stderr + stdout, /intentional backend test harness setup failure/,
    'the nonzero exit must come from the controlled setup failure, not an earlier one')

  const sandbox = stdout.match(/\[test-harness\] sandbox: (.+)/)?.[1]?.trim()
  assert.ok(sandbox, 'the failing setup probe must report its sandbox')
  const retained = stdout.match(/\[test-harness\] retained sandbox: (.+)/)?.[1]?.trim()
  assert.ok(retained, 'the failing setup probe must report its retained sandbox')

  // After the work-root separation, the sandbox lives under .test-work/ during
  // the run, and the retained container lands under _trash/test-fixtures/ after
  // the finally block moves it. The sandbox path is INSIDE the retained container.
  assert.equal((await fs.stat(retained)).isDirectory(), true)
  assert.match(retained, /\/_trash\/test-fixtures\/backend-test-harness-/)
  // The sandbox reported during setup is under the work root, but after retention
  // the whole container (including sandbox/) has moved. Verify the sentinel survived.
  const retainedSandbox = path.join(retained, 'sandbox')
  assert.equal(await fs.readFile(
    path.join(retainedSandbox, 'configured-projects', 'owner-sentinel', 'owner-marker.txt'), 'utf8',
  ), 'must remain byte-identical\n', 'the setup sentinel is retained byte-identically')
  // The app-settings.json was written when the sandbox lived under the work root,
  // so its projects_root_override points to the work-root sandbox path (captured
  // from stdout), not the retained-root sandbox path.
  assert.deepEqual(JSON.parse(await fs.readFile(
    path.join(retainedSandbox, 'home', 'Library', 'Application Support', 'Story Studio KH', 'app-settings.json'),
    'utf8',
  )), { projects_root_override: path.join(sandbox, 'configured-projects') },
  'the retained sandbox still points at its own isolated projects root')
  assert.equal((await fs.stat(path.join(retained, 'snapshots'))).isDirectory(), true)
})

for (const removeLiveWork of [false, true]) {
  test(removeLiveWork
    ? 'backend stops with a loud failure when its live work root vanishes'
    : 'backend survives removal of finished evidence during a run', async () => {
    // The container must be OUTSIDE the repository (the retained-root override
    // is refused inside it) and outside `_trash` (a live work root there is
    // refused by construction). The checkout's parent satisfies both, and is
    // already this file's fixture home for the retained-root override.
    const container = await fs.realpath(
      await fs.mkdtemp(path.join(path.resolve(ROOT, '..'), 'backend-work-lifecycle-')),
    )
    const work = path.join(container, 'work')
    const retained = path.join(container, 'retained')
    const preload = path.join(container, 'handshake.mjs')
    await fs.mkdir(retained)
    await fs.writeFile(path.join(retained, 'old-evidence.txt'), 'finished evidence\n')
    await fs.writeFile(preload, `
      import assert from 'node:assert/strict'
      import fs from 'node:fs/promises'
      import path from 'node:path'
      if (process.env.STORY_STUDIO_TEST_HARNESS_ROOT?.startsWith(
        process.env.STORY_STUDIO_TEST_WORK_ROOT + path.sep,
      )) {
        const sandbox = process.env.STORY_STUDIO_TEST_HARNESS_ROOT
        // Print the sandbox so the parent can verify it lives under the work root.
        console.log('WORK_READY=' + sandbox)
        const POLL_MS = 20
        const deadline = Date.now() + 20_000
        for (;;) {
          try { await fs.access(path.join(sandbox, 'resume')); break }
          catch (error) { if (error.code !== 'ENOENT') throw error }
          assert.ok(Date.now() < deadline, 'parent never resumed backend probe')
          await new Promise(resolve => setTimeout(resolve, POLL_MS))
        }
      }
    `)
    try {
      const { exitCode, stdout, stderr } = await runHarness(['--probe'], {
        ...nestedRunnerEnv(),
        NODE_OPTIONS: `--import ${pathToFileURL(preload).href}`,
        STORY_STUDIO_TEST_WORK_ROOT: work,
        STORY_STUDIO_RETAINED_FIXTURES_ROOT: retained,
      }, async ({ output, closed }) => {
        const sandbox = await waitFor(() => {
          const match = output().match(/WORK_READY=(.+)/)
          assert.ok(match || !closed(), `backend exited before readiness:\n${output()}`)
          return match?.[1]?.trim()
        }, 'backend readiness')
        const realWork = await fs.realpath(work)
        assert.ok(sandbox.startsWith(realWork + path.sep), `sandbox ${sandbox} not under resolved work ${realWork}`)
        await fs.rename(removeLiveWork ? work : retained, path.join(container, 'removed-root'))
        if (!removeLiveWork) await fs.writeFile(path.join(sandbox, 'resume'), 'parent finished')
      })
      const output = stdout + stderr
      if (removeLiveWork) {
        assert.notEqual(exitCode, 0, output)
        assert.match(output, /live test work disappeared or changed; failing the run/)
        assert.doesNotMatch(output, /retained sandbox:/)
      } else {
        assert.equal(exitCode, 0, output)
        assert.match(output, /configured projects root byte-identical: true/)
        const archived = stdout.match(/retained sandbox: (.+)/)?.[1]?.trim()
        assert.ok(archived?.startsWith(retained + path.sep), output)
        // exit 0 above proves the child saw `resume` and finished; the settled
        // successful run then released the bulky sandbox instead of keeping it.
        const bulky = (await fs.readdir(archived)).filter(name => /^sandbox(-|$)|^snapshots(-|$)/.test(name))
        assert.deepEqual(bulky, [], 'a successful run must not keep its bulky fixture')
        const reports = (await fs.readdir(archived)).filter(name => /^suite-coverage.*\.jsonl$/.test(name))
        assert.ok(reports.length > 0, 'the coverage report must survive reclamation')
      }
    } finally {
      await retainSandbox(container, undefined, 'backend-lifecycle-contract')
    }
  })
}

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
    await retainSandbox(dir, undefined, 'coverage-contract')
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
    await retainSandbox(dir, undefined, 'coverage-contract')
  }
})

test('the pool deals every file to exactly one worker, and one worker is the old serial run', async () => {
  const { planInvocations, partitionTestFiles, backendTestWorkers, SLOW_FILE_HINT_MS } = await import(
    pathToFileURL(path.join(ROOT, 'scripts', 'testing', 'run-backend-tests.mjs')).href
  )
  // Distinct basenames, one of them the heaviest file the hint table knows about,
  // and one that must stay alone.
  const files = [
    '/s/__tests__/a.test.ts',
    '/s/__tests__/youtube-upload-center-route.test.ts',
    '/s/__tests__/app-update.test.ts',
    ...Array.from({ length: 20 }, (_, index) => `/s/__tests__/z${String(index).padStart(2, '0')}.test.ts`),
  ]
  const serialNames = ['app-update.test.ts']

  const single = planInvocations(files, { workers: 1, serialNames })
  assert.equal(single.length, 1, 'one worker is one invocation')
  assert.equal(single[0].label, '', 'and it carries no label, so its log reads as the old runner did')
  assert.equal(single[0].files.length, files.length)
  assert.equal(single[0].concurrency, 1)

  const pool = planInvocations(files, { workers: 3, serialNames })
  assert.equal(pool.length, 4, 'three workers plus the serial list')
  assert.equal(pool.at(-1).label, 'serial')
  assert.deepEqual(pool.at(-1).files.map(file => path.basename(file)), serialNames)

  const scheduled = pool.flatMap(invocation => invocation.files)
  assert.equal(scheduled.length, files.length, 'no file is dropped')
  assert.equal(new Set(scheduled).size, files.length, 'and none is run twice')

  // Longest first: the heaviest file must not share a worker with the next heaviest
  // when there are workers to spare — that is the whole point of the hint table.
  const heaviest = pool.find(invocation => invocation.files.some(file => path.basename(file) === 'youtube-upload-center-route.test.ts'))
  assert.ok(heaviest, 'the heaviest file is scheduled')
  assert.ok(SLOW_FILE_HINT_MS['youtube-upload-center-route.test.ts'] > 0, 'the table names it')
  const { parallel } = partitionTestFiles(files, serialNames)
  assert.equal(parallel.length, files.length - serialNames.length, 'the serial file is not in the pool')

  // The count is a number the operator can set, and a small machine gets fewer.
  assert.equal(backendTestWorkers({}, 12), 4)
  assert.equal(backendTestWorkers({}, 4), 2)
  assert.equal(backendTestWorkers({ STORY_STUDIO_BACKEND_TEST_WORKERS: '2' }, 12), 2)
})

test('a split run proves each invocation and sums them into one aggregate the gate can read', async () => {
  // The gate certifies a partitioned lane from one aggregate line plus one whole
  // coverage line per invocation (story_gate_proof.py `_check_suite`). This runs
  // the real runner over three tiny files, one of them forced onto the serial
  // list through the operator override, and checks the shape it produces.
  const { exitCode, stdout, stderr } = await runHarness(
    ['--only', 'animation-filters', '--only', 'image-episode-concurrency', '--only', 'helpers-loopback-supertest'],
    {
      ...process.env,
      STORY_STUDIO_BACKEND_TEST_WORKERS: '4',
      STORY_STUDIO_BACKEND_SERIAL_TESTS: 'helpers-loopback-supertest.test.ts',
    },
  )
  assert.equal(exitCode, 0, stderr || stdout)

  const coverageLines = [...stdout.matchAll(/suite coverage: (\d+)\/(\d+) file\(s\) completed, (\d+) test\(s\) \+ (\d+) suite\(s\) = (\d+) marks/g)]
  const aggregate = stdout.match(/aggregate suite coverage: (\d+)\/(\d+) file\(s\) completed; inputs=\[([^\]]*)\]/)
  assert.ok(aggregate, 'a split run prints the aggregate the gate reads')
  // The filters match more than three files as the suite grows, so the number of
  // pool workers is not fixed here: the aggregate names its invocations, and each
  // must print exactly one coverage line (at least one pool worker plus serial).
  const invocations = (aggregate[3] ?? '').split(',').filter(Boolean)
  assert.ok(invocations.length >= 2, `a pool and a serial invocation, got ${invocations}`)
  assert.equal(coverageLines.length, invocations.length, `one coverage line per invocation, got ${coverageLines.length}`)
  assert.equal(aggregate[1], aggregate[2], 'the aggregate is at its discovered floor')
  assert.equal(Number(aggregate[1]), coverageLines.reduce((total, line) => total + Number(line[1]), 0),
    'the invocations add up to the aggregate')
  assert.equal(Number(aggregate[2]), coverageLines.reduce((total, line) => total + Number(line[2]), 0),
    'including what was discovered')
  assert.match(aggregate[3] ?? '', /serial/, 'the serial invocation is named in the aggregate')
  // A filtered split run is still unmistakably filtered, before and after.
  assert.equal([...stdout.matchAll(/=+ PARTIAL RUN =+/g)].length, 2, 'the banner still brackets a filtered run')
  assert.match(stdout, /END PARTIAL RUN \(about to run\)/, 'before the run')
  assert.match(stdout, /END PARTIAL RUN \(finished\)/, 'and after it')

  // One raw node summary per invocation, and they are what the gate sums.
  const summaries = [...stdout.matchAll(/^[#ℹ]\s+tests\s+(\d+)\s*$/gm)]
  assert.equal(summaries.length, invocations.length, 'each invocation keeps one contiguous summary block')
  const counted = coverageLines.reduce((total, line) => total + Number(line[3]), 0)
  assert.equal(summaries.reduce((total, match) => total + Number(match[1]), 0), counted,
    'the summaries and the coverage lines agree on how many tests ran')
})
