import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { transform } from 'esbuild'
import { createApp, defineComponent, h, nextTick, ref, type Component } from 'vue'
import { isFlowStepApplicable, type FlowStep } from '../composables/useProjectFlow.js'

function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')
}

const pipeline = source('../pages/projects/[slug]/pipeline.vue')
const picker = source('../components/EpisodeVisualSource.vue')

const pickerPath = fileURLToPath(new URL('../components/EpisodeVisualSource.vue', import.meta.url))
const globals = globalThis as typeof globalThis & {
  __episodeVisualSourceApi?: { put<T>(path: string, body: unknown): Promise<T> }
}

async function loadPicker(): Promise<Component> {
  const { descriptor } = parse(picker, { filename: pickerPath })
  const script = compileScript(descriptor, { id: 'episode-visual-source-runtime' })
  const template = compileTemplate({
    source: descriptor.template!.content,
    filename: pickerPath,
    id: 'episode-visual-source-runtime',
    compilerOptions: { bindingMetadata: script.bindings },
  })
  const vueUrl = await import.meta.resolve('vue')
  const support = `
    import { computed, defineComponent as _defineComponent, ref, watch } from ${JSON.stringify(vueUrl)}
    const useApi = () => globalThis.__episodeVisualSourceApi
    const useToast = () => ({ error: () => undefined })
  `
  const content = script.content
    .replace(/^import[^\n]+\n/gm, '')
    .replace('export default', 'const __sfc__ =')
  const built = await transform(`${support}\n${content}\n${template.code}\n__sfc__.render = render\nexport default __sfc__`, {
    loader: 'ts', format: 'esm',
  })
  return (await import(`data:text/javascript;base64,${Buffer.from(
    built.code.replaceAll('"vue"', JSON.stringify(vueUrl)),
  ).toString('base64')}`)).default
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

function deferred<T>() {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>(done => { resolve = done }), resolve }
}

test('Image Pool rows exclude Scene Plan stages from Pipeline counts', () => {
  const scenePlan = { key: 'scene-plan' } as FlowStep
  const common = { key: 'audio' } as FlowStep
  assert.equal(isFlowStepApplicable(scenePlan, 'scene_plan'), true)
  assert.equal(isFlowStepApplicable(scenePlan, 'image_pool'), false)
  assert.equal(isFlowStepApplicable(common, 'image_pool'), true)
  assert.match(pipeline, /function isStepApplicableForEpisode/)
  assert.match(pipeline, /stepId === 'broll' && source === 'image_pool'/)
  assert.match(pipeline, /isFlowStepApplicable\(\{ key: stepId\.replaceAll\('_', '-'\) \} as FlowStep, source\)/)
  assert.match(pipeline, /selectedApplicableStepCount/)
  assert.match(pipeline, /steps_skipped_as_inapplicable/)
})

test('Pipeline keeps a row source unavailable instead of defaulting it to Scene Plan', () => {
  const helper = pipeline.slice(pipeline.indexOf('function episodeVisualSource('), pipeline.indexOf('function onEpisodeVisualSourceChanged('))
  assert.match(helper, /return source === 'scene_plan' \|\| source === 'image_pool' \? source : null/)
  assert.doesNotMatch(helper, /normalizeEpisodeVisualSource/)
  assert.match(pipeline, /visual source is unavailable\. Refresh this episode before running it\./)
  assert.match(pipeline, /@changed="onEpisodeVisualSourceChanged\(ep\.episode_code, \$event\)"/)
})

test('the reusable source picker saves one episode and preserves its deep links', () => {
  assert.match(picker, /\/projects\/\$\{props\.slug\}\/video-editor\/visual-source\/\$\{encodeURIComponent\(props\.episodeId\)\}/)
  assert.match(picker, /hash: '#visual-timing'/)
  assert.match(picker, /path: `\/projects\/\$\{props\.slug\}\/video-assembly`/)
  assert.match(picker, /emit\('changed', result\.source\)/)
  assert.match(picker, /saved visual source is unavailable\. Refresh the episode list before changing it\./)
  assert.doesNotMatch(picker, /currentSource\.value = 'scene_plan'/)
})

test('an old source save cannot leave a reused picker disabled after the episode changes', async () => {
  const pending = deferred<{ source: 'image_pool' }>()
  globals.__episodeVisualSourceApi = { put: async () => pending.promise }
  const Picker = await loadPicker()
  const episodeId = ref('EP_A')
  const source = ref<'scene_plan' | 'image_pool'>('scene_plan')
  const changed: string[] = []
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(defineComponent({
    setup: () => () => h(Picker as any, {
      slug: 'fixture',
      episodeId: episodeId.value,
      source: source.value,
      onChanged: (value: string) => changed.push(value),
    }),
  }))
  app.component('NuxtLink', { template: '<a><slot /></a>' })
  app.mount(host)
  try {
    await flush()
    const poolRadio = host.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]!
    poolRadio.dispatchEvent(new Event('change', { bubbles: true }))
    await flush()
    assert.equal(host.querySelector('fieldset')!.disabled, true)

    episodeId.value = 'EP_B'
    await flush()
    assert.equal(host.querySelector('fieldset')!.disabled, false)

    pending.resolve({ source: 'image_pool' })
    await flush()
    assert.deepEqual(changed, [])
    assert.equal(host.querySelector('fieldset')!.disabled, false)
  } finally {
    app.unmount()
    host.remove()
    delete globals.__episodeVisualSourceApi
  }
})
