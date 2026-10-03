import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createApp, unref, type Component } from 'vue'
import { compileScript, parse } from '@vue/compiler-sfc'
import { transform } from 'esbuild'
import { waitFor } from '../../electron/server/__tests__/_timing.js'

const pagePath = fileURLToPath(new URL('../pages/projects/[slug]/subtitles.vue', import.meta.url))
const source = readFileSync(pagePath, 'utf8')

async function loadPageScript(): Promise<Component> {
  const { descriptor } = parse(source, { filename: pagePath })
  const script = compileScript(descriptor, { id: 'subtitles-initial-load' })
  const vueUrl = await import.meta.resolve('vue')
  const freshActionUrl = await import.meta.resolve('../composables/useFreshGenerationAction.ts')
  const languageUrl = import.meta.resolve('../utils/transcription-language.ts')
  const support = `
    import { computed, defineComponent as _defineComponent, h, nextTick, onMounted, ref, unref, watch } from ${JSON.stringify(vueUrl)}
    import { useFreshGenerationAction } from ${JSON.stringify(freshActionUrl)}
    import { DEFAULT_TRANSCRIPTION_LANGUAGE, defaultTranscriptionLanguage, isTranscriptionLanguageUsable,
      transcriptionLanguageControl, transcriptionLanguageRequestFields } from ${JSON.stringify(languageUrl)}
    const hasQualityFindings = () => false
    const definePageMeta = () => undefined
    const useAppTitle = () => undefined
    const useRoute = () => ({ params: { slug: 'task15-fixture' }, query: { episode_id: 'EP0083', section: 'Chapter_15' } })
    const useRouter = () => ({ replace: async (location) => globalThis.__subtitlesInitialRouterReplace(location) })
    const useApi = () => globalThis.__subtitlesInitialApi
    const useToast = () => ({ success: () => undefined, error: () => undefined, info: () => undefined })
    const useJobs = () => ({ jobs: ref([]) })
    const useConfirm = () => ({ ask: async () => true })
    const useProject = () => ({ project: ref(null), episodesRoot: ref('/fixture/episodes') })
    const useGenStudioTranscriptionModels = () => globalThis.__subtitleSelectionModel || ({
      modelId: ref(''), selectedModel: ref(null), options: ref([]), loading: ref(false),
      error: ref(''), ready: ref(false), load: async () => undefined,
    })
    const usePresets = () => ({ load: async () => undefined })
  `
  const content = script.content
    .replace(/^import[\s\S]*?from ['"][^'"]+['"];?\n/gm, '')
    .replace('export default', 'const __sfc__ =')
  const out = await transform(`${support}\n${content}\nconst __setup = __sfc__.setup
  __sfc__.setup = function (props, context) {
    const state = __setup(props, context)
    globalThis.__subtitlesInitialState = state
    return () => {
      if (unref(state.loading)) return null
      return h('ul', unref(state.sections).map(section => h('li', {
      id: 'sub-section-' + section.slug,
      tabindex: -1,
      }, section.label)))
    }
  }\nexport default __sfc__`, {
    loader: 'ts', format: 'esm',
  })
  return (await import(`data:text/javascript;base64,${Buffer.from(
    out.code.replaceAll('"vue"', JSON.stringify(vueUrl)),
  ).toString('base64')}`)).default
}

