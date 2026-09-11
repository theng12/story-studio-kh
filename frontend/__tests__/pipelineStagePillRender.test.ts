/**
 * The Research and B-Roll pills, PROVEN BY RENDERING.
 *
 * `optionalStageHonesty.test.ts` asserts on the source text, which is the right
 * shape for a mirror-drift guard: it catches the Pipeline's copy of a backend
 * rule falling out of step with the original. It cannot, however, show that the
 * pill a person looks at actually turns green — a `case` label can be present
 * and still be unreachable, shadowed, or attached to a step the template never
 * renders. The bug being fixed here was exactly an absent `case` falling through
 * to `return false`, so the proof has to be the rendered pill, not the label.
 *
 * So this file renders `pipeline.vue`'s OWN pill markup, driven by
 * `pipeline.vue`'s OWN `isStepDoneForEpisode` / `isStepManualForEpisode` /
 * `pillTitle` / `researchNote` — all four lifted out of the real SFC at test
 * time and compiled, never re-typed here. If the switch loses `research` again,
 * the rendered class flips from `done` to `missing` and this fails.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { parse } from '@vue/compiler-sfc'
import ts from 'typescript'
import { isFlowStepApplicable } from '../composables/useProjectFlow.js'

const sfcPath = fileURLToPath(new URL('../pages/projects/[slug]/pipeline.vue', import.meta.url))
const sfcSource = readFileSync(sfcPath, 'utf8')
const descriptor = parse(sfcSource).descriptor
const script = descriptor.scriptSetup?.content ?? descriptor.script?.content ?? ''
const template = descriptor.template?.content ?? ''
assert.ok(script, 'pipeline.vue must have a script block')
assert.ok(template, 'pipeline.vue must have a template block')

/** Lift one top-level `function NAME(...) {...}` out of the real script, by brace matching. */
function extractFunction(name: string): string {
  const start = script.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `pipeline.vue must still define ${name}()`)
  let depth = 0
  let seenBody = false
  for (let i = start; i < script.length; i++) {
    if (script[i] === '{') { depth++; seenBody = true }
    else if (script[i] === '}') {
      depth--
      if (seenBody && depth === 0) return script.slice(start, i + 1)
    }
  }
  throw new Error(`could not find the end of ${name}()`)
}

const FUNCTIONS = [
  'episodeVisualSource',
  'isStepApplicableForEpisode',
  'isStepDoneForEpisode',
  'isStepManualForEpisode',
  'researchNote',
  'pillTitle',
] as const

/** Compile the real functions to JS and hand them back as plain callables. */
function loadRealFunctions(): Record<string, (...args: any[]) => any> {
  const src = `${FUNCTIONS.map(extractFunction).join('\n\n')}\nreturn { ${FUNCTIONS.join(', ')} }`
  const js = ts.transpileModule(src, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText
  // eslint-disable-next-line no-new-func
  return new Function('isFlowStepApplicable', js)(isFlowStepApplicable)
}

const real = loadRealFunctions()

/** The exact `<div class="ep-status">…</div>` block the page renders, verbatim. */
function extractPillMarkup(): string {
  const start = template.indexOf('<div class="ep-status">')
  assert.notEqual(start, -1, 'pipeline.vue must still render the ep-status pill row')
  const end = template.indexOf('</div>', template.indexOf('</span>', start))
  return template.slice(start, end + '</div>'.length)
}

const pillMarkup = extractPillMarkup()

// The real step metadata rows, so the labels and icons are the page's own.
const STEPS = [
  { id: 'research', label: 'Research (optional)', icon: '🔍', optional: true },
  { id: 'broll', label: 'B-Roll Pick + Assemble', icon: '🎞' },
  { id: 'script-only', label: 'Script', icon: '📝' },
]

async function renderPills(ep: Record<string, unknown>): Promise<string> {
  const app = createSSRApp({
    template: `<div>${pillMarkup}</div>`,
    data: () => ({ visibleSteps: STEPS, ep: { visual_source: 'scene_plan', ...ep } }),
    methods: {
      isStepApplicableForEpisode: real.isStepApplicableForEpisode,
      isStepDoneForEpisode: real.isStepDoneForEpisode,
      isStepManualForEpisode: real.isStepManualForEpisode,
      pillTitle: real.pillTitle,
    },
  })
  app.config.warnHandler = () => {}
  return await renderToString(app)
}

/** Pull the rendered class + title for one step out of the HTML. */
function pillFor(html: string, icon: string): { done: boolean; manual: boolean; title: string } {
  const spans = html.match(/<span[^>]*>[^<]*<\/span>/g) ?? []
  const span = spans.find(s => s.includes(icon))
  assert.ok(span, `a pill for ${icon} must be rendered`)
  const title = /title="([^"]*)"/.exec(span!)?.[1] ?? ''
  return {
    done: /class="[^"]*\bdone\b/.test(span!),
    manual: /class="[^"]*\bmanual\b/.test(span!),
    // SSR escapes the em dash's neighbours, not the dash; decode the entities we use.
    title: title.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'"),
  }
}

