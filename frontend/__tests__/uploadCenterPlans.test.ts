import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import { createApp, defineComponent, h, nextTick, reactive, type Component } from 'vue'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import { transform } from 'esbuild'

const pagePath = fileURLToPath(new URL('../pages/projects/[slug]/upload/plans.vue', import.meta.url))
const source = readFileSync(pagePath, 'utf8')

async function loadPage(): Promise<Component> {
  const { descriptor } = parse(source, { filename: pagePath })
  const script = compileScript(descriptor, { id: 'uc-plans' })
  const template = compileTemplate({ source: descriptor.template!.content, filename: pagePath, id: 'uc-plans', compilerOptions: { bindingMetadata: script.bindings } })
  const vueUrl = await import.meta.resolve('vue')
  const support = `
    import { ref, computed, watch, h as __h } from ${JSON.stringify(vueUrl)}
    const useApi = () => globalThis.__plansApi
    const useRoute = () => globalThis.__plansRoute
    const useConfirm = () => ({ ask: (options) => globalThis.__plansAsk(options) })
    const onBeforeRouteLeave = (guard) => { globalThis.__plansLeave = guard }
    const onBeforeRouteUpdate = (guard) => { globalThis.__plansUpdate = guard }
    const NuxtLink = { props: ['to'], setup: (p, { slots }) => () => __h('a', { href: String(p.to) }, slots.default ? slots.default() : []) }
  `
  const code = `${support}\n${script.content.replace('export default', 'const __sfc__ =')}\n${template.code}\n__sfc__.render = render\nexport default __sfc__`
  const out = await transform(code, { loader: 'ts', format: 'esm' })
  return (await import(`data:text/javascript;base64,${Buffer.from(out.code.replaceAll('"vue"', JSON.stringify(vueUrl))).toString('base64')}`)).default
}

interface Call { method: string; path: string; body?: any }
const channel = (id = 'UC-x') => ({ assigned_channel: { channel_id: id, title: `Channel ${id}` } })
const plan = (overrides: any = {}) => ({
  id: 'plan-1', name: 'Friday uploads', platform: 'youtube', account_id: 'registry:UC-x',
  schedule: { weekdays: [5], time_local: '18:00', timezone: 'Asia/Phnom_Penh', interval_weeks: 1 },
  defaults: { privacy_status: 'private', made_for_kids: false, language: 'km' },
  created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z', ...overrides,
})

async function ticks(count = 6): Promise<void> { for (let i = 0; i < count; i++) await nextTick() }
async function mount(input: {
  overview?: any | ((slug: string) => Promise<any> | any)
  plans?: any | ((slug: string) => Promise<any> | any)
  config?: any
  initialSlug?: string
  post?: (path: string, body: any) => Promise<any> | any
  put?: (path: string, body: any) => Promise<any> | any
  confirmAnswer?: boolean
} = {}) {
  const calls: Call[] = []
  const confirms: any[] = []
  const route = reactive({ params: { slug: input.initialSlug ?? 'demo' } })
  ;(globalThis as any).__plansRoute = route
  ;(globalThis as any).__plansAsk = async (options: any) => { confirms.push(options); return input.confirmAnswer !== false }
  ;(globalThis as any).__plansLeave = undefined
  ;(globalThis as any).__plansUpdate = undefined
  ;(globalThis as any).__plansApi = {
    get: async (path: string) => {
      calls.push({ method: 'GET', path })
      const slug = path.split('/')[2]
      if (path.endsWith('/youtube/overview')) return typeof input.overview === 'function' ? input.overview(slug) : input.overview ?? channel()
      if (path.endsWith('/upload/plans')) return typeof input.plans === 'function' ? input.plans(slug) : input.plans ?? { plans: [], active: {} }
      if (path.endsWith('/settings/config')) return input.config ?? {}
      throw new Error(`unexpected GET ${path}`)
    },
    post: async (path: string, body: any) => {
      calls.push({ method: 'POST', path, body })
      return input.post ? input.post(path, body) : { plan: plan({ id: 'plan-new', name: body.name, account_id: body.account_id, schedule: body.schedule, defaults: body.defaults }) }
    },
    put: async (path: string, body: any) => {
      calls.push({ method: 'PUT', path, body })
      return input.put ? input.put(path, body) : { ok: true }
    },
  }
  const Page = await loadPage()
  const el = document.createElement('div')
  document.body.appendChild(el)
  const app = createApp(defineComponent({ render: () => h(Page as any) }))
  app.component('NuxtLink', defineComponent({
    props: { to: String }, setup(props, { slots }) { return () => h('a', { href: props.to }, slots.default?.()) },
  }))
  app.mount(el)
  await ticks()
  return {
    el, calls, confirms, text: () => el.textContent || '',
    setSlug: async (slug: string) => { route.params.slug = slug; await ticks() },
    leave: async () => (globalThis as any).__plansLeave(),
    update: async () => (globalThis as any).__plansUpdate(),
    destroy: () => { app.unmount(); el.remove() },
  }
}

