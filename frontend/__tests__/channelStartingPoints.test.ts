/**
 * The create screen's "Start from" row (2026-10-31) — the owner's *"several
 * defaults to choose from"* when setting up a new channel.
 *
 * The page is pinned from its source rather than mounted, the same way
 * `channelCreationFlow.test.ts` pins the create payload: what matters here is
 * WHICH endpoint a picked starting point uses and WHICH one a blank start
 * uses, because those are the two paths with different guarantees.
 *
 * What it cannot see: real CSS geometry, and any behavior only a mounted page
 * would exercise. The backend contract behind each of these is pinned in
 * `electron/server/__tests__/channel-defaults.test.ts`.
 *
 * Cases worth naming, because each is a way this feature is quietly wrong
 * rather than loudly broken:
 *
 *   - A STARTING POINT must go through the SAME copy path the channel's own
 *     Settings page uses (`/duplicate-settings`), or its Formula seeding and
 *     its rollback would diverge from the copy that already shipped.
 *   - A BLANK start must still use the plain create route, and still require
 *     a Formula — the 2026-10-25 ruling did not stop applying.
 *   - The list is read FRESH each time the screen opens, because a starting
 *     point that has since been deleted must not be offered.
 *   - Nothing shown when there are none. The screen must look exactly as it
 *     did before this feature existed.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const home = readFileSync(new URL('../pages/index.vue', import.meta.url), 'utf8')
const settings = readFileSync(new URL('../pages/projects/[slug]/settings.vue', import.meta.url), 'utf8')

test('a picked starting point copies through the existing duplicate-settings path', () => {
  const start = home.indexOf('async function createProject')
  assert.ok(start > 0, 'the create handler should still exist')
  const branch = home.slice(start, start + 700)
  // The branch itself: which endpoint each choice uses.
  assert.match(branch, /\? await postStartingPoint\(startingFrom\.source_slug, name\)/)
  assert.match(branch, /: await postBlankStart\(name\)/)

  const copy = home.slice(home.indexOf('async function postStartingPoint'), home.indexOf('async function postStartingPoint') + 700)
  assert.match(copy, /duplicate-settings/,
    'a starting point must use the SAME copy path the channel\'s Settings page uses')
  // Episode naming and audience language are NEW-channel choices, so they must
  // reach the copy rather than silently vanish into it.
  assert.match(copy, /episode_prefix/)
  assert.match(copy, /content_language/)

  const blank = home.slice(home.indexOf('async function postBlankStart'), home.indexOf('async function postBlankStart') + 800)
  assert.match(blank, /await post<any>\('\/projects'/, 'a blank start keeps the plain create route')
  // Nothing new negotiates the Formula on a blank start (owner, 2026-10-25).
  assert.match(blank, /formula_choice: form\.formula_choice === 'generic' \? 'generic' : 'selected'/)
})

test('one gate decides whether the form may be submitted', () => {
  assert.match(home, /const canCreateChannel = computed/)
  assert.match(home, /:disabled="!canCreateChannel \|\| creating"/,
    'the submit button must read the SAME gate the handler checks')
  assert.match(home, /if \(!canCreateChannel\.value \|\| creating\.value\) return/)
  // A starting point replaces the Formula requirement; a blank start keeps it.
  assert.match(home, /startingFromDefault\.value \? true : formulaChoiceMade\.value/)
})

test('the starting points are read fresh, and their absence is not an error', () => {
  // no-store: a starting point deleted while the page sat open must not be
  // offered from a cache.
  assert.match(home, /get<\{ defaults\?: ChannelDefaultSummary\[\] \}>\('\/channel-defaults', \{ cache: 'no-store' \}\)/)
  assert.match(home, /function loadChannelDefaults/, 're-read on every open, not once per mount')
  assert.match(home, /void loadChannelDefaults\(\)/, 'the screen opens with a fresh read')
  // "Still reading" must not render as "you have none" (AGENTS §6).
  assert.match(home, /v-if="channelDefaults\.length \|\| loadingChannelDefaults \|\| channelDefaultsError/)
  assert.match(home, /Reading your saved starting points…/)
  assert.match(home, /role="alert"/, 'a failed read says so rather than showing a plain-start screen')
})

test('a starting point that vanished under the customer is announced', () => {
  assert.match(home, /staleStartingPointNotice/)
  assert.match(home, /That starting point is no longer offered/)
  // …and the selection is REPLACED, never left pointing at nothing.
  assert.match(home, /form\.start_from = ''/)
})

test('a channel start with no saved starting points looks exactly like today', () => {
  // The whole row is conditional on there being something to offer.
  assert.match(home, /v-if="channelDefaults\.length \|\| loadingChannelDefaults/)
  // When a starting point IS chosen, the Formula picker is not merely
  // disabled — it is not rendered, because its answer would be ignored.
  assert.match(home, /<template v-if="!startingFromDefault">/)
  assert.match(home, /<\/template>/)
  // The blank start is always offered beside the saved ones.
  assert.match(home, /<strong>Start blank<\/strong>/)
  // Each card carries the art style's own picture when it has one.
  assert.match(home, /:src="entry\.art_style_preview"/)
  assert.match(home, /entry\.formula_name/)
  assert.match(home, /entry\.art_style_name/)
})

test('a channel is named as a starting point from its own Settings page', () => {
  assert.match(settings, /data-setting="channel-default"/)
  assert.match(settings, /v-model="channelDefaultName"/)
  assert.match(settings, /async function saveChannelDefault/)
  // ONE key, written by a route that writes only that key.
  assert.match(settings, /`\/projects\/\$\{slug\.value\}\/channel-default`/)
  assert.match(settings, /\{ name \}/)
  // The help says the source is shown AS IT IS NOW, and that a copy of a
  // starting point is not itself one.
  assert.match(settings, /as it is right now/)
  assert.match(settings, /is not itself one/)
})
