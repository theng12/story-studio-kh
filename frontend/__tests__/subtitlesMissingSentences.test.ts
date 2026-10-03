import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// Script vs transcript (Dreamlands E2E 2026-10-03): chapters whose narration skipped
// script sentences get the same Re-narrate path as a subtitle gap.
test('Subtitles names skipped script sentences per chapter with Re-narrate and Listen', () => {
  const page = readFileSync(new URL('../pages/projects/[slug]/subtitles.vue', import.meta.url), 'utf8')
  assert.match(page, /v-if="missingSentenceChapters\.length"/)
  assert.match(page, /title="The narration skips script sentences"/)
  assert.match(page, /:to="renarrateLink\(slug, episodeId, chapter\.slug\)"/)
  assert.match(page, /@click="reviewChapterAudio\(chapter\.slug\)"/)
  assert.match(page, /status\.value\?\.missing_sentences/)
})
