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

// ── The uncredited opening (DK0032) ──────────────────────────────────────
// A plan that skipped its Introduction and recorded no reason passes this
// page's coverage check and fails Video Assembly's. Both statements were true
// and neither page said so, which is what left the owner stuck between a green
// "Scene plan ready" chip and a red "Not ready" button.
test('Scene Plan names an opening the coverage check waved through', () => {
  assert.match(source, /uncreditedHeadGapSec/)
  assert.match(source, /of narration has no planned scene/)
  assert.match(source, /Cover the opening/)
  // The offer must state the cost of each route, not just present a button.
  assert.match(source, /no new images\s*\n?\s*needed/)
  assert.match(source, /re-run Scene Plan with the\s*\n?\s*introduction included/)
})

test('holding the opening is opt-in, never the default repair', () => {
  // The plain repair button must not pass the flag — and must not hand the
  // click event in as one either.
  assert.match(source, /@click="repairCoverage\(\)"/)
  assert.match(source, /@click="repairCoverage\(true\)"/)
  assert.doesNotMatch(source, /@click="repairCoverage"/)
  assert.match(source, /async function repairCoverage\(holdHeadScene = false\)/)
})
