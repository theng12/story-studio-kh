import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const ELECTRON_ROOT = path.join(ROOT, 'electron')
const PROBE_PATH = path.join(ROOT, 'scripts', 'release', 'fixtures', 'hermetic-backend-probe.test.mjs')
// Preloaded into every backend test process so supertest binds the IPv4
// loopback address it then connects to. Without it a throwaway test server
// can be shadowed by any local daemon holding that port on 127.0.0.1, and
// the request is answered by the neighbour instead of the app under test.
// See scripts/testing/loopback-supertest.mjs for the full story.
const LOOPBACK_PRELOAD = path.join(ROOT, 'scripts', 'testing', 'loopback-supertest.mjs')

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
function parseOnly(argv) {
  const needles = []
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
      needles.push(value)
      i += 1
    } else if (arg.startsWith('--only=')) {
      const value = arg.slice('--only='.length)
      if (!value) throw new Error('--only needs a value, e.g. --only=image-episode')
      needles.push(value)
    }
  }
  return needles
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

function trustedTempDir() {
  const keys = ['TMPDIR', 'TMP', 'TEMP']
  if (process.platform === 'win32') keys.push('USERPROFILE')
  const saved = new Map(keys.map(key => [key, process.env[key]]))
  for (const key of keys) delete process.env[key]
  try {
    return os.tmpdir()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

async function run() {
  let sandbox
  try {
    sandbox = await fs.mkdtemp(path.join(trustedTempDir(), 'story-studio-backend-tests-'))
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
    if (process.argv.includes('--fail-after-setup')) {
      console.log(`[test-harness] sandbox: ${sandbox}`)
      throw new Error('intentional backend test harness setup failure')
    }
    const before = await snapshotTree(configuredProjectsRoot)

    const require = createRequire(import.meta.url)
    const tsxCli = require.resolve('tsx/cli')
    const onlyNeedles = parseOnly(process.argv)
    const allTests = process.argv.includes('--probe') ? [PROBE_PATH] : await backendTestFiles()
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
      STORY_STUDIO_DISABLE_LISTEN: '1',
      // `--import` rather than an argv flag: tsx re-spawns node for `--test`,
      // and NODE_OPTIONS is what survives that hop.
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import ${pathToFileURL(LOOPBACK_PRELOAD).href}`]
        .filter(Boolean).join(' '),
    }
    delete childEnv.STORY_STUDIO_DATA_DIR
    delete childEnv.NODE_TEST_CONTEXT

    const child = spawn(process.execPath, [
      tsxCli,
      '--test',
      '--test-concurrency=1',
      '--test-force-exit',
      ...tests,
    ], {
      cwd: ELECTRON_ROOT,
      env: childEnv,
      // v1.4.44 — piped rather than inherited so the summary can be READ.
      // See `assertSummaryAgrees` below for why the exit code alone is not
      // enough to know whether the suite passed.
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
      console.error(`[test-harness] ${summary}`)
      exitCode = 1
    }

    // Printed AGAIN after the results, because the line a reader scrolls to is
    // the summary — and a partial pass sitting under a full-looking summary is
    // exactly how a narrowed run gets mistaken for a green release gate.
    if (onlyNeedles.length > 0) announcePartialRun(onlyNeedles, tests, skippedCount, 'finished')

    const after = await snapshotTree(configuredProjectsRoot)
    const unchanged = before === after
    console.log(`[test-harness] configured projects root byte-identical: ${unchanged}`)
    if (!unchanged) {
      console.error('[test-harness] backend tests changed the isolated configured projects-root sentinel')
      exitCode = 1
    }
    process.exitCode = exitCode
  } finally {
    if (sandbox) await fs.rm(sandbox, { recursive: true, force: true })
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
    return `${failed} of ${tests} backend test(s) failed (reported exit code ${exitCode}).`
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

// Importing this module (a test reaching for `assertSummaryAgrees` or
// `selectOnly`) must NOT launch the backend suite as a side effect.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run()
}
