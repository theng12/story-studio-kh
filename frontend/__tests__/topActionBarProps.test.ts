import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// `loading-label` is not a TopActionBar prop (it is `generate-loading-label`), so it
// fell through to the root element and never rendered.
test('no page passes a dead loading-label attribute', () => {
  const dir = join(import.meta.dirname, '..', 'pages', 'projects', '[slug]')
  for (const f of readdirSync(dir).filter(n => n.endsWith('.vue'))) {
    assert.doesNotMatch(readFileSync(join(dir, f), 'utf8'), /^\s*:?loading-label=/m, f)
  }
})
