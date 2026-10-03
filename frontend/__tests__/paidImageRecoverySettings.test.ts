import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createApp, defineComponent, h, nextTick, type Component } from 'vue'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import { transform } from 'esbuild'


// v1.4.249 — the four Settings paid-replacement cards became one table in
// components/PerformanceSettings.vue; their tests moved to performanceSettings.test.ts.

async function flush(): Promise<void> {
  await nextTick()
  await new Promise(resolve => setTimeout(resolve, 0))
  await nextTick()
}

async function renderPublicPaidImageAttempt(job: Record<string, unknown>): Promise<string> {
  const jobs = readFileSync(fileURLToPath(new URL('../pages/projects/[slug]/jobs.vue', import.meta.url)), 'utf8')
  const formatterStart = jobs.indexOf('function paidImageReplacementAttemptText')
  const formatterEnd = jobs.indexOf('\nfunction genStudioNumeric', formatterStart)
  const templateStart = jobs.indexOf('<p v-if="paidImageReplacementAttemptText(job)" class="paid-image-replacement-attempt" role="status">')
  const templateEnd = jobs.indexOf('</p>', templateStart) + '</p>'.length
  assert.notEqual(formatterStart, -1)
  assert.notEqual(formatterEnd, -1)
  assert.notEqual(templateStart, -1)
  const template = compileTemplate({ source: jobs.slice(templateStart, templateEnd), filename: 'jobs-paid-image-attempt.vue', id: 'jobs-paid-image-attempt' })
  const vueUrl = await import.meta.resolve('vue')
  const source = `
    import { formatCredits } from ${JSON.stringify(new URL('../utils/genstudio-credit-cost.ts', import.meta.url).href)}
    const formatTime = (value: string) => 'at ' + value
    ${jobs.slice(formatterStart, formatterEnd)}
    ${template.code}
    const component = { props: ['job'], methods: { paidImageReplacementAttemptText }, render }
    export default component
  `
  const compiled = await transform(source, { loader: 'ts', format: 'esm' })
  const component = (await import(`data:text/javascript;base64,${Buffer.from(
    compiled.code.replaceAll('"vue"', JSON.stringify(vueUrl)),
  ).toString('base64')}`)).default as Component
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(component, { job: { paid_image_replacement_attempt: job } })
  app.mount(host)
  await flush()
  const text = host.textContent || ''
  app.unmount()
  host.remove()
  return text
}

test('Jobs renders safe public Task5 replacement outcomes', async () => {
  assert.equal(
    await renderPublicPaidImageAttempt({ state: 'waiting', eligible_at: 'wait-at' }),
    'Paid image replacement is waiting until at wait-at.',
  )
  assert.equal(
    await renderPublicPaidImageAttempt({ state: 'blocked', eligible_at: 'wait-at', reason: 'automatic_replacement_unavailable' }),
    'Paid image replacement was blocked: Automatic replacement was not available.',
  )
  assert.equal(
    await renderPublicPaidImageAttempt({ state: 'committed', eligible_at: 'wait-at', replacement_committed_at: 'commit-at', quoted_credits: 4, price_version: 'mock-image-price-v1' }),
    'Paid image replacement was committed at commit-at. 4 credits at published price version mock-image-price-v1.',
  )
  assert.equal(
    await renderPublicPaidImageAttempt({ state: 'submitted', eligible_at: 'wait-at', quoted_credits: 1, price_version: 'mock-image-price-v1' }),
    'Paid image replacement was submitted. 1 credit at published price version mock-image-price-v1.',
  )
  assert.equal(
    await renderPublicPaidImageAttempt({ state: 'failed', eligible_at: 'wait-at', actual_settled_credits: 3 }),
    'Paid image replacement failed. Actual settled credits: 3 credits.',
  )
  assert.equal(
    await renderPublicPaidImageAttempt({ state: 'succeeded', eligible_at: 'wait-at', actual_settled_credits: 4 }),
    'Paid image replacement succeeded. Actual settled credits: 4 credits.',
  )
})
