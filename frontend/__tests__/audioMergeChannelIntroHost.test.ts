/**
 * Release 1.4.384 — Audio Assembly points channel intro editing at Video
 * Assembly, the single editing home. This page keeps the link's channel and
 * episode, leaves the episode's own intro (including its 2s default gap) alone,
 * and carries no duplicate channel picker, state or preset key of its own.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const SOURCE = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/audio-merge.vue', import.meta.url)),
  'utf8',
)

const EDITOR_HREF = '/projects/${slug}/video-assembly?step=2&episode_id=${encodeURIComponent(episodeId)}'

test('the channel intro links to Video Assembly with this channel and episode', () => {
  const at = SOURCE.indexOf(EDITOR_HREF)
  assert.ok(at > 0, 'the Video Assembly link must carry the channel slug and the open episode')
  const before = SOURCE.slice(Math.max(0, at - 200), at)
  assert.match(before, /<NuxtLink[\s\S]*:to="`$/, 'the href is the rendered NuxtLink target')
  assert.match(SOURCE, /Edited in Video Assembly/, 'the page says where the channel intro is edited')
})

test('the legacy episode intro and its 2s default gap are unchanged', () => {
  assert.match(SOURCE, /const intro = reactive\(\{\s*enabled: false,\s*file: '',\s*volume: 100,\s*gap_after: 2,/)
  assert.match(SOURCE, /intro: JSON\.parse\(JSON\.stringify\(intro\)\),/)
  assert.match(SOURCE, /payload\.intro = \{\s*enabled: true,\s*file: intro\.file,\s*volume: intro\.volume \/ 100,\s*gap_after: intro\.gap_after,/)
  assert.match(SOURCE, /<SliderWithNumber v-model="intro\.gap_after"/, 'the intro gap control stays in the mixer')
})

test('no duplicate channel intro picker, state or preset payload is added here', () => {
  assert.ok(!/ChannelIntroAudioPicker/.test(SOURCE), 'the channel picker belongs to Video Assembly only')
  assert.ok(!/channel_intro/.test(SOURCE), 'no duplicate preset key or merge payload')
  assert.ok(!/channelIntro/.test(SOURCE), 'no duplicate channel intro state or apply path')
})
