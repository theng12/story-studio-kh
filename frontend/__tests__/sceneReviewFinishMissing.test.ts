import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createApp, h, nextTick, reactive, ref, unref, type Component } from 'vue'
import { compileScript, parse } from '@vue/compiler-sfc'
import { transform } from 'esbuild'

const pagePath = fileURLToPath(new URL('../pages/projects/[slug]/scene-review.vue', import.meta.url))
const source = readFileSync(pagePath, 'utf8')

type JobFixture = {
  job_id: string
  type: string
  episode_id: string
  status: string
  created_at: string
  params?: Record<string, unknown>
}

async function loadSceneReview(): Promise<Component> {
  const { descriptor } = parse(source, { filename: pagePath })
  const script = compileScript(descriptor, { id: 'scene-review-finish-missing' })
  const vueUrl = await import.meta.resolve('vue')
  const freshActionUrl = await import.meta.resolve('../composables/useFreshGenerationAction.ts')
  const support = `
    import { computed, defineComponent as _defineComponent, h, nextTick, onBeforeUnmount, onMounted, ref, unref } from ${JSON.stringify(vueUrl)}
    import { useFreshGenerationAction } from ${JSON.stringify(freshActionUrl)}
    const watch = () => () => undefined
    const definePageMeta = () => undefined
    const useAppTitle = () => undefined
    const useRoute = () => globalThis.__sceneReviewRoute
    const useRouter = () => ({ push: () => undefined, replace: () => undefined })
    const useProject = () => ({ config: ref({ image_models: {} }) })
    const useApi = () => globalThis.__sceneReviewApi
    const useToast = () => ({ success: () => undefined, error: (message) => globalThis.__sceneReviewErrors.push(message), info: () => undefined })
    const useConfirm = () => ({ ask: (options) => globalThis.__sceneReviewAsk(options) })
    const useEpisodes = () => ({ updateEpisode: () => undefined, revalidateAfterMutation: () => undefined })
    const useRememberedForm = () => undefined
    const usePresets = () => ({ load: async () => undefined })
    const useGenStudioImageModels = () => ({ models: ref([]), refresh: async () => undefined })
    const useJobs = () => ({
      jobs: globalThis.__sceneReviewJobs,
      isJobActiveFor: (episodeId, types) => globalThis.__sceneReviewJobs.value.some(job =>
        job.episode_id === episodeId && ['queued', 'running', 'paused'].includes(job.status) && (!types || types.includes(job.type))),
    })
    const resolveActiveSceneRenderJob = (episodeId, cached, jobs) => jobs.find(job =>
      job.episode_id === episodeId && ['queued', 'running', 'paused'].includes(job.status)) || null
    const findOutputOption = () => null
    const publishedOutputOptions = () => []
    const describeImageUnitCost = () => ({ basis: 'unpublished', text: 'Not published', title: '' })
    const CREDIT_BASIS_LABEL = { unpublished: 'Credit cost' }
    const findGenStudioProduct = () => null
    const customerSafeJobText = (value) => String(value || '')
    const jobRequestIds = () => []
  `
  const content = script.content
    .replace(/^import[\s\S]*?from ['"][^'"]+['"];?\n/gm, '')
    .replace('export default', 'const __sfc__ =')
  const out = await transform(`${support}\n${content}\nconst __setup = __sfc__.setup
    __sfc__.setup = function (props, context) {
      const state = __setup(props, context)
      globalThis.__sceneReviewState = state
      return () => h('main', [
        unref(state.manualFinishStillGeneratingCount) > 0
          ? h('p', { id: 'still-generating' }, 'Still generating ' + unref(state.manualFinishStillGeneratingCount))
          : null,
        unref(state.replaceableUncertainJob)
          ? h('button', { id: 'replace-anyway', onClick: state.replaceUncertainImages }, 'Replace anyway')
          : null,
        unref(state.isQueuedRecoveryRender)
          ? h('div', { id: 'queued-repair-scope' }, [
              h('span', { id: 'queued-target' }, state.isSceneQueuedForRepair({ id: 'scene-target' }) ? 'Queued for repair' : 'Another repair is queued'),
              h('span', { id: 'queued-other' }, state.isSceneQueuedForRepair({ id: 'scene-other' }) ? 'Queued for repair' : 'Another repair is queued'),
            ])
          : null,
      ])
    }
    export default __sfc__`, { loader: 'ts', format: 'esm' })
  return (await import(`data:text/javascript;base64,${Buffer.from(
    out.code.replaceAll('"vue"', JSON.stringify(vueUrl)),
  ).toString('base64')}`)).default
}

