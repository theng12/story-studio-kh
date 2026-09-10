import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import ts from 'typescript'

const jobs = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/jobs.vue', import.meta.url)),
  'utf8',
)

function extractFunction(name: string): string {
  const start = jobs.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `${name}() must exist`)
  let depth = 0
  let body = false
  for (let i = start; i < jobs.length; i++) {
    if (jobs[i] === '{') { depth++; body = true }
    if (jobs[i] === '}') {
      depth--
      if (body && depth === 0) return jobs.slice(start, i + 1)
    }
  }
  throw new Error(`could not extract ${name}`)
}

function hiddenState(saved: string | null = null) {
  const source = `
    const HIDDEN_JOBS_KEY = 'story-studio:hidden-jobs:v1'
    const memory = new Map()
    if (${JSON.stringify(saved)} !== null) memory.set(HIDDEN_JOBS_KEY, ${JSON.stringify(saved)})
    const localStorage = {
      getItem(key) { return memory.get(key) || null },
      setItem(key, value) { memory.set(key, String(value)) },
    }
    const jobDisplayStatus = job => job.recovered ? 'recovered' : job.status
    const hiddenJobIds = { value: new Set(loadHiddenJobIds()) }
    const showHidden = { value: false }
    const activeFilter = { value: 'scene_images' }
    const statusFilter = { value: 'error' }
    const failureBatchFilter = { value: 'failed-batch' }
    let undoToasts = 0
    const successUndoable = () => { undoToasts++ }
    ${extractFunction('loadHiddenJobIds')}
    ${extractFunction('saveHiddenJobIds')}
    ${extractFunction('isJobHidden')}
    ${extractFunction('canHideJob')}
    ${extractFunction('hideJob')}
    ${extractFunction('toggleHiddenJobs')}
    ${extractFunction('isActionableHiddenFailure')}
    ${extractFunction('restoreActionableFailures')}
    return { hiddenJobIds, saveHiddenJobIds, isJobHidden, hideJob, toggleHiddenJobs, showHidden, activeFilter, statusFilter, failureBatchFilter, undoToasts: () => undoToasts, isActionableHiddenFailure, restoreActionableFailures, saved: () => memory.get(HIDDEN_JOBS_KEY) || null }
  `
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText
  // eslint-disable-next-line no-new-func
  return new Function(js)() as {
    hiddenJobIds: { value: Set<string> }
    saveHiddenJobIds(next: Set<string>): void
    isJobHidden(job: { job_id: string }): boolean
    hideJob(job: { job_id: string; status: string; recovered?: boolean }): void
    toggleHiddenJobs(): void
    showHidden: { value: boolean }
    activeFilter: { value: string }
    statusFilter: { value: string }
    failureBatchFilter: { value: string | null }
    undoToasts(): number
    isActionableHiddenFailure(job: { job_id: string; status: string; recovered?: boolean }): boolean
    restoreActionableFailures(jobIds: string[]): void
    saved(): string | null
  }
}

test('hidden job ids persist across reloads and apply in both Jobs scopes', () => {
  const firstVisit = hiddenState()
  firstVisit.saveHiddenJobIds(new Set(['project-done', 'other-project-recovered']))

  const reloaded = hiddenState(firstVisit.saved())
  const projectJobs = [{ job_id: 'project-done', project_slug: 'alpha' }]
  const allJobs = [...projectJobs, { job_id: 'other-project-recovered', project_slug: 'beta' }]

  assert.deepEqual(projectJobs.filter(job => !reloaded.isJobHidden(job)), [])
  assert.deepEqual(allJobs.filter(job => !reloaded.isJobHidden(job)), [])
})

test('a new actionable error restores a previously hidden completed job', () => {
  const state = hiddenState(JSON.stringify(['settling-job']))

  assert.equal(state.isActionableHiddenFailure({ job_id: 'settling-job', status: 'done' }), false)
  assert.equal(state.isJobHidden({ job_id: 'settling-job' }), true)

  assert.equal(state.isActionableHiddenFailure({ job_id: 'settling-job', status: 'error', recovered: true }), false)
  assert.equal(state.isJobHidden({ job_id: 'settling-job' }), true, 'a recovered attempt keeps its hidden presentation')

  assert.equal(state.isActionableHiddenFailure({ job_id: 'settling-job', status: 'error' }), true)
  state.restoreActionableFailures(['settling-job'])
  assert.equal(state.isJobHidden({ job_id: 'settling-job' }), false)
  assert.equal(state.saved(), '[]')
})

test('Show hidden clears stale filters so every hidden card is reachable, and hiding is idempotent', () => {
  const state = hiddenState()
  state.toggleHiddenJobs()
  assert.equal(state.showHidden.value, true)
  assert.equal(state.activeFilter.value, 'all')
  assert.equal(state.statusFilter.value, 'all')
  assert.equal(state.failureBatchFilter.value, null)

  const job = { job_id: 'done-job', status: 'done' }
  state.hideJob(job)
  state.hideJob(job)
  assert.equal(state.undoToasts(), 1)
  assert.equal(state.isJobHidden(job), true)
})
