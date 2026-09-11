import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const page = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/audio-merge.vue', import.meta.url)),
  'utf8',
)

test('keeps Audio Assembly mix settings visible and compact', () => {
  assert.match(page, /class="card mt-2 audio-mix-card"/)
  assert.match(page, /Voice, pacing, and optional layers/)
  assert.match(page, /class="audio-mix-section audio-mix-section--voice"/)
  assert.match(page, /class="compact-toggle"/)
  assert.match(page, /class="merge-output-status mt-2"/)
  assert.doesNotMatch(page, /<AdvancedDisclosure/)
  assert.doesNotMatch(page, /audio_merge_advanced_open/)
})

test('makes background-music source and opening choices explicit', () => {
  assert.match(page, /Background music source/)
  assert.match(page, /Music Pool/)
  assert.match(page, /Choose for this episode/)
  assert.match(page, /Standalone intro clip/)
  assert.match(page, /Music lead-in/)
  assert.match(page, /selectedMusicFiles/)
  assert.match(page, /music\.source === 'pool'/)
})

test('keeps merge output and the merge action in a floating bar with replace as the default', () => {
  const topBar = page.slice(page.indexOf('<TopActionBar'), page.indexOf('</TopActionBar>'))
  const actionBarIndex = page.indexOf('class="audio-assembly-action-bar"')
  const chaptersIndex = page.indexOf('<!-- Chapter Management -->')
  const presetSnapshot = page.slice(page.indexOf('snapshot: () => ({'), page.indexOf('  apply: (data) =>'))

  assert.match(topBar, /:show-generate="false"/)
  assert.doesNotMatch(topBar, /@generate=/)
  assert.ok(actionBarIndex > -1 && actionBarIndex < chaptersIndex)
  assert.match(page, /class="audio-output-choice"[\s\S]{0,500}<select[\s\S]{0,120}v-model="writeMode"/)
  assert.match(page, /<option value="overwrite"/)
  assert.match(page, /<option value="new"[^>]*>\s*Create another version/)
  assert.match(page, /const writeMode = ref<'overwrite' \| 'new'>\('overwrite'\)/)
  assert.doesNotMatch(page, /writeMode\.value = cur \? 'new' : 'overwrite'/)
  assert.match(page, /watch\(existingMergedAudio,[\s\S]{0,300}if \(!cur\) writeMode\.value = 'overwrite'/)
  assert.doesNotMatch(presetSnapshot, /writeMode|write_mode/)
  assert.match(page, /return files\.find\([\s\S]{0,140}activeFilename\) \|\| null/)
  assert.match(page, /:disabled="!chapterAudioReady \|\| mergeStatus\.loading \|\| !!mergeStatus\.error/)
  assert.match(page, /\.audio-assembly-action-bar \{[\s\S]{0,160}position: sticky;[\s\S]{0,80}top: 10px;/)
})
