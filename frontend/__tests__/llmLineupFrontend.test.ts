import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createApp, defineComponent, nextTick, onMounted, h, ref } from 'vue'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import { transform } from 'esbuild'
import { waitFor } from '../../electron/server/__tests__/_timing.js'
import { cloneLlmLineup, DEFAULT_LLM_LINEUP, lineupModeForModels, normalizeLlmLineup, normalizeLlmModelId, sameLlmModelId } from '../utils/llm-lineup.js'

const editor = readFileSync(fileURLToPath(new URL('../components/LlmLineupEditor.vue', import.meta.url)), 'utf8')
const pipeline = readFileSync(fileURLToPath(new URL('../pages/projects/[slug]/pipeline.vue', import.meta.url)), 'utf8')

test('LLM lineup defaults are safe and preserve ordered selections', () => {
  assert.deepEqual(normalizeLlmLineup(undefined), DEFAULT_LLM_LINEUP)
  assert.deepEqual(normalizeLlmLineup({ enabled: true, models: ['free', '', 'paid'], prefer_savings: false }), {
    enabled: true, models: ['free', 'paid'], prefer_savings: false,
  })
  assert.deepEqual(cloneLlmLineup({ enabled: true, models: ['first', 'second'], prefer_savings: true }), {
    enabled: true, models: ['first', 'second'], prefer_savings: true,
  })
  assert.equal(lineupModeForModels(['only']), 'single')
  assert.equal(lineupModeForModels(['primary', 'backup']), 'backup')
})

test('chat gateway prefixes normalize consistently without healing a saved product', () => {
  assert.equal(normalizeLlmModelId(' genstudio-chat:free-choice '), 'free-choice')
  assert.equal(sameLlmModelId('free-choice', 'genstudio-chat:free-choice'), true)
  assert.deepEqual(normalizeLlmLineup({ enabled: true, models: ['genstudio-chat:free-choice', 'free-choice', 'paid-choice'] }), {
    enabled: true, models: ['free-choice', 'paid-choice'], prefer_savings: true,
  })
})

async function loadMountedEditor(): Promise<any> {
  const filename = fileURLToPath(new URL('../components/LlmLineupEditor.vue', import.meta.url))
  const source = readFileSync(filename, 'utf8')
  const { descriptor } = parse(source, { filename })
  const script = compileScript(descriptor, { id: 'llm-lineup-roundtrip' })
  const template = compileTemplate({
    source: descriptor.template!.content,
    filename,
    id: 'llm-lineup-roundtrip',
    compilerOptions: { bindingMetadata: script.bindings },
  })
  const vueUrl = await import.meta.resolve('vue')
  const support = `
    const useApi = () => globalThis.__llmLineupApi
    const useProject = () => globalThis.__llmLineupProject
    const usePresets = () => globalThis.__llmLineupPresets
    const useToast = () => ({ success: () => {} })
    import { MAX_LLM_LINEUP_MODELS, DEFAULT_LLM_LINEUP, normalizeLlmModelId, sameLlmModelId, cloneLlmLineup, normalizeLlmLineup } from ${JSON.stringify(new URL('../utils/llm-lineup.ts', import.meta.url).href)}
  `
  const code = `${support}\n${script.content
    .replace(/^import .*? from ['"](?:\.\.?\/|~\/|@\/).*?['"]\s*;?\s*$/gm, '')
    .replace('export default', 'const __sfc__ =')}
${template.code}
__sfc__.render = render
export default __sfc__`
  const transformed = await transform(code, { loader: 'ts', format: 'esm' })
  const componentUrl = `data:text/javascript;base64,${Buffer.from(
    transformed.code.replaceAll('"vue"', JSON.stringify(vueUrl)),
  ).toString('base64')}`
  return (await import(componentUrl)).default
}

