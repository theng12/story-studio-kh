import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { lstatSync } from 'node:fs'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * The bundled ffmpeg binaries, prepended to the child's PATH.
 *
 * NEW-03. Several backend tests exercise real ffmpeg work, and on a Mac with no
 * system ffmpeg they failed with `ENOENT` unless the caller happened to run
 * `PATH="$PWD/bundled/ffmpeg:$PATH" npm run test:backend`. A gate that only
 * passes when the operator remembers an undocumented prefix is not a gate: the
 * next person reads the failures as product defects. The app ships these
 * binaries, so the suite uses the same ones.
 *
 * An absent directory changes nothing — a machine with a system ffmpeg still
 * resolves normally.
 */
const BUNDLED_FFMPEG_DIR = path.join(ROOT, 'bundled', 'ffmpeg')
let bundledFfmpegDir = null
try {
  await fs.access(path.join(BUNDLED_FFMPEG_DIR, 'ffmpeg'))
  bundledFfmpegDir = BUNDLED_FFMPEG_DIR
} catch { /* no bundled binaries on this checkout */ }
const ELECTRON_ROOT = path.join(ROOT, 'electron')
const PROBE_PATH = path.join(ROOT, 'scripts', 'release', 'fixtures', 'hermetic-backend-probe.test.mjs')
// Preloaded into every backend test process so supertest binds the IPv4
// loopback address it then connects to. Without it a throwaway test server
// can be shadowed by any local daemon holding that port on 127.0.0.1, and
// the request is answered by the neighbour instead of the app under test.
// See scripts/testing/loopback-supertest.mjs for the full story.
const LOOPBACK_PRELOAD = path.join(ROOT, 'scripts', 'testing', 'loopback-supertest.mjs')
const RETAINED_FS_PRELOAD = path.join(ROOT, 'scripts', 'testing', 'retained-fixture-fs.mjs')
// Records which FILES finished, so the run can be reconciled against the files
// it discovered rather than against its own summary. See `assertEverySuiteCompleted`.
const COVERAGE_REPORTER = path.join(ROOT, 'scripts', 'testing', 'suite-coverage-reporter.mjs')

/**
 * Where retained fixtures live when nobody says otherwise: the project's own
 * disposable `_trash/`, where finished evidence is moved after a run settles.
 * Live test work never sits here — only completed containers are moved in.
 */
export const DEFAULT_RETAINED_FIXTURES = path.join(ROOT, '_trash', 'test-fixtures')

/**
 * The override: where retained fixtures live when the operator says so.
 *
 * The main checkout reaches `_trash` through a symlink into a directory every
 * checkout on this machine shares, so a retained sandbox kept there is at the
 * mercy of that shared directory. This variable names a permanent home for
 * the evidence instead. It is VALIDATED, not trusted — an exact absolute
 * path, a real directory that is not itself a symbolic link, resolved to its
 * canonical form, outside the repository, on the checkout's volume. The
 * default is not validated this way: the shared `_trash` symlink is a
 * supported configuration.
 */
export const RETAINED_FIXTURES_ROOT_ENV = 'STORY_STUDIO_RETAINED_FIXTURES_ROOT'

/** Live sandboxes stay outside Trash; only settled evidence may be archived there. */
export const WORK_ROOT_ENV = 'STORY_STUDIO_TEST_WORK_ROOT'
export const DEFAULT_WORK_ROOT = path.join(ROOT, '.test-work')

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, `${JSON.stringify(value)}\n`)
}

async function snapshotTree(root) {
  const entries = []
  async function visit(dir, relative = '') {
    const children = await fs.readdir(dir, { withFileTypes: true })
    children.sort((a, b) => a.name.localeCompare(b.name))
    for (const child of children) {
      const absolute = path.join(dir, child.name)
      const name = path.join(relative, child.name)
      if (child.isDirectory()) {
        entries.push(`directory ${name}`)
        await visit(absolute, name)
      } else if (child.isFile()) {
        const bytes = await fs.readFile(absolute)
        entries.push(`file ${name} ${bytes.byteLength} ${createHash('sha256').update(bytes).digest('hex')}`)
      } else {
        entries.push(`special ${name}`)
      }
    }
  }
  await visit(root)
  return entries.join('\n')
}

