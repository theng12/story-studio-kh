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

  test('shows determinate upload percentage and transfer telemetry', () => {
    assert.match(page, /<ProgressBar/)
    assert.match(page, /:progress="jobProgress\(job\) \?\? undefined"/)
    assert.match(page, /:bytes-done="job\.bytes_done"/)
    assert.match(page, /:bytes-total="job\.bytes_total"/)
    assert.match(page, /:speed-bps="job\.speed_bps"/)
    assert.match(page, /:eta-seconds="job\.eta_seconds"/)
    assert.match(page, /Uploading video to YouTube/)
    assert.match(page, /Applying thumbnail and metadata/)
  })
})
