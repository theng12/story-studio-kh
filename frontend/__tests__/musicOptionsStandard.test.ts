/**
 * Background music, app side (owner, 2026-10-27): the bed's starting level is 6% ("all of regular
 * channel must have background music"), and a channel's music choices are shown against the
 * standard of at least ten.
 *
 * The page must read the ONE definition the generator mixes with — a literal 6 in the page is how
 * the old 8% survived in half the app — and the standard must be visible without ever blocking
 * assembly.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import {
  DEFAULT_BACKGROUND_MUSIC_VOLUME_PERCENT,
  MIN_CHANNEL_MUSIC_OPTIONS,
} from '../../electron/server/contracts/music-bed-defaults'

const page = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/audio-merge.vue', import.meta.url)),
  'utf8',
)
const panel = readFileSync(fileURLToPath(new URL('../components/MusicPoolPanel.vue', import.meta.url)), 'utf8')
const board = readFileSync(fileURLToPath(new URL('../pages/projects/[slug]/board.vue', import.meta.url)), 'utf8')

test('Audio Assembly starts a new bed at the one shared 6%, not a literal of its own', () => {
  assert.equal(DEFAULT_BACKGROUND_MUSIC_VOLUME_PERCENT, 6)
  assert.match(page, /volume: DEFAULT_BACKGROUND_MUSIC_VOLUME_PERCENT,/)
  assert.doesNotMatch(page, /^\s*volume: 6,\s*$/m, 'the form default is read from the contract, not copied')
  assert.match(panel, /volume: DEFAULT_BACKGROUND_MUSIC_VOLUME_PERCENT,/)
})

test('the music-options standard is shown on Audio Assembly, with no way to block a merge', () => {
  assert.equal(MIN_CHANNEL_MUSIC_OPTIONS, 10)
  // The count comes from the pool state the backend measures, and the wording comes from the
  // contract — so the sentence cannot drift from the number it quotes.
  assert.match(page, /get<\{ music_options\?: MusicOptionsMeasurement \} \| null>\(`\/projects\/\$\{slug\.value\}\/music-pool`\)/)
  assert.match(page, /buildMusicOptionsNotice\(musicOptions\.value\)/)
  assert.match(page, /\{\{ musicOptionsNotice\.text \}\}/)
  assert.match(page, /This is a standard, not a limit — assembly still runs\./)
  // Display only: the merge-submit path never reads the count, so a channel that
  // falls short can always be assembled (§8 — no hidden gate).
  const submit = page.slice(page.indexOf('async function generateMergedAudio('), page.indexOf('async function applyMergeFormatDefaultsIfNoPreset'))
  assert.ok(submit.length > 0, 'submitMerge exists')
  assert.doesNotMatch(submit, /musicOptions/)
})

test('a remembered choice and a Formula’s own level still win over the default', () => {
  // The page applies the Formula's starting level only while the remembered volume is untouched.
  assert.match(page, /if \(rememberedMusicVolume === music\.volume\) music\.volume = m\.musicVolume/)
})

test('the Production Board shows the same count, reading the same measurement and wording', () => {
  assert.match(board, /musicOptionsNotice as musicOptionsNoticeFor/)
  assert.match(board, /get<\{ music_options\?: MusicOptionsMeasurement \} \| null>\(`\/projects\/\$\{slug\.value\}\/music-pool`\)/)
  assert.match(board, /\{\{ musicOptionsCount \}\}<\/strong> music options/)
  // The standard's number also comes from the contract, never a second literal.
  assert.match(board, /standard is \{\{ MIN_CHANNEL_MUSIC_OPTIONS \}\}/)
  // Unmeasurable reads as "—", never as a fake zero (§6).
  assert.match(board, /return m && 'usable' in m \? m\.usable : '—'/)
  // A standard, never a gate: the board only renders it.
  assert.doesNotMatch(board, /missing_prerequisite[^\n]*music/i)
})
