import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import test from 'node:test'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { transform } from 'esbuild'
import { createApp, defineComponent, h, nextTick, reactive, ref, type Component } from 'vue'
import { waitFor } from '../../electron/server/__tests__/_timing.js'

const selectorPath = fileURLToPath(new URL('../components/ModelSelector.vue', import.meta.url))
const menuPath = fileURLToPath(new URL('../components/ModelMenu.vue', import.meta.url))

async function compileComponent(filename: string, id: string, support: string): Promise<Component> {
  const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename })
  const script = compileScript(descriptor, { id, inlineTemplate: true })
  const vueUrl = await import.meta.resolve('vue')
  let code = script.content
  code = code.replace(/from\s+(['"])(\.\.?\/[^'"]+)\1/g, (_match, _quote, specifier: string) => {
    const resolved = path.resolve(path.dirname(filename), specifier.replace(/\.js$/, '.ts'))
    return `from ${JSON.stringify(pathToFileURL(resolved).href)}`
  })
  const built = await transform(`${support}\n${code}`, { loader: 'ts', format: 'esm' })
  return (await import(`data:text/javascript;base64,${Buffer.from(
    built.code.replaceAll('"vue"', JSON.stringify(vueUrl)),
  ).toString('base64')}`)).default
}

const vueUrl = await import.meta.resolve('vue')
const ModelMenu = await compileComponent(menuPath, 'script-document-model-menu', `
  import { computed, nextTick, ref } from ${JSON.stringify(vueUrl)}
`)
const ModelSelector = await compileComponent(selectorPath, 'script-document-model-selector', `
  import { computed, ref, watch } from ${JSON.stringify(vueUrl)}
  const useApi = () => globalThis.__scriptDocumentSelectorApi
  const useAppSettingsModal = () => ({ open: () => undefined })
  const useGenStudioModelDisplay = () => ({
    hydrate: () => undefined,
    remember: () => undefined,
    knownName: () => '',
  })
`)

const PickerDialog = defineComponent({
  setup(_, { slots }) { return () => h('div', { class: 'picker-dialog-stub' }, slots.default?.()) },
})

function model(id: string, legacyIds: string[] = []) {
  return {
    id,
    label: id === 'model-a' ? 'Model A' : 'Model B',
    provider: 'genstudio',
    provider_name: 'Mock',
    available: true,
    locked: false,
    chargeable: false,
    legacy_ids: legacyIds,
    cost_tier: 'economy',
    queue_class: 'direct',
  }
}

async function mountSelector(initial: string, catalogue: { value: any[] }) {
  const selected = ref(initial)
  const deliberate: string[] = []
  const selector = ref<any>(null)
  ;(globalThis as any).__scriptDocumentSelectorApi = {
    get: async (url: string) => url.startsWith('/models?')
      ? JSON.parse(JSON.stringify(catalogue.value))
      : {},
  }
  const Harness = defineComponent({
    setup: () => () => h(ModelSelector, {
      ref: selector,
      modelValue: selected.value,
      projectSlug: 'script-project',
      writingStep: true,
      'onUpdate:modelValue': (value: string) => { selected.value = value },
      onUserSelected: (value: string) => { deliberate.push(value) },
    }),
  })
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(Harness)
  app.component('ModelMenu', ModelMenu)
  app.component('PickerDialog', PickerDialog)
  app.component('NuxtLink', PickerDialog)
  app.mount(host)
  await nextTick(); await nextTick(); await nextTick()
  return {
    app, host, selected, deliberate, selector,
    unmount: () => { app.unmount(); host.remove() },
  }
}

test('real ModelMenu selection emits explicit user intent through the real ModelSelector', async () => {
  const catalogue = ref<any[]>([model('model-a'), model('model-b')])
  const fixture = await mountSelector('model-a', catalogue)
  try {
    await waitFor(() => {
      const trigger = fixture.host.querySelector<HTMLButtonElement>('.model-menu-trigger')
      return !!trigger && !trigger.disabled && trigger.textContent?.includes('Model A') === true
    }, { label: 'model selector initial catalogue' })
    fixture.host.querySelector<HTMLButtonElement>('.model-menu-trigger')!.click()
    await waitFor(() => [...fixture.host.querySelectorAll('.model-menu-option')]
      .some(button => button.textContent?.includes('Model B')), { label: 'real Model B menu row' })
    const buttons = [...fixture.host.querySelectorAll<HTMLButtonElement>('.model-menu-option')]
    buttons.find(button => button.textContent?.includes('Model B'))!.click()
    await nextTick()
    assert.equal(fixture.selected.value, 'model-b')
    assert.deepEqual(fixture.deliberate, ['model-b'])
  } finally {
    fixture.unmount()
  }
})

