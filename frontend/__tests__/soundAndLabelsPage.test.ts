/**
 * Sound & Labels — the page's own promises (v1.4.365).
 *
 * Source-level pins over `sound-and-labels.vue`, in the repo's usual style, for
 * the defects the audit found that a backend test cannot see: settings leaking
 * between episodes, a save that re-certifies stale times, and controls that
 * change nothing.
 *
 * Cannot catch: layout, or a value that is set correctly and simply never
 * drawn. The rendered page was checked separately at 1440 and 1280.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const page = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/sound-and-labels.vue', import.meta.url)),
  'utf8',
)

test('the mix settings are read from THIS episode, never remembered across episodes', () => {
  // The audit's leak: `useRememberedForm` carried one episode's density, gains
  // and ducking into the next one. AGENTS.md §4 — an episode change REPLACES.
  assert.doesNotMatch(page, /useRememberedForm\('sound-and-labels', slug, settings/)
  assert.doesNotMatch(page, /useRememberedForm\([^)]*include: \[[^\]]*max_spots_per_minute/)
  // They are reset to the shipped defaults and then filled from the loaded
  // timeline, which is the episode's own saved answer.
  const load = page.slice(page.indexOf('async function loadEpisode'))
  const body = load.slice(0, load.indexOf('\n}\n'))
  assert.match(body, /settings\.value = \{ max_spots_per_minute: 3, default_bed_gain_db: -20, default_spot_gain_db: -12, ducking_profile: 'gentle' \}/)
  assert.match(body, /if \(sounds\.value\?\.settings\) settings\.value = \{ \.\.\.sounds\.value\.settings \}/)
  assert.ok(
    body.indexOf('settings.value = { max_spots_per_minute: 3') < body.indexOf('settings.value = { ...sounds.value.settings }'),
    'the blank must come before the fill',
  )
})

test('a save never re-certifies stale times: the plan date comes from the loaded plan', () => {
  // The backend writes `source_scene_plan_generated_at` from the CURRENT plan on
  // every save, so a save cannot stamp an old timeline as fresh. The page only
  // ever names the field in a TYPE or in an empty blank-timeline scaffold —
  // never in a request payload.
  const payloadWrites = page.slice(page.indexOf('async function writeTimeline'))
  assert.doesNotMatch(payloadWrites.slice(0, payloadWrites.indexOf('\n}\n')), /source_scene_plan_generated_at/)
  assert.match(page, /put<any>\(`\/projects\/\$\{project\}\/sound-and-labels\/\$\{episode\}\/sounds`, \{ cues: soundPayload, settings: mixSettings \}\)/)
})

test('the deleted controls stay deleted', () => {
  // `density` had no reader. A control that changes nothing is worse than none.
  assert.doesNotMatch(page, /Sound density|settings\.density/)
  // The project-level auto-approve switch: the preset's is the only one.
  assert.doesNotMatch(page, /auto_approve_cues/)
})

test('a sound can be PLAYED before it is approved', () => {
  // There was no play button at all: the only way to hear a clip was to approve
  // it and render the episode.
  assert.match(page, /function togglePlay\(row: Row\): void/)
  assert.match(page, /new Audio\(url\)/)
  assert.match(page, /sound-and-labels\/sounds\/pool-audio/)
  assert.match(page, /sound-and-labels\/sounds\/library-audio/)
})

test('an offline pool is REPORTED, not silently emptied', () => {
  // The picker used to show nothing and the page still said "approved", so the
  // customer's own library looked deleted.
  assert.match(page, /unavailablePools/)
  assert.match(page, /Its clips are not listed; nothing was removed/)
})

test('a label card shows only text, corner and "sound with this label"; the rest is Advanced', () => {
  const card = page.slice(page.indexOf('v-if="row.side === \'label\'" class="sl-editor"'))
  const main = card.slice(card.indexOf('sl-editor-main'), card.indexOf('<AdvancedDisclosure'))
  assert.match(main, /v-model="row\.cue\.title"/)
  assert.match(main, /v-model="row\.cue\.subtitle"/)
  assert.match(main, /@change="useCueCorner\(row\.cue/)
  assert.match(main, /toggleSoundWithLabel\(row\.cue/)
  // Everything else is behind the disclosure — including the preview, which now
  // draws over the REAL scene image rather than a grey box.
  assert.match(card, /<AdvancedDisclosure/)
  assert.match(card, /sceneImageUrl\(row\.cue\.scene_id\)/)
})

test('the list is sorted by time, labels and sounds together', () => {
  assert.match(page, /return rows\.sort\(\(a, b\) => a\.start_sec - b\.start_sec/)
})

test('a refusal is SHOWN, before the render rather than after it', () => {
  // The backend reports what it would refuse instead of hiding the rows behind
  // a 400. A page that never drew that sentence left the customer with rows
  // that looked fine and a render that refused for an unstated reason.
  assert.match(page, /const refuses = ref<\{ labels\?: string; sound\?: string \}>\(\{\}\)/)
  assert.match(page, /const refusedNote = computed\(\(\) => \[refuses\.value\.labels, refuses\.value\.sound\]/)
  assert.match(page, /v-if="refusedNote"/)
  assert.match(page, /data\.readiness\?\.labels\?\.refuses/)
  // And it is cleared on an episode change, like every other field (§4).
  const load = page.slice(page.indexOf('async function loadEpisode'))
  assert.match(load.slice(0, load.indexOf('\n}\n')), /refuses\.value = \{\}/)
})

test('the page has ONE readiness answer, taken from the backend that also renders it', () => {
  // A page that validated with its own rule is how "ready" came to disagree
  // with the renderer.
  assert.match(page, /const \[data, available\] = await Promise\.all/)
  assert.match(page, /validation\.value = data\.validation \|\| \{ labels: \[\], sound: \[\] \}/)
  assert.doesNotMatch(page, /resolveRenderable|validateContextualCueTimeline|validateSoundDesignTimeline/)
})
