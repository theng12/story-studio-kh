import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createApp, h, nextTick, readonly, ref, type Component } from 'vue'
import { compileScript, parse } from '@vue/compiler-sfc'
import { transform } from 'esbuild'
import { describeEpisodeAssetRecovery, recoverEpisodeAssets } from '../utils/job-asset-recovery'
import { groupEpisodeRecoveryRetries, isEpisodeRecoveryType, isRecoveredFailure, isSkippedJob, isVerifiedRecoveredSubtitleJob, jobDisplayStatus } from '../utils/episode-recovery'
import { customerSafeJobText, filterJobsForView, jobDisplayLabel, jobsEmptyState, jobTypeLabel, retryAdmissionAllowed } from '../utils/job-presentation'

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
    const useRoute = () => globalThis.__jobsRoute
    const useRouter = () => ({ replace: async () => undefined })
    const useConfirm = () => ({ ask: async () => true })
    const useViewMode = (key, fallback = 'cards') => ref(localStorage.getItem(key) === 'list' ? 'list' : fallback)
      const useApi = () => globalThis.__jobsApi

      const ViewModeToggle = { name: 'ViewModeToggle', props: ['modelValue', 'label'], emits: ['update:modelValue'], render() { return null } }
      const GroupedWarnings = { name: 'GroupedWarnings', props: ['groups', 'warnings', 'label'], render() { return null } }
    const useJobs = () => globalThis.__jobsProjectQueue
    const useAllJobs = () => globalThis.__jobsUniversalQueue
    // Fixture jobs carry their full evidence, so the per-job detail merge is the identity here.
    const useJobDetails = () => ({ ensure() {}, withDetail: job => job, stop() {} })
    // The finished half of the universal list is a server read; these fixtures are
    // project-scoped, where the stream itself still carries the whole list.
    const useJobHistory = () => ({ rows: ref([]), total: ref(0), loading: ref(false), error: ref(''), load: async () => undefined, invalidate() {}, removeIds() {}, reset() {} })
    const useGenStudioModelDisplay = () => ({ displayName: () => '', refresh: async () => undefined })
    const useToast = () => globalThis.__jobsToast
    const useNetworkStatus = () => ({ online: ref(true) })
    const createVisibleInterval = (tick, ms) => { let t = null; return { start() { t ||= setInterval(tick, ms) }, stop() { if (t) clearInterval(t); t = null } } }
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
    const customerSafeJobText = globalThis.__customerSafeJobText
    const filterJobsForView = globalThis.__filterJobsForView
    const isVerifiedLiveCapacity = () => false
    const jobRequestIds = () => []
    const primaryControl = () => null
    const secondaryControls = () => []
    const formatCredits = () => ''
    const recoverEpisodeAssets = globalThis.__recoverEpisodeAssets
    const describeEpisodeAssetRecovery = globalThis.__describeEpisodeAssetRecovery
    const isEpisodeRecoveryType = globalThis.__isEpisodeRecoveryType
    const groupEpisodeRecoveryRetries = globalThis.__groupEpisodeRecoveryRetries
    const isVerifiedRecoveredSubtitleJob = globalThis.__isVerifiedRecoveredSubtitleJob
    const isRecoveredFailure = globalThis.__isRecoveredFailure
    const isSkippedJob = globalThis.__isSkippedJob
    const jobDisplayStatus = globalThis.__jobDisplayStatus
    const jobTypeLabel = globalThis.__jobTypeLabel
    const jobDisplayLabel = globalThis.__jobDisplayLabel
    const jobsEmptyState = globalThis.__jobsEmptyState
    const retryAdmissionAllowed = globalThis.__retryAdmissionAllowed
    import { bulkConfirmOptions, capList, controlLabel, deriveOutputDir, episodeQueryValue, isPaidWork, matchesEpisodeSearch, orderJobsForDisplay, pageCount, pageSlice, rowOutputLineCount, rowProgressCounter, rowSummaryLine } from ${JSON.stringify(new URL('../utils/jobs-list.ts', import.meta.url).href)}
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

