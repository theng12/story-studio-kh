import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createApp, nextTick, type Component } from 'vue'
import { parse, compileScript } from '@vue/compiler-sfc'
import { transform } from 'esbuild'

async function load(): Promise<Component> {
  const filename = fileURLToPath(new URL('../components/SafetyChecksSettings.vue', import.meta.url))
  const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename })
  const script = compileScript(descriptor, { id: 'safety-settings', inlineTemplate: true })
  const vueUrl = await import.meta.resolve('vue')
  const code = script.content
    .replace("import { useApi } from '~/composables/useApi'", 'const useApi = () => globalThis.__safetyApi')
    .replace("import { useConfirm } from '~/composables/useConfirm'", 'const useConfirm = () => ({ ask: async () => true })')
  const out = await transform(code, { loader: 'ts', format: 'esm' })
  return (await import(`data:text/javascript;base64,${Buffer.from(out.code.replaceAll('"vue"', JSON.stringify(vueUrl))).toString('base64')}`)).default
}

const flush = async () => { for (let i = 0; i < 8; i++) await nextTick() }

test('channel silence control saves, resets and applies the displayed value with the existing switches', async (t) => {
  const writes: Array<{ path: string; body: any }> = []
  let threshold = 10
  ;(globalThis as any).__safetyApi = {
    get: async () => ({
      silence_min_sec: threshold,
      checks: [{ id: 'final_check', group: 'Video', name: 'Final check passed', protects: 'Checks the final video.', default: 'block', mode: 'block' }],
    }),
    put: async (path: string, body: any) => {
      writes.push({ path, body })
      threshold = body.silence_min_sec
      return { ok: true }
    },
    post: async (path: string, body: any) => { writes.push({ path, body }); return { applied: ['demo', 'other'] } },
  }
  const el = document.createElement('div')
  document.body.appendChild(el)
  const app = createApp(await load(), { slug: 'demo' })
  app.mount(el)
  t.after(() => { app.unmount(); el.remove(); delete (globalThis as any).__safetyApi })
  await flush()
  const field = () => el.querySelector<HTMLInputElement>('input[aria-label="Flag narration silence longer than, in seconds"]')!
  assert.equal(field().value, '10')
  field().value = '15'
  field().dispatchEvent(new Event('input'))
  field().dispatchEvent(new Event('change'))
  await flush()
  assert.deepEqual(writes[0], { path: '/projects/demo/safety-checks', body: { silence_min_sec: 15 } })
  assert.equal(field().value, '15')
  ;[...el.querySelectorAll('button')].find(button => button.textContent?.includes('Apply These'))!.click()
  await flush()
  assert.deepEqual(writes[1], { path: '/safety-checks/apply-to-all', body: { modes: { final_check: 'block' }, silence_min_sec: 15 } })
  ;[...el.querySelectorAll('button')].find(button => button.textContent?.includes('Back to Defaults'))!.click()
  await flush()
  assert.equal(writes[2]?.body.silence_min_sec, 10)
  assert.equal(field().value, '10')
})
