/**
 * NEW-11 — the checkout's own `package.json` must still be the SOURCE manifest.
 *
 * WHAT ACTUALLY HAPPENED (root cause found 2026-09-26, after it recurred).
 *
 * NEW-11 was recorded as "packaging rewrote the checkout's root package.json into its
 * trimmed shape (no `scripts`, no `devDependencies`)". That diagnosis was wrong, and the
 * guard built for it (`snapshotSourceManifests` / `restoreSourceManifests` in
 * `scripts/release/release-utils.mjs`) never fired — during a real 1.4.225 `dist:smoke`
 * it reported no rewrite at all, because electron-builder had not touched the file.
 *
 * The real cause is an INSPECTION command, not a build step:
 *
 *     npx asar extract-file "<app>.app/Contents/Resources/app.asar" package.json
 *
 * `asar extract-file` writes the named file into the CURRENT WORKING DIRECTORY. Run from
 * the repository root, that overwrites the source manifest with the packaged one — which
 * is exactly the observed shape: `scripts` and `devDependencies` gone, `\u2014` unescaped,
 * no trailing newline. It was reproduced on demand from a clean tree, twice.
 *
 * WHY THIS TEST EXISTS RATHER THAN A BETTER GUARD AROUND THE BUILD. The build was never
 * the problem, so a build-scoped guard cannot catch it. Anything that can rewrite the file
 * — a build, a stray command, a tool a future session runs to answer "what shipped?" — is
 * caught by asserting the file's SHAPE after the fact, which is cheap and cannot be evaded
 * by putting the write somewhere else.
 *
 * WHAT IT CANNOT CATCH: it runs when the suite runs, so a checkout can sit broken between
 * the write and the next gate. It also says nothing about `package-lock.json` (a different
 * shape, and `npm ci` will complain loudly on its own).
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const manifest = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))

describe('the checkout keeps its SOURCE package.json, not the packaged one', () => {
  test('the scripts block is still there', () => {
    // The packaged shape drops this entirely, which is what silently breaks every
    // `npm run …` in the checkout until somebody restores the file by hand.
    assert.ok(manifest.scripts && typeof manifest.scripts === 'object',
      'package.json has no `scripts` — it has been overwritten by a packaged manifest (NEW-11)')
    assert.ok(Object.keys(manifest.scripts).length > 0,
      '`scripts` is present but empty — this is the packaged shape (NEW-11)')
  })

  test('the gate commands this repository is driven by are all still declared', () => {
    for (const name of ['test:backend', 'build', 'dist:smoke', 'check:changelog', 'typecheck']) {
      assert.equal(typeof manifest.scripts[name], 'string',
        `\`npm run ${name}\` is gone from package.json (NEW-11)`)
    }
  })

  test('devDependencies survive — a packaged manifest has none', () => {
    assert.ok(manifest.devDependencies && typeof manifest.devDependencies === 'object',
      'package.json has no `devDependencies` — the packaged shape (NEW-11)')
    assert.ok(manifest.devDependencies.electron,
      '`electron` is missing from devDependencies — the packaged shape (NEW-11)')
  })

  test('the description keeps its escaped em-dash, which round-tripping strips', () => {
    // A JSON.parse/stringify round trip turns `\u2014` into a literal em-dash. The source
    // file is stored escaped; the packaged copy is not. This is the finest-grained signal
    // that the file was rewritten rather than edited.
    const raw = readFileSync(path.join(repoRoot, 'package.json'), 'utf8')
    assert.match(raw, /\\u2014/,
      'the escaped em-dash is gone — package.json was round-tripped through JSON (NEW-11)')
  })
})
