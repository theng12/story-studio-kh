import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

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
