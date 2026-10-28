import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const home = source('../pages/index.vue')
const dashboard = source('../layouts/dashboard.vue')
const mainCss = source('../assets/css/main.css')
const flow = source('../components/FlowRibbon.vue')
const projectFlow = source('../composables/useProjectFlow.ts')
const actionBar = source('../components/TopActionBar.vue')
const presetPicker = source('../components/PresetPicker.vue')
const videoAssembly = source('../pages/projects/[slug]/video-assembly.vue')
const board = source('../pages/projects/[slug]/board.vue')
const episodeSelector = source('../components/EpisodeSelector.vue')

describe('focused workspace UX', () => {
  test('channel cards and the mobile drawer use native accessible controls', () => {
    assert.match(home, /<NuxtLink[\s\S]*class="project-card"/)
    assert.doesNotMatch(home, /class="project-card"\s*@click/)
    assert.match(dashboard, /:aria-expanded="mobileNavOpen"/)
    assert.match(dashboard, /aria-controls="project-navigation"/)
    assert.match(dashboard, /event\.key === 'Escape'/)
    assert.match(dashboard, /focusableSidebarItems/)
    assert.match(mainCss, /\.skip-link\s*\{[\s\S]*top: -9999px;/)
    assert.match(mainCss, /\.skip-link:focus\s*\{[\s\S]*top: 0;/)
  })

  test('the full project-aware workflow remains directly visible in the sidebar', () => {
    for (const label of ['Dashboard', 'Ideas Generator', 'Pipeline', 'Production Board', 'YouTube Upload', 'Jobs', 'All Jobs', 'Settings', 'All Channels']) {
      assert.ok(dashboard.includes(label), `missing primary destination: ${label}`)
    }
    assert.match(dashboard, /<span class="nav-section-label">Workflow<\/span>/)
    assert.match(dashboard, /v-for="\(phase, index\) in workflowPhases"/)
    assert.match(dashboard, /v-for="step in phase\.steps"/)
    assert.match(dashboard, /FLOW_PHASES/)
    assert.match(dashboard, /useProjectFlow\(slug, visualSource\)/)
    // v1.4.365 — the two optional layers are one page with two steps in the
    // flow, named for the half each stands for. Both still appear, and both
    // open the merged page; the labels changed, the presence did not.
    for (const workflowStage of ['Research', 'Thumbnail Prompts', 'Audio Assembly', 'Subtitles', 'Character Sheet', 'Scene Plan', 'Labels', 'Sound', 'Scene Review', 'Motion Review', 'Video Assembly']) {
      assert.ok(projectFlow.includes(`label: '${workflowStage}'`), `missing workflow stage: ${workflowStage}`)
    }
    assert.match(dashboard, /step\.optional/)
    assert.match(dashboard, /step\.key === 'ideas'[\s\S]*Start here/)
    assert.match(flow, /v-if="currentStep"/)
    assert.match(flow, /previousStep/)
    assert.match(flow, /nextStep/)
    assert.doesNotMatch(flow, /v-for="\(step, i\) in steps"/)
  })

  test('long workflows stay fully visible but gain shared phase orientation', () => {
    for (const phase of ['Story', 'Media', 'Video']) {
      assert.match(projectFlow, new RegExp(`label: '${phase}'`))
    }
    assert.match(flow, /currentPhaseLabel/)
    assert.match(board, /v-for="phase in columnPhases"/)
    assert.match(board, /:colspan="phase\.count"/)
  })

  test('episode loading failures preserve cached data and expose retry', () => {
    assert.match(episodeSelector, /error: loadError/)
    assert.match(episodeSelector, /title="Episodes could not be refreshed"/)
    assert.match(episodeSelector, /Your last loaded episode list is still available/)
    assert.match(episodeSelector, /@click="refresh\(\)"/)
    assert.match(episodeSelector, /Check that Story Studio is online, then retry/)
  })

  test('shared libraries retain the active project navigation context', () => {
    assert.match(dashboard, /projectSlug\(route\.query\.project\)/)
    assert.match(dashboard, /path: '\/character-library', query: \{ channel: slug, project: slug \}/)
    assert.match(dashboard, /path: '\/broll-library', query: \{ project: slug \}/)
  })

  test('secondary preset CRUD and the final render action stay progressive', () => {
    assert.match(actionBar, /<details class="preset-more">/)
    assert.match(actionBar, /More preset actions/)
    assert.match(presetPicker, /<details class="preset-more">/)
    assert.match(videoAssembly, /:show-generate="currentStep === 6"/)
    assert.match(videoAssembly, /<button[\s\S]*:aria-current="currentStep === step \? 'step' : undefined"/)
    assert.doesNotMatch(videoAssembly, /<strong>\{\{ currentStep \}\}\/6<\/strong>/)
  })
})
