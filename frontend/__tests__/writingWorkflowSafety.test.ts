import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { computed, nextTick, ref, watch } from 'vue'
import { useFreshGenerationAction } from '../composables/useFreshGenerationAction'

const root = new URL('..', import.meta.url)
const read = (path: string) => readFileSync(new URL(path, root), 'utf8')

const ideas = read('pages/projects/[slug]/ideas.vue')
const scripts = read('pages/projects/[slug]/scripts.vue')
const introduction = read('pages/projects/[slug]/introduction.vue')
const research = read('pages/projects/[slug]/research.vue')
const metadata = read('pages/projects/[slug]/metadata.vue')
const outline = read('components/OutlineReviewPanel.vue')
const preview = read('components/ScriptPreview.vue')

test('writing actions retain an accepted request identity until the POST confirms it', () => {
  assert.match(ideas, /freshIdeaCampaignAction\.begin\(body\)/)
  assert.match(ideas, /operation_id: operationId/)
  assert.match(ideas, /freshIdeaCampaignAction\.complete\(operationId\)/)

  assert.match(scripts, /const operationId = freshScriptAction\.begin\(params\)/)
  assert.match(scripts, /params\.operation_id = operationId/)

  assert.match(outline, /freshOutlineExpansionAction\.begin\(body/)
  assert.match(outline, /const body = JSON\.parse\(JSON\.stringify\(draft\.body\)\)/)
  assert.match(outline, /const target = draft\.chapters \? `expand:\$\{draft\.chapters\.join\(','\)\}` : 'expand:all'/)
  assert.match(outline, /const operationId = freshOutlineExpansionAction\.begin\(body, target\)/)
  assert.match(outline, /await submitExpansion\(\{ \.\.\.draft, body, operationId \}\)/)
  assert.match(outline, /operation_id: submission\.operationId/)
  assert.match(outline, /freshOutlineExpansionAction\.complete\(submission\.operationId\)/)

  assert.match(metadata, /freshMetadataAction\.begin\(payload\)/)
  assert.match(metadata, /operation_id: operationId/)
  assert.match(metadata, /freshMetadataAction\.complete\(operationId\)/)
})

function productionFunction(name: string): string {
  const start = ideas.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `ideas.vue must define ${name}`)
  const bodyStart = ideas.indexOf('{', start)
  let depth = 0
  for (let index = bodyStart; index < ideas.length; index++) {
    if (ideas[index] === '{') depth++
    else if (ideas[index] === '}' && --depth === 0) return ideas.slice(start, index + 1)
  }
  assert.fail(`ideas.vue must close ${name}`)
}

