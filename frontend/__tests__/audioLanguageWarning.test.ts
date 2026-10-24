import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

// Owner, 2026-10-24: "add the page warning too" — a voice model that cannot speak the episode's
// script is flagged before Generate, greyed out in the picker, and Generate says why.
const page = readFileSync(new URL('../pages/projects/[slug]/audio.vue', import.meta.url), 'utf8')

test('the audio page reads the narration script and warns before Generate', () => {
  assert.match(page, /narration-language/)
  assert.match(page, /title="This voice model cannot speak this script"/)
  assert.match(page, /!!selectedModelLanguageMismatch\.value/, 'Generate is disabled while the model cannot speak it')
  assert.match(page, /\|\| !!modelLanguageMismatch\(model\)/, 'such models are greyed out in the picker')
})

test('the script is re-read, and the old one dropped, on every episode change', () => {
  assert.match(page, /narrationScript\.value = null\n  if \(!episode\) return/)
  assert.match(page, /if \(form\.episode_id === episode\) narrationScript\.value = found/)
})
