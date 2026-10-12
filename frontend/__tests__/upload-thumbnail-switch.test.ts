import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

// 1.4.301 — the Upload button follows the channel's "Thumbnail present" safety check (Block by default).
test('Upload requires a thumbnail only when the channel\'s thumbnail check is Block', () => {
  const src = readFileSync(new URL('../pages/projects/[slug]/upload/publish.vue', import.meta.url), 'utf8')
  assert.match(src, /\/projects\/\$\{value\}\/safety-checks/)
  assert.match(src, /thumbnailRequired\.value = mode !== 'off' && mode !== 'warn'/)
  assert.match(src, /if \(thumbnailRequired\.value && \(previewed\.value\?\.thumbnail\.state !== 'selected'/)
  assert.match(src, /v-else-if="thumbnailRequired && \(previewed\.thumbnail\.state !== 'selected'/)
})
