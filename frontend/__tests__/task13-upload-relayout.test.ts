import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createApp, defineComponent, h, nextTick, reactive, ref, type Component } from 'vue'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { transform } from 'esbuild'

const pagePath = fileURLToPath(new URL('../pages/projects/[slug]/upload/publish.vue', import.meta.url))
const source = readFileSync(pagePath, 'utf8')

async function page(): Promise<Component> {
  const { descriptor } = parse(source, { filename: pagePath })
  const script = compileScript(descriptor, { id: 'task13-upload-relayout' })
  const template = compileTemplate({
    source: descriptor.template!.content,
    filename: pagePath,
    id: 'task13-upload-relayout',
    compilerOptions: { bindingMetadata: script.bindings },
  })
  const vueUrl = await import.meta.resolve('vue')
  const support = `
    import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from ${JSON.stringify(vueUrl)}
    const useApi = () => globalThis.__task13Api
    const useRoute = () => globalThis.__task13Route
    const useConfirm = () => ({ ask: async () => true })
    const useJobs = () => ({ jobs: globalThis.__task13Jobs, jobsStale: globalThis.__task13JobsStale })
  `
  const code = `${support}\n${script.content.replace('export default', 'const __sfc__ =').replace("'~/utils/upload-bulk'", JSON.stringify(new URL('../utils/upload-bulk.ts', import.meta.url).href))}\n${template.code}\n__sfc__.render = render\nexport default __sfc__`
  const out = await transform(code, { loader: 'ts', format: 'esm' })
  return (await import(`data:text/javascript;base64,${Buffer.from(out.code.replaceAll('"vue"', JSON.stringify(vueUrl))).toString('base64')}`)).default
}

async function ticks(count = 6): Promise<void> {
  for (let i = 0; i < count; i++) await nextTick()
}

function relayoutPreview() {
  return {
    plan_id: 'plan-1', channel_id: 'UC-task13', start_date: '2099-01-01', timezone: 'UTC',
    ordered_episode_codes: ['EP0001'],
    assignments: [{ episode_code: 'EP0001', publishAt: '2099-01-02T12:00:00.000Z' }],
    skipped: [], occupied_days: [],
  }
}

async function mount(deferred: Promise<unknown>) {
  const route = reactive({ params: { slug: 'task13-project' }, query: { episode_id: '' } })
  ;(globalThis as any).__task13Route = route
  ;(globalThis as any).__task13Jobs = ref([])
  ;(globalThis as any).__task13JobsStale = ref(false)
  ;(globalThis as any).__task13Api = {
    get: async (path: string) => {
      if (path.endsWith('/publishable')) return {
        episodes: [{ episode_code: 'EP0001', title: 'Fixture', has_video: true }], total: 1,
      }
      if (path.endsWith('/overview')) return {
        assigned_channel: { channel_id: 'UC-task13', title: 'Fixture channel', status: 'connected' },
        quota: { buckets: { other_endpoints: { remaining: 10 }, video_uploads: { remaining: 10 } } },
      }
      if (path.endsWith('/upload/plans')) return {
        active: { 'youtube:registry:UC-task13': 'plan-1' },
        plans: [{ id: 'plan-1', name: 'Fixture plan' }],
      }
      throw new Error(`unexpected GET ${path}`)
    },
    post: async (path: string) => {
      if (path.endsWith('/youtube/plan/relayout/preview')) return deferred
      throw new Error(`unexpected POST ${path}`)
    },
  }
  const Page = await page()
  const el = document.createElement('div')
  document.body.appendChild(el)
  const app = createApp(defineComponent({ render: () => h(Page as any) }))
  app.component('Modal', defineComponent({
    props: { visible: Boolean, labelledby: String }, emits: ['close'],
    setup(props, { slots }) { return () => props.visible ? h('div', { role: 'dialog' }, slots.default?.()) : null },
  }))
  app.component('NuxtLink', defineComponent({ setup(_, { slots }) { return () => h('a', slots.default?.()) } }))
  app.component('ProgressBar', defineComponent({ setup() { return () => h('div') } }))
  app.mount(el)
  await ticks()
  const select = [...el.querySelectorAll('button')].find(button => button.textContent?.includes('Select all matching'))!
  select.click()
  await ticks()
  const open = [...el.querySelectorAll('button')].find(button => button.textContent?.includes('Edit planned dates'))!
  open.click()
  await ticks()
  const preview = [...el.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Preview dates')!
  preview.click()
  await ticks()
  return { el, destroy: () => { app.unmount(); el.remove() } }
}

test('changing a relayout date invalidates the outstanding preview instead of enabling its old Save action', async () => {
  let resolve!: (value: unknown) => void
  const mounted = await mount(new Promise(value => { resolve = value }))
  try {
    const date = mounted.el.querySelector('#relayout-start-date') as HTMLInputElement
    date.value = '2099-01-03'
    date.dispatchEvent(new Event('input', { bubbles: true }))
    await ticks()
    resolve(relayoutPreview())
    await ticks()

    assert.equal(
      [...mounted.el.querySelectorAll('button')].some(button => button.textContent?.includes('Save 1 planned date')),
      false,
    )
  } finally { mounted.destroy() }
})

test('a delayed relayout preview cannot repopulate after Close', async () => {
  let resolve!: (value: unknown) => void
  const mounted = await mount(new Promise(value => { resolve = value }))
  try {
    const close = [...mounted.el.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Close')!
    close.click()
    await ticks()
    resolve(relayoutPreview())
    await ticks()

    assert.equal(mounted.el.querySelector('[role="dialog"]'), null)
    assert.equal(
      [...mounted.el.querySelectorAll('button')].some(button => button.textContent?.includes('Save 1 planned date')),
      false,
    )
  } finally { mounted.destroy() }
})