/**
 * `--only <substring>` — running PART of the suite, on purpose and out loud.
 *
 * WHY THIS EXISTS. The backend suite was one indivisible block: checking a
 * single file meant running all of it. On 2026-08-26 two full suites competed
 * for one machine — one was killed at sixty minutes having printed nothing, the
 * other reported eleven failures that were not real. Hours went to that, and
 * none of it was about the code under test.
 *
 * THE DEFAULT DOES NOT MOVE. No `--only` means every file, exactly as before.
 * This is the release gate, and a gate that can be narrowed by accident is
 * worse than a slow one. The filter is opt-in and applies to the full list.
 *
 * A FILTERED RUN MUST BE IMPOSSIBLE TO MISTAKE FOR A FULL ONE. Three times in
 * one day a run reported success without covering what its reader assumed it
 * had. A quiet filter is that same trap wearing a new face, so a partial run
 * shouts its patterns, names what it selected, counts what it skipped, and says
 * in as many words that it is not the release gate — before AND after the run,
 * because the "after" is the line anyone scrolling to the summary will read.
 *
 * Repeatable: `--only a --only b` runs files matching EITHER. Matching is a
 * plain case-insensitive substring test against the file's basename, so
 * `--only image-episode` finds `image-episode-concurrency.test.ts` without
 * anyone having to think about globs or regex escaping.
 */
export function parseBackendTestArgs(argv) {
  const options = { onlyNeedles: [], probe: false, failAfterSetup: false, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--only') {
      const value = argv[i + 1]
      // A bare trailing `--only` is a typo, not a request to run everything.
      // Silently widening to the full suite is precisely the accident the
      // default is meant to be protected from, so refuse it.
      if (!value || value.startsWith('--')) {
        throw new Error('--only needs a value, e.g. --only image-episode')
      }
      options.onlyNeedles.push(value)
      i += 1
    } else if (arg.startsWith('--only=')) {
      const value = arg.slice('--only='.length)
      if (!value) throw new Error('--only needs a value, e.g. --only=image-episode')
      options.onlyNeedles.push(value)
    } else if (arg === '--probe') {
      options.probe = true
    } else if (arg === '--fail-after-setup') {
      options.failAfterSetup = true
    } else if (arg === '--help') {
      options.help = true
    } else {
      throw new Error(`Unsupported backend test runner option: ${arg}`)
    }
  }
  return options
}

export function parseOnly(argv) {
  return parseBackendTestArgs(argv).onlyNeedles
}

export function selectOnly(files, needles) {
  if (needles.length === 0) return files
  const lowered = needles.map(n => n.toLowerCase())
  return files.filter(file => {
    const name = path.basename(file).toLowerCase()
    return lowered.some(needle => name.includes(needle))
  })
}

function announcePartialRun(needles, selected, skipped, when) {
  const patterns = needles.map(n => `"${n}"`).join(', ')
  const names = selected.map(f => path.basename(f))
  console.log('[test-harness] ==================== PARTIAL RUN ====================')
  console.log(`[test-harness] --only ${patterns} — ${selected.length} file(s) SELECTED, ${skipped} file(s) SKIPPED`)
  for (const name of names) console.log(`[test-harness]   • ${name}`)
  console.log('[test-harness] THIS IS NOT THE RELEASE GATE. The full backend suite was NOT run.')
  console.log(`[test-harness] ============== END PARTIAL RUN (${when}) ==============`)
}

async function backendTestFiles() {
  const testsRoot = path.join(ELECTRON_ROOT, 'server', '__tests__')
  return (await fs.readdir(testsRoot))
    .filter(name => name.endsWith('.test.ts'))
    .sort()
    .map(name => path.join(testsRoot, name))
}

export function assertSameDeviceForRetention(sandboxDevice, fixturesDevice, sandbox) {
  if (sandboxDevice !== fixturesDevice) {
    throw new Error('backend test sandbox and the retained fixtures root are on different devices; '
      + `tests were not started and the original sandbox remains at ${sandbox}`)
  }
}

/**
 * The retained fixtures root for this run: the override when it is set, the
 * project's own `_trash/test-fixtures` otherwise. An empty override is a
 * mistake, not a request to retain fixtures at the filesystem root.
 */
export async function resolveRetainedFixturesRoot(env = process.env) {
  const configured = env[RETAINED_FIXTURES_ROOT_ENV]
  if (configured === undefined || configured === '') return DEFAULT_RETAINED_FIXTURES
  return await assertRealRetainedRoot(configured)
}

