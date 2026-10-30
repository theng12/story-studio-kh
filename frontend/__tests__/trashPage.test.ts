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
  assert.match(layout, /<NuxtLink to="\/trash" class="nav-item"/, 'Trash is an ordinary sidebar row (v1.4.371)')
})

test('Empty Trash is retired (2026-10-16): the page never calls /trash/empty; Delete all permanently replaces it', () => {
  assert.doesNotMatch(page, /\/trash\/empty|emptyTrash|EMPTY TRASH/)
  assert.match(page, /\nonMounted\(load\)\n/, 'on load it only lists')
})

// 2026-10-16: the mini is managed remotely. Free up space summary, Move to macOS Trash and
// Delete permanently (selected or all), each behind a confirmation that shows count and bytes.
test('Free up space shows total, item count and the oldest item, with both actions for selected items and for all', () => {
  assert.match(page, /<h2 id="free-space-title">Free up space<\/h2>/)
  assert.match(page, /formatBytes\(listing\.total_bytes\) \}\}<\/strong> in \{\{ listing\.items_total \}\}/)
  assert.match(page, /oldest: \{\{ baseName\(listing\.oldest\.path\) \}\}/)
  for (const [action, scope] of [['macos', 'selected'], ['macos', 'all'], ['delete', 'selected'], ['delete', 'all']]) {
    assert.match(page, new RegExp(`@click="ask\\('${action}', '${scope}'\\)"`))
  }
  assert.match(page, /v-model="selected" type="checkbox"/)
})

test('the confirmation shows count and bytes, and Delete sends exactly those figures for the server to re-measure', () => {
  assert.match(page, /`Delete \$\{countLabel\(pending\.count\)\} \(\$\{formatBytes\(pending\.bytes\)\}\) permanently\?/)
  assert.match(page, /`Move \$\{countLabel\(pending\.count\)\} \(\$\{formatBytes\(pending\.bytes\)\}\) to the Mac's Trash\?/)
  assert.match(page, /'\/trash\/delete-permanently', \{ ids: p\.ids, confirm: true, expected_count: p\.count, expected_bytes: p\.bytes \}/)
  assert.match(page, /'\/trash\/macos-trash', \{ ids: p\.ids, expected_count: p\.count, expected_bytes: p\.bytes \}/)
  assert.equal(page.match(/\/trash\/delete-permanently/g)?.length, 1, 'one call site, from the confirmation only')
  assert.match(page, /@click="runPending"/)
  assert.doesNotMatch(page.slice(page.lastIndexOf('onMounted(')), /runPending|delete-permanently|macos-trash/, 'never on load')
})
