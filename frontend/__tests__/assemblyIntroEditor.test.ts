/**
 * Video Assembly Step 2 — the intro popup body.
 *
 * What this pins: opening, browsing and cancelling write nothing; a video-only
 * Apply adopts only the changed raw file and lands in the CAPTURED episode's
 * own `video_assembly_last_used` entry; a channel-intro change is a real Audio
 * Assembly rebuild through the EXISTING selected preset, tracked to terminal,
 * verified, pinned by membership, and only then saved; an explicit clear sends
 * `channel_intro: null`; a late completion never announces itself into another
 * episode's form.
 *
 * What it cannot catch: layout/geometry inside the real Modal, and the
 * backend's own merge output (the backend lane owns that). Not run here by
 * instruction — the lead coordinates suite runs.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createApp, defineComponent, h, nextTick, reactive, ref, type Component } from 'vue'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { transform } from 'esbuild'
import * as draftUtil from '../utils/assembly-step-draft.ts'

const LAST_USED = 'video_assembly_last_used'
const CHANNEL_INTRO = '${CHANNEL}/assets/brand-intro.mp3'
const RAW_CHANNEL_INTRO = '/tmp/music-bed.mp3'
const ADOPTED_CHANNEL_INTRO = '${CHANNEL}/assets/music-bed.mp3'

interface Call { method: 'GET' | 'POST' | 'PUT'; path: string; body?: any }

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function baseline(overrides: Record<string, any> = {}) {
  return {
    intro: { enabled: false, video_path: '' },
    channel_intro: null,
    timeline: { title_image: { enabled: true, image_path: '/episodes/EP001/title.webp' } },
    effects: { title_card: { text: 'EP001' } },
    export: { crf: 18 },
    ...clone(overrides),
  }
}

let editorComponent: Promise<Component> | undefined
async function loadEditor(): Promise<Component> {
  if (editorComponent) return editorComponent
  editorComponent = (async () => {
    const filename = fileURLToPath(new URL('../components/AssemblyIntroEditor.vue', import.meta.url))
    const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename })
    const script = compileScript(descriptor, { id: 'assembly-intro-editor-test' })
    const template = compileTemplate({
      source: descriptor.template!.content,
      filename,
      id: 'assembly-intro-editor-test',
      compilerOptions: { bindingMetadata: script.bindings },
    })
    const vueUrl = await import.meta.resolve('vue')
    // Nuxt auto-imports these; the harness supplies the same names for a
    // plain node:test mount.
    const support = `
      const useApi = () => globalThis.__assemblyIntroHarness.api
      const useJobs = () => ({ jobs: globalThis.__assemblyIntroHarness.jobs })
      const useProject = () => ({ episodesRoot: globalThis.__assemblyIntroHarness.episodesRoot })
      const { beginAssemblyStepDraft, cancelAssemblyStepDraft, applyAssemblyStepDraft, sameAssemblyStepScope } = globalThis.__assemblyIntroHarness.draft
    `
    const code = `${support}\n${script.content.replace('export default', 'const __sfc__ =')}\n${template.code}\n__sfc__.render = render\nexport default __sfc__`
    const transformed = await transform(code, { loader: 'ts', format: 'esm' })
    const finalCode = transformed.code.replaceAll('"vue"', JSON.stringify(vueUrl))
    return (await import(`data:text/javascript;base64,${Buffer.from(finalCode).toString('base64')}`)).default
  })()
  return editorComponent
}

/** Browse returns the RAW pick here — adoption belongs to Apply. */
const FilePickerStub = defineComponent({
  props: {
    modelValue: { type: String, default: '' },
    placeholder: { type: String, default: '' },
    filters: { type: Array, default: () => [] },
    title: { type: String, default: '' },
    ariaLabel: { type: String, default: '' },
    clearable: { type: Boolean, default: false },
    episodesRoot: { type: String, default: undefined },
  },
  emits: ['update:modelValue'],
  setup(props, { emit }) {
    return () => h('div', {
      class: 'file-picker-stub',
      'data-value': props.modelValue,
      'data-has-episodes-root': String(props.episodesRoot === undefined ? 'absent' : 'present'),
    }, [
      h('button', {
        type: 'button',
        onClick: () => emit('update:modelValue', (globalThis as any).__introVideoPick ?? '/tmp/intro.mp4'),
      }, 'Browse video'),
    ])
  },
})