async function mount(jobs: JobFixture[]) {
  const calls: Array<{ path: string; body: any }> = []
  const route = reactive({ params: { slug: 'fixture-project' }, query: { episode_id: 'EP0001' } })
  const jobState = ref(jobs)
  let resolveConfirm: ((value: boolean) => void) | null = null
  ;(globalThis as any).__sceneReviewRoute = route
  ;(globalThis as any).__sceneReviewJobs = jobState
  ;(globalThis as any).__sceneReviewErrors = []
  ;(globalThis as any).__sceneReviewAsk = () => new Promise<boolean>(resolve => { resolveConfirm = resolve })
  ;(globalThis as any).__sceneReviewApi = {
    get: async () => ({ scene_plan: null, scenes: [], audio_path: null, stats: null, render_status: null }),
    post: async (path: string, body: any) => { calls.push({ path, body }); return { queued: 1, skipped: 0, job_id: 'posted-job' } },
    put: async () => ({}),
  }
  const Page = await loadSceneReview()
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(Page)
  app.mount(host)
  await nextTick()
  return {
    host,
    jobs: jobState,
    state: (globalThis as any).__sceneReviewState,
    calls,
    acceptConfirmation: () => resolveConfirm?.(true),
    unmount: () => { app.unmount(); host.remove() },
  }
}

const manual = (overrides: Partial<JobFixture> = {}): JobFixture => ({
  job_id: 'job-manual', type: 'continuity_render', episode_id: 'EP0001', status: 'error',
  created_at: '2026-09-06T10:00:00.000Z',
  params: { manual_image_finish: {} },
  ...overrides,
})

test('mounted Scene Review keeps still-generating and uncertain subsets separate', async () => {
  const mounted = await mount([manual({ params: { manual_image_finish: {
    still_generating_scene_ids: ['scene-running'], uncertain_scene_ids: ['scene-unknown'],
  } } })])
  assert.match(mounted.host.textContent || '', /Still generating 1/)
  assert.ok(mounted.host.querySelector('#replace-anyway'), mounted.host.innerHTML)
  mounted.unmount()
})

test('mounted Scene Review posts one current-selection Finish action without a second confirmation', async () => {
  const mounted = await mount([])
  mounted.state.stats.value = { total_scenes: 2, with_image: 1, approved: 0, all_approved: false }
  mounted.state.promptIntegrity.value = { complete: true, empty_ids: [], duplicate_ids: [] }
  mounted.state.subtitleIntegrity.value = { complete: true, missing_sections: [] }
  mounted.state.form.value.model = 'published-image-model'
  mounted.state.form.value.aspect_ratio = '16:9'
  const pending = mounted.state.finishMissingImages()
  await nextTick()
  mounted.state.episodeId.value = 'EP0002' // stops the background poll after the POST
  await pending
  assert.equal(mounted.calls.length, 1)
  assert.equal(mounted.calls[0].path, '/projects/fixture-project/scene-review/EP0001/finish-missing')
  assert.equal(mounted.calls[0].body.model, 'published-image-model')
  assert.equal(mounted.calls[0].body.aspect_ratio, '16:9')
  assert.match(mounted.calls[0].body.action_id, /^[0-9a-f-]{36}$/i)
  mounted.unmount()
})

test('mounted Scene Review can finish a valid missing scene when only a saved scene has a bad prompt', async () => {
  const mounted = await mount([])
  mounted.state.stats.value = { total_scenes: 2, with_image: 1, approved: 0, all_approved: false }
  mounted.state.subtitleIntegrity.value = { complete: true, missing_sections: [] }
  mounted.state.promptIntegrity.value = { complete: false, empty_ids: ['saved-scene'], duplicate_ids: [] }
  mounted.state.scenes.value = [
    { id: 'saved-scene', scene_index: 1, visual_prompt: '', image_filename: 'saved.png' },
    { id: 'missing-scene', scene_index: 2, visual_prompt: 'A lantern on the sea', image_filename: null },
  ]
  mounted.state.form.value.model = 'published-image-model'
  assert.equal(mounted.state.canBulkGenerate.value, true)
  assert.match(mounted.state.bulkStatus.value, /images already made first/i)
  mounted.unmount()
})

