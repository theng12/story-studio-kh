import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { compileScript, parse } from '@vue/compiler-sfc'
import { effectScope, nextTick, ref } from 'vue'
import { transform } from 'esbuild'

const pagePath = new URL('../pages/projects/[slug]/images.vue', import.meta.url)
const source = readFileSync(pagePath, 'utf8')
const snapshot = (value: unknown) => JSON.parse(JSON.stringify(value))

function model(ratios: string[], defaultRatio = '') {
  return {
    id: 'task14-image', display_name: 'Live image model', available: true,
    aspect_ratios: ratios, default_aspect_ratio: defaultRatio,
    output_options: [], supports_seed: false, max_prompt_characters: 2400,
  }
}

async function setupWith(row: ReturnType<typeof model>, confirm?: () => Promise<boolean>) {
  const models = ref([row])
  const sent: any[] = []
  const confirmations: any[] = []
  const errors: string[] = []
  const fixture = {
    models, errors,
    api: {
      get: async () => ({}),
      post: async (url: string, body: unknown) => {
        if (url.endsWith('/generate/images')) sent.push(snapshot(body))
        return {}
      },
    },
    confirmGeneration: async (_slug: string, _kind: string, params: unknown) => {
      confirmations.push(snapshot(params))
      return confirm ? await confirm() : true
    },
  }
  const { descriptor } = parse(source, { filename: pagePath.pathname })
  const script = compileScript(descriptor, { id: 'task14-image-ratios' })
  const vueUrl = import.meta.resolve('vue')
  const support = `
    import { computed, defineComponent as _defineComponent, reactive, ref, watch } from ${JSON.stringify(vueUrl)}
    import { findOutputOption } from ${JSON.stringify(new URL('../utils/genstudio-output-options.ts', import.meta.url).href)}
    import { CREDIT_BASIS_LABEL, describeImageUnitCost } from ${JSON.stringify(new URL('../utils/genstudio-credit-cost.ts', import.meta.url).href)}
    import { customerSafeJobText, jobRequestIds } from ${JSON.stringify(new URL('../utils/job-presentation.ts', import.meta.url).href)}
    const fixture = globalThis.__task14ImageFixture
    const definePageMeta = () => undefined
    const useRoute = () => ({ params: { slug: 'task14-project' }, query: {} })
    const useRouter = () => ({ replace: () => undefined })
    const useApi = () => fixture.api
    const useFreshGenerationAction = () => ({ begin: () => 'task14-operation', complete: () => undefined })
    const useProject = () => ({ config: ref({ image_models: {} }) })
    const useGenStudioImageModels = () => ({ models: fixture.models, refresh: async () => undefined })
    const useToast = () => ({ success: () => undefined, error: message => fixture.errors.push(message) })
    const useGenerating = () => ({ imageGenerating: ref(false), thumbImageGenerating: ref(false) })
    const useConfirmation = () => ({ confirmGeneration: fixture.confirmGeneration })
    const useJobs = () => ({ isJobActiveFor: () => false, jobs: ref([]) })
    const useAppTitle = () => undefined
    const useRememberedForm = () => undefined
    const useEpisodeStatus = () => ({ selectedEpisode: ref(null) })
    const usePresets = options => ({ load: async () => undefined, apply: options.apply })
    // Exercise selection/watch/admission directly; skip unrelated mount-time
    // format/preset network hydration. All production Vue watchers stay real.
    const onMounted = () => undefined
  `
  const stripped = script.content.replace(/^import[^\n]+\n/gm, '')
  const output = await transform(`${support}\n${stripped}`, { loader: 'ts', format: 'esm' })
  const directory = await mkdtemp(join(tmpdir(), 'task14-image-ratios-'))
  const modulePath = join(directory, 'images-setup.mjs')
  const scope = effectScope()
  try {
    await writeFile(modulePath, output.code)
    ;(globalThis as any).__task14ImageFixture = fixture
    const Component = (await import(pathToFileURL(modulePath).href)).default
    const state: any = scope.run(() => Component.setup({}, { expose: () => undefined }))
    return {
      state, models, sent, confirmations, errors,
      dispose: async () => { scope.stop(); await rm(directory, { recursive: true, force: true }) },
    }
  } catch (error) {
    scope.stop()
    await rm(directory, { recursive: true, force: true })
    throw error
  } finally {
    delete (globalThis as any).__task14ImageFixture
  }
}

test('Images initializes from the published default and retains a still-published customer choice', async () => {
  const fixture = await setupWith(model(['4:3', '16:9', '1:1'], '1:1'))
  try {
    const { state, models, sent } = fixture
    state.form.thumbnail.model = 'task14-image'
    await nextTick()
    assert.equal(state.form.thumbnail.aspect_ratio, '1:1', 'the synthetic 16:9 must not outrank the published default')
    await state.submit()
    assert.equal(sent.at(-1)?.aspect_ratio, '1:1')

    state.form.thumbnail.aspect_ratio = '16:9'
    models.value = [model(['4:3', '16:9', '1:1'], '4:3')]
    await nextTick()
    assert.equal(state.form.thumbnail.aspect_ratio, '16:9', 'retain a still-published explicit choice')

  } finally { await fixture.dispose() }
})