function productionManualIdeaRuntime(deps: Record<string, unknown>) {
  const beginSource = productionFunction('beginManualIdeaCampaignSubmission')
    .replace(/function beginManualIdeaCampaignSubmission\([^)]*\):[^\{]+\{/, 'async function beginManualIdeaCampaignSubmission(source, body) {')
    .replace(/const submission: ManualIdeaCampaignSubmission =/, 'const submission =')
    .replace(/catch \(error: any\)/g, 'catch (error)')
  const submitSource = productionFunction('submitManualIdeaCampaignSubmission')
    .replace(/function submitManualIdeaCampaignSubmission\([^)]*\):[^\{]+\{/, 'async function submitManualIdeaCampaignSubmission(submission) {')
    .replace(/post<[^>]+>/g, 'post')
    .replace(/catch \(error: any\)/g, 'catch (error)')
  const retrySource = productionFunction('retryManualIdeaCampaignSubmission')
    .replace(/function retryManualIdeaCampaignSubmission\([^)]*\):[^\{]+\{/, 'function retryManualIdeaCampaignSubmission(submission) {')
  const matchesSource = productionFunction('manualIdeaCampaignSubmissionMatchesCurrentTarget')
    .replace(/function manualIdeaCampaignSubmissionMatchesCurrentTarget\([^)]*\):[^\{]+\{/, 'function manualIdeaCampaignSubmissionMatchesCurrentTarget(submission) {')
  const sourceChangedSource = productionFunction('handleManualIdeaCampaignSourceChanged')
    .replace(/function handleManualIdeaCampaignSourceChanged\([^)]*\):[^\{]+\{/, 'function handleManualIdeaCampaignSourceChanged() {')
  const choiceChangedSource = productionFunction('onManualRedoChoiceChange')
    .replace(/function onManualRedoChoiceChange\([^)]*\):[^\{]+\{/, 'function onManualRedoChoiceChange() {')
  const resetScopeSource = productionFunction('resetManualIdeaCampaignScope')
    .replace(/function resetManualIdeaCampaignScope\([^)]*\):[^\{]+\{/, 'function resetManualIdeaCampaignScope() {')
  const factory = new Function(...Object.keys(deps), `
    ${matchesSource}; ${submitSource}; ${retrySource}; ${beginSource};
    ${sourceChangedSource}; ${choiceChangedSource}; ${resetScopeSource};
    return {
      beginManualIdeaCampaignSubmission,
      handleManualIdeaCampaignSourceChanged,
      onManualRedoChoiceChange,
      resetManualIdeaCampaignScope,
    }
  `)
  return factory(...Object.values(deps))
}

function productionIdeaSourceSelector(): (jobs: any[], projectSlug: string) => any | undefined {
  const fn = productionFunction('findManualIdeaCampaignSource')
    .replace(/function findManualIdeaCampaignSource\([^)]*\):[^\{]+\{/, 'function findManualIdeaCampaignSource(jobs, projectSlug) {')
    .replace(/\((job|entry): any\)/g, '($1)')
    .replace(/\((a|b): any, (a|b): any\)/g, '($1, $2)')
  return new Function(`${fn}; return findManualIdeaCampaignSource`)()
}

test('Idea Campaign manual redo is preference-gated and leaves ordinary actions intact', () => {
  assert.match(ideas, /useManualGenerationRedoPreference\(\)/)
  assert.match(ideas, /v-if="manualRedoPreference\.enabled\.value && manualIdeaCampaignSource"/)
  assert.match(ideas, /v-model="manualRedoChecked"/)
  assert.match(ideas, /Start separate campaign attempt/)
  assert.match(ideas, /Current model:[\s\S]*?Current price:/)
  assert.match(ideas, /@click="generate"/)
  assert.match(ideas, /@click="surpriseMe"/)
  const manualFlow = ideas.slice(
    ideas.indexOf('function manualIdeaCampaignSubmissionMatchesCurrentTarget'),
    ideas.indexOf('async function generate()'),
  )
  assert.doesNotMatch(manualFlow, /\b(?:confirm|ask)\(/, 'a selected paid LLM attempt needs no extra approval')
})

test('Idea Campaign manual source selector exposes only stopped unknown chat work', () => {
  const select = productionIdeaSourceSelector()
  const base = {
    project_slug: 'channel-a', type: 'idea_campaign', episode_id: 'ideas',
    status: 'error', created_at: '2026-10-14T01:00:00.000Z',
    genstudio_jobs_operations: ['chat.response'],
    genstudio_jobs_active: [{ id: 'pending:key', operation: 'chat.response', state: 'submitting' }],
  }
  assert.equal(select([{ ...base, job_id: 'eligible' }], 'channel-a')?.job_id, 'eligible')
  for (const [label, job] of [
    ['wrong project', { ...base, job_id: 'other-project', project_slug: 'channel-b' }],
    ['wrong type', { ...base, job_id: 'wrong-type', type: 'research_run' }],
    ['wrong resource', { ...base, job_id: 'wrong-resource', episode_id: 'EP001' }],
    ['active', { ...base, job_id: 'active', status: 'running' }],
    ['settled', { ...base, job_id: 'settled', genstudio_jobs_active: [] }],
    ['abandoned', { ...base, job_id: 'abandoned', force_abandoned: { at: 'now', unsettled: [] } }],
  ] as const) assert.equal(select([job], 'channel-a'), undefined, label)
})

test('Idea Campaign unknown-response Retry reuses its captured body and cannot cross scope', async () => {
  const action = useFreshGenerationAction()
  const posts: any[] = []
  const retries: Array<() => void> = []
  const errors: string[] = []
  const current = { slug: 'channel-a', model: 'writer-a', source: 'source-a' }
  const deps: any = {
    slug: { get value() { return current.slug } },
    form: { get model() { return current.model } },
    manualIdeaCampaignSource: { get value() { return current.source ? { job_id: current.source } : undefined } },
    freshIdeaCampaignAction: action,
    manualRedoPosting: { value: false }, manualRedoChecked: { value: true },
    pendingManualIdeaSubmission: { value: null },
    post: async (path: string, body: any) => {
      posts.push({ path, body: JSON.parse(JSON.stringify(body)) })
      throw new Error('response lost')
    },
    success: () => assert.fail('unknown response cannot report success'),
    showError: (message: string) => errors.push(message),
    showAction: (_message: string, _label: string, callback: () => void) => retries.push(callback),
    UNCONFIRMED_SUBMISSION: 'unconfirmed',
  }
  const runtime = productionManualIdeaRuntime(deps)
  const body = { count: 2, model: 'writer-a', keywords: ['history'] }
  await runtime.beginManualIdeaCampaignSubmission({ job_id: 'source-a' }, body)
  assert.equal(posts.length, 1)
  const first = posts[0]
  body.keywords.push('later edit')
  retries[0]()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(posts.length, 2)
  assert.deepEqual(posts[1].body, first.body, 'Retry posts the captured JSON body')
  assert.equal(posts[1].body.operation_id, first.body.operation_id)

  current.model = 'writer-b'
  retries[1]()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(posts.length, 2, 'a model change cannot post the old Retry')
  assert.match(errors.at(-1) || '', /current channel, model, or stopped campaign/i)

  current.model = 'writer-a'
  current.source = 'source-b'
  deps.manualRedoChecked.value = true
  runtime.onManualRedoChoiceChange()
  retries[1]()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(posts.length, 2, 'choosing a different source cannot post the old Retry')

  current.slug = 'channel-b'
  retries[1]()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(posts.length, 2, 'a project change cannot post the old Retry')
})

test('Idea Campaign accepted-source SSE transitions keep the captured unknown-response Retry', async () => {
  const select = productionIdeaSourceSelector()
  const baseSource = {
    job_id: 'source-a', project_slug: 'channel-a', type: 'idea_campaign', episode_id: 'ideas',
    status: 'error', created_at: '2026-10-14T01:00:00.000Z',
    genstudio_jobs_operations: ['chat.response'],
    genstudio_jobs_active: [{ id: 'pending:key', operation: 'chat.response', state: 'submitting' }],
  }
  const transitions = [
    ['force-abandoned', () => [{ ...baseSource, force_abandoned: { at: 'now', unsettled: ['pending:key'] } }]],
    ['settled', () => [{ ...baseSource, genstudio_jobs_active: [] }]],
    ['removed', () => []],
  ] as const

  for (const [label, transition] of transitions) {
    const action = useFreshGenerationAction()
    const projectSlug = ref('channel-a')
    const selectedModel = ref('writer-a')
    const jobs = ref<any[]>([{ ...baseSource }])
    const source = computed(() => select(jobs.value, projectSlug.value))
    const checked = ref(true)
    const pending = ref<any>(null)
    const posting = ref(false)
    const posts: any[] = []
    const retries: Array<() => void> = []
    const errors: string[] = []
    let postCount = 0
    const deps: any = {
      slug: projectSlug,
      form: { get model() { return selectedModel.value } },
      manualIdeaCampaignSource: source,
      freshIdeaCampaignAction: action,
      manualRedoPosting: posting,
      manualRedoChecked: checked,
      pendingManualIdeaSubmission: pending,
      post: async (path: string, body: any) => {
        posts.push({ path, body: JSON.parse(JSON.stringify(body)) })
        if (postCount++ === 0) {
          jobs.value = transition()
          await nextTick()
        }
        throw new Error('response lost')
      },
      success: () => assert.fail('unknown response cannot report success'),
      showError: (message: string) => errors.push(message),
      showAction: (_message: string, _label: string, callback: () => void) => retries.push(callback),
      UNCONFIRMED_SUBMISSION: 'unconfirmed',
    }
    const runtime = productionManualIdeaRuntime(deps)
    const stopSourceWatch = watch(
      () => source.value?.job_id || '',
      runtime.handleManualIdeaCampaignSourceChanged,
    )
    const stopScopeWatch = watch(
      [projectSlug, selectedModel],
      runtime.resetManualIdeaCampaignScope,
    )
    try {
      await runtime.beginManualIdeaCampaignSubmission(baseSource, { count: 2, model: 'writer-a' })
      assert.equal(source.value, undefined, `${label} removes only new-action eligibility`)
      assert.equal(checked.value, false, `${label} resets the new-action checkbox`)
      assert.ok(pending.value, `${label} retains the captured submission`)
      assert.equal(action.hasPending.value, true, `${label} retains the action UUID`)
      assert.equal(retries.length, 1)

      retries[0]()
      await new Promise(resolve => setTimeout(resolve, 0))
      assert.equal(posts.length, 2, `${label} Retry still posts`)
      assert.deepEqual(posts[1].body, posts[0].body, `${label} Retry keeps the captured body`)
      assert.equal(posts[1].body.operation_id, posts[0].body.operation_id, `${label} Retry keeps the UUID`)

      selectedModel.value = 'writer-b'
      await nextTick()
      assert.equal(pending.value, null, 'a real model change retires the captured submission')
      assert.equal(action.hasPending.value, false, 'a real model change retires the captured UUID')
      const beforeStaleRetry = posts.length
      retries.at(-1)!()
      await new Promise(resolve => setTimeout(resolve, 0))
      assert.equal(posts.length, beforeStaleRetry, 'the retired Retry cannot POST after a model change')
    } finally {
      stopSourceWatch()
      stopScopeWatch()
    }
  }
})

test('late writing loads use a request sequence as well as target equality', () => {
  for (const [label, source, sequence] of [
    ['research', research, 'loadExistingSequence'],
    ['finalizer', metadata, 'metadataLoadSequence'],
    ['outline', outline, 'outlineLoadSequence'],
    ['script preview', preview, 'loadSequence'],
  ] as const) {
    assert.match(source, new RegExp(`let ${sequence} = 0`), `${label} needs a sequence invalidator`)
    assert.match(source, new RegExp(`const requestSequence = \\+\\+${sequence}`), `${label} needs a sequence per request`)
    assert.match(source, new RegExp(`requestSequence !== ${sequence}`), `${label} must reject A→B→A and overlapping same-target replies`)
  }
})

test('research and finalizer scope late replies and writes to the captured project and episode', () => {
  assert.match(research, /const projectSlug = slug\.value[\s\S]*?\/projects\/\$\{projectSlug\}\/research\/\$\{ep\}/)
  assert.match(research, /slug\.value !== projectSlug \|\| episodeId\.value !== ep/)
  // Shape-tolerant on purpose: this asserts the INTENT (the episode-change
  // watcher bumps the scope epoch and reloads), not the exact statements
  // between them. v1.4.196 added blanking there, which is exactly the kind of
  // unrelated change an exact-whitespace match should not fail on.
  assert.match(
    research,
    /watch\(\[slug, episodeId\], \(\) => \{[\s\S]*?researchScopeEpoch\+\+[\s\S]*?void loadExisting\(\)[\s\S]*?\}, \{ immediate: true \}\)/,
  )
  assert.match(research, /target\?\.projectSlug === slug\.value && target\?\.episodeId === episodeId\.value/)

  assert.match(metadata, /const projectSlug = slug\.value[\s\S]*?\/projects\/\$\{projectSlug\}\/episodes\/\$\{code\}\/metadata/)
  assert.match(metadata, /requestSequence !== metadataLoadSequence \|\| metadataScopeEpoch !== scopeEpoch \|\| slug\.value !== projectSlug \|\| episodeId\.value !== code/)
  assert.match(metadata, /watch\(\[slug, episodeId\], async \(\[projectSlug, code\]\)/)
  assert.match(metadata, /async function waitForJob\(projectSlug: string, jobId: string\)/)
  assert.match(metadata, /\/projects\/\$\{projectSlug\}\/generate\/metadata\/save/)
  assert.match(metadata, /slug\.value !== projectSlug \|\| episodeId\.value !== code\) return/)
})

test('channel-scoped writing pages remount their captured preset and introduction state on project changes', () => {
  for (const [label, source] of [
    ['scripts', scripts],
    ['introduction', introduction],
  ] as const) {
    assert.match(
      source,
      /definePageMeta\(\{ layout: 'dashboard', key: route => String\(route\.params\.slug \|\| ''\) \}\)/,
      `${label} must not reuse project-captured preset state after the slug changes`,
    )
  }
})

test('script eligibility never keeps the previous episode while a new episode status refresh fails or arrives late', () => {
  const refresh = scripts.match(/let episodeStatusSequence = 0[\s\S]*?(?=\n\/\/ Fetch on initial mount)/)?.[0] || ''
  assert.match(refresh, /const targetSlug = slug\.value/)
  assert.match(refresh, /const targetEpisode = form\.episode_id/)
  assert.match(refresh, /const requestSequence = \+\+episodeStatusSequence/)
  assert.match(refresh, /selectedEpisode\.value\?\.episode_code !== targetEpisode\) selectedEpisode\.value = null/)
  assert.match(refresh, /slug\.value !== targetSlug \|\| form\.episode_id !== targetEpisode \|\| requestSequence !== episodeStatusSequence/)
  assert.doesNotMatch(refresh, /keep stale episode/)
  assert.match(scripts, /episodeStatusSequence\+\+\s*\n\s*selectedEpisode\.value = null/)
})
