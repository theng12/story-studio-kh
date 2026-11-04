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
  const outputOptionsUrl = await import.meta.resolve('../utils/genstudio-output-options.ts')
  const creditCostUrl = await import.meta.resolve('../utils/genstudio-credit-cost.ts')
  const support = `
    import { computed, defineComponent as _defineComponent, h, nextTick, onBeforeUnmount, onMounted, ref, unref, watch } from ${JSON.stringify(vueUrl)}
    import { secureOperationId, useFreshGenerationAction } from ${JSON.stringify(freshActionUrl)}
    import { findOutputOption, isPublishedAspectRatio, outputOptionsForRatio, publishedOutputOptions, storyDefaultAspectRatio } from ${JSON.stringify(outputOptionsUrl)}
    import { CREDIT_BASIS_LABEL, describeImageUnitCost } from ${JSON.stringify(creditCostUrl)}
    const definePageMeta = () => undefined
    const useAppTitle = () => undefined
    const useRoute = () => globalThis.__sceneReviewRoute
    const useRouter = () => ({ push: () => undefined, replace: () => undefined })
    const useProject = () => ({ config: ref({ image_models: {} }) })
    const useApi = () => globalThis.__sceneReviewApi
    const useToast = () => ({ success: () => undefined, error: (message) => globalThis.__sceneReviewErrors.push(message), info: () => undefined })
    const useConfirm = () => ({
      ask: (options) => globalThis.__sceneReviewConfirm.ask(options),
      cancel: () => globalThis.__sceneReviewConfirm.cancel(),
    })
    const useEpisodes = () => ({ updateEpisode: () => undefined, revalidateAfterMutation: () => undefined })
    // The page lists this episode's own characters for the reference picker; these tests own no characters.
    const useCharacters = () => ({ listForEpisode: async () => [] })
// The page imports these for the reference picker and preset boundary; the harnesses own no characters or presets.
const sceneReferenceLimits = () => null
const sceneReferenceNotice = () => ''
const reconcileSceneReferenceCharacters = (selected) => ({ kept: selected, dropped: [] })
const describeSceneReferenceDrops = () => ''
const sceneReferencePortrait = () => ''
const sceneTakesCharacterReferences = () => true
const sceneReviewPresetApply = (base, _data) => base
const sceneReviewPresetSnapshot = (data) => data
    const useRememberedForm = () => undefined
    const usePresets = () => ({ load: async () => undefined })
    const useGenStudioImageModels = () => ({ models: globalThis.__sceneReviewModels, refresh: async () => undefined })
    const useJobs = () => ({
      jobs: globalThis.__sceneReviewJobs,
      isJobActiveFor: (episodeId, types) => globalThis.__sceneReviewJobs.value.some(job =>
        job.episode_id === episodeId && ['queued', 'running', 'paused'].includes(job.status) && (!types || types.includes(job.type))),
    })
    const resolveActiveSceneRenderJob = (episodeId, cached, jobs) => jobs.find(job =>
      job.episode_id === episodeId && ['queued', 'running', 'paused'].includes(job.status)) || null
    const findGenStudioProduct = (models, id) => (models || []).find(model =>
      model.id === id || (model.legacy_ids || []).includes(id)) || null
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
          ? h('section', { id: 'uncertain-notice' }, [
              h('button', { id: 'check-again', onClick: state.checkUncertainAgain }, 'Check Again'),
              unref(state.manualRedoPreferenceEnabled)
                ? h('button', { id: 'replace-anyway', onClick: state.replaceUncertainImages }, 'Replace anyway')
                : null,
            ])
          : null,
        h('button', {
          id: 'finish-missing',
          disabled: !unref(state.canBulkGenerate) || unref(state.reviewJobActive),
          onClick: state.finishMissingImages,
        }, 'Finish Missing'),
        unref(state.scenes)[0]
          ? h('button', {
              id: 'generate-scene',
              disabled: !unref(state.form).model || unref(state.reviewJobActive),
              onClick: () => state.generateOne(unref(state.scenes)[0]),
            }, 'Generate Image')
          : null,
        unref(state.failedRenderJob)
          ? h('button', { id: 'retry-render', onClick: state.retryFailedRender }, 'Retry')
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

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await nextTick()
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}

async function mount(jobs: JobFixture[], options: {
  settings?: Array<unknown | Promise<unknown> | Error>
  replaceResponses?: Array<unknown | Error>
} = {}) {
  const calls: Array<{ path: string; body: any }> = []
  const route = reactive({ params: { slug: 'fixture-project' }, query: { episode_id: 'EP0001' } })
  const jobState = ref(jobs)
  const confirmations: Array<{ options: any; settled?: boolean }> = []
  let resolveConfirm: ((value: boolean) => void) | null = null
  let pendingConfirmation: { options: any; settled?: boolean } | null = null
  const settingResponses = [...(options.settings || [{ enabled: false }])]
  const replaceResponses = [...(options.replaceResponses || [])]
  ;(globalThis as any).__sceneReviewRoute = route
  ;(globalThis as any).__sceneReviewJobs = jobState
  ;(globalThis as any).__sceneReviewModels = ref([{
    id: 'published-image-model', display_name: 'Published image model', available: true,
    image_modes: [{ id: 'txt2img', label: 'Text to image', available: true }],
  }])
  ;(globalThis as any).__sceneReviewErrors = []
  ;(globalThis as any).__sceneReviewConfirm = {
    ask: (confirmationOptions: any) => new Promise<boolean>(resolve => {
      pendingConfirmation = { options: confirmationOptions }
      confirmations.push(pendingConfirmation)
      resolveConfirm = (value) => {
        pendingConfirmation!.settled = value
        pendingConfirmation = null
        resolveConfirm = null
        resolve(value)
      }
    }),
    cancel: () => resolveConfirm?.(false),
  }
  ;(globalThis as any).__sceneReviewApi = {
    get: async (path: string) => {
      if (path === '/app-settings/manual-generation-redo') {
        const response = settingResponses.length ? settingResponses.shift() : { enabled: false }
        if (response instanceof Error) throw response
        return await response
      }
      if (path.endsWith('/effective-format')) return { visualSource: 'scene_plan' }
      if (path.includes('/scene-review/')) {
        return { scene_plan: null, scenes: [], audio_path: null, stats: null, render_status: null }
      }
      throw new Error(`unexpected GET ${path}`)
    },
    post: async (path: string, body: any) => {
      calls.push({ path, body })
      if (path.endsWith('/replace-uncertain') && replaceResponses.length) {
        const response = replaceResponses.shift()
        if (response instanceof Error) throw response
        return response
      }
      return { queued: 1, skipped: 0, job_id: 'posted-job' }
    },
    put: async () => ({}),
  }
  const Page = await loadSceneReview()
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(Page)
  app.mount(host)
  await nextTick()
  await new Promise(resolve => setTimeout(resolve, 0))
  await nextTick()
  return {
    host,
    route,
    jobs: jobState,
    models: (globalThis as any).__sceneReviewModels,
    state: (globalThis as any).__sceneReviewState,
    calls,
    confirmations,
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

test('mounted Scene Review keeps still-generating and uncertain subsets separate when exposure is enabled', async () => {
  const mounted = await mount([manual({ params: { manual_image_finish: {
    still_generating_scene_ids: ['scene-running'], uncertain_scene_ids: ['scene-unknown'],
  } } })], { settings: [{ enabled: true }] })
  assert.match(mounted.host.textContent || '', /Still generating 1/)
  assert.ok(mounted.host.querySelector('#uncertain-notice'), mounted.host.innerHTML)
  assert.ok(mounted.host.querySelector('#check-again'), mounted.host.innerHTML)
  assert.ok(mounted.host.querySelector('#replace-anyway'), mounted.host.innerHTML)
  mounted.unmount()
})

test('a listed-but-rowless remembered ratio is repaired to a renderable row and announced', async () => {
  // F3 regression: `aspect_ratios` keeps listing 16:9 while `output_options`
  // no longer has a 16:9 row. The watcher must judge renderable rows, repair
  // the form to a real row's ratio, and announce the forced change.
  const mounted = await mount([])
  try {
    mounted.state.form.value.model = 'row-model'
    mounted.models.value = [{
      id: 'row-model',
      display_name: 'Row Model',
      available: true,
      image_modes: [{ id: 'txt2img', label: 'Text to image', available: true }],
      qualification_only: false,
      chargeable: true,
      credits_per_image: 3,
      aspect_ratios: ['16:9', '1:1'],
      default_aspect_ratio: '1:1',
      supports_reference_images: false,
      max_reference_images: 0,
      output_options: [
        { resolution: '1K', aspect_ratio: '1:1', width: 1024, height: 1024, is_default: true, credits_per_image: 3 },
      ],
    }]
    await flush()
    assert.equal(mounted.state.form.value.aspect_ratio, '1:1',
      'the rowless 16:9 is repaired even while the ratio list still names it')
    assert.match(String((globalThis as any).__sceneReviewErrors.at(-1) || ''),
      /does not publish 16:9[\s\S]*Switched to 1:1/)
  } finally { mounted.unmount() }
})

test('off, corrupt, and failed settings hide only exceptional replacement controls', async () => {
  for (const setting of [{ enabled: false }, { enabled: 'yes' }, new Error('offline')]) {
    const mounted = await mount([
      manual({ params: { manual_image_finish: { uncertain_scene_ids: ['scene-unknown'] } } }),
    ], { settings: [setting] })
    try {
      assert.ok(mounted.host.querySelector('#uncertain-notice'), mounted.host.innerHTML)
      assert.ok(mounted.host.querySelector('#check-again'), mounted.host.innerHTML)
      assert.equal(mounted.host.querySelector('#replace-anyway'), null, mounted.host.innerHTML)

      mounted.state.stats.value = { total_scenes: 1, with_image: 0, approved: 0, all_approved: false }
      mounted.state.promptIntegrity.value = { complete: true, empty_ids: [], duplicate_ids: [] }
      mounted.state.subtitleIntegrity.value = { complete: true, missing_sections: [] }
      mounted.state.form.value.model = 'published-image-model'
      mounted.state.scenes.value = [{
        id: 'scene-missing', scene_index: 1, visual_prompt: 'A lantern in a quiet archive.', image_filename: null,
      }]
      await flush()
      assert.equal(mounted.host.querySelector<HTMLButtonElement>('#finish-missing')?.disabled, false)
      assert.equal(mounted.host.querySelector<HTMLButtonElement>('#generate-scene')?.disabled, false)
    } finally { mounted.unmount() }
  }

  const retry = await mount([{
    job_id: 'failed-render', type: 'scene_image_generate', episode_id: 'EP0001', status: 'error',
    created_at: '2026-09-06T10:00:00.000Z',
  }], { settings: [new Error('offline')] })
  assert.ok(retry.host.querySelector('#retry-render'), retry.host.innerHTML)
  retry.unmount()
})

test('a stale enabled settings read cannot overwrite the current disabled scope', async () => {
  const oldScope = deferred<unknown>()
  const currentScope = deferred<unknown>()
  const mounted = await mount([
    manual({ params: { manual_image_finish: { uncertain_scene_ids: ['scene-unknown'] } } }),
  ], { settings: [oldScope.promise, currentScope.promise] })
  try {
    assert.equal(mounted.host.querySelector('#replace-anyway'), null)
    mounted.state.episodeId.value = 'EP0002'
    currentScope.resolve({ enabled: false })
    await flush()
    assert.equal(mounted.host.querySelector('#replace-anyway'), null)
    oldScope.resolve({ enabled: true })
    await flush()
    assert.equal(mounted.state.manualRedoPreferenceEnabled.value, false)
    assert.equal(mounted.host.querySelector('#replace-anyway'), null)
  } finally { mounted.unmount() }
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

test('enabled replacement opens the duplicate-charge dialog and project or episode switches cancel it before POST', async () => {
  for (const changeScope of ['project', 'episode'] as const) {
    const mounted = await mount([
      manual({ params: { manual_image_finish: { uncertain_scene_ids: ['scene-unknown'] } } }),
    ], { settings: [{ enabled: true }] })
    try {
      assert.equal(mounted.host.querySelectorAll('#replace-anyway').length, 1)
      mounted.state.form.value.model = 'published-image-model'
      const pending = mounted.state.replaceUncertainImages()
      await nextTick()
      assert.equal(mounted.confirmations.length, 1, 'the enabled control must open the real confirmation path')
      assert.match(mounted.confirmations[0].options.message, /may create a second image and may charge again/i)

      if (changeScope === 'project') mounted.route.params.slug = 'other-project'
      else mounted.state.episodeId.value = 'EP0002'
      await pending
      await flush()

      assert.equal(mounted.confirmations[0].settled, false, `${changeScope} switch cancels the open dialog`)
      assert.equal(mounted.calls.filter(call => call.path.endsWith('/replace-uncertain')).length, 0)
    } finally { mounted.unmount() }
  }
})

test('unknown-response retry keeps one source/action identity; a source switch cancels then mints a new identity', async () => {
  const source = manual({
    job_id: 'source-old',
    params: { manual_image_finish: { uncertain_scene_ids: ['scene-old'] } },
  })
  const mounted = await mount([source], {
    settings: [{ enabled: true }],
    replaceResponses: [new Error('unknown response'), new Error('unknown response'), new Error('unknown response')],
  })
  try {
    mounted.state.form.value.model = 'published-image-model'
    mounted.state.form.value.aspect_ratio = '16:9'

    for (let attempt = 0; attempt < 2; attempt++) {
      const pending = mounted.state.replaceUncertainImages()
      await nextTick()
      assert.equal(mounted.confirmations.length, attempt + 1)
      mounted.acceptConfirmation()
      await pending
      assert.equal(mounted.confirmations[attempt].settled, true)
    }
    const replacements = mounted.calls.filter(call => call.path.endsWith('/replace-uncertain'))
    assert.equal(replacements.length, 2)
    assert.equal(replacements[0].body.source_job_id, 'source-old')
    assert.match(replacements[0].body.action_id, /^[0-9a-f-]{36}$/i)
    assert.equal(replacements[1].body.action_id, replacements[0].body.action_id,
      'retry after an unknown response keeps the captured action UUID')
    assert.equal(replacements[1].body.source_job_id, replacements[0].body.source_job_id)

    const oldDialog = mounted.state.replaceUncertainImages()
    await nextTick()
    assert.equal(mounted.confirmations.length, 3)
    mounted.jobs.value = [manual({
      job_id: 'source-new',
      created_at: '2026-09-06T11:00:00.000Z',
      params: { manual_image_finish: { uncertain_scene_ids: ['scene-new'] } },
    })]
    await oldDialog
    await flush()
    assert.equal(mounted.confirmations[2].settled, false, 'source switch cancels the old open dialog')
    assert.equal(mounted.calls.filter(call => call.path.endsWith('/replace-uncertain')).length, 2,
      'the cancelled old-source dialog submits nothing')

    const newSource = mounted.state.replaceUncertainImages()
    await nextTick()
    assert.equal(mounted.confirmations.length, 4)
    mounted.acceptConfirmation()
    await newSource
    assert.equal(mounted.confirmations[3].settled, true)
    const afterSwitch = mounted.calls.filter(call => call.path.endsWith('/replace-uncertain'))
    assert.equal(afterSwitch.length, 3)
    assert.equal(afterSwitch[2].body.source_job_id, 'source-new')
    assert.notEqual(afterSwitch[2].body.action_id, replacements[0].body.action_id)
  } finally { mounted.unmount() }
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
  const failed = { job_id: 'failed', type: 'scene_image_generate', episode_id: 'EP0001', status: 'error', created_at: '2026-09-06T10:00:00.000Z', error: 'The Gateway refused the prompt.' }
  const mounted = await mount([failed])
  assert.equal(mounted.state.failedRenderJob.value?.job_id, 'failed')
  assert.match(mounted.state.failedRenderMessage.value, /[Tt]he Gateway refused the prompt/)
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

test('render banner explains Pause / Cancel in a visible line, not only a tooltip (owner decision 2026-10-03)', () => {
  assert.match(source, /class="review-control-hint"\n?\s*><strong>\{\{ control\.label \}\}:<\/strong> \{\{ control\.reason \}\}<\/small>/)
})

// ── The plain-HTTP identity path ──────────────────────────────────────────────
// `crypto.randomUUID` is secure-context-only; the shop mini is served over plain
// HTTP, where `getRandomValues` exists but randomUUID does not. Reported
// 2026-10-17: Finish refused with "Restart Story Studio" before the POST.

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

async function withBrowserCrypto<T>(fake: unknown, run: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  Object.defineProperty(globalThis, 'crypto', { value: fake, configurable: true, writable: true })
  try {
    return await run()
  } finally {
    if (original) Object.defineProperty(globalThis, 'crypto', original)
    else delete (globalThis as any).crypto
  }
}

async function mountFinishReady(): Promise<Awaited<ReturnType<typeof mount>>> {
  const mounted = await mount([])
  mounted.state.stats.value = { total_scenes: 2, with_image: 1, approved: 0, all_approved: false }
  mounted.state.promptIntegrity.value = { complete: true, empty_ids: [], duplicate_ids: [] }
  mounted.state.subtitleIntegrity.value = { complete: true, missing_sections: [] }
  mounted.state.form.value.model = 'published-image-model'
  mounted.state.form.value.aspect_ratio = '16:9'
  return mounted
}

test('over plain HTTP (no randomUUID, getRandomValues present) Finish still sends one v4 action id', async () => {
  await withBrowserCrypto({
    getRandomValues: (bytes: Uint8Array) => {
      for (let index = 0; index < bytes.length; index++) bytes[index] = index + 1
      return bytes
    },
  }, async () => {
    const mounted = await mountFinishReady()
    try {
      const pending = mounted.state.finishMissingImages()
      await nextTick()
      mounted.state.episodeId.value = 'EP0002' // stops the background poll after the POST
      await pending
      assert.equal(mounted.calls.length, 1, 'the Finish POST must happen over HTTP, not be refused')
      assert.equal(mounted.calls[0].path, '/projects/fixture-project/scene-review/EP0001/finish-missing')
      assert.match(mounted.calls[0].body.action_id, UUID_V4, 'a CSPRNG v4 identity, not a refusal')
      assert.deepEqual((globalThis as any).__sceneReviewErrors, [], 'no refusal message on the HTTP path')
    } finally { mounted.unmount() }
  })
})

test('with no CSPRNG at all Finish refuses before POSTing, with a truthful sentence and no restart advice', async () => {
  await withBrowserCrypto({}, async () => {
    const mounted = await mountFinishReady()
    try {
      await mounted.state.finishMissingImages()
      assert.equal(mounted.calls.length, 0, 'nothing may be sent without an identity')
      const error = String((globalThis as any).__sceneReviewErrors.at(-1) || '')
      assert.match(error, /cannot create a secure request identity/i)
      assert.match(error, /nothing was sent/i)
      assert.ok(!/restart/i.test(error), 'no restart advice')
      assert.ok(!/connection|settings|secure browser|browser security/i.test(error), 'no connection or settings advice')
    } finally { mounted.unmount() }
  })
})

test('a replacement retry reuses the same source/action identity over plain HTTP too', async () => {
  await withBrowserCrypto({
    getRandomValues: (bytes: Uint8Array) => {
      for (let index = 0; index < bytes.length; index++) bytes[index] = index + 1
      return bytes
    },
  }, async () => {
    const mounted = await mount([manual({ job_id: 'source-http', params: { manual_image_finish: { uncertain_scene_ids: ['scene-http'] } } })], {
      settings: [{ enabled: true }],
      replaceResponses: [new Error('unknown response'), new Error('unknown response')],
    })
    try {
      mounted.state.form.value.model = 'published-image-model'
      for (let attempt = 0; attempt < 2; attempt++) {
        const pending = mounted.state.replaceUncertainImages()
        await nextTick()
        mounted.acceptConfirmation()
        await pending
      }
      const replacements = mounted.calls.filter(call => call.path.endsWith('/replace-uncertain'))
      assert.equal(replacements.length, 2)
      assert.equal(replacements[0].body.source_job_id, 'source-http', 'the source job key is preserved')
      assert.match(replacements[0].body.action_id, UUID_V4)
      assert.equal(replacements[1].body.action_id, replacements[0].body.action_id,
        'an ambiguous retry keeps the same identity, so it cannot double-charge')
    } finally { mounted.unmount() }
  })
})
