import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createApp, h, nextTick, readonly, ref, type Component } from 'vue'
import { compileScript, parse } from '@vue/compiler-sfc'
import { transform } from 'esbuild'
import { groupEpisodeRecoveryRetries, isEpisodeRecoveryType, isVerifiedRecoveredSubtitleJob, jobDisplayStatus } from '../utils/episode-recovery'
import { filterJobsForView } from '../utils/job-presentation'

const pagePath = fileURLToPath(new URL('../pages/projects/[slug]/jobs.vue', import.meta.url))
const source = readFileSync(pagePath, 'utf8')

async function loadJobs(): Promise<Component> {
  const { descriptor } = parse(source, { filename: pagePath })
  const script = compileScript(descriptor, { id: 'jobs-retry-all-manual-finish' })
  const vueUrl = await import.meta.resolve('vue')
  const support = `
    import { computed, defineComponent as _defineComponent, h, nextTick, onBeforeUnmount, onMounted, onUnmounted, ref, watch } from ${JSON.stringify(vueUrl)}
    const definePageMeta = () => undefined
    const useAppTitle = () => undefined
    const useRoute = () => ({ params: { slug: 'fixture-project' }, query: {} })
    const useApi = () => globalThis.__jobsApi
    const useJobs = () => globalThis.__jobsProjectQueue
    const useAllJobs = () => globalThis.__jobsUniversalQueue
    const useGenStudioModelDisplay = () => ({ displayName: () => '', refresh: async () => undefined })
    const useToast = () => ({ success: () => undefined, error: () => undefined, info: () => undefined })
    const useNetworkStatus = () => ({ online: ref(true) })
    const publicProviderLabel = () => ''
    const buildLatestBatchSummary = () => null
    const formatElapsed = () => ''
    const describeCancellation = () => ''
    const describeFreshness = () => ''
    const describeJobExceptions = () => []
    const estimateSecondsRemaining = () => null
    const formatEtaApprox = () => ''
    const isProgressStale = () => false
    const lastProgressAt = () => null
    const medianSecondsPerItem = () => null
    const recordEtaSample = () => undefined
    const summariseSettlement = () => ({})
    const summariseJobItems = () => ({})
    const WAITING_FALLBACK_REASON = ''
    const describeRetryAllTriage = () => ''
    const normaliseRepairResult = () => null
    const triageFailedJobsForRetryAll = (jobs) => ({ retry: jobs, alreadyComplete: [], blocked: [] })
    const customerSafeJobText = value => String(value || '')
    const filterJobsForView = globalThis.__filterJobsForView
    const isVerifiedLiveCapacity = () => false
    const jobRequestIds = () => []
    const primaryControl = () => null
    const secondaryControls = () => []
    const formatCredits = () => ''
    const isEpisodeRecoveryType = globalThis.__isEpisodeRecoveryType
    const groupEpisodeRecoveryRetries = globalThis.__groupEpisodeRecoveryRetries
    const isVerifiedRecoveredSubtitleJob = globalThis.__isVerifiedRecoveredSubtitleJob
    const jobDisplayStatus = globalThis.__jobDisplayStatus
  `
  const content = script.content
    .replace(/^import[\s\S]*?from ['"][^'"]+['"];?\n/gm, '')
    .replace('export default', 'const __sfc__ =')
  const out = await transform(`${support}\n${content}\nconst __setup = __sfc__.setup
    __sfc__.setup = function (props, context) {
      const state = __setup(props, context)
      globalThis.__jobsState = state
      return () => h('main')
    }
    export default __sfc__`, { loader: 'ts', format: 'esm' })
  return (await import(`data:text/javascript;base64,${Buffer.from(
    out.code.replaceAll('"vue"', JSON.stringify(vueUrl)),
  ).toString('base64')}`)).default
}