test('mounted Scene Review suppresses an older uncertain action after a newer completed action', async () => {
  const mounted = await mount([
    manual({ job_id: 'old-uncertain', created_at: '2026-09-06T09:00:00.000Z', params: { manual_image_finish: { uncertain_scene_ids: ['scene-old'] } } }),
    manual({ job_id: 'new-complete', status: 'done', created_at: '2026-09-06T10:00:00.000Z', params: { manual_image_finish: {} } }),
  ])
  assert.equal(mounted.host.querySelector('#replace-anyway'), null, mounted.host.innerHTML)
  mounted.unmount()
})

test('mounted Scene Review abandons a replacement confirmation after its episode changes', async () => {
  const mounted = await mount([manual({ params: { manual_image_finish: { uncertain_scene_ids: ['scene-unknown'] } } })])
  const pending = mounted.state.replaceUncertainImages()
  mounted.state.episodeId.value = 'EP0002'
  mounted.acceptConfirmation()
  await pending
  assert.equal(mounted.calls.length, 0, 'a confirmation for EP0001 must not post into EP0002')
  mounted.unmount()
})

test('mounted Scene Review names only the exact recovery target as queued for repair', async () => {
  const mounted = await mount([{
    job_id: 'queued-recovery', type: 'continuity_render', episode_id: 'EP0001', status: 'queued',
    created_at: '2026-09-06T10:00:00.000Z',
    params: { episode_recovery_id: 'recovery-plan', scene_ids: ['scene-target'] },
  }])
  assert.equal(mounted.host.querySelector('#queued-target')?.textContent, 'Queued for repair')
  assert.equal(mounted.host.querySelector('#queued-other')?.textContent, 'Another repair is queued')
  mounted.unmount()
})

test('one bad prompt elsewhere does not block regenerating a different scene', async () => {
  const mounted = await mount([{ job_id: 'posted-job', type: 'scene_image_generate', episode_id: 'EP0001', status: 'done', created_at: '2026-09-06T10:00:00.000Z' }])
  mounted.state.subtitleIntegrity.value = { complete: true, missing_sections: [] }
  mounted.state.promptIntegrity.value = { complete: false, empty_ids: ['bad-scene'], duplicate_ids: [] }
  mounted.state.scenes.value = [
    { id: 'bad-scene', scene_index: 1, visual_prompt: '', image_filename: 'a.png', image_version: '1-1' },
    { id: 'good-scene', scene_index: 2, visual_prompt: 'A lantern on the sea', image_filename: 'b.png', image_version: '1-1' },
  ]
  mounted.state.form.value.model = 'published-image-model'

  await mounted.state.generateOne(mounted.state.scenes.value[0])
  assert.equal(mounted.calls.length, 0, 'the scene with no prompt is refused')
  assert.match((globalThis as any).__sceneReviewErrors.at(-1), /Scene #1 has a missing or duplicated prompt/)

  await mounted.state.generateOne(mounted.state.scenes.value[1])
  assert.equal(mounted.calls.length, 1, 'a valid scene renders even though another scene has a bad prompt')
  assert.equal(mounted.calls[0].path, '/projects/fixture-project/scene-review/EP0001/generate-image')
  assert.equal(mounted.calls[0].body.scene_id, 'good-scene')
  mounted.unmount()
})

test('the newest failed image job is surfaced until a newer job replaces it', async () => {
  const failed = { job_id: 'failed', type: 'scene_image_generate', episode_id: 'EP0001', status: 'error', created_at: '2026-09-06T10:00:00.000Z', error: 'GenStudio refused the prompt.' }
  const mounted = await mount([failed])
  assert.equal(mounted.state.failedRenderJob.value?.job_id, 'failed')
  assert.match(mounted.state.failedRenderMessage.value, /GenStudio refused the prompt/)
  await mounted.state.retryFailedRender()
  assert.equal(mounted.calls.at(-1)?.path, '/projects/fixture-project/jobs/failed/retry')
  mounted.jobs.value = [failed, { ...failed, job_id: 'later', status: 'done', created_at: '2026-09-06T11:00:00.000Z' }]
  assert.equal(mounted.state.failedRenderJob.value, null)
  mounted.unmount()
})

test('Check again re-reads the uncertain job in place instead of ordering a replacement', async () => {
  const mounted = await mount([manual({ params: { manual_image_finish: { uncertain_scene_ids: ['scene-unknown'] } } })])
  await mounted.state.checkUncertainAgain()
  assert.equal(mounted.calls.length, 1)
  assert.equal(mounted.calls[0].path, '/projects/fixture-project/jobs/job-manual/finish-missing-images')
  assert.deepEqual(mounted.calls[0].body, {})
  mounted.unmount()
})
