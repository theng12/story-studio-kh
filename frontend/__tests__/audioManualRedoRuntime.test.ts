import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createApp, nextTick, reactive, ref, type Component } from 'vue'
import { compileScript, parse } from '@vue/compiler-sfc'
import { transform } from 'esbuild'
import { waitFor } from '../../electron/server/__tests__/_timing.js'

const audioPath = fileURLToPath(new URL('../pages/projects/[slug]/audio.vue', import.meta.url))
const audioSource = readFileSync(audioPath, 'utf8')

async function loadAudioPage(): Promise<Component> {
  const sourceUnderTest = process.env.STORY_STUDIO_TEST_AUDIO_REDO_MUTATION === 'cancel-on-source-disappearance'
    ? audioSource.replace(
        'if (pendingAudioSubmission.value) return',
        'if (pendingAudioSubmission.value) { cancelPendingManualAudioSubmission(); return }',
      )
    : audioSource
  const { descriptor } = parse(sourceUnderTest, { filename: audioPath })
  const script = compileScript(descriptor, { id: 'audio-manual-redo-runtime' })
  const vueUrl = await import.meta.resolve('vue')
  const controlsUrl = await import.meta.resolve('../utils/tts-controls.ts')
  const support = `
    import { computed, defineComponent as _defineComponent, onMounted, onUnmounted, reactive, ref, watch } from ${JSON.stringify(vueUrl)}
    import { defaultTtsControlValues, resolveTtsControlValues } from ${JSON.stringify(controlsUrl)}
    const definePageMeta = () => undefined
    const useAppTitle = () => undefined
    const useRoute = () => globalThis.__audioManualRoute
    const useRouter = () => ({ replace: async () => undefined })
    const useApi = () => globalThis.__audioManualApi
    const useConfirm = () => ({ ask: async () => true })
    const UNCONFIRMED_SUBMISSION = 'unconfirmed submission'
    const useFreshGenerationAction = () => {
      const pending = ref(new Map())
      return {
        pending,
        hasPending: computed(() => pending.value.size > 0),
        begin(scope, target = 'default') {
          const key = JSON.stringify(scope)
          const current = pending.value.get(target)
          if (current?.scope === key) return current.id
          const id = '88888888-8888-4888-8888-' + String(++globalThis.__audioManualUuid).padStart(12, '0')
          pending.value = new Map(pending.value).set(target, { id, scope: key })
          return id
        },
        complete(id) {
          const next = new Map(pending.value)
          for (const [target, action] of next) if (action.id === id) next.delete(target)
          pending.value = next
        },
        isRetry(scope, target = 'default') { return pending.value.get(target)?.scope === JSON.stringify(scope) },
        cancel(target) {
          if (!target) pending.value = new Map()
          else { const next = new Map(pending.value); next.delete(target); pending.value = next }
        },
      }
    }
    const useManualGenerationRedoPreference = () => globalThis.__audioManualPreference
    const useJobDetails = () => ({ ensure: () => undefined, withDetail: job => job })
    const useProject = () => ({ project: ref(null), config: ref({ audio_quality: {}, confirmation_preferences: { audio: false } }), refreshConfig: async () => undefined })
    const useGenStudioVoices = () => globalThis.__audioManualVoices
    const useGenStudioTranscriptionModels = () => ({ models: ref([]), error: ref(''), isStale: ref(false), isUsable: ref(true), sourceFreshness: ref(null), load: async () => undefined })
    const genstudioStaleNote = () => ''
    const voiceIsGenerable = voice => voice?.generation_enabled !== false
    const voiceSourceText = () => ''
    const selectLiveGenStudioModel = (value, models) => models.find(model => model.id === value) || null
    const genStudioModelLockReason = () => ''
    const resolveAliasedModelId = () => null
    const CREDIT_BASIS_LABEL = { exact: 'Exact quote' }
    const describeVoiceRate = model => ({ text: model?.rate || 'No current rate', title: '', notice: '' })
    const describeQuotedTotal = () => ({ text: '2.00 credits', title: '', notice: '', basis: 'exact' })
    const formatCredits = value => String(value || 0)
    const hasPriceTruth = model => !!model?.rate
    const isFreeToRun = model => model?.free === true
    const describeRelaxedQueueHint = () => ''
    const isRelaxedQueue = () => false
    const queueClassGroupLabel = () => ''
    const useToast = () => globalThis.__audioManualToast
    const useGenerating = () => ({ audioGenerating: ref(false) })
    const useConfirmation = () => globalThis.__audioManualConfirmation
    const useJobs = () => ({ jobs: globalThis.__audioManualJobs })
    const useRememberedForm = () => undefined
    // Settings → Default models: the util's own pure decision, so this harness needs no module.
    const emptyDefaultModels = () => ({ writing: null, image: null, video: null, audio: null, transcription: null, music: null })
    const normalizeDefaultModels = () => emptyDefaultModels()
    const resolveEffectiveModel = (_family, selected) => ({ model: selected || '', defaultModel: '', goneNotice: '' })
    const useEpisodeStatus = () => ({ selectedEpisode: ref(null), scriptReady: ref(true), statusKnown: ref(true), refetch: async () => undefined })
    const usePresets = () => ({ load: async () => undefined })
    const subtitleChapterLabel = value => value
  `
  const content = script.content
    .replace(/^import[\s\S]*?from ['"][^'"]+['"];?\n/gm, '')
    .replace('export default', 'const __sfc__ =')
  const built = await transform(`${support}\n${content}\nconst __setup = __sfc__.setup
    __sfc__.setup = function (props, context) {
      const state = __setup(props, context)
      globalThis.__audioManualState = state
      return () => null
    }
    export default __sfc__`, { loader: 'ts', format: 'esm' })
  return (await import(`data:text/javascript;base64,${Buffer.from(
    built.code.replaceAll('"vue"', JSON.stringify(vueUrl)),
  ).toString('base64')}`)).default
}

