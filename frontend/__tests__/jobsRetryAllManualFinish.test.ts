import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createApp, h, nextTick, ref, type Component } from 'vue'
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
    const useJobs = () => globalThis.__jobsQueue
    const useAllJobs = () => globalThis.__jobsQueue
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

async function mount(jobs: any[]) {
  const posts: Array<{ path: string; body: unknown }> = []
  const queueStats = { running: 0, queued: 0, paused: 0, done: 0, error: 0, total: jobs.length }
  for (const job of jobs) if (job.status in queueStats) (queueStats as any)[job.status]++
  ;(globalThis as any).__jobsQueue = {
    jobs: ref(jobs), stats: ref(queueStats), start: () => undefined, stop: () => undefined,
  }
  ;(globalThis as any).__jobsApi = {
    get: async () => ({}), del: async () => ({}), put: async () => ({}),
    post: async (path: string, body: unknown) => { posts.push({ path, body }); return {} },
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
  return { state: (globalThis as any).__jobsState, posts, unmount: () => { app.unmount(); host.remove() } }
}

test('mounted Jobs Retry all withholds manual Finish rows while preserving ordinary continuity recovery', async () => {
  const mounted = await mount([
    { job_id: 'manual-finish', project_slug: 'fixture-project', episode_id: 'EP0001', type: 'continuity_render', status: 'error', params: { manual_image_finish: {} } },
    { job_id: 'eligible', project_slug: 'fixture-project', episode_id: 'EP0002', type: 'scene_clip_generate', status: 'error', params: {} },
    { job_id: 'ordinary-continuity', project_slug: 'fixture-project', episode_id: 'EP0003', type: 'continuity_render', status: 'error', params: {} },
  ])
  assert.deepEqual(mounted.state.manualFinishRetryWithheld.value.map((job: any) => job.job_id), ['manual-finish'])
  assert.equal(mounted.state.isTerminalContinuityRender(mounted.state.jobs.value[2]), true)
  assert.equal(mounted.state.isManualFinishContinuityRender(mounted.state.jobs.value[2]), false)
  assert.deepEqual(mounted.state.failedJobsForRetryAll.value.map((job: any) => job.job_id), ['eligible', 'ordinary-continuity'])
  assert.deepEqual(groupEpisodeRecoveryRetries(mounted.state.failedJobsForRetryAll.value).episodes, [{
    project_slug: 'fixture-project', episode_id: 'EP0003', source_job_ids: ['ordinary-continuity'],
  }])
  await mounted.state.retryAllFailed()
  assert.deepEqual(mounted.posts.map(call => call.path), [
    '/projects/fixture-project/jobs/recover-episode/EP0003',
    '/projects/fixture-project/jobs/eligible/retry',
  ])
  assert.match(source, /Finish missing images stays in Scene Review/)
  assert.match(source, /Open \{\{ isUniversal.*job\.episode_id \}\} in Scene Review/)
  assert.match(source, /v-if="isTerminalContinuityRender\(job\)"/)
  assert.match(source, /!isTerminalContinuityRender\(job\).*auto_repair_missing_prompts/)
  mounted.unmount()
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