test('catalog reconciliation updates the model without claiming a user selection', async () => {
  const catalogue = ref<any[]>([model('model-b', ['legacy-model'])])
  const fixture = await mountSelector('legacy-model', catalogue)
  try {
    await waitFor(() => fixture.selected.value === 'model-b', { label: 'published legacy-id reconciliation' })
    assert.equal(fixture.selected.value, 'model-b')
    assert.deepEqual(fixture.deliberate, [])
    catalogue.value = [model('model-b')]
    await fixture.selector.value.reloadCatalog()
    await nextTick()
    assert.deepEqual(fixture.deliberate, [])
  } finally {
    fixture.unmount()
  }
})

async function compilePageFragment(source: string): Promise<(ctx: Record<string, any>) => any> {
  const compiled = compileTemplate({ source, filename: 'script-document-page-fragment.vue', id: 'script-page-fragment' })
  const built = await transform(compiled.code, { loader: 'ts', format: 'esm' })
  return (await import(`data:text/javascript;base64,${Buffer.from(
    built.code.replaceAll('"vue"', JSON.stringify(vueUrl)),
  ).toString('base64')}`)).render
}

test('the real Scripts page bindings share explicit parent and chapter user edits without treating automatic model updates as user intent', async () => {
  const page = readFileSync(fileURLToPath(new URL('../pages/projects/[slug]/scripts.vue', import.meta.url)), 'utf8')
  const actionBinding = page.match(/<TopActionBar[\s\S]*?\n\s*\/>/)?.[0]
  const characterBinding = page.match(/<CharacterPicker[\s\S]*?\n\s*\/>/)?.[0]
  const modelBinding = page.match(/<ModelSelector v-model="form\.model"[^>]+\/>/)?.[0]
  const panelBinding = page.match(/<OutlineReviewPanel[\s\S]*?\n\s*\/>/)?.[0]
  assert.ok(actionBinding && characterBinding && modelBinding && panelBinding,
    'actual Scripts page owns every explicit child binding')
  const render = await compilePageFragment(`<div>${actionBinding}${characterBinding}${modelBinding}${panelBinding}</div>`)
  const state = reactive<Record<string, any>>({
    form: {
      model: 'model-a', episode_id: 'EP7207', title: 'Shared epoch', words_per_chapter: 700,
      character_ids: [],
    },
    slug: 'script-project', outlineRefreshKey: 0, narratorStyleLabels: {}, customStyleText: '',
    outlineManualUserEpoch: 0, panelsReady: true,
    scriptPresets: [], scriptJobActiveForEpisode: false, submitting: false, canSubmit: true,
    submitDisabledReason: '',
    onScriptModelMeta: () => undefined, onExpansionQueued: () => undefined, onOutlineLoaded: () => undefined,
    submitOutline: () => undefined, onEpisodeSelected: () => undefined,
    retireOutlineManualAction: () => { state.outlineManualUserEpoch++ },
    onCharacterSelection: (value: string[]) => {
      state.form.character_ids = value
      state.outlineManualUserEpoch++
    },
  })
  const TopActionBarStub = defineComponent({
    emits: ['preset-applied'],
    setup(_, { emit }) { return () => h('button', { class: 'preset-apply', onClick: () => emit('preset-applied') }, 'preset') },
  })
  const CharacterPickerStub = defineComponent({
    emits: ['update:modelValue'],
    setup(_, { emit }) {
      return () => h('button', { class: 'quick-character', onClick: () => emit('update:modelValue', ['character-a']) }, 'character')
    },
  })
  const ModelSelectorStub = defineComponent({
    emits: ['update:modelValue', 'model-meta', 'user-selected'],
    setup(_, { emit }) {
      return () => h('div', [
        h('button', { class: 'automatic-model', onClick: () => emit('update:modelValue', 'automatic-model') }, 'automatic'),
        h('button', {
          class: 'user-model',
          onClick: () => { emit('update:modelValue', 'user-model'); emit('user-selected', 'user-model') },
        }, 'user'),
      ])
    },
  })
  const OutlineReviewPanelStub = defineComponent({
    emits: ['manual-user-edit'],
    setup(_, { emit }) { return () => h('button', { class: 'chapter-edit', onClick: () => emit('manual-user-edit') }, 'chapter') },
  })
  const Page = defineComponent({ setup: () => state, render })
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(Page)
  app.component('TopActionBar', TopActionBarStub)
  app.component('CharacterPicker', CharacterPickerStub)
  app.component('ModelSelector', ModelSelectorStub)
  app.component('OutlineReviewPanel', OutlineReviewPanelStub)
  app.mount(host)
  try {
    host.querySelector<HTMLButtonElement>('.automatic-model')!.click()
    await nextTick()
    assert.equal(state.outlineManualUserEpoch, 0)
    host.querySelector<HTMLButtonElement>('.user-model')!.click()
    host.querySelector<HTMLButtonElement>('.chapter-edit')!.click()
    host.querySelector<HTMLButtonElement>('.preset-apply')!.click()
    host.querySelector<HTMLButtonElement>('.quick-character')!.click()
    await nextTick()
    assert.equal(state.outlineManualUserEpoch, 4)
  } finally {
    app.unmount(); host.remove()
  }
})

