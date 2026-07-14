import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const routeSource = readFileSync(new URL('../routes/projects.ts', import.meta.url), 'utf8')
const cleanupSource = readFileSync(new URL('../services/chunked-sidecar-cleanup.ts', import.meta.url), 'utf8')

test('retired legacy video-assembly migration stays out of the storage API', () => {
  assert.doesNotMatch(routeSource, /legacy-video-assembly-presets/)
  assert.doesNotMatch(routeSource, /legacy-preset-migrator/)
})

test('recovery cleanup uses the canonical reader for current and supported older sidecars', () => {
  assert.match(cleanupSource, /readSidecar\(paths\.script_dir, code\)/)
  assert.doesNotMatch(cleanupSource, /schema_version\s*!==\s*1/)
})
