import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { lstatSync } from 'node:fs'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { availableParallelism } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { TRASH_ROOT_ENV, assertSandboxedTrash, resolveTrashRoot, trashPath } from '../shared-paths.mjs'

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
 * Where retained fixtures live when nobody says otherwise: the trash root,
 * named directly instead of through a checkout link the owner can empty.
 * Live test work never sits here — only completed containers are moved in.
 */
export const DEFAULT_RETAINED_FIXTURES = trashPath('test-fixtures')

/**
 * The override: where retained fixtures live when the operator says so.
 *
 * This variable names a permanent home for the evidence instead of the
 * disposable trash. It is VALIDATED, not trusted — an exact absolute path, a
 * real directory that is not itself a symbolic link, resolved to its canonical
 * form, outside the repository, on the checkout's volume. The default follows
 * the same no-links rule through `resolveTrashRoot`.
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
  if (configured === undefined || configured === '') {
    await resolveTrashRoot(env)
    return DEFAULT_RETAINED_FIXTURES
  }
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
  const trashRoot = await resolveTrashRoot(env)
  if (workRoot.split(path.sep).includes('_trash') && workRoot.startsWith(trashRoot)) {
    throw new Error(`${WORK_ROOT_ENV} must stay outside _trash: ${workRoot}`)
  }
  await fs.mkdir(workRoot, { recursive: true, mode: 0o700 })
  const leaf = await fs.lstat(workRoot)
  if (!leaf.isDirectory() || leaf.isSymbolicLink()) {
    throw new Error(`${WORK_ROOT_ENV} must name a real directory: ${workRoot}`)
  }
  const canonical = await fs.realpath(workRoot)
  if (canonical === trashRoot || canonical.startsWith(`${trashRoot}${path.sep}`)) {
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

export const RETAIN_SUCCESSFUL_ENV = 'STORY_STUDIO_RETAIN_SUCCESSFUL_FIXTURES'

// Retained snapshots are deliberately read-only (0500/0400); unlinking only
// needs owner write on their directories, never on the files or symlinks.
async function restoreOwnerWrite(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) await restoreOwnerWrite(path.join(dir, entry.name))
  }
  await fs.chmod(dir, 0o700)
}

/**
 * Release the bulky sandbox/snapshots of a SUCCESSFUL run, keeping the small
 * report bytes the lane return and the gate still read: suite-coverage*.jsonl
 * is lifted out of each sandbox to the container root first. Runs that failed,
 * threw, refused or never reconciled never reach here — they keep every byte.
 * STORY_STUDIO_RETAIN_SUCCESSFUL_FIXTURES=1 opts a successful run back into
 * full retention for debugging (default off: reclamation).
 */
async function releaseSuccessfulRunBulk(retained) {
  const bulky = (await fs.readdir(retained)).filter(name =>
    name === 'sandbox' || name === 'snapshots'
    || name.startsWith('sandbox-') || name.startsWith('snapshots-'))
  for (const name of bulky) {
    const dir = path.join(retained, name)
    if (name.startsWith('sandbox')) {
      const reports = (await fs.readdir(dir)).filter(entry => /^suite-coverage.*\.jsonl$/.test(entry))
      for (const file of reports) await fs.rename(path.join(dir, file), path.join(retained, file))
    }
    // Best effort: the rm below keeps its own EACCES handling and evidence.
    try {
      await restoreOwnerWrite(dir)
    } catch { /* a tree we cannot chmod stays retained rather than failing the run */ }
    await fs.rm(dir, { recursive: true, force: true })
  }
  if (bulky.length > 0) {
    console.log(`[test-harness] released successful-run bulk evidence (${bulky.join(', ')}) under ${retained}`)
  }
}

/**
 * Move finished work into the retained root. `success` is an EXPLICIT claim
 * by the caller that the run settled: children closed, evidence reconciled,
 * exit 0. The default (omitted) is safe full retention, so an existing
 * three-argument call and any uncertain caller keep every byte.
 */
export async function retainSandbox(sandbox, fixtures, label = '', success = false) {
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
  if (success && process.env[RETAIN_SUCCESSFUL_ENV] !== '1') {
    // A failed release keeps whatever it could not remove rather than
    // turning a green run red; the report bytes are never in its path.
    try {
      await releaseSuccessfulRunBulk(retained)
    } catch (error) {
      console.error(`[test-harness] successful-run bulk release failed (evidence kept): ${error.message}`)
    }
  }
  return retained
}

