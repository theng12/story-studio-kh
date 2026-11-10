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
  const script = compileScript(descriptor, { id: 'motion-review-duration' })
  const template = compileTemplate({
    source: descriptor.template!.content,
    filename: pagePath,
    id: 'motion-review-duration',
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
    const useGenStudioMediaModels = () => ({ videoModels: globalThis.__mrModels, refresh: async () => {} })
    const usePresets = options => { globalThis.__mrPreset = options; return { load: async () => undefined } }
    const DEFAULT_EXCLUDE_KEYS = ${JSON.stringify(DEFAULT_EXCLUDE_KEYS)}
  `
  const code = `${support}\n${script.content.replace('export default', 'const __sfc__ =')}\n${template.code}\n__sfc__.render = render\nexport default __sfc__`
  const out = await transform(code, { loader: 'ts', format: 'esm' })
  const vueUrl = await import.meta.resolve('vue')
  const componentUrl = `data:text/javascript;base64,${Buffer.from(
    out.code
      .replaceAll('"vue"', JSON.stringify(vueUrl))
      .replace(/"@shared\/([\w-]+)"/g, (_match, name: string) => (
        JSON.stringify(new URL(`../../electron/server/contracts/${name}.ts`, import.meta.url).href)
      ))
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
    }, (props.options as any[]).map(option => h('option', {
      value: option.id,
      disabled: option.disabled,
    }, option.label)))
  },
})
const TopActionBarStub = defineComponent({
  props: { generateDisabled: Boolean },
  emits: ['generate'],
  setup(props, { emit }) {
    return () => h('button', {
      disabled: props.generateDisabled,
      onClick: () => emit('generate'),
    }, 'Generate missing clips')
  },
})
const NuxtLinkStub = defineComponent({
  props: { to: { type: String, required: true } },
  setup(props, { slots }) {
    return () => h('a', { href: props.to }, slots.default?.())
  },
})

type Variant = {
  operation: 'image-to-video'
  duration_seconds: number
  resolution: string
  credits_per_video: number
  minimum_credits: number
  price_version: string
}

function variant(duration: number, resolution: string, credits = duration * 10): Variant {
  return {
    operation: 'image-to-video', duration_seconds: duration, resolution,
    credits_per_video: credits, minimum_credits: credits, price_version: 'published-v1',
  }
}

function model(id: string, variants: Variant[], available = true) {
  return {
    id, display_name: id, available, locked: false, modes: ['image-to-video'],
    aspect_ratios: ['16:9'], variants, generates_audio: false,
  }
}