/** The shared picker is stubbed: its own behavior is pinned by its own test. */
const ChannelPickerStub = defineComponent({
  props: {
    modelValue: { type: Object, default: null },
    episodesRoot: { type: String, default: '' },
    slug: { type: String, default: '' },
  },
  emits: ['update:modelValue'],
  setup(props, { emit }) {
    return () => h('div', {
      class: 'channel-picker-stub',
      'data-file': props.modelValue?.file || '',
    }, [
      h('button', {
        type: 'button',
        onClick: () => {
          const pick = (globalThis as any).__channelIntroPick
          emit('update:modelValue', typeof pick === 'string' ? { file: pick, volume: 1, gap_after: 0 } : pick ?? null)
        },
      }, 'Choose intro'),
    ])
  },
})

interface HarnessOptions {
  fullsettings?: Record<string, any>
  status?: Record<string, any>
  mergeError?: any
  failConfigSaveCount?: number
}

function createHarness(options: HarnessOptions = {}) {
  const calls: Call[] = []
  const jobs = ref<any[]>([])
  const episodesRoot = ref('/library/chan/episodes')
  const config: Record<string, any> = {}
  let configSaveFailures = options.failConfigSaveCount ?? 0
  let mergeJobCounter = 0
  const status = options.status
  const api = {
    get: async (path: string) => {
      calls.push({ method: 'GET', path })
      if (path.endsWith('/settings/config')) return clone(config)
      if (path.endsWith('/audio-merge-status')) {
        if (status) return clone(status)
        const latest = [...jobs.value].reverse().find(job => job.type === 'audio_merge' && job.status === 'done')
        const line = (latest?.output_lines || []).find((entry: string) => /^Output:/.test(entry))
        const file = line ? String(line).replace(/^Output:\s*/, '').split('/').pop() || '' : ''
        return { present: !!file, file }
      }
      throw new Error(`unexpected GET ${path}`)
    },
    post: async (path: string, body: any) => {
      calls.push({ method: 'POST', path, body: clone(body) })
      if (path === '/system/resolve-asset-path') {
        const name = String(body?.path || '').split('/').pop() || 'adopted'
        return { output: `\${CHANNEL}/assets/${name}` }
      }
      if (path.endsWith('/generate/audio-merge')) {
        if (options.mergeError) throw options.mergeError
        mergeJobCounter += 1
        return { job_id: `job-${mergeJobCounter}` }
      }
      throw new Error(`unexpected POST ${path}`)
    },
    put: async (path: string, body: any) => {
      calls.push({ method: 'PUT', path, body: clone(body) })
      if (path.includes('/merged-audio/select/')) return { selected_merged_audio: body?.filename ?? null }
      if (path.endsWith('/settings/config')) {
        if (configSaveFailures > 0) {
          configSaveFailures -= 1
          throw new Error('config write refused')
        }
        Object.assign(config, clone(body))
        return { ok: true }
      }
      throw new Error(`unexpected PUT ${path}`)
    },
  }
  return { calls, jobs, episodesRoot, api, config, status }
}

let openEditor: Awaited<ReturnType<typeof mountEditor>> | null = null

afterEach(() => {
  openEditor?.unmount()
  openEditor = null
  delete (globalThis as any).__assemblyIntroHarness
  delete (globalThis as any).__introVideoPick
  delete (globalThis as any).__channelIntroPick
})

