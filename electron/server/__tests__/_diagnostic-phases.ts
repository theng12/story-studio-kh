import { writeSync } from 'node:fs'
import { after, afterEach, beforeEach } from 'node:test'

export const diagnosticsEnabled = process.env.STORY_STUDIO_TEST_DIAGNOSTICS === '1'

/** Synthetic test evidence only: never pass provider payloads or credentials here. */
export function diagnosticEvent(phase: string, details: Record<string, unknown> = {}): void {
  if (!diagnosticsEnabled) return
  writeSync(2, `[story-test-diagnostic] ${JSON.stringify({
    pid: process.pid, at: new Date().toISOString(), monotonic_ms: performance.now(), phase, ...details,
  })}\n`)
}

export async function diagnosticPhase<T>(
  phase: string,
  work: () => T | PromiseLike<T>,
  native?: { file: string; args?: string[] },
): Promise<T> {
  if (!diagnosticsEnabled) return work()
  const start = performance.now()
  diagnosticEvent(`${phase}:start`, native)
  try {
    const result = await work()
    diagnosticEvent(`${phase}:end`, { elapsed_ms: performance.now() - start })
    return result
  } catch (error) {
    const failure = error as { cmd?: string; status?: number; code?: string | number; signal?: string; stdout?: string | Buffer; stderr?: string | Buffer }
    diagnosticEvent(`${phase}:failed`, {
      elapsed_ms: performance.now() - start,
      ...(native ? {
        command: failure.cmd, status: failure.status, code: failure.code, signal: failure.signal,
        stdout: failure.stdout?.toString(), stderr: failure.stderr?.toString(),
      } : {}),
    })
    throw error
  }
}

/** These markers are observations; only the existing parent runner judges settlement/pass. */
export function installDiagnosticHooks(file: string): void {
  if (!diagnosticsEnabled) return
  diagnosticEvent('file-loaded', { file })
  beforeEach(t => { diagnosticEvent('beforeEach-observed', { file, test: t.name }) })
  afterEach(t => { diagnosticEvent('afterEach-observed', { file, test: t.name }) })
  after(() => { diagnosticEvent('file-after-hook-observed', { file, resources: process.getActiveResourcesInfo() }) })
  process.once('beforeExit', code => {
    diagnosticEvent('process-before-exit', { file, code, resources: process.getActiveResourcesInfo() })
  })
  process.once('exit', code => { diagnosticEvent('process-exit', { file, code }) })
}
