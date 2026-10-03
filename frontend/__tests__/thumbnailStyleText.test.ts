import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const page = readFileSync(new URL('../pages/projects/[slug]/image-prompts.vue', import.meta.url), 'utf8')

test('Thumbnail Prompts has one visible, labelled, editable style text again', () => {
  assert.match(page, /<label for="thumbnail-style-text">Style text<\/label>/)
  assert.match(page, /<textarea\s+id="thumbnail-style-text"\s+v-model="form\.thumbnail\.style_tag"/)
  assert.match(page, /Edit it freely — it is remembered for this channel\./)
  // The old editor sat in a hidden block; no hidden block may come back.
  assert.doesNotMatch(page, /v-if="false"/)
  // The text that is shown is the text that is sent.
  assert.match(page, /style_tag: activeForm\.value\.style_tag/)
})

test('a new channel\'s thumbnails start from its own look, not the shared format default', () => {
  const seed = page.slice(page.indexOf('async function applyFormatDefaultsIfNoPreset'))
  assert.match(seed, /settings\/config/)
  assert.match(seed, /default_style_bible/)
  assert.match(seed, /channelStyle \|\| /)
  // A remembered or preset-chosen style still wins.
  assert.match(seed, /seedThumb\('style_tag'\)/)
})
