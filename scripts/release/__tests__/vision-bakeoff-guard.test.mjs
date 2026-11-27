/**
 * The vision bake-off refuses the owner's live Gateway, and this repo is
 * public — so the address is not written here. The guard therefore forbids the
 * whole Tailscale CGNAT range (100.64.0.0/10) instead of one literal; these
 * cases pin both edges of that range, prove a real address inside it is refused
 * by the tool itself, and prove it is still not reachable from source.
 *
 * The guard lives in TypeScript, so it is imported through the repo's own tsx
 * loader rather than compiled here; the tool is spawned as a program so its
 * real `main()` is exercised, not a copy of it.
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'

const run = promisify(execFile)
const repoRoot = resolve(import.meta.dirname, '..', '..', '..')
const tool = join('scripts', 'vision-bakeoff', 'bakeoff.ts')
/** Any address in the Tailscale overlay; the owner's live Gateway is one of these. */
const IN_RANGE = '100.100.5.6'

test('the Tailscale range is refused at its edges and not outside them', async () => {
  const probe = `
    const { isForbiddenHost } = await import('./${tool}')
    console.log(JSON.stringify([
      '100.64.0.0', '100.100.1.1', '100.127.255.255',
      '100.63.255.255', '100.128.0.0', '192.0.2.10', '10.0.0.1', 'gateway.local', '100.64.0',
    ].map(host => [host, isForbiddenHost(host)])))
  `
  const { stdout } = await run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', probe], { cwd: repoRoot })
  const lastLine = stdout.trim().split('\n').pop()
  const rows = JSON.parse(lastLine)
  const forbidden = rows.filter(([, refused]) => refused).map(([host]) => host)
  assert.deepEqual(forbidden, ['100.64.0.0', '100.100.1.1', '100.127.255.255'])
})

test('the tool itself refuses a Tailscale gateway before doing anything else', async () => {
  const result = await run(process.execPath, [
    '--import', 'tsx', tool,
    '--images', 'i', '--labels', 'l', '--models', 'm', '--key', 'k', '--gateway', `http://${IN_RANGE}:8787`,
  ], { cwd: repoRoot }).then(() => null, error => error)
  assert.ok(result, 'a Tailscale gateway must not run')
  assert.equal(result.code, 1)
  assert.match(result.stderr ?? '', /is the owner's live Gateway\. This tool never measures against it\./)
})