const Page = await loadAudioPage()

type ConfirmationCall = {
  slug: string
  type: string
  body: Record<string, any>
  context: Record<string, any>
}

function sourceJob(episodeId = 'EP0001') {
  return {
    job_id: 'stopped-audio-source',
    project_slug: 'voice-project',
    episode_id: episodeId,
    type: 'audio',
    status: 'error',
    created_at: '2026-10-14T00:00:00.000Z',
    finished_at: '2026-10-14T00:01:00.000Z',
    params: {
      genstudio_recovery: {
        version: 1,
        route: 'genstudio',
        assets: {
          [`${episodeId}_Chapter_01_v2.mp3`]: {
            operation: 'tts',
            job_id: 'voice-task-1',
            idempotency_key: 'voice-key-1',
          },
        },
      },
    },
    genstudio_jobs_active: [{
      id: 'voice-task-1', operation: 'voice.tts', state: 'accepted', request_key: 'voice-key-1',
    }],
  }
}

async function mountFixture(options: {
  deferredConfirmation?: boolean
  post?: (path: string, body: Record<string, any>) => Promise<any>
} = {}) {
  const route = reactive({ params: { slug: 'voice-project' }, query: {} as Record<string, unknown> })
  const jobs = ref<any[]>([sourceJob()])
  const models = ref<any[]>([{
    id: 'paid-voice-model', display_name: 'Paid Voice', generation_enabled: true, locked: false,
    supports_speed: true, minimum_speed: 0.5, maximum_speed: 2, controls: [{
      name: 'warmth', label: 'Warmth', type: 'number', minimum: 0, maximum: 1,
      default: 0.4, step: 0.1, max_length: null, description: 'Voice warmth.',
    }],
    maximum_input_characters: 4000, supported_languages: [], rate: '1.00 credit / 1k characters',
  }])
  const preference = { enabled: ref(true), load: async () => true, reset: () => { preference.enabled.value = false } }
  const calls: ConfirmationCall[] = []
  const resolvers: Array<(value: boolean) => void> = []
  const confirmationState = reactive({ visible: false, type: '', always: false })
  const confirmation = {
    state: confirmationState,
    confirmGeneration: async (slug: string, type: string, body: Record<string, any>, context: Record<string, any>) => {
      calls.push({ slug, type, body: JSON.parse(JSON.stringify(body)), context: JSON.parse(JSON.stringify(context)) })
      confirmationState.visible = true
      confirmationState.type = type
      confirmationState.always = context?.always === true
      if (!options.deferredConfirmation) { confirmationState.visible = false; return true }
      return new Promise<boolean>(resolve => resolvers.push((value) => {
        confirmationState.visible = false
        resolve(value)
      }))
    },
    cancel: () => resolvers.shift()?.(false),
  }
  const actions: Array<{ message: string; label: string; run: () => void | Promise<void> }> = []
  const errors: string[] = []
  const successes: string[] = []
  const posts: Array<{ path: string; body: Record<string, any> }> = []
  const api = {
    get: async () => ({}),
    post: async (path: string, body: Record<string, any>) => {
      posts.push({ path, body: JSON.parse(JSON.stringify(body)) })
      return options.post?.(path, body) ?? {}
    },
  }
  Object.assign(globalThis as any, {
    __audioManualRoute: route,
    __audioManualApi: api,
    __audioManualJobs: jobs,
    __audioManualPreference: preference,
    __audioManualVoices: {
      models,
      modelsLoading: ref(false), modelsError: ref(''), modelsStale: ref(false), modelsLoadedAt: ref('2026-10-14T00:00:00Z'),
      loadModels: async () => undefined, quoteNarration: async () => ({}),
    },
    __audioManualConfirmation: confirmation,
    __audioManualToast: {
      success: (message: string) => successes.push(message),
      info: () => undefined,
      error: (message: string) => errors.push(message),
      showAction: (message: string, label: string, run: () => void | Promise<void>) => actions.push({ message, label, run }),
    },
    __audioManualUuid: 0,
  })
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(Page)
  app.mount(host)
  const state = (globalThis as any).__audioManualState
  state.form.episode_id = 'EP0001'
  await nextTick()
  state.form.model = 'paid-voice-model'
  state.form.voice = 'paid-voice'
  state.form.speed = 1
  state.form.controls = { warmth: 0.4 }
  state.onVoiceCatalogUpdated([{ id: 'paid-voice', display_name: 'Narrator', generation_enabled: true }])
  state.effectiveSections.value = ['Chapter_01']
  state.form.sections = 'Chapter_01'
  await nextTick()
  await nextTick()
  state.narrationQuote.value = { quotable: true, parts: [{ credits: 2 }] }
  state.quoteScopeKey.value = 'Chapter_01'
  assert.equal(state.manualAudioRedoEligible.value, true, 'fixture must reach the real source-bound action')
  state.manualAudioRedoChecked.value = true
  return {
    app, host, state, route, jobs, models, preference, calls, resolvers, confirmationState,
    actions, errors, successes, posts,
    unmount: () => { app.unmount(); host.remove() },
  }
}

