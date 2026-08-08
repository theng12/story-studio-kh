import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const home = readFileSync(new URL('../pages/index.vue', import.meta.url), 'utf8')

test('new channels use one focused identity form and let the backend own workflow defaults', () => {
  assert.doesNotMatch(home, /v-for="s in 2"|currentStep|output_root/)
  assert.match(home, /<NichePicker v-model="form\.niche_id"/)
  assert.match(home, /<form class="create-form" @submit\.prevent="createProject">/)
  assert.doesNotMatch(home, /get<any\[\]>\('\/projects\/templates'\)/)
  assert.match(home, /const project = await post<any>\('\/projects', \{/)
  assert.doesNotMatch(home, /Add existing project|iCloud|hidden project|Import project/i)
})
