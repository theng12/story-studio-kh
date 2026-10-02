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
const sound = read('../pages/projects/[slug]/sound-design.vue')
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

test('Sound Design cue fields wrap instead of covering Approve / Exclude / Remove', () => {
  assert.match(sound, /\.sound-cue \{ display:grid; grid-template-columns:6\.5rem 2\.2rem minmax\(0,1fr\) auto;/)
  assert.match(sound, /\.cue-fields \{ display:flex; flex-wrap:wrap;/)
  assert.doesNotMatch(sound, /minmax\(30rem,1fr\)/)
})

test('Sound Design names every problem, on the cue it belongs to', () => {
  assert.match(sound, /v-for="\(issue, i\) in validation"/)
  assert.match(sound, /cueIssues\(cue\.id\)/)
  assert.match(sound, /if \(issues\.length\) validation\.value = issues/)
  assert.match(sound, /No sound files found\. Add a folder of sound effects as an SFX pool/)
  assert.match(sound, /timeline\.value = data\.timeline \|\| blankTimeline\(\)/)
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
  assert.doesNotMatch(subtitles, /provider work|fresh GenStudio request/)
  assert.match(subtitles, /async function deleteSrt[\s\S]{0,200}useConfirm\(\)\.ask\(/)
})

test('Music Library: removal is recoverable, the background is picked, and a free model is not labelled paid', () => {
  assert.match(music, /moves to this project's _trash folder/)
  assert.doesNotMatch(music, /This deletes the file from disk/)
  assert.match(music, /<FilePicker\s+v-model="backgroundPath"/)
  assert.match(music, /musicCost\.basis === 'free'/)
})
