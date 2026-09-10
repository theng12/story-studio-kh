/**
 * v1.4.0 — Video Assembly does not choose a subtitle file at all.
 *
 * ── Why this file was rewritten rather than deleted ──
 *
 * It was written for v1.3.4, which fixed a real incident: `EP0047_final_video.mp4`
 * was rendered with EP0048's subtitles burned across it. The video was
 * unmistakably EP0047 — 989.833s, matching its own merged audio — but the
 * caption at t=14s read "…At Timbuktu, that process has", cue #3 of EP0048's
 * stitched SRT. The cause was `subtitles.srt_path`: an absolute path to one
 * episode's file, held in page state, never re-resolved when the episode
 * changed. That was the fifth instance of a documented shape (AGENTS.md, "Preset
 * Boundaries"): episode-specific state surviving an episode change.
 *
 * v1.3.4 taught the page to re-resolve that path and to announce every change.
 * The owner then asked for the choice itself to go: *"there's no need for me to
 * select which subtitle but automatically selected the stitched subtitle. you
 * don't need to show the several chapters ones as well"*.
 *
 * So the page now holds no path, resolves nothing, and announces nothing —
 * because nothing changes under the customer any more. The backend's
 * `resolveBurnSubtitle`, the renderer's own resolver, reports its answer as
 * `burn_target` and the page displays it. These tests therefore assert a DISPLAY
 * contract rather than a decision: that what is shown is the renderer's answer,
 * that per-chapter partials are never offered, and that a pin is only called the
 * customer's choice when it is the file actually being burned.
 *
 * Kept with its history, as `continuityPresetPacing.test.ts` was, so the next
 * reader sees this was decided rather than quietly dropped. The guarantee the
 * old file protected has not been weakened — it lives in
 * `electron/server/__tests__/video-subtitle-episode-ownership.test.ts`, where
 * the renderer refuses a foreign path outright, and it is now unreachable from
 * this page because the page sends no path at all.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  describeSubtitleBurn,
  isChapterPartial,
} from '../utils/subtitle-episode-selection.js'

const EP47 = '/p/EP0047 - Rome/EP0047 - 09 Subtitles Output'

const ep47Files = [
  { path: `${EP47}/EP0047_stitched.corrected.srt`, filename: 'EP0047_stitched.corrected.srt' },
  { path: `${EP47}/EP0047_stitched.srt`, filename: 'EP0047_stitched.srt' },
  { path: `${EP47}/EP0047_whisper.srt`, filename: 'EP0047_whisper.srt' },
  { path: `${EP47}/EP0047_Chapter_01.srt`, filename: 'EP0047_Chapter_01.srt' },
  { path: `${EP47}/EP0047_Chapter_02.srt`, filename: 'EP0047_Chapter_02.srt' },
]

test('a per-chapter partial is recognised whatever its casing', () => {
  assert.equal(isChapterPartial('EP0047_Chapter_01.srt'), true)
  assert.equal(isChapterPartial('EP0047_chapter_12.srt'), true)
  assert.equal(isChapterPartial('EP0047_stitched.srt'), false)
  assert.equal(isChapterPartial('EP0047_stitched.corrected.srt'), false)
  // A hand-imported file with "chapter" in its title but no number is a whole
  // transcript, not a partial. Excluding it would hide a legitimate choice.
  assert.equal(isChapterPartial('The Chapter House.srt'), false)
})

test('the page shows the renderer’s answer, not one of its own', () => {
  // Deliberately NOT the file a frontend heuristic would reach for first. If
  // this page ever starts re-deriving the choice, this assertion is what fails.
  const view = describeSubtitleBurn({
    existing_srts: ep47Files,
    burn_target: 'EP0047_whisper.srt',
    selected_subtitle: null,
  })
  assert.equal(view.burning, 'EP0047_whisper.srt')
  assert.equal(view.pinned, false)
})

test('per-chapter partials are never offered, and their absence is stated', () => {
  const view = describeSubtitleBurn({
    existing_srts: ep47Files,
    burn_target: 'EP0047_stitched.corrected.srt',
    selected_subtitle: null,
  })
  const names = view.alternatives.map(a => a.filename)
  assert.deepEqual(names, ['EP0047_stitched.srt', 'EP0047_whisper.srt'])
  assert.ok(!names.some(isChapterPartial), 'a chapter partial reached the Change list')
  // Hidden, but not concealed: the count is shown, so two files that exist and
  // are not listed cannot read as a missing-file bug.
  assert.equal(view.hidden_chapter_count, 2)
})

test('the active file is not offered as an alternative to itself', () => {
  const view = describeSubtitleBurn({
    existing_srts: ep47Files,
    burn_target: 'EP0047_stitched.srt',
    selected_subtitle: null,
  })
  assert.ok(!view.alternatives.some(a => a.filename === 'EP0047_stitched.srt'))
})

test('a pin is only called the customer’s choice when it is what burns', () => {
  const honoured = describeSubtitleBurn({
    existing_srts: ep47Files,
    burn_target: 'EP0047_whisper.srt',
    selected_subtitle: 'EP0047_whisper.srt',
  })
  assert.equal(honoured.pinned, true)

  // A pin naming a file that has since been deleted is honoured by nothing.
  // Printing "YOUR CHOICE" beside a file he did not choose would be the same
  // class of lie this release exists to remove.
  const stale = describeSubtitleBurn({
    existing_srts: ep47Files,
    burn_target: 'EP0047_stitched.corrected.srt',
    selected_subtitle: 'EP0047_deleted.srt',
  })
  assert.equal(stale.pinned, false)
  assert.equal(stale.burning, 'EP0047_stitched.corrected.srt')
})

test('an episode with no transcripts reports nothing rather than guessing', () => {
  const view = describeSubtitleBurn({ existing_srts: [], burn_target: null, selected_subtitle: null })
  assert.equal(view.burning, null)
  assert.equal(view.pinned, false)
  assert.deepEqual(view.alternatives, [])
  assert.equal(view.hidden_chapter_count, 0)
})

test('a missing or malformed status never throws at the caller', () => {
  // This drives a panel on a 5,800-line page; a status that has not arrived yet
  // must render as "nothing known", never as an exception during setup.
  for (const input of [null, undefined, {}, { existing_srts: null }]) {
    const view = describeSubtitleBurn(input as never)
    assert.equal(view.burning, null)
    assert.deepEqual(view.alternatives, [])
  }
})

/**
 * The page must not hold, send, or re-acquire a transcript path.
 *
 * Asserted against the source because the defect being prevented is the mere
 * EXISTENCE of that state: a unit test over a helper cannot see a `srt_path`
 * field reappearing in a reactive object 3,000 lines away, and that field is
 * exactly what put one episode's captions onto another's video.
 */
