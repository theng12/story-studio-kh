import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
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
