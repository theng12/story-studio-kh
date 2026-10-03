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
  assert.match(source, /View Full Release/)
  assert.match(source, /Show Less/)
  assert.match(source, /View all releases/)
  // It loads the next page, whose size it does not know; it never promised "500 more" honestly.
  assert.match(source, /View older releases/)
  assert.doesNotMatch(source, /View 500 more releases/)
  assert.match(source, /offset=\$\{offset\}/)
  assert.match(source, /max-height: calc\(100dvh - 230px\)/)
})
