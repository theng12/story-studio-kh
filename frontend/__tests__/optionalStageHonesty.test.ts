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

// ── the Pipeline's step truth tables must not silently lose a step ──
//
// Both switches below carry a trailing `return false`, which defeats
// TypeScript's exhaustiveness check: dropping a `case` compiles clean and
// renders a permanently-grey pill. The backend's `isStepAlreadyDone` has no
// such fallback, so it is the authority on which steps exist.

const backend = readFileSync(
  fileURLToPath(new URL('../../electron/server/routes/pipeline.ts', import.meta.url)), 'utf8')

/** Slice a named function's body out of a source file. */
function fnBody(src: string, name: string): string {
  const start = src.indexOf(`function ${name}`)
  assert.ok(start > -1, `${name} must exist`)
  const end = src.indexOf('\n}', start)
  assert.ok(end > start, `${name} must terminate`)
  return src.slice(start, end)
}

/** The step ids a switch actually handles. */
function casesIn(body: string): string[] {
  return [...body.matchAll(/case '([a-z_-]+)':/g)].map(m => m[1]).sort()
}

const backendSteps = casesIn(fnBody(backend, 'isStepAlreadyDone'))

test('every backend batch step has a done-pill rule on the Pipeline', () => {
  const ui = casesIn(fnBody(pipeline, 'isStepDoneForEpisode'))
  const missing = backendSteps.filter(s => !ui.includes(s))
  assert.deepEqual(missing, [],
    `these steps fall through to \`return false\`, so their pill reads "missing" on every episode forever: ${missing.join(', ')}`)
})

test('every backend batch step has a manual-override rule on the Pipeline', () => {
  const ui = casesIn(fnBody(pipeline, 'isStepManualForEpisode'))
  const missing = backendSteps.filter(s => !ui.includes(s))
  assert.deepEqual(missing, [],
    `these steps can never show the (manual override) hint: ${missing.join(', ')}`)
})

test('the Research pill reads the same field the backend skips on', () => {
  // Backend: `case 'research': return status.research` — evidence exists.
  // The Board's Research column reads `status.research` too (board.vue
  // STEP_FIELD), so reading anything else here re-opens the disagreement
  // where the Board counts 20 done and the Pipeline shows 20 blank.
  const line = fnBody(pipeline, 'isStepDoneForEpisode')
    .split('\n').find(l => l.includes("case 'research':"))
  assert.ok(line, 'the Research row must exist in the truth table')
  assert.match(line!, /s\.research\b/, 'Research is done once evidence exists')
  assert.ok(!/research_reviewed/.test(line!),
    'claim triage is separate editorial state — it must not gate the done pill')
})

test('the Research pill says when claims are still un-triaged', () => {
  // `research` (evidence exists) and `research_reviewed` (no claim left
  // pending) are different facts. One tick cannot carry both, so the
  // tooltip carries the second one rather than the pill silently dropping it.
  const note = fnBody(pipeline, 'researchNote')
  assert.match(note, /research_reviewed\b/, 'the tooltip must distinguish triaged from un-triaged research')
  assert.match(note, /claims still to review/i, 'and say so in words the owner can read')
  assert.match(note, /research_reviewed_by/, 'and never imply a person read claims the Pipeline auto-accepted')
  assert.match(note, /not read by a person/i, 'naming the auto-accept outright')
  // ...and it has to actually reach the tooltip.
  assert.match(fnBody(pipeline, 'pillTitle'), /researchNote\(/, 'pillTitle must use it')
})

test('the Production Board and the Pipeline agree on what a Research tick means', () => {
  // The bug the owner reported: Board "20/150 researched", Pipeline all blank.
  // Both must key the tick off `status.research` (evidence exists) — the field
  // the backend also skips on — so the two views can never report different
  // totals for the same episodes again.
  const board = page('board.vue')
  // v1.4.82 — the step -> status-field map moved out of board.vue into the
  // shared composable, because three surfaces each kept a drifting copy of it.
  // The rule this test protects is unchanged: the Board's Research column and
  // the Pipeline's Research pill must read the SAME field.
  const flow = readFileSync(fileURLToPath(new URL('../composables/useProjectFlow.ts', import.meta.url)), 'utf8')
  assert.match(flow, /^\s*research: 'research',$/m,
    'the shared step map must map Research to status.research')
  assert.match(board, /STEP_STATUS_FIELD\[step\.key\]/,
    'and the Board columns must be built from that shared map, not a private copy')
  assert.match(fnBody(pipeline, 'isStepDoneForEpisode').split('\n').find(l => l.includes("case 'research':"))!,
    /s\.research\b/, 'and the Pipeline pill must read the same field')

  // Agreeing on the tick is only half of it. Triage is a real, separate fact,
  // so BOTH views have to say it rather than let one tick imply it.
  for (const [name, src] of [['board.vue', board], ['pipeline.vue', pipeline]] as const) {
    const note = fnBody(src, 'researchNote')
    assert.match(note, /claims still to review/i, `${name} must surface un-triaged claims`)
    assert.match(note, /not read by a person/i, `${name} must not pass an auto-accept off as human review`)
  }
})