const pagePath = fileURLToPath(new URL('../pages/projects/[slug]/video-assembly.vue', import.meta.url))
const ioPath = fileURLToPath(new URL('../composables/useVideoAssemblyIo.ts', import.meta.url))

test('Video Assembly holds no subtitle path and sends none', () => {
  const page = readFileSync(pagePath, 'utf8')
  const io = readFileSync(ioPath, 'utf8')

  // No assignment to a page-held subtitle path, in any form.
  assert.ok(
    !/subtitles\.srt_path\s*=/.test(page),
    'video-assembly.vue assigns subtitles.srt_path — the episode-specific state this release removed',
  )
  // And none in the render payload: the renderer resolves it per episode, and a
  // browser-supplied path is what the backend ownership guard exists to refuse.
  assert.ok(
    !/srt_path:/.test(io),
    'useVideoAssemblyIo still sends srt_path in the render payload',
  )
  // The subtitles block must no longer be gated on a path, or a render would be
  // silently captionless whenever the browser had none.
  assert.ok(
    io.includes('if (s.subtitles?.enabled) {'),
    'the subtitles payload block should be gated on `enabled` alone',
  )
})

test('a single-episode render is gated on the caption check', () => {
  const page = readFileSync(pagePath, 'utf8')
  // The frames exist to be looked at BEFORE the encode. If Generate ever calls
  // straight through, they become decoration.
  assert.ok(
    page.includes('if (!preflightConfirmed.value)'),
    'generateVideo must run the caption preflight before enqueuing',
  )
  // And the confirmation must not outlive what it was about.
  assert.ok(page.includes('resetSubtitlePreflight()'), 'the confirmation must be reset')
})

/**
 * The removals themselves, asserted.
 *
 * A feature that is supposed to be GONE needs a test as much as one that is
 * supposed to work: the old picker and its swap announcement were both correct
 * code, and either could be reinstated in good faith by someone reading the
 * v1.3.4 comments without the owner's later instruction.
 */
