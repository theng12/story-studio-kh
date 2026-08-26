/**
 * The Introduction is a stage in the sidebar — PROVEN BY RENDERING.
 *
 * v1.4.73. The owner's report was that new users "don't even know it exists as
 * it's hidden and too small": the control was a checkbox on the Script page's
 * Outline tab, drawn only when the channel's niche declared an `openingProfile`,
 * which one niche of twenty-one does. Seven of ten of his channels had no
 * control at all.
 *
 * A grep for the string "Introduction" would pass on a step that is filtered
 * out of every flow, hidden behind a condition, or never rendered. So this file
 * renders `layouts/dashboard.vue`'s OWN workflow-nav markup, driven by
 * `useProjectFlow`'s OWN step list and `dashboard.vue`'s OWN label function —
 * all lifted out of the real files at test time, never re-typed here.
 *
 * The load-bearing claim is the second test: the entry is there whether or not
 * the channel has switched the feature on. A page that appears only once you
 * have found the setting cannot teach anyone that the setting exists; it just
 * moves the hiding place.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { describe } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { parse } from '@vue/compiler-sfc'
import ts from 'typescript'

import {
  FLOW_PHASES,
  flowForVisualSource,
  requiredFlowSteps,
  type FlowStep,
  type VisualSource,
} from '../composables/useProjectFlow.js'

const layoutSource = readFileSync(fileURLToPath(new URL('../layouts/dashboard.vue', import.meta.url)), 'utf8')
const descriptor = parse(layoutSource).descriptor
const template = descriptor.template?.content ?? ''
const script = descriptor.scriptSetup?.content ?? descriptor.script?.content ?? ''
assert.ok(template, 'dashboard.vue must have a template')
assert.ok(script, 'dashboard.vue must have a script block')

/** The real `workflowLabel`, compiled out of the real layout. */
function loadWorkflowLabel(): (step: FlowStep) => string {
  const start = script.indexOf('function workflowLabel(')
  assert.notEqual(start, -1, 'dashboard.vue must still define workflowLabel()')
  let depth = 0
  let seenBody = false
  let end = start
  for (let i = start; i < script.length; i += 1) {
    if (script[i] === '{') { depth += 1; seenBody = true }
    else if (script[i] === '}') {
      depth -= 1
      if (seenBody && depth === 0) { end = i + 1; break }
    }
  }
  const js = ts.transpileModule(`${script.slice(start, end)}\nreturn workflowLabel`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText
  // eslint-disable-next-line no-new-func
  return new Function(js)()
}
const workflowLabel = loadWorkflowLabel()

/** The exact `<div class="nav-group nav-workflow">…</div>` the sidebar renders. */
function extractWorkflowNav(): string {
  const start = template.indexOf('<div class="nav-group nav-workflow">')
  assert.notEqual(start, -1, 'dashboard.vue must still render the workflow nav group')
  const end = template.indexOf('</div>', template.indexOf('</NuxtLink>', start))
  const closing = template.indexOf('</div>', end + 1)
  return template.slice(start, closing + '</div>'.length)
}
const navMarkup = extractWorkflowNav()

async function renderSidebar(visualSource: VisualSource): Promise<string> {
  const steps = flowForVisualSource(visualSource)
  const app = createSSRApp({
    template: `<div>${navMarkup}</div>`,
    data: () => ({
      slug: 'dozing-knight',
      currentWorkflowKey: null,
      workflowPhases: FLOW_PHASES
        .map(phase => ({ ...phase, steps: steps.filter(step => step.phase === phase.key) }))
        .filter(phase => phase.steps.length),
    }),
    methods: {
      workflowLabel,
      workflowRouteFor: (step: FlowStep) => `/projects/dozing-knight${step.path}`,
    },
  })
  app.config.warnHandler = () => {}
  app.component('NuxtLink', { props: ['to'], template: '<a :href="to"><slot /></a>' })
  return await renderToString(app)
}

/** One rendered nav entry, found by the href it links to. */
function entryFor(html: string, href: string): { html: string; text: string } | null {
  const links = html.match(/<a [^>]*href="[^"]*"[\s\S]*?<\/a>/g) ?? []
  const match = links.find(link => link.includes(`href="${href}"`))
  if (!match) return null
  return { html: match, text: match.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() }
}

const FLOWS: VisualSource[] = ['timestamp-driven', 'continuity-chain', 'narrated-scenes']

describe('the Introduction is a visible stage in the sidebar', () => {
  test('the rendered sidebar actually emits something (guards the harness)', async () => {
    // Without this, every assertion below could pass vacuously on an empty
    // string if the markup extraction silently stopped matching.
    const html = await renderSidebar('continuity-chain')
    assert.ok(html.length > 500, `the workflow nav must render; got ${html.length} characters`)
    const links = html.match(/<a /g) ?? []
    assert.equal(links.length, flowForVisualSource('continuity-chain').length,
      'one nav entry per step in the flow')
  })

  for (const flow of FLOWS) {
    test(`it is rendered on the ${flow} flow`, async () => {
      const html = await renderSidebar(flow)
      const entry = entryFor(html, '/projects/dozing-knight/introduction')
      assert.ok(entry, `no Introduction entry rendered for ${flow}`)
      assert.match(entry!.text, /Introduction/, 'and it is named in words, not just linked')
    })

    test(`it carries the muted Optional badge on the ${flow} flow`, async () => {
      const html = await renderSidebar(flow)
      const entry = entryFor(html, '/projects/dozing-knight/introduction')!
      assert.match(entry.html, /class="nav-hint nav-hint-muted"/,
        'optional stages get the muted badge every other optional stage gets')
      assert.match(entry.text, /Optional/)
    })
  }

  test('it is rendered whether or not the channel has switched it on', async () => {
    // THE point of the change. The sidebar entry is a property of the app, not
    // of the channel's answer — nothing about `enabled` reaches this markup,
    // so there is no state in which the stage can disappear. Rendering it with
    // no channel data at all is the strongest form of that proof.
    const html = await renderSidebar('continuity-chain')
    assert.ok(entryFor(html, '/projects/dozing-knight/introduction'))
    assert.doesNotMatch(navMarkup, /introduction/i,
      'the nav must not name the Introduction specially — it comes from the flow like every other step')
  })

  test('it sits before the Script Generator, where the decision belongs', async () => {
    const html = await renderSidebar('continuity-chain')
    const intro = html.indexOf('/projects/dozing-knight/introduction')
    const script = html.indexOf('/projects/dozing-knight/scripts')
    assert.ok(intro > -1 && script > -1)
    assert.ok(intro < script, 'you say how the channel opens, then you write the episode')
  })

  test('it never blocks an episode from being finished', async () => {
    // `optional` is what the Production Board and the flow's completion rule
    // read. A channel that does not use openings must not be permanently
    // incomplete because of a stage it does not want.
    for (const flow of FLOWS) {
      const required = requiredFlowSteps(flow).map(step => step.key)
      assert.ok(!required.includes('introduction'),
        `${flow}: an optional stage must be excluded from completion`)
    }
  })
})

describe('the Script page no longer keeps its own answer', () => {
  const raw = readFileSync(
    fileURLToPath(new URL('../pages/projects/[slug]/scripts.vue', import.meta.url)), 'utf8')
  // Comments explain what USED to be here, on purpose, so the next person
  // does not put it back. Assert on the code, not on the explanation.
  const scripts = raw
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

  test('the page-local intro state is gone', () => {
    // `const intro = reactive({ enabled: false, … })` was a home invented for
    // an answer that had nowhere to live. There must be exactly one place.
    assert.doesNotMatch(scripts, /const intro = reactive\(/,
      'the Script page must not hold the channel\'s answer again')
  })

  test('the watcher that reset the answer on every context reload is gone', () => {
    // This was the defect itself: `watch(openingProfile, …)` forced
    // `intro.enabled = false` whenever the niche context reloaded.
    assert.doesNotMatch(scripts, /watch\(openingProfile/,
      'nothing may reset the channel\'s answer from this page')
  })

  test('the opening\'s recipe is no longer snapshotted into a script preset', () => {
    // A preset is a snapshot of a moment; how a channel opens is a property of
    // the channel. Keeping it in a preset is how a batch and the page ended up
    // writing different openings.
    assert.doesNotMatch(scripts, /introBeats/,
      'beat lists belong to the channel, not to a saved preset')
  })

  test('generating an opening from here sends no recipe at all', () => {
    // The server reads the channel's recipe, so this page, the Introduction
    // page and an unattended batch write from identical instructions.
    const start = scripts.indexOf('async function submitIntroduction')
    assert.ok(start > -1, 'the chained run still generates an opening')
    const body = scripts.slice(start, start + 1200)
    for (const field of ['host_name', 'word_target', 'custom_opening', 'beats:']) {
      assert.ok(!body.includes(field), `${field} must not be sent from this page any more`)
    }
  })
})

// ── The page itself, rendered ────────────────────────────────────────────

const pageDescriptor = parse(readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/introduction.vue', import.meta.url)), 'utf8')).descriptor
const pageTemplate = pageDescriptor.template?.content ?? ''
assert.ok(pageTemplate, 'introduction.vue must have a template')

/**
 * The real beat catalogue, read out of the server's own module.
 *
 * The page renders explanations that the API serves; this is that same list,
 * so the test cannot pass on wording invented here. If a beat loses its
 * explanation on the server, the rendered assertions below stop finding it.
 */
const { BEAT_LIBRARY } = await import('../../electron/server/lib/episode-segments.js')

/** Render the real page template with its surrounding components stubbed. */
async function renderPage(state: Record<string, unknown>): Promise<string> {
  const beats = [
    { id: 'welcome', label: 'Welcome & host intro', enabled: true },
    { id: 'patreon', label: 'Patreon / membership mention', enabled: false },
  ]
  const { methods: methodOverrides, ...dataState } = state as Record<string, any>
  const app = createSSRApp({
    template: pageTemplate,
    data: () => ({
      slug: 'dozing-knight',
      episodeId: '',
      saving: false,
      generating: false,
      dirty: false,
      newBeatLabel: '',
      restoreBeatId: '',
      modelMode: 'script',
      beatLibrary: Object.values(BEAT_LIBRARY),
      introPresets: { presets: { value: [] }, activeId: { value: '' } },
      expanded: new Set<string>(),
      previewRefreshKey: 0,
      wordTargetMin: 100,
      wordTargetMax: 600,
      heroDescription: 'A spoken opening before the story begins.',
      actionStatus: '',
      segment: { enabled: false, recipe: { host_name: '', word_target: 350, custom_opening_line: '', beats, model: '' } },
      ...dataState,
    }),
    computed: {
      recipe(this: any) { return this.segment.recipe },
      enabledBeats(this: any) { return this.segment.recipe.beats.filter((b: any) => b.enabled) },
      usesScriptModel(this: any) { return this.modelMode === 'script' },
      restorableBeats(this: any) {
        const present = new Set(this.segment.recipe.beats.map((b: any) => b.id))
        return this.beatLibrary.filter((b: any) => !present.has(b.id))
      },
    },
    // The page's real per-beat readers, so what is rendered is the catalogue's
    // own wording. Everything else the template calls is a no-op.
    methods: new Proxy({
      beatDescription(this: any, id: string) { return (BEAT_LIBRARY as any)[id]?.description || '' },
      beatSuitsNote(this: any, id: string) { return (BEAT_LIBRARY as any)[id]?.suitsNote || '' },
      beatPlaceholder(this: any, id: string) { return (BEAT_LIBRARY as any)[id]?.example || '' },
      ...(methodOverrides || {}),
    } as Record<string, unknown>, {
      get: (target, key) => (key in target ? (target as any)[key] : () => ''),
      has: () => true,
    }) as any,
  })
  app.config.warnHandler = () => {}
  app.component('NuxtLink', { props: ['to'], template: '<a :href="to"><slot /></a>' })
  app.component('ModelSelector', {
    props: ['modelValue', 'projectSlug', 'label'],
    template: '<div class="model-selector">{{ label }}: {{ modelValue }}</div>',
  })
  app.component('WorkspaceHero', {
    props: ['eyebrow', 'title', 'description'],
    template: '<header><span>{{ eyebrow }}</span><h1>{{ title }}</h1><p>{{ description }}</p><slot name="aside" /></header>',
  })
  app.component('WorkspaceNotice', {
    props: ['tone', 'title'],
    template: '<aside :data-tone="tone"><strong>{{ title }}</strong><div><slot /></div><slot name="actions" /></aside>',
  })
  app.component('TopActionBar', {
    props: ['presets'],
    // Says whether the page handed it a preset pool at all, so the assertion
    // below is about the wiring rather than about the toolbar's own markup.
    template: '<div class="top-action-bar" :data-has-presets="presets ? \'yes\' : \'no\'" />',
  })
  app.component('IntroductionPreview', { template: '<div class="intro-preview" />' })
  return await renderToString(app)
}

const strip = (html: string) => html.replace(/<[^>]*>/g, ' ')
  .replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim()

describe('the Introduction page renders whether or not the channel uses one', () => {
  test('switched OFF, the page still renders and says so', async () => {
    // "Visible even when `enabled` is false, showing its state." If the page
    // were blank until switched on, the hiding place would just have moved.
    const html = await renderPage({})
    assert.ok(html.length > 2000, `the page must render its settings while off; got ${html.length} characters`)
    const text = strip(html)
    assert.match(text, /Introduction/)
    assert.match(text, /Off for this channel/, 'the state is stated, not merely absent')
    assert.match(text, /Introduction is off/, 'and explained')
    assert.match(text, /begin at chapter one/, 'saying what happens instead')
    // The whole recipe is editable while off, so it can be set up in advance.
    assert.match(text, /Host or narrator name/)
    assert.match(text, /Welcome & host intro/)
  })

  test('switched ON, it states that every episode will get one', async () => {
    const html = await renderPage({
      segment: {
        enabled: true,
        recipe: {
          host_name: 'Luna',
          word_target: 350,
          custom_opening_line: '',
          beats: [{ id: 'welcome', label: 'Welcome & host intro', enabled: true }],
        },
      },
    })
    const text = strip(html)
    assert.match(text, /On for this channel/)
    assert.match(text, /Every episode this channel writes will get an opening/)
    assert.match(text, /unattended batch runs/, 'because that is the behaviour change')
  })

  test('an inferred setting says it was inferred, and asks', async () => {
    // Deciding `enabled` for an existing channel is the one real risk in this
    // change. It is inferred from what the channel has already made, and the
    // page must never present a guess as a decision.
    const html = await renderPage({
      segment: {
        enabled: true,
        inferred_at: '2026-08-26T00:00:00.000Z',
        recipe: { host_name: '', word_target: 350, custom_opening_line: '', beats: [] },
      },
    })
    const text = strip(html)
    assert.match(text, /worked out from your existing episodes/)
    assert.match(text, /not something you chose/)
    assert.match(text, /press Save/, 'and there is a way to settle it')
  })

  test('the model choice is offered, and defaults to the chapters\u2019 model', async () => {
    // REVERSES the v1.4.73 rule. The opening shipped with no picker, on the
    // reasoning that one language-model choice is easier to trust than two.
    // The owner overruled it: "what is the model picker not added. i don't
    // care if it's the same model or a different model writing it."
    //
    // The default must not move, though. A channel that has never been here
    // has a blank saved model, which means "follow the Script Generator" —
    // so on arrival the shared option is the selected one and NO picker is
    // mounted. That matters: ModelSelector heals an empty value to the
    // cheapest usable product the instant it mounts, so mounting it here
    // would turn every untouched channel into one that had chosen.
    const html = await renderPage({})
    const text = strip(html)
    assert.match(text, /Which model writes it/)
    assert.match(text, /The same one as the chapters/)
    assert.match(text, /A different model, chosen here/)
    assert.ok(!html.includes('class="model-selector"'),
      'no picker may be mounted while the channel is following the script\u2019s model')
  })

  test('choosing a different model mounts the same picker every other page uses', async () => {
    const html = await renderPage({ modelMode: 'own' })
    assert.ok(html.includes('class="model-selector"'), 'the picker appears once it is asked for')
    assert.match(strip(html), /Model for this channel.s opening/)
  })

  test('every standard beat says what it produces, on screen, unopened', async () => {
    // The owner's charge: "how can someone knows what's a welcome host intro
    // is, a story teaser is, community question is? patreon? how?" Seven
    // unexplained labels teaches no more than a hidden checkbox did — so the
    // explanation is body text next to the beat, not a tooltip and not behind
    // the disclosure arrow (`expanded` is empty in this render).
    const beats = Object.values(BEAT_LIBRARY).map((b: any) => ({ id: b.id, label: b.label, enabled: true }))
    const text = strip(await renderPage({
      segment: { enabled: true, recipe: { host_name: '', word_target: 350, custom_opening_line: '', beats, model: '' } },
    }))
    for (const beat of Object.values(BEAT_LIBRARY) as any[]) {
      assert.ok(beat.description.trim().length > 0, `${beat.id} must carry an explanation at all`)
      // Compare on a distinctive fragment: the full sentence contains curly
      // punctuation that the strip above normalises.
      const fragment = beat.description.split(/[.\u2014]/)[0].trim().slice(0, 40)
      assert.ok(text.includes(fragment),
        `the page must render what "${beat.label}" does; missing: ${fragment}`)
    }
  })

  test('a beat that suits only one kind of channel says so', async () => {
    // "our introduction is lacking and outdated completely" — the breathing
    // exercise is a sleep beat sitting in a list every channel gets. It is not
    // removed here, but a reader is told it is not general-purpose.
    const beats = [{ id: 'relaxation', label: 'Relaxation / breathing exercise', enabled: true }]
    const text = strip(await renderPage({
      segment: { enabled: true, recipe: { host_name: '', word_target: 350, custom_opening_line: '', beats, model: '' } },
    }))
    assert.match(text, /Suits sleep and calm channels/)
  })

  test('a removed standard beat can be put back by name, with its explanation', async () => {
    // Before this, removing "Story teaser" and retyping the label produced a
    // beat with a generated id whose explanation was gone for good.
    const beats = [{ id: 'welcome', label: 'Welcome & host intro', enabled: true }]
    const text = strip(await renderPage({
      segment: { enabled: true, recipe: { host_name: '', word_target: 350, custom_opening_line: '', beats, model: '' } },
    }))
    assert.match(text, /Put a standard beat back/)
    assert.match(text, /Story teaser/, 'the removed beat is offered back by its catalogue name')
  })

  test('the page carries a preset pool of its own', async () => {
    // "intro preset must be present. it's the most important thing."
    const html = await renderPage({})
    assert.match(html, /data-has-presets="yes"/,
      'the recipe must be saveable and reusable across channels')
  })

  test('it never claims the opening costs a separate audio charge', async () => {
    // It folds into the narration the episode already pays to voice. Saying
    // otherwise would make a ~2% change look like a second bill.
    assert.match(strip(await renderPage({})), /no separate audio charge/)
  })
})
