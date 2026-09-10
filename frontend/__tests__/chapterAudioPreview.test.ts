import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createApp, h, nextTick, reactive, type Component } from 'vue'
import { compileScript, parse } from '@vue/compiler-sfc'
import { transform } from 'esbuild'
import { waitFor } from '../../electron/server/__tests__/_timing.js'

const file = fileURLToPath(new URL('../components/ChapterAudioPreview.vue', import.meta.url))
async function component(): Promise<Component> {
  const { descriptor } = parse(readFileSync(file, 'utf8'), { filename: file })
  const script = compileScript(descriptor, { id: 'audio-preview-test', inlineTemplate: true })
  const vueUrl = import.meta.resolve('vue')
  const content = script.content.replaceAll('from "vue"', `from ${JSON.stringify(vueUrl)}`).replaceAll("from 'vue'", `from ${JSON.stringify(vueUrl)}`)
  const out = await transform(`const useApi = () => globalThis.__chapterAudioApi;\n${content}`, { loader: 'ts', format: 'esm' })
  return (await import(`data:text/javascript;base64,${Buffer.from(out.code).toString('base64')}`)).default
}
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>(done => { resolve = done }), resolve: (value: T) => resolve(value) }
}

test('plays the active chapter parts, seeks a chapter-local gap across chunks, and stops on unmount', async () => {
  const calls: string[] = []
  ;(globalThis as any).__chapterAudioApi = { get: async (path: string) => {
    calls.push(path)
    return { parts: [{ part: 0, filename: 'active_part1_v2.mp3' }, { part: 1, filename: 'active_part2_v2.mp3' }] }
  } }
  const originalPlay = HTMLMediaElement.prototype.play
  const originalPause = HTMLMediaElement.prototype.pause
  let pauses = 0
  let plays = 0
  HTMLMediaElement.prototype.play = async () => { plays++ }
  HTMLMediaElement.prototype.pause = () => { pauses++ }
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp(await component(), { projectSlug: 'capi', episodeId: 'EP0178', section: 'Chapter_13', startSeconds: 35 })
  try {
    app.mount(host)
    await waitFor(() => !!host.querySelector('audio'), { label: 'chapter audio player' })
    assert.equal(calls[0], '/projects/capi/episodes/EP0178/audio-file?section=Chapter_13&info=1')
    let audio = host.querySelector('audio')!
    assert.ok(audio.src.includes('section=Chapter_13&part=0'))
    Object.defineProperty(audio, 'duration', { value: 30, configurable: true })
    audio.dispatchEvent(new Event('loadedmetadata'))
    await nextTick()
    audio = host.querySelector('audio')!
    assert.ok(audio.src.includes('&part=1'))
    Object.defineProperty(audio, 'duration', { value: 20, configurable: true })
    audio.dispatchEvent(new Event('loadedmetadata'))
    assert.equal(audio.currentTime, 5)
    assert.equal(plays, 1)
    assert.equal(host.querySelectorAll('option').length, 2)
    const select = host.querySelector('select')!
    select.value = '0'
    select.dispatchEvent(new Event('change'))
    await nextTick()
    audio = host.querySelector('audio')!
    Object.defineProperty(audio, 'duration', { value: 30, configurable: true })
    audio.dispatchEvent(new Event('loadedmetadata'))
    assert.equal(audio.currentTime, 0)
    audio.dispatchEvent(new Event('ended'))
    await nextTick()
    assert.ok(host.querySelector('audio')!.src.includes('&part=1'))
    app.unmount()
    assert.ok(pauses >= 2)
  } finally {
    host.remove()
    HTMLMediaElement.prototype.play = originalPlay
    HTMLMediaElement.prototype.pause = originalPause
  }
})

test('late previous-episode reads cannot replace playback and a failed read offers working Retry', async () => {
  const old = deferred<any>()
  let attempts = 0
  ;(globalThis as any).__chapterAudioApi = { get: async (path: string) => {
    if (path.includes('/EP0178/')) return old.promise
    attempts++
    if (attempts === 1) throw new Error('offline')
    return { parts: [{ part: 0, filename: 'EP0179_Chapter_13.mp3' }] }
  } }
  const props = reactive({ projectSlug: 'capi', episodeId: 'EP0178', section: 'Chapter_13' })
  const Preview = await component()
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp({ render: () => h(Preview, props) })
  try {
    app.mount(host)
    props.episodeId = 'EP0179'
    await waitFor(() => !!host.querySelector('[role="alert"]'), { label: 'playback read failure' })
    old.resolve({ parts: [{ part: 9, filename: 'old.mp3' }] })
    await nextTick()
    assert.equal(host.querySelector('audio'), null)
    ;[...host.querySelectorAll('button')].find(button => button.textContent === 'Retry playback')!.click()
    await waitFor(() => !!host.querySelector('audio'), { label: 'retried current audio' })
    assert.ok(host.querySelector('audio')!.src.includes('/EP0179/audio-file'))
    assert.ok(host.querySelector('audio')!.src.includes('&part=0'))
    host.querySelector('audio')!.dispatchEvent(new Event('error'))
    await nextTick()
    assert.match(host.textContent!, /could not be played/)
  } finally { app.unmount(); host.remove() }
})
