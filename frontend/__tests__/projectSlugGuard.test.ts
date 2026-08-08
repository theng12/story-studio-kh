import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { projectSlug } from '../utils/project-slug.js'

describe('projectSlug()', () => {
  test('rejects unresolved route values before they become API paths', () => {
    assert.equal(projectSlug(undefined), '')
    assert.equal(projectSlug(null), '')
    assert.equal(projectSlug('undefined'), '')
    assert.equal(projectSlug('null'), '')
    assert.equal(projectSlug(['  channel-one  ']), 'channel-one')
  })
})

test('project routes redirect before dashboard or page setup can fetch', () => {
  const middleware = readFileSync(resolve(import.meta.dirname, '../middleware/validate-project-slug.global.ts'), 'utf8')
  const home = readFileSync(resolve(import.meta.dirname, '../pages/index.vue'), 'utf8')
  assert.match(middleware, /to\.path\.startsWith\('\/projects\/'\)/)
  assert.match(middleware, /navigateTo\('\/', \{ replace: true \}\)/)
  assert.match(home, /function projectHref\(project: \{ slug\?: unknown \}\)/)
  assert.match(home, /const slug = projectSlug\(project\?\.slug\)/)
  assert.match(home, /return slug \? `\/projects\/\$\{slug\}` : ''/)
})
