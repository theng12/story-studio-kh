/**
 * Where the subtitle-quality warning must appear — v1.2.2
 *
 * Detection is worthless if nobody sees it. Three surfaces matter, for
 * different reasons, and each is easy to lose in a later refactor:
 *
 *   1. Subtitles       — where transcripts are made and judged.
 *   2. Scene Plan      — where the transcript becomes image prompts. The
 *                        owner generates image prompts from transcripts, so a
 *                        hallucinated block does not merely look wrong in a
 *                        caption, it buys wrong pictures. This is the surface
 *                        where corruption costs money.
 *   3. Video Assembly  — the last moment before captions are baked into a video
 *                        and shipped to a customer.
 *
 * Two properties are load-bearing and asserted here as well: the warning is
 * ADVISORY (it must never disable or gate a render), and the app never offers
 * to rewrite a subtitle — a mangled word cannot be repaired without knowing
 * what was said, so re-transcription is the only remedy on offer.
 *
 * Source-text assertions, matching this suite's existing style.
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

const component = read('../components/SubtitleQualityWarning.vue')
const subtitlesPage = read('../pages/projects/[slug]/subtitles.vue')
const scenePlanPage = read('../pages/projects/[slug]/scene-plan.vue')
const videoAssemblyPage = read('../pages/projects/[slug]/video-assembly.vue')
const types = read('../types/subtitle-quality.ts')
const backendLib = read('../../electron/server/lib/subtitle-quality.ts')

describe('the warning reaches every surface that consumes a transcript', () => {
  test('Subtitles page shows it per file, and marks affected chapters', () => {
    assert.match(subtitlesPage, /<SubtitleQualityWarning/)
    // Readiness is not only "is there an SRT" but "is the SRT usable" — a
    // transcribed chapter full of hallucinated script looks done and is not.
    assert.match(subtitlesPage, /chapterIsGarbled\(s\.slug\)/)
    assert.match(subtitlesPage, /garbled-tag/)
  })

  test('Scene Plan shows it, because this transcript becomes image prompts', () => {
    assert.match(scenePlanPage, /<SubtitleQualityWarning/)
    assert.match(scenePlanPage, /:quality="status\.transcript_source\?\.quality"/)
    // The consequence must be spelled out where credits are about to be spent.
    assert.match(scenePlanPage, /image prompts/i)
  })

  test('Video Assembly shows it for the file about to be burned in', () => {
    assert.match(videoAssemblyPage, /<SubtitleQualityWarning/)
    assert.match(videoAssemblyPage, /activeSubtitleQuality/)
    // v1.4.0 — keyed off the resolved FILENAME, because the page no longer holds
    // a path. `burn_target` is the renderer's own answer for this episode, so the
    // warning still describes the file that will actually be burned.
    assert.match(videoAssemblyPage, /existing_srts\?\.find\(s => s\.filename === active\)/)
    assert.match(videoAssemblyPage, /burnView\.value\.burning/)
  })
})

describe('the warning is advisory, never a gate', () => {
  test('the component renders no disabled state and no blocking language', () => {
    assert.doesNotMatch(component, /:disabled=/, 'the warning must not disable anything')
    assert.doesNotMatch(component, /\bcannot (render|continue|proceed)\b/i)
  })

  test('rendering is not gated on subtitle quality anywhere', () => {
    // A person may knowingly ship a caption with an odd character in it.
    // Turning this into a blocker is a decision the owner has not made.
    for (const [name, page] of [['video assembly', videoAssemblyPage], ['scene plan', scenePlanPage]] as const) {
      assert.doesNotMatch(page, /quality[^\n]*\|\|[^\n]*generateDisabled/i, `${name} must not gate on quality`)
      assert.doesNotMatch(page, /generateDisabled[^\n]*quality/i, `${name} must not gate on quality`)
    }
  })
})

describe('the app never edits anyone\'s subtitles', () => {
  test('the only remedy offered is re-transcription, never a rewrite', () => {
    assert.match(subtitlesPage, /Regenerate this chapter/)
    for (const page of [subtitlesPage, scenePlanPage, videoAssemblyPage, component]) {
      assert.doesNotMatch(page, /\b(clean up|auto-?fix|strip|sanitiz|repair) (the )?(subtitle|cue|transcript)/i)
    }
  })

  test('a targeted re-transcribe re-asks and pays for one chapter only', () => {
    // force:true is what makes GenStudio produce a fresh result instead of
    // replaying the stored one; sections narrows the charge to this chapter.
    assert.match(subtitlesPage, /force: true,\s*\n\s*sections: \[sectionSlug\]/)
  })

  test('every chapter exposes the scoped fresh-generation action with honest price language', () => {
    assert.match(subtitlesPage, /@click="retranscribeChapter\(s\.slug\)"/)
    assert.match(subtitlesPage, /chapterHasSrt\(s\.slug\) \? 'Regenerate this chapter' : 'Generate this chapter'/)
    assert.match(subtitlesPage, /:aria-label="`\$\{chapterHasSrt\(s\.slug\) \? 'Regenerate' : 'Generate'\} \$\{s\.label\} subtitles`"/)
    assert.match(subtitlesPage, /Starts a fresh GenStudio request for \$\{s\.label\} only/)
    assert.match(subtitlesPage, /current quote[^<]*may be charged/i)
  })

  test('stitched and imported files do not invent a chapter-level action', () => {
    const files = subtitlesPage.slice(subtitlesPage.indexOf('<!-- Existing files -->'), subtitlesPage.indexOf('<!-- Stitch into the timeline'))
    assert.doesNotMatch(files, /retranscribeChapter/)
  })
})

describe('the report shows evidence, not a count', () => {
  test('each finding renders its cue number, timestamp and the offending text', () => {
    for (const bit of ['f.cue', 'formatClock(f.start_sec)', 'f.label', 'f.text']) {
      assert.ok(component.includes(bit), `the finding row must render ${bit}`)
    }
  })

  test('a truncated list says so rather than quietly hiding cues', () => {
    assert.match(component, /quality!\.truncated/)
    assert.match(component, /more cues are affected/i)
  })

  test('nothing renders when there is nothing to report', () => {
    assert.match(component, /v-if="findings"/)
    assert.match(types, /export function hasQualityFindings/)
  })
})

describe('the frontend contract matches the backend', () => {
  test('every backend rule id exists in the frontend type', () => {
    // A rule added on one side and missed on the other renders a blank label.
    const ids = [...backendLib.matchAll(/^\s{4}id: '([a-z_]+)',$/gm)].map(m => m[1]!)
    assert.ok(ids.length >= 5, `expected the shipped rules, found ${ids.length}`)
    for (const id of ids) {
      assert.ok(types.includes(`'${id}'`), `frontend type is missing rule id ${id}`)
    }
  })

  test('the report fields the UI reads are the ones the backend sends', () => {
    for (const field of ['clean', 'cues', 'affected_cues', 'rules', 'findings', 'truncated']) {
      assert.ok(types.includes(`${field}:`), `frontend type is missing ${field}`)
      assert.ok(backendLib.includes(`${field}:`), `backend report is missing ${field}`)
    }
  })
})