/** Content-pack staging must also stay outside the checkout. */
export async function resolveWorkRoot(env = process.env, outsideRepository = false) {
  const configured = env[WORK_ROOT_ENV]
  const workRoot = configured || (outsideRepository
    ? path.join(path.dirname(ROOT), '.test-work', path.basename(ROOT))
    : DEFAULT_WORK_ROOT)
  if (!path.isAbsolute(workRoot) || path.resolve(workRoot) !== workRoot) {
    throw new Error(`${WORK_ROOT_ENV} must be an exact absolute path, not "${workRoot}"`)
  }
  if (workRoot.split(path.sep).includes('_trash')) {
    throw new Error(`${WORK_ROOT_ENV} must stay outside _trash: ${workRoot}`)
  }
  await fs.mkdir(workRoot, { recursive: true, mode: 0o700 })
  const leaf = await fs.lstat(workRoot)
  if (!leaf.isDirectory() || leaf.isSymbolicLink()) {
    throw new Error(`${WORK_ROOT_ENV} must name a real directory: ${workRoot}`)
  }
  const canonical = await fs.realpath(workRoot)
  const trash = await fs.realpath(path.join(ROOT, '_trash')).catch(error => {
    if (error?.code === 'ENOENT') return null
    throw error
  })
  if (canonical.split(path.sep).includes('_trash')
    || (trash && (canonical === trash || canonical.startsWith(`${trash}${path.sep}`)))) {
    throw new Error(`${WORK_ROOT_ENV} must stay outside _trash: ${canonical}`)
  }
  const repo = await fs.realpath(ROOT)
  if (outsideRepository && (canonical === repo || canonical.startsWith(`${repo}${path.sep}`))) {
    throw new Error(`${WORK_ROOT_ENV} must be outside the repository for content-pack staging`)
  }
  return canonical
}

/** Observe identities while the child runs, including a final check before accepting its exit. */
export function waitForSuiteChild(child, roots) {
  return new Promise((resolve, reject) => {
    let failure
    let identities
    const check = (terminate = true) => {
      try {
        const current = roots.map(root => lstatSync(root))
        for (const [index, stat] of current.entries()) {
          if (!stat.isDirectory() || stat.isSymbolicLink()
            || (identities && (stat.dev !== identities[index].dev || stat.ino !== identities[index].ino))) {
            throw new Error(`directory identity changed: ${roots[index]}`)
          }
        }
        identities ??= current
      } catch (error) {
        if (failure) return
        failure = new Error(`live test work disappeared or changed; failing the run: ${error.message}`)
        console.error(`[test-harness] ${failure.message}`)
        if (!terminate) return
        // The detached group contains Node's test workers too; leaving them alive can keep the pipes open.
        if (process.platform !== 'win32' && child.pid) {
          try { process.kill(-child.pid, 'SIGKILL') } catch (killError) {
            if (killError?.code !== 'ESRCH') child.kill('SIGKILL')
          }
        } else child.kill('SIGKILL')
      }
    }
    const poll = setInterval(check, 100)
    child.once('error', error => { failure ??= error })
    child.once('close', code => {
      clearInterval(poll)
      check(false)
      if (failure) reject(failure)
      else resolve(code ?? 1)
    })
    check()
  })
}

/**
 * A retained fixtures root must be a REAL directory on THIS volume, outside
 * the repository.
 *
 * The named directory must not itself be a symbolic link: a link is the
 * weakness this override exists to escape, because a path that looks
 * permanent can be repointed and the evidence goes with it. An ancestor may
 * be one — macOS resolves /var to /private/var — so the path is resolved ONCE
 * to its canonical form here and that is where the evidence lives from then
 * on. The directory must also be the same one across the check, outside the
 * repository so nothing inside the checkout can take it, and on the
 * checkout's volume so a retained sandbox is moved rather than copied.
 */
async function assertRealRetainedRoot(configured) {
  const label = RETAINED_FIXTURES_ROOT_ENV
  if (!path.isAbsolute(configured) || path.resolve(configured) !== configured) {
    throw new Error(`${label} must be an exact absolute path, not "${configured}"`)
  }
  let before
  try {
    before = await fs.lstat(configured)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    await fs.mkdir(configured, { recursive: true, mode: 0o700 })
    before = await fs.lstat(configured)
  }
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error(`${label} must name a real directory, not a symbolic link: ${configured}`)
  }
  const after = await fs.lstat(configured)
  if (before.ino !== after.ino || before.dev !== after.dev) {
    throw new Error(`${label} changed while it was being checked: ${configured}`)
  }
  const canonical = await fs.realpath(configured)
  const root = await fs.realpath(ROOT)
  if (canonical === root || canonical.startsWith(`${root}${path.sep}`)) {
    throw new Error(`${label} must be outside the repository (${root})`)
  }
  const checkout = await fs.stat(ROOT)
  if (after.dev !== checkout.dev) {
    throw new Error(`${label} must be on the same volume as the checkout (${ROOT})`)
  }
  return canonical
}