async function mountEditor(options: HarnessOptions = {}) {
  const harness = createHarness(options)
  ;(globalThis as any).__assemblyIntroHarness = {
    api: harness.api,
    jobs: harness.jobs,
    episodesRoot: harness.episodesRoot,
    draft: draftUtil,
  }
  const state = reactive({
    slug: 'chan',
    episodeId: 'EP001',
    fullsettings: baseline(options.fullsettings),
  })
  const applied: any[] = []
  let refreshes = 0
  let cancels = 0
  const host = document.body.appendChild(document.createElement('div'))
  const Editor = await loadEditor()
  const Wrapper = defineComponent({
    setup() {
      return () => h(Editor, {
        slug: state.slug,
        episodeId: state.episodeId,
        fullsettings: state.fullsettings,
        onApplied: (value: any) => applied.push(value),
        onRefresh: () => { refreshes++ },
        onCancel: () => { cancels++ },
      })
    },
  })
  const app = createApp(Wrapper)
  app.component('FilePicker', FilePickerStub)
  app.component('ChannelIntroAudioPicker', ChannelPickerStub)
  app.mount(host)

  const flush = async () => {
    await nextTick()
    await nextTick()
    await Promise.resolve()
  }
  const click = async (selector: string) => {
    const element = host.querySelector<HTMLElement>(selector)
    assert.ok(element, `expected ${selector}`)
    element!.click()
    await flush()
  }
  const settle = async (ready: () => boolean) => {
    for (let index = 0; index < 80; index++) {
      await flush()
      if (ready()) {
        await flush()
        return
      }
    }
    assert.fail(`the editor did not reach the expected state; calls=${JSON.stringify(harness.calls)}; screen=${host.textContent}`)
  }
  return {
    host,
    calls: harness.calls,
    jobs: harness.jobs,
    config: harness.config,
    state,
    applied,
    get refreshes() { return refreshes },
    get cancels() { return cancels },
    click,
    flush,
    settle,
    unmount: () => { app.unmount(); host.remove() },
  }
}

async function open(options: HarnessOptions = {}) {
  openEditor = await mountEditor(options)
  return openEditor
}

test('opening the editor makes no request and selects nothing on its own', async () => {
  const mounted = await open()
  await mounted.flush()
  assert.equal(mounted.calls.length, 0, 'opening must not read, adopt or merge')
  assert.equal(mounted.applied.length, 0)
  assert.equal(mounted.host.querySelector('.channel-picker-stub')!.getAttribute('data-file'), '')
  assert.match(mounted.host.textContent || '', /Nothing is selected by default/)
})

test('browsing and cancelling stage a detached draft only — never a merge', async () => {
  const mounted = await open()
  ;(globalThis as any).__channelIntroPick = CHANNEL_INTRO
  await mounted.click('.channel-picker-stub button')
  assert.equal(mounted.calls.length, 0, 'Browse neither adopts nor queues')
  assert.equal(mounted.applied.length, 0)
  assert.match(mounted.host.textContent || '', /Apply rebuilds this episode’s audio/)

  await mounted.click('[data-testid="cancel-intro"]')
  assert.equal(mounted.cancels, 1)
  assert.equal(mounted.calls.length, 0, 'Cancel writes nothing')
})

test('a video-only Apply adopts the changed raw file into the captured episode and saves its own settings', async () => {
  const mounted = await open()
  await mounted.click('input[type="checkbox"]')
  ;(globalThis as any).__introVideoPick = '/tmp/intro.mp4'
  await mounted.click('.file-picker-stub button')
  assert.equal(mounted.host.querySelector('.file-picker-stub')!.getAttribute('data-has-episodes-root'), 'absent',
    'Browse must return the raw pick; adoption belongs to Apply')
  await mounted.click('[data-testid="apply-intro"]')
  await mounted.settle(() => mounted.applied.length === 1)

  const adopt = mounted.calls.find(call => call.method === 'POST' && call.path === '/system/resolve-asset-path')
  assert.ok(adopt, 'Apply must adopt the changed raw pick')
  assert.deepEqual(adopt!.body, {
    path: '/tmp/intro.mp4',
    output_root: '/library/chan/episodes',
    mode: 'adopt',
  })
  assert.equal(mounted.calls.some(call => call.path.endsWith('/generate/audio-merge')), false,
    'a video-only change must not rebuild audio')

  const save = mounted.calls.find(call => call.method === 'PUT' && call.path.endsWith('/settings/config'))
  assert.ok(save)
  const own = save!.body[LAST_USED].episodes.EP001.settings
  assert.deepEqual(own.intro, { enabled: true, video_path: '${CHANNEL}/assets/intro.mp4' })
  assert.deepEqual(own.timeline, baseline().timeline, 'the baseline seeds slots this editor does not own')
  assert.equal(own.channel_intro, null)

  assert.deepEqual(mounted.applied[0], {
    intro: { enabled: true, video_path: '${CHANNEL}/assets/intro.mp4' },
    channel_intro: null,
  })
  assert.equal(mounted.refreshes, 1)
})

