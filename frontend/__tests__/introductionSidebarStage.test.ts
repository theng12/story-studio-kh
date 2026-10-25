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

  test('it sits immediately after the Script Generator on every flow', async () => {
    for (const flow of FLOWS) {
      const html = await renderSidebar(flow)
      const intro = html.indexOf('/projects/dozing-knight/introduction')
      const script = html.indexOf('/projects/dozing-knight/scripts')
      assert.ok(intro > -1 && script > -1)
      assert.ok(script < intro, `${flow}: Script Generator must come before Introduction`)
      const steps = flowForVisualSource(flow).map(step => step.key)
      assert.equal(steps[steps.indexOf('script') + 1], 'introduction',
        `${flow}: Introduction must immediately follow Script Generator`)
    }
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
const pageScript = pageDescriptor.scriptSetup?.content ?? ''
assert.ok(pageTemplate, 'introduction.vue must have a template')
assert.ok(pageScript, 'introduction.vue must have a <script setup>')

/**
 * The page's OWN provenance computeds, compiled out of the real script block.
 *
 * Not re-typed here: the wording, the three-state rule, and the "the {Formula}
 * Formula" phrasing all come from `introduction.vue` itself, so a page that
 * stops distinguishing a Formula's opening from an owner's edit fails these
 * tests instead of passing them against a copy.
 */
function loadProvenance(): (s: { touched: boolean; follows: boolean; formula: string })
  => { state: string; line: string } {
  const start = pageScript.indexOf('const provenanceState = computed')
  assert.notEqual(start, -1, 'introduction.vue must still define provenanceState')
  const end = pageScript.indexOf('const actionStatus = computed', start)
  assert.notEqual(end, -1, 'introduction.vue must still define actionStatus after it')
  const body = pageScript.slice(start, end)
  const js = ts.transpileModule(`
    const computed = (fn) => ({ get value() { return fn() } })
    const recipeTouched = { value: false }
    const followsFormula = { value: false }
    const formulaName = { value: '' }
    ${body}
    return (s) => {
      recipeTouched.value = s.touched
      followsFormula.value = s.follows
      formulaName.value = s.formula
      return { state: provenanceState.value, line: provenanceLine.value }
    }
  `, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  // eslint-disable-next-line no-new-func
  return new Function(js)()
}
const provenanceFor = loadProvenance()

/** Extract one real page function without maintaining a test-side copy. */
function extractPageFunction(signature: string): string {
  const start = pageScript.indexOf(signature)
  assert.notEqual(start, -1, `introduction.vue must still define ${signature}`)
  let depth = 0
  let seenBody = false
  for (let i = start; i < pageScript.length; i += 1) {
    if (pageScript[i] === '{') { depth += 1; seenBody = true }
    else if (pageScript[i] === '}') {
      depth -= 1
      if (seenBody && depth === 0) return pageScript.slice(start, i + 1)
    }
  }
  assert.fail(`could not extract ${signature}`)
}

/**
 * The readiness computed and submission handler compiled from the page itself.
 * The harness supplies only Vue refs and the side effects the page depends on;
 * it does not reproduce the gate or the handler in test code.
 */
function loadIntroductionReadinessGate(): any {
  const stateStart = pageScript.indexOf("const episodeId = ref('')")
  const stateEnd = pageScript.indexOf('const loading = ref(true)', stateStart)
  assert.ok(stateStart > -1 && stateEnd > stateStart,
    'the page must keep its episode/readiness/generation state together')
  const state = pageScript.slice(stateStart, stateEnd)
  const generate = extractPageFunction('async function generateForEpisode')
  const js = ts.transpileModule(`
    const ref = (value) => ({ value })
    const computed = (fn) => ({ get value() { return fn() } })
    const slug = { value: 'demo' }
    const posts = []
    const operations = []
    const post = async (...args) => { posts.push(args); return { ok: true } }
    const freshIntroductionAction = {
      begin: (payload) => { operations.push(payload); return 'introduction-operation' },
      complete: () => undefined,
    }
    const success = () => undefined
    const showError = () => undefined
    const introFailure = ref('')
    const dirty = ref(false)
    const save = async () => true
    const watchedIntroJobs = new Set()
    // The page derives this from the current episode's script jobs. Keep it
    // mutable here so the real gate is exercised for queued/running/paused.
    const scriptWriting = ref(false)
    ${state}
    // Write snapshots the form for one run, so the gate needs a real recipe.
    const segment = { enabled: true, recipe: { host_name: '', word_target: 350, custom_opening_line: '', beats: [], model: '' } }
    const introductionInFlight = ref(false)
    ${generate}
    return {
      episodeId, scriptReadiness, canGenerateIntroduction, generateForEpisode, posts, operations,
      previewSaving, generating, introductionInFlight, scriptWriting,
    }
  `, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  // eslint-disable-next-line no-new-func
  return new Function(js)()
}


/**
 * The real beat catalogue, read out of the server's own module.
 *
 * The page renders explanations that the API serves; this is that same list,
 * so the test cannot pass on wording invented here. If a beat loses its
 * explanation on the server, the rendered assertions below stop finding it.
 */
const { BEAT_LIBRARY } = await import('../../electron/server/lib/episode-segments.js')
// The page's own style and section catalogue, also the real module, for the same reason.
const { INTRO_STYLES, INTRO_SECTIONS, introOption, introSampleFor } = await import('../../electron/server/contracts/intro-settings.js')

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
      INTRO_STYLES,
      INTRO_SECTIONS,
      // The channel's real identity, which the section samples resolve
      // against. Plain data, exactly as the API serves it.
      channelName: 'Dozing Knight',
      contentLanguage: '',
      automaticIntro: false,
      musicSummary: 'Choose music in Audio Assembly',
      introPresets: { presets: { value: [] }, activeId: { value: '' } },
      expanded: new Set<string>(),
      previewRefreshKey: 0,
      wordTargetMin: 100,
      wordTargetMax: 600,
      heroDescription: 'A spoken opening before the story begins.',
      // Defaults only; the provenance tests below drive these from the page's
      // OWN computeds, lifted out of the real script block.
      provenanceState: 'formula',
      provenanceLine: '',
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
      contentLanguageLabel(this: any) {
        return ({ km: 'Khmer', en: 'English' } as any)[String(this.contentLanguage).toLowerCase()]
          || this.contentLanguage || 'Language not set'
      },
      illustration(this: any) {
        return this.enabledBeats.map((b: any) => this.sampleFor(b).text).filter(Boolean).join('\n\n')
      },
    },
    // The page's real per-beat readers, so what is rendered is the catalogue's
    // own wording. Everything else the template calls is a no-op.
    methods: new Proxy({
      beatDescription(this: any, id: string) { return (BEAT_LIBRARY as any)[id]?.description || '' },
      beatSuitsNote(this: any, id: string) { return (BEAT_LIBRARY as any)[id]?.suitsNote || '' },
      beatPlaceholder(this: any, id: string) { return (BEAT_LIBRARY as any)[id]?.example || '' },
      introOption(this: any, beat: any) { return (introOption as any)(beat) },
      // The real chooser, so a rendered sample is the sentence the page would
      // really show — including whose words it is.
      sampleFor(this: any, beat: any) {
        return (introSampleFor as any)(beat, this.contentLanguage, this.channelName, this.segment.recipe.custom_opening_line)
      },
      sampleLabel(_source: string) { return _source === 'custom' ? 'Your wording:' : 'Example:' },
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
    // The redesign names the section in plain words — "Welcome", not the
    // catalogue's "Welcome & host intro", which the prompt still uses. A beat
    // outside the section catalogue keeps its own catalogue name.
    assert.match(text, /Welcome/)
    assert.match(text, /Patreon \/ membership mention/)
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
    // The redesign renamed "beats" to "sections" in every reader's copy; the
    // picker still restores a removed one BY ID, which is what this pins.
    assert.match(text, /Add a section/)
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

/**
 * The page says whether an opening was INFERRED or CHOSEN — proven by
 * rendering, with the page's own computeds driving it.
 *
 * v1.4.73. Every channel that predates this release is handed its Formula's
 * opening rather than the old sleep-shaped seven, so most channels' beats came
 * from nobody. The audit's finding, applied to the recipe: a value the app
 * worked out and a value somebody chose look identical on screen and are not
 * the same kind of thing. `inferred_at` already does this for the on/off
 * switch; this is the recipe's half.
 */
describe('the page distinguishes a Formula\u2019s opening from the owner\u2019s own', () => {
  function stateFor(s: { touched: boolean; follows: boolean; formula: string }) {
    return provenanceFor(s)
  }

  test('following the Formula: it says so, and NAMES the Formula', async () => {
    const p = stateFor({ touched: false, follows: true, formula: 'Business Economics' })
    assert.equal(p.state, 'formula')
    const html = await renderPage({ provenanceState: p.state, provenanceLine: p.line })
    const text = strip(html)
    assert.match(text, /Following the opening that comes with the Business Economics Formula/,
      'the page must name what the channel is following, not just that it follows something')
    // "sections", not "beats" \u2014 the same rename the redesign applied everywhere
    // a reader meets the word. The claim being pinned is unchanged: a Formula
    // default is never presented as somebody's decision.
    assert.match(text, /nobody here chose these sections/,
      'and must not present a Formula default as somebody\u2019s decision')
    assert.match(html, /data-state="formula"/)
  })

  test('the owner\u2019s own edit: it says that instead, and does not claim a Formula', async () => {
    const p = stateFor({ touched: false, follows: false, formula: 'Business Economics' })
    assert.equal(p.state, 'own')
    const html = await renderPage({ provenanceState: p.state, provenanceLine: p.line })
    const text = strip(html)
    assert.match(text, /This channel\u2019s own opening/)
    assert.match(text, /no longer matches what the Business Economics Formula ships/)
    assert.doesNotMatch(text, /nobody here chose/, 'the two states must not both render')
    assert.match(html, /data-state="own"/)
  })

  test('edited but unsaved is its own state, not silently one of the other two', async () => {
    // Saying "this is your own opening" before Save is the same lie in the
    // other direction, and `dirty` cannot stand in for it — a deep watch fires
    // when the on/off switch is flipped too, and flipping it does not make an
    // opening this channel's own.
    const p = stateFor({ touched: true, follows: true, formula: 'Business Economics' })
    assert.equal(p.state, 'edited')
    const html = await renderPage({ provenanceState: p.state, provenanceLine: p.line })
    const text = strip(html)
    assert.match(text, /Edited, and not saved yet/)
    assert.doesNotMatch(text, /nobody here chose/)
    assert.match(html, /data-state="edited"/)
  })

  test('MUTATION \u2014 the three states really are three different sentences', async () => {
    // Each assertion above would also pass against a page that rendered one
    // fixed sentence and a changing attribute. This is the check that the
    // WORDS differ, which is the part a person reads.
    const lines = new Set([
      stateFor({ touched: false, follows: true, formula: 'Sleep Stories' }).line,
      stateFor({ touched: false, follows: false, formula: 'Sleep Stories' }).line,
      stateFor({ touched: true, follows: true, formula: 'Sleep Stories' }).line,
    ])
    assert.equal(lines.size, 3, 'inferred, chosen and unsaved must read differently')
    for (const line of lines) assert.ok(line.trim().length > 40, `too terse to be an explanation: "${line}"`)
  })

  test('a channel with no Formula is still described, without an empty name', async () => {
    const p = stateFor({ touched: false, follows: true, formula: '' })
    assert.doesNotMatch(p.line, /\s{2,}/, 'a missing Formula name must not leave a gap in the sentence')
    assert.match(p.line, /this channel\u2019s Formula/,
      'it falls back to naming it generically rather than rendering "the  Formula"')
  })
})

describe('the Introduction page only submits for the checked episode script', () => {
  test('missing, loading, failed, and mismatched readiness cannot create an operation; ready can', async () => {
    const gate = loadIntroductionReadinessGate()
    gate.episodeId.value = 'EP0001'

    for (const state of ['loading', 'missing', 'error']) {
      gate.scriptReadiness.value = { projectSlug: 'demo', episodeId: 'EP0001', state }
      assert.equal(gate.canGenerateIntroduction.value, false, `${state} must keep the CTA disabled`)
      await gate.generateForEpisode()
    }

    gate.scriptReadiness.value = { projectSlug: 'demo', episodeId: 'EP0002', state: 'ready' }
    assert.equal(gate.canGenerateIntroduction.value, false,
      'a ready response for another selected episode is not permission to submit this one')
    await gate.generateForEpisode()

    assert.deepEqual(gate.posts, [], 'the handler must make no POST while the gate is closed')
    assert.deepEqual(gate.operations, [], 'the handler must not create an operation while the gate is closed')

    gate.scriptReadiness.value = { projectSlug: 'demo', episodeId: 'EP0001', state: 'ready' }
    assert.equal(gate.canGenerateIntroduction.value, true, 'the matching server readiness flag enables generation')

    for (const [label, busy] of [
      ['a queued, running, or paused script writer', gate.scriptWriting],
      ['an introduction submission already in progress', gate.generating],
      ['a manual preview save', gate.previewSaving],
      ['an introduction job already in flight', gate.introductionInFlight],
    ]) {
      busy.value = true
      assert.equal(gate.canGenerateIntroduction.value, false, `${label} must close an otherwise-ready gate`)
      await gate.generateForEpisode()
      busy.value = false
    }

    assert.deepEqual(gate.posts, [], 'busy conditions must not issue a POST even after readiness succeeds')
    assert.deepEqual(gate.operations, [], 'busy conditions must not create an operation even after readiness succeeds')
    assert.equal(gate.canGenerateIntroduction.value, true, 'clearing busy state restores the matching ready gate')
    await gate.generateForEpisode()

    // The redesign separated "Save channel defaults" from writing one episode's
    // intro, so the request now carries the form as a one-run snapshot instead
    // of the page saving first. The gate assertions above are unchanged.
    const runRecipe = { host_name: '', word_target: 350, custom_opening_line: '', beats: [], model: '' }
    assert.deepEqual(gate.operations, [{ episode_id: 'EP0001', introduction_recipe: runRecipe }])
    assert.deepEqual(gate.posts, [[
      '/projects/demo/generate/introduction-only',
      { episode_id: 'EP0001', introduction_recipe: runRecipe, operation_id: 'introduction-operation' },
    ]])
  })
})
