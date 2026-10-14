/**
 * Focused RED contract for truthful preset selection and frontend admission.
 *
 * The runtime portion mounts Vue around the real composable with an in-memory
 * config transport. Source checks cover the bounded SFC call sites without
 * making project/provider calls.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test, beforeEach } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createApp, defineComponent, h, nextTick, onMounted, reactive, ref, shallowRef, type Component } from 'vue'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { transform } from 'esbuild'
import ts from 'typescript'

const configStore: Record<string, any> = {}
const puts: Array<{ slug: string; body: Record<string, unknown> }> = []
let putBarrier: Promise<void> | null = null

;(globalThis as any).$fetch = async (url: string, options: any = {}) => {
  const match = url.match(/^\/api\/projects\/([^/]+)\/settings\/config$/)
  if (!match) throw new Error(`unexpected fetch: ${url}`)
  const slug = match[1]!
  configStore[slug] ||= {}
  if (!options.method || options.method === 'GET') return structuredClone(configStore[slug])
  if (options.method === 'PUT') {
    const body = structuredClone(options.body || {})
    puts.push({ slug, body })
    if (putBarrier) await putBarrier
    Object.assign(configStore[slug], body)
    return { ok: true }
  }
  throw new Error(`unexpected method: ${options.method}`)
}

const { usePresets } = await import('../composables/usePresets.js')

const topActionBarSource = readFileSync(
  fileURLToPath(new URL('../components/TopActionBar.vue', import.meta.url)), 'utf8',
)
const scenePlanPageSource = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/scene-plan.vue', import.meta.url)), 'utf8',
)
const pipelinePageSource = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/pipeline.vue', import.meta.url)), 'utf8',
)

function scenePlanSubmissionHarness(postImpl: (url: string, body: any) => Promise<any>) {
  const script = parse(scenePlanPageSource).descriptor.scriptSetup!.content
  const ast = ts.createSourceFile('scene-plan.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const names = new Set(['retireScenePlanUserIntent', 'provesNewAdmissionRejected', 'submitScenePlanSubmission', 'retryScenePlanSubmission'])
  const functions = ast.statements
    .filter(statement => ts.isFunctionDeclaration(statement) && names.has(statement.name!.text))
    .map(statement => statement.getText(ast)).join('\n')
  const compiled = ts.transpileModule(`${functions}\nreturn { submitScenePlanSubmission, retryScenePlanSubmission, retireScenePlanUserIntent, switchEpisode(next) { episodeId.value = next; scenePlanSubmitOwner += 1; planningEpisode.value = null; retireScenePlanUserIntent() } }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText
  const context = {
    ref, slug: ref('channel-a'), episodeId: ref('EP-A'),
    pendingScenePlanSubmission: shallowRef<any>(null), planningEpisode: ref<string | null>(null), planningStage: ref('timeline'),
    posts: [] as any[], notices: [] as string[], actions: [] as Array<() => void>,
    completed: [] as string[], cancelled: 0,
  }
  const api = new Function('ctx', 'postImpl', `
    const { ref, slug, episodeId, pendingScenePlanSubmission, planningEpisode, planningStage, posts, notices, actions, completed } = ctx;
    const post = async (url, body) => { posts.push({ url, body: structuredClone(body) }); return postImpl(url, body); };
    const success = message => notices.push(message);
    const showError = message => notices.push(message);
    const showAction = (_message, _label, action) => actions.push(action);
    const UNCONFIRMED_SUBMISSION = 'unconfirmed';
    const freshScenePlanRunAction = { complete: id => completed.push(id), cancel: () => { ctx.cancelled += 1; } };
    const pollUntilPlanLanded = async () => null;
    const planning = { get value() { return planningEpisode.value === episodeId.value; } };
    let scenePlanUserEpoch = 0;
    let scenePlanSubmitOwner = 0;
    ${compiled}
  `)(context, postImpl)
  return { ...context, ...api }
}

function scenePlanPresetFormHarness() {
  const script = parse(scenePlanPageSource).descriptor.scriptSetup!.content
  const ast = ts.createSourceFile('scene-plan.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const names = new Set(['scenePlanPromptDefaults', 'applyPromptPreset'])
  const functions = ast.statements
    .filter(statement => ts.isFunctionDeclaration(statement) && names.has(statement.name!.text))
    .map(statement => statement.getText(ast)).join('\n')
  const compiled = ts.transpileModule(`${functions}\nreturn { applyPromptPreset }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText
  const form = ref({
    model: '', use_research: true, prompt_pack_size: 'auto' as string | number,
    prompt_max_tokens: 'auto' as string | number, intended_image_model: '',
    prompt_char_cap: 'auto' as string | number, avoid_legible_text: true,
    creative_profile: 'narrative', creative_intensity: 2,
    creative_strategies: ['literal-narrative', 'editorial-metaphor', 'symbolic', 'poetic-environment'],
    creative_motifs: '', creative_avoid_cliches: '', creative_custom_direction: '',
    custom_instructions: 'Current episode only', reusable_guidance: '',
  })
  const projectConfig = ref({ avoid_legible_text_in_scenes: true })
  const api = new Function('ctx', `
    const { form, projectConfig } = ctx;
    const CREATIVE_PROFILES = [{ id: 'narrative' }, { id: 'custom' }];
    const CREATIVE_STRATEGIES = [
      { id: 'literal-narrative' }, { id: 'editorial-metaphor' },
      { id: 'symbolic' }, { id: 'poetic-environment' },
    ];
    const normalizePromptPackSetting = value => value === 'auto' || value == null || value === '' ? 'auto' : Number(value);
    const normalizePromptTokenSetting = value => value === 'auto' || value == null || value === '' ? 'auto' : Number(value);
    const setPromptPackSetting = value => { form.value.prompt_pack_size = normalizePromptPackSetting(value); };
    const setPromptCharCapSetting = value => { form.value.prompt_char_cap = value === 'auto' || value === 'none' ? value : Number(value); };
    const clampOutputAllowance = value => value;
    const publishedMaxOutput = { value: undefined };
    ${compiled}
  `)({ form, projectConfig }) as { applyPromptPreset(data: any): void }
  return { ...api, form }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

beforeEach(() => {
  for (const key of Object.keys(configStore)) delete configStore[key]
  puts.length = 0
  putBarrier = null
})

async function flushVue(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
  await nextTick()
}

async function loadTopActionBar(): Promise<Component> {
  const filename = fileURLToPath(new URL('../components/TopActionBar.vue', import.meta.url))
  const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename })
  const script = compileScript(descriptor, { id: 'preset-authority-top-action-bar' })
  const template = compileTemplate({
    source: descriptor.template!.content,
    filename,
    id: 'preset-authority-top-action-bar',
    compilerOptions: { bindingMetadata: script.bindings },
  })
  assert.deepEqual(template.errors, [])
  const vueUrl = await import.meta.resolve('vue')
  const support = `
    import { computed, defineComponent as _defineComponent, h, nextTick, onUnmounted, ref, watch } from ${JSON.stringify(vueUrl)}
    const EpisodeSelector = _defineComponent({ template: '<button type="button">Episode</button>' })
    const Modal = _defineComponent({ template: '<div><slot /></div>' })
    const LoadingSpinner = _defineComponent({ template: '<span />' })
    const Popover = _defineComponent({ template: '<div><slot /><slot name="content" /></div>' })
    const useDismissableDetails = () => undefined
    const useToast = () => ({ success: () => undefined, error: () => undefined })
    const useConfirm = () => ({ ask: async () => true })
    const STEP_STATUS_FIELD = {}
  `
  const content = script.content.replace(/^import[^\n]+\n/gm, '').replace('export default', 'const __sfc__ =')
  const output = await transform(`${support}\n${content}\n${template.code}\n__sfc__.render = render\nexport default __sfc__`, {
    loader: 'ts', format: 'esm',
  })
  return (await import(`data:text/javascript;base64,${Buffer.from(
    output.code.replaceAll('"vue"', JSON.stringify(vueUrl)),
  ).toString('base64')}`)).default
}

test('selection and reusable form edits expose dirty truth without speculative autosave', async () => {
  configStore.truth = {
    scene_plan_presets: [
      { id: 'preset-a', name: 'Approved A', type: 'scene-plan', data: { model: 'model-a', reusable_guidance: 'A' } },
      { id: 'preset-b', name: 'Approved B', type: 'scene-plan', data: { model: 'model-b', reusable_guidance: 'B' } },
    ],
    'scene_plan_last_preset_scene-plan': 'preset-a',
  }
  const form = reactive({ model: '', reusable_guidance: '' })
  const presets = usePresets({
    slug: 'truth', configKey: 'scene_plan', presetType: 'scene-plan',
    snapshot: () => ({ ...form }),
    apply: data => Object.assign(form, data),
  }) as ReturnType<typeof usePresets<{ model: string; reusable_guidance: string }>> & {
    isDirty?: { value: boolean }
  }

  await presets.load()
  assert.equal(presets.activeId.value, 'preset-a')
  assert.deepEqual({ ...form }, { model: 'model-a', reusable_guidance: 'A' })
  assert.ok(presets.isDirty, 'the shared composable exposes whether the form still equals the selected preset')
  assert.equal(presets.isDirty!.value, false)

  await presets.setActive('preset-b')
  assert.deepEqual({ ...form }, { model: 'model-a', reusable_guidance: 'A' },
    'selection alone keeps the existing explicit Apply control')
  assert.equal(presets.isDirty!.value, true,
    'the UI must not claim it will use B while A is still loaded')

  presets.applyActive()
  assert.deepEqual({ ...form }, { model: 'model-b', reusable_guidance: 'B' })
  assert.equal(presets.isDirty!.value, false)

  form.reusable_guidance = 'B with a deliberate edit'
  assert.equal(presets.isDirty!.value, true,
    'a reusable edit must be saved/applied before preset-backed generation')
  assert.equal(configStore.truth.scene_plan_presets[1].data.reusable_guidance, 'B',
    'editing a form never autosaves over the channel-approved preset')

  await presets.overwrite()
  assert.equal(presets.isDirty!.value, false)
  assert.equal(configStore.truth.scene_plan_presets[1].data.reusable_guidance, 'B with a deliberate edit')
})

test('mounted Vue distinguishes selected, applied, automatic catalogue reconciliation, and deliberate edits', async () => {
  configStore.mounted = {
    scene_plan_presets: [
      { id: 'preset-a', name: 'Approved A', type: 'scene-plan', data: { model: 'model-a', reusable_guidance: 'A' } },
      { id: 'preset-b', name: 'Approved B', type: 'scene-plan', data: { model: 'legacy-model-b', reusable_guidance: 'B' } },
    ],
    'scene_plan_last_preset_scene-plan': 'preset-a',
  }
  const form = reactive({ model: '', reusable_guidance: '', custom_instructions: 'Episode A only' })
  let controller: any
  const ready = ref(false)
  const Harness = defineComponent({
    setup() {
      controller = usePresets({
        slug: 'mounted', configKey: 'scene_plan', presetType: 'scene-plan',
        autoApplyOnLoad: false,
        excludeKeys: ['episode_id', 'episodeId', 'episode', 'title', 'custom_instructions'],
        snapshot: () => ({ ...form }),
        apply: (data: Record<string, unknown>) => Object.assign(form, data),
        // The current live catalogue says this old saved identifier and the
        // canonical identifier name the same retained product. Automatic
        // reconciliation must not masquerade as a user's reusable edit.
        normalizeForComparison: (data: Record<string, any>) => ({
          ...data,
          model: data.model === 'legacy-model-b' ? 'model-b' : data.model,
        }),
      } as any)
      onMounted(async () => {
        await controller.load()
        controller.applyActive()
        ready.value = true
      })
      return () => h('div', {
        'data-ready': String(ready.value),
        'data-dirty': String(controller?.isDirty?.value ?? false),
      }, [
        h('select', {
          class: 'preset-select',
          value: controller.activeId.value,
          onChange: (event: Event) => controller.setActive((event.target as HTMLSelectElement).value),
        }, controller.presets.value.map((preset: any) => h('option', { value: preset.id }, preset.name))),
        h('button', { class: 'apply', onClick: () => controller.applyActive() }, 'Apply'),
        h('button', { class: 'auto-model', onClick: () => { form.model = 'model-b' } }, 'Catalogue reconciled'),
        h('button', { class: 'user-model', onClick: () => { form.model = 'model-c' } }, 'Pick another model'),
        h('button', { class: 'episode-edit', onClick: () => { form.custom_instructions = 'Episode B only' } }, 'Episode edit'),
      ])
    },
  })
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(Harness)
  app.mount(host)
  try {
    await flushVue()
    const root = host.firstElementChild as HTMLElement
    assert.equal(root.dataset.ready, 'true')
    assert.equal(root.dataset.dirty, 'false')

    const select = host.querySelector<HTMLSelectElement>('.preset-select')!
    select.value = 'preset-b'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await flushVue()
    assert.equal(root.dataset.dirty, 'true',
      'choosing B does not claim B is applied while the mounted form still contains A')

    host.querySelector<HTMLButtonElement>('.apply')!.click()
    await flushVue()
    assert.equal(form.model, 'legacy-model-b')
    assert.equal(root.dataset.dirty, 'false')

    const putsAfterApply = puts.length
    host.querySelector<HTMLButtonElement>('.auto-model')!.click()
    await flushVue()
    assert.equal(form.model, 'model-b')
    assert.equal(root.dataset.dirty, 'false',
      'automatic old-id to canonical-id reconciliation is comparison-equivalent')
    assert.equal(puts.length, putsAfterApply, 'automatic reconciliation never autosaves the preset')

    host.querySelector<HTMLButtonElement>('.episode-edit')!.click()
    await flushVue()
    assert.equal(root.dataset.dirty, 'false', 'episode-only input is outside reusable dirty truth')

    host.querySelector<HTMLButtonElement>('.user-model')!.click()
    await flushVue()
    assert.equal(root.dataset.dirty, 'true', 'a deliberate different model is a reusable edit')
    assert.equal(puts.length, putsAfterApply, 'a deliberate edit still waits for explicit Save')
    assert.equal(configStore.mounted.scene_plan_presets[1].data.model, 'legacy-model-b')
  } finally {
    app.unmount()
    host.remove()
  }
})

test('sparse retained presets compare against actual post-Apply page semantics without render-time throws', async () => {
  configStore.sparse = {
    scene_plan_presets: [{
      id: 'legacy-sparse', name: 'Retained sparse production preset',
      data: { model: 'legacy-model', opening_mode: 'remembered', style_prompt: 'obsolete' },
    }],
    'scene_plan_last_preset_scene-plan': 'legacy-sparse',
  }
  const loading = ref(true)
  const form = reactive({
    model: '', prompt_pack_size: 'auto', prompt_max_tokens: 'auto', reusable_guidance: '',
  })
  const presets = usePresets({
    slug: 'sparse', configKey: 'scene_plan', presetType: 'scene-plan', autoApplyOnLoad: false,
    snapshot: () => {
      if (loading.value) throw new Error('save validation is unavailable while the timing panel loads')
      return { ...form }
    },
    comparisonSnapshot: () => loading.value ? null : ({ ...form }),
    apply: (data: Record<string, any>) => {
      const clean = { ...data }
      delete clean.opening_mode
      delete clean.style_prompt
      Object.assign(form, clean)
    },
    normalizeForComparison: (data: Record<string, any>) => ({
      ...data,
      model: data.model === 'legacy-model' ? 'current-model' : data.model,
    }),
  } as any)
  await presets.load()
  assert.doesNotThrow(() => presets.isDirty.value)
  assert.equal(presets.isDirty.value, true, 'loading is recoverable readiness, never a render exception')
  loading.value = false
  presets.applyActive()
  assert.equal(form.prompt_pack_size, 'auto', 'missing old fields retain current page defaults')
  assert.equal(presets.isDirty.value, false, 'explicit Apply records normalized actual page meaning')
  form.model = 'current-model'
  assert.equal(presets.isDirty.value, false, 'automatic catalogue aliases remain equivalent')
  form.reusable_guidance = 'a real reusable edit'
  assert.equal(presets.isDirty.value, true)
})

test('actual Scene Plan Apply resets omitted reusable fields to admission-equivalent defaults', () => {
  const page = scenePlanPresetFormHarness()
  page.applyPromptPreset({
    model: 'model-a', use_research: false,
    prompt_pack_size: 48, prompt_max_tokens: 12_000,
    intended_image_model: 'image-a', prompt_char_cap: 1800,
    creative_direction: {
      profile: 'custom', intensity: 4, strategies: ['symbolic'],
      recurring_motifs: 'A motif', avoid_cliches: 'A cliche', custom_direction: 'A direction',
    },
    reusable_guidance: 'A reusable direction', avoid_legible_text: false,
  })
  page.applyPromptPreset({ model: 'model-b' })

  assert.deepEqual(page.form.value, {
    model: 'model-b', use_research: true,
    prompt_pack_size: 'auto', prompt_max_tokens: 'auto',
    intended_image_model: '', prompt_char_cap: 'none',
    avoid_legible_text: true,
    creative_profile: 'narrative', creative_intensity: 2,
    creative_strategies: ['literal-narrative', 'editorial-metaphor', 'symbolic', 'poetic-environment'],
    creative_motifs: '', creative_avoid_cliches: '', creative_custom_direction: '',
    custom_instructions: 'Current episode only', reusable_guidance: '',
  }, 'sparse B means backend defaults/current project default, never leftover reusable values from A')
})

test('mounted Overwrite retires old applied data while pending and installs only its verified owned snapshot', async () => {
  configStore.saveRace = {
    scene_plan_presets: [
      { id: 'preset-a', name: 'A', type: 'scene-plan', data: { model: 'model-a', reusable_guidance: 'old A' } },
      { id: 'preset-b', name: 'B', type: 'scene-plan', data: { model: 'model-b', reusable_guidance: 'B' } },
    ],
    'scene_plan_last_preset_scene-plan': 'preset-a',
  }
  const form = reactive({ model: '', reusable_guidance: '' })
  let presets: any
  const ready = ref(false)
  const Harness = defineComponent({
    setup() {
      presets = usePresets({
        slug: 'saveRace', configKey: 'scene_plan', presetType: 'scene-plan',
        snapshot: () => ({ ...form }),
        apply: data => Object.assign(form, data),
      })
      onMounted(async () => {
        await presets.load()
        ready.value = true
      })
      return () => h('output', {
        'data-ready': String(ready.value),
        'data-dirty': String(presets?.isDirty.value ?? false),
      })
    },
  })
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(Harness)
  app.mount(host)
  await flushVue()
  assert.equal((host.firstElementChild as HTMLElement).dataset.ready, 'true')
  assert.equal(presets.isDirty.value, false)

  form.reusable_guidance = 'captured for Save'
  const gate = deferred<void>()
  putBarrier = gate.promise
  const saving = presets.overwrite()
  while (!puts.length) await Promise.resolve()

  form.reusable_guidance = 'old A'
  await nextTick()
  const dirtyWhilePending = presets.isDirty.value
  const selectingB = presets.setActive('preset-b')
  const selectingA = presets.setActive('preset-a')
  const dirtyAfterSelectionReturn = presets.isDirty.value
  gate.resolve()
  await Promise.all([saving, selectingB, selectingA])
  putBarrier = null

  assert.equal(configStore.saveRace.scene_plan_presets[0].data.reusable_guidance, 'captured for Save',
    'the PUT persists the snapshot captured before its await')
  assert.equal(presets.activeId.value, 'preset-a')
  const dirtyAfterCompletion = presets.isDirty.value
  app.unmount()
  host.remove()

  configStore.saveOwned = {
    scene_plan_presets: [{ id: 'preset-a', name: 'A', type: 'scene-plan', data: { model: 'model-a', reusable_guidance: 'old A' } }],
    'scene_plan_last_preset_scene-plan': 'preset-a',
  }
  const ownedForm = reactive({ model: '', reusable_guidance: '' })
  let owned: any
  const ownedReady = ref(false)
  const OwnedHarness = defineComponent({
    setup() {
      owned = usePresets({
        slug: 'saveOwned', configKey: 'scene_plan', presetType: 'scene-plan',
        snapshot: () => ({ ...ownedForm }),
        apply: data => Object.assign(ownedForm, data),
      })
      onMounted(async () => { await owned.load(); ownedReady.value = true })
      return () => h('output', { 'data-ready': String(ownedReady.value) })
    },
  })
  const ownedHost = document.body.appendChild(document.createElement('div'))
  const ownedApp = createApp(OwnedHarness)
  ownedApp.mount(ownedHost)
  await flushVue()
  ownedForm.reusable_guidance = 'verified Y'
  const ownedGate = deferred<void>()
  putBarrier = ownedGate.promise
  const ownedSave = owned.overwrite()
  while (puts.length < 4) await Promise.resolve()
  const ownedDirtyWhilePending = owned.isDirty.value
  ownedGate.resolve()
  await ownedSave
  putBarrier = null
  const ownedDirtyAfterCompletion = owned.isDirty.value
  ownedApp.unmount()
  ownedHost.remove()

  assert.equal(dirtyWhilePending, true,
    'the old X baseline stops authorizing generation as soon as Save captures Y')
  assert.equal(dirtyAfterSelectionReturn, true,
    'A→B→A while Save is pending cannot revive A’s old X baseline')
  assert.equal(dirtyAfterCompletion, true,
    'late Save completion cannot leave X authoritative after A was persisted as Y')
  assert.equal(ownedDirtyWhilePending, true, 'Save pending remains blocked until persistence verifies Y')
  assert.equal(ownedDirtyAfterCompletion, false,
    'the same selection becomes clean only after the captured Y payload is verified')
})

test('actual Scene Plan submission handler retries the detached DTO and fences late A→B→A responses', async () => {
  let calls = 0
  const page = scenePlanSubmissionHarness(async () => {
    calls += 1
    if (calls === 1) throw new Error('socket closed after submit')
    return { job_id: `job-${calls}` }
  })
  const capture = {
    targetSlug: 'channel-a', episodeId: 'EP-A', operationId: '83010000-0000-4000-8000-000000000001', stage: 'visual',
    body: { stage: 'visual', preset_id: 'retained-preset', operation_id: '83010000-0000-4000-8000-000000000001' },
  }
  await page.submitScenePlanSubmission(capture)
  assert.equal(page.actions.length, 1)
  const sent = structuredClone(page.posts[0])
  page.actions[0]!()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(page.posts[1], sent, 'Retry posts the captured target and body rather than current form or preset state')
  assert.equal(page.pendingScenePlanSubmission.value, null)

  const definite = scenePlanSubmissionHarness(async () => {
    throw { statusCode: 409, data: { detail: 'operation rejected before admission' } }
  })
  await definite.submitScenePlanSubmission(capture)
  assert.equal(definite.pendingScenePlanSubmission.value, null)
  assert.equal(definite.actions.length, 0, 'a trusted initial 409 is a rejection, not an unknown accepted request')
  assert.deepEqual(definite.completed, [capture.operationId])

  let uncertainCalls = 0
  const uncertain = scenePlanSubmissionHarness(async () => {
    uncertainCalls += 1
    if (uncertainCalls === 1) throw new Error('lost first response')
    if (uncertainCalls === 2) throw { statusCode: 500, data: { detail: 'server restarted while looking up receipt' } }
    return { job_id: 'adopted-on-third-try' }
  })
  await uncertain.submitScenePlanSubmission(capture)
  uncertain.actions[0]!()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(uncertain.actions.length, 2, 'a JSON 500 after a lost response does not prove the accepted operation absent')
  uncertain.actions[1]!()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(uncertain.posts.map(item => item.body), [capture.body, capture.body, capture.body])
  assert.equal(uncertain.pendingScenePlanSubmission.value, null)

  let resolveOld!: (value: any) => void
  const old = new Promise(resolve => { resolveOld = resolve })
  const fenced = scenePlanSubmissionHarness(async () => old)
  const late = fenced.submitScenePlanSubmission(capture)
  fenced.switchEpisode('EP-B')
  fenced.switchEpisode('EP-A')
  resolveOld({ job_id: 'late-old-job' })
  await late
  assert.deepEqual(fenced.completed, [], 'a late response cannot complete an action after A→B→A ownership changed')
  assert.deepEqual(fenced.notices, [])
})

test('the common action bar names dirty preset state and blocks preset-backed Generate', () => {
  assert.match(topActionBarSource, /isDirty/,
    'TopActionBar consumes the composable truth instead of describing any selected pointer as applied')
  const generateButton = topActionBarSource.slice(
    topActionBarSource.indexOf('class="btn btn-primary btn-primary-cta"'),
    topActionBarSource.indexOf('</button>', topActionBarSource.indexOf('class="btn btn-primary btn-primary-cta"')),
  )
  assert.match(generateButton, /presetStateBlocksGeneration/,
    'Generate is unavailable until reusable edits are saved or the selected preset is applied')
  const sentence = topActionBarSource.slice(
    topActionBarSource.indexOf('const generateActionSentence'),
    topActionBarSource.indexOf('const generateStatusSentence'),
  )
  assert.match(sentence, /isDirty/,
    'the popover cannot say “using preset” while the selected preset and form differ')
  assert.match(topActionBarSource, /requireAppliedPreset/,
    'dirty blocking is an explicit page opt-in instead of silently changing all preset-backed pages')
  assert.match(scenePlanPageSource, /:require-applied-preset="true"/,
    'Scene Plan is the first bounded caller to opt into preset-authoritative generation')
})

test('all Scene Plan hydration uses the sanitized apply boundary for episode-only fields', async () => {
  configStore.hydration = {
    scene_plan_presets: [{
      id: 'legacy-scene', name: 'Legacy scene', type: 'scene-plan', data: {
        model: 'approved-model',
        reusable_guidance: 'Reusable direction',
        custom_instructions: 'FOREIGN EPISODE GUIDANCE',
      },
    }],
    'scene_plan_last_preset_scene-plan': 'legacy-scene',
  }
  const form = reactive({
    model: '', reusable_guidance: '', custom_instructions: 'Current episode direction',
  })
  const presets = usePresets({
    slug: 'hydration', configKey: 'scene_plan', presetType: 'scene-plan',
    excludeKeys: ['episode_id', 'episodeId', 'episode', 'title', 'custom_instructions'],
    snapshot: () => ({ ...form }),
    apply: data => Object.assign(form, data),
  })
  await presets.load()
  assert.equal(form.model, 'approved-model')
  assert.equal(form.reusable_guidance, 'Reusable direction')
  assert.equal(form.custom_instructions, 'Current episode direction',
    'the existing composable already strips the legacy episode field')

  assert.doesNotMatch(scenePlanPageSource, /applyPromptPreset\(preset\.data\)/,
    'mount hydration must not bypass usePresets.cleanApply with the raw stored body')
  const loadCall = scenePlanPageSource.indexOf('void planPresets.load')
  const mountedLoad = scenePlanPageSource.slice(
    scenePlanPageSource.lastIndexOf('onMounted(() => {', loadCall),
    scenePlanPageSource.indexOf('// The character ceiling', loadCall),
  )
  assert.match(mountedLoad, /planPresets\.activeData\.value/,
    'mount hydration consumes the composable\'s sanitized selected data')
})

test('manual Scene Plan sends exact preset identity while episode input stays outside the saved preset', () => {
  const timeline = scenePlanPageSource.slice(
    scenePlanPageSource.indexOf('async function planScenes'),
    scenePlanPageSource.indexOf('async function runPromptStage'),
  )
  const prompts = scenePlanPageSource.slice(
    scenePlanPageSource.indexOf("async function runPromptStage(stage: 'visual' | 'motion'"),
    scenePlanPageSource.indexOf('async function pollUntilPlanLanded'),
  )
  assert.match(timeline, /const presetId = planPresets\.activeId\.value[\s\S]*preset_id:\s*presetId/,
    'timeline admission names the selected reusable settings record')
  assert.match(prompts, /const presetId = planPresets\.activeId\.value[\s\S]*preset_id:\s*presetId/,
    'visual/motion admission names the same selected reusable settings record')

  const presetSetup = scenePlanPageSource.slice(
    scenePlanPageSource.indexOf('const planPresets = usePresets'),
    scenePlanPageSource.indexOf('watch([slug, episodeId]'),
  )
  assert.match(presetSetup, /excludeKeys:\s*\[\.\.\.DEFAULT_EXCLUDE_KEYS,\s*'custom_instructions'\]/)
  assert.match(prompts, /custom_instructions:\s*form\.value\.custom_instructions/,
    'only the current episode guidance travels as request input; the server reads reusable guidance from the preset')
})

test('mounted TopActionBar blocks a dirty opted-in preset and names the required action', async () => {
  const TopActionBar = await loadTopActionBar()
  const dirty = ref(true)
  const presets = {
    presets: ref([{ id: 'scene-a', name: 'Approved Scene Plan', data: { model: 'model-a' } }]),
    activeId: ref('scene-a'),
    isDirty: dirty,
    setActive: async () => undefined,
    applyActive: () => undefined,
    overwrite: async () => undefined,
    saveAs: async () => undefined,
    rename: async () => undefined,
    remove: async () => undefined,
  }
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(TopActionBar, {
    projectSlug: 'mounted-action-bar',
    episodeMode: 'none',
    presets,
    requireAppliedPreset: true,
    generateLabel: 'Generate',
  })
  app.component('NuxtLink', defineComponent({
    props: { to: { type: [String, Object], required: true } },
    setup(_props, { slots }) { return () => h('a', slots.default?.()) },
  }))
  app.mount(host)
  try {
    await nextTick()
    const button = host.querySelector<HTMLButtonElement>('.btn-primary-cta')!
    assert.equal(button.disabled, true)
    assert.match(host.textContent || '', /save them or apply the selected preset/i)
    dirty.value = false
    await nextTick()
    assert.equal(button.disabled, false)
  } finally {
    app.unmount()
    host.remove()
  }
})

test('Pipeline sends its exact visible selections for browser clients while API-only omission remains a server contract', () => {
  const preflight = pipelinePageSource.slice(
    pipelinePageSource.indexOf('async function openConfirm'),
    pipelinePageSource.indexOf('async function submit'),
  )
  const submit = pipelinePageSource.slice(
    pipelinePageSource.indexOf('async function submit'),
    pipelinePageSource.indexOf('</script>', pipelinePageSource.indexOf('async function submit')),
  )
  assert.match(preflight, /preset_ids\s*:/,
    'preflight binds the exact per-step selections shown in the browser')
  assert.match(submit, /preset_ids\s*:/,
    'run-batch repeats the same exact map instead of asking the server to guess again')

  assert.doesNotMatch(
    pipelinePageSource.slice(
      pipelinePageSource.indexOf('function activePresetIdFor'),
      pipelinePageSource.indexOf('function presetsForStep'),
    ),
    /Type-based auto-resolve|for \(let i = list\.length - 1/,
    'the browser does not turn a stale/missing pointer into the newest saved neighbour',
  )
})