test('a channel-intro change queues the real merge with the saved preset, then verifies and pins the new track', async () => {
  const mounted = await open()
  ;(globalThis as any).__channelIntroPick = RAW_CHANNEL_INTRO
  await mounted.click('.channel-picker-stub button')
  await mounted.click('[data-testid="apply-intro"]')
  await mounted.settle(() => mounted.calls.some(call => call.path.endsWith('/generate/audio-merge')))

  const adopt = mounted.calls.find(call => call.method === 'POST' && call.path === '/system/resolve-asset-path')
  assert.deepEqual(adopt!.body, {
    path: RAW_CHANNEL_INTRO,
    output_root: '/library/chan/episodes',
    mode: 'adopt',
  }, 'the raw channel pick is adopted only at Apply, through the captured channel root')

  const merge = mounted.calls.find(call => call.path.endsWith('/generate/audio-merge'))
  assert.deepEqual(merge!.body, {
    episode_id: 'EP001',
    reuse_saved_settings: true,
    channel_intro: { enabled: true, file: ADOPTED_CHANNEL_INTRO, volume: 1, gap_after: 0 },
    write_mode: 'new',
  }, 'the saved preset and the explicit channel intro travel; no mixer fields are invented')
  assert.equal(mounted.applied.length, 0, 'nothing is announced before the job is terminal')
  assert.equal(mounted.calls.some(call => call.method === 'PUT' && call.path.endsWith('/settings/config')), false)
  assert.equal(mounted.host.querySelector<HTMLButtonElement>('[data-testid="apply-intro"]')!.disabled, true,
    'controls stay disabled while the rebuild runs')

  mounted.jobs.value = [{ job_id: 'job-1', type: 'audio_merge', status: 'done', output_lines: ['Output: /episode/EP001_merged_audio_v2.mp3'] }]
  await mounted.settle(() => mounted.applied.length === 1)

  const pin = mounted.calls.find(call => call.method === 'PUT' && call.path.includes('/merged-audio/select/EP001'))
  assert.ok(pin, 'the verified new basename must be pinned by membership')
  assert.deepEqual(pin!.body, { filename: 'EP001_merged_audio_v2.mp3' },
    'the completed job names the new output; a previous selection cannot substitute for it')

  const save = mounted.calls.find(call => call.method === 'PUT' && call.path.endsWith('/settings/config'))
  assert.deepEqual(save!.body[LAST_USED].episodes.EP001.settings.channel_intro, {
    file: ADOPTED_CHANNEL_INTRO,
    volume: 1,
    gap_after: 0,
  })
  assert.deepEqual(mounted.applied[0], {
    intro: { enabled: false, video_path: '' },
    channel_intro: { file: ADOPTED_CHANNEL_INTRO, volume: 1, gap_after: 0 },
    merged_audio: 'EP001_merged_audio_v2.mp3',
  })
  assert.equal(mounted.refreshes, 1)
})

test('a retry after the save fails finishes the completed merge instead of rebuilding the audio', async () => {
  const mounted = await open({ failConfigSaveCount: 1 })
  ;(globalThis as any).__channelIntroPick = CHANNEL_INTRO
  await mounted.click('.channel-picker-stub button')
  await mounted.click('[data-testid="apply-intro"]')
  await mounted.settle(() => mounted.calls.some(call => call.path.endsWith('/generate/audio-merge')))

  mounted.jobs.value = [{ job_id: 'job-1', type: 'audio_merge', status: 'done', output_lines: ['Output: /episode/EP001_merged_audio_v2.mp3'] }]
  await mounted.settle(() => /Could not save these settings/.test(mounted.host.textContent || ''))
  const mergePosts = () => mounted.calls.filter(call => call.path.endsWith('/generate/audio-merge')).length
  assert.equal(mergePosts(), 1, 'the first Apply queued exactly one rebuild')
  assert.equal(mounted.applied.length, 0)

  await mounted.click('[data-testid="apply-intro"]')
  await mounted.settle(() => mounted.applied.length === 1)

  assert.equal(mergePosts(), 1, 'the completed merge is reused, never queued twice')
  const pins = mounted.calls.filter(call => call.method === 'PUT' && call.path.includes('/merged-audio/select/EP001'))
  assert.equal(pins.length, 2, 'the retry pins again rather than trusting the failed attempt')
  assert.deepEqual(pins[1].body, { filename: 'EP001_merged_audio_v2.mp3' },
    'the retry pins the same completed job output')
  const saves = mounted.calls.filter(call => call.method === 'PUT' && call.path.endsWith('/settings/config'))
  assert.equal(saves.length, 2, 'the failed write is retried')
  assert.deepEqual(saves[1].body[LAST_USED].episodes.EP001.settings.channel_intro, {
    file: ADOPTED_CHANNEL_INTRO,
    volume: 1,
    gap_after: 0,
  })
  assert.equal(mounted.applied[0].merged_audio, 'EP001_merged_audio_v2.mp3')
  assert.equal(mounted.refreshes, 1)
})

