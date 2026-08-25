import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

const pipeline = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/pipeline.vue', import.meta.url)),
  'utf8',
)

describe('Pipeline stage selection', () => {
  test('starts empty and exposes safe bulk-selection shortcuts', () => {
    const initialSelection = pipeline.match(/const stepChecked = reactive<Record<StepId, boolean>>\(\{([\s\S]*?)\n\}\)/)?.[1] || ''
    assert.ok(initialSelection, 'step selection initializer is missing')
    assert.doesNotMatch(initialSelection, /:\s*true/)

    assert.match(pipeline, /function clearSelectedSteps\(\)/)
    assert.match(pipeline, /function selectRequiredSteps\(\)/)
    assert.match(pipeline, /if \(!step\.optional\) stepChecked\[step\.id\] = true/)
    assert.match(pipeline, /function selectAllSteps\(\)/)
    assert.match(pipeline, />Required stages<\/button>/)
    assert.match(pipeline, />Select all<\/button>/)
    assert.match(pipeline, />Clear<\/button>/)
  })

  test('treats Introduction as optional while retaining its Script dependency', () => {
    assert.match(
      pipeline,
      /id: 'introduction-only',[^\n]*label: 'Introduction \(optional\)'[^\n]*optional: true/,
    )
    assert.match(pipeline, /if \(stepId === 'introduction-only'\) return !stepChecked\['script-only'\]/)
    assert.match(pipeline, /if \(!on\) stepChecked\['introduction-only'\] = false/)
    assert.match(pipeline, /Optional Research, Introduction, and paid Motion Clips stay off/)
  })

  test('shows fixed ten-episode pages with pagination in the top toolbar', () => {
    assert.match(pipeline, /const EPISODES_PER_PAGE = 10/)
    assert.match(pipeline, /slice\(start, start \+ EPISODES_PER_PAGE\)/)
    assert.match(pipeline, /class="toolbar-pagination" aria-label="Episode pages"/)
    assert.doesNotMatch(pipeline, /v-model\.number="pageSize"/)

    const toolbarIndex = pipeline.indexOf('class="toolbar-pagination"')
    const listIndex = pipeline.indexOf('class="episode-list mt-2"')
    assert.ok(toolbarIndex >= 0 && toolbarIndex < listIndex, 'pagination must stay above the episode list')

    const episodeListCss = pipeline.match(/\.episode-list \{([\s\S]*?)\n\}/)?.[1] || ''
    assert.ok(episodeListCss, 'episode-list styles are missing')
    assert.doesNotMatch(episodeListCss, /max-height|overflow-y:\s*auto/)
  })

  test('derives every missing-stage filter from the active Pipeline stages', () => {
    assert.match(pipeline, /v-for="step in requiredFilterSteps"/)
    assert.match(pipeline, /v-for="step in optionalFilterSteps"/)
    assert.match(pipeline, /requiredFilterSteps = computed\(\(\) => visibleSteps\.value\.filter\(step => !step\.optional\)\)/)
    assert.match(pipeline, /optionalFilterSteps = computed\(\(\) => visibleSteps\.value\.filter\(step => step\.optional\)\)/)
    assert.match(pipeline, /const ids = visibleSteps\.value\.map\(step => step\.id\)/)
    assert.match(pipeline, /`missing-step:\$\{stepId\}`/)
    assert.doesNotMatch(pipeline, /FILTER_MODE_TO_STEP/)
    assert.doesNotMatch(pipeline, /<option value="missing-(?:script|audio|metadata|video)/)
  })

  test('shows why a batch skipped an episode instead of pointing at an empty Jobs tab', () => {
    // A skipped step enqueues no job, so the Jobs tab has nothing to show.
    // The backend already returns a reason per episode — surface it.
    assert.doesNotMatch(pipeline, /episode\(s\) skipped — see Jobs tab/)
    assert.match(pipeline, /new Set\(skipped\.map\(\(s: any\) => String\(s\?\.reason \|\| ''\)\)/)
    assert.match(pipeline, /showInfo\(`Skipped — \$\{reason\}`\)/)
  })

  test('keeps optional Research in the narrated-scenes Pipeline chain', () => {
    const narratedChain = pipeline.match(/const CHAIN_NARRATED_SCENES: ChainSpec = \[([\s\S]*?)\n\]/)?.[1] || ''
    assert.match(narratedChain, /'research'/)
    assert.match(pipeline, /id: 'research',[^\n]*optional: true/)
  })
})
