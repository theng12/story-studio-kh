import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const helper = new URL('../../../electron/server/__tests__/_diagnostic-phases.ts', import.meta.url).href

function runDiagnosticFixture(enabled) {
  return spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import assert from 'node:assert/strict'
    import { test } from 'node:test'
    import { diagnosticPhase, installDiagnosticHooks } from ${JSON.stringify(helper)}
    installDiagnosticHooks('synthetic-diagnostic-fixture')
    test('return values and original errors survive observation', async () => {
      assert.equal(await diagnosticPhase('value', () => 42), 42)
      const failure = Object.assign(new Error('synthetic refusal'), {
        status: 1, cmd: '/synthetic/tool attach', stdout: Buffer.from('synthetic output'),
        stderr: Buffer.from('synthetic permission denied'),
      })
      await assert.rejects(diagnosticPhase('native', () => { throw failure }, {
        file: '/synthetic/tool', args: ['attach'],
      }), error => error === failure)
    })
  `], {
    cwd: root,
    env: { ...process.env, STORY_STUDIO_TEST_DIAGNOSTICS: enabled ? '1' : '0' },
    encoding: 'utf8',
  })
}

test('diagnostic observation is silent when disabled and preserves results/errors', () => {
  const result = runDiagnosticFixture(false)
  assert.equal(result.status, 0, result.stderr || result.error?.message)
  assert.doesNotMatch(result.stderr, /story-test-diagnostic/)
})

test('enabled diagnostics preserve native refusal and distinguish hooks from process exit', () => {
  const result = runDiagnosticFixture(true)
  assert.equal(result.status, 0, result.stderr || result.error?.message)
  const events = result.stderr.split('\n').filter(line => line.startsWith('[story-test-diagnostic] '))
    .map(line => JSON.parse(line.slice('[story-test-diagnostic] '.length)))
  const failure = events.find(event => event.phase === 'native:failed')
  assert.equal(failure.command, '/synthetic/tool attach')
  assert.equal(failure.status, 1)
  assert.equal(failure.stderr, 'synthetic permission denied')
  assert.equal(failure.stdout, 'synthetic output')
  assert.ok(failure.elapsed_ms >= 0)
  for (const phase of ['file-loaded', 'beforeEach-observed', 'afterEach-observed', 'file-after-hook-observed', 'process-before-exit', 'process-exit']) {
    assert.ok(events.some(event => event.phase === phase), `missing ${phase}`)
  }
  assert.equal(events.at(-1).phase, 'process-exit')
  assert.ok(events.every(event => Number.isFinite(event.monotonic_ms) && Number.isInteger(event.pid)))
})
