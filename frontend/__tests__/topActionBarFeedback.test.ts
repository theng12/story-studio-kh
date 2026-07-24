import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const source = readFileSync(
  fileURLToPath(new URL('../components/TopActionBar.vue', import.meta.url)),
  'utf8',
)

test('shared preset actions show pending, verified success, toast, and error feedback', () => {
  for (const label of ['Applying…', 'Saving…', 'Renaming…', 'Deleting…']) {
    assert.match(source, new RegExp(label))
  }
  for (const label of ['✓ Applied', '✓ Saved', '✓ Renamed', '✓ Deleted']) {
    assert.match(source, new RegExp(label))
  }
  assert.match(source, /runPresetAction/)
  assert.match(source, /showSuccess\(message\)/)
  assert.match(source, /showError\(errorMessage/)
  assert.match(source, /preset-action-success/)
})

test('save-as and rename modals stay open unless persistence succeeds', () => {
  assert.match(source, /const succeeded = await runPresetAction\('save-as'[\s\S]*if \(succeeded\) \{[\s\S]*showSaveAs\.value = false/)
  assert.match(source, /const succeeded = await runPresetAction\('rename'[\s\S]*if \(succeeded\) \{[\s\S]*showRename\.value = false/)
})
