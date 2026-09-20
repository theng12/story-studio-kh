/**
 * Episode-scoped state must not survive an episode change — v1.4.195
 *
 * AGENTS.md §4, the most expensive defect class in this repo: a value belonging
 * to one episode reaching another. Two more instances, both found by checking
 * what each page's episode-change watcher actually resets rather than trusting
 * that a watcher exists.
 *
 * The frontend lane's convention is static analysis over the `.vue` source.
 * That proves the reset is present and runs on the episode change; it does NOT
 * prove the DOM clears. The remedy for that is a screenshot (AGENTS.md §3).
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const brollSource = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/broll.vue', import.meta.url)),
  'utf8',
)
const sceneReviewSource = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/scene-review.vue', import.meta.url)),
  'utf8',
)
const imagesSource = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/images.vue', import.meta.url)),
  'utf8',
)
const researchSource = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/research.vue', import.meta.url)),
  'utf8',
)

/**
 * The body of the watcher that fires when the open episode changes.
 *
 * `mustContain` matters on pages with more than one such watcher — images.vue
 * has two, and matching the first one silently asserts against the wrong block.
 */
function episodeChangeWatcher(source: string, opener: RegExp, mustContain?: string): string {
  const pattern = new RegExp(opener.source, opener.flags.includes('g') ? opener.flags : `${opener.flags}g`)
  const matches = [...source.matchAll(pattern)].map(m => m[0])
  const chosen = mustContain ? matches.find(m => m.includes(mustContain)) : matches[0]
  assert.ok(chosen, `the page must watch for an episode change${mustContain ? ` (containing ${mustContain})` : ''}`)
  return chosen
}

test('B-roll blanks the manual pick chosen for the episode being left', () => {
  const watcher = episodeChangeWatcher(brollSource, /watch\(\(\) => form\.episode_id,[\s\S]*?\n\}\)/)

  // The manual selection is an ordered list of clips with per-clip durations,
  // chosen for ONE episode. Keeping it means the new episode opens with the old
  // episode's footage still queued and would assemble it.
  assert.match(
    watcher,
    /manualSelection\.value = \[\]/,
    'the manual B-roll pick must be cleared on an episode change',
  )
  // The narration target is that episode's measured narration length.
  assert.match(
    watcher,
    /narrationTargetSec\.value = 0/,
    'the narration target belongs to the episode it was measured for',
  )
})

test('Scene Review closes the lightbox and drops the checked batch on an episode change', () => {
  const watcher = episodeChangeWatcher(
    sceneReviewSource,
    /watch\(\[slug, episodeId\],[\s\S]*?flush: 'sync' \}\)/,
  )

  // The lightbox holds a whole ReviewScene from the episode being left, and its
  // URL is rebuilt from the CURRENT episodeId with the OLD scene id — so it
  // either 404s or shows another episode's image.
  assert.match(
    watcher,
    /previewScene\.value = null/,
    'an open lightbox must not carry the previous episode\'s scene across',
  )
  // The checked batch is a Set of those same stale scene ids.
  assert.match(
    watcher,
    /selectedIds\.value = new Set\(\)/,
    'a batch action after the switch must not name the previous episode\'s scenes',
  )
})

test('Images blanks its integrity card and Browse grid on an episode change', () => {
  // The previous literals were cleared ONLY in the else branch — when the
  // episode became empty. Switching A -> B kept A's figures and grid on screen
  // for the whole load, and permanently if the read failed.
  const watcher = episodeChangeWatcher(
    imagesSource,
    /watch\(\[slug, \(\) => form\.episode_id\],[\s\S]*?\n\}, \{ immediate: true \}\)/,
    'lastRepairJobId',
  )

  assert.match(
    watcher,
    /Object\.assign\(imageStatus, emptyImageStatus\(\)\)/,
    'the integrity card is episode-scoped and must be blanked on the change, not only on a successful read',
  )
  assert.match(watcher, /editScenes\.value = \[\]/, 'the Browse grid is episode-scoped')
  assert.match(watcher, /editThumbs\.value = \[\]/, 'the Browse grid is episode-scoped')
  // And the blanking must not sit behind `if (v)`.
  const blankAt = watcher.indexOf('emptyImageStatus()')
  const ifAt = watcher.indexOf('if (v)')
  assert.ok(ifAt >= 0 && blankAt >= 0 && blankAt < ifAt, 'blanking must happen before the episode guard')
})

test('Research blanks the loaded result on an episode change so a failed read is honest', () => {
  const watcher = episodeChangeWatcher(researchSource, /watch\(\[slug, episodeId\],[\s\S]*?\n\}, \{ immediate: true \}\)/)

  assert.match(
    watcher,
    /result\.value = null/,
    "loadExisting's catch is empty because the empty-state card renders — which needs result to be null",
  )
  assert.match(watcher, /serverResult\.value = ''/, 'the server snapshot must not survive either')
})
