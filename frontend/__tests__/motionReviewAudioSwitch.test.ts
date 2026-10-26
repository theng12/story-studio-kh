/**
 * The published `audio` switch on Motion Review — rendered, preset, and sent.
 *
 * A local Studio Hub video lane can publish `audio` (default on, with the lane's own note);
 * every cloud video lane publishes nothing. This page must therefore render the
 * switch from the model's own published list — never from a family name, never
 * from `generates_audio` — and send the operator's choice only when they made
 * one, so "the lane's default" and "asked for silence" stay two different
 * requests all the way to the idempotency key.
 *
 * Mounted against the real page with stubbed Nuxt components; zero network.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, test } from 'node:test'
import { createApp, defineComponent, h, nextTick, reactive, ref, type Component } from 'vue'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { transform } from 'esbuild'

const pagePath = fileURLToPath(new URL('../pages/projects/[slug]/motion-review.vue', import.meta.url))
const pageSource = readFileSync(pagePath, 'utf8')
// The page uses Nuxt's auto-imported list; this harness compiles the SFC outside Nuxt, so it is
// injected from the real module rather than restated here.
const { DEFAULT_EXCLUDE_KEYS } = await import('../composables/usePresets.js')

async function loadPage(): Promise<Component> {
  const { descriptor } = parse(pageSource, { filename: pagePath })
  const script = compileScript(descriptor, { id: 'motion-review-switch' })
  const template = compileTemplate({
    source: descriptor.template!.content,
    filename: pagePath,
    id: 'motion-review-switch',
    compilerOptions: { bindingMetadata: script.bindings },
  })
  const support = `
    import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
    const definePageMeta = () => {}
    const useAppTitle = () => {}
    const useRoute = () => globalThis.__mrRoute
    const useProject = () => ({ config: {} })
    const useApi = () => globalThis.__mrApi
    const useToast = () => ({ success: () => {}, error: error => { throw error }, info: () => {} })
    const useConfirm = () => ({ ask: async () => true })
    const useJobs = () => ({ isJobActiveFor: () => false, jobs: { value: [] } })
    const useGenStudioMediaModels = () => ({ videoModels: globalThis.__mrModels, loaded: ref(true), refresh: async () => {} })
    const usePresets = options => { globalThis.__mrPreset = options; return { load: async () => undefined } }
    const DEFAULT_EXCLUDE_KEYS = ${JSON.stringify(DEFAULT_EXCLUDE_KEYS)}
  `
  const code = `${support}\n${script.content.replace('export default', 'const __sfc__ =')}\n${template.code}\n__sfc__.render = render\nexport default __sfc__`
  const out = await transform(code, { loader: 'ts', format: 'esm' })
  const vueUrl = await import.meta.resolve('vue')
  const componentUrl = `data:text/javascript;base64,${Buffer.from(
    out.code
      .replaceAll('"vue"', JSON.stringify(vueUrl))
      .replace(/"~\/utils\/([\w-]+)"/g, (_match, name: string) => (
        JSON.stringify(new URL(`../utils/${name}.ts`, import.meta.url).href)
      )),
  ).toString('base64')}`
  return (await import(componentUrl)).default
}

const SurfaceStub = defineComponent({ setup: (_, { slots }) => () => h('section', slots.default?.()) })
const ModelMenuStub = defineComponent({
  props: { modelValue: String, options: { type: Array, default: () => [] } },
  emits: ['update:modelValue'],
  setup(props, { emit }) {
    return () => h('select', {
      'aria-label': 'Image-to-video model options',
      value: props.modelValue,
      onChange: (event: Event) => emit('update:modelValue', (event.target as HTMLSelectElement).value),
    }, (props.options as any[]).map(option => h('option', { value: option.id, disabled: option.disabled }, option.label)))
  },
})
const TopActionBarStub = defineComponent({
  props: { generateDisabled: Boolean, generateStatus: String },
  emits: ['generate'],
  setup(props, { emit }) {
    return () => h('div', [
      h('button', { disabled: props.generateDisabled, onClick: () => emit('generate') }, 'Generate missing clips'),
      h('p', { class: 'generate-status' }, props.generateStatus),
    ])
  },
})
const NuxtLinkStub = defineComponent({
  props: { to: { type: String, required: true } },
  setup(props, { slots }) {
    return () => h('a', { href: props.to }, slots.default?.())
  },
})

const AUDIO_NOTE = 'the model generates picture and sound together, so this does not change generation time'

function variant(duration = 5, resolution = '720p') {
  return {
    operation: 'image-to-video', duration_seconds: duration, resolution,
    credits_per_video: duration * 10, minimum_credits: duration * 10, price_version: 'published-v1',
  }
}

/** A model as the catalogue publishes it, with or without the lane's switch. */
function model(id: string, controls?: Array<Record<string, unknown>>) {
  return {
    id, display_name: id, available: true, locked: false, modes: ['image-to-video'],
    aspect_ratios: ['16:9'], variants: [variant()], generates_audio: true,
    ...(controls ? { controls } : {}),
  }
}