test('Images permits a published visible fallback without a default or an extra customer click', async () => {
  const fixture = await setupWith(model(['3:4', '1:1']))
  try {
    const { state, sent } = fixture
    state.form.thumbnail.model = 'task14-image'
    await nextTick()
    assert.ok(['3:4', '1:1'].includes(state.form.thumbnail.aspect_ratio))
    assert.ok(state.aspectRatios.value.some((option: any) => option.value === state.form.thumbnail.aspect_ratio))
    await state.submit()
    assert.ok(['3:4', '1:1'].includes(sent.at(-1)?.aspect_ratio))
  } finally { await fixture.dispose() }
})

for (const mode of ['thumbs', 'scenes'] as const) {
  test(`Images ${mode} updates its selected ratio when the same catalogue row changes`, async () => {
    const fixture = await setupWith(model(['4:3'], '4:3'))
    try {
      const { state, models, sent } = fixture
      state.form.mode = mode
      state.activeForm.value.model = 'task14-image'
      await nextTick()
      state.activeForm.value.aspect_ratio = '4:3'
      await state.submit()
      assert.equal(sent.at(-1)?.aspect_ratio, '4:3', 'valid generation reaches the transport')

      models.value[0].aspect_ratios = ['1:1']
      models.value[0].default_aspect_ratio = '1:1'
      await nextTick()
      assert.equal(state.activeForm.value.aspect_ratio, '1:1')
      assert.deepEqual(state.aspectRatios.value.map((option: any) => option.value), ['1:1'])
      await state.submit()
      assert.equal(sent.at(-1)?.aspect_ratio, '1:1')
    } finally { await fixture.dispose() }
  })

  test(`Images ${mode} never forwards a stale ratio before a catalogue watcher flushes`, async () => {
    const fixture = await setupWith(model(['4:3'], '4:3'))
    try {
      const { state, models, sent, confirmations } = fixture
      state.form.mode = mode
      state.activeForm.value.model = 'task14-image'
      await nextTick()
      state.activeForm.value.aspect_ratio = '4:3'
      models.value = [model(['9:16'], '9:16')]
      // No nextTick: admission must check the catalogue at the moment of submit.
      await state.submit()
      for (const payload of [...confirmations, ...sent]) {
        assert.equal(payload.aspect_ratio, '9:16', 'only a currently published ratio can reach confirmation or generation')
      }
      await nextTick()
      await state.submit()
      assert.equal(sent.at(-1)?.aspect_ratio, '9:16', 'a usable published replacement must remain generatable')
    } finally { await fixture.dispose() }
  })

  test(`Images ${mode} clears an empty live ratio list and blocks stale generation`, async () => {
    const fixture = await setupWith(model(['4:3'], '4:3'))
    try {
      const { state, models, sent, confirmations } = fixture
      state.form.mode = mode
      state.activeForm.value.model = 'task14-image'
      await nextTick()
      state.activeForm.value.aspect_ratio = '4:3'
      models.value[0].aspect_ratios = []
      models.value[0].default_aspect_ratio = ''
      await state.submit()
      assert.equal(sent.length, 0, 'no generation may carry the retired ratio while the watcher is pending')
      assert.equal(confirmations.length, 0, 'an unsupported ratio must not reach the charge confirmation')
      await nextTick()
      assert.equal(state.activeForm.value.aspect_ratio, '')
      assert.deepEqual(state.aspectRatios.value, [], 'the model must not acquire invented compatibility options')
      await state.submit()
      assert.equal(sent.length, 0)
    } finally { await fixture.dispose() }
  })
}

test('Images stops for reconfirmation when the catalogue or selected model changes during confirmation', async () => {
  for (const change of ['ratios', 'model'] as const) {
    let accept!: (value: boolean) => void
    const confirmation = new Promise<boolean>(resolve => { accept = resolve })
    const fixture = await setupWith(model(['4:3'], '4:3'), () => confirmation)
    try {
      const { state, models, sent, confirmations, errors } = fixture
      state.form.thumbnail.model = 'task14-image'
      await nextTick()
      state.form.thumbnail.aspect_ratio = '4:3'
      const pending = state.submit()
      assert.equal(confirmations[0]?.model, 'task14-image')
      assert.equal(confirmations[0]?.aspect_ratio, '4:3')
      if (change === 'ratios') {
        models.value = [model(['9:16'], '9:16')]
      } else {
        models.value.push({ ...model(['4:3'], '4:3'), id: 'another-image' })
        state.form.thumbnail.model = 'another-image'
      }
      await nextTick()
      accept(true)
      await pending
      assert.equal(sent.length, 0, 'neither obsolete parameters nor an unconfirmed replacement may be posted')
      assert.ok(errors.some(message => /changed/i.test(message) && /again|retry|confirm/i.test(message)), 'explain that the choice changed and needs confirmation again')
    } finally { accept(true); await fixture.dispose() }
  }
})
