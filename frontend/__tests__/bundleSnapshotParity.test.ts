/**
 * 1.4.286 — the Video Assembly preset's copy of each slot is the slot preset itself.
 *
 * The Effects slot had two hand-kept lists and the bundle's was missing `frame`, so every
 * Pipeline batch dropped the Presentation Frame (refinanced, terranash). The intro copy held a
 * stale outro, and the subtitles copy never kept "hide captions during the intro". One snapshot
 * and one apply per slot means a new setting cannot be saved in one and forgotten in the other.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const page = readFileSync(fileURLToPath(new URL('../pages/projects/[slug]/video-assembly.vue', import.meta.url)), 'utf8')
const body = (name: string) => page.slice(page.indexOf(`function ${name}(`), page.indexOf('\n}\n', page.indexOf(`function ${name}(`)))

test('Effects, Intro and Subtitles presets use the same snapshot and apply as the bundle copy', () => {
  assert.match(page, /configKey: 'effects',\s*snapshot: \(\) => snapshotEffectsData\(\),\s*apply: \(raw: any\) => applyEffectsData\(raw\),/)
  assert.match(page, /configKey: 'intro',[\s\S]{0,600}?snapshot: \(\) => snapshotIntroData\(\),\s*apply: \(data: any\) => applyIntroData\(data\),/)
  assert.match(page, /configKey: 'subtitles',\s*snapshot: \(\) => snapshotSubtitlesData\(\),\s*apply: \(data: any\) => applySubtitlesData\(data\),/)
  assert.match(page, /fallback: \{\s*intro: snapshotIntroData\(\),\s*timeline: snapshotTimelineData\(\),\s*effects: snapshotEffectsData\(\),\s*subtitles: snapshotSubtitlesData\(\),/)
})

test('the bundle copy keeps the frame, the live outro and timeline clips, and the captions-intro choice', () => {
  assert.match(body('snapshotEffectsData'), /frame: \{ \.\.\.frame \}/)
  assert.match(body('applyEffectsData'), /if \(data\.frame\) Object\.assign\(frame, data\.frame\)/)
  assert.match(body('snapshotIntroData'), /outro: \{ \.\.\.outro \}[\s\S]*timeline_clips: timelineClips\.value\.map/)
  assert.match(body('snapshotSubtitlesData'), /hide_during_intro: subtitles\.hide_during_intro/)
  assert.match(body('applySubtitlesData'), /typeof data\.hide_during_intro === 'boolean'/)
})