export async function preflightSandboxRetention(sandbox, fixtures) {
  const root = fixtures ?? await resolveRetainedFixturesRoot()
  await fs.mkdir(root, { recursive: true })
  const [sandboxStat, fixturesStat] = await Promise.all([fs.stat(sandbox), fs.stat(root)])
  assertSameDeviceForRetention(sandboxStat.dev, fixturesStat.dev, sandbox)
}

export async function retainSandbox(sandbox, fixtures, label = '') {
  const root = fixtures ?? await resolveRetainedFixturesRoot()
  await fs.mkdir(root, { recursive: true, mode: 0o700 })
  const container = await fs.mkdtemp(path.join(root, label ? `story-studio-${label}-harness-` : 'backend-test-harness-'))
  const retained = path.join(container, path.basename(sandbox))
  try {
    await fs.rename(sandbox, retained)
  } catch (error) {
    throw new Error(`could not retain finished test work; original location: ${sandbox} (${error.message})`, { cause: error })
  }
  console.log(`[test-harness] retained ${label ? `${label} ` : ''}sandbox: ${retained}`)
  return retained
}

export async function retainedFsEvidenceFailure(snapshotRoot) {
  try {
    const names = (await fs.readdir(snapshotRoot)).filter(name => /^manifest-.*\.jsonl$/.test(name)).sort()
    if (names.length === 0) return 'retained filesystem preload produced no process manifest'
    for (const name of names) {
      const raw = await fs.readFile(path.join(snapshotRoot, name), 'utf8')
      if (!raw || !raw.endsWith('\n')) return `${name} is empty or has a partial final line`
      let records
      try {
        records = raw.trimEnd().split('\n').map(line => JSON.parse(line))
      } catch (error) {
        return `${name} contains invalid retained filesystem evidence: ${error.message}`
      }
      const finals = records.filter(record => [
        'child-settled', 'child-unsettled', 'child-signal-settled', 'child-signal-unsettled',
      ].includes(record.phase))
      if (finals.length !== 1 || records.at(-1) !== finals[0]) {
        return `${name} does not end in exactly one final child settlement record`
      }
      const final = finals[0]
      if (
        !Number.isInteger(final.activeOperations) || final.activeOperations < 0
        || !Number.isInteger(final.pendingCaptures) || final.pendingCaptures < 0
      ) return `${name} has invalid retained filesystem final counters`
      if (
        !(final.phase === 'child-settled'
          || (final.phase === 'child-signal-settled' && final.signal === 'SIGTERM'))
        || final.activeOperations !== 0 || final.pendingCaptures !== 0
      ) {
        return `${name} reports unsettled retained filesystem work`
      }
      for (const verified of records.filter(record => record.phase === 'snapshot-verified')) {
        const settlements = records.filter(record => record.phase === 'operation-settled'
          && record.receiptId === verified.receiptId)
        if (settlements.length !== 1) return `${name} has a verified snapshot without one operation outcome`
      }
    }
    try {
      await fs.lstat(path.join(snapshotRoot, '.retained-fixture-fs.lock'))
      return 'retained filesystem lock remained active after the child closed'
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    return null
  } catch (error) {
    return `retained filesystem evidence could not be reconciled: ${error.message}`
  }
}

/**
 * The configured projects root is the one thing this runner promises not to
 * touch, so a snapshot of it that cannot be taken is a FAILED RUN and must say
 * so — not look like a mistyped command line.
 */
async function snapshotConfiguredProjects(root) {
  try {
    return await snapshotTree(root)
  } catch (error) {
    throw new Error(
      'the configured projects root could not be snapshotted, so this run cannot prove it '
      + `stayed isolated: ${root} (${error?.message ?? String(error)})`,
      { cause: error },
    )
  }
}

async function run(options) {
  let workContainer
  let sandbox
  let snapshotRoot
  let retainedFixtures
  try {
    const workRoot = await resolveWorkRoot()
    retainedFixtures = await resolveRetainedFixturesRoot()
    console.log(`[test-harness] work root: ${workRoot}`)
    console.log(`[test-harness] retained fixtures root: ${retainedFixtures}`)
    // LIVE work happens in the work root, outside any `_trash`
    workContainer = await fs.mkdtemp(path.join(workRoot, 'backend-test-harness-'))
    workContainer = await fs.realpath(workContainer)
    await fs.chmod(workContainer, 0o700)
    sandbox = path.join(workContainer, 'sandbox')
    snapshotRoot = path.join(workContainer, 'snapshots')
    await fs.mkdir(sandbox, { mode: 0o700 })
    await fs.mkdir(snapshotRoot, { mode: 0o700 })
    // Preflight checks that the retained root is on the same device, so the
    // end-of-run move stays a rename. If the retained root is missing, we
    // create it here; if it disappears mid-run, the run continues unaffected.
    await preflightSandboxRetention(sandbox, retainedFixtures)
    const fakeHome = path.join(sandbox, 'home')
    const fakeProfile = path.join(sandbox, 'profile')
    const fakeAppData = path.join(sandbox, 'appdata')
    const fakeXdgConfig = path.join(sandbox, 'xdg-config')
    const configuredProjectsRoot = path.join(sandbox, 'configured-projects')
    const sentinelProject = path.join(configuredProjectsRoot, 'owner-sentinel')
    const settings = { projects_root_override: configuredProjectsRoot }

    await fs.mkdir(sentinelProject, { recursive: true })
    await fs.writeFile(path.join(sentinelProject, 'jobs.json'), '{"jobs":[{"job_id":"owner-record","status":"done"}]}\n')
    await fs.writeFile(path.join(sentinelProject, 'owner-marker.txt'), 'must remain byte-identical\n')
    await Promise.all([
      writeJson(path.join(fakeHome, 'Library', 'Application Support', 'Story Studio KH', 'app-settings.json'), settings),
      writeJson(path.join(fakeAppData, 'Story Studio KH', 'app-settings.json'), settings),
      writeJson(path.join(fakeXdgConfig, 'Story Studio KH', 'app-settings.json'), settings),
    ])
    if (options.failAfterSetup) {
      console.log(`[test-harness] sandbox: ${sandbox}`)
      throw new Error('intentional backend test harness setup failure')
    }
    const before = await snapshotConfiguredProjects(configuredProjectsRoot)

    const require = createRequire(import.meta.url)
    const tsxImport = require.resolve('tsx')
    const onlyNeedles = options.onlyNeedles
    // Real paths on both sides: Node's reporter names files by their resolved
    // path, and on macOS a discovered path can differ only by a symlink
    // (/var -> /private/var). Comparing the two unresolved would report every
    // file as missing — a coverage floor that cries wolf gets switched off.
    const allTests = await Promise.all(
      (options.probe ? [PROBE_PATH] : await backendTestFiles())
        .map(file => fs.realpath(file)),
    )
    const tests = selectOnly(allTests, onlyNeedles)
    // Zero matched files is NOT a pass. It is the most convincing green light
    // in the world and it means nothing ran, so it fails here, before the
    // runner is even spawned and before anything can print a clean summary.
    if (tests.length === 0) {
      console.error(`[test-harness] --only ${onlyNeedles.map(n => `"${n}"`).join(', ')} `
        + `matched no backend test files out of ${allTests.length}. Nothing ran, so this is a failure.`)
      process.exitCode = 1
      return
    }
    const skippedCount = allTests.length - tests.length
    if (onlyNeedles.length > 0) announcePartialRun(onlyNeedles, tests, skippedCount, 'about to run')
    const childEnv = {
      ...process.env,
      HOME: fakeHome,
      USERPROFILE: fakeProfile,
      APPDATA: fakeAppData,
      XDG_CONFIG_HOME: fakeXdgConfig,
      TMPDIR: sandbox,
      TMP: sandbox,
      TEMP: sandbox,
      STORY_STUDIO_TEST_HARNESS_ROOT: sandbox,
      STORY_STUDIO_TEST_WORK_ROOT: workRoot,
      STORY_STUDIO_RETAINED_SNAPSHOT_ROOT: snapshotRoot,
      STORY_STUDIO_DISABLE_LISTEN: '1',
      // NEW-03 — see BUNDLED_FFMPEG_DIR. Prepended, so a caller's own PATH still
      // takes precedence for anything else it needed.
      PATH: bundledFfmpegDir
        ? [bundledFfmpegDir, process.env.PATH].filter(Boolean).join(path.delimiter)
        : process.env.PATH,
      // NODE_OPTIONS carries the fixed preloads into node's test workers.
      NODE_OPTIONS: [
        process.env.NODE_OPTIONS,
        `--import ${pathToFileURL(LOOPBACK_PRELOAD).href}`,
        `--import ${pathToFileURL(RETAINED_FS_PRELOAD).href}`,
      ]
        .filter(Boolean).join(' '),
    }
    delete childEnv.STORY_STUDIO_DATA_DIR
    delete childEnv.NODE_TEST_CONTEXT

    const coveragePath = path.join(sandbox, 'suite-coverage.jsonl')
    const child = spawn(process.execPath, [
      '--import',
      tsxImport,
      '--test',
      '--test-concurrency=1',
      // NO `--test-force-exit`. See `startSuiteWatchdog` for what it was doing.
      // `spec` is already Node's default on this runtime; naming it explicitly
      // only makes room for the second reporter, and keeps the human output
      // identical if that default ever moves.
      '--test-reporter=spec',
      '--test-reporter-destination=stdout',
      `--test-reporter=${COVERAGE_REPORTER}`,
      `--test-reporter-destination=${coveragePath}`,
      ...tests,
    ], {
      cwd: ELECTRON_ROOT,
      env: childEnv,
      // v1.4.44 — piped rather than inherited so the summary can be READ.
      // See `assertSummaryAgrees` below for why the exit code alone is not
      // enough to know whether the suite passed.
      stdio: ['inherit', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    let transcript = ''
    for (const [stream, sink] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
      stream.setEncoding('utf8')
      stream.on('data', chunk => { transcript += chunk; sink.write(chunk) })
    }
    const watchdog = startSuiteWatchdog(child)
    let exitCode = await waitForSuiteChild(child, [workRoot, workContainer, sandbox, snapshotRoot])
      .finally(() => clearTimeout(watchdog))

    const retainedFsFailure = await retainedFsEvidenceFailure(snapshotRoot)
    if (retainedFsFailure) {
      console.error(`[test-harness] ${retainedFsFailure}`)
      exitCode = 1
    } else {
      console.log('[test-harness] retained filesystem evidence: complete')
    }

    const summary = assertSummaryAgrees(transcript, exitCode)
    if (summary) {
      console.error(`[test-harness] ${summary}`)
      exitCode = 1
    }

    // The coverage floor. Checked even when the summary looked clean — a
    // vanished file is INVISIBLE to the summary, which is the whole point.
    const coverage = assertEverySuiteCompleted(tests, await readCoverageRecords(coveragePath))
    console.log(`[test-harness] suite coverage: ${coverage.completed}/${coverage.discovered} file(s) completed`
      + `, ${coverage.tests} test(s) + ${coverage.suites} suite(s) = ${coverage.tests + coverage.suites} marks`)
    if (coverage.message) {
      console.error('[test-harness] ============== SUITE COVERAGE BELOW FLOOR ==============')
      console.error(`[test-harness] ${coverage.message}`)
      for (const name of coverage.missing) console.error(`[test-harness]   ✗ ${path.basename(name)}`)
      console.error('[test-harness] A file that never finished cannot have passed. Treating this run as a failure.')
      console.error('[test-harness] ========================================================')
      exitCode = 1
    }

    // Printed AGAIN after the results, because the line a reader scrolls to is
    // the summary — and a partial pass sitting under a full-looking summary is
    // exactly how a narrowed run gets mistaken for a green release gate.
    if (onlyNeedles.length > 0) announcePartialRun(onlyNeedles, tests, skippedCount, 'finished')

    const after = await snapshotConfiguredProjects(configuredProjectsRoot)
    const unchanged = before === after
    console.log(`[test-harness] configured projects root byte-identical: ${unchanged}`)
    if (!unchanged) {
      console.error('[test-harness] backend tests changed the isolated configured projects-root sentinel')
      exitCode = 1
    }
    process.exitCode = exitCode
  } finally {
    // Retire only after the child closed and all evidence was reconciled.
    if (workContainer) {
      console.log(`[test-harness] finished work container: ${workContainer}`)
      await retainSandbox(workContainer, retainedFixtures)
    }
  }
}

/**
 * v1.4.44 — believe the summary, not the exit code.
 *
 * On 2026-08-23 this harness printed a full `AssertionError` for a failing
 * backend test and then exited 0. Two releases went out on top of that green
 * result. The exit code is a single number produced after `--test-force-exit`
 * has already begun tearing the runner down, and it is exactly the thing that
 * cannot be trusted when a run ends abnormally — which is also the case where
 * the owner has seen the totals move between runs (3410 / 3424 / 3379).
 *
 * So the run is now judged on what the reporter actually said:
 *
 *   • a summary must exist at all — no summary means the run did not finish,
 *     and an unfinished run is a failure however it exited
 *   • `fail` must be zero
 *   • a non-zero exit with a clean summary is still a failure — something
 *     outside the tests went wrong and must not be swallowed either
 *
 * Returns a message when the run must be failed, or `null` when it is sound.
 */
export function assertSummaryAgrees(transcript, exitCode) {
  // The TAP reporter writes `# fail 2`; the spec reporter writes `ℹ fail 2`.
  // Match either, and take the LAST occurrence — nested suites print their own.
  const readCount = (label) => {
    const matches = [...transcript.matchAll(new RegExp(`^[#\\u2139]\\s+${label}\\s+(\\d+)\\s*$`, 'gm'))]
    return matches.length ? Number(matches[matches.length - 1][1]) : null
  }
  const tests = readCount('tests')
  const failed = readCount('fail')
  const passed = readCount('pass')
  if (tests === null || failed === null) {
    return 'the test run produced no summary, so it did not finish. Treating it as a failure '
      + `(reported exit code ${exitCode}).`
  }
  // A summary of all zeros is a run that started nothing. The previous agent
  // had to apply this rule by hand; it lives in the harness now so nobody has
  // to remember it. Zero tests is a failure, never a pass.
  if (tests === 0) {
    return 'the run reported a summary but no tests ran, so nothing was verified. '
      + `Zero tests is a failure, not a pass (reported exit code ${exitCode}).`
  }
  if (failed > 0) {
    // Lane-neutral wording: every gate lane reports through this function, and
    // the caller prefixes its own name. Saying "backend" here produced the line
    // "[test-harness] frontend: 1 of 1116 backend test(s) failed" on a real
    // frontend failure — which points a reader at the wrong suite entirely.
    return `${failed} of ${tests} test(s) failed (reported exit code ${exitCode}).`
  }
  // Skipped and todo are legitimate outcomes and are counted separately, so
  // they belong in the total. Anything left over means tests were started and
  // never resolved — the shape of an interrupted run.
  const accounted = (passed ?? 0) + failed + (readCount('skipped') ?? 0) + (readCount('todo') ?? 0)
  if (passed !== null && tests !== accounted) {
    return `the summary does not add up: ${tests} tests reported, ${accounted} accounted for `
      + `(${passed} passed, ${failed} failed). An incomplete run is a failure.`
  }
  if (exitCode !== 0) {
    return `every test passed but the runner exited ${exitCode}, so something outside the tests failed.`
  }
  return null
}

/**
 * Kill a suite that will not finish — LOUDLY. This replaces `--test-force-exit`.
 *
 * WHAT THAT FLAG WAS ACTUALLY DOING. It is inherited by every child test
 * process (Node runs each file in its own child, reporting results back over a
 * stdout PIPE). On macOS a pipe write is asynchronous, so a child that calls
 * `process.exit()` while its results are still queued DISCARDS the rest of
 * them. The parent never receives those tests, so they are not failed and not
 * cancelled — they never existed. The summary shrinks and still adds up.
 *
 * Measured here, 3,600 tests across 20 files, ten CPU burners for load:
 *
 *   with    --test-force-exit : 3538 / 3427 / 3485 tests, fail 0, exit 0
 *   without --test-force-exit : 3600 / 3600 / 3600 tests, fail 0, exit 0
 *
 * Three runs each, and the losses land on the TAIL of a file — which is the
 * "six of nine describes" that `subtitle-engine.test.ts` was blamed for. That
 * file is innocent: it has no timers, no async, no temp files, and runs in
 * 1.4s. It was simply one of the largest reporter payloads in the suite, so it
 * was among the likeliest to have its tail dropped. This also explains the
 * totals drifting between runs (3410 / 3424 / 3379).
 *
 * The flag was never added in response to an incident — it is in the harness's
 * first commit. It bought no speed either: 50 handle-heavy files finished in
 * 537s without it, and had not finished at 600s with it.
 *
 * A hang must therefore be handled by killing the run out loud instead. A
 * killed child prints no summary, and `assertSummaryAgrees` already fails a
 * run that produced no summary. The limit is env-overridable rather than a
 * constant: a number a future reader would want different is data, not code.
 */
function startSuiteWatchdog(child) {
  const limitMs = Number(process.env.STORY_STUDIO_BACKEND_TEST_TIMEOUT_MS ?? 90 * 60_000)
  if (!Number.isFinite(limitMs) || limitMs <= 0) return undefined
  return setTimeout(() => {
    console.error(`[test-harness] the backend suite ran past ${limitMs}ms and was killed. `
      + 'A run that does not finish is a failure, never a pass.')
    child.kill('SIGKILL')
  }, limitMs)
}

/**
 * Read the per-file records the coverage reporter wrote. Missing file = no evidence.
 *
 * Exported so the other three gate lanes (`run-lane-tests.mjs`) read the
 * reporter's output through this exact function instead of a second copy of
 * it. One implementation of the floor, or the lanes drift apart.
 */
export async function readCoverageRecords(coveragePath) {
  let raw
  try {
    raw = await fs.readFile(coveragePath, 'utf8')
  } catch {
    return null
  }
  return raw.split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)] } catch { return [] }
  })
}

