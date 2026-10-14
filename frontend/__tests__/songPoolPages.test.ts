/**
 * Music format phase 1 — Music Formula, Song Pool and Generate Songs (mockups 01–03).
 *
 * Source-level checks for the owner's rules that a render cannot prove: the writing model is
 * picked at start and never assigned, the song model is never defaulted to a paid row, every
 * control explains itself in visible text, and nothing uses the blocked window.prompt.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { describe } from 'node:test'
import { fileURLToPath } from 'node:url'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const pool = read('../pages/projects/[slug]/song-pool.vue')
const formula = read('../pages/projects/[slug]/music-formula.vue')
const dialog = read('../components/music/GenerateSongsDialog.vue')
const crumbs = read('../components/Breadcrumb.vue')

describe('Generate Songs dialog', () => {
  test('the writing model is picked in the dialog with the shared picker; the last pick is only pre-filled', () => {
    assert.match(dialog, /<ModelSelector v-model="writerModel"/)
    assert.match(dialog, /you choose/)
    assert.match(dialog, /does not make the audio/)
    assert.match(dialog, /writerModel\.value = recall\('writer-model'\)/)
    assert.doesNotMatch(dialog, /writerModel = ref\('[^']+'\)/, 'never a hard-coded writing model')
  })
  test('the song model defaults only to a model that runs free on the fleet, never to the first (possibly paid) row', () => {
    assert.match(dialog, /find\(m => m\.price_source === 'local'\)/)
    assert.doesNotMatch(dialog, /songModels\.value\[0\]/)
  })
  test('Start says why it is disabled, and Preview 5 Briefs makes no audio', () => {
    assert.match(dialog, /disabledReason \|\| 'Runs in the background/)
    assert.match(dialog, /Pick the writing model first\./)
    assert.match(dialog, /Writes 5 briefs only — no audio/)
    assert.match(dialog, /song-pool\/preview-briefs/)
  })
  test('time on the fleet comes from the pool\'s own measured songs, never a guessed constant', () => {
    assert.match(dialog, /averageGenerationS/)
    assert.match(dialog, /does not guess it/)
  })
  test('an unconfirmed ordinary submission keeps one captured body and UUID for Retry', () => {
    assert.match(dialog, /pendingSongPoolSubmission/)
    assert.match(dialog, /JSON\.parse\(JSON\.stringify/)
    assert.match(dialog, /showAction\(UNCONFIRMED_SUBMISSION, 'Retry'/)
    assert.match(dialog, /submission\.operationId/)
    assert.match(dialog, /submission\.projectSlug/)
  })
})

describe('Song Pool page', () => {
  test('has the mockup\'s columns, filters and actions', () => {
    for (const label of ['Free for Next Episode', 'Never Played', 'Rejected', 'Plays', 'Last used', 'Rating', 'Loudness',
      'Regenerate', 'Add Tag…', 'Edit Brief &amp; Regenerate…', 'Show in Finder', 'Fill Gaps…', 'Generate Songs…', 'in window', 'Check by ear']) {
      assert.ok(pool.includes(label), `missing: ${label}`)
    }
  })
  test('reject explains trash vs archive before anything moves', () => {
    assert.match(pool, /move to this project's _trash folder \(nothing is deleted\)/)
    assert.match(pool, /archived — kept so its tracklist stays true/)
    assert.match(pool, /danger: true/)
  })
  test('the Episode Builder\'s shortfall link opens the dialog pre-filled', () => {
    assert.match(pool, /route\.query\.generate/)
  })
  test('manual redo is default-off, exact-item, separately paid, and retry-safe', () => {
    assert.match(pool, /useManualGenerationRedoPreference/)
    assert.match(pool, /song-pool\/manual-redo-sources/)
    assert.match(pool, /source_item_key/)
    assert.match(pool, /manual_redo: \{ intent: 'replace_unresolved'/)
    assert.match(pool, /confirmed_paid_music: paid/)
    assert.match(pool, /always: true/)
    assert.match(pool, /JSON\.parse\(JSON\.stringify/)
    assert.match(pool, /showAction\(UNCONFIRMED_SUBMISSION, 'Retry'/)
    assert.match(pool, /Published limits:/)
    assert.match(pool, /publishedRange\('title'/)
  })
})

describe('Music Formula page', () => {
  test('saves through the merge route and offers Duplicate As New Channel', () => {
    assert.match(formula, /\/music-format\?project_slug=/)
    assert.match(formula, /duplicate-music-channel/)
    assert.match(formula, /Starting values — save to use them\./)
  })
  test('owner decisions are the starting values shown, and all of them are editable', () => {
    for (const label of ['Crossfade', 'Butt-join', 'Short silence', 'Upscale to 1080p', 'LUFS', 'dBTP', 'fps', 'Don\'t repeat a song for']) {
      assert.ok(formula.includes(label), `missing: ${label}`)
    }
  })
})

test('nothing uses window.prompt (blocked in the desktop app)', () => {
  for (const src of [pool, formula, dialog]) assert.doesNotMatch(src.replace(/<!--[\s\S]*?-->/g, ''), /window\.prompt\(/)
})

test('the breadcrumb names both pages', () => {
  assert.match(crumbs, /'music-formula': 'Music Formula'/)
  assert.match(crumbs, /'song-pool': 'Song Pool'/)
})