for (const [label, change] of [
  ['project', (fixture: any) => { fixture.route.params.slug = 'another-project' }],
  ['episode', (fixture: any) => { fixture.state.form.episode_id = 'EP0002' }],
  ['model', (fixture: any) => { fixture.state.form.model = 'another-model' }],
  ['voice', (fixture: any) => { fixture.state.form.voice = 'another-voice' }],
  ['sections', (fixture: any) => { fixture.state.effectiveSections.value = ['Chapter_02'] }],
  ['controls', (fixture: any) => { fixture.state.form.controls = { warmth: 0.8 } }],
] as const) {
  test(`manual voice confirmation refuses a ${label} change before its first POST`, async () => {
    const fixture = await mountFixture({ deferredConfirmation: true })
    try {
      const request = fixture.state.queueAudio(['Chapter_01'], 'new_version')
      await waitFor(() => fixture.calls.length === 1, { label: `${label} confirmation` })
      const captured = fixture.calls[0]!
      assert.equal(captured.context.always, true, 'manual voice work always uses the explicit confirmation')
      assert.equal(captured.body.manual_redo.source_job_id, 'stopped-audio-source')
      assert.deepEqual(captured.context.details.at(-1), { label: 'Exact quote', value: '2.00 credits' })
      change(fixture)
      await nextTick()
      await request
      assert.equal(fixture.posts.length, 0)
      assert.equal(captured.body.controls.warmth, 0.4, 'the body shown for confirmation stays immutable')
    } finally {
      fixture.unmount()
    }
  })
}