/**
 * The coverage floor — every file DISCOVERED must have finished.
 *
 * WHY THE SUMMARY IS NOT ENOUGH. `assertSummaryAgrees` reconciles the summary
 * against itself and against the exit code. Both agree perfectly when a file
 * dies mid-run, because a file that stops producing output stops contributing
 * to every total the summary is made of. Reduced to its smallest form:
 *
 *     f1..f12  (24 tests)          ->  all fine
 *     b        (process.exit(0))   ->  reported `test:pass`, zero tests counted
 *     result: exit 0, fail 0, skipped 0, success true — one file simply gone
 *
 * Measured on this runtime, five runs out of five. That is the shape of the
 * run that dropped three suites this week and of the `subtitle-engine` file
 * that reported six of its nine describes.
 *
 * WHAT IT CHECKS INSTEAD. Node emits a file-scoped `test:summary` only for a
 * file that ran to completion; the dying file above emits none. So the floor is
 * the discovery list itself: every file handed to the runner must come back
 * with its own summary. There is deliberately NO expected-total constant —
 * adding a test file raises the floor by itself, and nothing has to be bumped.
 *
 * Returns `{ message, missing, discovered, completed, tests, suites }`, with
 * `message` null when coverage is sound.
 */
export function assertEverySuiteCompleted(discoveredFiles, records) {
  const discovered = discoveredFiles.length
  if (records === null) {
    return {
      message: 'the run produced no suite-coverage record at all, so there is no evidence '
        + `any of the ${discovered} discovered file(s) finished.`,
      missing: discoveredFiles, discovered, completed: 0, tests: 0, suites: 0,
    }
  }
  const finished = new Set(records.map(record => path.resolve(record.file)))
  const missing = discoveredFiles.filter(file => !finished.has(path.resolve(file)))
  const tests = records.reduce((total, record) => total + (record.tests ?? 0), 0)
  const suites = records.reduce((total, record) => total + (record.suites ?? 0), 0)
  const result = {
    message: null, missing, discovered, completed: finished.size, tests, suites,
  }
  if (missing.length > 0) {
    result.message = `${missing.length} of ${discovered} discovered test file(s) never reported a `
      + 'completed suite, so the run covered less than it discovered. Each either ended early or '
      + 'defines no tests at all — both mean the file verified nothing:'
  }
  return result
}

