import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { transform } from 'esbuild'

const page = readFileSync(new URL('../pages/projects/[slug]/video-assembly.vue', import.meta.url), 'utf8')
const script = page.slice(page.indexOf('<script setup'))

function section(start: string, end: string): string {
  const at = script.indexOf(start)
  assert.ok(at >= 0, start)
  const stop = script.indexOf(end, at)
  assert.ok(stop > at, end)
  return script.slice(at, stop)
}

async function harness(fetch: (url: string) => Promise<unknown>) {
  const refresh = section('async function refreshBackgroundLibrary()', '\nasync function openBackgroundPicker(')
  const pick = section('async function pickBackgroundFile(', '\n// Project\'s overlays/')
  const { code } = await transform(`${refresh}\n${pick}`, { loader: 'ts', format: 'esm' })
  return new Function('$fetch', `
    const bgLibraryLoading = {value:false}, bgLibraryError = {value:''}, bgLibrary = {value:[]}
    const slug = {value:'channel'}, errors = []
    const backgroundPickerTarget = {value:'frame'}, showBackgroundPicker = {value:true}
    const frame = {background_path:'legacy.png'}, titleCard = {}, outroCard = {}
    const compilationLayout = {backgroundPlate:{source_path:''}}
    let videoEpisodeSequence = 0
    let normalization = async path => path
    const collapseToPortablePath = path => normalization(path)
    const showError = message => errors.push(message)
    ${code}
    return {refreshBackgroundLibrary, pickBackgroundFile, bgLibrary, bgLibraryLoading,
      bgLibraryError, frame, errors, showBackgroundPicker,
      normalizeWith: fn => {normalization = fn}, changeEpisode: () => {videoEpisodeSequence++}}
  `)(fetch)
}

test('the existing source lists None then app IDs without changing a saved override', async () => {
  const requested: string[] = []
  const h = await harness(async url => {
    requested.push(url)
    return { backgrounds: [{id:'white-crumpled',filename:'White crumpled',path:'${BACKGROUND}/white-crumpled'}] }
  })
  await h.refreshBackgroundLibrary()
  assert.deepEqual(requested, ['/api/projects/channel/video-editor/background-files'])
  assert.deepEqual(h.bgLibrary.value.map((item: any) => item.path), ['', '${BACKGROUND}/white-crumpled'])
  assert.equal(h.frame.background_path, 'legacy.png')
  assert.equal(h.bgLibraryLoading.value, false)
  assert.deepEqual(h.errors, [])
})

test('choosing None clears only the targeted background; catalog IDs stay portable', async () => {
  const h = await harness(async () => ({ backgrounds: [] }))
  await h.pickBackgroundFile({path:'',filename:'None'})
  assert.equal(h.frame.background_path, '')
  await h.pickBackgroundFile({path:'${BACKGROUND}/white-crumpled',filename:'White crumpled'})
  assert.equal(h.frame.background_path, '${BACKGROUND}/white-crumpled')
})

test('a slow custom-file resolution cannot overwrite the next episode', async () => {
  const h = await harness(async () => ({ backgrounds: [] }))
  let resolve!: (value: string) => void
  h.normalizeWith(() => new Promise<string>(done => { resolve = done }))
  const pending = h.pickBackgroundFile({path:'old.png',filename:'old.png'})
  h.changeEpisode()
  h.frame.background_path = 'next-episode.png'
  resolve('${CHANNEL}/backgrounds/old.png')
  await pending
  assert.equal(h.frame.background_path, 'next-episode.png')
})

test('catalog failure is visible and finishes loading', async () => {
  const h = await harness(async () => {throw new Error('Catalog unavailable')})
  await h.refreshBackgroundLibrary()
  assert.equal(h.bgLibraryLoading.value, false)
  assert.equal(h.bgLibraryError.value, 'Catalog unavailable')
  assert.deepEqual(h.errors, ['Catalog unavailable'])
})