async function mount(jobs: any[], postReply?: (path: string, body: unknown) => Promise<unknown>) {
  const posts: Array<{ path: string; body: unknown }> = []
  function makeReadonlyQueue(seed: any[]) {
    const jobRows = ref(seed)
    const queueStats = ref({ running: 0, queued: 0, paused: 0, done: 0, error: 0, total: 0 })
    const refreshStats = () => {
      const next = { running: 0, queued: 0, paused: 0, done: 0, error: 0, total: jobRows.value.length }
      for (const job of jobRows.value) if (job.status in next) (next as any)[job.status]++
      queueStats.value = next
    }
    const calls: any[] = []
    refreshStats()
    return {
      jobs: readonly(jobRows), stats: readonly(queueStats), calls,
      applyUpdate(next: any) {
        calls.push(next)
        const rows = [...jobRows.value]
        const index = rows.findIndex(job => job.job_id === next.job_id)
        if (index >= 0) rows[index] = next
        else rows.unshift(next)
        jobRows.value = rows
        refreshStats()
      },
      start: () => undefined, stop: () => undefined,
    }
  }
  const projectQueue = makeReadonlyQueue(jobs)
  const universalQueue = makeReadonlyQueue(jobs)
  ;(globalThis as any).__jobsProjectQueue = projectQueue
  ;(globalThis as any).__jobsUniversalQueue = universalQueue
  ;(globalThis as any).__jobsApi = {
    get: async () => ({}), del: async () => ({}), put: async () => ({}),
    post: async (path: string, body: unknown) => {
      posts.push({ path, body })
      if (postReply) return postReply(path, body)
      const jobId = path.match(/\/jobs\/([^/]+)\/finish-missing-images$/)?.[1]
      const existing = jobId ? jobs.find(job => job.job_id === jobId) : null
      return existing ? { ok: true, job: { ...existing, status: 'queued' } } : {}
    },
  }
  ;(globalThis as any).__isEpisodeRecoveryType = isEpisodeRecoveryType
  ;(globalThis as any).__groupEpisodeRecoveryRetries = groupEpisodeRecoveryRetries
  ;(globalThis as any).__isVerifiedRecoveredSubtitleJob = isVerifiedRecoveredSubtitleJob
  ;(globalThis as any).__jobDisplayStatus = jobDisplayStatus
  ;(globalThis as any).__filterJobsForView = filterJobsForView
  const Jobs = await loadJobs()
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(Jobs)
  app.mount(host)
  await nextTick()
  return { state: (globalThis as any).__jobsState, posts, projectQueue, universalQueue, unmount: () => { app.unmount(); host.remove() } }
}

test('mounted Jobs finishes missing images directly and Retry all keeps continuity rows in the queue', async () => {
  const mounted = await mount([
    { job_id: 'manual-finish', project_slug: 'fixture-project', episode_id: 'EP0001', type: 'continuity_render', status: 'error', params: { manual_image_finish: {} } },
    { job_id: 'eligible', project_slug: 'fixture-project', episode_id: 'EP0002', type: 'scene_clip_generate', status: 'error', params: {} },
    { job_id: 'ordinary-continuity', project_slug: 'fixture-project', episode_id: 'EP0003', type: 'continuity_render', status: 'error', params: {} },
  ])
  assert.equal(mounted.state.isTerminalContinuityRender(mounted.state.jobs.value[2]), true)
  assert.equal(mounted.state.isTerminalContinuityRender({ ...mounted.state.jobs.value[2], status: 'done' }), false)
  await mounted.state.finishMissingImages(mounted.state.jobs.value[0])
  assert.deepEqual(mounted.posts[0], { path: '/projects/fixture-project/jobs/manual-finish/finish-missing-images', body: {} })
  assert.equal(mounted.state.jobs.value.length, 3, 'the same row changes state; no duplicate is added')
  assert.equal(mounted.state.jobs.value[0].status, 'queued')
  assert.equal(mounted.projectQueue.calls.length, 1, 'the project readonly store receives the confirmed row')
  assert.equal(mounted.universalQueue.calls.length, 1, 'the all-project readonly store receives the confirmed row')
  assert.equal(mounted.projectQueue.stats.value.queued, 1, 'the visible queue statistics update before SSE arrives')
  assert.equal(mounted.state.statusFilter.value, 'queued')

  const failedAgain = { ...mounted.state.jobs.value[0], status: 'error' }
  mounted.projectQueue.applyUpdate(failedAgain)
  mounted.universalQueue.applyUpdate(failedAgain)
  mounted.state.statusFilter.value = 'error'
  assert.deepEqual(mounted.state.failedJobsForRetryAll.value.map((job: any) => job.job_id), ['manual-finish', 'eligible', 'ordinary-continuity'])
  await mounted.state.retryAllFailed()
  assert.deepEqual(mounted.posts.map(call => call.path), [
    '/projects/fixture-project/jobs/manual-finish/finish-missing-images',
    '/projects/fixture-project/jobs/manual-finish/finish-missing-images',
    '/projects/fixture-project/jobs/ordinary-continuity/finish-missing-images',
    '/projects/fixture-project/jobs/eligible/retry',
  ])
  assert.match(source, /async function finishMissingImages/)
  assert.match(source, /await post<\{ job: Job \}>\(`\$\{jobQueuePath\(job\)\}\/finish-missing-images`, \{\}\)/)
  assert.match(source, /projectQueue\.applyUpdate\(next\)/)
  assert.match(source, /universalQueue\.applyUpdate\(next\)/)
  assert.match(source, /statusFilter\.value = next\.status === 'running' \? 'running' : 'queued'/)
  assert.match(source, /controlBusy\.has\(job\.job_id\) \? 'Queuing…' : 'Finish missing images'/)
  assert.match(source, /v-if="isTerminalContinuityRender\(job\)"/)
  assert.match(source, /<button[\s\S]*?v-if="isTerminalContinuityRender\(job\)"[\s\S]*?@click="finishMissingImages\(job\)"/)
  mounted.unmount()
})