const USAGE = `Usage: node scripts/testing/run-backend-tests.mjs [options]

Options:
  --only <substring>   Run backend test files whose names contain the substring (repeatable)
  --only=<substring>   Equivalent inline form
  --probe              Run the single hermetic harness probe
  --fail-after-setup   Stop after sandbox setup (harness self-test)
  --help               Show this help without creating a sandbox or running tests`

// Importing this module (a test reaching for `assertSummaryAgrees`,
// `assertEverySuiteCompleted` or `selectOnly`) must NOT launch the backend
// suite as a side effect.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let options = null
  try {
    options = parseBackendTestArgs(process.argv.slice(2))
  } catch (error) {
    // A BAD COMMAND LINE is the only thing that prints the usage text and
    // exits 2. Everything else — a missing fixture root, a snapshot that
    // cannot be taken, a refused override — is a RUN THAT FAILED, and it is
    // reported as one, so nobody reads a broken gate as a mistyped flag.
    console.error(`[test-harness] ${error instanceof Error ? error.message : String(error)}`)
    console.error(USAGE)
    process.exitCode = 2
  }
  if (options) {
    if (options.help) {
      console.log(USAGE)
    } else {
      try {
        await run(options)
      } catch (error) {
        console.error(`[test-harness] ${error instanceof Error ? error.message : String(error)}`)
        process.exitCode = 1
      }
    }
  }
}