test('source abandonment before a lost HTTP reply preserves one exact Retry without a new quote or confirmation', async () => {
  let fixture: Awaited<ReturnType<typeof mountFixture>>
  let first = true
  fixture = await mountFixture({
    post: async () => {
      if (first) {
        first = false
        fixture.jobs.value = [{ ...sourceJob(), force_abandoned: true }]
        await nextTick()
        throw new Error('HTTP response lost after admission')
      }
      return { job_id: 'accepted-destination', reused: true }
    },
  })
  try {
    const queued = await fixture.state.queueAudio(['Chapter_01'], 'new_version')
    assert.equal(queued, false, 'the first call cannot claim success without its response')
    assert.equal(fixture.calls.length, 1)
    assert.equal(fixture.calls[0]!.context.always, true)
    assert.equal(fixture.posts.length, 1)
    assert.equal(fixture.actions.length, 1)
    assert.equal(fixture.actions[0]!.label, 'Retry')
    assert.equal(fixture.state.pendingAudioSubmission.value.operationId, fixture.posts[0]!.body.operation_id)
    assert.equal(fixture.state.manualAudioRedoChecked.value, true, 'SSE source removal keeps the captured action adoptable')

    fixture.preference.enabled.value = false
    fixture.models.value = []
    await nextTick()
    await fixture.actions[0]!.run()
    await waitFor(() => fixture.posts.length === 2, { label: 'captured voice retry' })
    assert.deepEqual(fixture.posts[1]!.body, fixture.posts[0]!.body, 'Retry reuses the exact body and UUID')
    assert.equal(fixture.calls.length, 1, 'accepted-action replay does not ask for a new confirmation or price')
    assert.equal(fixture.state.pendingAudioSubmission.value, null)
  } finally {
    fixture.unmount()
  }
})

for (const [label, change] of [
  ['model', (fixture: any) => { fixture.state.form.model = 'different-model' }],
  ['voice', (fixture: any) => { fixture.state.form.voice = 'different-voice' }],
  ['controls', (fixture: any) => { fixture.state.form.controls = { warmth: 0.7 } }],
] as const) {
  test(`a user ${label} edit cancels an unknown-response Retry`, async () => {
    let fixture: Awaited<ReturnType<typeof mountFixture>>
    fixture = await mountFixture({
      post: async () => {
        fixture.jobs.value = [{ ...sourceJob(), force_abandoned: true }]
        await nextTick()
        throw new Error('HTTP response lost after admission')
      },
    })
    try {
      await fixture.state.queueAudio(['Chapter_01'], 'new_version')
      assert.ok(fixture.state.pendingAudioSubmission.value)
      change(fixture)
      await nextTick()
      assert.equal(fixture.state.pendingAudioSubmission.value, null)
      await fixture.actions[0]!.run()
      assert.equal(fixture.posts.length, 1, 'the changed user scope cannot resend the captured request')
      assert.ok(fixture.errors.some(message => message.includes('belongs to another')))
    } finally {
      fixture.unmount()
    }
  })
}

for (const catalogChange of [
  { label: 'removal', controls: (_current: any[]) => [], resolved: {} },
  {
    label: 'range clamp',
    controls: (current: any[]) => [{ ...current[0], maximum: 0.2 }],
    resolved: { warmth: 0.2 },
  },
] as const) {
  test(`same-model catalog control ${catalogChange.label} preserves an accepted unknown-response Retry`, async () => {
    let fixture: Awaited<ReturnType<typeof mountFixture>>
    let first = true
    fixture = await mountFixture({
      post: async () => {
        if (first) {
          first = false
          fixture.jobs.value = [{ ...sourceJob(), force_abandoned: true }]
          fixture.models.value = [{
            ...fixture.models.value[0],
            controls: catalogChange.controls(fixture.models.value[0].controls),
          }]
          await nextTick()
          await nextTick()
          throw new Error('HTTP response lost after admission')
        }
        return { job_id: 'accepted-destination', reused: true }
      },
    })
    try {
      await fixture.state.queueAudio(['Chapter_01'], 'new_version')
      assert.deepEqual(fixture.state.resolvedControls.value, catalogChange.resolved, 'new planning immediately follows the refreshed catalog')
      assert.deepEqual(fixture.state.form.controls, { warmth: 0.4 }, 'raw normalization waits while the accepted action is unresolved')
      assert.equal(fixture.actions.length, 1)
      assert.ok(fixture.state.pendingAudioSubmission.value, 'automatic control normalization keeps the accepted request adoptable')
      const firstPost = fixture.posts[0]!
      await fixture.actions[0]!.run()
      await waitFor(() => fixture.posts.length === 2, { label: 'same-model normalized control Retry' })
      assert.deepEqual(fixture.posts[1]!.body, firstPost.body, 'Retry retains the pre-normalization body and UUID')
      assert.equal(fixture.calls.length, 1, 'Retry does not ask for a new quote or confirmation')
      assert.deepEqual(fixture.state.form.controls, catalogChange.resolved, 'deferred catalog normalization applies after the replay resolves')
    } finally {
      fixture.unmount()
    }
  })
}
