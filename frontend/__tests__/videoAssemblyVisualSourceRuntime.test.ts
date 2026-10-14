import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import ts from 'typescript'

const assembly = readFileSync(fileURLToPath(new URL('../pages/projects/[slug]/video-assembly.vue', import.meta.url)), 'utf8')
const imagePool = readFileSync(fileURLToPath(new URL('../pages/projects/[slug]/image-pool.vue', import.meta.url)), 'utf8')

function extractFunction(text: string, name: string): string {
  const functionStart = text.indexOf(`function ${name}(`)
  assert.ok(functionStart >= 0, `${name}() must exist`)
  const start = text.slice(Math.max(0, functionStart - 6), functionStart) === 'async '
    ? functionStart - 6
    : functionStart
  let depth = 0
  let body = false
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') { depth++; body = true }
    if (text[i] === '}') {
      depth--
      if (body && depth === 0) return text.slice(start, i + 1)
    }
  }
  throw new Error(`could not extract ${name}`)
}

function compiled(source: string): string {
  return ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText
}

function deferred<T>() {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>(r => { resolve = r }), resolve }
}

function makeRuntime(putImpl: (url: string, body: unknown) => Promise<unknown>, getImpl: (url: string) => Promise<unknown>) {
  return new Function('putImpl', 'getImpl', compiled(`
    const slug = { value: 'fixture' }
    const episodeId = { value: 'EP_A' }
    let videoEpisodeSequence = 1
    let visualSourceSequence = 0
    const visualSource = { value: 'image_pool' }
    const imagePoolSource = { value: { pool_id: 'pool-a', selected_images: [{ filename: 'a.png' }] } }
    const visualSourceError = { value: '' }
    const visualSourceLoaded = { value: true }
    const visualSourceLoading = { value: false }
    const visualSourceSaving = { value: false }
    const successCalls = []
    const errorCalls = []
    let scans = 0
    const put = putImpl
    const get = getImpl
    const success = message => successCalls.push(message)
    const showError = message => errorCalls.push(message)
    const scanAssets = async () => { scans++ }
    const loadManualRedoSources = async () => undefined
    function isCurrentVisualSourceScope(project, episode, scope = videoEpisodeSequence) {
      return scope === videoEpisodeSequence && project === slug.value && episode === episodeId.value
    }
    ${extractFunction(assembly, 'loadVisualSource')}
    ${extractFunction(assembly, 'saveVisualSource')}
    return {
      loadVisualSource, saveVisualSource,
      source: visualSource, pool: imagePoolSource, error: visualSourceError, loaded: visualSourceLoaded,
      saving: visualSourceSaving, successCalls, errorCalls, scans: () => scans,
      switchEpisode: (next) => {
        episodeId.value = next
        videoEpisodeSequence++
        visualSource.value = 'scene_plan'
        imagePoolSource.value = null
        visualSourceLoaded.value = false
      },
    }
  `))(putImpl, getImpl)
}

test('failed source promotion stays visible as an error and never reports success', async () => {
  const runtime = makeRuntime(
    async () => { throw Object.assign(new Error('synthetic PUT failure'), { data: { detail: 'source write failed' } }) },
    async () => ({ source: 'image_pool', image_pool: { pool_id: 'pool-a', selected_images: [{ filename: 'a.png' }] } }),
  )

  await runtime.saveVisualSource()
  assert.deepEqual(runtime.successCalls, [])
  assert.equal(runtime.error.value, 'source write failed')
  assert.equal(runtime.loaded.value, false)
  assert.equal(runtime.saving.value, false)
})

test('a source PUT completing after A→B→A cannot promote the old request', async () => {
  const pending = deferred<unknown>()
  const runtime = makeRuntime(
    async () => pending.promise,
    async () => ({ source: 'scene_plan', image_pool: null }),
  )

  const save = runtime.saveVisualSource()
  await Promise.resolve()
  runtime.switchEpisode('EP_B')
  runtime.switchEpisode('EP_A')
  pending.resolve({})
  await save

  assert.deepEqual(runtime.successCalls, [])
  assert.equal(runtime.scans(), 0)
})

test('a late source GET cannot overwrite the episode currently on screen', async () => {
  const first = deferred<any>()
  const second = deferred<any>()
  const runtime = makeRuntime(
    async () => ({}),
    async url => url.endsWith('EP_A') ? first.promise : second.promise,
  )

  const oldLoad = runtime.loadVisualSource()
  await Promise.resolve()
  runtime.switchEpisode('EP_B')
  const currentLoad = runtime.loadVisualSource()
  first.resolve({ source: 'image_pool', image_pool: { pool_id: 'old', selected_images: [{ filename: 'old.png' }] } })
  await oldLoad
  assert.equal(runtime.pool.value, null)
  second.resolve({ source: 'scene_plan', image_pool: null })
  await currentLoad
  assert.equal(runtime.source.value, 'scene_plan')
  assert.equal(runtime.scans(), 1)
})

test('switching image pools clears the previous completed pick immediately', () => {
  const watcher = imagePool.slice(imagePool.indexOf('watch([slug, episodeId, poolId]'))
  const body = watcher.slice(watcher.indexOf('{') + 1, watcher.indexOf('}, { flush:'))
  const runtime = new Function(compiled(`
    let imagePoolScopeSequence = 4
    const lastLoad = { value: { count: 3 } }
    const pickingImages = { value: false }
    const loadManualRedoSources = async () => undefined
    ${body}
    return { run: () => { ${body} }, lastLoad, pickingImages }
  `))()

  runtime.pickingImages.value = true
  runtime.run()
  assert.equal(runtime.lastLoad.value, null)
  assert.equal(runtime.pickingImages.value, false)
})
