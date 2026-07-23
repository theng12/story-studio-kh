import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const page = readFileSync(new URL('../pages/projects/[slug]/image-prompts.vue', import.meta.url), 'utf8')

test('Thumbnail Prompts exposes its prompt-model selector in the live workspace', () => {
  assert.match(page, /<ModelSelector\s+v-model="form\.thumbnail\.model"/)
  assert.match(page, /label="Prompt model"/)
  assert.match(page, /This model writes the thumbnail prompts\./)
})
