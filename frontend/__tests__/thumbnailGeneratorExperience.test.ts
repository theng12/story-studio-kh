import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
}

const page = source('../pages/projects/[slug]/images.vue')
const panel = source('../components/ImageGeneratorPanel.vue')
const row = source('../components/ImageGeneratorRow.vue')

test('thumbnail generation keeps recovery details technical and the workflow actionable', () => {
  assert.match(page, /Recovery & completeness/)
  assert.match(page, /Technical recovery details/)
  assert.match(page, /Recover prior result/)
  assert.match(page, /Thumbnail set ready/)
  assert.match(page, /Open YouTube Upload/)
  assert.doesNotMatch(page, /New version/)
  assert.doesNotMatch(page, /Specific # \(optional\)/)
})

test('thumbnail board is missing-first and pins upload selection beside the rendered asset', () => {
  assert.match(panel, /Thumbnail board/)
  assert.match(panel, /Generate \$\{missingCount\.value\} missing/)
  assert.match(panel, /force: props\.generationMode === 'regenerate'/)
  assert.match(panel, /@pin-toggle=/)
  assert.match(row, /Pin for upload/)
  assert.match(row, /Pinned for upload/)
})