function button(el: HTMLElement, text: string): HTMLButtonElement {
  const found = [...el.querySelectorAll('button')].find(item => item.textContent?.trim() === text)
  assert.ok(found, `button ${text}`)
  return found as HTMLButtonElement
}
function namedInput(el: HTMLElement, label: string): HTMLInputElement {
  const found = [...el.querySelectorAll('label')].find(item => item.textContent?.trim().startsWith(label))?.querySelector('input')
  assert.ok(found, `input ${label}`)
  return found as HTMLInputElement
}
function input(el: HTMLInputElement, value: string): void { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })) }

describe('Upload Center Plans', () => {
  test('creates a local plan from the channel cadence without applying a schedule', async () => {
    const mounted = await mount({ config: { publish_cadence: { schedule: { weekdays: [1, 4], time_local: '09:30', timezone: 'Asia/Phnom_Penh', interval_weeks: 2 }, defaults: { privacy_status: 'private', language: 'km' } } } })
    assert.match(mounted.text(), /local future-slot choices/)
    assert.equal(button(mounted.el, 'New plan').disabled, false)
    assert.equal(button(mounted.el, 'Save local plan').disabled, false)
    assert.equal([...mounted.el.querySelectorAll('a')].find(link => link.textContent?.trim() === 'Return to Publish')?.getAttribute('href'), '/projects/demo/upload/publish')
    input(namedInput(mounted.el, 'Plan name'), 'Morning releases')
    mounted.el.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await ticks()
    const save = mounted.calls.find(call => call.method === 'POST')!
    assert.equal(save.path, '/projects/demo/upload/plans')
    assert.deepEqual(save.body.schedule.weekdays, [1, 4])
    assert.equal(save.body.schedule.interval_weeks, 2)
    assert.equal(save.body.defaults.language, 'km')
    assert.equal(mounted.calls.some(call => /plan\/(apply|preview)|youtube\/upload/.test(call.path)), false)
    assert.match(mounted.text(), /has not applied dates or changed YouTube/)
    mounted.destroy()
  })

  test('edits the selected current-channel plan while preserving hidden schedule and defaults', async () => {
    const existing = plan({ schedule: { weekdays: [5], time_local: '18:00', timezone: 'Asia/Phnom_Penh', interval_weeks: 1, opaque_future_field: 'keep' } })
    const mounted = await mount({ plans: { plans: [existing, plan({ id: 'other', account_id: 'registry:UC-other' })], active: { 'youtube:registry:UC-x': 'plan-1' } } })
    assert.match(mounted.text(), /Friday uploads/)
    assert.doesNotMatch(mounted.text(), /registry:UC-other/)
    // The active plan is the initial editor draft, but explicit selection
    // remains available for a deliberate switch.
    assert.equal(namedInput(mounted.el, 'Plan name').value, 'Friday uploads')
    input(namedInput(mounted.el, 'Plan name'), 'Friday premieres')
    mounted.el.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await ticks()
    const save = mounted.calls.find(call => call.method === 'POST')!
    assert.equal(save.body.id, 'plan-1')
    assert.equal(save.body.defaults.language, 'km')
    assert.equal(save.body.schedule.opaque_future_field, 'keep')
    mounted.destroy()
  })

  test('activates an already saved plan with an explicit local action', async () => {
    const first = plan()
    const second = plan({ id: 'plan-2', name: 'Weekend uploads', schedule: { weekdays: [6], time_local: '10:00', timezone: 'Asia/Phnom_Penh' } })
    const mounted = await mount({ plans: { plans: [first, second], active: { 'youtube:registry:UC-x': 'plan-1' } } })
    button(mounted.el, 'Make active').click()
    await ticks()
    assert.deepEqual(mounted.calls.filter(call => call.method === 'PUT').map(call => call.path), ['/projects/demo/upload/plans/plan-2/active'])
    assert.match(mounted.text(), /Weekend uploads is now the active local plan/)
    assert.equal(mounted.calls.some(call => call.method === 'POST'), false)
    mounted.destroy()
  })

  test('keeps an unsaved draft when switching plans is declined, and blocks editor activation', async () => {
    const first = plan()
    const second = plan({ id: 'plan-2', name: 'Weekend uploads', schedule: { weekdays: [6], time_local: '10:00', timezone: 'Asia/Phnom_Penh' } })
    const mounted = await mount({ plans: { plans: [first, second], active: { 'youtube:registry:UC-x': 'plan-1' } }, confirmAnswer: false })
    const edits = [...mounted.el.querySelectorAll('button')].filter(item => item.textContent?.trim() === 'Edit')
    assert.equal(edits.length, 2)
    edits[1]!.click()
    await ticks()
    input(namedInput(mounted.el, 'Plan name'), 'Unsaved Friday')
    await ticks()
    assert.equal(button(mounted.el, 'Make this plan active').disabled, true)
    assert.match(mounted.text(), /Save changes before making this plan active/)
    button(mounted.el, 'New plan').click()
    await ticks()
    assert.equal(namedInput(mounted.el, 'Plan name').value, 'Unsaved Friday')
    assert.equal(mounted.confirms[0].title, 'Discard unsaved plan changes?')
    button(mounted.el, 'Make active').click()
    await ticks()
    assert.equal(mounted.calls.some(call => call.method === 'PUT'), false)
    assert.equal(mounted.confirms[1].title, 'Make the saved plan active?')
    mounted.destroy()
  })

  test('router guards keep an unsaved draft when leaving or switching projects is declined', async () => {
    const mounted = await mount({ plans: { plans: [plan()], active: { 'youtube:registry:UC-x': 'plan-1' } }, confirmAnswer: false })
    input(namedInput(mounted.el, 'Plan name'), 'Unsaved Friday')
    await ticks()
    assert.equal(await mounted.leave(), false)
    assert.equal(await mounted.update(), false)
    assert.equal(namedInput(mounted.el, 'Plan name').value, 'Unsaved Friday')
    assert.deepEqual(mounted.confirms.map(confirm => confirm.title), [
      'Discard unsaved plan changes?', 'Discard unsaved plan changes?',
    ])
    mounted.destroy()
  })

  test('offers Retry after a plan load failure', async () => {
    let attempts = 0
    const mounted = await mount({ overview: () => {
      attempts += 1
      if (attempts === 1) throw new Error('offline')
      return channel()
    } })
    assert.match(mounted.text(), /offline/)
    button(mounted.el, 'Retry').click()
    await ticks()
    assert.equal(attempts, 2)
    assert.match(mounted.text(), /No local upload plans yet/)
    mounted.destroy()
  })

  test('does not show an editor or write anything before a channel is assigned', async () => {
    const mounted = await mount({ overview: { assigned_channel: null } })
    assert.match(mounted.text(), /Choose this project’s YouTube channel first/)
    assert.equal(mounted.el.querySelector('form'), null)
    assert.equal(mounted.calls.some(call => call.method === 'POST' || call.method === 'PUT'), false)
    mounted.destroy()
  })

  test('rejects a weekly plan without weekdays before it reaches the server', async () => {
    const mounted = await mount()
    input(namedInput(mounted.el, 'Plan name'), 'No days')
    mounted.el.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await ticks()
    assert.match(mounted.text(), /Pick at least one weekday/)
    assert.equal(mounted.calls.some(call => call.method === 'POST'), false)
    mounted.destroy()
  })

  test('ignores a slow prior-project response after navigation', async () => {
    let resolveOld!: (value: any) => void
    const oldPlans = new Promise(resolve => { resolveOld = resolve })
    const mounted = await mount({
      overview: slug => channel(slug === 'old' ? 'UC-old' : 'UC-new'),
      plans: slug => slug === 'old' ? oldPlans : { plans: [plan({ id: 'new-plan', name: 'New project plan', account_id: 'registry:UC-new' })], active: {} },
      initialSlug: 'old',
    })
    await mounted.setSlug('new')
    resolveOld({ plans: [plan({ name: 'Old project plan', account_id: 'registry:UC-old' })], active: {} })
    await ticks()
    assert.match(mounted.text(), /New project plan/)
    assert.doesNotMatch(mounted.text(), /Old project plan/)
    mounted.destroy()
  })
})
