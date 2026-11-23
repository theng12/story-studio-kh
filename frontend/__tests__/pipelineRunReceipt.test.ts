import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'
import { ref, shallowRef, computed, createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { parse } from '@vue/compiler-sfc'

const source = readFileSync(new URL('../pages/projects/[slug]/pipeline.vue', import.meta.url), 'utf8')
const script = parse(source).descriptor.scriptSetup!.content
const ast = ts.createSourceFile('pipeline.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const names = new Set(['blockedEpisodes', 'hasGlobalPreflightIssue', 'removeResolvedSubmittedEpisodes', 'closeConfirm', 'retryPipelineSubmission', 'provesPipelineAdmissionRejected', 'submit'])
const functions = ast.statements.filter(s => ts.isFunctionDeclaration(s) && names.has(s.name!.text)).map(s => s.getText(ast)).join('\n')

function harness(
  result: any,
  reject = false,
  repair = false,
  outcomes: Array<{ reject: boolean; value: any }> = [],
) {
  const context = {
    ref, computed, response: result, reject,
    selectedEpisodes: new Set(['TN0001', 'TN0002']),
    slug: ref('sleep-stories'),
    submitting: ref(false), preflighting: ref(false), repairMode: ref(repair), forceRerun: ref(false),
    showConfirm: ref(true), repairActionId: ref('repair-1'), runActionId: ref(''),
    pendingPipelineSubmission: shallowRef<any>(null),
    checkedStepsOrdered: ref([{ id: 'metadata' }]),
    batchBlocked: ref<any[]>([]), batchHasJobs: ref(false), batchReceipt: ref<any>(null),
    presetIdsForRun: () => ({ metadata: 'metadata-preset' }),
    notices: [] as string[], requests: [] as string[], requestBodies: [] as any[], navigations: [] as string[],
    actions: [] as Array<() => void>, failures: reject ? 1 : 0, outcomes,
  }
  const js = ts.transpileModule(`${functions}\nreturn { submit, closeConfirm }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText
  const api = new Function('ctx', `
    const { ${Object.keys(context).join(', ')} } = ctx;
    const canRun = computed(() => !submitting.value && selectedEpisodes.size > 0);
    const post = async (url, body) => {
      requests.push(url); requestBodies.push(structuredClone(body));
      const outcome = ctx.outcomes.shift();
      if (outcome) { if (outcome.reject) throw outcome.value; return outcome.value; }
      if (ctx.failures-- > 0) throw response;
      return response;
    };
    const success = (text) => notices.push(text);
    const showInfo = success, showError = success;
    const showAction = (_message, _label, action) => actions.push(action);
    const UNCONFIRMED_SUBMISSION = 'unconfirmed';
    const navigateTo = (url) => navigations.push(url);
    let preflightRequestId = 0, submitRequestId = 0, pipelineCaptureId = 0;
    ${js}
  `)(context)
  return { ...context, ...api }
}

async function renderReceipt(page: ReturnType<typeof harness>) {
  const start = source.indexOf('<Modal :visible="!!batchReceipt"')
  assert.ok(start >= 0, 'result dialog is present')
  const template = source.slice(start, source.indexOf('</Modal>', start) + 8)
  return renderToString(createSSRApp({
    template,
    setup: () => ({ batchReceipt: page.batchReceipt, batchBlocked: page.batchBlocked }),
    components: {
      Modal: { props: ['visible'], template: '<section v-if="visible"><slot /></section>' },
      NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
    },
  }))
}

test('successful submission stays on Pipeline with server counts and an explicit Jobs link', async () => {
  const page = harness({ enqueued: 2, total_jobs_planned: 7 })
  await page.submit()
  assert.deepEqual(page.navigations, [])
  assert.equal(page.showConfirm.value, false)
  assert.equal(page.batchReceipt.value.title, 'Batch queued')
  assert.match(page.batchReceipt.value.lines.join(' '), /7 job\(s\).*2 episode\(s\)/)
  const html = await renderReceipt(page)
  assert.match(html, /Stay on Pipeline/)
  assert.match(html, /href="\/projects\/sleep-stories\/jobs"/)
  assert.match(html, /View Jobs/)
  page.batchReceipt.value = null
  assert.equal((await renderReceipt(page)).includes('View Jobs'), false)
  assert.equal(page.requests.length, 1, 'dismissing does not submit again')
})

test('partial repair reports accepted work and retains only the blocked episode', async () => {
  const page = harness({ enqueued: 1, total_jobs_planned: 3, blocked: [{ episode_id: 'TN0002', reason: 'Missing audio' }] }, false, true)
  await page.submit()
  assert.deepEqual([...page.selectedEpisodes], ['TN0002'])
  assert.equal(page.batchReceipt.value.title, 'Repair queued')
  assert.match(page.batchReceipt.value.lines.join(' '), /1 selected episode\(s\) need attention/)
  assert.match(await renderReceipt(page), /Episodes that could not start remain selected/)
  assert.deepEqual(page.navigations, [])
})

test('reused work offers Jobs without claiming new jobs were queued', async () => {
  const page = harness({ enqueued: 0, reused: 1, total_jobs_planned: 0 })
  await page.submit()
  assert.equal(page.batchReceipt.value.title, 'Work already active')
  assert.match(page.batchReceipt.value.lines.join(' '), /no duplicate work queued/)
  assert.ok(page.batchReceipt.value.jobsUrl)
})

test('empty and inline-only runs do not direct the user to empty Jobs', async () => {
  for (const response of [{ enqueued: 0 }, { enqueued: 0, character_sheets_applied: 2, skipped: [{ reason: 'Already complete' }] }]) {
    const page = harness(response)
    await page.submit()
    assert.equal(page.batchReceipt.value.title, 'Batch checked')
    assert.equal(page.batchReceipt.value.jobsUrl, null)
    assert.doesNotMatch(await renderReceipt(page), /View Jobs/)
  }
})

test('receipt identifies stages excluded by an episode’s Image Pool source', async () => {
  const page = harness({
    enqueued: 1,
    total_jobs_planned: 2,
    steps_skipped_as_inapplicable: [{ episode_id: 'TN0001', step: 'scene_plan' }],
  })
  await page.submit()
  assert.match(page.batchReceipt.value.lines.join(' '), /1 step\(s\) skipped because that episode uses Image Pool/)
})

test('failed submission shows no success receipt and repeat clicks submit once', async () => {
  const failed = harness({ data: { detail: 'Could not queue this run' } }, true)
  await failed.submit()
  assert.equal(failed.batchReceipt.value, null)
  assert.equal(failed.showConfirm.value, true)
  assert.deepEqual(failed.notices, ['Could not queue this run'])
  assert.equal(failed.submitting.value, false)
  const page = harness({ enqueued: 2, total_jobs_planned: 2 })
  await Promise.all([page.submit(), page.submit()])
  assert.equal(page.requests.length, 1)
})

test('unknown force response keeps one exact detached body whose Retry bypasses changed current choices', async () => {
  assert.match(source, /@click="submit\(\)"/, 'the button event is never mistaken for a detached Retry DTO')
  const page = harness(new Error('socket closed'), true)
  page.forceRerun.value = true
  page.runActionId.value = '82010000-0000-4000-8000-000000000001'
  await page.submit()
  assert.equal(page.actions.length, 1)
  assert.ok(page.pendingPipelineSubmission.value)
  const captured = structuredClone(page.requestBodies[0])
  page.selectedEpisodes.clear()
  page.selectedEpisodes.add('CHANGED')
  page.checkedStepsOrdered.value = [{ id: 'scene_plan' }]
  page.actions[0]!()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(page.requestBodies[1], captured)
  assert.equal(page.pendingPipelineSubmission.value, null)
})

test('Pipeline distinguishes definite initial rejection from an already-unknown action', async () => {
  const definite = harness(null, false, false, [
    { reject: true, value: { statusCode: 409, data: { detail: 'not admitted' } } },
  ])
  definite.forceRerun.value = true
  definite.runActionId.value = '82020000-0000-4000-8000-000000000002'
  await definite.submit()
  assert.equal(definite.pendingPipelineSubmission.value, null)
  assert.deepEqual(definite.actions, [])
  assert.deepEqual(definite.notices, ['not admitted'])

  const unknown = harness(null, false, false, [
    { reject: true, value: new Error('socket closed after admission') },
    { reject: true, value: { statusCode: 500, data: { detail: 'restart during receipt lookup' } } },
  ])
  unknown.forceRerun.value = true
  unknown.runActionId.value = '82030000-0000-4000-8000-000000000003'
  await unknown.submit()
  const captured = structuredClone(unknown.pendingPipelineSubmission.value)
  unknown.actions[0]!()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(unknown.actions.length, 2)
  assert.deepEqual(unknown.pendingPipelineSubmission.value?.body, captured.body)
  assert.equal(unknown.pendingPipelineSubmission.value?.outcomeUnknown, true)
  assert.deepEqual(unknown.requestBodies[0], unknown.requestBodies[1])
})

test('ordinary Pipeline B cannot advertise or clear unrelated unknown force A', async () => {
  const failedB = harness(null, false, false, [
    { reject: true, value: new Error('lost A response') },
    { reject: true, value: { data: { detail: 'ordinary B failed' } } },
  ])
  failedB.forceRerun.value = true
  failedB.runActionId.value = '82040000-0000-4000-8000-000000000004'
  await failedB.submit()
  const capturedA = structuredClone(failedB.pendingPipelineSubmission.value)
  failedB.closeConfirm()
  await failedB.submit()
  assert.equal(failedB.actions.length, 1, 'B has no immutable identity and must not offer Retry A as its own recovery')
  assert.deepEqual(failedB.pendingPipelineSubmission.value, capturedA)
  assert.equal(failedB.notices.at(-1), 'ordinary B failed')

  const successfulB = harness(null, false, false, [
    { reject: true, value: new Error('lost A response') },
    { reject: false, value: { enqueued: 1, total_jobs_planned: 2 } },
  ])
  successfulB.forceRerun.value = true
  successfulB.runActionId.value = '82050000-0000-4000-8000-000000000005'
  await successfulB.submit()
  const successfulCaptureA = structuredClone(successfulB.pendingPipelineSubmission.value)
  successfulB.closeConfirm()
  await successfulB.submit()
  assert.deepEqual(successfulB.pendingPipelineSubmission.value, successfulCaptureA,
    'ordinary B success does not silently erase A whose acceptance is still unknown')
  assert.equal(successfulB.batchReceipt.value.title, 'Batch queued')
})


test('a late submission cannot replace the new project receipt or release its active controls', async () => {
  let resolve!: (result: any) => void
  const pending = new Promise(resolveResult => { resolve = resolveResult })
  const page = harness(pending)
  const submitted = page.submit()
  page.slug.value = 'another-project'
  const currentReceipt = { title: 'New project work', lines: [], jobsUrl: null }
  page.batchReceipt.value = currentReceipt
  page.selectedEpisodes.clear()
  page.selectedEpisodes.add('EP0001')
  resolve({ enqueued: 2, total_jobs_planned: 7 })
  await submitted
  assert.deepEqual(page.batchReceipt.value, currentReceipt)
  assert.deepEqual([...page.selectedEpisodes], ['EP0001'])
  assert.equal(page.showConfirm.value, true)
  assert.equal(page.submitting.value, true, 'the previous request must not release new-project controls')
  assert.deepEqual(page.notices, [])
})

// Owner decision 2026-10-17 — Story Studio no longer owns the writing model. The
// per-run "Models for this run" picker and its `model_policies` request field are
// retired: a run uses the model its active preset names, and the Gateway owns any
// fallback across its own pool. This pins the request contract so the retired
// field cannot creep back into the batch body, and pins that the surface is gone
// from the page rather than merely hidden.
test('the batch request carries no per-run writing-model override', async () => {
  const page = harness({ enqueued: 1, total_jobs_planned: 1 })
  await page.submit()
  assert.equal(page.requests.length, 1)
  const body = page.requestBodies[0]
  assert.deepEqual(Object.keys(body).sort(), ['episode_ids', 'force', 'preset_ids', 'steps'])
  assert.equal('model_policies' in body, false)
  assert.doesNotMatch(source, /Models for this run|model_policies|modelPoliciesForRun|step-model-policy|policy-expanded/)
})