function scene() {
  return {
    id: 'scene-1', scene_index: 1, start_sec: 0, end_sec: 6.2,
    transcript_segment: 'Narration', motion_prompt: 'Slow push in', approved: true,
    image_filename: 'scene-1.png', clip_exists: false, clip_stale: false,
    motion_choice: 'pending',
  }
}

async function settle(times = 8): Promise<void> {
  for (let index = 0; index < times; index += 1) await nextTick()
}

const mountedApps: Array<() => void> = []
afterEach(() => {
  while (mountedApps.length) mountedApps.pop()!()
  document.body.innerHTML = ''
})

async function mount(models: any[]) {
  const calls: Array<{ path: string; body: any }> = []
  const modelRef = ref(models)
  const fixtureScenes = [scene()]
  ;(globalThis as any).__mrModels = modelRef
  ;(globalThis as any).__mrRoute = reactive({ params: { slug: 'demo' }, query: { episode_id: 'EP0001' } })
  ;(globalThis as any).__mrApi = {
    get: async () => ({
      scenes: fixtureScenes,
      stats: { total_scenes: 1, approved: 1, with_image: 1, with_clip: 0, motion_reviewed: 0, all_motion_reviewed: false },
      motion_scope: { mode: 'all' },
      motion_scene_ids: fixtureScenes.map(scene => scene.id),
      visual_source: 'scene_plan',
    }),
    post: async (path: string, body: any) => { calls.push({ path, body }); return { queued: 1, skipped: 0 } },
    put: async () => ({}),
  }
  const el = document.body.appendChild(document.createElement('div'))
  const app = createApp(await loadPage())
  app.component('WorkspaceHero', SurfaceStub)
  app.component('WorkspaceNotice', SurfaceStub)
  app.component('WorkspaceSection', SurfaceStub)
  app.component('NuxtLink', NuxtLinkStub)
  app.component('ModelMenu', ModelMenuStub)
  app.component('TopActionBar', TopActionBarStub)
  app.mount(el)
  let active = true
  const destroy = () => {
    if (!active) return
    active = false
    app.unmount()
    el.remove()
  }
  mountedApps.push(destroy)
  await settle()
  return {
    el,
    calls,
    models: modelRef,
    text: () => el.textContent || '',
    preset: () => (globalThis as any).__mrPreset,
    destroy,
  }
}

function switchInput(el: HTMLElement, name: string): HTMLInputElement | null {
  return el.querySelector<HTMLInputElement>(`input[type="checkbox"][aria-label^="${name} "]`)
}

