import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { transform } from 'esbuild'
import { createApp, nextTick, type Component } from 'vue'

const actionBarPath = new URL('../components/TopActionBar.vue', import.meta.url)
const scenePlanPath = new URL('../pages/projects/[slug]/scene-plan.vue', import.meta.url)

async function loadActionBar(): Promise<Component> {
  const source = readFileSync(actionBarPath, 'utf8')
  const { descriptor } = parse(source, { filename: actionBarPath.pathname })
  const script = compileScript(descriptor, { id: 'task13-scene-plan-loading-label' })
  const template = compileTemplate({
    source: descriptor.template!.content,
    filename: actionBarPath.pathname,
    id: 'task13-scene-plan-loading-label',
    compilerOptions: { bindingMetadata: script.bindings },
  })
  assert.deepEqual(template.errors, [])
  const vueUrl = await import.meta.resolve('vue')
  const support = `
    import { computed, defineComponent as _defineComponent, h, nextTick, onUnmounted, ref, watch } from ${JSON.stringify(vueUrl)}
    const EpisodeSelector = _defineComponent({ template: '<button type="button">Episode</button>' })
    const Modal = _defineComponent({ template: '<div><slot /></div>' })
    const LoadingSpinner = _defineComponent({ template: '<span class="loading-spinner" />' })
    const Popover = _defineComponent({ template: '<div><slot /><slot name="content" /></div>' })
    const useDismissableDetails = () => undefined
    const useToast = () => ({ success: () => undefined, error: () => undefined })
    const useConfirm = () => ({ ask: async () => true })
    const STEP_STATUS_FIELD = { script: 'script', audio: 'audio', 'audio-merge': 'merged_audio', 'image-pool': 'broll_picked', 'scene-plan': 'scene_plan', 'scene-review': 'scene_review', 'video-assembly': 'video_assembly' }
  `
  const content = script.content.replace(/^import[^\n]+\n/gm, '').replace('export default', 'const __sfc__ =')
  const output = await transform(`${support}\n${content}\n${template.code}\n__sfc__.render = render\nexport default __sfc__`, {
    loader: 'ts', format: 'esm',
  })
  return (await import(`data:text/javascript;base64,${Buffer.from(output.code.replaceAll('"vue"', JSON.stringify(vueUrl))).toString('base64')}`)).default
}

async function loadScenePlanHeader(): Promise<Component> {
  const source = readFileSync(scenePlanPath, 'utf8')
  const commandSurface = source.indexOf('<div class="workspace-command-surface">')
  const start = source.indexOf('<TopActionBar', commandSurface)
  const end = source.indexOf('>\n        <template #actions>', start)
  assert.notEqual(commandSurface, -1)
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)
  const header = `${source.slice(start, end)} />`
  const compiled = compileTemplate({ source: header, filename: scenePlanPath.pathname, id: 'task13-scene-plan-header' })
  assert.deepEqual(compiled.errors, [])
  const vueUrl = await import.meta.resolve('vue')
  const code = `
    import { defineComponent, ref } from ${JSON.stringify(vueUrl)}
    ${compiled.code.replace('export function render', 'function render')}
    const component = defineComponent({ setup() {
      const slug = ref('task13-project')
      const episodeId = ref('EP0001')
      const planPresets = { presets: ref([]), activeId: ref(''), setActive: async () => undefined, applyActive: () => undefined, overwrite: async () => undefined, saveAs: async () => undefined, rename: async () => undefined, remove: async () => undefined }
      const headerPrimaryLabel = ref('1. Build timeline')
      const headerPrimaryLoadingLabel = ref('Building timeline…')
      const planning = ref(true)
      const planJobActive = ref(false)
      const headerPrimaryDisabled = ref(false)
      const headerPrimaryStatus = ref('Building the timeline')
      const runHeaderPrimaryAction = () => undefined
      return { slug, episodeId, planPresets, headerPrimaryLabel, headerPrimaryLoadingLabel, planning, planJobActive, headerPrimaryDisabled, headerPrimaryStatus, runHeaderPrimaryAction }
    }})
    component.render = render
    export default component
  `
  const output = await transform(code, { loader: 'ts', format: 'esm' })
  return (await import(`data:text/javascript;base64,${Buffer.from(output.code.replaceAll('"vue"', JSON.stringify(vueUrl))).toString('base64')}`)).default
}

test('Scene Plan passes its busy label to the real TopActionBar rather than its idle fallback', async () => {
  const ActionBar = await loadActionBar()
  const Header = await loadScenePlanHeader()
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(Header)
  app.component('TopActionBar', ActionBar)
  app.mount(host)
  try {
    await nextTick()
    const button = host.querySelector('.btn-primary-cta')
    assert.ok(button)
    assert.match(button.textContent || '', /Building timeline…/)
    assert.doesNotMatch(button.textContent || '', /1\. Build timeline/)
  } finally {
    app.unmount()
    host.remove()
  }
})
