import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const source = fs.readFileSync(
  path.resolve(process.cwd(), 'pages/projects/[slug]/scene-plan.vue'),
  'utf-8',
)

test('Scene Plan surfaces render-blocking coverage gaps with one-click repair', () => {
  assert.match(source, /v-if="coverageNeedsRepair"/)
  assert.match(source, /Video Assembly will stop rather than create black or frozen footage/)
  assert.match(source, /Repair coverage now/)
})

test('coverage repair revalidates the shared Pending-only episode list', () => {
  assert.match(source, /useEpisodes\(slug\)/)
  assert.match(source, /await revalidateEpisodes\(\)/)
})
