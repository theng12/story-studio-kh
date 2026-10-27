import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { compileScript, parse } from '@vue/compiler-sfc'
import { nextTick, ref } from 'vue'
import { transform } from 'esbuild'

const pagePath = new URL('../pages/projects/[slug]/motion-review.vue', import.meta.url)
const source = readFileSync(pagePath, 'utf8')
// The page uses Nuxt's auto-imported list; this harness compiles the SFC outside Nuxt, so it is
// injected from the real module rather than restated here.
const { DEFAULT_EXCLUDE_KEYS } = await import('../composables/usePresets.js')
const { DEFAULT_MOTION_SCOPE } = await import('../../electron/server/contracts/motion-scope.js')

async function setupWith(models: ReturnType<typeof ref<any[]>>) {
  const { descriptor } = parse(source, { filename: pagePath.pathname })
  const script = compileScript(descriptor, { id: 'task13-motion-models' })
  const vueUrl = await import.meta.resolve('vue')
  const support = `
    import { computed, defineComponent as _defineComponent, onBeforeUnmount, onMounted, ref, watch } from ${JSON.stringify(vueUrl)}
    // Mirrors the real policy: empty takes the first usable row, a name must match.
    const selectLiveImageToVideoModel = (id, rows) => (id ? rows.find(row => row.id === id) || null : rows[0] || null)
    const genStudioModelLockReason = () => ''
    const describeVideoModelRate = () => ''
    const formatCredits = value => String(value)
    const hasPriceTruth = () => false
    const formatUsd = value => '$' + Number(value).toFixed(2)
    const variantsForVideoOperation = (rows, operation) => Array.isArray(rows) ? rows.filter(row => row.operation === operation) : []
    const definePageMeta = () => undefined
    const useAppTitle = () => undefined
    const useRoute = () => ({ params: { slug: 'task13-project' }, query: { episode_id: 'EP0001' } })
    const useApi = () => ({ get: async () => ({ scenes: [], stats: null }), post: async () => ({}), put: async () => ({}) })
    const useToast = () => ({ success: () => undefined, error: () => undefined, info: () => undefined })
    const useConfirm = () => ({ ask: async () => true })
    const useJobs = () => ({ isJobActiveFor: () => false, jobs: { value: [] } })
    const useGenStudioMediaModels = () => ({ videoModels: globalThis.__task13VideoModels, refresh: async () => undefined })
    const emptyDefaultModels = () => ({ writing: null, image: null, video: null, audio: null, transcription: null, music: null })
    const normalizeDefaultModels = () => emptyDefaultModels()
    const resolveEffectiveModel = (_family, selected) => ({ model: selected || '', defaultModel: '', goneNotice: '' })
    const usePresets = options => ({ apply: options.apply })
    const DEFAULT_EXCLUDE_KEYS = ${JSON.stringify(DEFAULT_EXCLUDE_KEYS)}
    const DEFAULT_MOTION_SCOPE = ${JSON.stringify(DEFAULT_MOTION_SCOPE)}
    const HOLD_MAX_SECONDS = 60
    const holdDrafts = () => ({ fixed: '2.5', min: '2', max: '3' })
    const holdFromDraft = () => ({ ok: true, hold: null })
    const holdLabel = () => ''
    const REVEAL_TYPES = ['line', 'buildup', 'swipes', 'patches', 'bloom']
    const REVEAL_LABELS = { line: 'Line', buildup: 'Build-up', swipes: 'Swipes', patches: 'Patches', bloom: 'Bloom' }
    const revealFromDraft = () => ({ ok: true, reveal: null })
    const revealLabel = () => ''
    const revealMixFor = () => []
    const revealChoiceOf = () => ''
    const revealForPreset = () => null
    const applyRevealPreset = live => live
  `
  const stripped = script.content.replace(/^import[\s\S]*?from ['"][^'"]+['"]\n/gm, '')
  const code = `${support}\n${stripped.replace('export default', 'const __sfc__ =')}\nexport default __sfc__`
  const out = await transform(code, { loader: 'ts', format: 'esm' })
  ;(globalThis as any).__task13VideoModels = models
  const Component = (await import(`data:text/javascript;base64,${Buffer.from(out.code.replaceAll('"vue"', JSON.stringify(vueUrl))).toString('base64')}`)).default
  return Component.setup({}, { expose: () => undefined })
}

test('Motion Review submits only a ratio selected from the current model catalogue', async () => {
  const models = ref([{
    id: 'portrait-video', display_name: 'Portrait', available: true, modes: ['image-to-video'], aspect_ratios: ['9:16'],
    variants: [{ operation: 'image-to-video', resolution: '720p', duration_seconds: 5, credits_per_video: 1, minimum_credits: 1, price_version: 'fixture' }],
  }])
  const state: any = await setupWith(models)

  assert.equal(state.selectedAspectRatio.value, '')
  assert.equal(state.generationPayload(), null, 'a catalogue order is not an unpublished default')

  state.selectedAspectRatio.value = '9:16'
  assert.equal(state.generationPayload().aspect_ratio, '9:16')

  state.motionPresets.apply({
    model: 'genstudio-video:portrait-video', aspect_ratio: '2:1',
    resolution: '720p', duration_seconds: 5, duration_mode: 'manual',
  })
  assert.equal(state.selectedAspectRatio.value, '', 'a same-model preset cannot retain an unpublished ratio')
  assert.equal(state.generationPayload(), null)

  state.selectedAspectRatio.value = '9:16'
  models.value[0].aspect_ratios = ['1:1']
  assert.equal(state.generationPayload(), null, 'membership blocks an invalid ratio before the watcher flushes')
  await nextTick()
  assert.equal(state.selectedAspectRatio.value, '', 'an aspect-only catalogue mutation clears the stale ratio')
  state.selectedAspectRatio.value = '1:1'
  assert.equal(state.generationPayload().aspect_ratio, '1:1', 'a published square ratio is submitted exactly')

  models.value = [{
    ...models.value[0], id: 'square-video', aspect_ratios: ['1:1'],
  }]
  await nextTick()
  assert.equal(state.selectedAspectRatio.value, '')
  assert.equal(state.generationPayload(), null, 'a ratio invalidated by a model switch requires a new choice')
})

test('a saved video model the live catalogue does not have is unselected, with one honest sentence', async () => {
  const models = ref([{
    id: 'portrait-video', display_name: 'Portrait', available: true, modes: ['image-to-video'], aspect_ratios: ['9:16'],
    variants: [{ operation: 'image-to-video', resolution: '720p', duration_seconds: 5, credits_per_video: 1, minimum_credits: 1, price_version: 'fixture' }],
  }])
  const state: any = await setupWith(models)

  state.motionPresets.apply({ model: 'genstudio-video:gone-model', aspect_ratio: '9:16', resolution: '720p', duration_seconds: 5 })

  assert.equal(state.videoModel.value, '', 'a model the catalogue does not publish is not left in the form')
  assert.equal(state.videoModelNotice.value, 'This model is no longer available — choose another.')
  assert.equal(state.generationPayload(), null, 'nothing can be queued against the dropped model')
})
