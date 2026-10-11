// 1.4.289: Story → Trash. Emptying is the owner's alone: a typed confirmation inside the page,
// never an automatic call, and the button stays disabled until the phrase matches.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const page = readFileSync(new URL('../pages/trash.vue', import.meta.url), 'utf8')
const layout = readFileSync(new URL('../layouts/dashboard.vue', import.meta.url), 'utf8')

test('the Trash page lists totals per channel and per kind, items with Restore, and is linked from every channel', () => {
  assert.match(page, /<h2>By channel<\/h2>/)
  assert.match(page, /<h2>By kind<\/h2>/)
  assert.match(page, /post<\{ restored_to: string \}>\('\/trash\/restore', \{ id: item\.id \}\)/)
  assert.match(layout, /<NuxtLink to="\/trash" class="sidebar-utility"/)
})

test('Empty Trash needs the typed phrase on the page; nothing else calls it', () => {
  assert.equal(page.match(/\/trash\/empty/g)?.length, 1, 'one call site')
  assert.match(page, /const PHRASE = 'EMPTY TRASH'/)
  assert.match(page, /:disabled="busy \|\| typed\.trim\(\) !== PHRASE" @click="emptyTrash"/)
  assert.match(page, /async function emptyTrash\(\) \{\n  if \(typed\.value\.trim\(\) !== PHRASE \|\| emptying\.value\) return/)
  assert.match(page, /\nonMounted\(load\)\n/, 'on load it only lists')
  assert.doesNotMatch(page.slice(page.lastIndexOf('onMounted(')), /emptyTrash/, 'never on load')
})