describe('Motion Review audio switch', () => {
  test('a model publishing the switch shows it, with the lane\'s own note', async () => {
    const mounted = await mount([model('local-video', [
      { name: 'audio', type: 'boolean', default: true, note: AUDIO_NOTE },
    ])])
    const control = switchInput(mounted.el, 'Audio')
    assert.ok(control, 'the published switch is rendered')
    assert.equal(control.checked, true, 'the lane\'s own default decides the starting position')
    assert.match(mounted.text(), /does not change generation time/,
      'the lane\'s sentence about what the switch does is shown verbatim')
    mounted.destroy()
  })

  test('a model publishing no switch shows none, and still discloses the soundtrack', async () => {
    const mounted = await mount([model('cloud-no-switch')])
    assert.equal(switchInput(mounted.el, 'Audio'), null,
      'a lane that publishes no switch must not be offered one Story Studio made up')
    assert.ok(!/does not change generation time/.test(mounted.text()))
    // The disclosure that DOES apply stays: this model bills for a track the episode will not use.
    assert.match(mounted.text(), /you are charged for it/)
    mounted.destroy()
  })

  test('turning sound off is what travels, and leaving it alone sends nothing', async () => {
    const mounted = await mount([model('local-video', [
      { name: 'audio', type: 'boolean', default: true, note: AUDIO_NOTE },
    ])])
    // The same route the duration suite drives: pick the published ratio, follow narration (which
    // is the mode that builds a batch plan), then press the page's generate action.
    const ratio = mounted.el.querySelector<HTMLSelectElement>('select[aria-label="Aspect ratio"]')!
    ratio.value = '16:9'
    ratio.dispatchEvent(new Event('change', { bubbles: true }))
    mounted.el.querySelector<HTMLInputElement>('input[name="duration-mode"][value="follow_narration"]')!.click()
    await settle()
    const generate = mounted.el.querySelector<HTMLButtonElement>('button')!
    generate.click()
    await settle()
    const untouched = mounted.calls.at(-1)
    assert.ok(untouched, `a request was made (page said: ${mounted.text().slice(0, 200)})`)
    assert.equal('audio' in (untouched!.body || {}), false,
      'an untouched switch must not be sent: the lane\'s own default is the answer')

    const control = switchInput(mounted.el, 'Audio')!
    control.checked = false
    control.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
    assert.match(mounted.text(), /not cheaper and not faster/,
      'the silent state says the run is not cheaper or faster rather than implying a saving')
    generate.click()
    await settle()
    assert.equal(mounted.calls.at(-1)?.body?.audio, false,
      'the OFF half of the switch is the whole point of it and must reach the request')
    mounted.destroy()
  })

  test('the choice is a preset setting, and a preset without switches clears it', async () => {
    const mounted = await mount([model('local-video', [
      { name: 'audio', type: 'boolean', default: true, note: AUDIO_NOTE },
    ])])
    const control = switchInput(mounted.el, 'Audio')!
    control.checked = false
    control.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
    const preset = mounted.preset()
    assert.deepEqual(preset.snapshot().switches, { audio: false },
      'a reusable setting belongs in the preset')

    // Applying a preset that stored no switches must clear the live choice rather than
    // inherit it — a value that survives the preset that did not ask for it is the
    // episode-leak defect wearing a preset key.
    preset.apply({ model: 'genstudio-video:local-video', aspect_ratio: '16:9', switches: { audio: true } })
    await settle()
    assert.equal(switchInput(mounted.el, 'Audio')!.checked, true, 'a stored choice is restored')
    preset.apply({ model: 'genstudio-video:local-video', aspect_ratio: '16:9' })
    await settle()
    assert.equal(switchInput(mounted.el, 'Audio')!.checked, true,
      'with no stored choice the lane\'s published default is what shows')
    mounted.destroy()
  })
})

describe('Motion Review with a saved model the live catalogue does not have', () => {
  const GONE = 'genstudio-video:baa-ai/LTX-2.3-22B-RAM-12GB-MLX'

  test('the saved model is unselected and the one honest sentence is shown', async () => {
    const mounted = await mount([model('cloud-video')])
    mounted.preset().apply({ model: GONE, aspect_ratio: '16:9' })
    await settle()
    assert.equal(mounted.preset().snapshot().model, '', 'the form does not keep a model the catalogue does not publish')
    assert.match(mounted.text(), /This model is no longer available — choose another\./)
    mounted.destroy()
  })

  test('with no video model listed the page stays calm, says so plainly, and cannot generate', async () => {
    const mounted = await mount([])
    mounted.preset().apply({ model: GONE, aspect_ratio: '16:9' })
    await settle()
    assert.equal(mounted.preset().snapshot().model, '', 'a finished empty catalogue does not keep the saved id either')
    assert.match(mounted.text(), /This model is no longer available — choose another\./)
    assert.match(mounted.text(), /No image-to-video model is available right now\. Scenes stay still\./)
    assert.equal(mounted.el.querySelector<HTMLButtonElement>('button')!.disabled, true)
    assert.equal(mounted.calls.length, 0, 'no request was made')
    mounted.destroy()
  })
})