function scene(overrides: Record<string, unknown> = {}) {
  return {
    id: 'scene-1', scene_index: 1, start_sec: 0, end_sec: 6.2,
    transcript_segment: 'Narration', motion_prompt: 'Slow push in', approved: true,
    image_filename: 'scene-1.png', clip_exists: false, clip_stale: false,
    motion_choice: 'pending', ...overrides,
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

async function mount(input: {
  models: any[]
  scenes?: any[]
  motion_scope?: unknown
  motion_scene_ids?: string[]
  motion_crossing_scene_ids?: string[]
  motion_scope_error?: string
  visual_source?: 'scene_plan' | 'image_pool'
}) {
  const calls: Array<{ path: string; body: any }> = []
  const models = ref(input.models)
  const fixtureScenes = input.scenes ?? [scene()]
  ;(globalThis as any).__mrModels = models
  ;(globalThis as any).__mrRoute = reactive({ params: { slug: 'demo' }, query: { episode_id: 'EP0001' } })
  ;(globalThis as any).__mrApi = {
    get: async () => ({
      scenes: fixtureScenes,
      stats: { total_scenes: fixtureScenes.length, approved: 1, with_image: 1, with_clip: 0, motion_reviewed: 0, all_motion_reviewed: false },
      motion_scope: input.motion_scope ?? { mode: 'all' },
      motion_scene_ids: input.motion_scene_ids ?? fixtureScenes.map(scene => scene.id),
      motion_crossing_scene_ids: input.motion_crossing_scene_ids,
      motion_scope_error: input.motion_scope_error,
      visual_source: input.visual_source,
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
    models,
    text: () => el.textContent || '',
    preset: () => (globalThis as any).__mrPreset,
    destroy,
  }
}

function change(select: HTMLSelectElement, value: string): void {
  select.value = value
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

function clickRadio(el: HTMLElement, value: string): void {
  const radio = el.querySelector<HTMLInputElement>(`input[name="duration-mode"][value="${value}"]`)!
  assert.ok(radio, `${value} duration mode exists`)
  radio.click()
}

describe('Motion Review duration controls', () => {
  test('follows narration across sparse durations and names trim or hold per scene', async () => {
    const mounted = await mount({
      models: [model('sparse', [variant(5, '720p', 50), variant(8, '720p', 80), variant(10, '720p', 100)])],
      scenes: [scene(), scene({ id: 'scene-2', scene_index: 2, end_sec: 12 })],
    })
    clickRadio(mounted.el, 'follow_narration')
    await settle()

    const rows = [...mounted.el.querySelectorAll('.scene-duration-plan')].map(row => row.textContent || '')
    assert.match(rows[0]!, /Scene \/ narration timeline\s*6\.2s/)
    assert.match(rows[0]!, /Generated motion request\s*8s/)
    assert.match(rows[0]!, /Trim 1\.8s/)
    assert.match(rows[0]!, /Estimated cost\s*80 credits/)
    assert.match(rows[1]!, /Scene \/ narration timeline\s*12s/)
    assert.match(rows[1]!, /Generated motion request\s*10s/)
    assert.match(rows[1]!, /Hold final frame 2s/)
    assert.match(mounted.text(), /2 clips/)
    assert.match(mounted.text(), /Estimated total 180 credits/)
    assert.match(mounted.text(), /Price is confirmed when each clip starts/i)
    mounted.destroy()
  })

  test('rounds manual input up, caps it visibly, and supports contiguous rows', async () => {
    const mounted = await mount({ models: [model('contiguous', [4, 5, 6, 7, 8].map(seconds => variant(seconds, '1080p')))] })
    const field = mounted.el.querySelector<HTMLInputElement>('input[aria-label="Manual clip length"]')!
    assert.ok(field)
    field.value = '6.2'
    field.dispatchEvent(new Event('input', { bubbles: true }))
    field.dispatchEvent(new Event('blur', { bubbles: true }))
    await settle()
    assert.equal(field.value, '7')
    field.value = '99'
    field.dispatchEvent(new Event('input', { bubbles: true }))
    field.dispatchEvent(new Event('blur', { bubbles: true }))
    await settle()
    assert.equal(field.value, '8')
    assert.equal(field.max, '8')
    assert.match(mounted.text(), /Maximum 8s/)
    mounted.destroy()
  })

  test('uses only the newly selected model and resolution, including future 30-second rows', async () => {
    const mounted = await mount({
      models: [
        model('first', [variant(5, '720p'), variant(8, '720p'), variant(6, '1080p'), variant(10, '1080p')]),
        model('future', [variant(12, '1080p'), variant(30, '1080p')]),
      ],
    })
    const manual = mounted.el.querySelector<HTMLInputElement>('input[aria-label="Manual clip length"]')!
    manual.value = '8'
    manual.dispatchEvent(new Event('input', { bubbles: true }))
    manual.dispatchEvent(new Event('blur', { bubbles: true }))
    change(mounted.el.querySelector<HTMLSelectElement>('select[aria-label="Resolution"]')!, '1080p')
    await settle()
    assert.equal(manual.value, '10', 'a resolution switch rounds the selected duration up instead of resetting it')

    change(mounted.el.querySelector<HTMLSelectElement>('select[aria-label="Image-to-video model options"]')!, 'genstudio-video:future')
    await settle()
    assert.match(mounted.text(), /Maximum 30s/)
    assert.doesNotMatch(mounted.text(), /Maximum 8s/)
    assert.deepEqual(
      [...mounted.el.querySelectorAll<HTMLSelectElement>('select[aria-label="Resolution"] option')].map(option => option.value),
      ['1080p'],
    )

    mounted.models.value = [model('unavailable', [], false)]
    await settle()
    assert.match(mounted.text(), /No resolution available/)
    assert.equal(mounted.el.querySelector<HTMLButtonElement>('button')?.disabled, true)
    mounted.destroy()
  })

  test('counts and totals only clips the batch will actually submit', async () => {
    const mounted = await mount({
      models: [model('sparse', [variant(5, '720p', 50), variant(8, '720p', 80)])],
      scenes: [
        scene(),
        scene({ id: 'existing', scene_index: 2, clip_exists: true, clip_stale: true }),
        scene({ id: 'unapproved', scene_index: 3, approved: false }),
        scene({ id: 'no-image', scene_index: 4, image_filename: null }),
        scene({ id: 'no-prompt', scene_index: 5, motion_prompt: '' }),
        scene({ id: 'still', scene_index: 6, motion_choice: 'still' }),
      ],
    })
    change(mounted.el.querySelector<HTMLSelectElement>('select[aria-label="Aspect ratio"]')!, '16:9')
    clickRadio(mounted.el, 'follow_narration')
    await settle()
    assert.match(mounted.text(), /1 clip · Estimated total 80 credits/)
    assert.match(mounted.text(), /Existing clips stay out of this batch/)
    mounted.el.querySelector<HTMLButtonElement>('button')!.click()
    await settle()
    assert.equal(mounted.calls.length, 1)
    assert.deepEqual(mounted.calls[0]!.body, {
      model: 'genstudio-video:sparse', aspect_ratio: '16:9', operation: 'image-to-video',
      duration_mode: 'follow_narration', resolution: '720p',
    })
    mounted.destroy()
  })

  test('carries a chosen extra switch and blocks new unsupported controls after refresh', async () => {
    const published = { ...model('controls', [variant(5, '720p')]), controls: [
      { name: 'enhance', type: 'boolean', default: true, note: 'Published enhancement' },
    ] }
    const mounted = await mount({ models: [published] })
    change(mounted.el.querySelector<HTMLSelectElement>('select[aria-label="Aspect ratio"]')!, '16:9')
    const toggle = mounted.el.querySelector<HTMLInputElement>('input[role="switch"]')!
    assert.ok(toggle)
    assert.equal(toggle.checked, true)
    toggle.click()
    await settle()
    mounted.el.querySelector<HTMLButtonElement>('button')!.click()
    await settle()
    assert.equal(mounted.calls.length, 1)
    assert.deepEqual(mounted.calls[0]!.body.video_controls, { enhance: false })

    mounted.models.value = [{ ...published, controls: [{ name: 'extension_seconds', type: 'integer', default: null, note: null }] }]
    await settle()
    assert.match(mounted.text(), /Update Story Studio.*extension_seconds/)
    assert.equal(mounted.el.querySelector<HTMLButtonElement>('button')!.disabled, true)
    mounted.el.querySelector<HTMLButtonElement>('button')!.click()
    await settle()
    assert.equal(mounted.calls.length, 1, 'a newly unsupported capability cannot enqueue a second purchase')
    mounted.destroy()
  })

  test('leaves chaining visibly unavailable without submitting extra clips', async () => {
    const mounted = await mount({
      models: [model('short', [variant(5, '720p')])],
      scenes: [scene({ end_sec: 12, clip_exists: true, visual_lane: 'image_to_video' })],
    })
    const options = [...mounted.el.querySelectorAll<HTMLOptionElement>('option[value="chain"]')]
    assert.ok(options.length)
    assert.ok(options.every(option => option.disabled && /unavailable/.test(option.textContent || '')))
    const chainButtons = [...mounted.el.querySelectorAll<HTMLButtonElement>('button')]
      .filter(button => /Chain clips/.test(button.textContent || ''))
    assert.ok(chainButtons.every(button => button.disabled))
    chainButtons.forEach(button => button.click())
    await settle()
    assert.equal(mounted.calls.length, 0)
    mounted.destroy()
  })

  test('presets retain the manual value and old presets remain manual', async () => {
    const mounted = await mount({ models: [model('sparse', [variant(5, '720p'), variant(8, '720p')])] })
    change(mounted.el.querySelector<HTMLSelectElement>('select[aria-label="Aspect ratio"]')!, '16:9')
    const field = mounted.el.querySelector<HTMLInputElement>('input[aria-label="Manual clip length"]')!
    field.value = '8'
    field.dispatchEvent(new Event('input', { bubbles: true }))
    field.dispatchEvent(new Event('blur', { bubbles: true }))
    clickRadio(mounted.el, 'follow_narration')
    await settle()
    assert.deepEqual(mounted.preset().snapshot(), {
      model: 'genstudio-video:sparse', aspect_ratio: '16:9', operation: 'image-to-video',
      duration_seconds: 8, resolution: '720p', duration_mode: 'follow_narration',
    })

    mounted.preset().apply({ model: 'genstudio-video:sparse', duration_seconds: 5, resolution: '720p' })
    await settle()
    assert.equal(mounted.el.querySelector<HTMLInputElement>('input[name="duration-mode"][value="manual"]')!.checked, true)
    assert.equal(mounted.el.querySelector<HTMLInputElement>('input[aria-label="Manual clip length"]')!.value, '5')
    mounted.destroy()
  })

  test('keyboard arrows move through sparse published lengths', async () => {
    const mounted = await mount({ models: [model('sparse', [variant(5, '720p'), variant(8, '720p'), variant(10, '720p')])] })
    const slider = mounted.el.querySelector<HTMLInputElement>('input[aria-label="Manual clip length slider"]')!
    assert.ok(slider)
    slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    await settle()
    assert.equal(mounted.el.querySelector<HTMLInputElement>('input[aria-label="Manual clip length"]')!.value, '8')
    slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    await settle()
    assert.equal(mounted.el.querySelector<HTMLInputElement>('input[aria-label="Manual clip length"]')!.value, '5')
    mounted.destroy()
  })

  test('shows the saved opening scope, crossing boundary, and only its eligible batch cost', async () => {
    const mounted = await mount({
      models: [model('scope', [variant(5, '720p', 50)])],
      scenes: [
        scene({ id: 'opening', scene_index: 1, start_sec: 0, end_sec: 8 }),
        scene({ id: 'crossing', scene_index: 2, start_sec: 8, end_sec: 16 }),
        scene({ id: 'later', scene_index: 3, start_sec: 16, end_sec: 24 }),
      ],
      motion_scope: { mode: 'opening', end_sec: 12 },
      motion_scene_ids: ['opening'],
      motion_crossing_scene_ids: ['crossing'],
    })
    change(mounted.el.querySelector<HTMLSelectElement>('select[aria-label="Aspect ratio"]')!, '16:9')
    await settle()

    assert.match(mounted.text(), /Opening.*12s/i)
    assert.match(mounted.text(), /1 eligible scene/i)
    assert.match(mounted.text(), /Scene 2 crosses the opening boundary/i)
    assert.match(mounted.text(), /1 clip · Estimated total 50 credits/)
    assert.ok(mounted.el.querySelector('a[href*="scene-plan"][href$="#visual-timing"]'))
    const generateButtons = [...mounted.el.querySelectorAll<HTMLButtonElement>('button')]
      .filter(button => /Generate Clip/.test(button.textContent || ''))
    assert.equal(generateButtons.length, 3)
    assert.equal(generateButtons[0]!.disabled, false)
    assert.equal(generateButtons[1]!.disabled, true)
    assert.equal(generateButtons[2]!.disabled, true)
    generateButtons[1]!.click()
    await settle()
    assert.equal(mounted.calls.length, 0, 'an out-of-scope row cannot enqueue paid motion work')
    mounted.destroy()
  })

  test('labels Image Pool as not using Motion Review and leaves its single-scene controls unavailable', async () => {
    const mounted = await mount({
      models: [model('pool', [variant(5, '720p', 50)])],
      visual_source: 'image_pool',
    })
    await settle()

    assert.match(mounted.text(), /Image Pool.*not used/i)
    assert.equal(mounted.el.querySelector<HTMLButtonElement>('button')?.disabled, true)
    assert.equal(mounted.calls.length, 0)
    mounted.destroy()
  })

  test('keeps Scene Review available when its saved motion scope needs repair', async () => {
    const mounted = await mount({
      models: [model('stale', [variant(5, '720p', 50)])],
      motion_scope: { mode: 'off' },
      motion_scene_ids: [],
      motion_scope_error: 'Selected motion scenes no longer exist: removed-scene. Choose the scenes again.',
    })
    await settle()

    assert.match(mounted.text(), /Selected motion scenes no longer exist: removed-scene/i)
    assert.ok(mounted.el.querySelector('a[href*="scene-plan"][href$="#visual-timing"]'))
    mounted.destroy()
  })

  test('does not mark an Off scope as 100% decided', async () => {
    const mounted = await mount({
      models: [model('off', [variant(5, '720p', 50)])],
      motion_scope: { mode: 'off' },
      motion_scene_ids: [],
    })
    await settle()

    assert.match(mounted.text(), /No motion decisions in this scope/)
    assert.match(mounted.text(), /not applicable/)
    assert.doesNotMatch(mounted.text(), /100%\s*decided/)
    mounted.destroy()
  })
})