test('the manual subtitle picker is gone from Step 5', () => {
  const page = readFileSync(pagePath, 'utf8')
  assert.ok(
    !page.includes('Other subtitle files found'),
    'the old always-visible picker list is back',
  )
  assert.ok(
    !page.includes('pickSubtitlePath'),
    'the page can still set a transcript path by hand',
  )
  // The read-only statement that replaced it must actually be there, or Step 5
  // says nothing at all about which captions are being burned.
  assert.ok(page.includes('burnView.burning'), 'Step 5 must name the file being burned')
})

test('the episode-swap announcement is gone, because nothing swaps any more', () => {
  const page = readFileSync(pagePath, 'utf8')
  // v1.3.4 announced a re-resolve. There is no re-resolve now — the page holds
  // nothing to re-resolve — so an announcement would describe an event that
  // cannot happen.
  assert.ok(!page.includes('subtitleEpisodeSwap'), 'the v1.3.4 swap notice survived the rewrite')
})

test('choosing by hand is still possible, one click away', () => {
  const page = readFileSync(pagePath, 'utf8')
  // He said he should not NEED to choose, not that choosing must be impossible.
  assert.ok(page.includes('subtitleChangeOpen'), 'the Change disclosure is missing')
  assert.ok(page.includes('pinSubtitle('), 'there is no way to pin a transcript')
  assert.ok(page.includes("pinSubtitle('')"), 'there is no way back to automatic')
  // The pin is written server-side, into the episode's own folder. A pin held
  // in the browser would be episode-specific state all over again.
  assert.ok(
    /put\(`\/projects\/\$\{slug\.value\}\/video-editor\/subtitles\/select\//.test(page),
    'the pin must be persisted per episode by the backend',
  )
})

test('the caption frames are inline and there are three of them', () => {
  const page = readFileSync(pagePath, 'utf8')
  // Inline, so the images can be zoomed — he asked for screenshots to judge,
  // and a modal that must be dismissed to see the rest of the page is not that.
  assert.ok(page.includes('preflight-frames'), 'the frame grid is missing')
  assert.ok(!/preflight[^\n]*Modal/i.test(page), 'the caption check must not be a modal')
  // Each frame states what it is showing, or three near-identical stills are
  // impossible to tell apart.
  assert.ok(page.includes('frame.cue_text'), 'each frame must show the caption text it proves')
  assert.ok(page.includes('formatPreflightTime(frame.time_sec)'), 'each frame must state its timestamp')
})

test('an old caption check cannot confirm or replace evidence after an episode switch', async () => {
  const { transform } = await import('esbuild')
  const page = readFileSync(pagePath, 'utf8')
  const start = page.indexOf('let preflightRequestSequence = 0')
  const end = page.indexOf('\n/**', start)
  assert.ok(start > 0 && end > start)
  const code = await transform(page.slice(start, end), { loader: 'ts', format: 'esm' })
  const script = `
    let videoEpisodeSequence = 0
    const episodeId = { value: 'EP0001' }, slug = { value: 'project' }
    const subtitlePreflight = { value: null }, preflightConfirmed = { value: false }
    const preflightRunning = { value: false }, preflightCacheKey = { value: 0 }, preflightStale = { value: false }
    const buildVideoAssemblyPayload = () => ({ episode_id: episodeId.value })
    const showError = () => undefined
    ${code.code}
    return {
      runSubtitlePreflight, subtitlePreflight, preflightConfirmed, preflightRunning,
      switchEpisode() { episodeId.value = 'EP0002'; videoEpisodeSequence++; resetSubtitlePreflight() }
    }
  `
  let finishOld!: (value: any) => void
  const pending = new Promise(done => { finishOld = done })
  let calls = 0
  const state = new Function('post', script)(async () => ++calls === 1 ? pending : { skipped: false, frames: ['new-frame'] })
  const first = state.runSubtitlePreflight()
  state.switchEpisode()
  assert.equal(await state.runSubtitlePreflight(), true)
  finishOld({ skipped: true, frames: [] })
  assert.equal(await first, false)
  assert.equal(state.preflightConfirmed.value, false)
  assert.deepEqual(state.subtitlePreflight.value.frames, ['new-frame'])
  assert.equal(state.preflightRunning.value, false)
})
