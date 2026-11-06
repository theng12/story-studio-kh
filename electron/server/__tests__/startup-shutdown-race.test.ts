import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'

// Execute the real startup catch without starting Electron or a native modal.
const source = fs.readFileSync(new URL('../../main.ts', import.meta.url), 'utf8')
const startupSource = source.slice(source.indexOf('void electronApp.whenReady()'))
const catchBody = startupSource.match(/\n  } catch \(e\) \{([\s\S]*?)\n  }\n}\)/)?.[1]
assert.ok(catchBody, 'main startup catch must be found')
const compiled = ts.transpileModule(
  `function handle(e: unknown, isShuttingDown: boolean, logCrash: Function, dialog: any, redactSecrets: Function, electronApp: any) {${catchBody}}`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText
const handle = new Function(`${compiled}; return handle`)() as (
  error: Error, shuttingDown: boolean, log: Function, dialog: object, redact: Function, app: object,
) => void

function observe(shuttingDown: boolean) {
  const calls: unknown[][] = []
  handle(new Error('ERR_FAILED (-2) loading initial page'), shuttingDown,
    (...args: unknown[]) => calls.push(['log', ...args]),
    { showErrorBox: (...args: unknown[]) => calls.push(['dialog', ...args]) },
    () => 'redacted startup error',
    { quit: () => calls.push(['quit']) })
  return calls
}

test('quit-cancelled startup does not open a native modal or re-enter quit', () => {
  assert.deepEqual(observe(true), [])
})

test('a real startup failure still logs, reports a redacted error, and quits', () => {
  const calls = observe(false)
  assert.deepEqual(calls.map(call => call[0]), ['log', 'dialog', 'quit'])
  assert.deepEqual(calls[1], ['dialog', 'Story Studio failed to start', 'redacted startup error'])
})

test('a late successful window load cannot start background services after shutdown', () => {
  const continuation = source.match(/await createWindow\(port\)([\s\S]*?)installJobNotifier\(\)/)?.[1]
  assert.ok(continuation)
  const run = new Function('isShuttingDown', 'installJobNotifier', `${continuation}; installJobNotifier()`)
  let installed = 0
  run(true, () => installed++)
  assert.equal(installed, 0)
  run(false, () => installed++)
  assert.equal(installed, 1)
})
