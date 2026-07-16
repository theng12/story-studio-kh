import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

const page = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/jobs.vue', import.meta.url)),
  'utf8',
)
const layout = readFileSync(
  fileURLToPath(new URL('../layouts/dashboard.vue', import.meta.url)),
  'utf8',
)
const composable = readFileSync(
  fileURLToPath(new URL('../composables/useAllJobs.ts', import.meta.url)),
  'utf8',
)

describe('universal Jobs workspace', () => {
  test('offers explicit project and all-project scopes from the sidebar and page', () => {
    assert.match(layout, /Project Jobs/)
    assert.match(layout, /All Jobs/)
    assert.match(page, /This project/)
    assert.match(page, /All projects/)
    assert.match(page, /route\.query\.scope === 'all'/)
  })

  test('filters and identifies jobs by their owning project', () => {
    assert.match(page, /v-model="projectFilter"/)
    assert.match(page, /job\.project_slug === projectFilter\.value/)
    assert.match(page, /projectName\(job\.project_slug\)/)
    assert.match(page, /jobProjectSlug\(job\)/)
  })

  test('uses one initial snapshot and incremental universal queue events', () => {
    assert.match(composable, /new EventSource\('\/api\/jobs\/all\/stream'\)/)
    assert.match(composable, /addEventListener\('snapshot'/)
    assert.match(composable, /addEventListener\('update'/)
    assert.match(composable, /addEventListener\('cleared'/)
  })
})
