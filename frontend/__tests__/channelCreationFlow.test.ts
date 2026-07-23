import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const home = readFileSync(new URL('../pages/index.vue', import.meta.url), 'utf8')

test('new channels use the two-step, continuity-first creation flow', () => {
  assert.match(home, /<div v-for="s in 2"/)
  assert.match(home, /Continuity workflow/)
  assert.match(home, /const DEFAULT_FORMAT_ID = 'continuity-chain'/)
  assert.doesNotMatch(home, /get<any\[\]>\('\/projects\/templates'\)/)
  assert.match(home, /const project = await post<any>\('\/projects', \{/)
})
