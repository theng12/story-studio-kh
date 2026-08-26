import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const home = readFileSync(new URL('../pages/index.vue', import.meta.url), 'utf8')

test('new channels use one focused identity form and let the backend own workflow defaults', () => {
  // No multi-step wizard — the 2026-08-08 collapse replaced it with one form.
  assert.doesNotMatch(home, /v-for="s in 2"|currentStep/)
  // The CREATE PAYLOAD must not carry an episodes folder. It never did, which
  // is why removing the capability was a deletion and not a migration: a
  // channel's episodes now always live at `<projectDir>/episodes` and the
  // create request has nothing to say about it. A browser-supplied absolute
  // path is exactly how two real projects ended up with roots that broke on a
  // new Mac (v1.4.2), and the schema rejects the key outright now.
  //
  // Narrowed from a whole-file `output_root` ban on 2026-08-19. That ban also
  // forbade READING the field, which is what the home page still does to show
  // "Folder missing" and name the path — the value it reads is the RESOLVED
  // absolute folder the backend computes, not a stored setting. Forbidding the
  // diagnosis was never this test's intent; forbidding the frontend from
  // CHOOSING the folder is.
  const createStart = home.indexOf("await post<any>('/projects'")
  assert.ok(createStart > 0, 'the create-channel POST should still exist')
  assert.doesNotMatch(home.slice(createStart, createStart + 500), /output_root/)
  assert.match(home, /<NichePicker v-model="form\.niche_id"/)
  assert.match(home, /<form class="create-form" @submit\.prevent="createProject">/)
  assert.doesNotMatch(home, /get<any\[\]>\('\/projects\/templates'\)/)
  assert.match(home, /const project = await post<any>\('\/projects', \{/)
  assert.doesNotMatch(home, /Add existing project|iCloud|hidden project|Import project/i)
})
