import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { describeSubtitleGaps, subtitleChapterLabel } from '../../electron/server/contracts/subtitle-gaps.ts'

const scenePlan = readFileSync(new URL('../pages/projects/[slug]/scene-plan.vue', import.meta.url), 'utf8')
const subtitles = readFileSync(new URL('../pages/projects/[slug]/subtitles.vue', import.meta.url), 'utf8')

// Dreamlands EP0001: Whisper skipped speech inside five chapters (Ch 11 twice).
const dreamlands = [
  { slug: 'Chapter_03', start_sec: 312.2, gap_sec: 35.2 },
  { slug: 'Chapter_07', start_sec: 439.2, gap_sec: 31.6 },
  { slug: 'Chapter_09', start_sec: 135.8, gap_sec: 42.2 },
  { slug: 'Chapter_11', start_sec: 601.0, gap_sec: 31.8 },
  { slug: 'Chapter_11', start_sec: 655.7, gap_sec: 37.2 },
  { slug: 'Chapter_13', start_sec: 49.0, gap_sec: 40.1 },
]

test('names each gap by chapter, length and chapter time, then counts the rest', () => {
  assert.equal(subtitleChapterLabel('Chapter_03'), 'Chapter 3')
  assert.equal(describeSubtitleGaps(dreamlands.slice(0, 1)), 'Chapter 3: 35 s at 5:12')
  assert.equal(
    describeSubtitleGaps(dreamlands, 2),
    'Chapter 3: 35 s at 5:12; Chapter 7: 32 s at 7:19; and 3 more chapters',
  )
  assert.match(describeSubtitleGaps(dreamlands), /Chapter 11: 32 s at 10:01, 37 s at 10:55; Chapter 13: 40 s at 0:49$/)
  assert.equal(describeSubtitleGaps([{ slug: '', gap_sec: 40 }]), 'A part with no single chapter: 40 s')
})

test('Scene Plan names the gap and links to Subtitles instead of a bare "repair" hint', () => {
  assert.match(scenePlan, /if \(blockingSubtitleCueGaps\.value\.length\) return `Subtitles skip speech in \$\{subtitleGapSummary\.value\}\.`/)
  assert.match(scenePlan, /label: 'Fix in Subtitles'/)
  assert.match(scenePlan, /:generate-status-link="headerPrimaryStatus === subtitleTimelineBlocker \? subtitleTimelineBlockerLink : undefined"/)
})

test('Subtitles gap notice offers Re-transcribe for each affected chapter', () => {
  const notice = subtitles.slice(subtitles.indexOf('v-for="section in gapActionSections"'), subtitles.indexOf('Listen to {{ section'))
  assert.match(notice, /@click="retranscribeChapter\(section\)"/)
  assert.match(notice, /Re-transcribe \$\{section\.replaceAll\('_', ' '\)\}/)
})
