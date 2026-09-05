import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createApp, nextTick } from 'vue'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import { transform } from 'esbuild'

test('Retry All groups dependent rows once without altering subtitle allow-lists', async () => {
  const { groupEpisodeRecoveryRetries } = await import('../utils/episode-recovery')
  const jobs = [
    { job_id: 's', project_slug: 'p', episode_id: 'EP0001', type: 'subtitles_transcribe', params: { sections: ['Chapter_02'] } },
    { job_id: 'p', project_slug: 'p', episode_id: 'EP0001', type: 'scene_plan_run' },
    { job_id: 'r', project_slug: 'p', episode_id: 'EP0001', type: 'continuity_render' },
    { job_id: 'other', project_slug: 'p', episode_id: 'EP0001', type: 'metadata' },
  ]
  const grouped = groupEpisodeRecoveryRetries(jobs)
  assert.deepEqual(grouped.episodes, [{ project_slug: 'p', episode_id: 'EP0001', source_job_ids: ['s', 'p', 'r'] }])
  assert.deepEqual(grouped.other, [jobs[3]])
  assert.deepEqual(jobs[0].params!.sections, ['Chapter_02'])
})

test('cancelled subtitle, Scene Plan, and Scene Review retries use saved source intent, never raw generator posts', async () => {
  const { groupEpisodeRecoveryRetries } = await import('../utils/episode-recovery')
  const jobs = ['subtitles_transcribe', 'scene_plan_run', 'continuity_render'].map(type => ({
    type, job_id: type, project_slug: 'p', episode_id: 'EP0001', status: 'cancelled', params: { force: true, sections: ['Chapter_02'] },
  }))
  const grouped = groupEpisodeRecoveryRetries(jobs)
  assert.deepEqual(grouped.other, [])
  assert.deepEqual(grouped.episodes, [{ project_slug: 'p', episode_id: 'EP0001', source_job_ids: jobs.map(job => job.job_id) }])
  const page = readFileSync(new URL('../pages/projects/[slug]/jobs.vue', import.meta.url), 'utf8')
  const retry = page.slice(page.indexOf('async function retryJob('), page.indexOf('const endpointMap:', page.indexOf('async function retryJob(')))
  assert.match(retry, /if \(isEpisodeRecoveryType\(job.type\)\)/)
  assert.match(retry, /source_job_ids: \[job.job_id\]/)
  assert.doesNotMatch(retry, /status !== 'cancelled'/)
  assert.doesNotMatch(page.slice(page.indexOf('async function retryJob(')), /video-editor\/subtitles\/transcribe/)
  assert.deepEqual(jobs[0].params, { force: true, sections: ['Chapter_02'] })
})

async function component() {
  const filename = fileURLToPath(new URL('../components/EpisodeRecoveryStatus.vue', import.meta.url))
  const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename })
  const script = compileScript(descriptor, { id: 'episode-recovery' })
  const template = compileTemplate({ source: descriptor.template!.content, filename, id: 'episode-recovery', compilerOptions: { bindingMetadata: script.bindings } })
  const vueUrl = import.meta.resolve('vue')
  const support = `const useApi = () => ({ post: (...args) => globalThis.__recoveryPost(...args) });`
  const code = await transform(`${support}\n${script.content.replace('export default', 'const __sfc__ =')}\n${template.code}\n__sfc__.render = render; export default __sfc__`, { loader: 'ts', format: 'esm' })
  return (await import(`data:text/javascript;base64,${Buffer.from(code.code.replaceAll('"vue"', JSON.stringify(vueUrl))).toString('base64')}`)).default
}

test('manual action appears only for authoritative eligibility and double click posts one bounded request', async () => {
  const sent: unknown[] = []
  let finish!: () => void
  const hostGlobal = globalThis as any
  hostGlobal.__recoveryPost = (...args: unknown[]) => { sent.push(args); return new Promise<void>(resolve => { finish = resolve }) }
  const host = document.body.appendChild(document.createElement('div'))
  const job = { job_id: 'failed', project_slug: 'project', episode_id: 'EP0001', type: 'subtitles_transcribe', status: 'error',
    params: { subtitle_recovery: { sections: { Chapter_02: { state: 'paid_blocked', message: 'Paid recovery is off.', manual_action: 'buy_missing_subtitles' } } } },
    result: { expected_sections: 2, ready_sections: 1, missing_sections: ['Chapter_02'] } }
  const app = createApp(await component(), { job })
  app.mount(host)
  try {
    assert.match(host.textContent!, /Buy missing subtitles now/)
    assert.match(host.textContent!, /1\/2 sections ready/)
    const input = host.querySelector('input')!
    input.value = '12'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    host.querySelector('button')!.click()
    host.querySelector('button')!.click()
    await nextTick()
    assert.deepEqual(sent, [[ '/projects/project/video-editor/subtitles/buy-missing/failed', { additional_credit_ceiling: 12 } ]])
    finish()
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.match(host.textContent!, /Recovery queued/)
  } finally { app.unmount(); host.remove(); delete hostGlobal.__recoveryPost }
})

test('settlement uncertainty has no purchase control', async () => {
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(await component(), { job: { job_id: 'waiting', project_slug: 'p', type: 'subtitles_transcribe', status: 'error',
    params: { subtitle_recovery: { sections: { Chapter_02: { state: 'waiting_settlement', message: 'Waiting for credit settlement' } } } }, result: { missing_sections: ['Chapter_02'] } } })
  app.mount(host)
  try { assert.match(host.textContent!, /Waiting for credit settlement/); assert.equal(host.querySelector('button'), null) }
  finally { app.unmount(); host.remove() }
})
