import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createApp, nextTick, type Component } from 'vue'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import { transform } from 'esbuild'

const path = fileURLToPath(new URL('../components/WeeklyResults.vue', import.meta.url))
async function component(): Promise<Component> {
  const { descriptor } = parse(readFileSync(path, 'utf8'), { filename: path })
  const script = compileScript(descriptor, { id: 'weekly-results' })
  const template = compileTemplate({ source: descriptor.template!.content, filename: path, id: 'weekly-results', compilerOptions: { bindingMetadata: script.bindings } })
  const vue = await import.meta.resolve('vue')
  const source = `import { ref, computed, onMounted, watch } from ${JSON.stringify(vue)}\nconst useApi = () => globalThis.__weeklyApi\n${script.content.replace('export default', 'const __sfc__ =')}\n${template.code}\n__sfc__.render = render\nexport default __sfc__`
  const output = await transform(source, { loader: 'ts', format: 'esm' })
  return (await import(`data:text/javascript;base64,${Buffer.from(output.code.replaceAll('"vue"', JSON.stringify(vue))).toString('base64')}`)).default
}
const metric = (state: string, value: number | null = null) => ({ state, value, reason: '' })
const week = (date: string, complete: boolean, metrics: Record<string, unknown>) => ({
  week: date, end_date: date, complete, reason: complete ? null : 'Some results could not be read.', warnings: [],
  top_videos: [{ video_id: date, title: `Episode ${date}`, metrics }],
})
async function mount(results: unknown[]) {
  ;(globalThis as any).__weeklyApi = {
    get: async (url: string) => url.endsWith('/settings') ? { enabled: true } : { results },
    put: async (_url: string, body: unknown) => body,
  }
  const el = document.createElement('div')
  const app = createApp(await component(), { slug: 'demo' })
  app.mount(el)
  for (let i = 0; i < 6; i++) await nextTick()
  return { el, app }
}

test('weekly results distinguish no data, zero and unavailable, and switch weeks', async () => {
  const { el, app } = await mount([
    week('2026-10-19', false, { views: metric('measured', 0), watch_minutes: metric('no_data'), click_through_rate: metric('unavailable'), impressions: metric('measured', 42) }),
    week('2026-10-12', true, { views: metric('measured', 17), watch_minutes: metric('measured', 5), click_through_rate: metric('measured', 2), impressions: metric('measured', 200) }),
  ])
  assert.match(el.textContent!, /Partial week/)
  assert.deepEqual([...el.querySelectorAll('dd')].map(e => e.textContent), ['0', 'No data', 'Not available', '42'])
  assert.equal((el.querySelector('input') as HTMLInputElement).checked, true)
  const select = el.querySelector('select')!
  select.value = '2026-10-12'
  select.dispatchEvent(new Event('change'))
  await nextTick()
  assert.match(el.textContent!, /Episode 2026-10-12/)
  assert.doesNotMatch(el.textContent!, /Partial week/)
  assert.deepEqual([...el.querySelectorAll('dd')].map(e => e.textContent), ['17', '5', '2%', '200'])
  app.unmount()
})

test('an empty report says No data', async () => {
  const { el, app } = await mount([])
  assert.match(el.textContent!, /No data/)
  assert.equal(el.querySelector('select'), null)
  app.unmount()
})