export async function retainedFsEvidenceFailure(snapshotRoot) {
  try {
    const names = (await fs.readdir(snapshotRoot)).filter(name => /^manifest-.*\.jsonl$/.test(name)).sort()
    if (names.length === 0) return 'retained filesystem preload produced no process manifest'
    for (const name of names) {
      const raw = await fs.readFile(path.join(snapshotRoot, name), 'utf8')
      // An EMPTY manifest is a process that performed no retained-fixture
      // operation — the preload creates the file in every node child, including
      // the ones a test deliberately SIGKILLs (wedge-watch, orphan-reap,
      // video-encode-cancel), and a killed process cannot write its own
      // settlement. Empty is not missing evidence: every capture appends
      // `snapshot-verified` (or its refusal) BEFORE the operation it authorises,
      // so empty can only mean nothing happened in that process. A capture taken
      // and never settled still fails on the lock check below. This assertion
      // used to fail the whole gate on empty; 1.4.412 and 1.4.413 both lost runs
      // to it with every test passing.
      if (!raw) continue
      if (!raw.endsWith('\n')) return `${name} has a partial final line`
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

/**
 * Files that run ALONE, at concurrency 1, whatever the pool size.
 *
 * Owner decision, 2026-10-26: the backend gate may run its files in parallel
 * ("do all 4 if possible so it's faster"). A file belongs here for one of two
 * reasons, and its entry says which:
 *
 *   • MEASURED — it failed while other files were running and passed when rerun
 *     alone. That is the 2026-10-24 gate A run with zero failing tests.
 *   • DECLARED — the file asserts a WALL-CLOCK ceiling or an exact number of
 *     interval fires. Such an assertion is load-sensitive by construction: four
 *     workers on one machine is exactly the condition it was not written for, so
 *     running it in the pool would turn a product assertion into a bet on the
 *     machine. They are cheap (the whole declared list is under 15 s), so the
 *     pool loses nothing worth having.
 *
 * Anything that flakes in a proof run joins this list, and the run is repeated.
 */
export const SERIAL_TEST_FILES = [
  // DECLARED, 2026-11-20 — a REAL transfer of 5.5 minutes on purpose. The defect 1.4.415 fixes was a
  // 300 s wall clock; a mocked clock proves that the mock fires, not that a long transfer imports.
  'download-video-idle-bound.test.ts',
  // MEASURED, 2026-11-04 — ordinary subtitle recovery timed out in the pooled 379 gate; passed alone (1/1, exit 0, 15.9 s).
  'audio-subtitle-explicit-regeneration.test.ts',
  // MEASURED, 2026-10-31 — "serialises quote saves across Node processes" timed out on the persistence lock in the 1.4.372 pooled gate; passes alone.
  'content-store-commerce-state.test.ts',
  // MEASURED — bulk evidence is timed against wall clock, not a mocked one.
  'publishing-overview-bulk-evidence.test.ts',
  // MEASURED, 2026-11-15 — cached median 144.7 ms pooled, 71.9 ms alone; the owner's 100 ms budget is unchanged.
  'performance-budgets.test.ts',
  // MEASURED, 2026-08-28 — "Cannot read properties of undefined (reading 'watchedMtimes')" under load.
  'episode-status-warm-list.test.ts',
  // DECLARED — "expected <10s, took Nms" around real ffmpeg work.
  'ffmpeg-manager.test.ts',
  // DECLARED — a 600 ms ceiling on the pause guard interrupting a retry-after.
  'genstudio-image-admission-permit.test.ts',
  // DECLARED — a cancelled wait must be noticed inside 1.5 s.
  'genstudio-poll-backoff.test.ts',
  // DECLARED — a warm read must answer inside 2 s (jobs-read-latency, jobs-history).
  'jobs-read-latency.test.ts',
  'jobs-history.test.ts',
  // DECLARED — automatic chain handoffs and failed-child settlement must finish inside 2 s; pooled 375 gate hit that ceiling.
  'job-queue.test.ts',
  // MEASURED, 2026-10-27 — failed in the pooled sweep on 524254f5, passed alone (job-queue timing).
  'job-cancellation-reconciliation.test.ts',
  'private-render-owner-admission.test.ts',
  // MEASURED, 2026-10-27 — 3 subtests failed in serial gate A on 442a4900 under machine load, 14/14 alone.
  'video-assembly-remote-wait.test.ts',
  // MEASURED, 2026-10-28 — failed in the pooled sweep on a55c5f12 (load ~15), passed alone 73/15/34.
  'episode-media-cleanup.test.ts',
  'jobs-stream.test.ts',
  'job-queue-genstudio-resume.test.ts',
  // MEASURED, 2026-11-04 — "returns measured Trash totals while free-space measurement remains in flight" failed in the pooled 380 gate (30 ms timeout, expected 24/24, got null/null); passed alone (6/6, exit 0, 1/1 file).
  'storage-space-summary-timeout.test.ts',
  // MEASURED, 2026-11-05 — "concurrent child processes retain both a provider update and a dedicated anchor append" timed out in the pooled 382 R3 gate: the parent polled 217 times over 2625 ms wall clock (test frame 3586 ms) against a 2586 ms scheduled-time budget waiting for a cold node+tsx child to boot, which waitFor's budget cannot credit — it measures the WAITING process's scheduling, not the child's. The same file then passed 5 of 5 alone (33/33, exit 0, ~12 s each). It holds two real child processes.
  'app-secrets-store-hardening.test.ts',
  // MEASURED, 2026-11-06 — flushProjectNow hydration failed in pooled 383 R3; unchanged file passed alone (29/29, 1/1 file, exit 0).
  'episode-status-cache.test.ts',
  // MEASURED, 2026-11-06 — external-final appearance timed out in pooled 383 R6; unchanged file passed alone (1/1 test, 1/1 file, exit 0).
  'episode-status-external-final-watch.test.ts',
  // MEASURED, 2026-11-07 — native chain handoff timed out in pooled 384 r11; unchanged file passed alone (17/17, 1/1 file, exit 0).
  'pipeline-handoff-lifecycle.test.ts',
  // MEASURED, 2026-11-07 — failed pooled R1 and passed unchanged alone; AGENTS §10 requires measured flakes serialized.
  'generation-paid-replacement.test.ts',
]

/**
 * Extra names for the serial list, comma separated, for an operator who needs a
 * file alone without editing this script.
 *
 * ADDITIVE ONLY, on purpose: the environment can make the run more cautious and
 * can never make it less. A variable that could empty this list would be a way
 * to quietly undo a measured decision, which is exactly what the list exists to
 * prevent — and it is also how the harness proves the split path without paying
 * for a slow process-and-timer fixture.
 */
export const SERIAL_TEST_FILES_ENV = 'STORY_STUDIO_BACKEND_SERIAL_TESTS'
export function serialTestFileNames(env = process.env) {
  const extra = (env[SERIAL_TEST_FILES_ENV] ?? '')
    .split(',')
    .map(name => name.trim())
    .filter(Boolean)
  return [...new Set([...SERIAL_TEST_FILES, ...extra])]
}

/**
 * How many test processes run at once — the POOL size, which is not the same
 * thing as a single runner's `--test-concurrency`.
 *
 * Owner asked for "all 4 if possible". The default is four on any machine with
 * cores to spare, two on a small one, and never more than half the cores: the
 * files that stay in the pool still need a processor to land on, and a machine
 * running four suites plus its own apps is exactly the machine that produced the
 * 2026-10-24 gate A run with zero failing tests.
 */
export const BACKEND_TEST_WORKERS_ENV = 'STORY_STUDIO_BACKEND_TEST_WORKERS'
export function backendTestWorkers(env = process.env, cores = availableParallelism()) {
  const configured = Math.floor(Number(env[BACKEND_TEST_WORKERS_ENV]))
  if (Number.isFinite(configured) && configured > 0) return Math.min(configured, 32)
  return Math.max(1, Math.min(4, Math.floor(cores / 2) || 1))
}

/**
 * Scheduling hints, in milliseconds, measured in the 1.4.359 full gate.
 *
 * These decide WHICH worker a file starts on and nothing else. They are not a
 * threshold, a budget or an assertion: a file that gets slower, faster or
 * disappears changes the balance and nothing else, and no run can fail because
 * one of these numbers went stale. They exist because an alphabetical split puts
 * the 650 s YouTube route beside three light files and the pool then finishes at
 * the speed of its unluckiest worker.
 */
export const SLOW_FILE_HINT_MS = {
  'youtube-upload-center-route.test.ts': 649_500,
  'final-render-import.test.ts': 209_600,
  'episode-media-cleanup.test.ts': 199_700,
  'paid-image-replacement-integration.test.ts': 167_100,
  'closing-tail-remix.test.ts': 154_900,
  'subtitle-recovery-engine.test.ts': 148_300,
  'final-render-monitor.test.ts': 123_400,
  'final-render-sealed-transport.test.ts': 116_600,
  'audio-dead-result-fresh-request.test.ts': 96_500,
  'genstudio-client-boundary.test.ts': 67_900,
  'youtube-upload-generator.test.ts': 60_200,
  'scene-effect-preview-render.test.ts': 58_800,
  'youtube-publication-cache.test.ts': 55_400,
  'music-episode-routes.test.ts': 48_800,
  'content-pack-project-pins.test.ts': 40_400,
  'genstudio-image-retry-identity.test.ts': 39_300,
  'youtube-analytics-cache.test.ts': 39_200,
  'content-store-commerce-state.test.ts': 36_800,
  'youtube-publication-status.test.ts': 34_100,
}
/** What an unlisted file is assumed to cost when balancing, from that same gate. */
const BASELINE_FILE_MS = 5_500

/**
 * Split the discovered files into the pool and the serial list.
 *
 * A serial file the caller did not select (an `--only` run) is simply absent
 * from both groups.
 */
export function partitionTestFiles(files, serialNames = serialTestFileNames()) {
  const serial = new Set(serialNames)
  const parallel = []
  const alone = []
  for (const file of files) {
    if (serial.has(path.basename(file))) alone.push(file)
    else parallel.push(file)
  }
  return { parallel, alone }
}

/**
 * Deal the files out to `workers` chunks, longest first, each going to whichever
 * chunk is currently lightest.
 *
 * Longest-processing-time first: the four heaviest files land on four different
 * workers instead of one, which is the whole reason the hint table exists. Order
 * inside a chunk is alphabetical so a chunk's log still reads predictably.
 */
export function balanceChunks(files, workers) {
  const cost = file => SLOW_FILE_HINT_MS[path.basename(file)] ?? BASELINE_FILE_MS
  const ordered = [...files].sort((a, b) => {
    const difference = cost(b) - cost(a)
    return difference !== 0 ? difference : a.localeCompare(b)
  })
  const chunks = Array.from({ length: Math.max(1, workers) }, () => [])
  const loads = chunks.map(() => 0)
  for (const file of ordered) {
    const lightest = loads.indexOf(Math.min(...loads))
    chunks[lightest].push(file)
    loads[lightest] += cost(file)
  }
  return chunks.filter(chunk => chunk.length > 0).map(chunk => chunk.sort((a, b) => a.localeCompare(b)))
}

/**
 * The invocations this run will make: one process per worker, then the serial
 * list on its own afterwards.
 *
 * ONE CHUNK IS THE OLD RUNNER. With a single worker (a `--only` run, a small
 * machine, an explicit `STORY_STUDIO_BACKEND_TEST_WORKERS=1`) there is one
 * invocation with no label, no aggregate line and byte-identical output to the
 * pre-2026-10-26 serial runner.
 */
export function planInvocations(files, options = {}) {
  const workers = options.workers ?? backendTestWorkers()
  const { parallel, alone } = partitionTestFiles(files, options.serialNames)
  const chunks = parallel.length > 0
    ? balanceChunks(parallel, Math.max(1, Math.min(workers, parallel.length)))
    : []
  const invocations = chunks.map((chunk, index) => ({
    label: chunks.length > 1 ? `worker-${index + 1}` : '',
    files: chunk,
    concurrency: 1,
  }))
  if (alone.length > 0) {
    if (invocations.length === 0) {
      invocations.push({ label: '', files: alone, concurrency: 1 })
    } else if (invocations.length === 1) {
      // One worker is a serial run: the serial list is already alone, so folding it
      // into the same invocation keeps `STORY_STUDIO_BACKEND_TEST_WORKERS=1` the
      // exact single-invocation shape the pre-2026-10-26 runner produced.
      invocations[0].files = [...invocations[0].files, ...alone].sort((a, b) => a.localeCompare(b))
    } else {
      invocations.push({ label: 'serial', files: alone, concurrency: 1 })
    }
  }
  return invocations
}

function announceInvocations(invocations) {
  if (invocations.length <= 1) return
  console.log(`[test-harness] running ${invocations.length} invocation(s):`)
  for (const invocation of invocations) {
    console.log(`[test-harness]   • ${invocation.label}: ${invocation.files.length} file(s)`)
  }
}

function reportCoverageFailure(coverage) {
  console.error('[test-harness] ============== SUITE COVERAGE BELOW FLOOR ==============')
  console.error(`[test-harness] ${coverage.message}`)
  for (const name of coverage.missing) console.error(`[test-harness]   ✗ ${path.basename(name)}`)
  console.error('[test-harness] A file that never finished cannot have passed. Treating this run as a failure.')
  console.error('[test-harness] ========================================================')
}

/**
 * The summary lines the spec reporter prints, one contiguous block per run.
 *
 * They are HELD BACK and replayed once, together, when the invocation ends. Four
 * workers stream their tests into one log at the same time, so a summary printed
 * where it arrives would be interleaved with another worker's test lines and
 * would stop being a recognisable block — and `story_gate_proof.verify` reads
 * those blocks to certify the lane. Holding them back is the difference between
 * "four runs, each proven" and "four runs, none provable".
 */
const SUMMARY_LINE = /^[#ℹ]\s+(?:tests|suites|pass|fail|cancelled|skipped|todo)\s+\d+\s*$/

function forwarder(sink, onChunk) {
  let buffer = ''
  const held = []
  return {
    held,
    push(chunk) {
      onChunk?.(chunk)
      buffer += chunk
      let index
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (SUMMARY_LINE.test(line)) held.push(line)
        else sink.write(`${line}\n`)
      }
    },
    flush() {
      if (!buffer) return
      if (SUMMARY_LINE.test(buffer)) held.push(buffer)
      else sink.write(buffer)
      buffer = ''
    },
  }
}

/**
 * One node test-runner invocation: spawn it, stream it, judge it.
 *
 * Everything about a single invocation is unchanged from the serial runner — the
 * reporters, the piped transcript, the watchdog, the identifier checks around the
 * live work directories. Only the file list differs between invocations, which is
 * why the pool needs no second implementation of any of the proofs.
 *
 * `--test-concurrency=1` INSIDE an invocation on purpose: files are spread across
 * worker PROCESSES instead, so each worker owns one processor, one set of temp
 * directories and one log block. A worker that runs four files at once would
 * reintroduce exactly the load the serial list is quarrelling with.
 */
async function runInvocation(invocation, ctx) {
  const coveragePath = path.join(ctx.sandbox, `suite-coverage${invocation.label ? `-${invocation.label}` : ''}.jsonl`)
  const child = spawn(process.execPath, [
    '--import',
    ctx.tsxImport,
    '--test',
    `--test-concurrency=${invocation.concurrency}`,
    // NO `--test-force-exit`. See `startSuiteWatchdog` for what it was doing.
    // `spec` is already Node's default on this runtime; naming it explicitly
    // only makes room for the second reporter, and keeps the human output
    // identical if that default ever moves.
    '--test-reporter=spec',
    '--test-reporter-destination=stdout',
    `--test-reporter=${COVERAGE_REPORTER}`,
    `--test-reporter-destination=${coveragePath}`,
    ...invocation.files,
  ], {
    cwd: ELECTRON_ROOT,
    env: ctx.env,
    // v1.4.44 — piped rather than inherited so the summary can be READ.
    // See `assertSummaryAgrees` below for why the exit code alone is not
    // enough to know whether the suite passed.
    stdio: ['inherit', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })
  const diagnosticStart = performance.now()
  const diagnostic = (phase, details = {}) => {
    if (ctx.env.STORY_STUDIO_TEST_DIAGNOSTICS !== '1') return
    console.error(`[story-test-diagnostic] ${JSON.stringify({
      pid: process.pid, child_pid: child.pid, invocation: invocation.label, at: new Date().toISOString(),
      monotonic_ms: performance.now(), elapsed_ms: performance.now() - diagnosticStart, phase, ...details,
    })}`)
  }
  diagnostic('invocation-spawned', { files: invocation.files })
  child.once('close', (code, signal) => diagnostic('invocation-child-close', { code, signal }))
  let transcript = ''
  const stdout = forwarder(process.stdout, chunk => { transcript += chunk })
  const stderr = forwarder(process.stderr, chunk => { transcript += chunk })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => stdout.push(chunk))
  child.stderr.on('data', chunk => stderr.push(chunk))
  const watchdog = startSuiteWatchdog(child)
  const exitCode = await waitForSuiteChild(child, [ctx.workRoot, ctx.workContainer, ctx.sandbox, ctx.snapshotRoot])
    .finally(() => clearTimeout(watchdog))
  stdout.flush()
  stderr.flush()
  diagnostic('invocation-wait-returned', { exitCode, coveragePath, snapshotRoot: ctx.snapshotRoot })
  return { invocation, exitCode, transcript, coveragePath, snapshotRoot: ctx.snapshotRoot, summaryLines: [...stdout.held, ...stderr.held] }
}

/**
 * One invocation's own sandbox: its HOME, its config directories, its TMPDIR and
 * its retained-filesystem snapshot root.
 *
 * Workers run at the same time, so a shared HOME is a shared file — two suites
 * writing `app-settings.json` at once is the cross-talk this pool must not
 * introduce. The SNAPSHOT ROOT is separated for a harder reason:
 * `retained-fixture-fs.mjs` takes a lock file inside it around every `rename`,
 * `unlink`, `rm` and `rmdir`, and its synchronous path treats "already locked"
 * as a hard failure. One lock per process is what the serial runner had by
 * construction; four workers sharing one would fail each other on ordinary
 * atomic writes, so each worker gets its own.
 *
 * The configured projects root is NOT duplicated: it is the one directory the
 * runner promises never to touch, and every worker pointing at the same
 * read-only sentinel is what makes one byte-identical check enough.
 */
async function prepareInvocationSandbox(workContainer, label, configuredProjectsRoot) {
  const sandbox = path.join(workContainer, label ? `sandbox-${label}` : 'sandbox')
  const snapshots = path.join(workContainer, label ? `snapshots-${label}` : 'snapshots')
  const home = path.join(sandbox, 'home')
  const profile = path.join(sandbox, 'profile')
  const appData = path.join(sandbox, 'appdata')
  const xdgConfig = path.join(sandbox, 'xdg-config')
  const settings = { projects_root_override: configuredProjectsRoot }
  // 0o700 BEFORE anything is written into it: the retained-fixture guard refuses a
  // harness root that any other user could reach, and a directory created by the
  // first `writeJson` would be 0o755 under the default umask.
  await fs.mkdir(sandbox, { recursive: true, mode: 0o700 })
  await fs.chmod(sandbox, 0o700)
  await fs.mkdir(snapshots, { recursive: true, mode: 0o700 })
  await fs.chmod(snapshots, 0o700)
  await Promise.all([
    writeJson(path.join(home, 'Library', 'Application Support', 'Story Studio KH', 'app-settings.json'), settings),
    writeJson(path.join(appData, 'Story Studio KH', 'app-settings.json'), settings),
    writeJson(path.join(xdgConfig, 'Story Studio KH', 'app-settings.json'), settings),
  ])
  return { sandbox, snapshots, home, profile, appData, xdgConfig }
}

async function run(options) {
  let workContainer
  let sandbox
  let retainedFixtures
  // True only after every check reconciled and exit 0: a throw, a refusal or
  // a nonzero exit leaves this false, so the finally retains every byte.
  let settledSuccess = false
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
    const baseSnapshots = path.join(workContainer, 'snapshots')
    await fs.mkdir(sandbox, { mode: 0o700 })
    await fs.mkdir(baseSnapshots, { mode: 0o700 })
    // Preflight checks that the retained root is on the same device, so the
    // end-of-run move stays a rename. If the retained root is missing, we
    // create it here; if it disappears mid-run, the run continues unaffected.
    await preflightSandboxRetention(sandbox, retainedFixtures)
    const configuredProjectsRoot = path.join(sandbox, 'configured-projects')
    const sentinelProject = path.join(configuredProjectsRoot, 'owner-sentinel')

    await fs.mkdir(sentinelProject, { recursive: true })
    await fs.writeFile(path.join(sentinelProject, 'jobs.json'), '{"jobs":[{"job_id":"owner-record","status":"done"}]}\n')
    await fs.writeFile(path.join(sentinelProject, 'owner-marker.txt'), 'must remain byte-identical\n')
    // The BASE sandbox gets the same three settings files the invocations later
    // (re)write for themselves — this is the one a failed setup retains, and the
    // harness's own self-test reads it back from the retained container.
    await Promise.all([
      writeJson(path.join(sandbox, 'home', 'Library', 'Application Support', 'Story Studio KH', 'app-settings.json'),
        { projects_root_override: configuredProjectsRoot }),
      writeJson(path.join(sandbox, 'appdata', 'Story Studio KH', 'app-settings.json'),
        { projects_root_override: configuredProjectsRoot }),
      writeJson(path.join(sandbox, 'xdg-config', 'Story Studio KH', 'app-settings.json'),
        { projects_root_override: configuredProjectsRoot }),
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
    const invocations = planInvocations(tests)
    announceInvocations(invocations)

    /**
     * One invocation's complete environment. Everything shared by the whole run
     * (the configured projects root, the retained snapshot root, the bundled
     * ffmpeg, preloads) comes from `process.env` plus the overrides below;
     * everything that must NOT be shared (HOME, TMPDIR, the app data dir, the
     * coverage file) comes from the invocation's own sandbox.
     */
    const invocationContext = async invocation => {
      const own = await prepareInvocationSandbox(workContainer, invocation.label, configuredProjectsRoot)
      await preflightSandboxRetention(own.sandbox, retainedFixtures)
      const env = {
        ...process.env,
        HOME: own.home,
        USERPROFILE: own.profile,
        APPDATA: own.appData,
        XDG_CONFIG_HOME: own.xdgConfig,
        TMPDIR: own.sandbox,
        TMP: own.sandbox,
        TEMP: own.sandbox,
        STORY_STUDIO_TEST_HARNESS_ROOT: own.sandbox,
        STORY_STUDIO_TEST_WORK_ROOT: workRoot,
        STORY_STUDIO_RETAINED_SNAPSHOT_ROOT: own.snapshots,
        // Same rule as the lane runner: the child's trash lives inside its sandbox, and the guard
        // refuses the owner's Desktop, .Trash or the checkout before anything can be written there.
        // Retained fixtures still go to the resolved default, which does not read this variable.
        [TRASH_ROOT_ENV]: assertSandboxedTrash(path.join(own.sandbox, 'trash'), { sandbox: own.sandbox }),
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
      delete env.STORY_STUDIO_DATA_DIR
      delete env.NODE_TEST_CONTEXT
      // A nested run always falls back to the resolved trash root: an outer override
      // must never decide where an inner run retains evidence (it may be a link).
      delete env.STORY_STUDIO_RETAINED_FIXTURES_ROOT
      return { env, sandbox: own.sandbox, snapshotRoot: own.snapshots, workRoot, workContainer, tsxImport }
    }

    // The pool runs at the same time; the serial list runs afterwards, on its own,
    // exactly the reason it is on the list.
    const pooled = invocations.filter(invocation => invocation.label !== 'serial')
    const alone = invocations.filter(invocation => invocation.label === 'serial')
    const contexts = new Map()
    for (const invocation of invocations) contexts.set(invocation, await invocationContext(invocation))

    let exitCode = 0
    // Every reason the run will exit non-zero, in the order they were found.
    // Printed as one sentence at the end: the reasons themselves appear above,
    // but a reader (and the gate's 12-line tail) sees only the summaries, so a
    // run used to finish with `rc=1` and no sentence saying why.
    const exitReasons = []
    const results = await Promise.all(pooled.map(invocation => runInvocation(invocation, contexts.get(invocation))))
    for (const invocation of alone) {
      results.push(await runInvocation(invocation, contexts.get(invocation)))
    }
    for (const result of results) {
      if (result.exitCode !== 0) {
        exitCode = result.exitCode
        exitReasons.push(`${result.invocation.label || 'the run'} exited ${result.exitCode}`)
      }
    }

    // Each worker snapshotted into its own root (see prepareInvocationSandbox), so
    // every root is reconciled and its result is attributed to the worker that
    // produced it — an unattributed "evidence incomplete" is a diagnosis nobody
    // can act on.
    const evidenceFailures = []
    for (const result of results) {
      const failure = await retainedFsEvidenceFailure(result.snapshotRoot)
      if (failure) {
        evidenceFailures.push(`${result.invocation.label ? `${result.invocation.label}: ` : ''}${failure}`)
      }
    }
    if (evidenceFailures.length > 0) {
      for (const failure of evidenceFailures) console.error(`[test-harness] ${failure}`)
      exitCode = 1
      exitReasons.push(...evidenceFailures)
    } else {
      console.log('[test-harness] retained filesystem evidence: complete')
    }

    for (const result of results) {
      // Replayed together so each invocation's summary stays one contiguous block.
      if (result.summaryLines.length > 0) process.stdout.write(`${result.summaryLines.join('\n')}\n`)
    }
    // Every invocation is judged on its own transcript and exit code, exactly as
    // the single invocation always was. A pool is not licence to trust one green
    // summary for four batches.
    for (const result of results) {
      const summary = assertSummaryAgrees(result.transcript, result.exitCode)
      if (summary) {
        console.error(`[test-harness] ${result.invocation.label}${result.invocation.label ? ': ' : ''}${summary}`)
        exitCode = 1
        exitReasons.push(summary)
      }
    }

    // The coverage floor, per invocation and then over everything discovered.
    // Checked even when the summary looked clean — a vanished file is INVISIBLE
    // to the summary, which is the whole point.
    const records = []
    let coverage = null
    for (const result of results) {
      const own = await readCoverageRecords(result.coveragePath)
      const lane = assertEverySuiteCompleted(result.invocation.files, own)
      console.log(`[test-harness] ${result.invocation.label ? `${result.invocation.label} ` : ''}suite coverage: `
        + `${lane.completed}/${lane.discovered} file(s) completed`
        + `, ${lane.tests} test(s) + ${lane.suites} suite(s) = ${lane.tests + lane.suites} marks`)
      if (lane.message) {
        reportCoverageFailure(lane)
        exitCode = 1
        exitReasons.push(lane.message)
      }
      if (own) records.push(...own)
    }
    coverage = assertEverySuiteCompleted(tests, records)
    if (invocations.length > 1) {
      // The line the gate reads for a partitioned lane (see summarize-step.mjs and
      // story_gate_proof.py): the aggregated floor, which the per-invocation lines
      // above must add up to exactly. Without it a partition could hide behind the
      // last lane's line and still look whole.
      console.log(`[test-harness] aggregate suite coverage: ${coverage.completed}/${coverage.discovered} file(s) completed`
        + `; inputs=[${invocations.map(invocation => invocation.label).join(',')}]`)
    }
    if (coverage.message) {
      reportCoverageFailure(coverage)
      exitCode = 1
      exitReasons.push(coverage.message)
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
      exitReasons.push('backend tests changed the isolated configured projects-root sentinel')
    }
    // The verdict, last: one sentence saying why this run exits non-zero, so a
    // tail (or a gate's 12-line failure summary) never shows a green-looking
    // coverage line and no reason.
    if (exitCode !== 0) {
      console.error(`[test-harness] EXIT ${exitCode}: ${exitReasons.join(' | ') || 'no reason was recorded'}`)
    }
    process.exitCode = exitCode
    settledSuccess = exitCode === 0
  } finally {
    // Retire only after the child closed and all evidence was reconciled.
    if (workContainer) {
      console.log(`[test-harness] finished work container: ${workContainer}`)
      await retainSandbox(workContainer, retainedFixtures, '', settledSuccess)
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
 *
 * THE DEFAULT IS 180 MINUTES BECAUSE 90 MINUTES WAS BELOW THE REAL RUNTIME.
 * Measured on this Mac: a serial backend lane takes 5,268–6,189 s (88–103 min),
 * the 1.4.359 gate's accepted run reported duration_ms 5,249,875 ms, and one
 * earlier 1.4.359 run took 7,534 s. The old 90-minute default sat UNDER the
 * ordinary case, so the watchdog became a second, silent failure mode: the
 * 1.4.359 gate A run was killed at 850 of 854 files with zero failing tests and
 * no summary, which reads as a product defect and is not one. 180 minutes clears
 * the slowest measured serial run by ~50 % and still bounds a genuinely hung
 * child. The lane now runs across worker processes, so each invocation gets its
 * own limit (expected ~30 min of work against it), and the serial list runs
 * under the same one.
 */
function startSuiteWatchdog(child) {
  const limitMs = Number(process.env.STORY_STUDIO_BACKEND_TEST_TIMEOUT_MS ?? 180 * 60_000)
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