test('Introduction click-only recipe changes and explicit preset Apply retire a captured action', () => {
  const page = readFileSync(fileURLToPath(new URL('../pages/projects/[slug]/introduction.vue', import.meta.url)), 'utf8')
  assert.match(page, /@preset-applied="retireIntroductionManualAction"/)
  assert.match(page, /autoApplyOnLoad: false/,
    'automatic recipe hydration remains separate from explicit preset Apply')
  assert.match(page, /freshIntroductionAction\.begin\(\{ scope, userEpoch: introductionManualUserEpoch\.value \}/,
    'the next deliberate action scopes its identity to the current user epoch without changing the wire body')
  for (const functionName of ['restoreBeat', 'moveBeat', 'removeBeat', 'addBeat']) {
    const start = page.indexOf(`function ${functionName}(`)
    assert.notEqual(start, -1, `${functionName} must remain an explicit page action`)
    const end = page.indexOf('\n}', start)
    assert.match(page.slice(start, end), /retireIntroductionManualAction\(\)/,
      `${functionName} must retire the pending manual UUID as well as its Retry epoch`)
  }
})

test('ordinary and manual outline submits share one busy-state owner', () => {
  const page = readFileSync(fileURLToPath(new URL('../pages/projects/[slug]/scripts.vue', import.meta.url)), 'utf8')
  assert.match(page, /freshScriptAction\.begin\(\{ scope: manualScope, userEpoch \}, 'manual-outline'\)/)
  assert.match(page, /let outlineSubmitOwner = 0/)
  assert.ok((page.match(/const submitOwner = claimOutlineSubmit\(\)/g) || []).length >= 2,
    'manual and ordinary submission must each claim the shared busy owner')
  assert.ok((page.match(/ownsOutlineSubmit\(submitOwner\)/g) || []).length >= 2,
    'manual and ordinary cleanup must both prove current ownership')
})

function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `${name} must exist in the actual Scripts page`)
  const open = source.indexOf('{', start)
  let depth = 0
  for (let index = open; index < source.length; index++) {
    if (source[index] === '{') depth++
    else if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1)
  }
  throw new Error(`${name} has no closing brace`)
}

test('episode retirement releases an unaccepted outline busy owner before a successor', async () => {
  const page = readFileSync(fileURLToPath(new URL('../pages/projects/[slug]/scripts.vue', import.meta.url)), 'utf8')
  const watcher = page.slice(
    page.indexOf('watch(() => form.episode_id, (newEp, oldEp) => {'),
    page.indexOf('\n})', page.indexOf('watch(() => form.episode_id, (newEp, oldEp) => {')),
  )
  assert.match(watcher, /retireOutlineSubmitView\(\)/,
    'the episode switch must release a local submit that created no queue job')
  const harness = await transform(`
    export default function createHarness(state) {
      const { jobs, watchedScriptTypes, submitting, scriptGenerating } = state
      let outlineSubmitOwner = 0
      ${extractFunction(page, 'claimOutlineSubmit')}
      ${extractFunction(page, 'ownsOutlineSubmit')}
      ${extractFunction(page, 'retireOutlineSubmitView')}
      return { claimOutlineSubmit, ownsOutlineSubmit, retireOutlineSubmitView }
    }
  `, { loader: 'ts', format: 'esm' })
  const createHarness = (await import(`data:text/javascript;base64,${Buffer.from(harness.code).toString('base64')}`)).default
  const state = {
    jobs: ref<any[]>([]),
    watchedScriptTypes: new Set(['outline_only', 'chapter-only', 'expand_chapters', 'introduction-only']),
    submitting: ref(false),
    scriptGenerating: ref(false),
  }
  const actual = createHarness(state)
  const retiredOwner = actual.claimOutlineSubmit()
  actual.retireOutlineSubmitView()
  assert.equal(state.submitting.value, false)
  assert.equal(state.scriptGenerating.value, false,
    'an unaccepted request with no queue job releases the global pulse at retirement')

  const successorOwner = actual.claimOutlineSubmit()
  if (actual.ownsOutlineSubmit(retiredOwner)) state.scriptGenerating.value = false
  assert.equal(actual.ownsOutlineSubmit(successorOwner), true)
  assert.equal(state.scriptGenerating.value, true,
    'the late retired reject/finally cannot clear a newer ordinary submit owner')

  state.jobs.value = [{ type: 'outline_only', status: 'running' }]
  actual.retireOutlineSubmitView()
  assert.equal(state.submitting.value, false)
  assert.equal(state.scriptGenerating.value, true,
    'a known queued or running Script writer keeps the global indicator active')
})