async function mount(
  jobs: any[],
  postReply?: (path: string, body: unknown) => Promise<unknown>,
  routeQuery: Record<string, string> = {},
) {
  const posts: Array<{ path: string; body: unknown }> = []
  const toasts: Array<{ kind: 'success' | 'error' | 'info'; message: string }> = []
  function makeReadonlyQueue(seed: any[]) {
    const jobRows = ref(seed)
    const queueStats = ref({ running: 0, queued: 0, paused: 0, done: 0, error: 0, total: 0 })
    const jobsStale = ref(false)
    const lastRefreshError = ref('')
    let refreshCalls = 0
    let fetchCalls = 0
    const refreshStats = () => {
      const next = { running: 0, queued: 0, paused: 0, done: 0, error: 0, total: jobRows.value.length }
      for (const job of jobRows.value) if (job.status in next) (next as any)[job.status]++
      queueStats.value = next
    }
    const calls: any[] = []
    refreshStats()
    return {
      jobs: readonly(jobRows), stats: readonly(queueStats), isLoading: readonly(ref(false)), jobsStale: readonly(jobsStale), lastRefreshError: readonly(lastRefreshError), jobsStaleState: jobsStale, lastRefreshErrorState: lastRefreshError, calls,
      applyUpdate(next: any) {
        calls.push(next)
        const rows = [...jobRows.value]
        const index = rows.findIndex(job => job.job_id === next.job_id)
        if (index >= 0) rows[index] = next
        else rows.unshift(next)
        jobRows.value = rows
        refreshStats()
      },
      replaceJob(replacedJobId: string, next: any) {
        calls.push(next)
        const rows = jobRows.value.filter(job => job.job_id !== replacedJobId)
        const index = rows.findIndex(job => job.job_id === next.job_id)
        if (index >= 0) rows[index] = next
        else rows.unshift(next)
        jobRows.value = rows
        refreshStats()
      },
      start: () => undefined, stop: () => undefined,
      refresh: async () => { refreshCalls++ },
      fetchJobs: async () => { fetchCalls++ },
      transportCalls: () => ({ refreshCalls, fetchCalls }),
    }
  }
  const projectQueue = makeReadonlyQueue(jobs)
  const universalQueue = makeReadonlyQueue(jobs)
  ;(globalThis as any).__jobsRoute = { params: { slug: 'fixture-project' }, query: routeQuery }
  ;(globalThis as any).__jobsProjectQueue = projectQueue
  ;(globalThis as any).__jobsUniversalQueue = universalQueue
  ;(globalThis as any).__jobsApi = {
    get: async (path: string) => path === '/projects' ? [] : {}, del: async () => ({}), put: async () => ({}),
    post: async (path: string, body: unknown) => {
      posts.push({ path, body })
      if (postReply) return postReply(path, body)
      const jobId = path.match(/\/jobs\/([^/]+)\/finish-missing-images$/)?.[1]
      const existing = jobId ? jobs.find(job => job.job_id === jobId) : null
      return existing ? { ok: true, job: { ...existing, status: 'queued' } } : {}
    },
  }
  ;(globalThis as any).__jobsToast = {
    success: (message: string) => { toasts.push({ kind: 'success', message }) },
    error: (message: string) => { toasts.push({ kind: 'error', message }) },
    info: (message: string) => { toasts.push({ kind: 'info', message }) },
  }
  ;(globalThis as any).__isEpisodeRecoveryType = isEpisodeRecoveryType
  ;(globalThis as any).__recoverEpisodeAssets = recoverEpisodeAssets
  ;(globalThis as any).__describeEpisodeAssetRecovery = describeEpisodeAssetRecovery
  ;(globalThis as any).__groupEpisodeRecoveryRetries = groupEpisodeRecoveryRetries
  ;(globalThis as any).__isVerifiedRecoveredSubtitleJob = isVerifiedRecoveredSubtitleJob
  ;(globalThis as any).__isRecoveredFailure = isRecoveredFailure
  ;(globalThis as any).__isSkippedJob = isSkippedJob
  ;(globalThis as any).__jobDisplayStatus = jobDisplayStatus
  ;(globalThis as any).__filterJobsForView = filterJobsForView
  ;(globalThis as any).__customerSafeJobText = customerSafeJobText
  ;(globalThis as any).__jobTypeLabel = jobTypeLabel
  ;(globalThis as any).__jobDisplayLabel = jobDisplayLabel
  ;(globalThis as any).__jobsEmptyState = jobsEmptyState
  ;(globalThis as any).__retryAdmissionAllowed = retryAdmissionAllowed
  const Jobs = await loadJobs()
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(Jobs)
  app.mount(host)
  await nextTick()
  return { state: (globalThis as any).__jobsState, posts, toasts, projectQueue, universalQueue, unmount: () => { app.unmount(); host.remove() } }
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
  assert.match(source, /controlBusy\.has\(job\.job_id\) \? 'Queuing…' : 'Finish Missing Images'/)
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

test('mounted Retry all shares three workers, reports progress, ignores repeat clicks, and keeps its starting scope', async () => {
  const waiting = new Map<string, (value: unknown) => void>()
  const projectA = [
    { job_id: 'episode-one', project_slug: 'project-a', episode_id: 'EP0001', type: 'audio_merge', status: 'error', params: {} },
    { job_id: 'episode-one-tail', project_slug: 'project-a', episode_id: 'EP0001', type: 'scene_plan_run', status: 'error', params: {} },
    { job_id: 'episode-two', project_slug: 'project-a', episode_id: 'EP0002', type: 'scene_plan_run', status: 'error', params: {} },
    { job_id: 'episode-three', project_slug: 'project-a', episode_id: 'EP0003', type: 'contextual_cues', status: 'error', params: {} },
    { job_id: 'ordinary-four', project_slug: 'project-a', episode_id: 'EP0004', type: 'thumb_images', status: 'error', params: {} },
  ]
  const mounted = await mount([
    ...projectA,
    { job_id: 'outside-scope', project_slug: 'project-b', episode_id: 'EP0099', type: 'audio_merge', status: 'error', params: {} },
  ], path => new Promise(resolve => { waiting.set(path, resolve) }), { scope: 'all' })
  let retry: Promise<boolean> | undefined
  try {
    mounted.state.projectFilter.value = 'project-a'
    await nextTick()
    retry = mounted.state.retryAllFailed()
    await nextTick()

    assert.equal(mounted.posts.length, 3, 'grouped and ordinary actions share one three-request ceiling')
    assert.deepEqual(mounted.posts[0], {
      path: '/projects/project-a/jobs/recover-episode/EP0001',
      body: { source_job_ids: ['episode-one', 'episode-one-tail'] },
    }, 'dependent rows from the same episode remain one server-owned request')
    assert.deepEqual(mounted.state.retryAllCurrentEpisodes.value, [
      'project-a / EP0001', 'project-a / EP0002', 'project-a / EP0003',
    ])
    assert.equal(mounted.state.retryAllRun.value.completed, 0)
    assert.equal(mounted.state.retryAllRun.value.total, 4)
    assert.equal(mounted.state.retryAllButtonLabel.value, 'Retrying 0/4…')
    assert.equal(mounted.state.retryAllStatusMessage.value, 'Retry Failed Jobs: 0 of 4 finished · working on project-a / EP0001, project-a / EP0002, project-a / EP0003.')
    assert.equal(await mounted.state.retryAllFailed(), false, 'a repeated click cannot start a second snapshot')
    assert.equal(mounted.posts.length, 3)

    mounted.state.projectFilter.value = 'all'
    waiting.get('/projects/project-a/jobs/recover-episode/EP0001')?.({
      plan: { dispatch_status: 'queued', dispatch_job_id: 'dispatch-one', message: 'EP0001 queued.' },
    })
    await Promise.resolve()
    await nextTick()
    assert.equal(mounted.posts.length, 4, 'the freed worker starts the ordinary retry immediately')
    assert.equal(mounted.state.retryAllRun.value.completed, 1)
    assert.deepEqual(mounted.state.retryAllCurrentEpisodes.value, [
      'project-a / EP0002', 'project-a / EP0003', 'project-a / EP0004',
    ])

    waiting.get('/projects/project-a/jobs/recover-episode/EP0002')?.({
      plan: { dispatch_status: 'running', dispatch_job_id: 'dispatch-two', message: 'EP0002 already running.' },
    })
    waiting.get('/projects/project-a/jobs/recover-episode/EP0003')?.({
      plan: { dispatch_status: 'complete', message: 'EP0003 was already complete.' },
    })
    waiting.get('/projects/project-a/jobs/ordinary-four/retry')?.({
      job: { ...projectA[4], job_id: 'ordinary-four-retry', status: 'queued' },
    })
    assert.equal(await retry, true)
    assert.deepEqual(mounted.state.retryAllCounts.value, { sent: 3, alreadyComplete: 1, needsAttention: 0 })
    assert.equal(mounted.state.bulkActionMessage.value, 'Retry Failed Jobs finished: 3 queued or running; 1 already complete; 0 need attention. Original failed rows may remain in history.')
    assert.equal(mounted.state.retryAllStatusMessage.value, mounted.state.bulkActionMessage.value, 'the final counts remain visible after the workers finish')
    assert.equal(mounted.posts.some(call => call.path.includes('project-b')), false, 'changing the filter does not widen the active snapshot')
    assert.deepEqual(mounted.universalQueue.transportCalls(), { refreshCalls: 1, fetchCalls: 0 }, 'the visible queue refreshes once after the snapshot settles')
  } finally {
    // An early assertion must not strand the mounted page's workers or timers.
    for (let pass = 0; pass < projectA.length; pass++) {
      for (const [path, resolve] of waiting) {
        resolve(path.endsWith('/retry')
          ? { job: { ...projectA[4], job_id: 'ordinary-four-cleanup', status: 'queued' } }
          : { plan: { dispatch_status: 'blocked', message: 'Test cleanup.' } })
        waiting.delete(path)
      }
      await Promise.resolve()
    }
    await retry?.catch(() => undefined)
    mounted.unmount()
  }
})

test('mounted Retry all classifies every recovery plan and continues after failures', async () => {
  const mounted = await mount([
    { job_id: 'first-episode', project_slug: 'fixture-project', episode_id: 'EP0001', type: 'audio_merge', status: 'error', params: {} },
    { job_id: 'second-episode', project_slug: 'fixture-project', episode_id: 'EP0002', type: 'scene_plan_run', status: 'error', params: {} },
    { job_id: 'paused-episode', project_slug: 'fixture-project', episode_id: 'EP0003', type: 'contextual_cues', status: 'error', params: {} },
    { job_id: 'blocked-episode', project_slug: 'fixture-project', episode_id: 'EP0004', type: 'audio_merge', status: 'error', params: {} },
    { job_id: 'complete-episode', project_slug: 'fixture-project', episode_id: 'EP0005', type: 'scene_plan_run', status: 'error', params: {} },
    { job_id: 'unconfirmed-episode', project_slug: 'fixture-project', episode_id: 'EP0006', type: 'audio_merge', status: 'error', params: {} },
    { job_id: 'ordinary-failure', project_slug: 'fixture-project', episode_id: 'EP0007', type: 'audio', status: 'error', params: {} },
  ], async (path) => {
    if (path.endsWith('/EP0001')) throw new Error('The first provider request still needs reconciliation.')
    if (path.endsWith('/EP0002')) return { plan: { dispatch_status: 'queued', dispatch_job_id: 'queued-two', message: 'EP0002 queued.' } }
    if (path.endsWith('/EP0003')) return { plan: { dispatch_status: 'paused', dispatch_job_id: 'paused-three', message: 'Resume the queue to continue EP0003.' } }
    if (path.endsWith('/EP0004')) return { plan: { dispatch_status: 'blocked', message: 'EP0004 needs a subtitle choice for blocked-episode.' } }
    if (path.endsWith('/EP0005')) return { plan: { dispatch_status: 'complete', message: 'EP0005 already has every output.' } }
    if (path.endsWith('/EP0006')) return { plan: { message: 'Legacy 202 response without a dispatch result.' } }
    if (path.endsWith('/ordinary-failure/retry')) throw new Error('The independent retry was rejected.')
    throw new Error(`unexpected request: ${path}`)
  })
  try {
    await mounted.state.retryAllFailed()
    assert.deepEqual(mounted.posts.map(call => call.path).sort(), [
      '/projects/fixture-project/jobs/recover-episode/EP0001',
      '/projects/fixture-project/jobs/recover-episode/EP0002',
      '/projects/fixture-project/jobs/recover-episode/EP0003',
      '/projects/fixture-project/jobs/recover-episode/EP0004',
      '/projects/fixture-project/jobs/recover-episode/EP0005',
      '/projects/fixture-project/jobs/recover-episode/EP0006',
      '/projects/fixture-project/jobs/ordinary-failure/retry',
    ].sort(), 'one failed worker action does not prevent later actions from starting')
    assert.deepEqual(mounted.state.retryAllCounts.value, { sent: 1, alreadyComplete: 1, needsAttention: 5 })
    assert.deepEqual(mounted.state.retryAllAttentionResults.value.map((result: any) => [result.label, result.reason]), [
      ['EP0001', 'The first provider request still needs reconciliation.'],
      ['EP0003', 'Resume the queue to continue EP0003.'],
      ['EP0004', 'EP0004 needs a subtitle choice for [request hidden].'],
      ['EP0006', 'Legacy 202 response without a dispatch result.'],
      ['EP0007', 'Story Studio could not confirm this retry was queued.'],
    ])
    assert.deepEqual(mounted.toasts[mounted.toasts.length - 1], {
      kind: 'error',
      message: 'Retry Failed Jobs finished: 1 queued or running; 1 already complete; 5 need attention. Original failed rows may remain in history.',
    })
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

test('mounted Jobs recovers only the selected episode’s saved assets without navigation or retry', async () => {
  const mounted = await mount([
    { job_id: 'target-assembly', project_slug: 'fixture-project', episode_id: 'SS0077', type: 'audio_merge', status: 'error', params: {} },
    // Both eligible rows represent one episode intent; the update reaches both
    // cards, but the recovery request must still be made exactly once.
    { job_id: 'target-video', project_slug: 'fixture-project', episode_id: 'SS0077', type: 'video_assembly', status: 'cancelled', params: {} },
    { job_id: 'other-assembly', project_slug: 'fixture-project', episode_id: 'SS0078', type: 'audio_merge', status: 'error', params: {} },
  ], async (path) => {
    if (path.endsWith('/assets/repair-all')) {
      return { audited_episode_codes: ['SS0077'], enqueued: [], skipped: [], audio_repair_candidates: ['SS0077'] }
    }
    if (path.endsWith('/SS0077/audio-repair')) return { recovered: 1, still_missing: 0, total_expected: 1 }
    throw new Error(`unexpected request: ${path}`)
  })
  try {
    const target = mounted.state.jobs.value[0]
    assert.equal(mounted.state.canRecoverEpisode(target), true)
    assert.equal(mounted.state.canRecoverEpisode(mounted.state.jobs.value[2]), true)
    assert.equal((await mounted.state.recoverEpisode(target))?.episodeId, 'SS0077')
    assert.deepEqual(mounted.posts, [
      { path: '/projects/fixture-project/assets/repair-all', body: { episode_codes: ['SS0077'] } },
      { path: '/projects/fixture-project/episodes/SS0077/audio-repair', body: {} },
    ])
    assert.equal(mounted.state.repairOutcome.value['target-assembly']?.kind, 'ok')
    assert.equal(mounted.state.repairOutcome.value['target-video']?.kind, 'ok')
    assert.equal(mounted.state.repairOutcome.value['other-assembly'], undefined)
    assert.equal(mounted.posts.some(call => /board\?repair|recover-episode|\/retry|\/generate\//.test(call.path)), false)
  } finally { mounted.unmount() }
})

test('mounted Jobs holds a duplicate episode click until its free recovery settles', async () => {
  let settle: ((value: unknown) => void) | undefined
  const mounted = await mount([
    { job_id: 'target-assembly', project_slug: 'fixture-project', episode_id: 'SS0077', type: 'audio_merge', status: 'error', params: {} },
    { job_id: 'target-video', project_slug: 'fixture-project', episode_id: 'SS0077', type: 'video_assembly', status: 'cancelled', params: {} },
  ], async (path) => {
    if (path.endsWith('/assets/repair-all')) return new Promise(resolve => { settle = resolve })
    return { recovered: 0, still_missing: 0, total_expected: 0 }
  })
  try {
    const first = mounted.state.recoverEpisode(mounted.state.jobs.value[0])
    assert.equal(await mounted.state.recoverEpisode(mounted.state.jobs.value[1]), null)
    assert.equal(mounted.posts.length, 1, 'a duplicate episode row must not begin another recovery')
    settle?.({ audited_episode_codes: ['SS0077'], enqueued: [], skipped: [], audio_repair_candidates: [] })
    assert.equal((await first)?.episodeId, 'SS0077')
    assert.equal(mounted.posts.length, 1)
  } finally { mounted.unmount() }
})

test('mounted Jobs scopes metrics, keeps paused type counts, and clamps history after an SSE update', async () => {
  const history = Array.from({ length: 11 }, (_, index) => ({
    job_id: `history-${index}`,
    project_slug: 'other-project',
    episode_id: `EP${index}`,
    type: 'music_generate',
    status: 'done',
    params: {},
  }))
  const selected = {
    job_id: 'selected-paused', project_slug: 'fixture-project', episode_id: 'EP-selected',
    type: 'music_generate', status: 'paused', params: {},
  }
  const mounted = await mount([...history, selected], undefined, { scope: 'all' })
  try {
    mounted.state.projectFilter.value = 'fixture-project'
    await nextTick()
    assert.equal(mounted.state.stats.value.paused, 1)
    assert.equal(mounted.state.stats.value.done, 0)
    assert.equal(mounted.state.filterTabs.value.find((tab: any) => tab.type === 'music_generate')?.label, 'Music generation')
    assert.equal(mounted.state.filterTabs.value.find((tab: any) => tab.type === 'music_generate')?.count, 1)

    mounted.state.projectFilter.value = 'all'
    mounted.state.currentPage.value = 2
    mounted.universalQueue.applyUpdate({ ...history[10], status: 'queued' })
    await nextTick()
    assert.equal(mounted.state.historyTotalPages.value, 1)
    assert.equal(mounted.state.currentPage.value, 1)
  } finally { mounted.unmount() }
})

test('mounted Jobs retries non-episode rows through the queue and retains failures', async () => {
  const staleThumbnail = {
    job_id: 'thumbnail-stale', project_slug: 'fixture-project', episode_id: 'EP0001',
    type: 'thumb_images', status: 'error', params: { obsolete: 'must-not-be-reposted', force: true },
  }
  let resolveRetry: ((value: unknown) => void) | undefined
  const mounted = await mount([staleThumbnail], (path, body) => {
    assert.equal(path, '/projects/fixture-project/jobs/thumbnail-stale/retry')
    assert.deepEqual(body, {})
    return new Promise(resolve => { resolveRetry = resolve })
  })
  try {
    assert.equal(mounted.state.canRetryJob({ ...staleThumbnail, controls: [{ action: 'return-later', enabled: true }] }), false)
    assert.equal(mounted.state.canRetryJob({ ...staleThumbnail, controls: [{ action: 'recheck-provider-status', enabled: true }] }), false)
    for (const type of ['outline_only', 'expand_chapters']) {
      assert.equal(
        mounted.state.canRetryJob({ ...staleThumbnail, type, controls: [{ action: 'recheck-provider-status', enabled: true }] }),
        true,
        `${type} keeps Retry for the server-owned exact replay of saved chat evidence`,
      )
    }
    assert.equal(mounted.state.canRetryJob(staleThumbnail), true)
    const first = mounted.state.retryJob(mounted.state.jobs.value[0])
    assert.equal(await mounted.state.retryJob(mounted.state.jobs.value[0]), false, 'busy retry does not issue a second request')
    assert.equal(mounted.posts.length, 1)
    resolveRetry?.({ job: {
      ...staleThumbnail,
      job_id: 'thumbnail-retry-1',
      status: 'queued',
      params: { server_owned: true },
    } })
    assert.equal(await first, true)
    assert.deepEqual(mounted.state.jobs.value.map((job: any) => job.job_id), ['thumbnail-retry-1'])
    assert.equal(mounted.state.jobs.value[0].status, 'queued')
    assert.equal(mounted.projectQueue.calls.length, 1)
    assert.equal(mounted.universalQueue.calls.length, 1)
  } finally { mounted.unmount() }

  const legacyImages = { ...staleThumbnail, job_id: 'legacy-images-thumbnail', type: 'images', params: {} }
  const legacy = await mount([legacyImages], async () => ({
    job: { ...legacyImages, job_id: 'legacy-thumbnail-retry', type: 'thumb_images', status: 'queued' },
  }))
  try {
    assert.equal(await legacy.state.retryJob(legacy.state.jobs.value[0]), true)
    assert.deepEqual(legacy.state.jobs.value.map((job: any) => job.job_id), ['legacy-thumbnail-retry'])
    assert.equal(legacy.state.jobs.value[0].type, 'thumb_images')
  } finally { legacy.unmount() }

  const mismatched = await mount([staleThumbnail], async () => ({
    job: { ...staleThumbnail, job_id: 'wrong-episode-retry', episode_id: 'EP0002', status: 'queued' },
  }))
  try {
    assert.equal(await mismatched.state.retryJob(mismatched.state.jobs.value[0]), false)
    assert.deepEqual(mismatched.state.jobs.value.map((job: any) => job.job_id), ['thumbnail-stale'])
    assert.equal(mismatched.projectQueue.calls.length, 0)
    assert.equal(mismatched.universalQueue.calls.length, 0)
  } finally { mismatched.unmount() }

  const rejected = await mount([staleThumbnail], async () => { throw new Error('Retry is not available yet.') })
  try {
    assert.equal(await rejected.state.retryJob(rejected.state.jobs.value[0]), false)
    assert.equal(rejected.state.jobs.value.length, 1)
    assert.equal(rejected.state.jobs.value[0].status, 'error')
  } finally { rejected.unmount() }
})

test('mounted Jobs exposes stale state from the selected queue and refreshes that queue', async () => {
  const mounted = await mount([])
  try {
    mounted.projectQueue.jobsStaleState.value = true
    mounted.projectQueue.lastRefreshErrorState.value = 'The live stream was interrupted.'
    await nextTick()
    assert.equal(mounted.state.jobsStale.value, true)
    assert.equal(mounted.state.jobsRefreshMessage.value, 'The live stream was interrupted.')
    await mounted.state.refreshVisibleJobs()
    assert.deepEqual(mounted.projectQueue.transportCalls(), { refreshCalls: 0, fetchCalls: 1 })
  } finally { mounted.unmount() }
})
