import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'
import { computed, ref } from 'vue'
import { parse } from '@vue/compiler-sfc'

const source = readFileSync(new URL('../pages/projects/[slug]/jobs.vue', import.meta.url), 'utf8')
const script = parse(source).descriptor.scriptSetup!.content
const ast = ts.createSourceFile('jobs.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const names = ['jobCleanupAction', 'selectCleanupJobs', 'toggleCleanupJob', 'abandonAndClearSelected']
const functions = ast.statements.filter(s => ts.isFunctionDeclaration(s) && names.includes(s.name!.text))
  .map(s => s.getText(ast)).join('\n')

function job(id: string, project: string, action = 'force-abandon', status = 'error') {
  return { job_id: id, project_slug: project, episode_id: id, title: id, type: 'audio', status,
    controls: [{ action, enabled: true, reason: 'Stops local tracking; accepted provider work may finish. Files and billing records stay intact.' }] }
}

function harness(rows = [job('one', 'alpha'), job('two', 'beta', 'clear-history', 'done')]) {
  assert.ok(functions.includes('async function abandonAndClearSelected'), 'bulk action must exist')
  const c = {
    selectedCleanupIds: ref(new Set(rows.map(j => j.job_id))),
    eligibleCleanupJobs: ref(rows), selectedCleanupJobs: computed(() => rows),
    bulkActionBusy: ref(false), controlBusy: ref(new Set<string>()), clearingSelected: ref(false),
    cleanupProgress: ref(''), cleanupFailures: ref<{ label: string; reason: string }[]>([]),
    actionScopeLabel: ref('All projects'),
    requests: [] as string[], updates: [] as string[], removed: [] as string[], messages: [] as string[],
    historyRemoved: [] as string[], historyReloads: 0, isUniversal: { value: true },
    approved: true, failDelete: '', pendingPost: null as Promise<void> | null, confirms: [] as any[],
  }
  const code = ts.transpileModule(`${functions}\nreturn { ${names.join(', ')} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText
  const api = new Function('c', `
    const { selectedCleanupIds, eligibleCleanupJobs, selectedCleanupJobs, bulkActionBusy, controlBusy,
      clearingSelected, cleanupProgress, cleanupFailures, actionScopeLabel, isUniversal } = c;
    const history = { removeIds: ids => c.historyRemoved.push(...ids), invalidate() {} };
    const loadJobHistory = async () => { c.historyReloads += 1 };
    const jobControls = job => job.controls || [];
    const jobDisplayStatus = job => job.status;
    const jobProjectSlug = job => job.project_slug;
    const projectName = slug => slug;
    const jobQueuePath = job => '/projects/' + job.project_slug + '/jobs/' + job.job_id;
    const customerJobText = value => String(value);
    const useConfirm = () => ({ ask: async options => { c.confirms.push(options); return c.approved; } });
    const post = async url => { c.requests.push(url); if (c.pendingPost) await c.pendingPost;
      return { job: { job_id: url.split('/').at(-2), controls: [{action:'clear-history',enabled:true}] } }; };
    const del = async url => { c.requests.push(url); if (url.includes(c.failDelete) && c.failDelete) throw {data:{detail:'Cannot clear yet'}}; return {ok:true}; };
    const projectQueue = {applyUpdate: j => c.updates.push(j.job_id), removeJobs: ids => c.removed.push(...ids)};
    const universalQueue = {applyUpdate: () => {}, removeJobs: () => {}};
    const info = text => c.messages.push(text), showError = info;
    ${code}
  `)(c)
  return Object.assign(c, api)
}

test('bulk cleanup confirms once and touches only selected jobs in their own projects', async () => {
  const h = harness()
  await h.abandonAndClearSelected()
  assert.equal(h.confirms.length, 1)
  assert.match(h.confirms[0].message, /Files and billing records stay intact/)
  assert.deepEqual(h.requests, ['/projects/alpha/jobs/one/abandon', '/projects/alpha/jobs/one', '/projects/beta/jobs/two'])
  assert.deepEqual(h.updates, ['one'])
  assert.deepEqual(h.removed, ['one', 'two'])
  assert.deepEqual(h.historyRemoved, ['one', 'two'], 'the history read must drop both confirmed rows, not only the live stores')
  assert.equal(h.historyReloads, 1, 'one authoritative reload after the bulk clear')
  assert.equal(h.clearingSelected.value, false)
  assert.equal(h.selectedCleanupIds.value.size, 0)
})

test('declining bulk cleanup makes no request', async () => {
  const h = harness(); h.approved = false
  await h.abandonAndClearSelected()
  assert.deepEqual(h.requests, [])
  assert.deepEqual(h.historyRemoved, [])
  assert.equal(h.historyReloads, 0)
  assert.equal(h.clearingSelected.value, false)
})

test('one failed clear stays selected and reported while other selected jobs complete', async () => {
  const h = harness(); h.failDelete = '/alpha/jobs/one'
  await h.abandonAndClearSelected()
  assert.deepEqual(h.removed, ['two'])
  assert.deepEqual(h.historyRemoved, ['two'])
  assert.equal(h.historyReloads, 1)
  assert.deepEqual([...h.selectedCleanupIds.value], ['one'])
  assert.equal(h.cleanupFailures.value.length, 1)
  assert.match(h.cleanupFailures.value[0].reason, /Cannot clear yet/)
})

test('repeated clicks cannot start a second bulk abandonment', async () => {
  const h = harness()
  let release!: () => void
  h.pendingPost = new Promise<void>(resolve => { release = resolve })
  const first = h.abandonAndClearSelected()
  await Promise.resolve()
  await h.abandonAndClearSelected()
  release(); await first
  assert.equal(h.confirms.length, 1)
  assert.equal(h.requests.filter((p: string) => p.endsWith('/abandon')).length, 1)
})

test('automatic selection follows current filtered eligibility and can target needs-attention only', () => {
  const h = harness([job('failed', 'alpha'), job('running', 'beta', 'force-abandon', 'running')])
  h.selectCleanupJobs(true)
  assert.deepEqual([...h.selectedCleanupIds.value], ['failed'])
  h.selectCleanupJobs(false)
  assert.deepEqual([...h.selectedCleanupIds.value], ['failed', 'running'])
  assert.equal(h.jobCleanupAction({ controls: [{action:'force-abandon',enabled:false}] }), null)
  assert.equal(h.jobCleanupAction({ controls: [{action:'clear-history',enabled:true}, {action:'force-abandon',enabled:true}] }), 'clear-history')
})

test('selection controls are available for both active and history cards', () => {
  assert.equal((source.match(/@change="toggleCleanupJob\(job\)"/g) || []).length, 2)
  assert.match(source, /Select Needs Attention/)
  assert.match(source, /Select All Matching/)
  assert.match(source, /Abandon and Hide From List/)
})
