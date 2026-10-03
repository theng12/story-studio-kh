import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const modal = readFileSync(fileURLToPath(new URL('../components/WhatsNewModal.vue', import.meta.url)), 'utf8')

// The dialog used to wait for the "seen" save before closing, so on a busy backend the
// button looked dead and needed a second click. It must close first and save in the background.
test("What's New closes on the first click and saves the seen version without waiting", () => {
  const close = modal.slice(modal.indexOf('function onClose()'), modal.indexOf('Tiny markdown renderer'))
  assert.match(close, /^function onClose\(\) \{[\s\S]*?modal\.close\(\)[\s\S]*?void put\('\/app-settings\/last-seen-version'/)
  assert.doesNotMatch(close, /await/)
})
