import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import ts from 'typescript'

const pipeline = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/pipeline.vue', import.meta.url)),
  'utf8',
)

function extractFunction(name: string): string {
  const start = pipeline.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `pipeline.vue must define ${name}()`)
  let depth = 0
  let seenBody = false
  for (let i = start; i < pipeline.length; i++) {
    if (pipeline[i] === '{') { depth++; seenBody = true }
    else if (pipeline[i] === '}') {
      depth--
      if (seenBody && depth === 0) return pipeline.slice(start, i + 1)
    }
  }
  throw new Error(`could not find the end of ${name}()`)
}

function loadSelectionRetainer() {
  const source = `
    const selectedEpisodes = new Set(['EP-blocked', 'EP-queued', 'EP-changed-during-submit'])
    ${extractFunction('removeResolvedSubmittedEpisodes')}
    return { selectedEpisodes, removeResolvedSubmittedEpisodes }
  `
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText
  // eslint-disable-next-line no-new-func
  return new Function(js)() as {
    selectedEpisodes: Set<string>
    removeResolvedSubmittedEpisodes: (submitted: string[], blocked: Array<{ episode_id: string }>) => void
  }
}

describe('Pipeline stage selection', () => {
  test('starts empty and exposes safe bulk-selection shortcuts', () => {
    const initialSelection = pipeline.match(/const stepChecked = reactive<Record<StepId, boolean>>\(\{([\s\S]*?)\n\}\)/)?.[1] || ''
    assert.ok(initialSelection, 'step selection initializer is missing')
    assert.doesNotMatch(initialSelection, /:\s*true/)

    assert.match(pipeline, /function clearSelectedSteps\(\)/)
    assert.match(pipeline, /function selectRequiredSteps\(\)/)
    assert.match(pipeline, /if \(!step\.optional\) stepChecked\[step\.id\] = true/)
    assert.match(pipeline, /function selectAllSteps\(\)/)
    assert.match(pipeline, />Required Stages<\/button>/)
    assert.match(pipeline, />Select All<\/button>/)
    assert.match(pipeline, />Clear<\/button>/)
  })

  test('restores only available saved steps and announces what was dropped', () => {
    const source = `
      const visualSource = { value: 'music' }
      const rememberedSteps = { value: ['metadata', 'scene_plan', 'removed-step'] }
      const visibleSteps = { value: [{ id: 'metadata', label: 'Metadata' }] }
      const stepsMeta = [{ id: 'metadata', label: 'Metadata' }, { id: 'scene_plan', label: 'Scene Plan' }]
      const stepChecked = { metadata: false, scene_plan: true }
      const droppedStepNotice = { value: '' }
      function clearSelectedSteps() { for (const step of stepsMeta) stepChecked[step.id] = false }
      function syncDerivedSteps() {}
      ${extractFunction('restoreRememberedSteps')}
      restoreRememberedSteps()
      return { stepChecked, notice: droppedStepNotice.value, rememberedSteps }
    `
    const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
    const result = new Function(js)()
    assert.deepEqual(result.stepChecked, { metadata: true, scene_plan: false })
    assert.match(result.notice, /Scene Plan, removed-step/)
    assert.equal(result.rememberedSteps.value, null)
    assert.match(pipeline, /watch\(slug, async \(\) => \{[\s\S]*?clearSelectedSteps\(\)[\s\S]*?rememberedSteps\.value = null/)
    assert.match(pipeline, /request !== rememberedRequest \|\| targetSlug !== slug\.value/)
  })

  test('the Introduction follows the channel rather than a box that can be forgotten', () => {
    // v1.4.73 — this used to be a normal optional checkbox, and four episodes
    // reached paid audio with no opening because it happened not to be ticked
    // on the run that wrote them. The server adds the step for a channel that
    // opens with one (`applyChannelSegmentIntent`), so a live checkbox the run
    // ignores would be worse than none: the tile states the rule instead.
    assert.match(pipeline, /id: 'introduction-only',[^\n]*label: 'Introduction'[^\n]*optional: true/)
    assert.match(pipeline, /if \(stepId === 'introduction-only'\) return true/,
      'it is never hand-toggled here any more')
    assert.match(pipeline, /stepChecked\['introduction-only'\] = !!stepChecked\['script-only'\][\s\S]{0,80}channelIntroEnabled\.value === true[\s\S]{0,80}autoIntroductionEnabled\.value/,
      'it is derived from the channel setting, the project master switch, and the Script step, in one place')
    assert.match(pipeline, /Runs automatically — this channel opens with an Introduction/)
    assert.match(pipeline, /An Introduction is not a choice here — it follows what the channel says/,
      'the "required stages" shortcut must not still describe it as staying off')
  })

  test('the page says a run will produce openings BEFORE it is started', () => {
    // The behaviour change is the point of v1.4.73, but a surprise is still a
    // surprise. This has to be visible at selection time, not in the receipt.
    assert.match(pipeline, /New episodes in this run will also get an Introduction/)
    assert.match(pipeline, /v-if="autoIntroductionEnabled && channelIntroEnabled && stepChecked\['script-only'\]"/)
  })

  test('the Introduction step points at the page that owns it, and has no preset', () => {
    // A preset is a snapshot of a moment; how a channel opens belongs to the
    // channel. Leaving a preset pool here is how a batch and the page ended up
    // writing different openings.
    assert.match(pipeline, /id: 'introduction-only',[^\n]*link: '\/introduction'/)
    assert.doesNotMatch(pipeline, /id: 'introduction-only',[^\n]*presetList/)
    assert.match(pipeline, /NO_PRESET_STEPS = new Set<StepId>\(\['introduction-only', 'music_build'\]\)/)
  })

  test('the page and the backend agree on which steps need no preset', () => {
    // These two lists are copies of each other, and the page's own comment
    // says so. If they drift, the page hides a preset picker for a step the
    // backend then refuses the entire batch over — "No active preset for X".
    const backend = readFileSync(
      fileURLToPath(new URL('../../electron/server/routes/pipeline.ts', import.meta.url)), 'utf8')
    const ids = (src: string, decl: RegExp): string[] => {
      const match = decl.exec(src)
      assert.ok(match, 'the NO_PRESET_STEPS declaration must still exist')
      return [...match![1].matchAll(/'([a-z_-]+)'/g)].map(m => m[1]).sort()
    }
    assert.deepEqual(
      ids(pipeline, /NO_PRESET_STEPS = new Set<StepId>\(\[([^\]]*)\]?\)/),
      ids(backend, /NO_PRESET_STEPS = new Set<BatchStep>\(\[([^\]]*)\]?\)/),
      'a step that needs no preset must be exempt on BOTH sides',
    )
  })

  test('defaults to ten-episode pages and lets users expand the page without losing selection', () => {
    assert.match(pipeline, /const pageSize = ref\(\[10, 25, 50, 100\]\.includes\(place\.rows\) \? place\.rows : 10\)/)
    assert.match(pipeline, /const PLACE = \{[^}]*rows: 10,/)
    assert.match(pipeline, /v-model\.number="pageSize"/)
    assert.match(pipeline, /<option :value="10">10<\/option>/)
    assert.match(pipeline, /<option :value="25">25<\/option>/)
    assert.match(pipeline, /<option :value="50">50<\/option>/)
    assert.match(pipeline, /<option :value="100">100<\/option>/)
    assert.match(pipeline, /slice\(start, start \+ pageSize\.value\)/)
    assert.match(pipeline, /watch\(totalPages, \(tp\) => \{ if \(currentPage\.value > tp\) currentPage\.value = tp \}\)/)
    assert.match(pipeline, /Selection remains intact while you move between pages\./)
    assert.match(pipeline, /class="toolbar-pagination" aria-label="Episode pages"/)

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

  test('runs eligible episodes while retaining blocked selections and their reasons', () => {
    assert.match(pipeline, /const batchBlocked = ref<BlockedEpisode\[\]>\(\[\]\)/)
    assert.match(pipeline, /These episodes remain selected, but no work was started for them\./)
    assert.match(pipeline, /preflightEligibleCount\.value = Array\.isArray\(result\?\.eligible_episode_ids\)/)
    assert.match(pipeline, /batchBlocked\.value = blockedEpisodes\(r\?\.blocked\)/)
    assert.match(pipeline, /No selected episodes were queued\. Their reasons are shown below\./)
    assert.match(pipeline, /blocked\.length && !hasGlobalPreflightIssue\(e\?\.data\?\.issues\)/)
    assert.match(pipeline, /View Queued Jobs/)
    assert.doesNotMatch(extractFunction('submit'), /navigateTo/)
  })

  test('opens a cancellable checking confirmation before the preflight response returns', () => {
    const openConfirm = extractFunction('openConfirm')
    const opensAt = openConfirm.indexOf('showConfirm.value = true')
    const requestAt = openConfirm.indexOf('await post<any>')
    assert.ok(opensAt >= 0 && opensAt < requestAt, 'the selected work should be visible while preflight reads local state')
    assert.match(pipeline, /<template v-if="preflighting">/)
    assert.match(pipeline, /:disabled="submitting \|\| preflighting \|\| preflightEligibleCount === 0"/)
    assert.match(extractFunction('closeConfirm'), /preflightRequestId \+= 1/)
  })

  test('discards a preflight response if its project route changes before it returns', () => {
    const openConfirm = extractFunction('openConfirm')
    assert.match(openConfirm, /const targetSlug = slug\.value/)
    assert.match(openConfirm, /\/projects\/\$\{targetSlug\}\/pipeline\/preflight/)
    assert.match(openConfirm, /requestId !== preflightRequestId \|\| slug\.value !== targetSlug/)
    assert.match(pipeline, /watch\(slug, \(\) => \{[\s\S]*closeConfirm\(true\)/)
  })

  test('detaches an old project batch response without cancelling its already-authorized server request', () => {
    const submit = extractFunction('submit')
    assert.match(submit, /const requestId = \+\+submitRequestId/)
    assert.match(submit, /const targetSlug = retry\?\.targetSlug \?\? slug\.value/)
    assert.match(submit, /const submittedRepair = retry \? retry\.body\.repair_missing === true : repairMode\.value/)
    assert.match(submit, /if \(retry\) body = structuredClone\(retry\.body\)/)
    assert.match(submit, /\/projects\/\$\{targetSlug\}\/pipeline\/run-batch/)
    assert.match(submit, /requestId !== submitRequestId \|\| slug\.value !== targetSlug/)
    assert.match(pipeline, /submitRequestId \+= 1[\s\S]*submitting\.value = false[\s\S]*closeConfirm\(true\)/)
  })

  test('a partial response clears resolved submitted episodes, retains blockers, and preserves later selection', () => {
    const page = loadSelectionRetainer()
    page.removeResolvedSubmittedEpisodes(['EP-blocked', 'EP-queued'], [{ episode_id: 'EP-blocked' }])
    assert.deepEqual([...page.selectedEpisodes], ['EP-blocked', 'EP-changed-during-submit'])
  })

  test('offers one explicit recover-first repair action with replay-stable authority', () => {
    assert.match(pipeline, />Repair Selected Gaps<\/button>/)
    assert.match(pipeline, /repairActionId\.value = secureOperationId\(\)/)
    assert.match(pipeline, /repair_missing: true, action_id: repairActionId\.value/)
    assert.match(pipeline, /force: submittedRepair \? false : forceRerun\.value/)
    assert.match(pipeline, /one fresh attempt at the current live price/)
    assert.match(pipeline, /Valid completed outputs are kept/)
    assert.match(pipeline, /Start Repair · May Use Credits/)
    assert.match(pipeline, /Active or uncertain requests[\s\S]*without a duplicate submission/)
    assert.match(pipeline, /v-if="!repairMode" class="force-rerun"/)
    assert.match(pipeline, /if \(submitting\.value && !force\) return/)
    assert.match(pipeline, /closeConfirm\(true\)/)
  })

  test('keeps optional Research in the narrated-scenes Pipeline chain', () => {
    const narratedChain = pipeline.match(/const CHAIN_NARRATED_SCENES: ChainSpec = \[([\s\S]*?)\n\]/)?.[1] || ''
    assert.match(narratedChain, /'research'/)
    assert.match(pipeline, /id: 'research',[^\n]*optional: true/)
  })
})