const MountedModelSelector = defineComponent({
  props: { modelValue: { type: String, required: true }, projectSlug: { type: String, required: true }, label: String },
  emits: ['update:modelValue', 'model-meta'],
  setup(props, { emit }) {
    const options = ['genstudio-chat:alpha', 'genstudio-chat:beta', 'genstudio-chat:unknown']
    onMounted(() => emit('model-meta', ['retiring', 'depleted', 'unknown'].includes(props.modelValue) ? null : { id: `genstudio-chat:${props.modelValue}` }))
    return { options, selected: ref(props.modelValue.startsWith('genstudio-chat:') ? props.modelValue : `genstudio-chat:${props.modelValue}`) }
  },
  template: '<div><label>{{ label }}</label><select v-model="selected" @change="$emit(\'update:modelValue\', selected); $emit(\'model-meta\', selected.endsWith(\':unknown\') ? null : { id: selected })"><option v-for="option in options" :key="option" :value="option">{{ option }}</option></select></div>',
})

const MountedPresetPicker = defineComponent({
  props: { label: String, presets: { type: Array, default: () => [] }, activeId: String },
  template: '<div><strong>{{ label }}</strong></div>',
})

async function mountEditor(component: any, api: any) {
  ;(globalThis as any).__llmLineupApi = api
  ;(globalThis as any).__llmLineupProject = { refreshConfig: async () => {} }
  ;(globalThis as any).__llmLineupPresets = {
    presets: ref([]), activeId: ref(null), activePresetIsBuiltIn: ref(false),
    load: async () => {}, setActive: () => {}, applyActive: () => false,
    overwrite: async () => {}, saveAs: async () => {}, rename: async () => {}, remove: async () => {},
  }
  document.body.innerHTML = ''
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(component, { projectSlug: 'roundtrip-project' })
  app.component('ModelSelector', MountedModelSelector)
  app.component('PresetPicker', MountedPresetPicker)
  app.mount(host)
  await nextTick()
  await waitFor(() => Boolean(host.querySelector('.llm-lineup-editor') && !host.textContent?.includes('Loading project lineup…')), { label: 'LLM lineup editor readiness' })
  return { host, unmount: () => app.unmount() }
}

test('mounted editor saves picker-native prefixed selection as backend bare id and settles saved state', async () => {
  const Editor = await loadMountedEditor()
  const requests: Array<{ path: string; body?: any }> = []
  let saved = { enabled: true, models: ['alpha'], prefer_savings: true }
  const api = {
    get: async () => ({ llm_lineup: saved }),
    put: async (path: string, body: any) => { requests.push({ path, body }); saved = body.llm_lineup },
  }
  const mounted = await mountEditor(Editor, api)
  const select = mounted.host.querySelector('select') as HTMLSelectElement
  select.value = 'genstudio-chat:beta'
  select.dispatchEvent(new Event('change', { bubbles: true }))
  await nextTick()
  const apply = [...mounted.host.querySelectorAll('button')].find(button => button.textContent?.includes('Apply lineup to project')) as HTMLButtonElement
  assert.ok(apply && !apply.disabled)
  apply.click()
  await waitFor(() => requests.length === 1 && mounted.host.textContent?.includes('Saved project lineup') === true, { label: 'LLM lineup save round trip' })
  assert.equal(requests[0]?.path, '/projects/roundtrip-project/settings/config')
  assert.deepEqual(requests[0]?.body?.llm_lineup, { enabled: true, models: ['beta'], prefer_savings: true })
  assert.match(mounted.host.textContent || '', /Saved project lineup/)
  assert.doesNotMatch(mounted.host.textContent || '', /Draft changes/)
  mounted.unmount()
})

test('mounted editor can disable a retired saved selection without live metadata', async () => {
  const Editor = await loadMountedEditor()
  const requests: Array<{ body?: any }> = []
  let saved = { enabled: true, models: ['retiring'], prefer_savings: true }
  const mounted = await mountEditor(Editor, {
    get: async () => ({ llm_lineup: saved }),
    put: async (_path: string, body: any) => { requests.push(body); saved = body.llm_lineup },
  })
  const toggle = mounted.host.querySelector('.llm-lineup-toggle input') as HTMLInputElement
  toggle.click()
  await nextTick()
  const apply = [...mounted.host.querySelectorAll('button')].find(button => button.textContent?.includes('Apply lineup to project')) as HTMLButtonElement
  assert.ok(apply && !apply.disabled)
  apply.click()
  await waitFor(() => requests.length === 1 && mounted.host.textContent?.includes('Saved project lineup') === true, { label: 'disabled retired LLM lineup save' })
  assert.deepEqual(requests[0]?.llm_lineup, { enabled: false, models: ['retiring'], prefer_savings: true })
  mounted.unmount()
})

