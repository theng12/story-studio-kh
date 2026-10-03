import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { describeSubtitleGaps, gapAudioSentence, renarrateLink, subtitleChapterLabel } from '../../electron/server/contracts/subtitle-gaps.ts'
import { describeChapterSectionQuality } from '../../electron/server/contracts/section-quality.ts'

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

test('Scene Plan names the gap and leads with Re-narrate (missing chapters still go to Subtitles)', () => {
  assert.match(scenePlan, /if \(blockingSubtitleCueGaps\.value\.length\) return `Subtitles skip speech in \$\{subtitleGapSummary\.value\}\.`/)
  assert.match(scenePlan, /if \(gapSection\) return \{ to: renarrateLink\(slug\.value, episodeId\.value, gapSection\), label: `Re-narrate \$\{subtitleChapterLabel\(gapSection\)\}` \}/)
  assert.match(scenePlan, /const gapSection = !missingSubtitleSections\.value\.length && blockingSubtitleCueGaps\.value\.length/)
  assert.match(scenePlan, /label: 'Fix in Subtitles'/)
  assert.match(scenePlan, /:generate-status-link="headerPrimaryStatus === subtitleTimelineBlocker \? subtitleTimelineBlockerLink : undefined"/)
})

test('Re-narrate opens Audio Generator on that chapter, ready to re-make it', () => {
  assert.equal(renarrateLink('dreamlands sleep', 'EP0001', 'Chapter_03'), '/projects/dreamlands%20sleep/audio?episode_id=EP0001&section=Chapter_03&renarrate=1')
  assert.match(gapAudioSentence('silent'), /No sound here: the narration skipped this part/)
  assert.match(gapAudioSentence('sound'), /humming or mumbling means the narration went wrong; clear speech means only the subtitles missed it/)
  assert.equal(gapAudioSentence(undefined), '')
})

test('Subtitles gap notice leads with Re-narrate and keeps Re-transcribe as the second choice', () => {
  const notice = subtitles.slice(subtitles.indexOf('v-for="section in gapActionSections"'), subtitles.indexOf('Listen to {{ section'))
  assert.match(notice, /v-if="gapSections\.has\(section\)"\s+:to="renarrateLink\(slug, episodeId, section\)"\s+class="btn btn-sm btn-primary"/)
  assert.match(notice, />Re-narrate \{\{ subtitleChapterLabel\(section\) \}\}<\/NuxtLink>/)
  assert.ok(notice.indexOf('Re-narrate {{') < notice.indexOf('retranscribeChapter(section)'), 'Re-narrate comes first')
  assert.match(notice, /gapSections\.has\(section\) \? 'btn-secondary' : 'btn-primary'/)
  assert.match(notice, /@click="retranscribeChapter\(section\)"/)
  assert.match(notice, /Re-transcribe \$\{section\.replaceAll\('_', ' '\)\}/)
  assert.match(subtitles, /The narration itself is missing speech here — re-making the chapter’s audio fixes it\./)
  assert.match(subtitles, /\{\{ gapAudioSentence\(gap\.audio\) \}\}/)
})

test('Audio shows what the Mac\'s section check did per chapter', () => {
  assert.equal(describeChapterSectionQuality({ sections: 9, remade: 0 }), 'Checked by the Mac: all 9 sections came out right the first time.')
  assert.match(describeChapterSectionQuality({ sections: 9, remade: 2 }), /re-made 2 sections that came out wrong \(silent, humming or missing words\), and all 9 now pass/)
  const failed = 'Section 4 of 9 came out silent on all 4 tries, so this part was not saved. Re-narrate to try again, or reword that part of the script.'
  assert.equal(describeChapterSectionQuality({ sections: 9, remade: 3, failed }), failed)
})

test('the header keeps a space between the blocker sentence and its "Fix in Subtitles" link', () => {
  const bar = readFileSync(new URL('../components/TopActionBar.vue', import.meta.url), 'utf8')
  assert.match(bar, /<template v-if="generateStatusLink">\{\{ ' ' \}\}<NuxtLink/)
})

test('Audio Generator: the Re-narrate notice re-makes that one chapter and asks for its subtitles after', () => {
  const audio = readFileSync(new URL('../pages/projects/[slug]/audio.vue', import.meta.url), 'utf8')
  const selector = readFileSync(new URL('../components/AudioChapterSelector.vue', import.meta.url), 'utf8')
  assert.match(audio, /const renarrateTarget = ref\(route\.query\.renarrate === '1' && typeof route\.query\.section === 'string' \? route\.query\.section : ''\)/)
  assert.match(audio, /v-if="renarrateTarget && form\.episode_id"/)
  assert.match(audio, /:disabled="inlineGenerateDisabled"/)
  assert.match(audio, /if \(await queueAudio\(\[section\], 'regenerate', \{ then_subtitles: true \}\)\) await dismissRenarrate\(\)/)
  assert.match(audio, /const payload: Record<string, any> = \{ \.\.\.audioRequestPayload\(targetSections, mode\), \.\.\.extra \}/)
  // Per-chapter section check from the latest run that reported one; nothing when the Gateway passes nothing.
  assert.match(audio, /:section-checks="chapterSectionChecks"/)
  assert.match(audio, /j\.result\?\.section_quality && typeof j\.result\.section_quality === 'object'/)
  assert.match(selector, /\{\{ describeChapterSectionQuality\(sectionChecks\[s\.slug\]!\) \}\}/)
})
