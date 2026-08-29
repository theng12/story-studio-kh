/**
 * The home page paints the channels it already knows about, then reconciles.
 *
 * ── The defect ──
 *
 * `pages/index.vue` started with `projects = ref([])` and fetched `/projects`
 * with `cache: 'no-store'`. The template's first branch is
 * `v-if="loading && projects.length === 0"`, so every single visit began with a
 * full-screen spinner that could not clear until the backend answered.
 *
 * That read walks every channel folder on disk. When the machine is also
 * rendering video the disk is saturated, so the first thing the owner saw on
 * opening his own app during a render was "Loading channels…" — with no way to
 * tell a slow read from a dead one, and no way to get anywhere.
 *
 * ── What is pinned here ──
 *
 *   1. The remembered list survives a round-trip through storage, so the page
 *      can paint before any fetch resolves.
 *   2. The refresh REPLACES the remembered list rather than merging into it — a
 *      channel deleted elsewhere has to disappear, so a cache that only ever
 *      grew would be worse than no cache.
 *   3. A storage that is unavailable, full, or holding garbage degrades to the
 *      old behaviour instead of throwing on the way to first paint.
 *   4. The page tells the truth about what it is showing: a quiet marker while a
 *      read is in flight behind painted rows, and a visible one — plus the way
 *      out of a missing Library — when the read has failed and the rows on
 *      screen are unconfirmed.
 *
 * A remembered list is a display convenience and nothing else. It is never the
 * basis for a submission, and the file it lives in says so.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test, beforeEach } from 'node:test'
import {
  readLastKnownList,
  writeLastKnownList,
  clearLastKnownList,
} from '../utils/last-known-list.ts'

const homePage = readFileSync(
  fileURLToPath(new URL('../pages/index.vue', import.meta.url)), 'utf8',
)

const CHANNELS = 'test-channels'

function channel(slug: string) {
  return { slug, name: slug.toUpperCase(), episode_prefix: 'EP', has_api_keys: true }
}

describe('the home page can paint before the fetch resolves', () => {
  beforeEach(() => { clearLastKnownList(CHANNELS) })

  test('a remembered list survives a round-trip, so first paint has rows', () => {
    assert.deepEqual(readLastKnownList(CHANNELS), [], 'a true first run starts empty')

    writeLastKnownList(CHANNELS, [channel('alpha'), channel('beta')])
    const painted = readLastKnownList<{ slug: string }>(CHANNELS)

    assert.equal(painted.length, 2, 'the next launch has rows before any request is made')
    assert.deepEqual(painted.map(row => row.slug), ['alpha', 'beta'])
  })

  test('a refresh replaces the remembered list — a deleted channel disappears', () => {
    writeLastKnownList(CHANNELS, [channel('alpha'), channel('beta')])
    // `beta` was deleted somewhere else; the server no longer returns it.
    writeLastKnownList(CHANNELS, [channel('alpha')])

    const painted = readLastKnownList<{ slug: string }>(CHANNELS)
    assert.deepEqual(painted.map(row => row.slug), ['alpha'],
      'merging instead of replacing would resurrect a deleted channel on every launch')
  })

  test('garbage in storage degrades to the old blank-then-spinner behaviour', () => {
    localStorage.setItem('story_studio_last_known_' + CHANNELS, '{"not":"an array"}')
    assert.deepEqual(readLastKnownList(CHANNELS), [], 'a non-array value is not a channel list')

    localStorage.setItem('story_studio_last_known_' + CHANNELS, 'not json at all')
    assert.deepEqual(readLastKnownList(CHANNELS), [], 'unparseable storage must not throw at first paint')
  })

  test('a non-array write is refused rather than half-stored', () => {
    writeLastKnownList(CHANNELS, [channel('alpha')])
    writeLastKnownList(CHANNELS, 'nonsense' as unknown as unknown[])
    assert.equal(readLastKnownList(CHANNELS).length, 1, 'the good value survived a bad write')
  })
})

describe('the page says what it is showing', () => {
  test('the spinner is reserved for a true first run', () => {
    // The condition itself is unchanged — what changed is that `projects` can
    // now already be non-empty at that moment.
    assert.match(homePage, /v-if="loading && projects\.length === 0"/)
    assert.match(homePage, /const cachedChannels = readLastKnownList<any>\(LAST_KNOWN_CHANNELS\)/)
    assert.match(homePage, /const projects = ref<any\[\]>\(cachedChannels\)/)
  })

  test('a read in flight behind painted rows is visible, quietly', () => {
    assert.match(homePage, /const refreshingChannels = computed\(\(\) => loading\.value && projects\.value\.length > 0\)/)
    assert.match(homePage, /v-if="refreshingChannels"[\s\S]{0,120}Refreshing…/)
  })

  test('a FAILED read behind painted rows is admitted, not hidden', () => {
    // This is the worse of the two failures: painting a remembered list and then
    // staying silent would leave the page looking perfectly healthy while
    // showing something nobody had confirmed.
    assert.match(homePage, /const showingUnconfirmedChannels = computed/)
    assert.match(homePage, /v-if="showingUnconfirmedChannels"/)
    assert.match(homePage, /channels from your last visit/)
    assert.match(homePage, /@click="retryLoadProjects"/)
  })

  test('a remembered list never costs the user the way out of a missing Library', () => {
    // The blank-state branch offers "Choose a different folder…". Having a cache
    // must not hide it — that would mean the cache took away an escape hatch a
    // first-time visitor still gets.
    assert.match(
      homePage,
      /showingUnconfirmedChannels[\s\S]{0,900}v-if="libraryMissing" to="\/welcome"/,
      'the unconfirmed-rows banner must keep the Library escape hatch',
    )
  })

  test('the successful read is what writes the cache', () => {
    assert.match(homePage, /writeLastKnownList\(LAST_KNOWN_CHANNELS, fresh\)/)
    // Written only on success: a failed read must never overwrite the last list
    // that actually worked.
    assert.doesNotMatch(homePage, /catch[\s\S]{0,400}writeLastKnownList/)
  })
})
