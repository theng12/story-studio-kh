/**
 * v1.2.7 — two UI claims that had drifted from what the backend actually does.
 *
 * Both are source-text assertions rather than behaviour tests, deliberately:
 * each is a copy of a backend rule living in a `.vue` file, and the failure
 * mode is the copy quietly falling out of step with the original. A rendered
 * page cannot catch that — it looks perfectly fine while being wrong.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

function page(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../pages/projects/[slug]/${name}`, import.meta.url)), 'utf8')
}

const pipeline = page('pipeline.vue')
const videoAssembly = page('video-assembly.vue')

test('Pipeline mirrors the backend rule that Contextual Cues is done only once a timeline exists', () => {
  // "Nothing outstanding" and "already generated" are different answers on the
  // backend (`isStepAlreadyDone` in routes/pipeline.ts). If this mirror keeps
  // reading `contextual_cues` alone it will show a ✓ on episodes where the step
  // still has work to do, and the pending selector will skip them.
  const line = pipeline.split('\n').find(l => l.includes("case 'contextual_cues':"))
  assert.ok(line, 'the truth-table row must still exist')
  assert.match(line!, /contextual_cues_generated/, 'the done-pill must require a real timeline, as the backend does')
})

test('Pipeline says which blockers its header is counting', () => {
  // The header counts this page's own setup problems; per-episode preflight is
  // a separate later check. Calling both "blockers" let the header read
  // "0 blockers" beside eighteen preflight failures.
  assert.match(pipeline, /setup blockers/, 'the metric must name what it counts')
  assert.match(pipeline, /preflight when you press Run Batch/i, 'and say where the other check happens')
})

test('"Exclude intro and title from effects" no longer promises to gate subtitles', () => {
  // FFmpeg's libass filters take no timeline `enable`, so this checkbox has
  // never affected a caption — see the filter comment in generators/video.ts.
  const block = videoAssembly.slice(
    videoAssembly.indexOf('<!-- Intro + title exclusion -->'),
    videoAssembly.indexOf('<!-- Intro + title exclusion -->') + 1800,
  )
  assert.ok(block.includes('Exclude intro and title from effects'), 'found the right block')
  const hint = block.slice(block.indexOf('Color grading'), block.indexOf('</p>'))
  const gatedList = hint.slice(0, hint.indexOf('only start after'))
  assert.ok(!/subtitles/i.test(gatedList), 'the list of gated effects must not include subtitles')
  assert.match(hint, /Captions are not affected/, 'and must say so outright')
  assert.match(hint, /Hide captions during the intro/, 'pointing at the control that really does it')
  // The same claim was baked into the condition that reveals the block, so a
  // project with only subtitles on saw a checkbox that could do nothing at all.
  const condition = block.slice(0, block.indexOf('>'))
  assert.ok(!/subtitles\.enabled/.test(condition), 'subtitles must not reveal a control that ignores them')
})
