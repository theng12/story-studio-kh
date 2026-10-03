/**
 * Audio Assembly counts chapters, not part files (Dreamlands EP0001 showed
 * "73 chapters" for 15), and the chapter pause is named plainly with the
 * Series Formula's suggestion visible beside it. Source assertions.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const merge = readFileSync(fileURLToPath(new URL('../pages/projects/[slug]/audio-merge.vue', import.meta.url)), 'utf8')

test('chapter counts group part files by chapter', () => {
  assert.match(merge, /const chapterCount = computed\(\(\) => new Set\(chapters\.value\.map\(chapter => chapterKeyFromFilename\(chapter\.filename\)\)\)\.size\)/)
  assert.match(merge, /\$\{chapterCount\} chapter\$\{chapterCount === 1/)
  assert.doesNotMatch(merge, /\$\{chapters\.length\} chapter/)
})

test('the pause between chapters is named plainly and shows the Formula suggestion', () => {
  assert.match(merge, /<label>Pause between chapters \(\{\{ gapDuration \}\} s\)<\/label>/)
  assert.match(merge, /Your Series Formula suggests \{\{ formulaGapSec \}\} s\./)
  assert.match(merge, /formulaGapSec\.value = m\.gapDurationSec/)
  assert.doesNotMatch(merge, /Silence Between Chapters|Silence Gaps/)
})
