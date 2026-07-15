import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const settingsPath = fileURLToPath(new URL('../pages/projects/[slug]/settings.vue', import.meta.url))
const source = readFileSync(settingsPath, 'utf8')

test('Hub connection has an explicit save/test action and persistent feedback', () => {
  assert.match(source, /Save & test connection/)
  assert.match(source, /Test saved connection/)
  assert.match(source, /Unsaved changes/)
  assert.match(source, /Saved & verified/)
  assert.doesNotMatch(source, /setTimeout\(\(\) => \{ hubSavedNote\.value = ''/)
})

test('local Hub and direct-fallback responsibilities are explained accurately', () => {
  assert.match(source, /local Hub connection, so Story Studio needs no access token/)
  assert.match(source, /Studio Hub manages the private fleet credential/)
  assert.match(source, /Direct Studio URLs are used only as an emergency fallback when the Hub itself cannot be reached/)
})
