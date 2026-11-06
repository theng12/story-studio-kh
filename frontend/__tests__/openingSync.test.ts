import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { describeOpeningSync, type OpeningSyncInput } from '../utils/opening-sync.js'

// Dreamlands E2E 2026-10-03: a default-on 5 s title image put every scene 5 s
// behind its narration and nothing on the page said so before Generate.

const base: OpeningSyncInput = {
  visualSource: 'scene_plan',
  planReservedSec: 0,
  introVideoOn: false,
  introVideoSec: 0,
  titleImageOn: false,
  titleImageSec: 5,
  titleCardOn: false,
  titleCardSec: 5,
}

test('an unreserved title image says the narration starts after it and scenes stay in sync', () => {
  const note = describeOpeningSync({ ...base, titleImageOn: true })
  assert.equal(note?.tone, 'info')
  assert.match(note!.text, /5 s title plays first/)
  assert.match(note!.text, /stay in sync/)
})

test('an unreserved intro clip warns that scenes will lag the narration, by how much', () => {
  const note = describeOpeningSync({ ...base, introVideoOn: true, introVideoSec: 8, titleImageOn: true })
  assert.equal(note?.tone, 'warning')
  assert.match(note!.text, /13 s behind the narration/)
  assert.match(note!.text, /Scene Plan/)
})

test('a reserved opening with nothing switched on warns before the render refuses', () => {
  const note = describeOpeningSync({ ...base, planReservedSec: 10 })
  assert.equal(note?.tone, 'warning')
  assert.match(note!.text, /first 10 s/)
})

test('nothing to say when sync is unaffected or not yet known', () => {
  assert.equal(describeOpeningSync(base), null)
  assert.equal(describeOpeningSync({ ...base, planReservedSec: 5, titleImageOn: true }), null)
  assert.equal(describeOpeningSync({ ...base, planReservedSec: null, titleImageOn: true }), null)
  assert.equal(describeOpeningSync({ ...base, visualSource: 'image_pool', introVideoOn: true }), null)
})

test('Video Assembly shows the note in the opening step and next to Generate', () => {
  const page = readFileSync(new URL('../pages/projects/[slug]/video-assembly.vue', import.meta.url), 'utf8')
  // Two placements: beside the Step 2 intro summary and beside Generate. The
  // note is incumbent user-visible safety context — losing either before a
  // render is the 2026-10-03 incident again.
  assert.equal(page.match(/v-if="openingSyncNote"/g)?.length, 2)
  assert.match(page, /openingSyncNote\.text/)
  assert.match(page, /plan_opening_reserved_sec/)
  // Loaded on first paint too, not only after the episode or intro changes.
  assert.match(page, /watch\(\[\(\) => episodeId\.value, \(\) => intro\.enabled, \(\) => intro\.video_path\], \(\) => \{ loadIntroHold\(\) \}, \{ immediate: true \}\)/)
})