test('mounted Jobs keeps one Finish request busy until its same row returns', async () => {
  let settlePost: ((value: unknown) => void) | undefined
  const mounted = await mount([
    { job_id: 'manual-finish', project_slug: 'fixture-project', episode_id: 'EP0001', type: 'continuity_render', status: 'error', params: {} },
  ], () => new Promise(resolve => { settlePost = resolve }))
  try {
    const first = mounted.state.finishMissingImages(mounted.state.jobs.value[0])
    assert.equal(await mounted.state.finishMissingImages(mounted.state.jobs.value[0]), false)
    assert.equal(mounted.posts.length, 1, 'a second click must not submit a second Finish request')
    settlePost?.({ job: { ...mounted.state.jobs.value[0], status: 'queued' } })
    assert.equal(await first, true)
    assert.equal(mounted.state.jobs.value[0].status, 'queued')
  } finally { mounted.unmount() }
})

test('mounted Jobs leaves a rejected Finish row in Needs attention', async () => {
  const mounted = await mount([
    { job_id: 'manual-finish', project_slug: 'fixture-project', episode_id: 'EP0001', type: 'continuity_render', status: 'error', params: {} },
  ], async () => { throw new Error('The existing provider request needs reconciliation.') })
  try {
    mounted.state.statusFilter.value = 'error'
    assert.equal(await mounted.state.finishMissingImages(mounted.state.jobs.value[0]), false)
    assert.equal(mounted.state.jobs.value.length, 1)
    assert.equal(mounted.state.jobs.value[0].status, 'error')
    assert.equal(mounted.state.statusFilter.value, 'error')
  } finally { mounted.unmount() }
})

test('mounted Jobs counts and filters verified recovery separately from attention', async () => {
  const recovered = {
    job_id: 'recovered-subtitles', project_slug: 'fixture-project', episode_id: 'SS0080',
    type: 'subtitles_transcribe', status: 'error', params: {
      episode_recovery_id: 'plan-1',
      episode_recovery: { id: 'plan-1', completed: ['audio_merge', 'subtitle_sections', 'subtitle_stitch'], first_unresolved: 'scene_plan_run' },
    },
  }
  const needsAttention = { job_id: 'still-failed', project_slug: 'fixture-project', episode_id: 'SS0081', type: 'audio', status: 'error', params: {} }
  const mounted = await mount([recovered, needsAttention])
  try {
    assert.equal(mounted.state.stats.value.error, 1)
    assert.equal(mounted.state.stats.value.recovered, 1)
    assert.equal(mounted.state.statusFilters.value.find((item: any) => item.key === 'error')?.count, 1)
    assert.equal(mounted.state.statusFilters.value.find((item: any) => item.key === 'recovered')?.count, 1)
    mounted.state.statusFilter.value = 'error'
    await nextTick()
    assert.deepEqual(mounted.state.filteredJobs.value.map((job: any) => job.job_id), ['still-failed'])
    mounted.state.statusFilter.value = 'recovered'
    await nextTick()
    assert.deepEqual(mounted.state.filteredJobs.value.map((job: any) => job.job_id), ['recovered-subtitles'])
    assert.deepEqual(mounted.state.failedJobsForRetryAll.value.map((job: any) => job.job_id), ['still-failed'])
  } finally { mounted.unmount() }
})
