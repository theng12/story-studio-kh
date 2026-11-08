import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

// The release lane discovers this file, so the proof helper and publisher changes are covered
// by a real contract in the canonical release test set.  The Python suites stay runnable on
// their own, and no publisher module is imported here (it reads credentials at import time).
const CASES = [
  { name: 'schema-1 gate proof', file: 'scripts/release/orchestration/test_story_gate_proof.py', tests: 21 },
  { name: 'schema-2 composite proof', file: 'scripts/release/orchestration/test_story_composite_proof.py', tests: 24 },
]

for (const item of CASES) {
  test(`offline ${item.name} suite`, () => {
    const result = spawnSync('python3', ['-I', '-B', item.file], {
      cwd: ROOT,
      encoding: 'utf8',
      // Python's own tests use tempfile and throwaway git repos.  Keep bytecode out of the
      // checkout and let the lane's sandbox HOME/TMPDIR stand.
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      timeout: 120_000,
    })
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
    assert.equal(result.error, undefined,
      `${item.name}: spawn failed: ${result.error?.message}\n${output}`)
    assert.equal(result.status, 0, `${item.name}: python exit ${result.status}\n${output}`)
    assert.match(output, new RegExp(`Ran ${item.tests} tests`),
      `${item.name}: expected ${item.tests} tests\n${output}`)
    assert.match(output, /^OK$/m, `${item.name}: no OK summary\n${output}`)
    assert.doesNotMatch(output, /^FAILED/m, `${item.name}: suite failed\n${output}`)
  })
}
