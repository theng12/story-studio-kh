import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const source = readFileSync(
  fileURLToPath(new URL('../components/WhatsNewModal.vue', import.meta.url)),
  'utf8',
)

test("What's New keeps the current release fully readable and expands older long releases", () => {
  assert.match(source, /size="xxl"/)
  assert.match(source, /dialog-class="whats-new-dialog"/)
  assert.match(source, /entry\.version === currentVersion\.value/)
  assert.match(source, /View full release/)
  assert.match(source, /Show less/)
  assert.match(source, /View all releases/)
  assert.match(source, /View 500 more releases/)
  assert.match(source, /offset=\$\{offset\}/)
  assert.match(source, /max-height: calc\(100dvh - 230px\)/)
})
