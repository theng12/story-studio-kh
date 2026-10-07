/**
 * A colour token that is used but never defined makes its declaration silently do nothing:
 * `var(--danger)` left error text plain white on Publish and a dozen other pages. Every token
 * the app reads without a fallback must be defined somewhere.
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
function files(dir: string): string[] {
  return readdirSync(join(root, dir)).flatMap((name) => {
    const rel = join(dir, name)
    return statSync(join(root, rel)).isDirectory() ? files(rel) : /\.(vue|css)$/.test(name) ? [rel] : []
  })
}

test('every var(--token) used without a fallback is defined', () => {
  const sources = ['pages', 'components', 'layouts', 'assets'].flatMap(files).concat('app.vue').map(f => readFileSync(join(root, f), 'utf8'))
  const defined = new Set(sources.flatMap(s => [...s.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1])))
  const missing = new Set(sources.flatMap(s => [...s.matchAll(/var\((--[\w-]+)\s*\)/g)].map(m => m[1])).filter(t => !defined.has(t)))
  // Fonts fall back to the inherited family on purpose; colours must not.
  for (const font of ['--font-mono', '--font-display']) missing.delete(font)
  assert.deepEqual([...missing], [])
})