test('reverting to the original channel intro after a failed save rebuilds and pins the baseline track', async () => {
  const mounted = await open({ failConfigSaveCount: 1 })
  ;(globalThis as any).__channelIntroPick = CHANNEL_INTRO
  await mounted.click('.channel-picker-stub button')
  await mounted.click('[data-testid="apply-intro"]')
  await mounted.settle(() => mounted.calls.some(call => call.path.endsWith('/generate/audio-merge')))

  mounted.jobs.value = [{ job_id: 'job-1', type: 'audio_merge', status: 'done', output_lines: ['Output: /episode/EP001_merged_audio_v2.mp3'] }]
  await mounted.settle(() => /Could not save these settings/.test(mounted.host.textContent || ''))
  assert.equal(mounted.applied.length, 0)

  ;(globalThis as any).__channelIntroPick = null
  await mounted.click('.channel-picker-stub button')
  assert.match(mounted.host.textContent || '', /Apply rebuilds this episode’s audio/,
    'reverting to the baseline is a rebuild of the pinned track')

  await mounted.click('[data-testid="apply-intro"]')
  await mounted.settle(() => mounted.calls.filter(call => call.path.endsWith('/generate/audio-merge')).length === 2)

  const merges = mounted.calls.filter(call => call.path.endsWith('/generate/audio-merge'))
  assert.equal(merges[1].body.channel_intro, null,
    'the revert rebuilds with the original baseline choice, not a duplicate of the new intro')
  assert.equal(merges[1].body.write_mode, 'new')

  mounted.jobs.value = [
    { job_id: 'job-1', type: 'audio_merge', status: 'done', output_lines: ['Output: /episode/EP001_merged_audio_v2.mp3'] },
    { job_id: 'job-2', type: 'audio_merge', status: 'done', output_lines: ['Output: /episode/EP001_merged_audio_v3.mp3'] },
  ]
  await mounted.settle(() => mounted.applied.length === 1)

  const pins = mounted.calls.filter(call => call.method === 'PUT' && call.path.includes('/merged-audio/select/EP001'))
  assert.equal(pins.length, 2)
  assert.deepEqual(pins[1].body, { filename: 'EP001_merged_audio_v3.mp3' },
    'the rebuilt baseline track is pinned, not the earlier new intro')
  assert.deepEqual(mounted.applied[0], {
    intro: { enabled: false, video_path: '' },
    channel_intro: null,
    merged_audio: 'EP001_merged_audio_v3.mp3',
  })
  assert.equal(mounted.refreshes, 1)
})

test('an explicit clear sends channel_intro: null, never an absent key or a fake non-empty pick', async () => {
  const mounted = await open({
    fullsettings: {
      channel_intro: { file: '${CHANNEL}/assets/old-intro.mp3', volume: 0.6, gap_after: 2 },
    },
  })
  ;(globalThis as any).__channelIntroPick = null
  await mounted.click('.channel-picker-stub button')
  await mounted.click('[data-testid="apply-intro"]')
  await mounted.settle(() => mounted.calls.some(call => call.path.endsWith('/generate/audio-merge')))

  const merge = mounted.calls.find(call => call.path.endsWith('/generate/audio-merge'))
  assert.equal(merge!.body.channel_intro, null)
  assert.equal(merge!.body.reuse_saved_settings, true)
  assert.equal(mounted.calls.some(call => call.method === 'POST' && call.path === '/system/resolve-asset-path'), false,
    'clearing adopts nothing')

  mounted.jobs.value = [{ job_id: 'job-1', type: 'audio_merge', status: 'done', output_lines: ['Output: /episode/EP001_merged_audio_v2.mp3'] }]
  await mounted.settle(() => mounted.applied.length === 1)
  assert.equal(mounted.applied[0].channel_intro, null)
})