test('mounted editor retains a depleted saved choice while requiring metadata for new choices', async () => {
  const Editor = await loadMountedEditor()
  const requests: Array<{ body?: any }> = []
  let saved = { enabled: true, models: ['depleted', 'alpha'], prefer_savings: true }
  const mounted = await mountEditor(Editor, {
    get: async () => ({ llm_lineup: saved }),
    put: async (_path: string, body: any) => { requests.push(body); saved = body.llm_lineup },
  })
  const selects = () => [...mounted.host.querySelectorAll('select')] as HTMLSelectElement[]
  const paid = selects()[1]
  paid.value = 'genstudio-chat:beta'
  paid.dispatchEvent(new Event('change', { bubbles: true }))
  await nextTick()
  const apply = () => [...mounted.host.querySelectorAll('button')].find(button => button.textContent?.includes('Apply lineup to project')) as HTMLButtonElement
  assert.ok(!apply().disabled, 'an unchanged depleted choice must not block a verified new choice')
  apply().click()
  await waitFor(() => requests.length === 1 && mounted.host.textContent?.includes('Saved project lineup') === true, { label: 'depleted saved choice round trip' })
  assert.deepEqual(requests[0]?.llm_lineup, { enabled: true, models: ['depleted', 'beta'], prefer_savings: true })

  const add = [...mounted.host.querySelectorAll('button')].find(button => button.textContent?.includes('Add model')) as HTMLButtonElement
  add.click()
  await nextTick()
  assert.ok(apply().disabled, 'a blank new slot must block apply')
  const unknown = selects()[2]
  unknown.value = 'genstudio-chat:unknown'
  unknown.dispatchEvent(new Event('change', { bubbles: true }))
  await nextTick()
  assert.ok(apply().disabled, 'an unverified new slot must block apply')
  mounted.unmount()
})

test('editor keeps presets separate from explicit project settings and has bounded reorder controls', () => {
  assert.match(editor, /configKey: 'llm_lineup'/)
  assert.match(editor, /presetType: 'llm-lineup'/)
  assert.match(editor, /autoApplyOnLoad: false/)
  assert.match(editor, /put\(`\/projects\/\$\{targetSlug\}\/settings\/config`, \{ llm_lineup: next \}\)/)
  assert.match(editor, /:disabled="index === 0 \|\| saving"/)
  assert.match(editor, /:disabled="index === draft\.models\.length - 1 \|\| saving"/)
  assert.match(editor, /MAX_LLM_LINEUP_MODELS/)
  assert.match(editor, /draft\.enabled && draft\.models\.some/)
  assert.doesNotMatch(editor, /maxModels|slice\(0,\s*\d+\)/)
})

test('Pipeline applies a saved lineup to eligible stages while preserving explicit stage overrides', () => {
  assert.match(pipeline, /<LlmLineupEditor :key="slug" :project-slug="slug"/)
  assert.match(pipeline, /wait_for_availability: true/)
  assert.match(pipeline, /prefer_savings: savedLlmLineup\.value\.prefer_savings/)
  assert.match(pipeline, /else if \(savedLlmLineup\.value\.enabled && savedLlmLineup\.value\.models\.length\)/)
  assert.match(pipeline, /savedLlmLineup\.value\.models\.length >= 2 \? 'backup' : 'single'/)
  assert.match(pipeline, /watch\(slug, \(\) => \{[\s\S]*savedLlmLineup\.value = \{ enabled: false, models: \[\], prefer_savings: true \}/)
})
