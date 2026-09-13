import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import ts from 'typescript'

const audio = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/audio.vue', import.meta.url)),
  'utf8',
)

function extractFunction(name: string): string {
  const functionStart = audio.indexOf(`function ${name}(`)
  assert.ok(functionStart >= 0, `audio.vue must define ${name}()`)
  const start = audio.slice(Math.max(0, functionStart - 6), functionStart) === 'async '
    ? functionStart - 6
    : functionStart
  let depth = 0
  let seenBody = false
  for (let i = start; i < audio.length; i++) {
    if (audio[i] === '{') { depth++; seenBody = true }
    else if (audio[i] === '}') {
      depth--
      if (seenBody && depth === 0) return audio.slice(start, i + 1)
    }
  }
  throw new Error(`could not find the end of ${name}()`)
}

function compiled(source: string): string {
  return ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  return { promise: new Promise<T>((res, rej) => { resolve = res; reject = rej }), resolve, reject }
}

function makeRuntime(
  getImpl: (url: string) => Promise<unknown>,
  postImpl: (url: string, body: unknown) => Promise<unknown>,
) {
  const js = compiled(`
    const slug = { value: 'project-a' }
    const form = { episode_id: 'EP_A', sections: 'Chapter_01' }
    const audioStatus = { loading: false, error: '', total: 4, present: 4, missing: 0, missing_files: [] }
    const repairing = { value: false }
    const repairResult = { value: null }
    const effectiveSections = []
    const missingSections = []
    const sectionRefreshKey = { value: 0 }
    let audioStatusRequestId = 0
    let repairRequestId = 0
    const successCalls = []
    const errorCalls = []
    const get = getImpl
    const post = postImpl
    const success = message => successCalls.push(message)
    const showError = message => errorCalls.push(message)
    ${extractFunction('clearAudioStatus')}
    ${extractFunction('isCurrentAudioStatusScope')}
    ${extractFunction('isCurrentRepairScope')}
    ${extractFunction('refreshAudioStatus')}
    ${extractFunction('runRepair')}
    ${extractFunction('onAudioScopeChanged')}
    return {
      audioStatus, repairing, repairResult, successCalls, errorCalls, effectiveSections, missingSections, sectionRefreshKey,
      refreshAudioStatus, runRepair,
      switchScope: (nextSlug, nextEpisode) => {
        slug.value = nextSlug
        form.episode_id = nextEpisode
        onAudioScopeChanged(nextEpisode)
      },
    }
  `)
  // eslint-disable-next-line no-new-func
  return new Function('getImpl', 'postImpl', js)(getImpl, postImpl) as {
    audioStatus: { loading: boolean; error: string; total: number; present: number; missing: number; missing_files: string[] }
    repairing: { value: boolean }
    repairResult: { value: unknown }
    successCalls: string[]
    errorCalls: string[]
    effectiveSections: string[]
    missingSections: string[]
    sectionRefreshKey: { value: number }
    refreshAudioStatus: () => Promise<void>
    runRepair: () => Promise<void>
    switchScope: (slug: string, episode: string) => void
  }
}

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
}

test('chapter status refreshes do not rescan sections until a repair changes them', () => {
  assert.match(audio, /:refresh-key="sectionRefreshKey"/)
  assert.doesNotMatch(audio, /:refresh-key="audioStatus\.total \+ sectionRefreshKey"/)
})

test('audio status ignores stale A→B success and finally, and clears blank selection', async () => {
  const first = deferred<any>()
  const second = deferred<any>()
  const runtime = makeRuntime(
    async url => url.includes('EP_A') ? first.promise : second.promise,
    async () => ({}),
  )

  const oldLoad = runtime.refreshAudioStatus()
  await flush()
  runtime.switchScope('project-a', 'EP_B')
  assert.equal(runtime.audioStatus.total, 0)
  assert.equal(runtime.audioStatus.loading, true)

  first.resolve({ total: 1, present: 0, missing: 1, missing_files: ['old.wav'] })
  await oldLoad
  assert.equal(runtime.audioStatus.total, 0)
  assert.equal(runtime.audioStatus.loading, true)

  second.resolve({ total: 2, present: 1, missing: 1, missing_files: ['current.wav'] })
  await flush()
  assert.deepEqual(runtime.audioStatus.missing_files, ['current.wav'])
  assert.equal(runtime.audioStatus.loading, false)

  runtime.switchScope('project-a', '')
  assert.deepEqual(runtime.audioStatus, { loading: false, error: '', total: 0, present: 0, missing: 0, missing_files: [] })
})

test('audio status ignores stale A→B errors and keeps the current request loading', async () => {
  const first = deferred<any>()
  const second = deferred<any>()
  const runtime = makeRuntime(
    async url => url.includes('EP_A') ? first.promise : second.promise,
    async () => ({}),
  )

  const oldLoad = runtime.refreshAudioStatus()
  await flush()
  runtime.switchScope('project-a', 'EP_B')
  first.reject(Object.assign(new Error('old failure'), { data: { detail: 'old failure' } }))
  await oldLoad
  assert.equal(runtime.audioStatus.error, '')
  assert.equal(runtime.audioStatus.loading, true)

  second.resolve({ total: 3, present: 3, missing: 0, missing_files: [] })
  await flush()
  assert.equal(runtime.audioStatus.error, '')
  assert.equal(runtime.audioStatus.loading, false)
})

test('a same-episode refresh supersedes its older response', async () => {
  const first = deferred<any>()
  const second = deferred<any>()
  let calls = 0
  const runtime = makeRuntime(
    async () => (++calls === 1 ? first.promise : second.promise),
    async () => ({}),
  )

  const oldLoad = runtime.refreshAudioStatus()
  await flush()
  const currentLoad = runtime.refreshAudioStatus()
  first.resolve({ total: 1, present: 1, missing: 0, missing_files: [] })
  await oldLoad
  assert.equal(runtime.audioStatus.loading, true)
  second.resolve({ total: 5, present: 4, missing: 1, missing_files: ['new.wav'] })
  await currentLoad
  assert.equal(runtime.audioStatus.total, 5)
  assert.deepEqual(runtime.audioStatus.missing_files, ['new.wav'])
  assert.equal(runtime.audioStatus.loading, false)
})

test('a repair result from a changed episode is discarded and duplicate clicks do not post twice', async () => {
  const repair = deferred<any>()
  let postCalls = 0
  const runtime = makeRuntime(
    async () => ({ total: 1, present: 1, missing: 0, missing_files: [] }),
    async () => { postCalls++; return repair.promise },
  )

  const firstRepair = runtime.runRepair()
  await flush()
  const duplicateRepair = runtime.runRepair()
  assert.equal(postCalls, 1)
  runtime.switchScope('project-a', 'EP_B')
  repair.resolve({ total_expected: 1, present_before: 0, recovered: 1, still_missing: 0, outcomes: [], logs: [] })
  await Promise.all([firstRepair, duplicateRepair])

  assert.equal(runtime.repairResult.value, null)
  assert.equal(runtime.repairing.value, false)
  assert.equal(runtime.sectionRefreshKey.value, 0)
  assert.deepEqual(runtime.successCalls, [])
  assert.deepEqual(runtime.errorCalls, [])
})

test('a current repair increments the chapter refresh key after status refresh', async () => {
  const runtime = makeRuntime(
    async () => ({ total: 2, present: 2, missing: 0, missing_files: [] }),
    async () => ({ total_expected: 2, present_before: 1, recovered: 1, still_missing: 0, outcomes: [], logs: [] }),
  )

  await runtime.runRepair()
  assert.equal(runtime.sectionRefreshKey.value, 1)
})
