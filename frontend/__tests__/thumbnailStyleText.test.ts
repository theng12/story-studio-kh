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

test('the lettering limit is shown where the lettering is chosen — one setting, two places', () => {
  // Owner, 2026-11-15: the number belongs on the Thumbnail Prompts page too, and
  // it must be the SAME number, not a second one that can drift.
  const settings = readFileSync(new URL('../components/PerformanceSettings.vue', import.meta.url), 'utf8')
  for (const file of [page, settings]) {
    assert.match(file, /\/app-settings\/thumbnail-style-text-limit/, 'both surfaces read and write one endpoint')
  }
  // The page shows the value in force and can change it in place.
  assert.match(page, /id="thumbnail-lettering-limit"/)
  assert.match(page, /@change="saveLetteringLimit"/)
  assert.match(page, /:disabled="letteringLimitBusy"/)
  // The number shown is the server's answer, never a client-side copy of the default.
  assert.match(page, /if \(typeof saved\.limit === 'number'\) letteringLimit\.value = saved\.limit/)
  // A refusal from the server is shown, not swallowed.
  assert.match(page, /letteringLimitError\.value = e\?\.data\?\.detail/)
  // …and it says where the other place is, so nobody wonders which one wins.
  assert.match(page, /same setting as Settings → Performance &amp; recovery/)
})
