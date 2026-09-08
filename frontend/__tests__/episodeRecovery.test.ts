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

test('only a verified normal subtitle recovery is presented as recovered', async () => {
  const { isVerifiedRecoveredSubtitleJob: isRecovered } = await import('../utils/episode-recovery')
  const job = {
    type: 'subtitles_transcribe',
    status: 'error',
    params: {
      force: false,
      episode_recovery_id: 'recovery-plan-1',
      episode_recovery: {
        id: 'recovery-plan-1',
        completed: ['audio_merge', 'subtitle_sections', 'subtitle_stitch'],
        first_unresolved: 'scene_plan_run',
        message: '16/16 sections ready',
      },
    },
  }
  assert.equal(isRecovered(job), true)
  assert.equal(isRecovered({ ...job, params: { ...job.params, force: true } }), false)
  assert.equal(isRecovered({ ...job, params: { ...job.params, generation_action: { id: 'fresh-1', kind: 'fresh' } } }), false)
  assert.equal(isRecovered({ ...job, params: { ...job.params, episode_recovery_id: 'another-plan' } }), false)
  assert.equal(isRecovered({ ...job, params: { ...job.params, episode_recovery_id: '' } }), false)
  assert.equal(isRecovered({ ...job, params: { ...job.params, episode_recovery: {
    ...job.params.episode_recovery, completed: ['audio_merge', 'subtitle_sections'],
  } } }), false)
  assert.equal(isRecovered({ ...job, params: { ...job.params, episode_recovery: {
    ...job.params.episode_recovery, first_unresolved: 'subtitle_stitch',
  } } }), false)
  assert.equal(isRecovered({ ...job, params: { ...job.params, episode_recovery: {
    ...job.params.episode_recovery, first_unresolved: undefined,
  } } }), false)
  assert.equal(isRecovered({ ...job, status: 'done' }), false)
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

test('verified recovery replaces stale missing-section actions with the current result', async () => {
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(await component(), {
    verifiedRecovered: true,
    job: {
      job_id: 'old-failure', project_slug: 'p', episode_id: 'SS0080', type: 'subtitles_transcribe', status: 'error',
      params: {
        episode_recovery: {
          completed: ['audio_merge', 'subtitle_sections', 'subtitle_stitch'],
          first_unresolved: 'scene_plan_run',
          message: '16/16 sections ready',
        },
        subtitle_recovery: { sections: {
          Chapter_01: { state: 'needs_attention', message: 'Old attempt missing.', manual_action: 'buy_missing_subtitles' },
        } },
      },
      result: { expected_sections: 16, ready_sections: 13, missing_sections: ['Chapter_01', 'Chapter_03', 'Chapter_12'] },
    },
  })
  app.mount(host)
  try {
    assert.match(host.textContent!, /Recovered/)
    assert.match(host.textContent!, /16\/16 sections ready/)
    assert.doesNotMatch(host.textContent!, /13\/16 sections ready/)
    assert.doesNotMatch(host.textContent!, /Old attempt missing/)
    assert.equal(host.querySelector('button'), null)
    assert.equal(host.querySelector('a'), null)
  } finally { app.unmount(); host.remove() }
})

test('unavailable saved subtitle work points to a scoped fresh request and states the charge boundary', async () => {
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(await component(), { job: { job_id: 'missing-task', project_slug: 'p & q', episode_id: 'EP0001',
    type: 'subtitles_transcribe', status: 'error', params: { subtitle_recovery: { sections: {
      Chapter_12: { state: 'needs_attention', message: 'Saved task unavailable.', manual_action: 'rerun_subtitle_section' },
    } } }, result: { expected_sections: 16, missing_sections: ['Chapter_12'] } } })
  app.mount(host)
  try {
    assert.match(host.textContent!, /15\/16 sections ready/)
    assert.match(host.textContent!, /fresh GenStudio request/i)
    assert.match(host.textContent!, /current quote/i)
    assert.match(host.textContent!, /may be charged/i)
    assert.equal(host.querySelector('button'), null)
    assert.equal(host.querySelector('a')?.getAttribute('href'), '/projects/p%20%26%20q/subtitles?episode_id=EP0001')
  } finally { app.unmount(); host.remove() }
})
