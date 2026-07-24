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

test('repair actions explain when to use them and what to do next', () => {
  assert.match(source, /<div class="popover-title">Repair out-of-range scenes<\/div>/)
  assert.match(source, /run Visual prompts → All pending/)
  assert.match(source, /<div class="popover-title">Repair coverage<\/div>/)
  assert.match(source, /larger narrated ranges as cue-aligned scenes/)
  assert.match(source, /<div class="popover-title">Reconcile timings<\/div>/)
  assert.match(source, /audio was regenerated or subtitles were re-stitched/)
})