test('the Research pill renders GREEN when the backend says research is done', async () => {
  // This is the owner's report: the Production Board showed research done for
  // 20 episodes while the Pipeline pill stayed grey, because the switch had no
  // `case 'research'` and fell through to `return false`.
  const html = await renderPills({
    episode_code: 'EP0001',
    status: { research: true, research_reviewed: true, research_has_usable_claims: true },
  })
  const pill = pillFor(html, '🔍')
  assert.equal(pill.done, true, 'research: true must render a done pill, not a missing one')
  assert.match(pill.title, /✓ done/, 'and the tooltip must agree with the colour')
})

test('the Research pill renders GREY when there is no evidence', async () => {
  const html = await renderPills({ episode_code: 'EP0001', status: { research: false } })
  const pill = pillFor(html, '🔍')
  assert.equal(pill.done, false, 'no evidence must still render as missing')
  assert.match(pill.title, /missing/)
})

test('the B-Roll pill renders GREEN off video_assembly, the field the backend reads', async () => {
  // routes/pipeline.ts: `case 'broll': return status.video_assembly`.
  const html = await renderPills({ episode_code: 'EP0001', status: { video_assembly: true } })
  assert.equal(pillFor(html, '🎞').done, true, 'video_assembly: true must light the B-Roll pill')

  const notYet = await renderPills({ episode_code: 'EP0001', status: { video_assembly: false } })
  assert.equal(pillFor(notYet, '🎞').done, false)
})

test('a done Research pill still says out loud when claims are un-triaged', async () => {
  // The tick means "evidence exists". Triage is a separate editorial fact and
  // must not be folded into the colour, but it must not be silent either.
  const html = await renderPills({
    episode_code: 'EP0001',
    status: { research: true, research_reviewed: false },
  })
  const pill = pillFor(html, '🔍')
  assert.equal(pill.done, true, 'un-triaged claims do not un-do the evidence')
  assert.match(pill.title, /claims still to review/, 'but the tooltip has to say so')
})

test('an unattended auto-accept never reads as a person having reviewed the claims', async () => {
  const auto = await renderPills({
    episode_code: 'EP0001',
    status: {
      research: true,
      research_reviewed: true,
      research_reviewed_by: 'pipeline-auto',
      research_has_usable_claims: true,
    },
  })
  assert.match(pillFor(auto, '🔍').title, /not read by a person/)

  const human = await renderPills({
    episode_code: 'EP0001',
    status: {
      research: true,
      research_reviewed: true,
      research_reviewed_by: 'human',
      research_has_usable_claims: true,
    },
  })
  const humanTitle = pillFor(human, '🔍').title
  assert.match(humanTitle, /claims reviewed/)
  assert.doesNotMatch(humanTitle, /not read by a person/)
})

test('a manual override on research is carried through to the rendered pill', async () => {
  const html = await renderPills({
    episode_code: 'EP0001',
    status: { research: true, research_reviewed: true, research_has_usable_claims: true },
    status_overrides: { research: true },
  })
  const pill = pillFor(html, '🔍')
  assert.equal(pill.manual, true, 'an overridden research field must mark the pill manual')
  assert.match(pill.title, /manual override/)
})

test('the rendered pill row actually emits every step it was given', async () => {
  // Guards the harness itself: if the template block stopped rendering, every
  // assertion above would pass vacuously on an empty string.
  const html = await renderPills({ episode_code: 'EP0001', status: { research: true } })
  assert.ok(html.length > 0, 'the pill row must render something')
  const spans = html.match(/<span/g) ?? []
  assert.equal(spans.length, STEPS.length, 'one pill per visible step')
})
