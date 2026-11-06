import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// `loading-label` is not a TopActionBar prop (it is `generate-loading-label`), so it
// fell through to the root element and never rendered. Other valid components,
// such as ModelMenu, legitimately own a `loading-label` prop.
function hasDeadLoadingLabel(source: string): boolean {
  return [...source.matchAll(/<TopActionBar\b[\s\S]*?\/>/g)]
    .some(([tag]) => /(?:^|\s):?loading-label\s*=/.test(tag))
}

test('no page passes a dead loading-label attribute', () => {
  const dir = join(import.meta.dirname, '..', 'pages', 'projects', '[slug]')
  for (const f of readdirSync(dir).filter(n => n.endsWith('.vue'))) {
    const source = readFileSync(join(dir, f), 'utf8')
    assert.equal(hasDeadLoadingLabel(source), false, f)
  }
})

test('the dead-attribute guard inspects every TopActionBar tag only', () => {
  assert.equal(hasDeadLoadingLabel('<ModelMenu loading-label="Loading models…" />'), false)
  assert.equal(hasDeadLoadingLabel('<TopActionBar :generate-loading-label="checking" />'), false)
  assert.equal(hasDeadLoadingLabel('<TopActionBar loading-label="Saving…" />'), true)
  assert.equal(
    hasDeadLoadingLabel('<TopActionBar\n  :generate-loading-label="checking"\n/>\n<TopActionBar\n  :loading-label="saving"\n/>'),
    true,
  )
  assert.equal(
    hasDeadLoadingLabel('<TopActionBar\n  loading-label="Saving…"\n/>\n<TopActionBar />'),
    true,
  )
})