test('a completed job without its own output never substitutes the previous selected track', async () => {
  const mounted = await open({ status: { present: true, file: 'EP001_merged_audio.mp3' } })
  ;(globalThis as any).__channelIntroPick = CHANNEL_INTRO
  await mounted.click('.channel-picker-stub button')
  await mounted.click('[data-testid="apply-intro"]')
  await mounted.settle(() => mounted.calls.some(call => call.path.endsWith('/generate/audio-merge')))
  mounted.jobs.value = [{ job_id: 'job-1', type: 'audio_merge', status: 'done', output_lines: [] }]
  await mounted.settle(() => /could not name the new merged track/.test(mounted.host.textContent || ''))
  assert.equal(mounted.applied.length, 0)
  assert.equal(mounted.calls.some(call => call.method === 'PUT'), false)
})

test('status must verify the newly selected output before intro settings are saved', async () => {
  const mounted = await open({ status: { present: true, file: 'EP001_merged_audio.mp3' } })
  ;(globalThis as any).__channelIntroPick = CHANNEL_INTRO
  await mounted.click('.channel-picker-stub button')
  await mounted.click('[data-testid="apply-intro"]')
  await mounted.settle(() => mounted.calls.some(call => call.path.endsWith('/generate/audio-merge')))
  mounted.jobs.value = [{ job_id: 'job-1', type: 'audio_merge', status: 'done', output_lines: ['Output: /episode/EP001_merged_audio_v2.mp3'] }]
  await mounted.settle(() => /could not verify it/.test(mounted.host.textContent || ''))
  assert.equal(mounted.applied.length, 0)
  assert.equal(mounted.calls.some(call => call.method === 'PUT' && call.path.endsWith('/settings/config')), false)
})

test('a missing Audio Assembly preset fails loudly and writes nothing', async () => {
  const mounted = await open({
    mergeError: { data: { detail: 'Saved Audio Assembly settings are not available: no Audio Assembly preset is selected.' } },
  })
  ;(globalThis as any).__channelIntroPick = CHANNEL_INTRO
  await mounted.click('.channel-picker-stub button')
  await mounted.click('[data-testid="apply-intro"]')
  await mounted.settle(() => /no Audio Assembly preset is selected/.test(mounted.host.textContent || ''))

  assert.equal(mounted.applied.length, 0)
  assert.equal(mounted.calls.some(call => call.method === 'PUT' && call.path.endsWith('/settings/config')), false)
  assert.equal(mounted.host.querySelector<HTMLButtonElement>('[data-testid="apply-intro"]')!.disabled, false,
    'a failed Apply keeps the draft available for a retry')
})

test('a late completion is saved for its captured episode, never announced into the episode open now', async () => {
  const mounted = await open()
  ;(globalThis as any).__channelIntroPick = CHANNEL_INTRO
  await mounted.click('.channel-picker-stub button')
  await mounted.click('[data-testid="apply-intro"]')
  await mounted.settle(() => mounted.calls.some(call => call.path.endsWith('/generate/audio-merge')))

  mounted.state.episodeId = 'EP002'
  await mounted.flush()
  mounted.jobs.value = [{ job_id: 'job-1', type: 'audio_merge', status: 'done', output_lines: ['Output: /episode/EP001_merged_audio_v2.mp3'] }]
  await mounted.settle(() => mounted.calls.some(call => call.method === 'PUT' && call.path.endsWith('/settings/config')))

  assert.equal(mounted.applied.length, 0, 'EP002 must not receive EP001’s intro')
  assert.equal(mounted.refreshes, 0)
  const save = mounted.calls.find(call => call.method === 'PUT' && call.path.endsWith('/settings/config'))
  assert.deepEqual(Object.keys(save!.body[LAST_USED].episodes), ['EP001'],
    'the late save lands in the captured episode only')
})
