import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'
import { ref, computed, createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { parse } from '@vue/compiler-sfc'

const source = readFileSync(new URL('../pages/projects/[slug]/pipeline.vue', import.meta.url), 'utf8')
const script = parse(source).descriptor.scriptSetup!.content
const ast = ts.createSourceFile('pipeline.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const names = new Set(['blockedEpisodes', 'hasGlobalPreflightIssue', 'removeResolvedSubmittedEpisodes', 'closeConfirm', 'submit'])
const functions = ast.statements.filter(s => ts.isFunctionDeclaration(s) && names.has(s.name!.text)).map(s => s.getText(ast)).join('\n')

function harness(result: any, reject = false, repair = false) {
  const context = {
    ref, computed, response: result, reject,
    selectedEpisodes: new Set(['TN0001', 'TN0002']),
    slug: ref('terranash-sleep-stories'),
    submitting: ref(false), repairMode: ref(repair), forceRerun: ref(false),
    showConfirm: ref(true), repairActionId: ref('repair-1'), runActionId: ref(''),
    checkedStepsOrdered: ref([{ id: 'metadata' }]),
    batchBlocked: ref<any[]>([]), batchHasJobs: ref(false), batchReceipt: ref<any>(null),
    modelPoliciesForRun: () => ({}),
    notices: [] as string[], requests: [] as string[], navigations: [] as string[],
  }
  const js = ts.transpileModule(`${functions}\nreturn { submit, closeConfirm }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText
  const api = new Function('ctx', `
    const { ${Object.keys(context).join(', ')} } = ctx;
    const canRun = computed(() => !submitting.value && selectedEpisodes.size > 0);
    const post = async (url) => { requests.push(url); if (reject) throw response; return response; };
    const success = (text) => notices.push(text);
    const showInfo = success, showError = success;
    const navigateTo = (url) => navigations.push(url);
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
  assert.match(html, /href="\/projects\/terranash-sleep-stories\/jobs"/)
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
