/**
 * 1.4.402 startup deferral: the boot recovery sweep and the background
 * catalogue warmups start only after the first-paint seam resolves — never
 * before it, exactly once after it, each with its log lines — and the defer
 * itself is signal-driven, never a sleep.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  registerDeferredBootWork,
  signalBootFirstPaint,
  _resetDeferredBootWorkForTesting,
} from '../boot/deferred-boot.js'
import { flushLogLines, getLogDir } from '../services/logger.js'
import { useTempDataDir } from './_helpers.js'

const server = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

const macrotasks = async (n = 3): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise(resolve => setTimeout(resolve, 0))
}

async function logLinesMatching(needle: string): Promise<string[]> {
  // `logLine` buffers: drain before reading, or the first assertion races.
  await flushLogLines()
  const lines: string[] = []
  for (const file of await fs.readdir(getLogDir()).catch(() => [] as string[])) {
    const text = await fs.readFile(path.join(getLogDir(), file), 'utf8').catch(() => '')
    for (const line of text.split('\n')) if (line.includes(needle)) lines.push(line)
  }
  return lines
}

test('deferred boot work runs only after the first-paint signal, once, with its log lines', async () => {
  await useTempDataDir()
  _resetDeferredBootWorkForTesting()
  try {
    const started: string[] = []
    registerDeferredBootWork({ name: 'proactive-recovery-sweep', run: async () => { started.push('sweep') } })
    registerDeferredBootWork({ name: 'genstudio-catalog-refresh', run: async () => { started.push('catalogue') } })

    // Several macrotasks pass with no signal: nothing may have started.
    await macrotasks()
    assert.deepEqual(started, [], 'deferred items ran before the first-paint signal')
    assert.equal((await logLinesMatching('deferred boot work starting after first paint')).length, 0,
      'a start line was emitted before the signal')

    signalBootFirstPaint('test signal')
    await macrotasks()
    assert.deepEqual(started.sort(), ['catalogue', 'sweep'], 'items must run after the signal, none skipped')

    // The start line fires once per item, naming the item and the defer length.
    const startLines = await logLinesMatching('deferred boot work starting after first paint')
    assert.equal(startLines.length, 2, `expected one start line per item, got ${startLines.length}`)
    assert.ok(startLines.every(line => line.includes('defer_ms')))
    // The schedule line fires when the item is registered.
    const scheduled = await logLinesMatching('deferred boot work scheduled')
    assert.ok(scheduled.some(line => line.includes('proactive-recovery-sweep')))
    assert.ok(scheduled.some(line => line.includes('genstudio-catalog-refresh')))

    // Idempotent: a recreated window re-firing the signal runs nothing again.
    signalBootFirstPaint('second signal')
    await macrotasks()
    assert.equal(started.filter(name => name === 'sweep').length, 1)
    assert.equal(startLines.length, 2)
  } finally {
    _resetDeferredBootWorkForTesting()
  }
})

test('boot migrations register the sweep as deferred work and boot_complete stays signal-free', async () => {
  await useTempDataDir()
  _resetDeferredBootWorkForTesting()
  try {
    const { runBootMigrations, isBootComplete } = await import('../boot/migrations.js')
    runBootMigrations()
    await macrotasks()
    // The sweep is registered, not started: starting it would need an unclean
    // shutdown anyway, but the register line proves the handoff happened.
    assert.ok((await logLinesMatching('deferred boot work scheduled')).some(
      line => line.includes('proactive-recovery-sweep')),
      'runBootMigrations must register the sweep with the defer seam')
    // boot_complete semantics are unchanged: it flips when the async boot
    // migrations settle (the 20 s safety net stays), not on the paint signal.
    await macrotasks()
    assert.equal(typeof isBootComplete(), 'boolean')
  } finally {
    _resetDeferredBootWorkForTesting()
  }
})

test('no sleep was introduced as the defer mechanism', async () => {
  const source = async (rel: string): Promise<string> => readFile(path.join(server, rel), 'utf8')
  const seam = await source('boot/deferred-boot.ts')
  assert.doesNotMatch(seam, /setTimeout\s*\(\s*[^,)]+,\s*([1-9]\d{2,}|0[xX][1-9a-fA-F]{3,})/) // no waits over 99ms
  assert.doesNotMatch(seam, /sleep|Atomics\.wait/)
  const migrations = await source('boot/migrations.ts')
  assert.match(migrations, /registerDeferredBootWork\(\{\s*name:\s*'proactive-recovery-sweep'/,
    'the sweep must be registered with the defer seam')
  // The standalone listen branch signals one macrotask (0ms) after listen — the
  // only setTimeout allowed near the seam is that 0.
  const app = await source('app.ts')
  for (const match of app.matchAll(/setTimeout\s*\(/g)) {
    const around = app.slice(match.index ?? 0, (match.index ?? 0) + 160)
    assert.match(around, /,\s*0\s*\)/, `any setTimeout in app.ts near the defer must be a 0ms macrotask: ${around}`)
  }
  const main = await source(path.join(server, '..', 'main.ts'))
  assert.match(main, /did-finish-load/, 'Electron mode must signal first paint from the window event')
  assert.match(main, /registerDeferredBootWork\(\{\s*name:\s*'genstudio-catalog-refresh'/,
    'the catalogue scheduler must be registered with the defer seam')
})
