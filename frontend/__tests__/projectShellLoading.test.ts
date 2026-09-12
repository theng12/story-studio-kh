import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const shell = readFileSync(new URL('../layouts/dashboard.vue', import.meta.url), 'utf8')

test('a missing formula notice requires resolved current-project metadata', () => {
  assert.match(shell, /<NicheMissingBanner v-if="slug && project"/)
  assert.match(shell, /if \(!project\.value\) return 'Loading channel…'/)
  assert.match(shell, /if \(!project\.value\.niche_id\) return 'Choose a Series Formula'/)
  assert.match(shell, /'Series Formula unavailable'/)
})

test('project navigation starts independent flow loading without waiting for all settings', () => {
  const start = shell.indexOf('watch(slug, async currentSlug =>')
  const end = shell.indexOf('}, { immediate: true })', start)
  const watcher = shell.slice(start, end)
  assert.ok(watcher.indexOf('void loadVisualSource()') < watcher.indexOf('await loadProject(currentSlug)'))
  assert.ok(watcher.indexOf('startJobPolling(currentSlug)') < watcher.indexOf('await loadProject(currentSlug)'))
  assert.match(watcher, /currentSlug !== slug\.value/)
  assert.match(watcher, /catch/)
})
