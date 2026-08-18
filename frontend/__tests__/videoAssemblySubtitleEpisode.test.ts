/**
 * v1.3.4 — Video Assembly never burns another episode's captions.
 *
 * The incident: `EP0047_final_video.mp4` was rendered with EP0048's subtitles
 * burned across it. The video was unmistakably EP0047 — 989.833s, matching its
 * own merged audio — but the caption at t=14s read "indistinguishable from the
 * dunes around it. At Timbuktu, that process has", which is cue #3 of EP0048's
 * stitched SRT. EP0047 is "The Day Rome's Grain Dole Ran Dry"; EP0048 is "The
 * Forgotten Granaries of Timbuktu".
 *
 * The cause: `subtitles.srt_path` holds an absolute path to ONE episode's file.
 * It is correctly excluded from presets, and nothing cleared or re-resolved it
 * when the selected episode changed — the reload that refreshes the file list
 * only ever filled an EMPTY selection.
 *
 * This is the FIFTH instance of one documented shape (AGENTS.md, "Preset
 * Boundaries"): episode-specific state surviving an episode change. The three
 * before it were `title_image.image_path`, `pacing` and `references.sheet`; the
 * fourth was fixed in 1.3.3's cue saving.
 *
 * What is asserted here is the whole decision, including the two cases that
 * must stay SILENT — a selection that is already this episode's, and an empty
 * one being filled in. An announcement that fires when nothing changed is its
 * own defect.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  defaultSubtitlePick,
  resolveSubtitleForEpisode,
  subtitleKind,
} from '../utils/subtitle-episode-selection.js'

const EP47 = '/p/EP0047 - Rome/EP0047 - 09 Subtitles Output'
const EP48 = '/p/EP0048 - Timbuktu/EP0048 - 09 Subtitles Output'

const ep47Files = [
  { path: `${EP47}/EP0047_Chapter_01.srt`, filename: 'EP0047_Chapter_01.srt' },
  { path: `${EP47}/EP0047_stitched.srt`, filename: 'EP0047_stitched.srt' },
  { path: `${EP47}/EP0047_stitched.corrected.srt`, filename: 'EP0047_stitched.corrected.srt' },
  { path: `${EP47}/EP0047_whisper.srt`, filename: 'EP0047_whisper.srt' },
]

test('the incident: EP0048\'s transcript is not kept when EP0047 is selected', () => {
  const outcome = resolveSubtitleForEpisode(`${EP48}/EP0048_stitched.corrected.srt`, ep47Files)
  assert.equal(outcome.action, 'swap')
  assert.equal(outcome.action === 'swap' && outcome.dropped, 'EP0048_stitched.corrected.srt')
  // Re-resolved to the SAME KIND of transcript, this episode's copy — not
  // merely to whatever happened to be first.
  assert.equal(outcome.action === 'swap' && outcome.pick.filename, 'EP0047_stitched.corrected.srt')
})

test('a selection that already belongs to this episode is left alone, silently', () => {
  const outcome = resolveSubtitleForEpisode(`${EP47}/EP0047_whisper.srt`, ep47Files)
  assert.deepEqual(outcome, { action: 'keep' })
})

test('an empty selection is filled without an announcement', () => {
  // "Nothing was chosen, here is the default" is not a change the customer
  // made and must not be reported as one.
  const outcome = resolveSubtitleForEpisode('', ep47Files)
  assert.equal(outcome.action, 'fill')
  assert.equal(outcome.action === 'fill' && outcome.pick.filename, 'EP0047_stitched.srt')
})

test('a foreign kind this episode lacks falls back to its stitched transcript', () => {
  const outcome = resolveSubtitleForEpisode(`${EP48}/EP0048_Chapter_07.srt`, [
    { path: `${EP47}/EP0047_stitched.srt`, filename: 'EP0047_stitched.srt' },
  ])
  assert.equal(outcome.action, 'swap')
  assert.equal(outcome.action === 'swap' && outcome.pick.filename, 'EP0047_stitched.srt')
})

test('an episode with no subtitle files clears the selection and says so', () => {
  const outcome = resolveSubtitleForEpisode(`${EP48}/EP0048_stitched.srt`, [])
  assert.deepEqual(outcome, { action: 'clear', dropped: 'EP0048_stitched.srt' })
})

test('an empty selection with no files available stays quiet', () => {
  assert.deepEqual(resolveSubtitleForEpisode('', []), { action: 'keep' })
})

test('a hand-imported file with no episode code is replaced, not name-matched', () => {
  // Stripping a code from `my-transcript.srt` removes nothing, so the whole
  // name would otherwise be compared against this episode's names and could
  // never match — the fallback must carry it rather than a wrong same-kind hit.
  const outcome = resolveSubtitleForEpisode('/elsewhere/my-transcript.srt', ep47Files)
  assert.equal(outcome.action, 'swap')
  assert.equal(outcome.action === 'swap' && outcome.pick.filename, 'EP0047_stitched.srt')
})

test('subtitleKind identifies the transcript, not the episode', () => {
  assert.equal(subtitleKind('EP0047_stitched.corrected.srt'), '_stitched.corrected.srt')
  assert.equal(subtitleKind('EP0048_stitched.corrected.srt'), '_stitched.corrected.srt')
  assert.equal(subtitleKind('DK0041_whisper.srt'), '_whisper.srt')
  assert.equal(subtitleKind('loose.srt'), 'loose.srt')
})

test('per-chapter partials are never the default pick', () => {
  // v1.0.418's rule, re-asserted because the fallback path now leans on it:
  // a `Chapter_01` fragment is a few seconds of an hour-long episode.
  assert.equal(defaultSubtitlePick([
    { path: `${EP47}/EP0047_Chapter_01.srt`, filename: 'EP0047_Chapter_01.srt' },
  ]), undefined)
})

// ── The page is actually wired to this decision ────────────────────────────
const page = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/video-assembly.vue', import.meta.url)),
  'utf-8',
)

test('Video Assembly calls the resolver instead of only filling an empty slot', () => {
  assert.ok(
    page.includes('resolveSubtitleForEpisode(subtitles.srt_path'),
    'loadSubtitlesStatus must run every refresh through resolveSubtitleForEpisode',
  )
  assert.ok(
    !/if \(!subtitles\.srt_path\) \{/.test(page),
    'the "only fill an EMPTY selection" guard is the defect — it must not come back',
  )
})

test('a swap is announced on the page, in both the replaced and the cleared case', () => {
  assert.ok(page.includes('subtitleEpisodeSwap'), 'the swap notice state must exist')
  assert.ok(
    /<WorkspaceNotice[\s\S]{0,400}subtitleEpisodeSwap/.test(page),
    'the swap must surface as a WorkspaceNotice, not only in state',
  )
  assert.ok(
    page.includes('belongs to a different episode and was'),
    'the cleared case must say so too — a silent clear is the same defect',
  )
})

test('picking or clearing by hand dismisses the notice', () => {
  // It reports something the customer has now superseded; leaving it up would
  // describe a state that no longer exists.
  assert.ok(page.includes('subtitleEpisodeSwap = null'))
})