test('an initial subtitle deep link loads its status without waiting for the episode selector to change', async () => {
  const calls: string[] = []
  ;(globalThis as any).__subtitlesInitialRouterReplace = () => {
    ;(document.activeElement as HTMLElement | null)?.blur()
  }
  ;(globalThis as any).__subtitlesInitialApi = {
    get: async (path: string) => {
      calls.push(path)
      if (path.endsWith('/audio-sections')) return { sections: [{ label: 'Chapter 15', slug: 'Chapter_15' }] }
      return { existing_srts: [], completion: { mode: 'per-section', completed_sections: [] } }
    },
    post: async () => ({}),
    del: async () => ({}),
  }
  const Page = await loadPageScript()
  HTMLElement.prototype.scrollIntoView = () => undefined
  const app = createApp(Page)
  const container = document.createElement('div')
  document.body.append(container)
  app.mount(container)
  await waitFor(
    () => document.activeElement?.id === 'sub-section-Chapter_15',
    { label: 'the initial subtitle chapter deep link to receive focus' },
  )

  assert.ok(calls.includes('/projects/task15-fixture/video-editor/subtitles/status/EP0083'))
  assert.ok(calls.includes('/projects/task15-fixture/episodes/EP0083/audio-sections'))
  assert.deepEqual(unref((globalThis as any).__subtitlesInitialState.sections), [{ label: 'Chapter 15', slug: 'Chapter_15' }])
  assert.ok(document.getElementById('sub-section-Chapter_15'), document.body.innerHTML || '<empty body>')
  assert.equal(document.activeElement?.id, 'sub-section-Chapter_15', document.body.innerHTML)
  app.unmount()
  container.remove()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

test('a late stitch-status read and delete response cannot overwrite a newly selected episode', async () => {
  const oldStitch = deferred<any>()
  const oldDelete = deferred<any>()
  const calls: string[] = []
  ;(globalThis as any).__subtitlesInitialRouterReplace = () => undefined
  ;(globalThis as any).__subtitlesInitialApi = {
    get: async (path: string) => {
      calls.push(path)
      if (path.includes('/scene-plan/EP0083')) return oldStitch.promise
      if (path.includes('/scene-plan/')) return { audio_merged: true, audio_merge_gap_s: 2, stitched_srt: null }
      if (path.endsWith('/audio-sections')) return { sections: [] }
      return { existing_srts: [{ filename: path.endsWith('/EP0083') ? 'old.srt' : 'new.srt' }] }
    },
    post: async () => ({}),
    del: () => oldDelete.promise,
  }
  const app = createApp(await loadPageScript())
  const container = document.createElement('div')
  document.body.append(container)
  app.mount(container)
  try {
    await waitFor(() => calls.some(path => path.endsWith('/scene-plan/EP0083')), { label: 'initial stitch read' })
    const state = (globalThis as any).__subtitlesInitialState
    const deleting = state.deleteSrt('old.srt')
    state.episodeId.value = 'EP0084'
    await waitFor(() => state.stitchStatus.value?.audio_merge_gap_s === 2, { label: 'new episode timeline' })
    oldStitch.resolve({ audio_merge_gap_s: 99, audio_merged: false, stitched_srt: null })
    oldDelete.resolve({ existing_srts: [] })
    await deleting
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(state.stitchStatus.value.audio_merge_gap_s, 2)
    assert.deepEqual(state.status.value.existing_srts.map((file: any) => file.filename), ['new.srt'])
  } finally {
    app.unmount()
    container.remove()
  }
})


test('subtitle gap review targets source audio and clears playback on episode change', async () => {
  ;(globalThis as any).__subtitlesInitialRouterReplace = () => undefined
  ;(globalThis as any).__subtitlesInitialApi = {
    get: async (path: string) => {
      if (path.endsWith('/audio-sections')) return { sections: [{ label: 'Chapter 13', slug: 'Chapter_13', quality: { state: 'review_needed' } }] }
      return { existing_srts: [], timeline_integrity: { complete: false, missing_sections: [], blocking_cue_gaps: [
        { previous_end_sec: 1822.5, next_start_sec: 1856.1, gap_sec: 33.6, section_slugs: ['Chapter_13'], section_local_start_sec: 31.2, section_local_end_sec: 64.8 },
      ] } }
    }, post: async () => { throw new Error('Playback must not submit generation') }, del: async () => ({}),
  }
  const app = createApp(await loadPageScript())
  const container = document.createElement('div')
  document.body.append(container)
  try {
    app.mount(container)
    const state = (globalThis as any).__subtitlesInitialState
    await waitFor(() => state.sections.value.length === 1, { label: 'gap chapter available' })
    assert.equal(state.sections.value[0].quality.state, 'review_needed')
    assert.equal(state.audioSectionLink('Chapter_13'), '/projects/task15-fixture/audio?episode_id=EP0083&section=Chapter_13')
    await state.reviewChapterAudio('Chapter_13', true)
    assert.equal(state.audioReview.value.section, 'Chapter_13')
    assert.equal(state.audioReview.value.startSeconds, 29.2)
    state.episodeId.value = 'EP0179'
    assert.equal(state.audioReview.value, null)
    assert.ok(source.includes('>Listen to {{ section.replaceAll'))
    assert.ok(source.includes('Regenerate Subtitles'))
  } finally { app.unmount(); container.remove() }
})


test('disabled subtitle actions keep rendering while model language capabilities are unavailable', async () => {
  ;(globalThis as any).__subtitlesInitialRouterReplace = () => undefined
  ;(globalThis as any).__subtitlesInitialApi = {
    get: async (path: string) => path.endsWith('/audio-sections') ? { sections: [] } : { existing_srts: [] },
  }
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(await loadPageScript())
  app.mount(host)
  try {
    const state = (globalThis as any).__subtitlesInitialState
    assert.equal(state.canTranscribe.value, false)
    assert.equal(state.subtitleActionLabel('Chapter_13', 'Regenerate Subtitles'), 'Regenerate Subtitles')
    assert.equal(state.subtitleActionLabel(null, 'Transcribe chapters'), 'Transcribe chapters')
  } finally { app.unmount(); host.remove() }
})

test('a subtitle whose selected audio changed is shown as stale while other chapters stay current', async () => {
  ;(globalThis as any).__subtitlesInitialRouterReplace = () => undefined
  ;(globalThis as any).__subtitlesInitialApi = {
    get: async (path: string) => path.endsWith('/audio-sections')
      ? { sections: [{ label: 'Chapter 01', slug: 'Chapter_01' }, { label: 'Chapter 02', slug: 'Chapter_02' }] }
      : { existing_srts: [], stale_sections: ['Chapter_01'], completion: { mode: 'per-section', completed_sections: ['Chapter_01', 'Chapter_02'] } },
  }
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(await loadPageScript())
  app.mount(host)
  try {
    const state = (globalThis as any).__subtitlesInitialState
    await waitFor(() => state.sections.value.length === 2, { label: 'subtitle chapter freshness status' })
    assert.equal(state.chapterIsStale('Chapter_01'), true)
    assert.equal(state.chapterIsStale('Chapter_02'), false)
  } finally { app.unmount(); host.remove() }
})

test('the Stitch action explains stale audio and blocks the guaranteed failing request', () => {
  assert.match(
    source,
    /v-else-if="staleSubtitleSections\.size"[\s\S]*?Update the affected chapters above before stitching/i,
  )
  assert.match(
    source,
    /:disabled="stitching \|\| !status\?\.has_merged_audio \|\| status\?\.freshness_unavailable \|\| staleSubtitleSections\.size > 0"/,
  )
})

test('subtitle stitching shows the source timestamp in local time without using recency as freshness', () => {
  assert.match(source, /Last stitched:/)
  assert.match(source, /last_stitched_at\?: string \| null/)
  assert.match(source, /toLocaleString\(undefined, \{ dateStyle: 'medium', timeStyle: 'medium' \}\)/)
  assert.match(source, /Last stitched:[\s\S]*?time unavailable/i)
  assert.match(source, /staleSubtitleSections\.size > 0/)
  assert.match(source, /v-else-if="coverage\.total && coverage\.done < coverage\.total"[\s\S]*?<\/p>\s*\n\s*<div v-if="stitchStatus\?\.stitched_srt"/)
})

test('subtitle actions fail closed when selected-source freshness cannot be inspected', () => {
  assert.match(source, /freshness_unavailable\?: boolean/)
  assert.match(source, /Subtitle source freshness is unavailable\. Refresh status before transcribing\./)
  assert.match(source, /stitching \|\| !status\?\.has_merged_audio \|\| status\?\.freshness_unavailable \|\| staleSubtitleSections\.size > 0/)
  assert.match(source, /Subtitle freshness unavailable/)
  assert.match(source, /if \(status\.value\?\.freshness_unavailable\) return false/)
  assert.match(source, /subtitleFreshnessUnavailable \? '\?' : coverage\.done/)
})


test('selected subtitle chapters share one scoped request, retain retry identity, and reset with the episode', async () => {
  const vue = await import('vue')
  ;(globalThis as any).__subtitleSelectionModel = {
    modelId: vue.ref('transcribe-test'), selectedModel: vue.ref({ id: 'transcribe-test', supported_languages: ['en'], supports_language_auto_detect: true }),
    options: vue.ref([]), loading: vue.ref(false), error: vue.ref(''), ready: vue.ref(true), load: async () => undefined,
  }
  const requests: any[] = []
  let reject = true
  ;(globalThis as any).__subtitlesInitialRouterReplace = () => undefined
  ;(globalThis as any).__subtitlesInitialApi = {
    get: async (path: string) => {
      if (path.endsWith('/audio-sections')) return { sections: [1, 2, 3].map(n => ({ label: `Chapter 0${n}`, slug: `Chapter_0${n}` })) }
      return { has_chapter_audio: true, audio_assembly_ready: true, existing_srts: [], stale_sections: ['Chapter_01'],
        completion: { mode: 'per-section', completed_sections: ['Chapter_02', 'Chapter_03'] } }
    },
    post: async (path: string, payload: any) => { requests.push({ path, payload: structuredClone(payload) }); if (reject) throw Error('response lost'); return {} },
    del: async () => ({}),
  }
  const app = createApp(await loadPageScript()), container = document.createElement('div')
  document.body.append(container)
  try {
    app.mount(container)
    const state = (globalThis as any).__subtitlesInitialState
    await waitFor(() => state.sections.value.length === 3, { label: 'selectable subtitle sections' })
    state.language.value = 'en'
    assert.equal(state.canTranscribe.value, true)
    state.selectSubtitleAttention()
    assert.deepEqual(state.selectedSubtitleSections.value, ['Chapter_01'])
    state.selectedSubtitleSections.value = ['Chapter_03', 'Chapter_01']
    await state.transcribe()
    assert.equal(requests.length, 1)
    assert.deepEqual(requests[0].payload.sections, ['Chapter_01', 'Chapter_03'])
    assert.equal(requests[0].payload.force, true)
    assert.ok(requests[0].payload.operation_id)
    assert.deepEqual(state.selectedSubtitleSections.value, ['Chapter_03', 'Chapter_01'])
    assert.equal(state.subtitleRetryPending.value, true)
    const knownSections = [...state.sections.value]
    state.sections.value = []
    assert.equal(state.canTranscribe.value, false)
    await state.transcribe()
    assert.equal(requests.length, 1, 'unavailable selection must not submit all chapters')
    state.sections.value = knownSections
    reject = false
    await state.transcribe()
    assert.equal(requests[1].payload.operation_id, requests[0].payload.operation_id)
    assert.deepEqual(state.selectedSubtitleSections.value, [])
    state.selectedSubtitleSections.value = ['Chapter_02']
    reject = true
    await state.transcribe()
    assert.equal(state.subtitleRetryPending.value, true)
    state.episodeId.value = 'EP0084'
    assert.deepEqual(state.selectedSubtitleSections.value, [])
    assert.equal(state.subtitleRetryPending.value, false)
    reject = false
    await waitFor(() => state.sections.value.length === 3, { label: 'new episode sections' })
    state.selectedSubtitleSections.value = ['Chapter_01', 'Chapter_03']
    await state.transcribe()
    assert.notEqual(requests[3].payload.operation_id, requests[0].payload.operation_id)
    assert.ok(requests[3].path.endsWith('/EP0084'))
  } finally { app.unmount(); container.remove(); delete (globalThis as any).__subtitleSelectionModel }
})
