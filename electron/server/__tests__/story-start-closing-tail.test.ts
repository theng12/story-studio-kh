/**
 * Regression for a surviving completion-review finding — 2026-10-19.
 *
 * FINDING: the Scene Plan's "where the story starts" clock is inflated by the
 * merged audio's CLOSING TAIL, because it measures the lead-in a different way
 * than the subtitle stitcher does.
 *
 * The stitcher's authoritative opening comes from `describeMergedAudioOpening`
 * (services/merged-audio-opening.ts), which subtracts the baked closing tail
 * before measuring:
 *   introLeadInFrom(finalDurationSec - closingTailSec, ...)      (line 119)
 *   introLeadInFrom(mergedDurationSec - closingTailSec, ...)     (lines 194-198)
 * So its `lead_in_sec` excludes music that plays AFTER the narration.
 *
 * `computeStoryStartSec` (lib/intro-lead-in.ts:315-339) instead calls
 * `computeIntroLeadInSec` (line 150-157 -> `measureIntroLeadIn` -> `introLeadInFrom`
 * with NO tail subtraction, line 113 `const lead = dur - extent`). The probed
 * `dur` is the WHOLE merged file, so `lead = trueLeadIn + closingTail`. The
 * story start is then `leadIn + Σ(intro chapters + gaps)` (lines 330-333) —
 * inflated by exactly the closing tail.
 *
 * CONSEQUENCE: on a sleep-story episode whose merge baked a closing music tail,
 * `story_start_sec` is too large. Its consumers move the plan and the render:
 *   - generators/scene-plan.ts:2475,2477  -> `skipUntilSec = story.story_start_sec`
 *     skips real story content at the head of the plan;
 *   - routes/video.ts:361-363             -> `hold_sec = story_start_sec - intro_video_sec`
 *     holds the title card too long.
 * The doc comment at lines 300-314 claims it "mirrors the subtitle-stitcher's
 * cursor math EXACTLY" — it does not, by the closing tail.
 *
 * WHY THIS IS NOT the excluded "plan-end duration/shared drift" item: that one
 * is `scenePlanLeadInShiftSec` (the plan's END tail). This is the plan's START
 * clock, computed by a different function that never consults the tail.
 *
 * The completion-record shape below is the real one written by
 * generators/audio-merge.ts:1181-1202 (`schema_version`, `output_filename`,
 * `bytes`, `duration_sec`, `generated_at`, `master_filename`, `closing_tail_sec`,
 * `opening{lead_in_sec,intro,music_lead_in_sec}`). `describeMergedAudioOpening`
 * (services/merged-audio-opening.ts:159-198) reads exactly `output_filename`,
 * `closing_tail_sec`, and `opening.lead_in_sec`, so the recorded (tail-excluded)
 * opening control is reached; and even if it fell through to the measured path,
 * `introLeadInFrom(104.5 - 8, ...)` = 6 with this fixture's chapters. Either way
 * the opening control is 6 s and the story start is the intended red.
 *
 * PLACEMENT: uses the application's own relative imports, so copy to
 * electron/server/__tests__/ before running against a release worktree.
 *
 * EXPECTED RED on the current source: `computeStoryStartSec` returns
 * lead-in + tail + Introduction + gap (44.5 for the fixture) instead of
 * lead-in + Introduction + gap (36.5). GREEN once it excludes the tail the same
 * way the stitcher does. The fixture (a real PCM WAV, so ffprobe reports an
 * exact duration) is left on disk.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { computeStoryStartSec, resolveEpisodeIntroLeadIn } from '../lib/intro-lead-in.js'

const SAMPLE_RATE = 8000

/** A minimal PCM 16-bit mono WAV of an exact duration, so ffprobe's duration is deterministic. */
function wav(seconds: number): Buffer {
  const samples = Math.round(seconds * SAMPLE_RATE)
  const dataBytes = samples * 2
  const buf = Buffer.alloc(44 + dataBytes)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataBytes, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)            // PCM
  buf.writeUInt16LE(1, 22)            // mono
  buf.writeUInt32LE(SAMPLE_RATE, 24)
  buf.writeUInt32LE(SAMPLE_RATE * 2, 28) // byte rate
  buf.writeUInt16LE(2, 32)            // block align
  buf.writeUInt16LE(16, 34)           // bits per sample
  buf.write('data', 36)
  buf.writeUInt32LE(dataBytes, 40)
  return buf
}

const CODE = 'EP0047'
const SECTIONS = [
  { slug: 'Introduction', duration_s: 30 },
  { slug: 'Chapter_01', duration_s: 60 },
]
const GAP = 0.5
const INTRO_DURATION = 30
const LEAD_IN = 6            // what the merge recorded before the narration
const CLOSING_TAIL = 8       // music after the narration
const EXTENT = 30 + 60 + GAP // Σ durations + inter-section gaps
const MERGED_SECONDS = LEAD_IN + EXTENT + CLOSING_TAIL

test('RED: the story start is not inflated by the merged audio closing tail', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'story-start-tail-'))
  const episodeDir = path.join(root, 'episode')
  const mergedDir = path.join(episodeDir, 'merged')
  await fs.mkdir(mergedDir, { recursive: true })
  await fs.writeFile(path.join(episodeDir, 'audio_chapters.json'),
    JSON.stringify({ sections: SECTIONS, gap_duration_s: GAP }))

  const mergedName = `${CODE}_merged_audio.wav`
  const mergedPath = path.join(mergedDir, mergedName)
  const mergedBytes = wav(MERGED_SECONDS)
  await fs.writeFile(mergedPath, mergedBytes)
  await fs.writeFile(path.join(mergedDir, `${CODE}_merged_audio.completion.json`), JSON.stringify({
    schema_version: 2,
    output_filename: mergedName,
    bytes: mergedBytes.length,
    duration_sec: MERGED_SECONDS,
    generated_at: '2026-10-19T00:00:00.000Z',
    master_filename: `${CODE}_merged_audio_master.wav`,
    closing_tail_sec: CLOSING_TAIL,
    opening: {
      lead_in_sec: LEAD_IN,
      intro: { filename: 'intro.mp3', duration_sec: LEAD_IN, gap_after_sec: 0 },
      music_lead_in_sec: 0,
    },
  }))

  // The stitcher's authoritative opening excludes the tail (the merge recorded it).
  const opening = await resolveEpisodeIntroLeadIn(episodeDir, mergedDir, CODE)
  assert.equal(opening.status, 'measured')
  assert.equal(opening.seconds, LEAD_IN, 'the stitcher lead-in must be the recorded value, tail excluded')

  // computeStoryStartSec must place the story on that same clock.
  const story = await computeStoryStartSec(mergedPath, SECTIONS, GAP)
  assert.ok(story, 'a leading Introduction chapter must yield a story start')
  const expected = LEAD_IN + INTRO_DURATION + GAP // 36.5
  assert.ok(
    Math.abs(story!.story_start_sec - expected) <= 0.05,
    `story_start_sec must be the stitcher lead-in (${LEAD_IN}) + Introduction (${INTRO_DURATION}) `
    + `+ gap (${GAP}) = ${expected}; got ${story!.story_start_sec}. The closing tail (${CLOSING_TAIL}s) `
    + 'plays AFTER the narration and must not move the story start.',
  )
})
