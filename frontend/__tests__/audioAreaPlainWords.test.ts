/**
 * 2026-10-03 audio-area audit: dead ends, jargon and a squeezed layout on the
 * narration / assembly / music / sound / subtitles pages. Source assertions,
 * like the rest of this lane; the layout fixes were also checked in renders
 * (`_orchestra/audit-20261001/story-audit/audio/`), which no test here can see.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const audio = read('../pages/projects/[slug]/audio.vue')
const merge = read('../pages/projects/[slug]/audio-merge.vue')
const sound = read('../pages/projects/[slug]/sound-and-labels.vue')
const subtitles = read('../pages/projects/[slug]/subtitles.vue')
const music = read('../pages/projects/[slug]/music.vue')
const missingAssets = read('../components/MissingAssetsDialog.vue')

test('links to a step carry the episode in the query the step actually reads', () => {
  // EpisodeSelector reads `episode_id`; `?episode=` silently dropped the episode.
  for (const source of [merge, missingAssets]) assert.doesNotMatch(source, /\?episode=\$\{/)
  assert.match(merge, /\/audio\?episode_id=\$\{encodeURIComponent\(episodeId\)\}/)
})

test('Audio Assembly gives the intro clip path the full row', () => {
  assert.match(merge, /\.audio-mix-section--intro > \.mt-2 \{ grid-column: 1 \/ -1;/)
})

test('Sound & Labels rows wrap instead of covering their actions', () => {
  // v1.4.365 — one timeline row for both halves. The promise this pins is
  // unchanged: a long row wraps into a stack at narrow widths instead of
  // sliding its buttons off the edge, and the fields inside a row wrap too.
  assert.match(sound, /\.sl-row \{ display: grid; grid-template-columns:/)
  assert.match(sound, /@media \(max-width: 1100px\) \{[\s\S]{0,200}?\.sl-row \{ grid-template-columns: 1fr; display: grid; \}/)
  assert.match(sound, /\.sl-editor-main \{ display: flex; flex-wrap: wrap;/)
})

test('Sound & Labels names every problem, on the row it belongs to', () => {
  // The audit's defect was a warning with no row to sit on. Every note the
  // backend returns is drawn against the cue it names.
  assert.match(sound, /function rowNotes\(row: Row\): string\[\]/)
  assert.match(sound, /v-for="\(issue, i\) in rowNotes\(row\)"/)
  assert.match(sound, /if \(issues\.length\) \{[\s\S]{0,300}?validation\.value = \{ \.\.\.validation\.value, \[side\]: issues \}/)
  // An unavailable folder is REPORTED, not silently filtered into an empty picker.
  assert.match(sound, /unavailablePools/)
  assert.match(sound, /Its clips are not listed; nothing was removed/)
  // An episode with nothing on it renders an honest empty state, not a blank.
  assert.match(sound, /Nothing here yet\. That is valid/)
})

test('an unconfirmed request says what Retry does in plain words', () => {
  for (const source of [audio, subtitles, music]) {
    assert.doesNotMatch(source, /submission was not confirmed|Retry submission/)
    assert.match(source, /UNCONFIRMED_SUBMISSION/)
  }
})

test('Audio Generator: no stale or provider-key advice, and every action is explained on screen', () => {
  assert.doesNotMatch(audio, /Skip existing|TTS provider key|aged out of the provider/)
  assert.match(audio, /<strong>Generate missing<\/strong> makes only chapters with no audio yet/)
  assert.match(audio, /Buttons are off because: \{\{ inlineGenerateDisabledReason \}\}/)
  assert.match(audio, /title="No finished script yet"[\s\S]{0,600}Open Script Generator/)
})

test('Subtitles: no "provider work" jargon, and removing a file asks first', () => {
  assert.doesNotMatch(subtitles, /provider work|fresh Gateway request/)
  assert.match(subtitles, /async function deleteSrt[\s\S]{0,200}useConfirm\(\)\.ask\(/)
})

test('Music Library: removal is recoverable, the background is picked, and a free model is not labelled paid', () => {
  assert.match(music, /moves to this project's _trash folder/)
  assert.doesNotMatch(music, /This deletes the file from disk/)
  assert.match(music, /<FilePicker\s+v-model="backgroundPath"/)
  assert.match(music, /musicCost\.basis === 'free'/)
})

test('Music Library keeps the app sidebar like every other project page', () => {
  assert.match(music, /definePageMeta\(\{ layout: 'dashboard' \}\)/)
})
