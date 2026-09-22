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
const characterSheetSource = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/character-sheet.vue', import.meta.url)),
  'utf8',
)
const motionReviewSource = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/motion-review.vue', import.meta.url)),
  'utf8',
)
const metadataSource = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/metadata.vue', import.meta.url)),
  'utf8',
)
const scenePlanSource = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/scene-plan.vue', import.meta.url)),
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

test('Character Sheet blanks the episode continuity config before the new read resolves', () => {
  // `loadConfig` replaces the config on success and falls back to defaults on
  // failure, so the earlier "replaced only on a successful load" shape is gone.
  // What was left is the window in between: the watcher is `flush: 'sync'`, yet
  // the previous episode's anchors, pacing and references stayed live until the
  // awaited read returned. Blank it on the change (AGENTS.md §4).
  const watcher = episodeChangeWatcher(
    characterSheetSource,
    /watch\(\[slug, episodeId\],[\s\S]*?flush: 'sync' \}\)/,
  )
  assert.match(watcher, /config\.value = continuityDefaults\(\)/, 'the episode continuity config must be blanked on the change')
  const blankAt = watcher.indexOf('continuityDefaults()')
  const loadAt = watcher.indexOf('loadConfig()')
  assert.ok(blankAt >= 0 && loadAt >= 0 && blankAt < loadAt, 'the blank must happen before the reload, not inside it')
})

test('Motion Review resets every episode-scoped motion field on an episode change', () => {
  const watcher = episodeChangeWatcher(motionReviewSource, /watch\(episodeId,[\s\S]*?\n\}, \{ immediate: true \}\)/)
  assert.match(watcher, /resetEpisodeScopedMotionState\(\)/, 'the episode-scoped reset must run on the change')
  const body = /function resetEpisodeScopedMotionState\(\) \{([\s\S]*?)\n\}/.exec(motionReviewSource)?.[1]
  assert.ok(body, 'the reset function must exist')
  for (const field of ['scenes.value = []', 'stats.value = null', 'motionScope.value', 'cacheBuster.value = Date.now()']) {
    assert.ok(body.includes(field), `the reset must clear ${field}`)
  }
})

test('Metadata blanks the episode-owned generation and finalization state on an episode change', () => {
  const watcher = episodeChangeWatcher(
    metadataSource,
    /watch\(\[slug, episodeId\],[\s\S]*?\n\}\)/,
    'titleOptions.value = []',
  )
  assert.match(watcher, /titleOptions\.value = \[\]/, "the previous episode's title variants must not be submittable")
  assert.match(watcher, /finalizationStatus\.value = null/, 'the finalization gate must not answer from the previous episode')
  assert.match(watcher, /genAll\.value = false/, 'the previous episode\'s in-flight banner must not gate the new episode')
  assert.match(watcher, /lastGenResult\.value = null/, 'the result banner belonged to the episode just left')
})

/**
 * X-06 (owner decision 2026-09-22) — Scene Plan now has two guidance boxes, and
 * they must not share a lifetime: the episode-only one is dropped on an episode
 * change and the reusable one is kept, because it is the text a preset carries
 * to the next episode rather than a value owned by this one.
 */
test('Scene Plan drops the episode-only guidance on an episode change and keeps the reusable rule', () => {
  const watcher = episodeChangeWatcher(
    scenePlanSource,
    /watch\(\[slug, episodeId\],[\s\S]*?flush: 'sync' \}\)/,
    'custom_instructions',
  )

  assert.match(watcher, /form\.value\.custom_instructions = ''/,
    'the previous episode’s written guidance must not steer the new episode’s prompts')
  assert.match(watcher, /episodeGuidanceNotice\.value =/,
    'clearing the customer’s text must be announced, not silent (AGENTS.md §4)')
  assert.doesNotMatch(watcher, /reusable_guidance/,
    'the reusable rule is not episode-owned and must survive the change')
})
